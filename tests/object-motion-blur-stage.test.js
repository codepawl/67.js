import test from 'node:test';
import assert from 'node:assert/strict';
import { mat4 } from 'gl-matrix';
import { resolveEffects } from '../src/effects.js';
import { installCameraEffects } from '../src/camera-effects.js';
import { installRenderPasses } from '../src/render-passes.js';
import { installObjectMotionBlur, packObjectMotion } from '../src/object-motion-blur.js';

function recordingContext(calls) {
  return new Proxy({}, {
    get(target, name) {
      if (typeof name === 'symbol') return undefined;
      if (/^[A-Z0-9_]+$/.test(name)) return 1;
      if (name === 'checkFramebufferStatus') return () => 1;
      return (...args) => {
        calls.push([name, ...args]);
        return true;
      };
    },
  });
}

function fakeBatchRenderer(names) {
  return { batches: [{ parts: names.map(name => ({ name })) }], drawsInOpaqueLoop: () => true };
}

test('the object stage uploads the part deltas and the ID texture, then frees them', () => {
  const calls = [];
  const context = recordingContext(calls);
  const renderer = installObjectMotionBlur(installCameraEffects(installRenderPasses({
    postStages: [], context, canvas: { width: 8, height: 8 }, hdr: false, benchmark: false,
    depthTexture: 'depth', inverseViewProjection: mat4.create(), viewProjection: mat4.create(), world: false,
    renderTargets: { record() {}, release() {} }, requireFeatureNames() {},
  })));
  renderer.passSupport.prepare({ pass: 'objectId' });
  assert.ok(renderer.passSupport.texture);
  const stage = renderer.postStages[2];
  const effects = resolveEffects({ motionBlur: { shutter: 0.1, objects: 0.5 } });
  const objectMotion = packObjectMotion(fakeBatchRenderer(['a', 'b']), new Map(), new Map());
  const camera = { eye: [0, 1, 5], target: [0, 1, 0], fov: 40 };
  for (const frame of [{ objectMotion, previousCamera: camera, ...camera }, { objectMotion, ...camera }]) {
    assert.ok(stage.apply(renderer, frame, effects, 'source'));
  }
  const uploads = calls.filter(call => call[0] === 'texImage2D' && call.at(-1) instanceof Float32Array);
  assert.equal(uploads.length, 2);
  assert.ok(calls.some(call => call[0] === 'uniform1f' && call[2] === 0.5));
  stage.releaseTargets(context);
  stage.dispose(context);
  assert.ok(calls.filter(call => call[0] === 'deleteTexture').length >= 2);
});

test('installing object blur without render passes is refused', () => {
  assert.throws(() => installObjectMotionBlur({ postStages: [] }), /installRenderPasses/);
});
