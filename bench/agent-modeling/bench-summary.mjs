// The bench's summary numbers. Runs go through Claude Code on a subscription, so cost is never reported in dollars:
// the figures are success, tool calls, tokens and wall time.
//   pass@1  average success rate over every run (the chance one try works)
//   pass^k  share of tasks that passed on all k runs (the chance an agent can be relied on)
//   pass@k  share of tasks that passed on at least one of the k runs
import { kindOf } from './suite.mjs';

const mean = (values, digits = 1) => (values.length ? Number((values.reduce((total, value) => total + value, 0) / values.length).toFixed(digits)) : null);

function groupBy(records, keyOf) {
  const groups = new Map();
  for (const record of records) {
    const key = keyOf(record);
    groups.set(key, [...(groups.get(key) ?? []), record]);
  }
  return groups;
}

/** Numbers for a group of records that belong to tasks run `runs` times each. */
export function benchTotals(records, runs) {
  const perTask = [...groupBy(records, record => record.task).values()];
  const everyRun = perTask.filter(own => own.length >= runs && own.every(record => record.pass));
  const anyRun = perTask.filter(own => own.some(record => record.pass));
  const share = count => (perTask.length ? Number((count / perTask.length).toFixed(3)) : null);
  return {
    tasks: perTask.length,
    runs: records.length,
    passAt1: records.length ? Number((records.filter(record => record.pass).length / records.length).toFixed(3)) : null,
    passPowK: share(everyRun.length),
    passAtK: share(anyRun.length),
    callsPerRun: mean(records.map(record => record.toolCalls)),
    errorsPerRun: mean(records.map(record => record.toolErrors)),
    inputTokensPerRun: mean(records.map(record => record.inputTokens), 0),
    outputTokensPerRun: mean(records.map(record => record.outputTokens), 0),
    secondsPerRun: mean(records.map(record => record.wallSeconds)),
  };
}

/** Totals for the model, by kind of task and by task. `byModel` maps a requested model alias to its records. */
export function benchSummary(byModel, runs) {
  return Object.fromEntries(Object.entries(byModel).map(([model, records]) => [model, {
    ...benchTotals(records, runs),
    kinds: Object.fromEntries([...groupBy(records, record => kindOf[record.task] ?? 'other')].map(([kind, own]) => [kind, benchTotals(own, runs)])),
    taskResults: Object.fromEntries([...groupBy(records, record => record.task)].map(([task, own]) => [task, { passed: own.filter(record => record.pass).length, runs: own.length }])),
  }]));
}

const percent = value => (value === null ? '?' : `${Math.round(value * 100)}%`);

export function formatSummaryTable(summary, runs) {
  const header = ['model', 'tasks', 'runs', 'pass@1', `pass^${runs}`, `any of ${runs}`, 'calls/run', 'tokens in/run', 'tokens out/run', 'seconds/run'];
  const rows = Object.entries(summary).map(([model, totals]) => [
    model, totals.tasks, totals.runs, percent(totals.passAt1), percent(totals.passPowK), percent(totals.passAtK),
    totals.callsPerRun, totals.inputTokensPerRun, totals.outputTokensPerRun, totals.secondsPerRun,
  ].map(String));
  const widths = header.map((title, column) => Math.max(title.length, ...rows.map(row => row[column].length)));
  const line = cells => cells.map((cell, column) => cell.padEnd(widths[column])).join('  ');
  const kindLines = Object.entries(summary).flatMap(([model, totals]) => [
    `${model} by kind: ${Object.entries(totals.kinds).map(([kind, own]) => `${kind} ${percent(own.passAt1)}`).join(', ')}`,
  ]);
  return [line(header), ...rows.map(line), '', ...kindLines].join('\n');
}
