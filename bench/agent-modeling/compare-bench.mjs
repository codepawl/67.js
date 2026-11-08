// Compare a candidate bench file against a baseline bench file, per model that appears in both:
//
// node bench/agent-modeling/compare-bench.mjs <baseline bench file> <candidate bench file> [--tolerance 0.05]
//
// Prints pass@1, pass^k, calls and tokens per run side by side, then the tasks whose pass count changed. Exits with 1
// when a model's pass@1 drops by more than the tolerance (default 0.05). With k runs per task, a swing of one run on
// one task is noise: judge a branch by the totals and by tasks that moved by two runs or more.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const percent = value => (value === null || value === undefined ? '?' : `${Math.round(value * 100)}%`);
const signed = value => (value > 0 ? `+${value}` : String(value));

/** Differences per model: totals side by side and the tasks whose passes changed. */
export function compareBench(baseline, candidate, tolerance = 0.05) {
  const lines = [];
  let regressed = false;
  for (const model of Object.keys(baseline.summary).filter(name => name in candidate.summary)) {
    const before = baseline.summary[model];
    const after = candidate.summary[model];
    const drop = Number(((before.passAt1 ?? 0) - (after.passAt1 ?? 0)).toFixed(3));
    if (drop > tolerance) regressed = true;
    lines.push(`${model}: pass@1 ${percent(before.passAt1)} -> ${percent(after.passAt1)}${drop > tolerance ? '  REGRESSION' : ''}, pass^k ${percent(before.passPowK)} -> ${percent(after.passPowK)}, calls/run ${before.callsPerRun} -> ${after.callsPerRun}, tokens in/run ${before.inputTokensPerRun} -> ${after.inputTokensPerRun}, tokens out/run ${before.outputTokensPerRun} -> ${after.outputTokensPerRun}`);
    const tasks = new Set([...Object.keys(before.taskResults), ...Object.keys(after.taskResults)]);
    for (const task of tasks) {
      const passedBefore = before.taskResults[task]?.passed ?? 0;
      const passedAfter = after.taskResults[task]?.passed ?? 0;
      if (passedBefore !== passedAfter) lines.push(`  ${task}: ${passedBefore}/${before.taskResults[task]?.runs ?? 0} -> ${passedAfter}/${after.taskResults[task]?.runs ?? 0} (${signed(passedAfter - passedBefore)})`);
    }
  }
  return { regressed, text: lines.join('\n') || 'No model appears in both files.' };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { tolerance: { type: 'string', default: '0.05' } } });
  const [baselinePath, candidatePath] = positionals;
  const [baseline, candidate] = await Promise.all([baselinePath, candidatePath].map(async path => JSON.parse(await readFile(path, 'utf8'))));
  const result = compareBench(baseline, candidate, Number(values.tolerance));
  console.log(result.text);
  process.exitCode = result.regressed ? 1 : 0;
}
