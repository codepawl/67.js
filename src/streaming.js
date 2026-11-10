// Live asset streaming: a runtime system that loads, swaps and frees assets while a game plays.
// Assets are requested by distance from a focus point or by an explicit game request, held under a byte budget with
// least-recently-used eviction, and switched between detail levels with hysteresis. Formats load through plugins, so GLB
// is only the first loader. Everything is decided inside update() from the focus, a counter and sorted ids, never from
// wall time, so the same walk streams in the same order. Loaders are async; update() only starts them. See docs/streaming.md.

export const STREAMING_LIMITS = Object.freeze({
  maximumAssets: 4096,
  maximumLevels: 8,
  maximumLoaders: 32,
  maximumConcurrentLoads: 16,
  defaultConcurrentLoads: 2,
  maximumBudgetBytes: 2 ** 40,
  defaultHysteresis: 0.1,
  maximumHysteresis: 1,
  eventHistory: 256,
});

export const STREAMING_STATES = Object.freeze(['idle', 'pending', 'loaded', 'evicted', 'failed']);

function describe(value) {
  return value === null ? 'null' : typeof value;
}

function compareText(first, second) {
  if (first === second) return 0;
  return first < second ? -1 : 1;
}

function boundedNumber(value, label, minimum, maximum) {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new RangeError(`${label} must be a number from ${minimum} to ${maximum}, got ${String(value)}.`);
  }
  return value;
}

function validatePoint(point, label) {
  if (!Array.isArray(point) && !ArrayBuffer.isView(point)) {
    throw new TypeError(`${label} must be a point like [x, y, z], got ${describe(point)}.`);
  }
  if (point.length !== 3 || !Array.prototype.every.call(point, Number.isFinite)) {
    throw new RangeError(`${label} must be three finite numbers [x, y, z].`);
  }
  return [point[0], point[1], point[2]];
}

/**
 * Pick a detail level for a distance, with hysteresis. `maximumDistances[i]` is where level i ends; the last level has no end.
 * A level only coarsens once the distance passes its end by `hysteresis` (a fraction), and only refines once the distance falls
 * short of the finer level's end by the same fraction, so a focus standing on a boundary never flaps.
 */
export function selectDetailLevel(maximumDistances, distance, currentLevel = 0, hysteresis = STREAMING_LIMITS.defaultHysteresis) {
  let level = Math.min(Math.max(currentLevel, 0), maximumDistances.length);
  while (level < maximumDistances.length && distance > maximumDistances[level] * (1 + hysteresis)) level += 1;
  while (level > 0 && distance < maximumDistances[level - 1] * (1 - hysteresis)) level -= 1;
  return level;
}

/** The GLB loader. It imports the glTF parser on first use, so a game that streams nothing pays nothing. Pass `options` for parseGltf limits and decoders, or `fetchBytes(source, signal)` to read bytes elsewhere. */
export function createGlbLoader({ options = {}, fetchBytes } = {}) {
  return {
    async load({ source, signal }) {
      const { parseGltf } = await import('./gltf.js');
      const bytes = fetchBytes ? await fetchBytes(source, signal) : await fetchArrayBuffer(source, signal);
      const asset = await parseGltf(bytes, { baseUrl: baseUrlOf(source), ...options });
      return { asset, bytes: bytes.byteLength };
    },
    dispose(asset) {
      asset.dispose();
    },
  };
}

async function fetchArrayBuffer(source, signal) {
  const response = await fetch(source, { signal });
  if (!response.ok) throw new Error(`Fetching ${source} failed with status ${response.status}.`);
  return response.arrayBuffer();
}

function baseUrlOf(source) {
  return /^https?:/.test(source) ? new URL('.', source).href : '';
}

function validateLoader(format, loader) {
  if (typeof format !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(format)) {
    throw new TypeError(`A loader format must be a lowercase name like "glb" or "terrain-tile", got ${describe(format)} ${String(format)}.`);
  }
  if (loader === null || typeof loader !== 'object' || typeof loader.load !== 'function') {
    throw new TypeError(`Loader "${format}" must be an object { load(request) => Promise<{ asset, bytes }>, dispose(asset) }, got ${describe(loader)}.`);
  }
  if (loader.dispose !== undefined && typeof loader.dispose !== 'function') {
    throw new TypeError(`Loader "${format}" dispose must be a function or left out.`);
  }
}

function validateDefinition(definition, loaders, hysteresis) {
  if (definition === null || typeof definition !== 'object') {
    throw new TypeError(`A streamed asset must be an object { id, format, source, position, loadDistance, estimatedBytes }, got ${describe(definition)}.`);
  }
  const { id, format } = definition;
  if (typeof id !== 'string' || id === '') throw new TypeError('A streamed asset needs a unique id string.');
  if (!loaders.has(format)) {
    const known = [...loaders.keys()].sort().join(', ') || 'none';
    throw new RangeError(`Streamed asset "${id}" uses format "${String(format)}" with no loader. Register one with registerLoader first; registered: ${known}.`);
  }
  const position = validatePoint(definition.position ?? [0, 0, 0], `Streamed asset "${id}" position`);
  const loadDistance = definition.loadDistance === undefined ? Infinity : boundedNumber(definition.loadDistance, `Streamed asset "${id}" loadDistance`, 0, Infinity);
  const levelInputs = definition.levels ?? [{ source: definition.source, estimatedBytes: definition.estimatedBytes }];
  if (!Array.isArray(levelInputs) || levelInputs.length < 1 || levelInputs.length > STREAMING_LIMITS.maximumLevels) {
    throw new RangeError(`Streamed asset "${id}" levels must be an array of 1 to ${STREAMING_LIMITS.maximumLevels} { source, estimatedBytes, maximumDistance }.`);
  }
  const levels = levelInputs.map((level, index) => {
    if (typeof level?.source !== 'string' || level.source === '') {
      throw new TypeError(`Streamed asset "${id}" level ${index} needs a source string (a URL).`);
    }
    const estimatedBytes = boundedNumber(level.estimatedBytes, `Streamed asset "${id}" level ${index} estimatedBytes`, 1, STREAMING_LIMITS.maximumBudgetBytes);
    const isLast = index === levelInputs.length - 1;
    const maximumDistance = isLast ? Infinity : boundedNumber(level.maximumDistance, `Streamed asset "${id}" level ${index} maximumDistance`, 0, Infinity);
    return { source: level.source, estimatedBytes: Math.ceil(estimatedBytes), maximumDistance };
  });
  for (let index = 1; index < levels.length - 1; index += 1) {
    if (levels[index].maximumDistance <= levels[index - 1].maximumDistance) {
      throw new RangeError(`Streamed asset "${id}" level maximumDistance values must increase from the finest level to the coarsest.`);
    }
  }
  return { id, format, position, loadDistance, unloadDistance: loadDistance * (1 + hysteresis), levels };
}

export function createStreaming(options = {}) {
  if (options === null || typeof options !== 'object') throw new TypeError('createStreaming options must be an object or left out.');
  const budgetBytes = Math.floor(boundedNumber(options.budgetBytes, 'createStreaming budgetBytes', 1, STREAMING_LIMITS.maximumBudgetBytes));
  const hysteresis = boundedNumber(options.hysteresis ?? STREAMING_LIMITS.defaultHysteresis, 'createStreaming hysteresis', 0, STREAMING_LIMITS.maximumHysteresis);
  const maximumConcurrentLoads = boundedNumber(options.maximumConcurrentLoads ?? STREAMING_LIMITS.defaultConcurrentLoads, 'createStreaming maximumConcurrentLoads', 1, STREAMING_LIMITS.maximumConcurrentLoads);
  if (options.focus !== undefined && typeof options.focus !== 'function') {
    throw new TypeError('createStreaming focus must be a function () => [x, y, z], or left out and set with setFocus.');
  }
  if (options.onEvent !== undefined && typeof options.onEvent !== 'function') {
    throw new TypeError('createStreaming onEvent must be a function (event) or left out.');
  }

  const loaders = new Map();
  const records = new Map();
  const events = [];
  let focusPoint = [0, 0, 0];
  let tick = 0;
  let activeLoads = 0;
  let disposed = false;

  function emit(type, id, level, extra = {}) {
    const event = { type, id, level, tick, ...extra };
    events.push(event);
    if (events.length > STREAMING_LIMITS.eventHistory) events.shift();
    options.onEvent?.(event);
  }

  function registerLoader(format, loader) {
    validateLoader(format, loader);
    if (loaders.has(format)) throw new RangeError(`A loader for "${format}" is already registered. Use another format name.`);
    if (loaders.size >= STREAMING_LIMITS.maximumLoaders) throw new RangeError(`At most ${STREAMING_LIMITS.maximumLoaders} loaders can be registered.`);
    loaders.set(format, loader);
  }

  function addAsset(definition) {
    if (disposed) throw new Error('The streaming system was disposed.');
    const asset = validateDefinition(definition, loaders, hysteresis);
    if (records.has(asset.id)) throw new RangeError(`A streamed asset named "${asset.id}" already exists. Pass another id.`);
    if (records.size >= STREAMING_LIMITS.maximumAssets) throw new RangeError(`At most ${STREAMING_LIMITS.maximumAssets} streamed assets can be defined.`);
    records.set(asset.id, { ...asset, wanted: false, requested: false, level: 0, resident: new Map(), pendingLevels: new Map(), lastUsed: 0, state: 'idle', failure: null });
  }

  const recordFor = id => {
    const record = records.get(id);
    if (!record) throw new RangeError(`No streamed asset named "${String(id)}". Add it with addAsset first.`);
    return record;
  };

  function bytesInUse() {
    let total = 0;
    for (const record of records.values()) {
      for (const resident of record.resident.values()) total += resident.bytes;
      for (const pending of record.pendingLevels.values()) total += pending.reservedBytes;
    }
    return total;
  }

  function evictable() {
    const candidates = [];
    for (const record of records.values()) {
      if (record.wanted || record.requested) continue;
      for (const [level, resident] of record.resident) candidates.push({ record, level, resident });
    }
    return candidates.sort((first, second) => first.record.lastUsed - second.record.lastUsed || compareText(first.record.id, second.record.id) || first.level - second.level);
  }

  function evict({ record, level, resident }, reason) {
    loaders.get(record.format).dispose?.(resident.asset);
    record.resident.delete(level);
    if (record.resident.size === 0 && record.pendingLevels.size === 0) record.state = 'evicted';
    emit('evict', record.id, level, { reason, bytes: resident.bytes });
  }

  /** Free least recently used assets nobody wants until `neededBytes` fit. Returns whether they fit. */
  function makeRoom(neededBytes) {
    let used = bytesInUse();
    if (used + neededBytes <= budgetBytes) return true;
    for (const candidate of evictable()) {
      used -= candidate.resident.bytes;
      evict(candidate, 'budget');
      if (used + neededBytes <= budgetBytes) return true;
    }
    return false;
  }

  function startLoad(record, level) {
    const loader = loaders.get(record.format);
    const levelDefinition = record.levels[level];
    const controller = new AbortController();
    const pending = { reservedBytes: levelDefinition.estimatedBytes, controller };
    record.pendingLevels.set(level, pending);
    record.state = 'pending';
    activeLoads += 1;
    emit('load-start', record.id, level);
    const request = { id: record.id, format: record.format, source: levelDefinition.source, level, signal: controller.signal };
    Promise.resolve()
      .then(() => loader.load(request))
      .then(result => finishLoad(record, level, pending, loader, result), error => failLoad(record, level, pending, error));
  }

  function finishLoad(record, level, pending, loader, result) {
    activeLoads -= 1;
    record.pendingLevels.delete(level);
    const bytes = Number.isFinite(result?.bytes) && result.bytes >= 0 ? Math.ceil(result.bytes) : pending.reservedBytes;
    if (disposed || pending.controller.signal.aborted) {
      loader.dispose?.(result?.asset);
      return;
    }
    record.resident.set(level, { asset: result.asset, bytes });
    record.state = 'loaded';
    record.lastUsed = tick;
    emit('loaded', record.id, level, { bytes });
    if (bytesInUse() > budgetBytes) makeRoom(0);
    retireOtherLevels(record);
  }

  function failLoad(record, level, pending, error) {
    activeLoads -= 1;
    record.pendingLevels.delete(level);
    if (disposed || pending.controller.signal.aborted) return;
    record.state = record.resident.size > 0 ? 'loaded' : 'failed';
    record.failure = error instanceof Error ? error.message : String(error);
    record.requested = false;
    record.wanted = false;
    emit('failed', record.id, level, { message: record.failure });
  }

  /** Once the level the focus needs is resident, the other levels of that asset are no longer shown, so they go. */
  function retireOtherLevels(record) {
    if (!record.resident.has(record.level)) return;
    for (const [level, resident] of [...record.resident]) {
      if (level !== record.level) evict({ record, level, resident }, 'level-switch');
    }
  }

  function distanceTo(record) {
    return Math.hypot(record.position[0] - focusPoint[0], record.position[1] - focusPoint[1], record.position[2] - focusPoint[2]);
  }

  function updateWanted(record, distance) {
    if (record.wanted) {
      if (distance > record.unloadDistance) record.wanted = false;
    } else if (distance <= record.loadDistance) {
      record.wanted = true;
    }
  }

  function update() {
    if (disposed) return;
    tick += 1;
    if (options.focus) focusPoint = validatePoint(options.focus(), 'createStreaming focus()');
    const wantedLoads = [];
    for (const record of records.values()) {
      if (record.state === 'failed') continue;
      const distance = distanceTo(record);
      updateWanted(record, distance);
      if (!record.wanted && !record.requested) continue;
      record.level = selectDetailLevel(record.levels.slice(0, -1).map(level => level.maximumDistance), distance, record.level, hysteresis);
      record.lastUsed = tick;
      if (!record.resident.has(record.level) && !record.pendingLevels.has(record.level)) wantedLoads.push({ record, distance });
      else retireOtherLevels(record);
    }
    wantedLoads.sort((first, second) => first.distance - second.distance || compareText(first.record.id, second.record.id));
    for (const { record } of wantedLoads) {
      if (activeLoads >= maximumConcurrentLoads) break;
      const needed = record.levels[record.level].estimatedBytes;
      if (makeRoom(needed)) startLoad(record, record.level);
    }
  }

  function request(id) {
    const record = recordFor(id);
    if (record.state === 'failed') {
      record.state = record.resident.size > 0 ? 'loaded' : 'idle';
      record.failure = null;
    }
    record.requested = true;
  }

  function release(id) {
    recordFor(id).requested = false;
  }

  function setFocus(point) {
    focusPoint = validatePoint(point, 'setFocus point');
  }

  function getState(id) {
    const record = recordFor(id);
    const resident = record.resident.get(record.level) ?? [...record.resident.values()][0];
    return { state: record.state, level: record.level, bytes: resident?.bytes ?? 0, failure: record.failure };
  }

  /** The loaded asset to draw: the wanted level when it is loaded, else any level still resident, else null. Reading it counts as a use. */
  function getAsset(id) {
    const record = recordFor(id);
    const entry = record.resident.get(record.level) ?? [...record.resident.entries()].sort(([first], [second]) => first - second)[0]?.[1];
    if (!entry) return null;
    record.lastUsed = tick;
    return entry.asset;
  }

  /** Resolves once no load is in flight and update() would start none more; for tests and loading screens. */
  async function settled() {
    for (let round = 0; round < STREAMING_LIMITS.maximumAssets * STREAMING_LIMITS.maximumLevels; round += 1) {
      await new Promise(resolve => setTimeout(resolve, 0));
      if (activeLoads === 0) return;
    }
    throw new Error('Streaming did not settle; a loader never resolved.');
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const record of records.values()) {
      for (const pending of record.pendingLevels.values()) pending.controller.abort();
      for (const [level, resident] of [...record.resident]) {
        loaders.get(record.format).dispose?.(resident.asset);
        record.resident.delete(level);
      }
      record.state = 'evicted';
    }
  }

  const stats = () => {
    const counts = Object.fromEntries(STREAMING_STATES.map(state => [state, 0]));
    for (const record of records.values()) counts[record.state] += 1;
    return { ...counts, bytesInUse: bytesInUse(), budgetBytes, activeLoads, assets: records.size };
  };

  for (const [format, loader] of Object.entries(options.loaders ?? {})) registerLoader(format, loader);
  if (!loaders.has('glb')) registerLoader('glb', createGlbLoader());
  for (const definition of options.assets ?? []) addAsset(definition);

  return {
    name: options.name ?? 'streaming',
    update,
    dispose,
    registerLoader,
    addAsset,
    request,
    release,
    setFocus,
    getState,
    getAsset,
    settled,
    get stats() { return stats(); },
    get events() { return events.slice(); },
    get loaders() { return [...loaders.keys()].sort(); },
  };
}
