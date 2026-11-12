import test from 'node:test';
import assert from 'node:assert/strict';
import { compareWithBaseline, mergeLcov, totalsOf } from '../scripts/coverage-gate.mjs';

const baseline = { lines: 90, branches: 80, functions: 90 };

function verdicts(percentages) {
  return Object.fromEntries(compareWithBaseline(percentages, baseline).map(result => [result.metric, result.ok]));
}

test('branch coverage may wander by run-to-run noise without failing the gate', () => {
  assert.deepEqual(verdicts({ lines: 90, branches: 78.6, functions: 90 }), { lines: true, branches: true, functions: true });
});

test('a real drop fails each metric past its own allowance', () => {
  assert.deepEqual(verdicts({ lines: 89.4, branches: 78.4, functions: 89.4 }), { lines: false, branches: false, functions: false });
});

test('unnamed functions merge by line, since each shard numbers them on its own', () => {
  const firstShard = ['SF:src/example.js', 'FN:10,anonymous_1', 'FN:20,anonymous_2', 'FN:30,named', 'FNDA:3,anonymous_1', 'FNDA:0,anonymous_2', 'FNDA:1,named', 'end_of_record'].join('\n');
  const secondShard = ['SF:src/example.js', 'FN:20,anonymous_1', 'FN:30,named', 'FNDA:0,anonymous_1', 'FNDA:0,named', 'end_of_record'].join('\n');
  const { totals } = totalsOf(mergeLcov([firstShard, secondShard]));
  assert.deepEqual(totals.functions, [2, 3]);
});

test('a function hit in only one shard counts as covered', () => {
  const firstShard = ['SF:src/example.js', 'FN:10,anonymous_4', 'FNDA:0,anonymous_4', 'end_of_record'].join('\n');
  const secondShard = ['SF:src/example.js', 'FN:10,anonymous_9', 'FNDA:2,anonymous_9', 'end_of_record'].join('\n');
  const { totals } = totalsOf(mergeLcov([firstShard, secondShard]));
  assert.deepEqual(totals.functions, [1, 1]);
});

// Real V8 shards number the blocks of a file in the order they report them, so one branch carries different block ids in
// different shards and a shard that never runs a function reports it as a single range.
const branchShardA = ['SF:src/example.js', 'BRDA:10,0,0,4', 'BRDA:10,1,0,0', 'BRDA:20,2,0,1', 'end_of_record'].join('\n');
const branchShardB = ['SF:src/example.js', 'BRDA:5,0,0,0', 'BRDA:10,1,0,0', 'BRDA:10,2,0,2', 'BRDA:20,3,0,0', 'end_of_record'].join('\n');
const branchShardC = ['SF:src/example.js', 'BRDA:10,7,0,0', 'end_of_record'].join('\n');

test('a branch counts once however the shards number their blocks', () => {
  const { totals } = totalsOf(mergeLcov([branchShardA, branchShardB, branchShardC]));
  assert.deepEqual(totals.branches, [3, 4]);
});

test('the branch total does not depend on how the same shards are grouped', () => {
  const allApart = totalsOf(mergeLcov([branchShardA, branchShardB, branchShardC])).totals.branches;
  const together = totalsOf(mergeLcov([[branchShardA, branchShardB].join('\n'), branchShardC])).totals.branches;
  assert.deepEqual(allApart, together);
});
