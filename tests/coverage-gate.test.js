import test from 'node:test';
import assert from 'node:assert/strict';
import { compareWithBaseline } from '../scripts/coverage-gate.mjs';

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
