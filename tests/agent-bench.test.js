import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { benchSummary, benchTotals } from '../bench/agent-modeling/bench-summary.mjs';
import { classifyZeroCalls } from '../bench/agent-modeling/zero-calls.mjs';
import { compareBench } from '../bench/agent-modeling/compare-bench.mjs';
import { gradeRecipe } from '../bench/agent-modeling/check.mjs';
import { REFERENCES } from '../bench/agent-modeling/references.mjs';
import { BENCH_TASKS, SMOKE_TASKS } from '../bench/agent-modeling/suite.mjs';
import { taskById } from '../bench/agent-modeling/tasks.mjs';

const failedKinds = grade => grade.results.filter(result => !result.pass).map(result => result.label ?? result.kind);

test('the bench has 20 to 30 tasks, each known to the suite, covering every kind of work', () => {
  assert.ok(BENCH_TASKS.length >= 20 && BENCH_TASKS.length <= 30, `${BENCH_TASKS.length} tasks`);
  assert.equal(new Set(BENCH_TASKS.map(task => task.id)).size, BENCH_TASKS.length);
  for (const { id } of BENCH_TASKS) assert.ok(taskById(id).checks.length > 0, id);
  for (const id of SMOKE_TASKS) assert.ok(BENCH_TASKS.some(task => task.id === id), id);
  const kinds = new Set(BENCH_TASKS.map(task => task.kind));
  for (const kind of ['modeling', 'scene', 'look', 'light', 'camera', 'animation', 'film']) assert.ok(kinds.has(kind), kind);
});

test('the camera, light, look and film tasks reject plausible wrong answers', async () => {
  const wrong = (id, change) => {
    const recipe = structuredClone(REFERENCES[id]);
    change(recipe);
    return gradeRecipe(taskById(id), recipe);
  };
  assert.deepEqual(failedKinds(await wrong('camera-closeup', recipe => { recipe.camera.eye = [6, 4, 8]; })), ['cameraAims']);
  assert.deepEqual(failedKinds(await wrong('camera-closeup', recipe => { recipe.camera.target = [3, 1, 0]; })), ['cameraAims']);
  assert.deepEqual(failedKinds(await wrong('camera-orbit', recipe => { recipe.motion.tracks[0].keyframes.length = 4; })), ['cameraOrbit']);
  assert.deepEqual(failedKinds(await wrong('camera-orbit', recipe => { delete recipe.motion; })), ['cameraOrbit']);
  assert.deepEqual(failedKinds(await wrong('light-spot-shadow', recipe => { recipe.environment.spotLights[0].castShadow = false; })), ['one shadow spot above, aimed at the statue']);
  assert.deepEqual(failedKinds(await wrong('light-spot-shadow', recipe => { recipe.environment.spotLights[0].direction = [1, 0, 0]; })), ['one shadow spot above, aimed at the statue']);
  assert.deepEqual(failedKinds(await wrong('light-key-fill', recipe => { recipe.environment.pointLights[0].color = [1, 0.5, 0.3]; })), ['cool point fill on the right']);
  assert.deepEqual(failedKinds(await wrong('look-metal', recipe => { recipe.materials[1].metallic = 0; })), ['polished gold on the statue']);
  assert.deepEqual(failedKinds(await wrong('look-fog', recipe => { recipe.environment.fogDensity = 0.001; })), ['thin fog']);
  assert.deepEqual(failedKinds(await wrong('sunset-timelapse', recipe => { recipe.motion.tracks[1].keyframes[1].value = [1, 1, 1]; })), ['sun colour gets warmer']);
  assert.deepEqual(failedKinds(await wrong('film-reveal', recipe => { recipe.motion.tracks[0].keyframes[1].value = [0, 3, 9]; })), ['cameraDolly']);
  assert.deepEqual(failedKinds(await wrong('film-reveal', recipe => { recipe.motion.tracks.pop(); })), ['exposure fades up']);
});

const record = (task, pass, extra = {}) => ({ task, pass, toolCalls: 10, toolErrors: 1, inputTokens: 1000, outputTokens: 100, wallSeconds: 30, ...extra });

test('pass@1 is the share of runs that pass, pass^k needs every run of a task to pass', () => {
  const records = [
    record('crate', true), record('crate', true), record('crate', true),
    record('bolt', true), record('bolt', false), record('bolt', true),
    record('mug', false), record('mug', false), record('mug', false),
  ];
  const totals = benchTotals(records, 3);
  assert.equal(totals.passAt1, 0.556);
  assert.equal(totals.passPowK, 0.333);
  assert.equal(totals.passAtK, 0.667);
  assert.equal(totals.callsPerRun, 10);
  assert.equal(totals.secondsPerRun, 30);
});

test('a task with fewer runs than k does not count toward pass^k', () => {
  assert.equal(benchTotals([record('crate', true), record('crate', true)], 3).passPowK, 0);
});

test('the summary groups by model and kind, and the comparison flags a pass@1 drop and the tasks that moved', () => {
  const baselineRecords = { haiku: [record('crate', true), record('crate', true), record('look-fog', true), record('look-fog', false)] };
  const candidateRecords = { haiku: [record('crate', true), record('crate', false), record('look-fog', false), record('look-fog', false)] };
  const baseline = { summary: benchSummary(baselineRecords, 2) };
  const candidate = { summary: benchSummary(candidateRecords, 2) };
  assert.equal(baseline.summary.haiku.kinds.look.passAt1, 0.5);
  const result = compareBench(baseline, candidate);
  assert.equal(result.regressed, true);
  assert.match(result.text, /REGRESSION/);
  assert.match(result.text, /crate: 2\/2 -> 1\/2 \(-1\)/);
  assert.equal(compareBench(baseline, baseline).regressed, false);
});

test('the run guard counts each streamed message once and kills a run over its budget', async () => {
  const { createRunGuard, estimateUsageCostUsd } = await import('../bench/agent-modeling/run-guard.mjs');
  assert.equal(estimateUsageCostUsd({ input_tokens: 1e6, output_tokens: 1e6 }, 'claude-haiku-4-5'), 6);
  assert.equal(estimateUsageCostUsd({ cache_read_input_tokens: 1e6 }, 'sonnet'), 0.3);
  let kills = 0;
  const child = { kill: () => { kills++; } };
  const guard = createRunGuard({ child, model: 'haiku', budgetUsd: 0.9, timeoutSeconds: 60 });
  const event = JSON.stringify({ type: 'assistant', message: { id: 'a', usage: { output_tokens: 100000 } } });
  guard.feed(`${event}\n${event}\n{"type":"assis`);
  assert.equal(kills, 0, 'the same message id repeated is one message');
  assert.equal(guard.estimatedCostUsd, 0.5);
  guard.feed(`tant","message":{"id":"b","usage":{"output_tokens":100000}}}\n`);
  assert.equal(kills, 1);
  assert.equal(guard.reason, 'budget');
  guard.stop();
});

test('the run guard kills a run that reaches its time limit', async () => {
  const { createRunGuard } = await import('../bench/agent-modeling/run-guard.mjs');
  let kills = 0;
  const guard = createRunGuard({ child: { kill: () => { kills++; } }, model: 'haiku', budgetUsd: 1, timeoutSeconds: 0.01 });
  await new Promise(resolveWait => setTimeout(resolveWait, 60));
  assert.equal(kills, 1);
  assert.equal(guard.reason, 'timeout');
});

const readFixture = name => readFileSync(new URL(`./fixtures/agent-bench/${name}.jsonl`, import.meta.url), 'utf8');

test('a run with 0 scene calls is classified by cause: infra for start-up, server and empty ToolSearch, model for the rest', () => {
  const classify = (name, options = {}) => classifyZeroCalls(readFixture(name), { exitCode: 0, toolCalls: 0, ...options });
  assert.equal(classify('with-scene-calls', { toolCalls: 1 }), null);
  assert.deepEqual(classify('no-init', { exitCode: 1, errors: 'spawn failed\nmore' }), { kind: 'infra', cause: 'start-up-failure', detail: 'spawn failed' });
  assert.equal(classify('mcp-server-failed').cause, 'mcp-server-failed');
  assert.equal(classify('mcp-server-failed').kind, 'infra');
  assert.equal(classify('no-result', { exitCode: 1 }).cause, 'start-up-failure');
  assert.equal(classify('no-result', { exitCode: null }).cause, 'timeout');
  assert.equal(classify('toolsearch-empty').cause, 'toolsearch-empty');
  assert.equal(classify('toolsearch-empty').kind, 'infra');
});

test('a ToolSearch that showed the 67js tools and then quit, a refusal and a no-tool answer are model failures', () => {
  const classify = name => classifyZeroCalls(readFixture(name), { exitCode: 0, toolCalls: 0 });
  assert.deepEqual([classify('toolsearch-then-quit').kind, classify('toolsearch-then-quit').cause], ['model', 'toolsearch-then-quit']);
  assert.deepEqual([classify('refusal').kind, classify('refusal').cause], ['model', 'refusal']);
  assert.deepEqual([classify('no-tool-use').kind, classify('no-tool-use').cause], ['model', 'no-tool-use']);
});

test('infra runs stay out of pass@1 and are reported by cause; model zero-call runs stay counted and are labelled', () => {
  const infraRecord = cause => record('crate', false, { toolCalls: 0, infra: true, zeroCalls: { kind: 'infra', cause } });
  const quitRecord = record('bolt', false, { toolCalls: 0, infra: false, zeroCalls: { kind: 'model', cause: 'toolsearch-then-quit' } });
  const totals = benchTotals([record('crate', true), infraRecord('mcp-server-failed'), infraRecord('timeout'), record('bolt', true), quitRecord], 2);
  assert.equal(totals.runs, 3);
  assert.equal(totals.passAt1, 0.667);
  assert.equal(totals.infraRuns, 2);
  assert.deepEqual(totals.infraByCause, { 'mcp-server-failed': 1, timeout: 1 });
  assert.deepEqual(totals.modelZeroCalls, { 'toolsearch-then-quit': 1 });
  assert.equal(totals.infraShare, 0.4);
  assert.equal(totals.passPowK, 0.5);
  assert.equal(benchSummary({ haiku: [record('crate', true), infraRecord('timeout')] }, 2).haiku.taskResults.crate.infra, 1);
});

test('the comparison prints infra counts next to pass@1 and flags infra above the bound', () => {
  const infraRecord = record('crate', false, { toolCalls: 0, infra: true, zeroCalls: { kind: 'infra', cause: 'timeout' } });
  const clean = { summary: benchSummary({ haiku: [record('crate', true), record('crate', true), record('bolt', true), record('bolt', true)] }, 2) };
  const noisy = { summary: benchSummary({ haiku: [record('crate', true), infraRecord, record('bolt', true), record('bolt', true)] }, 2) };
  const result = compareBench(clean, noisy);
  assert.equal(result.regressed, false);
  assert.equal(result.tooMuchInfra, true);
  assert.match(result.text, /haiku: infra 0 -> 1 runs {2}INFRA over 10% of runs; pass@1 100% -> 100%/);
  assert.match(result.text, /candidate infra runs \(not in pass@1\): 1 \(timeout 1\)/);
  assert.equal(compareBench(clean, noisy, 0.05, 0.5).tooMuchInfra, false);
});
