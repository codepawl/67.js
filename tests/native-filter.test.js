import assert from 'node:assert/strict';
import test from 'node:test';
import { STRUCT_STRIDES_V2, buildNativeInputV2, withFilterOptions } from '../packages/render-native/index.mjs';
import {
  KERNEL_PARAMS_V2_FILTER_TYPE_BYTE_OFFSET,
  KERNEL_PARAMS_V2_FILTER_WIDTH_BYTE_OFFSET,
  validateFilterOptions,
  validatePackOptions,
} from '../packages/render-native/pack-input-v2.mjs';
import { createCamera } from '../src/path-tracer.js';

test('pixel filter options accept the three filters and a width in pixels', () => {
  for (const filterType of [undefined, 'box', 'gaussian', 'blackman-harris', 'blackman_harris', 0, 1, 2]) {
    assert.doesNotThrow(() => validateFilterOptions({ filterType }, 'test'), String(filterType));
  }
  for (const filterWidth of [undefined, 0.01, 1, 1.5, 16]) {
    assert.doesNotThrow(() => validateFilterOptions({ filterWidth }, 'test'), String(filterWidth));
  }
  assert.doesNotThrow(() => validatePackOptions({ filterType: 'blackman-harris', filterWidth: 1.5 }, 'test'));
});

test('pixel filter options reject an unknown filter and a width outside 0.01 to 16', () => {
  for (const filterType of ['tent', 'Box', 3, -1, null, {}]) {
    assert.throws(
      () => validateFilterOptions({ filterType }, 'test'),
      /`filterType` must be "box" \(default\), "gaussian" or "blackman-harris"/,
      String(filterType)
    );
  }
  for (const filterWidth of [0, -1, 0.001, 17, Number.NaN, Number.POSITIVE_INFINITY, '1.5', null]) {
    assert.throws(
      () => validateFilterOptions({ filterWidth }, 'test'),
      /`filterWidth` must be a number of pixels from 0.01 to 16/,
      String(filterWidth)
    );
  }
  assert.throws(() => validatePackOptions({ filterType: 'tent' }, 'test'), /`filterType`/);
});

test('filter options on an already packed v2 input patch the kernel params with the packer offsets', () => {
  const kernelParams = new Uint8Array(STRUCT_STRIDES_V2.kernelParams);
  const view = new DataView(kernelParams.buffer);
  view.setUint32(KERNEL_PARAMS_V2_FILTER_TYPE_BYTE_OFFSET, 0, true);
  view.setFloat32(KERNEL_PARAMS_V2_FILTER_WIDTH_BYTE_OFFSET, 1, true);
  const read = (params) => {
    const readView = new DataView(params.buffer, params.byteOffset, params.byteLength);
    return {
      type: readView.getUint32(KERNEL_PARAMS_V2_FILTER_TYPE_BYTE_OFFSET, true),
      width: readView.getFloat32(KERNEL_PARAMS_V2_FILTER_WIDTH_BYTE_OFFSET, true),
    };
  };
  assert.deepEqual(read(withFilterOptions(kernelParams, { filterType: 'blackman-harris' })), { type: 2, width: 1.5 });
  assert.deepEqual(read(withFilterOptions(kernelParams, { filterType: 'gaussian', filterWidth: 2 })), { type: 1, width: 2 });
  assert.deepEqual(read(withFilterOptions(kernelParams, { filterWidth: 3 })), { type: 0, width: 3 });
  assert.deepEqual(read(kernelParams), { type: 0, width: 1 }, 'the packed buffer is not modified');
});

test('the packer writes the filter at the shared byte offsets', () => {
  const camera = createCamera({ eye: [0, 0, 6], target: [0, 0, 0], fov: 50 }, 8, 8);
  const packed = buildNativeInputV2({ materials: [], instances: [], lights: {} }, camera, {
    width: 8,
    height: 8,
    samples: 1,
    filterType: 'gaussian',
    filterWidth: 2.5,
  });
  const view = new DataView(packed.kernelParams.buffer, packed.kernelParams.byteOffset, packed.kernelParams.byteLength);
  assert.equal(view.getUint32(KERNEL_PARAMS_V2_FILTER_TYPE_BYTE_OFFSET, true), 1);
  assert.equal(view.getFloat32(KERNEL_PARAMS_V2_FILTER_WIDTH_BYTE_OFFSET, true), 2.5);
});
