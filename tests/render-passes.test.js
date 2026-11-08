import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveEffects } from '../src/effects.js';
import { normalizeAgentLook } from '../src/agent-look.js';
import { RENDER_PASS_MODES, installRenderPasses } from '../src/render-passes.js';
import { createFragmentShader } from '../src/shaders.js';
import { RENDER_PASS_NAMES } from '../src/agent-scene-capabilities.js';
import { installCameraEffects, depthOfFieldFragment, motionBlurFragment } from '../src/camera-effects.js';
import { createAgentRenderJobs, artifactNames } from '../scripts/agent-render-jobs.mjs';

const limits = { maxOutputBytes: 1024, maxFrameBytes: 128, maxStoreBytes: 1024 ** 2, cleanupMs: 100 };

test('capabilities and the renderer list the same passes in the same order', () => {
  assert.deepEqual(Object.keys(RENDER_PASS_MODES), [...RENDER_PASS_NAMES]);
  assert.deepEqual(Object.values(RENDER_PASS_MODES), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});

test('the pass branch of the main shader is compiled out unless a pass is requested', () => {
  assert.match(createFragmentShader([]), /#define USES_RENDER_PASS false/);
  assert.match(createFragmentShader(['renderPass']), /#define USES_RENDER_PASS \(renderPassMode > 0\.5 && renderPassMode < 5\.5\)/);
});

test('camera effects default off, validate ranges and survive look normalization', () => {
  const neutral = resolveEffects();
  assert.equal(neutral.depthOfField.blur, 0);
  assert.equal(neutral.motionBlur.shutter, 0);
  const look = normalizeAgentLook({ effects: { depthOfField: { blur: 0.5 }, motionBlur: { shutter: 0.1 } } });
  assert.deepEqual(look.effects.depthOfField, { blur: 0.5, focusDistance: 5 });
  assert.equal(look.effects.motionBlur.shutter, 0.1);
  assert.deepEqual(normalizeAgentLook(look), look);
  for (const effects of [{ depthOfField: { blur: 2 } }, { depthOfField: { focusDistance: 0 } }, { depthOfField: { mystery: 1 } },
    { motionBlur: { shutter: 0.6 } }, { motionBlur: { shutter: 'long' } }, { motionBlur: 1 }]) {
    assert.throws(() => normalizeAgentLook({ effects }), undefined, JSON.stringify(effects));
  }
});

test('installing camera effects adds two stages once and costs nothing until a frame uses them', () => {
  const unusedContext = new Proxy({}, { get() { throw new Error('The GL context was touched.'); } });
  const renderer = { postStages: [], context: unusedContext };
  installCameraEffects(installCameraEffects(renderer));
  assert.deepEqual(renderer.postStages.map(stage => stage.name), ['Depth of field', 'Motion blur']);
  const effects = resolveEffects();
  for (const stage of renderer.postStages) assert.equal(stage.apply(renderer, {}, effects, null), null);
  const withoutPreviousCamera = resolveEffects({ motionBlur: { shutter: 0.2 } });
  assert.equal(renderer.postStages[1].apply({ ...renderer, previousViewProjection: null }, {}, withoutPreviousCamera, null), null);
  const blurred = resolveEffects({ depthOfField: { blur: 1 } });
  assert.throws(() => renderer.postStages[0].apply(renderer, {}, blurred, null), /requires depth:true/);
  for (const source of [depthOfFieldFragment, motionBlurFragment]) assert.doesNotMatch(source, /rand\(|Math\.random|time/);
});

test('render passes need the addon, reject unknown names and touch no GL until asked', () => {
  const unusedContext = new Proxy({}, { get() { throw new Error('The GL context was touched.'); } });
  const renderer = { passSupport: null, context: unusedContext, canvas: { width: 8, height: 8 }, benchmark: false };
  installRenderPasses(installRenderPasses(renderer));
  assert.ok(renderer.passSupport);
  assert.throws(() => renderer.passSupport.prepare({ pass: 'beauty' }), /Unknown render pass/);
  assert.throws(() => renderer.passSupport.prepare({ pass: 'depth', passDepthRange: 0 }), /depth range/);
  assert.deepEqual(renderer.passSupport.background('depth'), [1, 1, 0, 1]);
  assert.deepEqual(renderer.passSupport.background('objectId'), [0, 0, 0, 1]);
});

test('artifact names list the lit image and each pass per frame', () => {
  assert.deepEqual(artifactNames('image'), ['render.png']);
  assert.deepEqual(artifactNames('image', ['depth', 'objectId']), ['render.png', 'render-depth.png', 'render-objectId.png']);
  assert.equal(artifactNames('stills', ['normal']).length, 16);
  assert.ok(artifactNames('stills', ['normal']).includes('frame-7-normal.png'));
  assert.deepEqual(artifactNames('video'), ['render.mp4']);
});

test('a job with passes publishes every pass file and rejects bad pass requests', async context => {
  const root = await mkdtemp(join(tmpdir(), '67js-render-passes-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const run = async ({ directory, settings }) => {
    const artifacts = [];
    for (const filename of artifactNames(settings.kind, settings.passes)) {
      await writeFile(join(directory, `${filename}.partial`), Buffer.from(filename));
      artifacts.push({ temporary: `${filename}.partial`, filename, mimeType: 'image/png' });
    }
    return { artifacts, metrics: {} };
  };
  const controller = await createAgentRenderJobs({ root, limits, run });
  const snapshot = { recipe: { format: 'fixture' } };
  const submitted = await controller.submit({ sourceRevision: 0, snapshot, settings: { kind: 'image', width: 64, height: 64, passes: ['depth', 'albedo'] } });
  while (controller.status(submitted.jobId).state !== 'completed') await new Promise(resolve => setTimeout(resolve, 2));
  const record = controller.status(submitted.jobId);
  assert.deepEqual(record.artifacts.map(artifact => artifact.filename), ['render.png', 'render-depth.png', 'render-albedo.png']);
  assert.deepEqual(record.settings.passes, ['depth', 'albedo']);
  await controller.release(submitted.jobId);
  for (const passes of [['mystery'], ['depth', 'depth'], [], 'depth']) {
    await assert.rejects(controller.submit({ sourceRevision: 0, snapshot, settings: { kind: 'image', width: 64, height: 64, passes } }), /pass/i);
  }
  await assert.rejects(controller.submit({ sourceRevision: 0, snapshot, settings: { kind: 'video', width: 64, height: 64, passes: ['depth'] } }), /image or stills/);
  await controller.close();
});
