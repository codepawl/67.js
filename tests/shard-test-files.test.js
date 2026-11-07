import assert from 'node:assert/strict';
import test from 'node:test';
import { assignShards } from '../scripts/shard-test-files.mjs';

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
