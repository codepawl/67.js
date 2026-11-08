import { test } from 'node:test';
import assert from 'node:assert/strict';
import { manualChecksFor, planChecks } from '../scripts/preflight.mjs';

function checkNamed(checks, name) {
  return checks.find(check => check.name === name);
}

test('a docs-only change runs the link check and skips the code gates', () => {
  const checks = planChecks(['docs/guide.md']);
  assert.equal(checkNamed(checks, 'links').skipped, null);
  assert.match(checkNamed(checks, 'size').skipped, /no shipped code/);
  assert.match(checkNamed(checks, 'tool cost').skipped, /no MCP tool code/);
  assert.match(checkNamed(checks, 'change note').skipped, /no change under/);
});

test('a source change without a change note fails the note check', () => {
  const checks = planChecks(['src/camera.js']);
  assert.match(checkNamed(checks, 'change note').failure, /changes\/<issue>\.md/);
  assert.equal(checkNamed(checks, 'size').skipped, null);
});

test('a size note alone does not count as a change note', () => {
  const checks = planChecks(['src/camera.js', 'changes/700.size.md']);
  assert.ok(checkNamed(checks, 'change note').failure);
  const withNote = planChecks(['src/camera.js', 'changes/700.size.md', 'changes/700.md']);
  assert.equal(checkNamed(withNote, 'change note').failure, null);
});

test('editing a protected file fails with the alternative', () => {
  const checks = planChecks(['CHANGELOG.md', 'bench/size/budgets.json']);
  const failure = checkNamed(checks, 'protected files').failure;
  assert.match(failure, /CHANGELOG\.md: Add a changes/);
  assert.match(failure, /budgets\.json: Accept a size increase/);
});

test('MCP tool code runs the schema and tool cost checks', () => {
  const checks = planChecks(['src\\agent-scene.js', 'changes/700.md']);
  assert.equal(checkNamed(checks, 'tool schemas').skipped, null);
  assert.equal(checkNamed(checks, 'tool cost').skipped, null);
});

test('--skip-tests skips the build, the tests and the coverage gate', () => {
  const checks = planChecks(['src/camera.js'], { skipTests: true });
  for (const name of ['build library', 'unit tests and coverage', 'coverage gate']) {
    assert.match(checkNamed(checks, name).skipped, /--skip-tests/);
  }
});

test('manual GPU checks are pointed out by the files they cover', () => {
  const commands = manualChecksFor(['src/cascaded-shadows.js', 'src/gltf-loader.js']).map(check => check.command);
  assert.deepEqual(commands, ['npm run reference', 'npm run smoke:character']);
  assert.deepEqual(manualChecksFor(['docs/guide.md']), []);
});
