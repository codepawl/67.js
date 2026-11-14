// Heavy pure computations (light bake, cloth solver, material pattern bake, uv_unwrap) can run on a worker while the
// page stays responsive. Scene building is synchronous, so the worker result reaches it through a cache:
//
//   1. `buildWithKernels(build)` runs the synchronous build with a session open.
//   2. A kernel that has no cached result throws `KernelDeferred` instead of computing.
//   3. The session computes that kernel on a worker, caches the result by a hash of its input, and runs the build again.
//
// Without a session `runKernel` computes inline, so every caller that never opted in behaves exactly as before and a
// host without workers (Node) produces the same bytes through the same code. This module is only imported by the
// on-demand scene modules, never by the scene core.

// Held in a constant so the bundler leaves the URL alone: the worker is its own package entry, built beside this file.
const KERNEL_WORKER_FILE = './kernel-worker.js';

const RECONSTRUCTED_ERRORS = { RangeError, TypeError, SyntaxError, ReferenceError };

// More distinct heavy kernels than any real scene holds: past it the build finishes inline.
const MAXIMUM_DEFERRALS = 256;

let activeSession = null;
let workerStartFailure = null;

// What ran where, since the last reset: a kernel served by a worker, a kernel computed inline, and why a kernel that
// should have gone to a worker did not. A silent fallback would otherwise look the same as success.
const MAXIMUM_RECORDED_FALLBACKS = 16;
const statistics = { worker: 0, page: 0, inline: 0, fallbacks: [] };

/** Counts of kernels served by a worker and run inline, with the reason for each fallback. */
export function kernelStats() {
  return { worker: statistics.worker, page: statistics.page, inline: statistics.inline, fallbacks: statistics.fallbacks.map(fallback => ({ ...fallback })) };
}

export function resetKernelStats() {
  statistics.worker = 0;
  statistics.page = 0;
  statistics.inline = 0;
  statistics.fallbacks = [];
}

function recordFallback(kernel, reason) {
  if (statistics.fallbacks.length < MAXIMUM_RECORDED_FALLBACKS) {
    statistics.fallbacks.push({ kernel, reason });
  }
  if (kernelWorkersAvailable()) {
    console.warn(`Crucible kernel fallback: ${kernel} ran inline (${reason}).`);
  }
}

function computeInline(compute, args) {
  statistics.inline++;
  return compute(...args);
}

/** Thrown by `runKernel` inside a session when a kernel's result has to be computed on the worker first. */
export class KernelDeferred {
  constructor(job) {
    this.job = job;
  }
}

function isPlainObject(value) {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

const HASH_PRIMES = [0x01000193, 0x85ebca6b];

function createHasher() {
  return { states: [0x811c9dc5, 0x9747b28c], length: 0 };
}

function mixBytes(hasher, bytes) {
  for (let index = 0; index < bytes.length; index++) {
    for (let lane = 0; lane < 2; lane++) {
      hasher.states[lane] = Math.imul(hasher.states[lane] ^ bytes[index], HASH_PRIMES[lane]) >>> 0;
    }
  }
  hasher.length += bytes.length;
}

const textEncoder = new TextEncoder();

function mixText(hasher, text) {
  mixBytes(hasher, textEncoder.encode(text));
}

function mixNamedValue(hasher, key, value) {
  mixText(hasher, `${key}=`);
  return mixValue(hasher, value);
}

/** Feeds a value into the hasher; returns false for anything that is not plain, cloneable data. */
function mixValue(hasher, value) {
  if (value === null || value === undefined || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
    mixText(hasher, `${typeof value}:${String(value)};`);
    return true;
  }
  if (ArrayBuffer.isView(value)) {
    mixText(hasher, `${value.constructor.name}:${value.byteLength};`);
    mixBytes(hasher, new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
    return true;
  }
  // Browsers hold pattern textures as ImageData, which a worker clones as it is.
  if (typeof ImageData === 'function' && value instanceof ImageData) {
    mixText(hasher, `ImageData:${value.width}x${value.height}:${value.colorSpace};`);
    return mixValue(hasher, value.data);
  }
  if (Array.isArray(value)) {
    mixText(hasher, `[${value.length}:`);
    return value.every(item => mixValue(hasher, item));
  }
  if (typeof value === 'object' && isPlainObject(value)) {
    const keys = Object.keys(value);
    mixText(hasher, `{${keys.length}:`);
    return keys.every(key => mixNamedValue(hasher, key, value[key]));
  }
  return false;
}

/** A key that identifies a kernel call by its name and the bytes of its input, or null when the input is not plain data. */
export function kernelKey(name, args) {
  const hasher = createHasher();
  mixText(hasher, `${name}:`);
  if (!mixValue(hasher, args)) {
    return null;
  }
  return `${name}:${hasher.length}:${hasher.states.map(state => state.toString(16)).join('')}`;
}

/**
 * Runs `compute(...args)`. Inside a `buildWithKernels` session the call returns the worker's cached result, or throws
 * `KernelDeferred` so the session can fetch it. Everywhere else it computes inline. A call site that catches errors
 * must rethrow `KernelDeferred`.
 */
export function runKernel(name, args, compute) {
  if (!activeSession) {
    return computeInline(compute, args);
  }
  const key = kernelKey(name, args);
  if (key === null) {
    recordFallback(name, 'its input is not plain data');
    return computeInline(compute, args);
  }
  if (activeSession.inlineAll || activeSession.inlineKeys.has(key)) {
    return computeInline(compute, args);
  }
  if (activeSession.results.has(key)) {
    const entry = activeSession.results.get(key);
    if (entry.thrown) {
      throw entry.thrown;
    }
    return entry.value;
  }
  throw new KernelDeferred({ name, args, key });
}

function rebuildError({ name, message }) {
  const ErrorClass = RECONSTRUCTED_ERRORS[name] ?? Error;
  return new ErrorClass(message);
}

function defaultWorkerFactory() {
  return new Worker(new URL(KERNEL_WORKER_FILE, import.meta.url), { type: 'module' });
}

/** Whether this host can start the kernel worker. */
export function kernelWorkersAvailable() {
  return typeof Worker === 'function';
}

function abortError(signal) {
  return signal.reason ?? new DOMException('The build was cancelled.', 'AbortError');
}

/** One job on one worker: resolves with the worker's answer, or rejects when the worker itself fails. */
function requestKernel(worker, job, signal) {
  return new Promise((resolve, reject) => {
    const cleanUp = () => signal?.removeEventListener('abort', onAbort);
    const onAbort = () => {
      cleanUp();
      reject(abortError(signal));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    worker.onmessage = event => {
      cleanUp();
      resolve(event.data);
    };
    worker.onerror = event => {
      cleanUp();
      reject(new Error(`Kernel worker failed: ${event.message}`));
    };
    try {
      worker.postMessage({ name: job.name, args: job.args });
    } catch (error) {
      cleanUp();
      reject(error);
    }
  });
}

/**
 * Runs a synchronous scene build while its heavy kernels compute on a worker. The result is the build's own result,
 * built from identical bytes. `createWorker` replaces the browser Worker (tests, other hosts); `signal` cancels the
 * build and ends the worker. Hosts without workers just run the build.
 */
export async function buildWithKernels(build, { createWorker = defaultWorkerFactory, signal, available = kernelWorkersAvailable(), pageKernels } = {}) {
  if (!available || activeSession) {
    return build();
  }
  const session = { results: new Map(), inlineKeys: new Set(), inlineAll: false, deferrals: 0 };
  let worker = null;
  try {
    for (;;) {
      if (signal?.aborted) {
        throw abortError(signal);
      }
      activeSession = session;
      try {
        return build();
      } catch (error) {
        if (!(error instanceof KernelDeferred)) {
          throw error;
        }
        activeSession = null;
        session.deferrals++;
        // A build whose inputs change on every run would never find its cached result; computing inline ends the loop.
        if (session.deferrals > MAXIMUM_DEFERRALS && !session.inlineAll) {
          session.inlineAll = true;
          recordFallback(error.job.name, 'the build asked for more kernels than any scene holds');
        }
        if (await computeOnPage(session, pageKernels, error.job)) {
          continue;
        }
        worker ??= createWorkerOrNull(createWorker);
        await computeOnWorker(session, worker, error.job, signal);
      } finally {
        activeSession = null;
      }
    }
  } finally {
    worker?.terminate();
  }
}

// A page kernel answers a job on the page itself, where the GPU is, instead of on the worker. It takes a job only when its
// `accepts` says so; if it fails, the worker still does the job on the CPU, so a GPU fault never fails a build.
async function computeOnPage(session, pageKernels, job) {
  const kernel = pageKernels?.[job.name];
  if (!kernel?.accepts(job.args)) {
    return false;
  }
  try {
    session.results.set(job.key, { value: await kernel.compute(job.args) });
    statistics.page++;
    return true;
  } catch (error) {
    recordFallback(job.name, `the page kernel failed: ${error.message}`);
    return false;
  }
}

function createWorkerOrNull(createWorker) {
  try {
    return createWorker();
  } catch (error) {
    workerStartFailure = error.message;
    return null;
  }
}

// A worker that cannot start or dies leaves the job to the inline path, which then does the work and raises its own
// errors, so a failure never depends on the worker.
async function computeOnWorker(session, worker, job, signal) {
  if (!worker) {
    session.inlineKeys.add(job.key);
    recordFallback(job.name, `the worker could not start: ${workerStartFailure}`);
    return;
  }
  let answer;
  try {
    answer = await requestKernel(worker, job, signal);
  } catch (error) {
    if (signal?.aborted) {
      throw error;
    }
    session.inlineKeys.add(job.key);
    recordFallback(job.name, `the worker failed: ${error.message}`);
    return;
  }
  statistics.worker++;
  session.results.set(job.key, answer.error ? { thrown: rebuildError(answer.error) } : { value: answer.value });
}
