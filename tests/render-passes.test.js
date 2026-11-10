import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveEffects } from '../src/effects.js';
import { normalizeAgentLook } from '../src/agent-look.js';
import { RENDER_PASS_MODES, installRenderPasses, cryptomatteValue, cryptomatteHashHex } from '../src/render-passes.js';
import { createFragmentShader } from '../src/shaders.js';
import { RENDER_PASS_NAMES } from '../src/agent-scene-capabilities.js';
import { installCameraEffects, depthOfFieldFragment, motionBlurFragment } from '../src/camera-effects.js';
import { createAgentRenderJobs, artifactNames } from '../scripts/agent-render-jobs.mjs';
import { encodeRenderOutput, encodeMultilayerExr } from '../scripts/render-output-encoders.mjs';
import { createAgentScene, loadAllAgentSceneModules } from '../src/agent-scene.js';
import { bakeMaterialGraph } from '../src/material-graph.js';

const limits = { maxOutputBytes: 1024, maxFrameBytes: 128, maxStoreBytes: 1024 ** 2, cleanupMs: 100 };

test('capabilities and the renderer list the same passes in the same order, wireframe last as a composed pass', () => {
  assert.deepEqual([...Object.keys(RENDER_PASS_MODES), 'wireframe'], [...RENDER_PASS_NAMES]);
  assert.deepEqual(Object.values(RENDER_PASS_MODES), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18]);
});

test('the pass branch of the main shader is compiled out unless a pass is requested', () => {
  assert.match(createFragmentShader([]), /#define USES_RENDER_PASS false/);
  assert.match(createFragmentShader(['renderPass']), /#define USES_RENDER_PASS \(renderPassMode > 0\.5 && renderPassMode < 5\.5\)/);
  assert.match(createFragmentShader(['renderPass', 'lightingPass']), /cryptoHash/);
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

test('render passes need the addon, reject unknown names and bind per-pass uniforms and manifests', () => {
  const calls = [];
  const context = {
    VERTEX_SHADER: 1, FRAGMENT_SHADER: 2, COMPILE_STATUS: 3, LINK_STATUS: 4,
    TEXTURE_2D: 5, RGBA16F: 6, RGBA8: 7, RGBA: 8, HALF_FLOAT: 9, UNSIGNED_BYTE: 10,
    TEXTURE_MIN_FILTER: 11, TEXTURE_MAG_FILTER: 12, NEAREST: 13, RENDERBUFFER: 14,
    DEPTH_COMPONENT24: 15, FRAMEBUFFER: 16, COLOR_ATTACHMENT0: 17, DEPTH_ATTACHMENT: 18,
    FRAMEBUFFER_COMPLETE: 19, DEPTH_TEST: 20, CULL_FACE: 21, TEXTURE0: 22, TRIANGLES: 23,
    getExtension: () => ({}),
    createShader: () => ({}),
    shaderSource: () => {},
    compileShader: () => {},
    getShaderParameter: () => true,
    deleteShader: () => {},
    createProgram: () => ({}),
    attachShader: () => {},
    linkProgram: () => {},
    getProgramParameter: () => true,
    getProgramInfoLog: () => '',
    getShaderInfoLog: () => '',
    deleteProgram: () => {},
    getUniformLocation: (_program, name) => name,
    createTexture: () => ({ kind: 'tex' }),
    bindTexture: () => {},
    texImage2D: () => {},
    texParameteri: () => {},
    createRenderbuffer: () => ({ kind: 'rb' }),
    bindRenderbuffer: () => {},
    renderbufferStorage: () => {},
    createFramebuffer: () => ({ kind: 'fb' }),
    bindFramebuffer: () => {},
    framebufferTexture2D: () => {},
    framebufferRenderbuffer: () => {},
    checkFramebufferStatus: () => 19,
    deleteTexture: () => {},
    deleteRenderbuffer: () => {},
    deleteFramebuffer: () => {},
    viewport: () => {},
    disable: () => {},
    bindVertexArray: () => {},
    useProgram: () => {},
    activeTexture: () => {},
    uniform1i: (loc, val) => calls.push([loc, val]),
    uniform1f: (loc, val) => calls.push([loc, val]),
    uniform1fv: (loc, val) => calls.push([loc, val.length]),
    uniform3f: (loc, x, y, z) => calls.push([loc, [x, y, z]]),
    uniform3fv: (loc, val) => calls.push([loc, val]),
    uniformMatrix4fv: (loc, _transpose, val) => calls.push([loc, val.length]),
    drawArrays: () => calls.push(['drawArrays']),
  };
  const drawn = [];
  const batchOpaque = {
    parts: [
      { name: 'hero', matrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]), material: { id: 'steel', aov: [0.2, 0.4, 0.6], aovMap: { id: 'aov-tex' } } },
      { name: 'floor', matrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]), material: { name: 'stone' } },
    ],
    layerState: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    textures: ['t0', 't1', 't2', 't3', 't4'],
  };
  const batchGlass = {
    parts: [{ name: 'glass', matrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]), material: { transmissionMap: { id: 'trans-tex' } } }],
    layerState: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0.85],
    textures: ['g0', 'g1', 'g2', 'g3', 'g4'],
  };
  const renderer = {
    passSupport: null,
    context,
    canvas: { width: 8, height: 8 },
    benchmark: false,
    program: {},
    viewProjection: new Float32Array(16),
    renderTargets: { record: () => {}, release: () => {} },
    requireFeatureNames: () => {},
    drawsInOpaqueLoop: batch => batch === batchOpaque,
    createTexture: desc => desc,
    drawAlphaBatch: (batch, _tex, culled) => drawn.push({ batch, tex4: batch.textures[4], culled }),
    batches: [batchOpaque, batchGlass],
  };
  installRenderPasses(installRenderPasses(renderer));
  assert.ok(renderer.passSupport);
  assert.throws(() => renderer.passSupport.prepare({ pass: 'beauty' }), /Unknown render pass/);
  assert.throws(() => renderer.passSupport.prepare({ pass: 'depth', passDepthRange: 0 }), /depth range/);
  assert.deepEqual(renderer.passSupport.background('depth'), [1, 1, 0, 1]);
  assert.deepEqual(renderer.passSupport.background('objectId'), [0, 0, 0, 1]);
  const manifest = renderer.passSupport.cryptomatteManifest();
  assert.deepEqual(Object.keys(manifest.objects), ['hero', 'floor']);
  assert.deepEqual(Object.keys(manifest.materials), ['steel', 'stone']);
  assert.equal(manifest.objects.hero.value, cryptomatteValue(1));
  assert.equal(manifest.objects.hero.hash, cryptomatteHashHex('hero'));
  assert.equal(manifest.materials.stone.value, cryptomatteValue(2));
  assert.equal(renderer.passSupport.drawsInPass(batchGlass, RENDER_PASS_MODES.albedo), false);
  assert.equal(renderer.passSupport.drawsInPass(batchGlass, RENDER_PASS_MODES.transmission), true);

  assert.equal(renderer.passSupport.prepare({ pass: 'aov', passFloat: true }), RENDER_PASS_MODES.aov);
  assert.ok(renderer.passSupport.framebuffer);
  assert.ok(renderer.passSupport.texture);
  renderer.passSupport.bindFrame(
    { passFloat: true, previousCamera: { eye: [1, 2, 5], target: [0, 0, 0] } },
    { fogDensity: 0.01, fogColor: [0.3, 0.4, 0.5] },
    { density: 0, color: [0, 0, 0] },
  );
  renderer.passSupport.drawBatch(
    batchOpaque,
    RENDER_PASS_MODES.aov,
    { previousMatrices: { hero: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 1]) } },
    0,
  );
  assert.equal(drawn.at(-1).tex4.id, 'aov-tex');
  assert.equal(batchOpaque.textures[4], 't4');
  renderer.passSupport.drawBatch(
    batchGlass,
    RENDER_PASS_MODES.transmission,
    { objectMotion: { matrices: new Float32Array(32) } },
    0,
  );
  assert.equal(drawn.at(-1).tex4.id, 'trans-tex');
  assert.equal(batchGlass.textures[4], 'g4');
  renderer.passSupport.copyToCanvas();
  assert.equal(renderer.passSupport.prepare({ pass: 'cryptomatte', passFloat: false }), RENDER_PASS_MODES.cryptomatte);
  renderer.passSupport.dispose(context);
});

test('materials accept scalar or RGB aov values and material graphs bake aovMap descriptors', async () => {
  await loadAllAgentSceneModules();
  const scene = createAgentScene({
    format: '67js.scene',
    schemaVersion: 1,
    geometries: [{ id: 'cube', type: 'box' }],
    materials: [
      { id: 'scalar-aov', color: [0.5, 0.5, 0.5], aov: 0.75 },
      { id: 'rgb-aov', color: [0.5, 0.5, 0.5], aov: [0.2, 0.4, 0.8] },
    ],
    nodes: [
      { id: 'a', geometry: 'cube', material: 'scalar-aov' },
      { id: 'b', geometry: 'cube', material: 'rgb-aov', translation: [2, 0, 0] },
    ],
  });
  assert.deepEqual(scene.parts[0].material.aov, [0.75, 0.75, 0.75]);
  assert.deepEqual(scene.parts[1].material.aov, [0.2, 0.4, 0.8]);
  assert.equal(scene.parts[0].material.id, 'scalar-aov');
  assert.throws(() => createAgentScene({
    format: '67js.scene',
    schemaVersion: 1,
    geometries: [{ id: 'cube', type: 'box' }],
    materials: [{ id: 'bad', aov: [1.5, 0, 0] }],
    nodes: [],
  }), /aov/);
  const baked = bakeMaterialGraph({
    color: [0.5, 0.5, 0.5],
    aov: { checker: { count: 2 } },
  }, { resolution: 64, bump: 1 });
  assert.ok(baked.aovMap);
  assert.equal(baked.aovMap.colorSpace, 'linear');
  assert.equal(baked.aovMap.image.width, 64);
});

test('artifact names and multilayer EXR encoders cover new passes and multilayer jobs', () => {
  assert.deepEqual(artifactNames('image'), ['render.png']);
  assert.deepEqual(artifactNames('image', ['depth', 'objectId']), ['render.png', 'render-depth.png', 'render-objectId.png']);
  assert.deepEqual(artifactNames('image', ['depth', 'position', 'cryptomatte'], 'exr', true), ['render.exr']);
  assert.deepEqual(artifactNames('stills', ['depth', 'uv'], 'exr', true).length, 8);
  assert.equal(artifactNames('stills', ['normal']).length, 16);
  assert.ok(artifactNames('stills', ['normal']).includes('frame-7-normal.png'));
  assert.deepEqual(artifactNames('video'), ['render.mp4']);

  const pixels = new Float32Array([
    1.5, -2.0, 3.25, 1,
    0.25, 0.75, 0.5, 1,
    -0.1, 0.2, 0, 1,
    0.8, 0.4, 1, 1,
  ]);
  for (const pass of ['position', 'velocity', 'uv', 'cryptomatte', 'aov']) {
    const exr = encodeRenderOutput({ format: 'exr', pixels, width: 2, height: 2, pass });
    assert.equal(exr[0], 0x76);
    const png16 = encodeRenderOutput({ format: 'png16', pixels, width: 2, height: 2, pass });
    assert.equal(png16[0], 0x89);
  }
  const multi = encodeMultilayerExr({
    width: 2,
    height: 2,
    beauty: pixels,
    passes: {
      position: pixels,
      velocity: pixels,
      uv: pixels,
      depth: new Float32Array(16),
      objectId: new Float32Array(16),
      cryptomatte: pixels,
      aov: pixels,
    },
    hasAlpha: true,
  });
  const headerText = multi.subarray(0, 512).toString('latin1');
  for (const channelName of ['Combined.R', 'Combined.A', 'position.X', 'position.Z', 'velocity.X', 'uv.U', 'depth.Z', 'objectId.id', 'cryptomatte.R', 'aov.G']) {
    assert.ok(headerText.includes(channelName), `multilayer EXR header includes ${channelName}`);
  }
});

test('a job with passes or multilayer EXR publishes every expected file and rejects bad pass requests', async context => {
  const root = await mkdtemp(join(tmpdir(), '67js-render-passes-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const run = async ({ directory, settings }) => {
    const artifacts = [];
    const mimeType = settings.format === 'exr' ? 'image/x-exr' : 'image/png';
    for (const filename of artifactNames(settings.kind, settings.passes, settings.format, settings.multilayer)) {
      await writeFile(join(directory, `${filename}.partial`), Buffer.from(filename));
      artifacts.push({ temporary: `${filename}.partial`, filename, mimeType });
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

  const multiSubmitted = await controller.submit({
    sourceRevision: 0,
    snapshot,
    settings: { kind: 'image', width: 64, height: 64, format: 'exr', multilayer: true, passes: ['position', 'velocity', 'uv', 'cryptomatte', 'aov'] },
  });
  while (controller.status(multiSubmitted.jobId).state !== 'completed') await new Promise(resolve => setTimeout(resolve, 2));
  const multiRecord = controller.status(multiSubmitted.jobId);
  assert.deepEqual(multiRecord.artifacts.map(artifact => artifact.filename), ['render.exr']);
  assert.equal(multiRecord.settings.multilayer, true);
  await controller.release(multiSubmitted.jobId);

  await assert.rejects(controller.submit({ sourceRevision: 0, snapshot, settings: { kind: 'image', width: 64, height: 64, multilayer: true, passes: ['depth'] } }), /multilayer requires format exr/);
  await assert.rejects(controller.submit({ sourceRevision: 0, snapshot, settings: { kind: 'image', width: 64, height: 64, format: 'exr', multilayer: true } }), /multilayer requires format exr and passes/);
  for (const passes of [['mystery'], ['depth', 'depth'], [], 'depth']) {
    await assert.rejects(controller.submit({ sourceRevision: 0, snapshot, settings: { kind: 'image', width: 64, height: 64, passes } }), /pass/i);
  }
  await assert.rejects(controller.submit({ sourceRevision: 0, snapshot, settings: { kind: 'video', width: 64, height: 64, passes: ['depth'] } }), /image or stills/);
  await controller.close();
});
