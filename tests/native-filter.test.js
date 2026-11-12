import assert from 'node:assert/strict';
import test from 'node:test';
import { validateFilterOptions, validatePackOptions } from '../packages/render-native/pack-input-v2.mjs';

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
