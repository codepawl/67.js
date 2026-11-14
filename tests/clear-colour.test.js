import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_BACKGROUND, resolveBackground, clearColourFor } from '../src/clear-colour.js';

test('the default clear colour is the historical grey', () => {
  assert.deepEqual([...DEFAULT_BACKGROUND], [0.145, 0.162, 0.177, 1]);
  assert.deepEqual([...clearColourFor(null, false)], [0.145, 0.162, 0.177, 1]);
});

test('a background gets opaque alpha when none is given', () => {
  assert.deepEqual(resolveBackground([0.1, 0.2, 0.3]), [0.1, 0.2, 0.3, 1]);
  assert.deepEqual(resolveBackground([0.1, 0.2, 0.3, 0.5]), [0.1, 0.2, 0.3, 0.5]);
});

test('an opaque canvas clears to the given colour', () => {
  assert.deepEqual(clearColourFor([1, 0, 0, 1], false), [1, 0, 0, 1]);
});

test('a transparent canvas clears to nothing by default and premultiplies a given colour', () => {
  assert.deepEqual(clearColourFor(null, true), [0, 0, 0, 0]);
  assert.deepEqual(clearColourFor([1, 0.5, 0, 0.5], true), [0.5, 0.25, 0, 0.5]);
});

test('invalid backgrounds throw an error that says what to pass', () => {
  for (const bad of ['red', [1, 1], [1, 1, 1, 1, 1], [2, 0, 0], [-0.1, 0, 0], [NaN, 0, 0], ['1', 0, 0], {}]) {
    assert.throws(() => resolveBackground(bad), /background must be \[red, green, blue\]/);
  }
});
