import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildNativeInput,
  buildNativeInputV2,
  prepareCyclesInput,
  traceNative,
  withPathRegenerationFlag,
} from '../packages/render-native/index.mjs';
import {
  KERNEL_FLAG_PATH_REGENERATION,
  KERNEL_PARAMS_V2_KERNEL_FLAGS_BYTE_OFFSET,
  STRUCT_STRIDES_V2,
  validatePathRegenerationOption,
} from '../packages/render-native/pack-input-v2.mjs';
import { createCamera } from '../src/path-tracer.js';
import * as pack from '../src/path-tracer-gpu-pack.js';
import { buildTraceScene } from '../src/path-tracer-scene.js';

function readKernelFlags(kernelParams) {
  const view = new DataView(kernelParams.buffer, kernelParams.byteOffset, kernelParams.byteLength);
  return view.getUint32(KERNEL_PARAMS_V2_KERNEL_FLAGS_BYTE_OFFSET, true);
}

function makeKernelParams(flags) {
  const kernelParams = new Uint8Array(STRUCT_STRIDES_V2.kernelParams);
  new DataView(kernelParams.buffer).setUint32(KERNEL_PARAMS_V2_KERNEL_FLAGS_BYTE_OFFSET, flags, true);
  return kernelParams;
}

test('the path regeneration flag is bit 10 and does not collide with the other kernel flags', () => {
  assert.equal(KERNEL_FLAG_PATH_REGENERATION, 1024);
});

test('withPathRegenerationFlag sets and clears only its own bit and leaves the input untouched', () => {
  const original = makeKernelParams(1 | 64);
  const enabled = withPathRegenerationFlag(original, true);
  assert.equal(readKernelFlags(enabled), 1 | 64 | 1024);
  assert.equal(readKernelFlags(original), 1 | 64);
  assert.equal(readKernelFlags(withPathRegenerationFlag(enabled, false)), 1 | 64);
});

test('pathRegeneration accepts true, false and undefined, and rejects anything else', () => {
  validatePathRegenerationOption(undefined, 'caller');
  validatePathRegenerationOption(true, 'caller');
  validatePathRegenerationOption(false, 'caller');
  assert.throws(() => validatePathRegenerationOption('on', 'caller'), /`pathRegeneration` must be true, false/);
  assert.throws(() => validatePathRegenerationOption(1, 'caller'), TypeError);
});

function makeCardScene() {
  const parts = [{
    name: 'card',
    geometry: {
      positions: new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]),
      normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
      uvs: new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]),
      colors: new Float32Array(12).fill(1),
      indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
    },
    material: { color: [0.6, 0.5, 0.4], roughness: 0.7 },
  }];
  const scene = buildTraceScene(parts, {});
  const camera = createCamera({ eye: [0, 0, 4], target: [0, 0, 0], fov: 45 }, 16, 16);
  return { scene, camera };
}

const traceOptions = { width: 16, height: 16, samples: 1 };

test('the cycles kernel turns path regeneration on unless the caller says false', () => {
  const { scene, camera } = makeCardScene();
  const v2Input = buildNativeInputV2(scene, camera, traceOptions);
  assert.equal(readKernelFlags(v2Input.kernelParams) & KERNEL_FLAG_PATH_REGENERATION, 0, 'the packer leaves the flag to traceNative');

  const byDefault = prepareCyclesInput(v2Input, traceOptions);
  assert.equal(readKernelFlags(byDefault.kernelParams) & KERNEL_FLAG_PATH_REGENERATION, KERNEL_FLAG_PATH_REGENERATION);

  const explicitTrue = prepareCyclesInput(v2Input, { ...traceOptions, pathRegeneration: true });
  assert.equal(readKernelFlags(explicitTrue.kernelParams), readKernelFlags(byDefault.kernelParams));

  const explicitFalse = prepareCyclesInput(v2Input, { ...traceOptions, pathRegeneration: false });
  assert.equal(readKernelFlags(explicitFalse.kernelParams) & KERNEL_FLAG_PATH_REGENERATION, 0);
  assert.equal(
    readKernelFlags(explicitFalse.kernelParams) | KERNEL_FLAG_PATH_REGENERATION,
    readKernelFlags(byDefault.kernelParams),
    'false clears only the regeneration bit'
  );
});

test('a v1 input upgraded for the cycles kernel also defaults to path regeneration and honours false', () => {
  const { scene, camera } = makeCardScene();
  const v1Input = buildNativeInput(scene, camera, traceOptions, pack);
  const byDefault = prepareCyclesInput(v1Input, traceOptions);
  const explicitFalse = prepareCyclesInput(v1Input, { ...traceOptions, pathRegeneration: false });
  assert.equal(readKernelFlags(byDefault.kernelParams) & KERNEL_FLAG_PATH_REGENERATION, KERNEL_FLAG_PATH_REGENERATION);
  assert.equal(readKernelFlags(explicitFalse.kernelParams) & KERNEL_FLAG_PATH_REGENERATION, 0);
});

test('the legacy kernel ignores pathRegeneration and still refuses a FORMAT-v2 input', () => {
  const { scene, camera } = makeCardScene();
  const v2Input = buildNativeInputV2(scene, camera, traceOptions);
  for (const pathRegeneration of [undefined, true, false]) {
    assert.throws(
      () => traceNative(v2Input, { ...traceOptions, kernel: 'legacy', pathRegeneration }),
      /Cannot pass a FORMAT-v2 scene input to kernel "legacy"|native tracer is not built/
    );
  }
});
