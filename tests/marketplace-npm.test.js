import test from 'node:test';
import assert from 'node:assert/strict';
import { npmManifestPath } from '../src/marketplace-npm.js';

test('a plain or scoped npm name becomes its registry manifest path', () => {
  assert.equal(npmManifestPath('hover-controller'), 'hover-controller/latest');
  assert.equal(npmManifestPath('@studio/crucible-hover'), '@studio%2Fcrucible-hover/latest');
});

test('a name that npm would not publish is refused instead of reaching the request', () => {
  for (const name of ['../../-/user', '@a/b/c', 'a/b', 'UPPER', 'a?x=1', 'a#b', '', ' a', 'a'.repeat(215), null, 42]) {
    assert.equal(npmManifestPath(name), null, `refuses ${String(name).slice(0, 20)}`);
  }
});
