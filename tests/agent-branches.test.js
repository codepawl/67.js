import test from 'node:test';
import assert from 'node:assert/strict';
import { BRANCH_LIMITS, createBranchStore, printableLabel, validateBranchName } from '../src/agent-branches.js';
import { normalizeReview } from '../scripts/agent-review.mjs';

const hostileNames = ['', 'Warm', '1warm', 'a'.repeat(25), '../x', 'a b', 'a\nb', 'https://example.com/x', '__proto__ ', 'a;rm', 'é', 7, null, {}];

function forkInput(recipeId, baseId = 'base') {
  return { recipe: { id: recipeId }, baseRecipe: { id: baseId }, operations: [{ type: 'set-material', id: recipeId }], baseRevision: 0 };
}

test('branch names are bounded identifiers and hostile text is refused', () => {
  for (const name of ['a', 'warm', 'variant-2', 'long_name_with_24_chars']) assert.equal(validateBranchName(name), name);
  for (const name of hostileNames) assert.throws(() => validateBranchName(name), TypeError, String(name));
});

test('branches with the same recipe share one snapshot and unused snapshots are pruned', () => {
  const store = createBranchStore();
  assert.equal(store.fork('one', forkInput('red')).shared, false);
  assert.equal(store.fork('two', forkInput('red')).shared, true);
  assert.equal(store.fork('three', forkInput('blue')).shared, false);
  assert.equal(store.snapshotCount(), 2);
  store.fork('two', forkInput('blue'));
  store.fork('one', forkInput('blue'));
  assert.equal(store.snapshotCount(), 1);
  assert.deepEqual(store.names(), ['one', 'two', 'three']);
});

test('branch reads return copies, so a caller cannot edit stored recipes', () => {
  const store = createBranchStore();
  store.fork('one', forkInput('red'));
  store.get('one').recipe.id = 'changed';
  store.get('one').operations.length = 0;
  assert.equal(store.get('one').recipe.id, 'red');
  assert.equal(store.get('one').operations.length, 1);
});

test('the branch count is capped, a name can be reused at the cap, and unknown names fail clearly', () => {
  const store = createBranchStore();
  for (let index = 0; index < BRANCH_LIMITS.maximumBranches; index++) store.fork(`b${index}`, forkInput(`r${index}`));
  assert.throws(() => store.fork('extra', forkInput('x')), /branch: got "extra"; expected a name that is already a branch/);
  store.fork('b0', forkInput('replacement'));
  assert.throws(() => store.get('missing'), /branch: got "missing"; expected one of the known branches/);
  assert.throws(() => store.get('Bad Name'), TypeError);
  store.clear();
  assert.deepEqual(store.names(), []);
  assert.equal(store.snapshotCount(), 0);
});

test('label text is reduced to short printable ASCII', () => {
  assert.equal(printableLabel('lamp\nbody\u0000‮'), 'lamp?body??');
  assert.equal(printableLabel('x'.repeat(100)).length, 32);
});

test('review groups shots by branch and keeps the source shots together', () => {
  const normalized = normalizeReview({ sessionId: 's', expectedRevision: 0, labels: true,
    shots: [{ branch: 'warm' }, {}, { branch: 'cool', label: 'Cool' }, { branch: 'warm', camera: { eye: [1, 2, 3] } }] });
  assert.equal(normalized.labels, true);
  assert.deepEqual(normalized.branchNames, ['warm', 'cool']);
  assert.deepEqual(normalized.groups, [
    { branch: 'warm', shotIndexes: [0, 3] }, { branch: undefined, shotIndexes: [1] }, { branch: 'cool', shotIndexes: [2] }]);
  assert.equal(normalized.shots[0].label, 'warm');
  assert.equal(normalized.shots[2].label, 'Cool');
  assert.equal(normalizeReview({ sessionId: 's', expectedRevision: 0, shots: [{}] }).labels, false);
});

test('review rejects hostile branch names and branch shots that sample an imported clip', () => {
  const base = { sessionId: 's', expectedRevision: 0 };
  for (const name of hostileNames.filter(name => name !== undefined)) {
    assert.throws(() => normalizeReview({ ...base, shots: [{ branch: name }] }), TypeError, String(name));
  }
  assert.throws(() => normalizeReview({ ...base, shots: [{ branch: 'warm', animation: { clip: 0, time: 0 } }] }), /imported animation/);
  assert.throws(() => normalizeReview({ ...base, labels: 'yes', shots: [{}] }), /labels must be boolean/);
});
