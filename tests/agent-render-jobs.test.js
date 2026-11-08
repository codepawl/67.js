import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, link, unlink } from 'node:fs/promises';
import { watch, writeFileSync } from 'node:fs';
import { tmpdir, constants, setPriority } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { createAgentRenderJobs, jobDeadlineMs } from '../scripts/agent-render-jobs.mjs';

setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL);
const limits = { maxOutputBytes: 1024, maxFrameBytes: 128, maxStoreBytes: 1024 ** 2, cleanupMs: 100 };
const request = () => ({ sourceRevision: 7, snapshot: { recipe: { format: 'fixture', color: [1, 0, 0] } }, settings: { kind: 'image', width: 64, height: 64 } });

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function temporary(context) {
  const directory = await mkdtemp(join(tmpdir(), '67js-render-controller-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

// A hung job fails through the test timeout instead of a wall-clock bound inside the poll loop.
// The bound is for liveness, not speed: CPU-heavy test files run in parallel and slow every job down.
const TEST_TIMEOUT_MILLISECONDS = 60000;
const test = (name, body) => nodeTest(name, { timeout: TEST_TIMEOUT_MILLISECONDS }, body);

async function terminal(controller, jobId) {
  while (!['completed', 'cancelled', 'failed', 'interrupted'].includes(controller.status(jobId).state)) {
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  return controller.status(jobId);
}

async function writeImage({ directory, progress }) {
  await writeFile(join(directory, 'render.png.partial'), Buffer.from('fixture PNG bytes'));
  await progress({ frames: 1, maximumPendingFrames: 1 });
  return { artifacts: [{ temporary: 'render.png.partial', filename: 'render.png', mimeType: 'image/png' }], metrics: { maximumPendingFrames: 1 } };
}

test('motion job ranges use immutable recipe duration, loops and actual sample times across restart', async context => {
  const root = await temporary(context);
  const controller = await createAgentRenderJobs({ root, limits, run: writeImage });
  const input = request();
  input.snapshot.recipe = { format: '67js.scene', motion: { duration: 1, loop: false } };
  input.settings.motion = { start: 1 };
  const submitted = await controller.submit(input);
  await terminal(controller, submitted.jobId);
  assert.equal(controller.status(submitted.jobId).settings.motion.start, 1);
  input.settings = { kind: 'stills', width: 64, height: 64, duration: 1, motion: { start: 0.1 } };
  await assert.rejects(controller.submit(input), /Motion range/);
  input.snapshot.recipe.motion.loop = true;
  input.settings.motion.start = 3600;
  await assert.rejects(controller.submit(input), /motion end/);
  input.settings.motion.start = null;
  await assert.rejects(controller.submit(input), /motion start/);
  input.snapshot.recipe = { format: '67js.asset', motion: { duration: 1 } };
  input.settings.motion.start = 0;
  await assert.rejects(controller.submit(input), /Asset snapshot bytes/);
  const assetBytes = Buffer.from('owned motion asset bytes');
  input.snapshot.assetBytes = assetBytes;
  input.snapshot.recipe.assetId = createHash('sha256').update(assetBytes).digest('hex');
  input.settings = { kind: 'image', width: 64, height: 64, motion: { start: 0.5 } };
  const assetSubmitted = await controller.submit(input);
  assert.equal((await terminal(controller, assetSubmitted.jobId)).state, 'completed');
  assert.equal(controller.status(assetSubmitted.jobId).settings.motion.start, 0.5);
  await controller.close();
  const reopened = await createAgentRenderJobs({ root, limits, run: writeImage });
  assert.equal(reopened.status(submitted.jobId).settings.motion.start, 1);
  assert.equal(reopened.status(assetSubmitted.jobId).settings.motion.start, 0.5);
  await reopened.release(submitted.jobId);
  await reopened.release(assetSubmitted.jobId);
  await reopened.close();
});

test('a scene that places a clip takes motion settings without authored motion, one that places a still asset does not', async context => {
  const root = await temporary(context);
  const controller = await createAgentRenderJobs({ root, limits, run: writeImage });
  const id = 'a'.repeat(64);
  const input = request();
  input.settings = { kind: 'image', width: 64, height: 64, motion: { start: 2 } };
  input.snapshot.recipe = { format: '67js.scene', nodes: [{ id: 'walker', asset: { id, clip: { index: 0 } } }] };
  const submitted = await controller.submit(input);
  assert.equal((await terminal(controller, submitted.jobId)).state, 'completed');
  assert.equal(controller.status(submitted.jobId).settings.motion.start, 2);
  input.snapshot.recipe = { format: '67js.scene', nodes: [{ id: 'prop', asset: { id } }] };
  await assert.rejects(controller.submit(input), /authored motion or a placed clip/);
  await controller.release(submitted.jobId);
  await controller.close();
});

test('real files publish after success with copied snapshots, hashes and restart persistence', async context => {
  const root = await temporary(context);
  const started = deferred();
  const finish = deferred();
  let observed;
  const controller = await createAgentRenderJobs({ root, limits, async run(argumentsValue) {
    observed = argumentsValue.snapshot;
    started.resolve();
    await finish.promise;
    return writeImage(argumentsValue);
  } });
  const input = request();
  input.snapshot.assetBytes = Buffer.from('owned bytes');
  const submitting = controller.submit(input);
  input.sourceRevision = 99;
  const submitted = await submitting;
  assert.equal(submitted.sourceRevision, 7);
  assert.equal(submitted.state, 'queued');
  await started.promise;
  input.snapshot.recipe.color[0] = 0;
  input.snapshot.assetBytes.fill(0);
  assert.deepEqual(observed.recipe.color, [1, 0, 0]);
  assert.equal(observed.assetBytes.toString(), 'owned bytes');
  assert.throws(() => controller.result(submitted.jobId), /No completed result/);
  await assert.rejects(controller.submit(request()), /already active/);
  finish.resolve();
  assert.equal((await terminal(controller, submitted.jobId)).state, 'completed');
  const result = controller.result(submitted.jobId);
  const bytes = await readFile(join(root, submitted.jobId, 'render.png'));
  assert.equal(result.artifacts[0].sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(result.artifacts[0].bytes, bytes.length);
  assert.equal(Object.hasOwn(result.artifacts[0], 'path'), false);
  assert.equal((await readdir(join(root, submitted.jobId))).includes('render.png.partial'), false);
  result.artifacts[0].filename = '../foreign';
  assert.equal(controller.result(submitted.jobId).artifacts[0].filename, 'render.png');
  await controller.close();
  const recovered = await createAgentRenderJobs({ root, limits, run: writeImage });
  assert.equal(recovered.status(submitted.jobId).state, 'completed');
  assert.deepEqual(recovered.result(submitted.jobId).metrics, { maximumPendingFrames: 1 });
  await recovered.release(submitted.jobId);
  assert.throws(() => recovered.status(submitted.jobId), /Unknown/);
  await recovered.close();
});

test('cancel acknowledges immediately and blocks output publication after runner writes a partial', async context => {
  const root = await temporary(context);
  const started = deferred();
  const controller = await createAgentRenderJobs({ root, limits, async run({ directory, signal }) {
    await writeFile(join(directory, 'render.png.partial'), 'partial bytes');
    started.resolve();
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    return { artifacts: [{ temporary: 'render.png.partial', filename: 'render.png', mimeType: 'image/png' }] };
  } });
  const { jobId } = await controller.submit(request());
  await started.promise;
  assert.equal(controller.cancel(jobId).state, 'cancelling');
  await assert.rejects(controller.release(jobId), /settle/);
  assert.equal((await terminal(controller, jobId)).state, 'cancelled');
  assert.equal((await readdir(join(root, jobId))).includes('render.png'), false);
  assert.throws(() => controller.result(jobId), /cancelled/);
  await controller.close();
});

test('deadline aborts a cooperative callback and close detects an uncooperative callback without releasing its lock', async context => {
  const root = await temporary(context);
  const controller = await createAgentRenderJobs({ root, limits: { ...limits, deadlineMs: 10 }, async run({ signal }) {
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    throw signal.reason;
  } });
  const { jobId } = await controller.submit(request());
  const failed = await terminal(controller, jobId);
  assert.equal(failed.state, 'failed');
  assert.match(failed.reason, /deadline/);
  await controller.close();
  const started = deferred();
  const finish = deferred();
  const hung = await createAgentRenderJobs({ root, limits: { ...limits, cleanupMs: 10 }, async run(argumentsValue) {
    started.resolve();
    await finish.promise;
    return writeImage(argumentsValue);
  } });
  const hungJob = await hung.submit(request());
  await started.promise;
  await assert.rejects(hung.close(), /did not settle/);
  await assert.rejects(createAgentRenderJobs({ root, limits, run: writeImage }), /live process/);
  finish.resolve();
  assert.equal((await terminal(hung, hungJob.jobId)).state, 'cancelled');
  await hung.close();
});

test('1920x1080 and 1080x1920 jobs are admitted', async context => {
  const root = await temporary(context);
  const controller = await createAgentRenderJobs({ root, limits, run: writeImage });
  for (const [width, height] of [[1920, 1080], [1080, 1920]]) {
    const { jobId } = await controller.submit({ ...request(), settings: { kind: 'image', width, height } });
    assert.equal((await terminal(controller, jobId)).settings.width, width);
  }
  await controller.close();
});

test('validation enforces range, geometry-independent storage limits and one pending frame', async context => {
  const root = await temporary(context);
  let calls = 0;
  const controller = await createAgentRenderJobs({ root, limits, async run(argumentsValue) {
    calls++;
    await argumentsValue.progress({ frames: 1, maximumPendingFrames: 2 });
    return writeImage(argumentsValue);
  } });
  for (const settings of [
    { kind: 'video', width: 65, height: 64 },
    { kind: 'image', width: 1921, height: 64 },
    { kind: 'image', width: 1920, height: 1081 },
    { kind: 'image', width: 1920, height: 1920 },
    { kind: 'video', width: 64, height: 64, fps: 31 },
    { kind: 'video', width: 64, height: 64, duration: 61 },
  ]) await assert.rejects(controller.submit({ ...request(), settings }));
  await assert.rejects(controller.submit({ ...request(), snapshot: { recipe: {}, clips: [{ duration: 1 }] }, settings: { kind: 'video', width: 64, height: 64, duration: 1, animation: { clip: 0, start: 0.1 } } }), /clip duration/);
  await assert.rejects(controller.submit({ ...request(), snapshot: { recipe: { sparse: Array(2) } } }), /dense/);
  assert.equal(calls, 0);
  const { jobId } = await controller.submit(request());
  const failed = await terminal(controller, jobId);
  assert.equal(failed.state, 'failed');
  assert.match(failed.reason, /pending frames/);
  await controller.close();
});

test('runner traversal and oversized outputs fail without final artifacts', async context => {
  const root = await temporary(context);
  const controller = await createAgentRenderJobs({ root, limits, async run({ directory }) {
    await writeFile(join(directory, 'render.png.partial'), Buffer.alloc(129));
    return { artifacts: [{ temporary: 'render.png.partial', filename: 'render.png', mimeType: 'image/png' }] };
  } });
  const oversized = await controller.submit(request());
  assert.match((await terminal(controller, oversized.jobId)).reason, /byte budget/);
  await controller.close();
  const traversal = await createAgentRenderJobs({ root, limits, async run() {
    return { artifacts: [{ temporary: '../outside', filename: 'render.png', mimeType: 'image/png' }] };
  } });
  const submitted = await traversal.submit(request());
  assert.match((await terminal(traversal, submitted.jobId)).reason, /fixed filename/);
  assert.equal((await readdir(join(root, submitted.jobId))).includes('render.png'), false);
  await traversal.close();
});

test('restart marks unfinished records interrupted and rejects forged artifact paths', async context => {
  const root = await temporary(context);
  const controller = await createAgentRenderJobs({ root, limits, run: writeImage });
  const { jobId } = await controller.submit(request());
  await terminal(controller, jobId);
  await controller.close();
  const statusPath = join(root, jobId, 'status.json');
  const status = JSON.parse(await readFile(statusPath, 'utf8'));
  status.state = 'running';
  status.artifacts = [];
  await writeFile(statusPath, JSON.stringify(status));
  await writeFile(join(root, 'store.lock'), JSON.stringify({ schemaVersion: 1, pid: 2147483647, token: randomUUID() }));
  const staleLock = await readFile(join(root, 'store.lock'));
  await assert.rejects(createAgentRenderJobs({ root, limits, run: writeImage }), /explicit repair/);
  assert.deepEqual(await readFile(join(root, 'store.lock')), staleLock);
  // The test owns this root and performs the explicit stale-lock repair.
  await unlink(join(root, 'store.lock'));
  const recovered = await createAgentRenderJobs({ root, limits, run: writeImage });
  assert.equal(recovered.status(jobId).state, 'interrupted');
  await recovered.close();
  status.state = 'completed';
  status.artifacts = [{ filename: '../outside', mimeType: 'image/png', bytes: 1, sha256: '0'.repeat(64) }];
  await writeFile(statusPath, JSON.stringify(status));
  await assert.rejects(createAgentRenderJobs({ root, limits, run: writeImage }), /artifact name/);
});

test('incomplete admissions remain quarantined while completed jobs reopen and storage stays bounded', async context => {
  const root = await temporary(context);
  const controller = await createAgentRenderJobs({ root, limits, run: writeImage });
  const completed = await controller.submit(request());
  await terminal(controller, completed.jobId);
  await controller.close();
  const { storeId } = JSON.parse(await readFile(join(root, 'store.json'), 'utf8'));
  const staging = join(root, `.pending-${storeId}-${randomUUID()}`);
  const empty = join(root, `.pending-${storeId}-${randomUUID()}`);
  await mkdir(staging);
  await mkdir(empty);
  await writeFile(join(staging, 'owner.json'), '{');
  await writeFile(join(staging, 'snapshot.json'), '{"recipe":');
  await writeFile(join(staging, 'foreign.txt'), 'preserve me');
  const reopened = await createAgentRenderJobs({ root, limits, run: writeImage });
  assert.equal(reopened.result(completed.jobId).artifacts.length, 1);
  assert.equal(reopened.list().length, 1);
  assert.equal(await readFile(join(staging, 'foreign.txt'), 'utf8'), 'preserve me');
  assert.equal((await readdir(root)).includes(empty.split(/[\\/]/).at(-1)), false);
  await writeFile(join(staging, 'asset.glb'), Buffer.alloc(limits.maxStoreBytes));
  await assert.rejects(reopened.submit(request()), /total byte budget/);
  await reopened.close();
});

test('a real initial status write failure publishes no job and leaves admission available', async context => {
  const root = await temporary(context);
  let calls = 0;
  const controller = await createAgentRenderJobs({ root, limits, async run(argumentsValue) {
    calls++;
    return writeImage(argumentsValue);
  } });
  let staging;
  const watcher = watch(root, (event, name) => {
    if (!staging && String(name).startsWith('.pending-')) {
      staging = join(root, String(name));
      writeFileSync(join(staging, 'status.json'), 'preserve conflicting file', { flag: 'wx' });
      watcher.close();
    }
  });
  try { await assert.rejects(controller.submit(request()), /EEXIST/); }
  finally { watcher.close(); }
  assert.ok(staging);
  assert.equal(controller.list().length, 0);
  assert.equal(calls, 0);
  assert.equal(await readFile(join(staging, 'status.json'), 'utf8'), 'preserve conflicting file');
  const completed = await controller.submit(request());
  assert.equal((await terminal(controller, completed.jobId)).state, 'completed');
  assert.equal(calls, 1);
  await controller.close();
  const reopened = await createAgentRenderJobs({ root, limits, run: writeImage });
  assert.equal(reopened.result(completed.jobId).artifacts.length, 1);
  assert.equal(reopened.list().length, 1);
  await reopened.close();
});

test('release rejects aliases and foreign files before deleting owned entries', async context => {
  const parent = await temporary(context);
  const root = join(parent, 'jobs');
  const controller = await createAgentRenderJobs({ root, limits, run: writeImage });
  const { jobId } = await controller.submit(request());
  await terminal(controller, jobId);
  const outside = join(parent, 'outside.txt');
  await writeFile(outside, 'preserve me');
  await link(outside, join(root, jobId, 'frame-0.png.partial'));
  await assert.rejects(controller.release(jobId), /aliases/);
  assert.equal(await readFile(outside, 'utf8'), 'preserve me');
  assert.ok((await readdir(join(root, jobId))).includes('status.json'));
  await controller.close();
  const foreignRoot = join(parent, 'foreign');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(foreignRoot);
  await writeFile(join(foreignRoot, 'keep.txt'), 'untouched');
  await assert.rejects(createAgentRenderJobs({ root: foreignRoot, limits, run: writeImage }), /foreign/);
  assert.equal(await readFile(join(foreignRoot, 'keep.txt'), 'utf8'), 'untouched');
});

test('record quota requires explicit release and completed artifact integrity survives reopening', async context => {
  const root = await temporary(context);
  const controller = await createAgentRenderJobs({ root, limits: { ...limits, maxRecords: 1 }, run: writeImage });
  const { jobId } = await controller.submit(request());
  await terminal(controller, jobId);
  await assert.rejects(controller.submit(request()), /record budget/);
  await controller.close();
  await writeFile(join(root, jobId, 'render.png'), 'corrupted');
  await assert.rejects(createAgentRenderJobs({ root, limits, run: writeImage }), /integrity/);
});

test('asset digests bind immutable bytes and still/video settings produce only their fixed artifacts', async context => {
  const root = await temporary(context);
  const assetBytes = Buffer.from('bounded embedded GLB fixture');
  const assetId = createHash('sha256').update(assetBytes).digest('hex');
  const controller = await createAgentRenderJobs({ root, limits, async run({ directory, settings, snapshot, progress }) {
    assert.equal(snapshot.recipe.assetId, createHash('sha256').update(snapshot.assetBytes).digest('hex'));
    const filenames = settings.kind === 'stills' ? Array.from({ length: 8 }, (_, index) => `frame-${index}.png`) : ['render.mp4'];
    const artifacts = [];
    for (const filename of filenames) {
      await writeFile(join(directory, `${filename}.partial`), Buffer.alloc(32, 1));
      artifacts.push({ temporary: `${filename}.partial`, filename, mimeType: settings.kind === 'video' ? 'video/mp4' : 'image/png' });
    }
    await progress({ frames: settings.frameCount, maximumPendingFrames: 1 });
    return { artifacts, metrics: { frameCount: settings.frameCount } };
  } });
  const snapshot = { recipe: { format: '67js.asset', assetId }, assetBytes, clips: [{ duration: 5 }] };
  await assert.rejects(controller.submit({ sourceRevision: 1, snapshot: { ...snapshot, assetBytes: Buffer.from('changed') }, settings: { kind: 'image', width: 64, height: 64 } }), /SHA256/);
  for (const kind of ['stills', 'video']) {
    const { jobId } = await controller.submit({ sourceRevision: 1, snapshot, settings: { kind, width: 64, height: 64, duration: 1, fps: 12, animation: { clip: 0, start: 2 }, rendererTime: { start: 3, rate: -1 } } });
    assert.equal((await terminal(controller, jobId)).state, 'completed');
    const result = controller.result(jobId);
    assert.equal(result.artifacts.length, kind === 'stills' ? 8 : 1);
    assert.equal(result.metrics.frameCount, kind === 'stills' ? 8 : 12);
    assert.deepEqual(controller.status(jobId).settings.rendererTime, { start: 3, rate: -1 });
  }
  await controller.close();
});

test('a path tracer job names its denoiser, and oidn defaults to 16 samples instead of 64', async context => {
  const root = await temporary(context);
  const assetBytes = Buffer.from('bounded embedded GLB fixture');
  const assetId = createHash('sha256').update(assetBytes).digest('hex');
  const snapshot = { recipe: { format: '67js.asset', assetId }, assetBytes, clips: [{ duration: 5 }] };
  const controller = await createAgentRenderJobs({ root, limits, async run({ directory }) {
    await writeFile(join(directory, 'render.png.partial'), Buffer.alloc(32, 1));
    return { artifacts: [{ temporary: 'render.png.partial', filename: 'render.png', mimeType: 'image/png' }], metrics: {} };
  } });
  const submitWith = renderer => controller.submit({ sourceRevision: 1, snapshot, settings: { kind: 'image', width: 64, height: 64, renderer: { type: 'pathTracer', ...renderer } } });
  const expectations = [[{}, true, 64], [{ denoise: 'oidn' }, 'oidn', 16], [{ denoise: 'oidn', samples: 8 }, 'oidn', 8], [{ denoise: 'wavelet' }, 'wavelet', 64], [{ denoise: false }, false, 64]];
  for (const [renderer, denoise, samples] of expectations) {
    const job = await submitWith(renderer);
    await terminal(controller, job.jobId);
    const settings = controller.status(job.jobId).settings.renderer;
    assert.equal(settings.denoise, denoise);
    assert.equal(settings.samples, samples);
  }
  await assert.rejects(submitWith({ denoise: 'bm3d' }), /denoise must be/);
  await controller.close();
});

test('a path tracer job draws every sample unless it passes a noise threshold, which stays within 0 to 0.1', async context => {
  const root = await temporary(context);
  const assetBytes = Buffer.from('bounded embedded GLB fixture');
  const assetId = createHash('sha256').update(assetBytes).digest('hex');
  const snapshot = { recipe: { format: '67js.asset', assetId }, assetBytes, clips: [{ duration: 5 }] };
  const controller = await createAgentRenderJobs({ root, limits, async run({ directory }) {
    await writeFile(join(directory, 'render.png.partial'), Buffer.alloc(32, 1));
    return { artifacts: [{ temporary: 'render.png.partial', filename: 'render.png', mimeType: 'image/png' }], metrics: {} };
  } });
  const submitWith = renderer => controller.submit({ sourceRevision: 1, snapshot, settings: { kind: 'image', width: 64, height: 64, renderer: { type: 'pathTracer', ...renderer } } });
  const defaulted = await submitWith({});
  await terminal(controller, defaulted.jobId);
  assert.equal(controller.status(defaulted.jobId).settings.renderer.noiseThreshold, 0);
  const adaptive = await submitWith({ noiseThreshold: 0.03 });
  await terminal(controller, adaptive.jobId);
  assert.equal(controller.status(adaptive.jobId).settings.renderer.noiseThreshold, 0.03);
  for (const noiseThreshold of [-0.01, 0.11, Number.NaN]) await assert.rejects(submitWith({ noiseThreshold }), /noiseThreshold/);
  await controller.close();
});

test('a path tracer job runs on the cpu unless it asks for the gpu, and film jobs may trace every frame', async context => {
  const root = await temporary(context);
  const assetBytes = Buffer.from('bounded embedded GLB fixture');
  const assetId = createHash('sha256').update(assetBytes).digest('hex');
  const snapshot = { recipe: { format: '67js.asset', assetId }, assetBytes, clips: [{ duration: 5 }] };
  const controller = await createAgentRenderJobs({ root, limits, async run({ directory }) {
    await writeFile(join(directory, 'render.png.partial'), Buffer.alloc(32, 1));
    return { artifacts: [{ temporary: 'render.png.partial', filename: 'render.png', mimeType: 'image/png' }], metrics: {} };
  } });
  const submitWith = (renderer, kind = 'image') => controller.submit({ sourceRevision: 1, snapshot, settings: { kind, width: 64, height: 64, duration: 1, fps: 2, renderer: { type: 'pathTracer', ...renderer } } });
  const defaulted = await submitWith({});
  await terminal(controller, defaulted.jobId);
  assert.equal(controller.status(defaulted.jobId).settings.renderer.backend, 'cpu');
  const onGpu = await submitWith({ backend: 'gpu' });
  await terminal(controller, onGpu.jobId);
  assert.equal(controller.status(onGpu.jobId).settings.renderer.backend, 'gpu');
  const onNative = await submitWith({ backend: 'native' });
  await terminal(controller, onNative.jobId);
  assert.equal(controller.status(onNative.jobId).settings.renderer.backend, 'native');
  await assert.rejects(submitWith({ backend: 'metal' }), /backend must be cpu, gpu or native/);
  const film = await submitWith({ backend: 'gpu', samples: 16 }, 'video');
  assert.equal(controller.status(film.jobId).settings.renderer.samples, 16);
  await controller.close();
});

test('the deadline of a traced film covers every frame', () => {
  const renderer = { type: 'pathTracer', maxSeconds: 10 };
  const single = jobDeadlineMs({ frameCount: 1, width: 64, height: 64, renderer });
  const film = jobDeadlineMs({ frameCount: 5, width: 64, height: 64, renderer });
  assert.equal(film - single, 4 * 10 * 1000);
});
