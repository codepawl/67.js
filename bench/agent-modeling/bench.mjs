// The agent bench in one command: every task in suite.mjs, k runs each, on each model, through headless
// `claude -p` with the 67js MCP config (run.mjs does the per-run work: clean temp folder, MCP server only, grader).
// Runs use the Claude Code subscription, so the summary has tokens, calls and time and never dollars.
//
// node bench/agent-modeling/bench.mjs --claude <claude executable> --models haiku,sonnet,opus --runs 3 --label baseline
//   [--tasks crate,look-fog] [--smoke] [--backend gpu|cpu] [--budget 3] [--timeout 1200] [--resume]
//
// --smoke runs the two smoke tasks once. --resume continues the same label (same models, same --runs): attempts already
// recorded are skipped. The summary goes to bench/agent-modeling/results/bench-<label>.json and holds the per-run records
// of every model, so `compare-bench.mjs` can diff it against another bench file.
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { benchSummary, formatSummaryTable } from './bench-summary.mjs';
import { BENCH_TASKS, SMOKE_TASKS } from './suite.mjs';

const resultsDirectory = join(resolve(import.meta.dirname), 'results');

const { values: options } = parseArgs({
  options: {
    claude: { type: 'string', default: process.env.CLAUDE_EXECUTABLE ?? 'claude' },
    models: { type: 'string', default: 'haiku,sonnet,opus' },
    runs: { type: 'string', default: '3' },
    label: { type: 'string', default: 'bench' },
    tasks: { type: 'string' },
    smoke: { type: 'boolean', default: false },
    backend: { type: 'string', default: 'gpu' },
    budget: { type: 'string', default: '3' },
    timeout: { type: 'string', default: '1200' },
    resume: { type: 'boolean', default: false },
  },
});

const runs = options.smoke ? 1 : Number(options.runs);
if (!Number.isInteger(runs) || runs < 1) throw new RangeError('--runs must be a whole number from 1');
const taskIds = options.tasks ? options.tasks.split(',') : options.smoke ? SMOKE_TASKS : BENCH_TASKS.map(task => task.id);
const models = options.models.split(',');
const benchName = options.smoke ? `smoke-${options.label}` : options.label;

function runModel(model) {
  const runName = `bench-${benchName}-${model}`;
  const argumentsList = [
    join(import.meta.dirname, 'run.mjs'),
    '--claude', options.claude, '--model', model, '--tasks', taskIds.join(','), '--runs', String(runs),
    '--backend', options.backend, '--budget', options.budget, '--timeout', options.timeout,
    '--label', benchName, '--run-name', runName,
    ...(options.resume ? ['--resume', runName] : []),
  ];
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, argumentsList, { stdio: 'inherit', windowsHide: true });
    child.on('error', reject);
    child.on('close', async code => {
      if (code !== 0) return reject(new Error(`run.mjs for ${model} exited with ${code}`));
      const summary = JSON.parse(await readFile(join(resultsDirectory, `${runName}.json`), 'utf8'));
      // The session's cost estimate is not what a subscription run costs, so the bench file leaves it out.
      resolvePromise(summary.records.map(({ costUsd, ...record }) => record));
    });
  });
}

await mkdir(resultsDirectory, { recursive: true });
const recordsByModel = {};
for (const model of models) {
  console.log(`\n== ${model}: ${taskIds.length} tasks x ${runs} runs ==`);
  recordsByModel[model] = await runModel(model);
}

const summary = benchSummary(recordsByModel, runs);
const benchFile = join(resultsDirectory, `bench-${benchName}.json`);
await writeFile(benchFile, `${JSON.stringify({ bench: benchName, date: new Date().toISOString(), runsPerTask: runs, tasks: taskIds, backend: options.backend, summary, recordsByModel }, null, 2)}\n`);
console.log(`\n${formatSummaryTable(summary, runs)}\n\nBench file: bench/agent-modeling/results/bench-${benchName}.json`);
