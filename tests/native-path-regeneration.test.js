import assert from 'node:assert/strict';
import test from 'node:test';
import { withPathRegenerationFlag } from '../packages/render-native/index.mjs';
import {
  KERNEL_FLAG_PATH_REGENERATION,
  KERNEL_PARAMS_V2_KERNEL_FLAGS_BYTE_OFFSET,
  STRUCT_STRIDES_V2,
  validatePathRegenerationOption,
} from '../packages/render-native/pack-input-v2.mjs';

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
