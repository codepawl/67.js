import { readFileSync, unlinkSync } from 'node:fs';
import { mkdir, open, readFile, writeFile, rename, unlink, rmdir, readdir, lstat, realpath } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';

import { RENDER_PASS_NAMES, RENDER_OUTPUT_FORMATS, MAXIMUM_JOB_FPS, VIDEO_ENCODERS, AUDIO_FILE_PATTERN, MAXIMUM_VIDEO_SECONDS, MAXIMUM_JOB_SIDE, MAXIMUM_JOB_PIXELS } from '../src/agent-scene-capabilities.js';
import { recipeAssetNeeds } from '../src/agent-scene-assets.js';
import { normalizeFilmTimeline, filmTimelineDuration } from '../src/film-timeline.js';
import { OIDN_DEFAULT_SAMPLES, PATH_TRACER_DENOISERS, PATH_TRACER_JOB_LIMITS } from '../src/path-tracer-capabilities.js';
import { AGENT_ASSET_LIMITS, describeAssetBytes } from '../src/agent-asset-limits.js';

const UUID =/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const STATES = ['queued', 'running', 'finalizing', 'completed', 'cancelling', 'cancelled', 'failed', 'interrupted'];
const TERMINAL = new Set(['completed', 'cancelled', 'failed', 'interrupted']);
/** Hard ceiling on one job's elapsed time. The deadline below it grows with the job's frames and pixels. */
export const MAXIMUM_JOB_DEADLINE_MS = 30 * 60 * 1000;
const BASE_DEADLINE_MS = 60 * 1000;
const FRAME_ALLOWANCE_MS = 2000;
const REFERENCE_FRAME_PIXELS = 1024 * 576;
/** A 1920x1080 PNG of a busy scene runs to several MiB, so a frame may be up to 12 MiB. */
const DEFAULT_LIMITS = Object.freeze({ maxRecords: 32, maxStoreBytes: 512 * 1024 ** 2, maxOutputBytes: 128 * 1024 ** 2, maxFrameBytes: 12 * 1024 ** 2, deadlineMs: MAXIMUM_JOB_DEADLINE_MS, cleanupMs: 5000 });

/** Time the page needs to start, draw the scene and encode the PNG around a path trace that runs for its whole maxSeconds. */
const PATH_TRACE_OVERHEAD_MS = 60 * 1000;

/**
 * 60 s plus 2 s per frame, scaled up for frames larger than 1024x576, never above the ceiling. A path trace may run for
 * its own maxSeconds on every frame, so its deadline also reaches that plus the overhead and the trace stops itself first.
 */
export function jobDeadlineMs({ frameCount, width, height, renderer }, maximumMs = MAXIMUM_JOB_DEADLINE_MS) {
  const sizeScale = Math.max(1, (width * height) / REFERENCE_FRAME_PIXELS);
  const frameDeadline = Math.ceil(BASE_DEADLINE_MS + frameCount * FRAME_ALLOWANCE_MS * sizeScale);
  const traceDeadline = renderer?.type === 'pathTracer' ? Math.ceil(renderer.maxSeconds * 1000 * frameCount) + PATH_TRACE_OVERHEAD_MS : 0;
  return Math.min(maximumMs, Math.max(frameDeadline, traceDeadline));
}
const MINIMUM_REGION_SIDE = 16;
/** A 16-bit PNG or an EXR of a busy 1920x1080 frame is bigger than the 8-bit PNG the frame limit was sized for. */
export const HIGH_PRECISION_FRAME_FACTOR = 4;
const MAXIMUM_JSON_BYTES = 1024 ** 2;
const MAXIMUM_ASSET_BYTES = AGENT_ASSET_LIMITS.maxBytes;
/** Sibling folder of the job directories where the runtime keeps GLB exports; the store never reads or counts it. */
export const EXPORT_DIRECTORY_NAME = 'exports';
const STORE_FILES = ['store.json', 'store.lock', EXPORT_DIRECTORY_NAME];
const INTERNAL_FILES =new Set(['owner.json', 'snapshot.json', 'asset.glb', 'status.json', 'status.json.pending']);

function objectKeys(value, allowed, label) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) throw new TypeError(`${label} must be a plain object.`);
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new TypeError(`Unknown ${label} field: ${key}. Allowed fields: ${allowed.join(", ")}.`);
  }
}

function boundedNumber(value, minimum, maximum, label, integer = false) {
  if (!Number.isFinite(value) || value < minimum || value > maximum || (integer && !Number.isInteger(value))) {
    throw new RangeError(`${label} must be within ${minimum} and ${maximum}${integer ? ' as an integer' : ''}.`);
  }
  return value;
}

function jsonCopy(value, maximum = MAXIMUM_JSON_BYTES) {
  const ancestors = new Set();
  let estimatedBytes = 0;
  function validate(input, depth) {
    if (depth > 64) throw new RangeError('JSON nesting exceeds 64 levels.');
    estimatedBytes += typeof input === 'string' ? Buffer.byteLength(input) : 1;
    if (estimatedBytes > maximum) throw new RangeError('Snapshot JSON exceeds its byte budget.');
    if (input === null || typeof input === 'boolean' || typeof input === 'string') return;
    if (typeof input === 'number' && Number.isFinite(input)) return;
    if (!input || typeof input !== 'object' || ancestors.has(input)) throw new TypeError('Snapshot must contain finite, acyclic JSON.');
    if (!Array.isArray(input) && Object.getPrototypeOf(input) !== Object.prototype) throw new TypeError('Snapshot must contain plain JSON.');
    ancestors.add(input);
    if (Array.isArray(input) && (input.length > maximum || Object.keys(input).length !== input.length || Object.keys(input).some((key, index) => key !== String(index)))) throw new TypeError('Snapshot arrays must be bounded and dense.');
    for (const key of Reflect.ownKeys(input)) {
      if (Array.isArray(input) && key === 'length') continue;
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (typeof key !== 'string' || key === '__proto__' || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw new TypeError('Snapshot accessors and hidden fields are unsupported.');
      validate(descriptor.value, depth + 1);
    }
    ancestors.delete(input);
  }
  validate(value, 0);
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text) > maximum) throw new RangeError('Snapshot JSON exceeds its byte budget.');
  return JSON.parse(text);
}

/** Seconds the recipe's physics or cloth bake covers, or undefined when it has neither. Both play on the motion clock. */
function bakedPhysicsDuration(recipe) {
  const durations = [recipe?.physics?.duration, recipe?.cloth?.duration].filter(Number.isFinite);
  return durations.length ? Math.max(...durations) : undefined;
}

function playsPhysics(recipe) {
  return Boolean(recipe?.physics || recipe?.cloth || recipe?.particles);
}

function settingsFrom(input, clips, recipe) {
  objectKeys(input, ['kind', 'width', 'height', 'fps', 'duration', 'animation', 'motion', 'rendererTime', 'passes', 'renderer', 'timeline', 'audio', 'encoder', 'transparent', 'format', 'multilayer', 'region'], 'settings');
  if (!['image', 'stills', 'video'].includes(input.kind)) throw new TypeError('kind must be image, stills or video.');
  const width = boundedNumber(input.width, 64, MAXIMUM_JOB_SIDE, 'width', true);
  const height = boundedNumber(input.height, 64, MAXIMUM_JOB_SIDE, 'height', true);
  if (width * height > MAXIMUM_JOB_PIXELS) throw new RangeError('width x height must not exceed 1920x1080 pixels.');
  if (input.kind === 'video' && (width % 2 || height % 2)) throw new RangeError('Video dimensions must be even.');
  const fps = boundedNumber(input.fps ?? 24, 1, MAXIMUM_JOB_FPS, 'fps', true);
  const timelineStart = timelineStartFrom(input, recipe);
  // A physics-only film runs as long as its bake, counted from the motion start.
  const bakeSeconds = recipe?.format === '67js.scene' && !recipe.motion ? bakedPhysicsDuration(recipe) : undefined;
  const bakeDefault = bakeSeconds && input.kind !== 'image' && input.motion ? Math.max(0.1, bakeSeconds - (Number(input.motion.start) || 0)) : undefined;
  const defaultDuration = timelineStart === undefined || input.kind === 'image' ? bakeDefault ?? 1 : filmTimelineDuration(recipe.timeline) - timelineStart;
  const duration = boundedNumber(input.duration ?? defaultDuration, 0.1, MAXIMUM_VIDEO_SECONDS, 'duration');
  const frameCount = input.kind === 'image' ? 1 : input.kind === 'stills' ? 8 : Math.ceil(fps * duration);
  if (frameCount > 900) throw new RangeError('Job exceeds 900 frames.');
  const result = { kind: input.kind, width, height, fps, duration, frameCount };
  if (input.passes !== undefined) result.passes = passesFrom(input.passes, input.kind);
  if (input.renderer !== undefined) result.renderer = rendererFrom(input.renderer, input.passes);
  Object.assign(result, outputOptionsFrom(input, result));
  const lastSampleTime = input.kind === 'image' ? 0 : input.kind === 'stills' ? duration : (frameCount - 1) / fps;
  if (timelineStart !== undefined) {
    if (input.motion !== undefined || input.animation !== undefined) throw new TypeError('A timeline owns the motion clock; leave motion and animation out.');
    if (timelineStart + lastSampleTime > filmTimelineDuration(recipe.timeline)) throw new RangeError('Timeline range exceeds the timeline duration.');
    result.timeline = { start: timelineStart };
  }
  if (input.encoder !== undefined) {
    if (input.kind !== 'video') throw new TypeError('encoder needs kind video.');
    if (!VIDEO_ENCODERS.includes(input.encoder)) throw new TypeError(`encoder must be one of ${VIDEO_ENCODERS.join(', ')}.`);
    result.encoder = input.encoder;
  }
  if (input.audio !== undefined) result.audio = audioFrom(input.audio, input.kind);
  if (input.motion !== undefined) {
    objectKeys(input.motion, ['start'], 'motion');
    // Clips of placed assets play on scene time, so a scene that places one needs no authored motion.
    const placesClips = recipe?.format === '67js.scene' && recipeAssetNeeds(recipe).some(need => need.copies > 1);
    // A map sequence reads the same clock.
    const sequenced = JSON.stringify(recipe?.materials ?? []).includes('"sequence":{');
    if (!['67js.scene', '67js.asset'].includes(recipe?.format) || (!recipe.motion && !placesClips && !sequenced && !(recipe.format === '67js.scene' && playsPhysics(recipe)))) {
      throw new RangeError('Motion settings require a recipe with authored motion, physics (or cloth, particles), a placed clip or a map sequence.');
    }
    const motionDuration = recipe.motion ? boundedNumber(recipe.motion.duration, 0.1, 30, 'motion duration') : undefined;
    if (recipe.motion?.loop !== undefined && typeof recipe.motion.loop !== 'boolean') {
      throw new TypeError('Motion loop must be boolean.');
    }
    const start = boundedNumber(input.motion.start === undefined ? 0 : input.motion.start, 0, 3600, 'motion start');
    boundedNumber(start + lastSampleTime, 0, 3600, 'motion end');
    if (recipe.motion && !recipe.motion.loop && start + lastSampleTime > motionDuration) {
      throw new RangeError('Motion range exceeds the authored duration.');
    }
    if (!recipe.motion && bakeSeconds && start + lastSampleTime > bakeSeconds) {
      throw new RangeError(`Motion range exceeds the physics bake duration of ${bakeSeconds} s; shorten the job or lengthen physics.duration.`);
    }
    result.motion = { start };
  }
  if (input.animation !== undefined) {
    objectKeys(input.animation, ['clip', 'start'], 'animation');
    const clip = boundedNumber(input.animation.clip, 0, clips.length - 1, 'clip', true);
    const start = boundedNumber(input.animation.start ?? 0, 0, clips[clip].duration, 'animation start');
    if (input.kind !== 'image' && start + duration > clips[clip].duration) throw new RangeError('Animation range exceeds the selected clip duration.');
    result.animation = { clip, start };
  }
  if (input.rendererTime !== undefined) {
    objectKeys(input.rendererTime, ['start', 'rate'], 'rendererTime');
    result.rendererTime = { start: boundedNumber(input.rendererTime.start ?? 0, 0, 3600, 'renderer time start'), rate: boundedNumber(input.rendererTime.rate ?? 1, -16, 16, 'renderer time rate') };
  } else {
    result.rendererTime = { start: 0, rate: 1 };
  }
  boundedNumber(result.rendererTime.start + lastSampleTime * result.rendererTime.rate, 0, 3600, 'renderer time end');
  return result;
}

/** The optional transparent, format and region settings, kept only when they differ from the defaults so old records read the same. */
function outputOptionsFrom(input, { kind, width, height, renderer, passes }) {
  const options = {};
  const tracerNote = 'The path tracer writes an opaque 8-bit PNG of the whole frame.';
  if (input.transparent !== undefined) {
    if (typeof input.transparent !== 'boolean') throw new TypeError('transparent must be boolean.');
    if (input.transparent && kind === 'video') throw new RangeError('H.264 video has no alpha: transparent needs kind image or stills.');
    if (input.transparent && renderer) throw new RangeError(`transparent cannot combine with renderer. ${tracerNote}`);
    if (input.transparent) options.transparent = true;
  }
  if (input.format !== undefined) {
    if (!RENDER_OUTPUT_FORMATS.includes(input.format)) throw new TypeError(`format must be one of ${RENDER_OUTPUT_FORMATS.join(', ')}.`);
    if (input.format !== 'png' && kind === 'video') throw new RangeError('A video is H.264: format needs kind image or stills.');
    if (input.format !== 'png' && renderer) throw new RangeError(`format cannot combine with renderer. ${tracerNote}`);
    if (input.format !== 'png') options.format = input.format;
  }
  if (input.multilayer !== undefined) {
    if (typeof input.multilayer !== 'boolean') throw new TypeError('multilayer must be boolean.');
    if (input.multilayer && (input.format !== 'exr' || !passes)) throw new RangeError('multilayer requires format exr and passes.');
    if (input.multilayer) options.multilayer = true;
  }
  if (input.region !== undefined) {
    objectKeys(input.region, ['x', 'y', 'width', 'height'], 'region');
    if (renderer) throw new RangeError(`region cannot combine with renderer. ${tracerNote}`);
    const region = {
      x: boundedNumber(input.region.x, 0, width - 1, 'region x', true),
      y: boundedNumber(input.region.y, 0, height - 1, 'region y', true),
      width: boundedNumber(input.region.width, MINIMUM_REGION_SIDE, width, 'region width', true),
      height: boundedNumber(input.region.height, MINIMUM_REGION_SIDE, height, 'region height', true),
    };
    if (region.x + region.width > width || region.y + region.height > height) throw new RangeError('region must lie inside the frame.');
    if (kind === 'video' && (region.width % 2 || region.height % 2)) throw new RangeError('A video region must have even width and height.');
    options.region = region;
  }
  return options;
}

const PATH_TRACER_BACKENDS = ['cpu', 'gpu', 'native'];
const FRACTIONAL_RENDERER_FIELDS = new Set(['maxSeconds', 'noiseThreshold']);

function rendererFrom(renderer, passes) {
  objectKeys(renderer, ['type', 'backend', 'samples', 'bounces', 'denoise', 'seed', 'maxSeconds', 'noiseThreshold'], 'renderer');
  if (renderer.type !== 'pathTracer') throw new TypeError('renderer.type must be pathTracer.');
  if (passes !== undefined) throw new RangeError('The path tracer writes the lit image only: leave passes out.');
  const denoise = renderer.denoise ?? true;
  if (typeof denoise !== 'boolean' && !PATH_TRACER_DENOISERS.includes(denoise)) throw new TypeError(`renderer.denoise must be a boolean or one of ${PATH_TRACER_DENOISERS.join(', ')}.`);
  const backend = renderer.backend ?? 'cpu';
  if (!PATH_TRACER_BACKENDS.includes(backend)) throw new TypeError('renderer.backend must be cpu, gpu or native.');
  const result = { type: 'pathTracer', backend, denoise };
  for (const name of Object.keys(PATH_TRACER_JOB_LIMITS)) {
    const { minimum, maximum, default: fallback } = PATH_TRACER_JOB_LIMITS[name];
    const defaultValue = name === 'samples' && denoise === 'oidn' ? OIDN_DEFAULT_SAMPLES : fallback;
    result[name] = boundedNumber(renderer[name] ?? defaultValue, minimum, maximum, `renderer ${name}`, !FRACTIONAL_RENDERER_FIELDS.has(name));
  }
  return result;
}

function timelineStartFrom(input, recipe) {
  if (input.timeline === undefined) return undefined;
  objectKeys(input.timeline, ['start'], 'timeline');
  if (recipe?.format !== '67js.scene' || !recipe.timeline) throw new RangeError('Timeline settings require a recipe with a timeline.');
  normalizeFilmTimeline(recipe.timeline, recipe);
  return boundedNumber(input.timeline.start ?? 0, 0, MAXIMUM_VIDEO_SECONDS, 'timeline start');
}

function audioFrom(audio, kind) {
  if (kind !== 'video') throw new TypeError('audio needs kind video.');
  objectKeys(audio, ['file', 'offset', 'track'], 'audio');
  if (audio.track !== undefined && !['aac', 'pcm'].includes(audio.track)) throw new TypeError('audio.track must be aac or pcm.');
  if (typeof audio.file !== 'string' || !AUDIO_FILE_PATTERN.test(audio.file)) {
    throw new TypeError('audio.file must be a file name in the configured audio folder ending in .wav, .mp3, .ogg or .flac.');
  }
  return { file: audio.file, offset: boundedNumber(audio.offset ?? 0, 0, 3600, 'audio offset'), track: audio.track ?? 'aac' };
}

function passesFrom(passes, kind) {
  if (kind === 'video') throw new RangeError('Render passes need kind image or stills; a video holds the lit image only.');
  if (!Array.isArray(passes) || passes.length < 1 || passes.length > RENDER_PASS_NAMES.length) throw new TypeError(`passes must list 1 to ${RENDER_PASS_NAMES.length} pass names.`);
  for (const name of passes) {
    if (!RENDER_PASS_NAMES.includes(name)) throw new RangeError(`Unknown render pass: ${name}. Use ${RENDER_PASS_NAMES.join(', ')}.`);
  }
  if (new Set(passes).size !== passes.length) throw new RangeError('passes must not repeat a name.');
  return [...passes];
}

/** Every artifact filename of a job, lit image first and then each requested pass, frame by frame. */
export function artifactNames(kind, passes = [], format = 'png', multilayer = false) {
  if (kind === 'video') return ['render.mp4'];
  const extension = format === 'exr' ? 'exr' : 'png';
  const stems = kind === 'image' ? ['render'] : Array.from({ length: 8 }, (_, index) => `frame-${index}`);
  if (multilayer) return stems.map(stem => `${stem}.${extension}`);
  return stems.flatMap(stem => [`${stem}.${extension}`, ...passes.map(pass => `${stem}-${pass}.${extension}`)]);
}

function artifactMimeType(settings) {
  if (settings.kind === 'video') return 'video/mp4';
  return settings.format === 'exr' ? 'image/x-exr' : 'image/png';
}

function artifactByteLimit(settings, limits) {
  if (settings.kind === 'video') return limits.maxOutputBytes;
  return settings.format === undefined ? limits.maxFrameBytes : limits.maxFrameBytes * HIGH_PRECISION_FRAME_FACTOR;
}

function allowedFile(name) {
  const passNames = RENDER_PASS_NAMES.join('|');
  const artifact = new RegExp(`^(?:render\\.(?:png|mp4|exr)|(?:render|frame-[0-7])(?:-(?:${passNames}))?\\.(?:png|exr))(?:\\.partial)?$`);
  return INTERNAL_FILES.has(name) || artifact.test(name);
}

async function regularFile(path) {
  const details = await lstat(path);
  if (!details.isFile() || details.isSymbolicLink() || details.nlink !== 1) throw new Error('Job files must be regular files without links or aliases.');
  return details;
}

async function readJson(path, maximum = MAXIMUM_JSON_BYTES) {
  const details = await regularFile(path);
  if (details.size > maximum) throw new RangeError('Persisted job JSON exceeds its budget.');
  return jsonCopy(JSON.parse(await readFile(path, 'utf8')), maximum);
}

async function hashFile(path, maximum) {
  const before = await regularFile(path);
  if (!before.size || before.size > maximum) throw new RangeError('Artifact exceeds its output byte budget or is empty.');
  const handle = await open(path, 'r');
  try {
    const opened = await handle.stat();
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.nlink !== 1) throw new Error('Artifact changed while opening.');
    const hash = createHash('sha256');
    let bytes = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      bytes += chunk.length;
      if (bytes > maximum) throw new RangeError('Artifact exceeds its output byte budget.');
      hash.update(chunk);
    }
    const after = await handle.stat();
    if (bytes !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new Error('Artifact changed while hashing.');
    return { bytes, sha256: hash.digest('hex') };
  } finally {
    await handle.close();
  }
}

/** Persistent controller. The trusted runner must stop its owned browser and encoder when aborted. */
export async function createAgentRenderJobs({ root, run, limits: inputLimits = {} }) {
  if (typeof root !== 'string' || !isAbsolute(root)) throw new TypeError('Job root must be an explicit absolute directory.');
  if (typeof run !== 'function') throw new TypeError('run must be an async render callback.');
  objectKeys(inputLimits, Object.keys(DEFAULT_LIMITS), 'limits');
  const limits = { ...DEFAULT_LIMITS, ...inputLimits };
  for (const [key, value] of Object.entries(limits)) boundedNumber(value, 1, DEFAULT_LIMITS[key], key, true);
  root = resolve(root);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const rootDetails = await lstat(root);
  if (!rootDetails.isDirectory() || rootDetails.isSymbolicLink()) throw new Error('Job root must be a real directory without links.');
  root = await realpath(root);
  const lockPath = join(root, 'store.lock');
  const lockToken = randomUUID();
  const jobs = new Map();
  let active;
  let closed = false;
  let admission;
  let storeId;
  let lockHeld = false;

  async function acquireLock() {
    try {
      const lock = await open(lockPath, 'wx', 0o600);
      try { await lock.writeFile(JSON.stringify({ schemaVersion: 1, pid: process.pid, token: lockToken })); }
      finally { await lock.close(); }
      lockHeld = true;
      process.once('exit', releaseLockOnExit);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      await regularFile(lockPath);
      const owner = await readJson(lockPath, 4096);
      objectKeys(owner, ['schemaVersion', 'pid', 'token'], 'store lock');
      if (owner.schemaVersion !== 1 || !UUID.test(owner.token)) throw new Error('Unrecognized job store lock.');
      boundedNumber(owner.pid, 1, 2147483647, 'lock process ID', true);
      try {
        process.kill(owner.pid, 0);
        throw new Error('The job store is already owned by a live process.');
      } catch (failure) {
        if (failure.code !== 'ESRCH') throw failure;
      }
      throw new Error('Stale job store lock requires explicit repair. Verify that no process owns the store before removing store.lock.');
    }
  }

  // A process that ends without a clean close (an exit call, an uncaught error, a signal Node turns into an exit) still gives the
  // lock back, so the next run does not meet a "stale" lock. Only the owner's own token is removed.
  function releaseLockOnExit() {
    if (!lockHeld) return;
    try {
      if (JSON.parse(readFileSync(lockPath, 'utf8')).token === lockToken) unlinkSync(lockPath);
    } catch {
      // The lock is already gone or no longer ours: nothing to give back.
    }
    lockHeld = false;
  }

  async function unlock() {
    if (!lockHeld) return;
    if ((await readJson(lockPath, 4096)).token !== lockToken) throw new Error('Job store lock ownership changed.');
    await unlink(lockPath);
    lockHeld = false;
    process.removeListener('exit', releaseLockOnExit);
  }

  async function directoryFor(jobId) {
    if (!UUID.test(jobId)) throw new Error('Unknown job ID.');
    const directory = join(root, jobId);
    const details = await lstat(directory);
    if (!details.isDirectory() || details.isSymbolicLink() || await realpath(directory) !== directory) throw new Error('Job directory must remain inside its owned store.');
    const owner = await readJson(join(directory, 'owner.json'), 4096);
    objectKeys(owner, ['schemaVersion', 'storeId', 'jobId'], 'job owner');
    if (owner.schemaVersion !== 1 || owner.storeId !== storeId || owner.jobId !== jobId) throw new Error('Foreign job directory ownership.');
    for (const filename of await readdir(directory)) {
      if (!allowedFile(filename)) throw new Error(`Foreign job entry: ${filename}.`);
      await regularFile(join(directory, filename));
    }
    return directory;
  }

  async function storeBytes() {
    let bytes = 0;
    for (const name of await readdir(root)) {
      if (name === EXPORT_DIRECTORY_NAME) continue;
      if (['store.json', 'store.lock'].includes(name)) {
        bytes += (await regularFile(join(root, name))).size;
      } else {
        if (isPending(name)) {
          const directory = await pendingDirectory(name);
          for (const filename of await readdir(directory)) bytes += (await regularFile(join(directory, filename))).size;
          continue;
        }
        if (!UUID.test(name)) throw new Error(`Foreign store entry: ${name}.`);
        const directory = await directoryFor(name);
        for (const filename of await readdir(directory)) bytes += (await regularFile(join(directory, filename))).size;
      }
    }
    if (bytes > limits.maxStoreBytes) throw new RangeError('Job store exceeds its total byte budget. Release completed jobs.');
    return bytes;
  }

  function isPending(name) {
    return name.startsWith(`.pending-${storeId}-`) && UUID.test(name.slice(`.pending-${storeId}-`.length));
  }

  async function pendingDirectory(name) {
    if (!isPending(name)) throw new Error('Unrecognized pending admission.');
    const directory = join(root, name);
    const details = await lstat(directory);
    if (!details.isDirectory() || details.isSymbolicLink() || await realpath(directory) !== directory) throw new Error('Pending admission must remain inside its owned store.');
    // Quarantine incomplete writes and foreign files; never interpret their contents.
    for (const filename of await readdir(directory)) await regularFile(join(directory, filename));
    return directory;
  }

  function getJob(jobId) {
    if (typeof jobId !== 'string' || !UUID.test(jobId) || !jobs.has(jobId)) throw new Error('Unknown job ID.');
    return jobs.get(jobId);
  }

  function persist(job, record = job.record) {
    const text = JSON.stringify(record);
    job.persistence = job.persistence.then(async () => {
      const directory = await directoryFor(job.record.jobId);
      const pending = join(directory, 'status.json.pending');
      await writeFile(pending, text, { mode: 0o600 });
      await rename(pending, join(directory, 'status.json'));
    });
    return job.persistence;
  }

  async function recover() {
    const names = await readdir(root);
    if (!names.includes('store.json')) {
      if (names.some(name => name !== 'store.lock' && name !== EXPORT_DIRECTORY_NAME)) throw new Error('Job root contains foreign entries without store ownership.');
      storeId = randomUUID();
      await writeFile(join(root, 'store.json'), JSON.stringify({ schemaVersion: 1, storeId }), { flag: 'wx', mode: 0o600 });
    } else {
      const metadata = await readJson(join(root, 'store.json'), 4096);
      objectKeys(metadata, ['schemaVersion', 'storeId'], 'store metadata');
      if (metadata.schemaVersion !== 1 || !UUID.test(metadata.storeId)) throw new Error('Unsupported job store metadata.');
      storeId = metadata.storeId;
    }
    for (const name of await readdir(root)) {
      if (STORE_FILES.includes(name)) continue;
      if (isPending(name)) {
        const directory = await pendingDirectory(name);
        if (!(await readdir(directory)).length) await rmdir(directory);
        continue;
      }
      if (!UUID.test(name)) throw new Error(`Foreign store entry: ${name}.`);
      const directory = await directoryFor(name);
      const record = await readJson(join(directory, 'status.json'));
      objectKeys(record, ['schemaVersion', 'jobId', 'sourceRevision', 'state', 'settings', 'progress', 'artifacts', 'metrics', 'reason'], 'job status');
      if (record.schemaVersion !== 1 || record.jobId !== name || !STATES.includes(record.state)) throw new Error('Invalid persisted job status.');
      boundedNumber(record.sourceRevision, 0, Number.MAX_SAFE_INTEGER, 'source revision', true);
      const snapshot = await readJson(join(directory, 'snapshot.json'));
      objectKeys(snapshot, ['recipe', 'clips'], 'snapshot');
      validateClips(snapshot.clips ?? []);
      if (!snapshot.recipe || typeof snapshot.recipe !== 'object' || Array.isArray(snapshot.recipe)) throw new Error('Persisted snapshot recipe must be an object.');
      if ((await readdir(directory)).includes('asset.glb') && (await regularFile(join(directory, 'asset.glb'))).size > MAXIMUM_ASSET_BYTES) throw new Error('Persisted asset exceeds its byte budget.');
      if (snapshot.recipe.format === '67js.asset') {
        const asset = await hashFile(join(directory, 'asset.glb'), MAXIMUM_ASSET_BYTES);
        if (asset.sha256 !== snapshot.recipe.assetId) throw new Error('Persisted asset does not match its recipe digest.');
      }
      const { frameCount, ...inputSettings } = record.settings;
      const settings = settingsFrom(inputSettings, snapshot.clips ?? [], snapshot.recipe);
      if (frameCount !== settings.frameCount) throw new Error('Invalid persisted frame count.');
      record.settings = settings;
      objectKeys(record.progress, ['frames', 'maximumPendingFrames'], 'persisted progress');
      boundedNumber(record.progress.frames, 0, settings.frameCount, 'persisted frames', true);
      boundedNumber(record.progress.maximumPendingFrames, 0, 1, 'persisted pending frames', true);
      if (record.metrics !== undefined) record.metrics = jsonCopy(record.metrics, 65536);
      if (record.reason !== undefined && (typeof record.reason !== 'string' || record.reason.length > 2048)) throw new Error('Invalid persisted job reason.');
      const namesAllowed = artifactNames(settings.kind, settings.passes, settings.format, settings.multilayer);
      if (!Array.isArray(record.artifacts) || record.artifacts.length > namesAllowed.length) throw new Error('Invalid persisted artifacts.');
      const seen = new Set();
      for (const artifact of record.artifacts) {
        objectKeys(artifact, ['filename', 'mimeType', 'bytes', 'sha256'], 'artifact');
        if (!namesAllowed.includes(artifact.filename) || seen.has(artifact.filename)) throw new Error('Invalid persisted artifact name.');
        seen.add(artifact.filename);
        const actual = await hashFile(join(directory, artifact.filename), artifactByteLimit(settings, limits));
        if (artifact.mimeType !== artifactMimeType(settings) || artifact.bytes !== actual.bytes || artifact.sha256 !== actual.sha256) throw new Error('Persisted artifact integrity failed.');
      }
      if (record.state === 'completed' && record.artifacts.length !== namesAllowed.length) throw new Error('Completed job is missing its artifacts.');
      const job = { record, persistence: Promise.resolve(), settled: Promise.resolve() };
      jobs.set(name, job);
      if (!TERMINAL.has(record.state)) {
        record.state = 'interrupted';
        record.reason = 'The previous process stopped before the job finished.';
        record.artifacts = [];
        await persist(job);
      }
    }
    if (jobs.size > limits.maxRecords) throw new RangeError('Job store exceeds its record budget.');
    await storeBytes();
  }

  function validateClips(clips) {
    if (!Array.isArray(clips) || clips.length > 256) throw new TypeError('Snapshot clips must contain at most 256 durations.');
    for (const clip of clips) {
      objectKeys(clip, ['duration'], 'clip');
      boundedNumber(clip.duration, 0, 3600, 'clip duration');
    }
  }

  async function finish(job, snapshot) {
    const { record, controller } = job;
    const timer = setTimeout(() => {
      job.failure = 'Render job exceeded its elapsed deadline.';
      record.state = 'cancelling';
      record.reason = job.failure;
      controller.abort(new Error(job.failure));
      persist(job).catch(() => {});
    }, jobDeadlineMs(record.settings, limits.deadlineMs));
    const renamed = [];
    try {
      if (controller.signal.aborted) throw controller.signal.reason;
      record.state = 'running';
      await persist(job);
      const runnerDirectory = await directoryFor(record.jobId);
      if (controller.signal.aborted) throw controller.signal.reason;
      const completed = await run({
        jobId: record.jobId, sessionId: job.sessionId, directory: runnerDirectory, snapshot, settings: structuredClone(record.settings), signal: controller.signal,
        progress(update) {
          objectKeys(update, ['frames', 'maximumPendingFrames'], 'progress');
          if (controller.signal.aborted) throw controller.signal.reason;
          if (record.state !== 'running') throw new Error('Progress is only accepted while the callback is running.');
          const frames = boundedNumber(update.frames ?? record.progress.frames, record.progress.frames, record.settings.frameCount, 'captured frames', true);
          const maximumPendingFrames = boundedNumber(update.maximumPendingFrames ?? record.progress.maximumPendingFrames, 0, 1, 'pending frames', true);
          record.progress = { frames, maximumPendingFrames: Math.max(record.progress.maximumPendingFrames, maximumPendingFrames) };
          return persist(job);
        },
      });
      if (controller.signal.aborted) throw controller.signal.reason;
      record.state = 'finalizing';
      await persist(job);
      objectKeys(completed, ['artifacts', 'metrics'], 'runner result');
      const expected = artifactNames(record.settings.kind, record.settings.passes, record.settings.format, record.settings.multilayer);
      if (!Array.isArray(completed.artifacts) || completed.artifacts.length !== expected.length) throw new Error('Runner did not return the required fixed artifacts.');
      const directory = await directoryFor(record.jobId);
      const metrics = jsonCopy(completed.metrics ?? {}, 65536);
      const artifacts = [];
      const seen = new Set();
      let outputBytes = 0;
      for (const output of completed.artifacts) {
        objectKeys(output, ['temporary', 'filename', 'mimeType'], 'runner artifact');
        if (!expected.includes(output.filename) || seen.has(output.filename) || output.temporary !== `${output.filename}.partial` || output.mimeType !== artifactMimeType(record.settings)) throw new Error('Runner artifact must use the fixed filename and MIME type.');
        seen.add(output.filename);
        const artifact = { filename: output.filename, mimeType: output.mimeType, ...await hashFile(join(directory, output.temporary), artifactByteLimit(record.settings, limits)) };
        outputBytes += artifact.bytes;
        if (outputBytes > limits.maxOutputBytes) throw new RangeError('Job exceeds its combined output byte budget.');
        artifacts.push(artifact);
      }
      await storeBytes();
      if (controller.signal.aborted) throw controller.signal.reason;
      for (const artifact of artifacts) {
        if (controller.signal.aborted) throw controller.signal.reason;
        const target = join(directory, artifact.filename);
        try { await lstat(target); throw new Error('Final artifact already exists.'); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        await rename(join(directory, `${artifact.filename}.partial`), target);
        renamed.push(artifact.filename);
      }
      if (controller.signal.aborted) throw controller.signal.reason;
      const completedRecord = { ...record, artifacts, metrics, state: 'completed' };
      await persist(job, completedRecord);
      if (controller.signal.aborted) throw controller.signal.reason;
      Object.assign(record, completedRecord);
    } catch (error) {
      const failedRecord = { ...record, state: controller.signal.aborted && !job.failure ? 'cancelled' : 'failed', reason: String(job.failure ?? error?.message ?? error).slice(0, 2048), artifacts: [] };
      try {
        const directory = await directoryFor(record.jobId);
        for (const filename of renamed) {
          await regularFile(join(directory, filename));
          await rename(join(directory, filename), join(directory, `${filename}.partial`));
        }
        await persist(job, failedRecord);
      } catch (failure) {
        failedRecord.reason = `${failedRecord.reason} Store cleanup or persistence failed: ${failure.message}`.slice(0, 2048);
      }
      Object.assign(record, failedRecord);
    } finally {
      clearTimeout(timer);
      if (active === job) active = undefined;
    }
  }

  await acquireLock();
  try { await recover(); }
  catch (error) { await unlock(); throw error; }

  return Object.freeze({
    limits: Object.freeze(limits),
    async submit(input) {
      if (closed) throw new Error('Render job controller is closed.');
      if (active || admission) throw new Error('A render job is already active. No additional jobs are queued.');
      objectKeys(input, ['sessionId', 'sourceRevision', 'snapshot', 'settings'], 'submission');
      const sourceRevision = boundedNumber(input.sourceRevision, 0, Number.MAX_SAFE_INTEGER, 'source revision', true);
      objectKeys(input.snapshot, ['recipe', 'assetBytes', 'clips'], 'snapshot');
      const clips = jsonCopy(input.snapshot.clips ?? []);
      validateClips(clips);
      const recipe = jsonCopy(input.snapshot.recipe);
      if (!recipe || typeof recipe !== 'object' || Array.isArray(recipe)) throw new TypeError('Snapshot recipe must be a JSON object.');
      const snapshotMetadata = jsonCopy({ recipe, clips });
      const settings = settingsFrom(input.settings, clips, recipe);
      if (input.snapshot.assetBytes !== undefined && (!Buffer.isBuffer(input.snapshot.assetBytes) || input.snapshot.assetBytes.length > MAXIMUM_ASSET_BYTES || !input.snapshot.assetBytes.length)) throw new RangeError(`Asset snapshot must be a nonempty Buffer of at most ${MAXIMUM_ASSET_BYTES} bytes (${describeAssetBytes(MAXIMUM_ASSET_BYTES)}).`);
      const snapshot = { recipe, clips, ...(input.snapshot.assetBytes ? { assetBytes: Buffer.from(input.snapshot.assetBytes) } : {}) };
      if (recipe.format === '67js.asset' && (!snapshot.assetBytes || createHash('sha256').update(snapshot.assetBytes).digest('hex') !== recipe.assetId)) throw new Error('Asset snapshot bytes must match the recipe SHA256 assetId.');
      const operation = (async () => {
        if (jobs.size >= limits.maxRecords) throw new RangeError('Job record budget exhausted. Release a finished job.');
        const snapshotText = JSON.stringify(snapshotMetadata);
        const existingBytes = await storeBytes();
        if (existingBytes + Buffer.byteLength(snapshotText) + (snapshot.assetBytes?.length ?? 0) + limits.maxOutputBytes + 131072 > limits.maxStoreBytes) throw new RangeError('Job store lacks space for the snapshot and output reservation.');
        const jobId = randomUUID();
        const directory = join(root, jobId);
        const staging = join(root, `.pending-${storeId}-${jobId}`);
        await mkdir(staging, { mode: 0o700 });
        await writeFile(join(staging, 'owner.json'), JSON.stringify({ schemaVersion: 1, storeId, jobId }), { flag: 'wx', mode: 0o600 });
        await writeFile(join(staging, 'snapshot.json'), snapshotText, { flag: 'wx', mode: 0o600 });
        if (snapshot.assetBytes) await writeFile(join(staging, 'asset.glb'), snapshot.assetBytes, { flag: 'wx', mode: 0o600 });
        const record = { schemaVersion: 1, jobId, sourceRevision, state: 'queued', settings, progress: { frames: 0, maximumPendingFrames: 0 }, artifacts: [] };
        await writeFile(join(staging, 'status.json'), JSON.stringify(record), { flag: 'wx', mode: 0o600 });
        await rename(staging, directory);
        const job = { record, sessionId: input.sessionId, controller: new AbortController(), persistence: Promise.resolve() };
        jobs.set(jobId, job);
        active = job;
        const result = structuredClone(record);
        job.settled = Promise.resolve().then(() => finish(job, snapshot));
        job.settled.catch(() => {});
        return result;
      })();
      admission = operation;
      try { return await operation; }
      finally { admission = undefined; }
    },
    status(jobId) { return structuredClone(getJob(jobId).record); },
    list() { return [...jobs.values()].map(job => structuredClone(job.record)); },
    cancel(jobId) {
      if (closed) throw new Error('Render job controller is closed.');
      const job = getJob(jobId);
      if (!TERMINAL.has(job.record.state)) {
        job.record.state = 'cancelling';
        job.controller.abort(new Error('Render job cancelled.'));
        persist(job).catch(() => {});
      }
      return structuredClone(job.record);
    },
    result(jobId) {
      const record = getJob(jobId).record;
      if (record.state !== 'completed') throw new Error(`Render job is ${record.state}. No completed result is available.`);
      return structuredClone({ jobId, sourceRevision: record.sourceRevision, artifacts: record.artifacts, metrics: record.metrics });
    },
    async release(jobId) {
      if (closed) throw new Error('Render job controller is closed.');
      const job = getJob(jobId);
      if (active === job || !TERMINAL.has(job.record.state)) throw new Error('Cancel and settle the active job before release.');
      await job.persistence;
      const directory = await directoryFor(jobId);
      for (const filename of await readdir(directory)) {
        await regularFile(join(directory, filename));
        await unlink(join(directory, filename));
      }
      await rmdir(directory);
      jobs.delete(jobId);
      return { jobId, released: true };
    },
    async close() {
      closed = true;
      await admission?.catch(() => {});
      if (active) {
        const job = active;
        job.record.state = 'cancelling';
        job.controller.abort(new Error('Render job controller closed.'));
        await persist(job);
        let timer;
        try {
          await Promise.race([job.settled, new Promise((resolveWait, reject) => { timer = setTimeout(() => reject(new Error('Render callback did not settle after cancellation. Store ownership remains locked.')), limits.cleanupMs); })]);
        } finally { clearTimeout(timer); }
      }
      for (const job of jobs.values()) await job.persistence;
      await unlock();
    },
  });
}
