// Spatial audio for a live game, as a runtime system. Sounds are defined once, then played from events (input actions,
// physics contacts, animation markers, game code) at a position, on a node, or flat. A listener follows the camera.
// Everything talks to a backend object (play a buffer, move the listener, set a bus volume); the Web Audio backend is the
// default and tests or another engine pass their own. See docs/audio.md.

export const AUDIO_LIMITS = Object.freeze({
  maximumSounds: 256,
  maximumBindings: 256,
  maximumBuses: 16,
  maximumVoices: 64,
  defaultVoices: 32,
  defaultInstancesPerSound: 8,
  maximumInstancesPerSound: 32,
  maximumMarkers: 512,
});

export const DEFAULT_BUSES = Object.freeze(['music', 'effects', 'voice']);
// An occluded source loses this share of its level and is also muffled by a low-pass filter.
export const OCCLUDED_GAIN_LOSS = 0.7;
const OCCLUDED_LOW_PASS_HERTZ = 400;
const OPEN_LOW_PASS_HERTZ = 20000;
const PARAMETER_SMOOTHING_SECONDS = 0.01;
const DISTANCE_MODELS = ['inverse', 'linear', 'exponential'];
const GESTURE_EVENTS = ['pointerdown', 'keydown', 'touchend'];

function describe(value) {
  return value === null ? 'null' : typeof value;
}

function requireName(value, label) {
  if (typeof value !== 'string' || value === '') {
    throw new TypeError(`${label} must be a non-empty string, got ${describe(value)}.`);
  }
  return value;
}

function requireNumberInRange(value, label, minimum, maximum) {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new RangeError(`${label} must be a number from ${minimum} to ${maximum}, got ${String(value)}.`);
  }
  return value;
}

function requireVector(value, label) {
  if (!Array.isArray(value) && !ArrayBuffer.isView(value)) {
    throw new TypeError(`${label} must be [x, y, z], got ${describe(value)}.`);
  }
  if (value.length < 3 || !Number.isFinite(value[0]) || !Number.isFinite(value[1]) || !Number.isFinite(value[2])) {
    throw new TypeError(`${label} must be three finite numbers [x, y, z].`);
  }
  return [value[0], value[1], value[2]];
}

// Distance gain from the Web Audio specification, so the level measured here matches what a PannerNode applies.
export function distanceGain(distance, { model = 'inverse', referenceDistance = 1, maximumDistance = 50, rolloff = 1 } = {}) {
  const clamped = Math.min(Math.max(distance, referenceDistance), maximumDistance);
  if (model === 'linear') {
    const span = maximumDistance - referenceDistance;
    return span <= 0 ? 1 : 1 - rolloff * (clamped - referenceDistance) / span;
  }
  if (model === 'exponential') return (clamped / referenceDistance) ** -rolloff;
  return referenceDistance / (referenceDistance + rolloff * (clamped - referenceDistance));
}

function normalizeSpatial(spatial, label) {
  if (spatial === undefined || spatial === false) return null;
  const options = spatial === true ? {} : spatial;
  if (options === null || typeof options !== 'object') {
    throw new TypeError(`${label} spatial must be true or { referenceDistance, maximumDistance, rolloff, model, occlusion }, got ${describe(spatial)}.`);
  }
  const model = options.model ?? 'inverse';
  if (!DISTANCE_MODELS.includes(model)) {
    throw new RangeError(`${label} spatial model must be one of ${DISTANCE_MODELS.join(', ')}, got ${String(model)}.`);
  }
  const referenceDistance = requireNumberInRange(options.referenceDistance ?? 1, `${label} spatial referenceDistance`, 0.01, 1000);
  const maximumDistance = requireNumberInRange(options.maximumDistance ?? 50, `${label} spatial maximumDistance`, referenceDistance, 100000);
  const rolloff = requireNumberInRange(options.rolloff ?? 1, `${label} spatial rolloff`, 0, 20);
  return Object.freeze({ model, referenceDistance, maximumDistance, rolloff, occlusion: options.occlusion === true });
}

// ---- Positions and listener ----

function matrixTranslation(matrix) {
  return [matrix[12], matrix[13], matrix[14]];
}

// A node is { position: [x, y, z] }, { matrix } (a 4x4 column-major array), or a function returning either of those.
export function readNodePosition(node, label = 'node') {
  const resolved = typeof node === 'function' ? node() : node;
  if (resolved === null || typeof resolved !== 'object') {
    throw new TypeError(`${label} must be [x, y, z], { position }, { matrix } or a function returning one of them, got ${describe(resolved)}.`);
  }
  if (Array.isArray(resolved) || (ArrayBuffer.isView(resolved) && resolved.length === 3)) return requireVector(resolved, label);
  if (resolved.position !== undefined) return requireVector(resolved.position, `${label} position`);
  if (resolved.matrix !== undefined && resolved.matrix.length === 16) return requireVector(matrixTranslation(resolved.matrix), `${label} matrix`);
  throw new TypeError(`${label} must be [x, y, z], { position }, { matrix } or a function returning one of them.`);
}

// The listener follows the camera: pass the renderer frame ({ eye, target, up }) or { position, forward, up }.
export function readListener(camera) {
  if (camera === null || typeof camera !== 'object') {
    throw new TypeError(`listener must be a camera frame { eye, target, up } or { position, forward, up }, got ${describe(camera)}.`);
  }
  const up = camera.up === undefined ? [0, 1, 0] : requireVector(camera.up, 'listener up');
  if (camera.eye !== undefined) {
    const position = requireVector(camera.eye, 'listener eye');
    const target = requireVector(camera.target ?? [position[0], position[1], position[2] - 1], 'listener target');
    return { position, forward: normalizeForward([target[0] - position[0], target[1] - position[1], target[2] - position[2]]), up };
  }
  return {
    position: requireVector(camera.position ?? [0, 0, 0], 'listener position'),
    forward: normalizeForward(requireVector(camera.forward ?? [0, 0, -1], 'listener forward')),
    up,
  };
}

function normalizeForward(vector) {
  const length = Math.hypot(vector[0], vector[1], vector[2]);
  if (length < 1e-9) return [0, 0, -1];
  return [vector[0] / length, vector[1] / length, vector[2] / length];
}

function distanceBetween(first, second) {
  return Math.hypot(first[0] - second[0], first[1] - second[1], first[2] - second[2]);
}

// ---- Animation markers ----

// Markers are { time, name } on a clip. Returns the ones crossed when the clip time moves from `fromTime` (exclusive)
// to `toTime` (inclusive). With `loop` and `duration`, a wrap from the end back to the start fires both ends.
export function markersCrossed(markers, fromTime, toTime, { loop = false, duration = Infinity } = {}) {
  if (!Array.isArray(markers) || markers.length > AUDIO_LIMITS.maximumMarkers) {
    throw new RangeError(`markers must be an array of up to ${AUDIO_LIMITS.maximumMarkers} { time, name } entries.`);
  }
  const crossed = [];
  const wrapped = loop && toTime < fromTime;
  for (const marker of markers) {
    requireName(marker?.name, 'marker name');
    requireNumberInRange(marker.time, `marker ${marker.name} time`, 0, Number.MAX_VALUE);
    const inRange = wrapped
      ? (marker.time > fromTime && marker.time <= duration) || (marker.time >= 0 && marker.time <= toTime)
      : marker.time > fromTime && marker.time <= toTime;
    if (inRange) crossed.push(marker);
  }
  return crossed;
}

// ---- Web Audio backend ----

function setParameter(parameter, value, now) {
  if (typeof parameter.setTargetAtTime === 'function') parameter.setTargetAtTime(value, now, PARAMETER_SMOOTHING_SECONDS);
  else parameter.value = value;
}

function setPannerPosition(panner, position, now) {
  if (panner.positionX) {
    setParameter(panner.positionX, position[0], now);
    setParameter(panner.positionY, position[1], now);
    setParameter(panner.positionZ, position[2], now);
  } else {
    panner.setPosition(position[0], position[1], position[2]);
  }
}

function setListenerPose(listener, pose, now) {
  if (listener.positionX) {
    setParameter(listener.positionX, pose.position[0], now);
    setParameter(listener.positionY, pose.position[1], now);
    setParameter(listener.positionZ, pose.position[2], now);
    setParameter(listener.forwardX, pose.forward[0], now);
    setParameter(listener.forwardY, pose.forward[1], now);
    setParameter(listener.forwardZ, pose.forward[2], now);
    setParameter(listener.upX, pose.up[0], now);
    setParameter(listener.upY, pose.up[1], now);
    setParameter(listener.upZ, pose.up[2], now);
  } else {
    listener.setPosition(pose.position[0], pose.position[1], pose.position[2]);
    listener.setOrientation(pose.forward[0], pose.forward[1], pose.forward[2], pose.up[0], pose.up[1], pose.up[2]);
  }
}

function occlusionHertz(occlusion) {
  return OPEN_LOW_PASS_HERTZ * (OCCLUDED_LOW_PASS_HERTZ / OPEN_LOW_PASS_HERTZ) ** occlusion;
}

// Graph: voice source -> [low-pass -> panner] -> voice gain -> bus gain -> master gain -> limiter -> destination.
export function webAudioBackend(options = {}) {
  const createContext = options.createContext ?? (() => new globalThis.AudioContext({ latencyHint: 'interactive' }));
  const fetchBytes = options.fetch ?? (globalThis.fetch ? globalThis.fetch.bind(globalThis) : null);
  const gestureTarget = options.gestureTarget === undefined ? globalThis.document : options.gestureTarget;
  let context = null;
  let master = null;
  let limiter = null;
  let removeGestureListeners = null;
  const buses = new Map();

  function requireContext() {
    if (!context) throw new Error('The audio backend has not started. Call audio.init() or add the audio system to a started runtime.');
    return context;
  }

  function unlock() {
    if (context && context.state === 'suspended') {
      const result = context.resume();
      if (result && typeof result.catch === 'function') result.catch(() => {});
    }
  }

  return {
    name: 'web-audio',
    get state() {
      return context ? context.state : 'closed';
    },
    init() {
      if (context) return;
      context = createContext();
      limiter = context.createDynamicsCompressor();
      limiter.threshold.value = -1;
      limiter.knee.value = 0;
      limiter.ratio.value = 20;
      limiter.attack.value = 0.003;
      limiter.release.value = 0.1;
      limiter.connect(context.destination);
      master = context.createGain();
      master.connect(limiter);
      if (gestureTarget && typeof gestureTarget.addEventListener === 'function') {
        const handler = () => {
          unlock();
          if (context.state !== 'suspended' && removeGestureListeners) removeGestureListeners();
        };
        for (const type of GESTURE_EVENTS) gestureTarget.addEventListener(type, handler);
        removeGestureListeners = () => {
          for (const type of GESTURE_EVENTS) gestureTarget.removeEventListener(type, handler);
          removeGestureListeners = null;
        };
      }
    },
    dispose() {
      if (removeGestureListeners) removeGestureListeners();
      if (context && typeof context.close === 'function') context.close();
      context = null;
      buses.clear();
    },
    unlock,
    createBus(name, volume) {
      const gain = requireContext().createGain();
      gain.gain.value = volume;
      gain.connect(master);
      buses.set(name, gain);
    },
    setBusVolume(name, volume) {
      const bus = name === 'master' ? master : buses.get(name);
      setParameter(bus.gain, volume, requireContext().currentTime);
    },
    async decode(source) {
      const audioContext = requireContext();
      if (typeof source === 'string') {
        if (!fetchBytes) throw new Error('No fetch is available to load a sound from a URL. Pass an ArrayBuffer or a decoded AudioBuffer instead.');
        const response = await fetchBytes(source);
        if (!response.ok) throw new Error(`Loading the sound ${source} failed with status ${response.status}.`);
        return audioContext.decodeAudioData(await response.arrayBuffer());
      }
      if (source instanceof ArrayBuffer) return audioContext.decodeAudioData(source);
      if (source && typeof source.duration === 'number') return source;
      throw new TypeError(`A sound source must be a URL string, an ArrayBuffer or a decoded AudioBuffer, got ${describe(source)}.`);
    },
    setListener(pose) {
      const audioContext = requireContext();
      setListenerPose(audioContext.listener, pose, audioContext.currentTime);
    },
    startVoice(voiceOptions) {
      const audioContext = requireContext();
      const now = audioContext.currentTime;
      const source = audioContext.createBufferSource();
      source.buffer = voiceOptions.buffer;
      source.loop = voiceOptions.loop;
      source.playbackRate.value = voiceOptions.pitch;
      const gain = audioContext.createGain();
      gain.gain.value = voiceOptions.volume;
      let filter = null;
      let panner = null;
      let tail = source;
      if (voiceOptions.spatial) {
        const spatial = voiceOptions.spatial;
        if (spatial.occlusion) {
          filter = audioContext.createBiquadFilter();
          filter.type = 'lowpass';
          filter.frequency.value = occlusionHertz(voiceOptions.occlusion);
          tail.connect(filter);
          tail = filter;
        }
        panner = audioContext.createPanner();
        panner.panningModel = 'HRTF';
        panner.distanceModel = spatial.model;
        panner.refDistance = spatial.referenceDistance;
        panner.maxDistance = spatial.maximumDistance;
        panner.rolloffFactor = spatial.rolloff;
        setPannerPosition(panner, voiceOptions.position, now);
        tail.connect(panner);
        tail = panner;
      }
      tail.connect(gain);
      gain.connect(buses.get(voiceOptions.bus));
      let ended = false;
      source.onended = () => {
        ended = true;
        voiceOptions.onEnded();
      };
      source.start(now);
      return {
        update(change) {
          const time = audioContext.currentTime;
          setParameter(gain.gain, change.volume, time);
          setParameter(source.playbackRate, change.pitch, time);
          if (panner) setPannerPosition(panner, change.position, time);
          if (filter) setParameter(filter.frequency, occlusionHertz(change.occlusion), time);
        },
        stop() {
          if (ended) return;
          ended = true;
          source.onended = null;
          try {
            source.stop();
          } catch {
            // A source that never started or already ended throws; either way it is silent.
          }
          source.disconnect();
        },
      };
    },
  };
}

// ---- The audio system ----

function resolveNumber(value, data, label, minimum, maximum) {
  const resolved = typeof value === 'function' ? value(data) : value;
  return requireNumberInRange(resolved, label, minimum, maximum);
}

function createSeededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

export function createAudio(options = {}) {
  const backend = options.backend ?? webAudioBackend(options.webAudio);
  const maximumVoices = requireNumberInRange(options.maximumVoices ?? AUDIO_LIMITS.defaultVoices, 'createAudio maximumVoices', 1, AUDIO_LIMITS.maximumVoices);
  const occluder = options.occlusion ?? null;
  if (occluder !== null && typeof occluder !== 'function') {
    throw new TypeError('createAudio occlusion must be a function (from, to) => 0 to 1, or left out.');
  }
  const listenerSource = options.listener ?? null;
  if (listenerSource !== null && typeof listenerSource !== 'function') {
    throw new TypeError('createAudio listener must be a function () => camera frame { eye, target, up }, or left out.');
  }
  const random = createSeededRandom(options.seed ?? 1);
  const sounds = new Map();
  const bindings = new Map(); // event name -> [{ sound, options }]
  const actionEvents = new Map(); // action name -> event name
  const busVolumes = new Map();
  const voices = [];
  let bindingCount = 0;
  let nextVoiceId = 1;
  let started = false;
  let input = options.input ?? null;
  let listenerPose = { position: [0, 0, 0], forward: [0, 0, -1], up: [0, 1, 0] };

  function createBus(name, volume = 1) {
    requireName(name, 'bus name');
    requireNumberInRange(volume, `bus ${name} volume`, 0, 4);
    if (name === 'master') throw new RangeError('The bus name master is reserved for the output level. Use setBusVolume("master", volume) to change it.');
    if (!busVolumes.has(name) && busVolumes.size >= AUDIO_LIMITS.maximumBuses) {
      throw new RangeError(`An audio can have at most ${AUDIO_LIMITS.maximumBuses} buses, so ${name} was not added.`);
    }
    busVolumes.set(name, volume);
    if (started) backend.createBus(name, volume);
  }

  busVolumes.set('master', 1);
  for (const name of DEFAULT_BUSES) busVolumes.set(name, 1);
  for (const [name, volume] of Object.entries(options.buses ?? {})) createBus(name, volume);

  function requireBus(name) {
    if (!busVolumes.has(name) || name === 'master') {
      throw new RangeError(`Unknown bus ${String(name)}. Use one of ${[...busVolumes.keys()].filter(key => key !== 'master').join(', ')} or add it with createBus(name).`);
    }
    return name;
  }

  function requireSound(name) {
    const sound = sounds.get(name);
    if (!sound) {
      throw new RangeError(`Unknown sound ${String(name)}. Define it first with audio.defineSound(name, { buffer }) or await audio.load(name, source). Known: ${[...sounds.keys()].join(', ') || 'none'}.`);
    }
    return sound;
  }

  function defineSound(name, definition) {
    requireName(name, 'sound name');
    if (definition === null || typeof definition !== 'object') {
      throw new TypeError(`defineSound(${name}, definition) needs { buffer, bus, volume, pitch, loop, spatial }, got ${describe(definition)}.`);
    }
    if (!sounds.has(name) && sounds.size >= AUDIO_LIMITS.maximumSounds) {
      throw new RangeError(`An audio can hold at most ${AUDIO_LIMITS.maximumSounds} sounds, so ${name} was not added.`);
    }
    if (!definition.buffer || typeof definition.buffer.duration !== 'number') {
      throw new TypeError(`defineSound(${name}) buffer must be a decoded AudioBuffer. To load a URL or ArrayBuffer use await audio.load(name, source).`);
    }
    const sound = Object.freeze({
      name,
      buffer: definition.buffer,
      bus: requireBus(definition.bus ?? 'effects'),
      volume: requireNumberInRange(definition.volume ?? 1, `sound ${name} volume`, 0, 4),
      pitch: requireNumberInRange(definition.pitch ?? 1, `sound ${name} pitch`, 0.1, 4),
      pitchVariance: requireNumberInRange(definition.pitchVariance ?? 0, `sound ${name} pitchVariance`, 0, 1),
      loop: definition.loop === true,
      maximumInstances: requireNumberInRange(definition.maximumInstances ?? AUDIO_LIMITS.defaultInstancesPerSound, `sound ${name} maximumInstances`, 1, AUDIO_LIMITS.maximumInstancesPerSound),
      spatial: normalizeSpatial(definition.spatial, `sound ${name}`),
    });
    sounds.set(name, sound);
    return sound;
  }

  async function load(name, source, definition = {}) {
    requireName(name, 'sound name');
    backend.init();
    const buffer = await backend.decode(source);
    return defineSound(name, { ...definition, buffer });
  }

  // ---- Voices ----

  function voiceLevel(voice) {
    const sound = voice.sound;
    let level = voice.volume * busVolumes.get(sound.bus) * busVolumes.get('master');
    if (voice.position && sound.spatial) {
      level *= distanceGain(distanceBetween(voice.position, listenerPose.position), sound.spatial);
      level *= 1 - OCCLUDED_GAIN_LOSS * voice.occlusion;
    }
    return level;
  }

  function resolveVoicePosition(voice) {
    return readNodePosition(voice.node, `sound ${voice.sound.name} node`);
  }

  function measureOcclusion(voice) {
    if (!occluder || !voice.sound.spatial?.occlusion || !voice.position) return 0;
    return requireNumberInRange(occluder(listenerPose.position, voice.position), 'occlusion function result', 0, 1);
  }

  function removeVoice(voice) {
    const index = voices.indexOf(voice);
    if (index >= 0) voices.splice(index, 1);
  }

  function stopVoice(voice) {
    voice.backendVoice.stop();
    removeVoice(voice);
  }

  function makeRoom(sound, level) {
    const sameSound = voices.filter(voice => voice.sound === sound);
    if (sameSound.length >= sound.maximumInstances) stopVoice(sameSound[0]);
    if (voices.length < maximumVoices) return true;
    const quietest = voices.reduce((lowest, voice) => (voice.level < lowest.level ? voice : lowest), voices[0]);
    if (quietest.level >= level) return false;
    stopVoice(quietest);
    return true;
  }

  // Plays a sound. Options: position [x, y, z] or node (follows it), volume, pitch, bus, loop. Returns a handle, or null when
  // the voice limit is full of louder sounds.
  function play(soundName, playOptions = {}) {
    const sound = requireSound(soundName);
    startBackend();
    const volume = sound.volume * requireNumberInRange(playOptions.volume ?? 1, `play ${soundName} volume`, 0, 4);
    const variance = sound.pitchVariance === 0 ? 0 : (random() * 2 - 1) * sound.pitchVariance;
    const pitch = sound.pitch * requireNumberInRange(playOptions.pitch ?? 1, `play ${soundName} pitch`, 0.1, 4) * (1 + variance);
    const voice = {
      id: nextVoiceId,
      sound,
      node: playOptions.node ?? null,
      position: null,
      volume,
      pitch: requireNumberInRange(pitch, `play ${soundName} resulting pitch`, 0.1, 16),
      loop: playOptions.loop ?? sound.loop,
      occlusion: 0,
      level: 0,
      backendVoice: null,
    };
    if (sound.spatial) {
      if (voice.node === null && playOptions.position === undefined) {
        throw new TypeError(`Sound ${soundName} is spatial, so play it with { position: [x, y, z] } or { node }. For a flat sound define it without spatial.`);
      }
      voice.position = voice.node === null
        ? requireVector(playOptions.position, `play ${soundName} position`)
        : resolveVoicePosition(voice);
    }
    voice.occlusion = measureOcclusion(voice);
    voice.level = voiceLevel(voice);
    if (!makeRoom(sound, voice.level)) return null;
    nextVoiceId += 1;
    voice.backendVoice = backend.startVoice({
      buffer: sound.buffer,
      bus: sound.bus,
      volume: voice.volume,
      pitch: voice.pitch,
      loop: voice.loop,
      spatial: sound.spatial,
      position: voice.position,
      occlusion: voice.occlusion,
      onEnded: () => removeVoice(voice),
    });
    voices.push(voice);
    return Object.freeze({
      id: voice.id,
      sound: soundName,
      stop: () => stopVoice(voice),
      get playing() {
        return voices.includes(voice);
      },
      get level() {
        return voice.level;
      },
    });
  }

  // A sound that follows a node: loops by default, so an engine hum stays on its vehicle until stop() is called.
  function attach(node, soundName, playOptions = {}) {
    return play(soundName, { loop: true, ...playOptions, node });
  }

  function stopAll(soundName) {
    for (const voice of [...voices]) {
      if (soundName === undefined || voice.sound.name === soundName) stopVoice(voice);
    }
  }

  // The active voices, for tests and a debug overlay: level is the predicted output level after bus, distance and occlusion.
  function activeVoices() {
    return voices.map(voice => Object.freeze({
      id: voice.id,
      sound: voice.sound.name,
      bus: voice.sound.bus,
      volume: voice.volume,
      pitch: voice.pitch,
      loop: voice.loop,
      position: voice.position ? [...voice.position] : null,
      occlusion: voice.occlusion,
      level: voice.level,
    }));
  }

  // ---- Events ----

  // Bind an event name to a sound. volume, pitch and position are numbers or functions (eventData) => value, so a contact's
  // impulse can set the loudness: bindEvent('contact', 'thud', { volume: data => Math.min(1, data.impulse / 20) }).
  function bindEvent(eventName, soundName, bindOptions = {}) {
    requireName(eventName, 'event name');
    requireSound(soundName);
    if (bindingCount >= AUDIO_LIMITS.maximumBindings) {
      throw new RangeError(`An audio can hold at most ${AUDIO_LIMITS.maximumBindings} event bindings, so ${eventName} was not bound.`);
    }
    for (const field of ['volume', 'pitch']) {
      const value = bindOptions[field];
      if (value !== undefined && typeof value !== 'function' && !Number.isFinite(value)) {
        throw new TypeError(`bindEvent ${eventName} ${field} must be a number or a function (eventData) => number, got ${describe(value)}.`);
      }
    }
    if (!bindings.has(eventName)) bindings.set(eventName, []);
    const entry = { soundName, options: bindOptions };
    bindings.get(eventName).push(entry);
    bindingCount += 1;
    return () => {
      const list = bindings.get(eventName);
      const index = list ? list.indexOf(entry) : -1;
      if (index >= 0) {
        list.splice(index, 1);
        bindingCount -= 1;
      }
    };
  }

  function playBinding(entry, data) {
    const settings = entry.options;
    const playOptions = {
      volume: settings.volume === undefined ? 1 : resolveNumber(settings.volume, data, `${entry.soundName} volume`, 0, 4),
      pitch: settings.pitch === undefined ? 1 : resolveNumber(settings.pitch, data, `${entry.soundName} pitch`, 0.1, 4),
    };
    const position = typeof settings.position === 'function' ? settings.position(data) : settings.position ?? data?.position;
    if (settings.node !== undefined) playOptions.node = settings.node;
    else if (position !== undefined) playOptions.position = position;
    return play(entry.soundName, playOptions);
  }

  // Fires every sound bound to the event. Returns the handles that started.
  function emit(eventName, data = {}) {
    requireName(eventName, 'event name');
    const handles = [];
    for (const entry of [...(bindings.get(eventName) ?? [])]) {
      const handle = playBinding(entry, data);
      if (handle) handles.push(handle);
    }
    return handles;
  }

  // Input: a pressed action fires the event input:<action>. The input system must run before this one.
  function bindAction(actionName, soundName, bindOptions = {}) {
    requireName(actionName, 'action name');
    if (!input) throw new TypeError('bindAction needs an input: pass createAudio({ input }) or call audio.setInput(input).');
    const eventName = `input:${actionName}`;
    actionEvents.set(actionName, eventName);
    return bindEvent(eventName, soundName, bindOptions);
  }

  function setInput(newInput) {
    if (!newInput || typeof newInput.wasPressed !== 'function') {
      throw new TypeError('setInput needs an input from createInput (it has wasPressed(action)).');
    }
    input = newInput;
  }

  // Physics contacts (the recorded scene's contactEvents): each started event fires contact (or sensor), plus
  // contact:<collider> for both colliders, so a sound can bind to one body. data.position comes from options.position(event).
  function emitContacts(contactEvents, contactOptions = {}) {
    if (!Array.isArray(contactEvents)) {
      throw new TypeError(`emitContacts needs an array of contact events { started, kind, colliderA, colliderB, ... }, got ${describe(contactEvents)}.`);
    }
    for (const event of contactEvents) {
      if (event.started === false) continue;
      const data = contactOptions.position ? { ...event, position: contactOptions.position(event) } : event;
      const kind = event.kind === 'sensor' ? 'sensor' : 'contact';
      emit(kind, data);
      emit(`${kind}:${String(event.colliderA)}`, data);
      emit(`${kind}:${String(event.colliderB)}`, data);
    }
  }

  // Animation markers crossed between two clip times fire marker:<name>, with the marker and extra data in the event data.
  function emitMarkers(markers, fromTime, toTime, markerOptions = {}) {
    for (const marker of markersCrossed(markers, fromTime, toTime, markerOptions)) {
      emit(`marker:${marker.name}`, { ...markerOptions.data, marker, time: marker.time });
    }
  }

  // ---- Mixing ----

  function setBusVolume(name, volume) {
    requireNumberInRange(volume, `bus ${String(name)} volume`, 0, 4);
    if (name !== 'master') requireBus(name);
    busVolumes.set(name, volume);
    if (started) backend.setBusVolume(name, volume);
    for (const voice of voices) voice.level = voiceLevel(voice);
  }

  function getBusVolume(name) {
    if (!busVolumes.has(name)) requireBus(name);
    return busVolumes.get(name);
  }

  function setListener(camera) {
    listenerPose = readListener(camera);
    if (started) backend.setListener(listenerPose);
  }

  function synchronize() {
    if (listenerSource) setListener(listenerSource());
    for (const voice of [...voices]) {
      if (voice.node !== null && voice.sound.spatial) voice.position = resolveVoicePosition(voice);
      voice.occlusion = measureOcclusion(voice);
      voice.level = voiceLevel(voice);
      voice.backendVoice.update({ volume: voice.volume, pitch: voice.pitch, position: voice.position, occlusion: voice.occlusion });
    }
  }

  // ---- Runtime system ----

  function startBackend() {
    if (started) return;
    backend.init();
    for (const [name, volume] of busVolumes) {
      if (name !== 'master') backend.createBus(name, volume);
    }
    backend.setBusVolume('master', busVolumes.get('master'));
    backend.setListener(listenerPose);
    started = true;
  }

  return {
    name: options.name ?? 'audio',
    init() {
      startBackend();
    },
    fixedUpdate(step, context) {
      if (input) {
        for (const [actionName, eventName] of actionEvents) {
          if (input.wasPressed(actionName)) emit(eventName, { action: actionName });
        }
      }
      if (context?.mode === 'fixed') synchronize();
    },
    update() {
      synchronize();
    },
    dispose() {
      stopAll();
      backend.dispose();
      started = false;
    },
    backend,
    defineSound,
    load,
    createBus,
    setBusVolume,
    getBusVolume,
    play,
    attach,
    stopAll,
    activeVoices,
    bindEvent,
    bindAction,
    setInput,
    emit,
    emitContacts,
    emitMarkers,
    setListener,
    synchronize,
    unlock: () => backend.unlock?.(),
  };
}
