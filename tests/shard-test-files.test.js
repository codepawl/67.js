import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { assignShards, medianOf } from '../scripts/shard-test-files.mjs';

const timings = { 'tests/a.test.js': 90, 'tests/b.test.js': 60, 'tests/c.test.js': 50, 'tests/d.test.js': 40, 'tests/e.test.js': 10 };
const names = Object.keys(timings);

test('timed files are dealt longest first to the lightest shard', () => {
  const shards = assignShards(names, timings, 2);
  const total = shard => names.filter(name => shards.get(name) === shard).reduce((sum, name) => sum + timings[name], 0);
  assert.equal(total(0), 130);
  assert.equal(total(1), 120);
  assert.deepEqual(assignShards(names, timings, 2), shards);
});

test('a file without a timing lands in one shard and moves no other file', () => {
  const before = assignShards(names, timings, 3);
  const after = assignShards([...names, 'tests/new.test.js'], timings, 3);
  assert.equal(after.size, names.length + 1);
  for (const name of names) assert.equal(after.get(name), before.get(name));
  assert.ok(after.get('tests/new.test.js') >= 0 && after.get('tests/new.test.js') < 3);
});

test('files without a timing go to the lightest shard by the median timing and never move a timed file', () => {
  const before = assignShards(names, timings, 2);
  const withNew = assignShards([...names, 'tests/new-a.test.js', 'tests/new-b.test.js'], timings, 2);
  for (const name of names) assert.equal(withNew.get(name), before.get(name));
  // Median timing is 50; shard 0 holds 130 and shard 1 holds 120, so the first new file goes to shard 1, the second to shard 0.
  assert.equal(withNew.get('tests/new-a.test.js'), 1);
  assert.equal(withNew.get('tests/new-b.test.js'), 0);
});

test('the hash option keeps untimed files on their name hash', () => {
  const first = assignShards([...names, 'tests/new.test.js'], timings, 3, { untimed: 'hash' });
  const second = assignShards([...names, 'tests/new.test.js', 'tests/other.test.js'], timings, 3, { untimed: 'hash' });
  assert.equal(first.get('tests/new.test.js'), second.get('tests/new.test.js'));
});

test('the median of repeated measurements is what the timings keep', () => {
  assert.equal(medianOf([300, 100, 200]), 200);
  assert.equal(medianOf([100, 200]), 150);
});

test('the workflow matrix and the shard count in its test command agree', () => {
  const workflow = readFileSync(new URL('../.github/workflows/test.yml', import.meta.url), 'utf8');
  const matrix = workflow.match(/shard: \[([\d, ]+)\]/)[1].split(',').map(Number);
  const count = Number(workflow.match(/shard-test-files\.mjs \$\{\{ matrix\.shard \}\} (\d+)/)[1]);
  assert.deepEqual(matrix, Array.from({ length: count }, (_, index) => index + 1));
});
