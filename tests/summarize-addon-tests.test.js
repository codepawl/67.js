import assert from 'node:assert/strict';
import test from 'node:test';
import { countTapTests, formatSummary } from '../scripts/summarize-addon-tests.mjs';

const REPORT = `TAP version 13
# Subtest: a suite
    # Subtest: leaf one
    ok 1 - leaf one
      ---
      duration_ms: 1
      ...
    # Subtest: leaf two
    ok 2 - leaf two # SKIP the native addon is not built
    # Subtest: leaf three
    not ok 3 - leaf three
ok 1 - a suite
ok 2 - lone test # SKIP the native addon is not built
ok 3 - other # SKIP no ray query adapter
`;

test('countTapTests counts leaf tests and groups skip reasons', () => {
  const counts = countTapTests(REPORT);
  assert.equal(counts.passed, 1);
  assert.equal(counts.failed, 1);
  assert.equal(counts.skipped, 3);
  assert.equal(counts.skipReasons.get('the native addon is not built'), 2);
  assert.equal(counts.skipReasons.get('no ray query adapter'), 1);
});

test('formatSummary names the skip reasons, most common first', () => {
  const text = formatSummary(countTapTests(REPORT), 'Title');
  assert.match(text, /### Title/);
  assert.match(text, /\| skipped \| 3 \|/);
  assert.ok(text.indexOf('2 x the native addon') < text.indexOf('1 x no ray query'));
});
