import assert from 'node:assert/strict';
import test from 'node:test';
import { benchSummary, benchTotals } from '../bench/agent-modeling/bench-summary.mjs';
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
