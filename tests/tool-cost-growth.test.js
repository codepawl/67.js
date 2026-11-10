import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readAcceptedBundles } from '../scripts/size-base.mjs';
import { budgetsFrom, ceilingProblems, compareCostsToBase, costAllowance, costsFrom, hardCeilingProblems } from '../scripts/tool-cost-growth.mjs';

const report = {
  schemaTotal: { bytes: 20000 },
  schemas: [{ name: 'scene_create', bytes: 12000 }, { name: 'scene_apply', bytes: 8000 }],
  results: [{ name: 'scene_capabilities', bytes: 300 }],
};

test('costs are named tool:<name>, tool-total and result:<name>', () => {
  assert.deepEqual(costsFrom(report), { 'tool-total': 20000, 'tool:scene_create': 12000, 'tool:scene_apply': 8000, 'result:scene_capabilities': 300 });
});

test('a tool gets 64 bytes, a result and the total 128', () => {
  assert.equal(costAllowance('tool:scene_create'), 64);
  assert.equal(costAllowance('result:scene_capabilities'), 128);
  assert.equal(costAllowance('tool-total'), 128);
});

test('a tool that grows past the allowance fails with the move advice and the accept instruction', () => {
  const { problems } = compareCostsToBase({ 'tool:scene_create': 700 }, { 'tool:scene_create': 600 });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /tool:scene_create grew by 100 bytes against the base branch \(600 to 700\), over its allowance of 64/);
  assert.match(problems[0], /Move rare detail into scene_capabilities or reference a shared schema/);
  assert.match(problems[0], /Reduce it, or accept it: add changes\/<issue>\.size\.md/);
  assert.match(problems[0], /- tool:scene_create: <why it is worth the bytes>/);
});

test('growth inside the allowance, a shrink and a new cost pass', () => {
  const measured = { 'tool:scene_create': 664, 'tool:scene_apply': 300, 'tool:fresh': 90 };
  const base = { 'tool:scene_create': 600, 'tool:scene_apply': 400 };
  const { rows, problems } = compareCostsToBase(measured, base);
  assert.deepEqual(problems, []);
  assert.deepEqual(rows.map(row => row.growth), [64, -100, null]);
});

test('a note accepts only the costs it names', () => {
  const measured = { 'tool-total': 1500, 'tool:scene_create': 700, 'result:scene_capabilities': 600 };
  const base = { 'tool-total': 1000, 'tool:scene_create': 600, 'result:scene_capabilities': 300 };
  const accepted = new Map([['tool:scene_create', 'a new field'], ['tool-total', 'the same field']]);
  const { problems } = compareCostsToBase(measured, base, accepted);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /result:scene_capabilities grew by 300/);
});

test('release ceilings are listed as problems, and a release resets them', () => {
  const budgets = { schemaTotalBytes: 19000, schemaToolBytes: { scene_create: 12500 }, schemaOtherToolBytes: 4000, resultBytes: { scene_capabilities: 320 } };
  const measured = costsFrom(report);
  const problems = ceilingProblems(measured, budgets);
  assert.equal(problems.length, 2);
  assert.match(problems[0], /tool-total is 20000 bytes, over its release ceiling of 19000 by 1000/);
  assert.match(problems[1], /tool:scene_apply is 8000 bytes, over its release ceiling of 4000 by 4000/);
  const reset = budgetsFrom(measured, budgets);
  assert.deepEqual(ceilingProblems(measured, reset), []);
  assert.equal(reset.schemaOtherToolBytes, 4000);
});

test('absolute ceilings fail the total, a large tool, any other tool and the default capabilities answer', () => {
  const ceilings = { schemaTotalBytes: 19000, schemaToolBytes: { scene_create: 12500 }, schemaOtherToolBytes: 7000, resultBytes: { scene_capabilities: 250 } };
  const problems = hardCeilingProblems(costsFrom(report), ceilings);
  assert.equal(problems.length, 2 + 1);
  assert.match(problems[0], /tool-total is 20000 bytes, over its absolute ceiling of 19000 by 1000/);
  assert.match(problems[1], /tool:scene_apply is 8000 bytes, over its absolute ceiling of 7000 by 1000/);
  assert.match(problems[2], /result:scene_capabilities is 300 bytes, over its absolute ceiling of 250 by 50/);
  assert.deepEqual(hardCeilingProblems(costsFrom(report), { ...ceilings, schemaTotalBytes: 20000, schemaOtherToolBytes: 8000, resultBytes: {} }), []);
});

function runGit(folder, ...args) {
  const identity = ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false'];
  const result = spawnSync('git', [...identity, ...args], { cwd: folder, encoding: 'utf8' });
  assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr}`);
  return result.stdout;
}

function commitFile(folder, path, text, message) {
  mkdirSync(join(folder, path, '..'), { recursive: true });
  writeFileSync(join(folder, path), text);
  runGit(folder, 'add', '.');
  runGit(folder, 'commit', '-q', '-m', message);
}

test('two pull requests that grow different tools merge in sequence and neither touches the shared budget file', () => {
  const folder = mkdtempSync(join(tmpdir(), 'tool-cost-sim-'));
  try {
    runGit(folder, 'init', '-q', '-b', 'main');
    commitFile(folder, 'bench/tool-cost-budgets.json', '{\n  "schemaTotalBytes": 1000\n}\n', 'budgets');
    commitFile(folder, 'src/create.js', 'export const create = 1;\n', 'create');
    commitFile(folder, 'src/apply.js', 'export const apply = 1;\n', 'apply');
    runGit(folder, 'update-ref', 'refs/remotes/origin/main', 'HEAD');

    runGit(folder, 'checkout', '-q', '-b', 'grow-create');
    commitFile(folder, 'src/create.js', 'export const create = 2;\n', 'grow create');
    commitFile(folder, 'changes/301.size.md', '- tool:scene_create: a new field\n- tool-total: the same field\n', 'accept create');
    runGit(folder, 'checkout', '-q', 'main');
    runGit(folder, 'checkout', '-q', '-b', 'grow-apply');
    commitFile(folder, 'src/apply.js', 'export const apply = 2;\n', 'grow apply');
    commitFile(folder, 'changes/302.size.md', '- tool:scene_apply: a new field\n- result:scene_capabilities: its notes\n', 'accept apply');

    assert.deepEqual([...readAcceptedBundles('origin/main', folder).keys()], ['tool:scene_apply', 'result:scene_capabilities']);
    runGit(folder, 'checkout', '-q', 'grow-create');
    assert.deepEqual([...readAcceptedBundles('origin/main', folder).keys()], ['tool:scene_create', 'tool-total']);

    runGit(folder, 'checkout', '-q', 'main');
    runGit(folder, 'merge', '-q', '--no-ff', '-m', 'merge create', 'grow-create');
    runGit(folder, 'merge', '-q', '--no-ff', '-m', 'merge apply', 'grow-apply');
    const touched = runGit(folder, 'diff', '--name-only', 'origin/main', 'HEAD');
    assert.equal(touched.includes('bench/tool-cost-budgets.json'), false);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
