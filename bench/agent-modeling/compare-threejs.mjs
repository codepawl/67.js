// Joins one 67js run (run.mjs) and one three.js run (threejs.mjs) into the comparison file of issue #31 and prints
// the markdown tables.
// node bench/agent-modeling/compare-threejs.mjs <67js run json> <three.js run json> <output json> [--pairwise <pairwise-judge result json>]
// With --pairwise it also prints wins per system, the exact binomial p and the position-bias control of pairwise-judge.mjs.
import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { pairwiseTable } from './pairwise-judge.mjs';

const { values: options, positionals } = parseArgs({ allowPositionals: true, options: { pairwise: { type: 'string' } } });
const [mcpPath, codePath, outputPath] = positionals;
const mcpRun = JSON.parse(await readFile(mcpPath, 'utf8'));
// The three.js run may be split over several files (comma separated) when a run was stopped and the rest redone.
const codeRuns = await Promise.all(codePath.split(',').map(async path => JSON.parse(await readFile(path, 'utf8'))));
const codeRun = { ...codeRuns[0], records: codeRuns.flatMap(run => run.records) };

const SYSTEMS = [
  { name: '67js MCP', run: mcpRun },
  { name: 'three.js by code', run: codeRun },
];
const records = SYSTEMS.flatMap(({ name, run }) => run.records.map(record => ({ system: name, ...record })));

const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length;
const lookOf = record => record.look?.silhouette?.mean ?? null;
const tokensOf = record => record.inputTokens + record.outputTokens;
const thousands = value => `${Math.round(value / 1000)}k`;

// Records from before fix rounds were counted have none; a mean needs every record to carry one.
const fixRoundsOf = own => (own.every(record => typeof record.fixRounds === 'number') ? Number(mean(own.map(record => record.fixRounds)).toFixed(1)) : null);

const taskIds = [...new Set(records.map(record => record.task))];
const lines = ['| Task | System | Pass | Tool calls | Tool errors | Fix rounds | Tokens in / out | Look | Failures |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- |'];
for (const task of taskIds) {
  for (const { name } of SYSTEMS) {
    const record = records.find(candidate => candidate.task === task && candidate.system === name);
    lines.push(`| ${task} | ${name} | ${record.pass ? 'yes' : 'no'} (${record.passed}/${record.total}) | ${record.toolCalls} | ${record.toolErrors} | ${record.fixRounds ?? '-'} | ${thousands(record.inputTokens)} / ${thousands(record.outputTokens)} | ${lookOf(record)?.toFixed(3) ?? '-'} | ${record.failed.join('; ') || '-'} |`);
  }
}
const totals = ['| System | Pass | Mean tool calls | Mean fix rounds | Mean tokens | Mean look | Mean wall seconds |', '| --- | --- | --- | --- | --- | --- | --- |'];
const summary = {};
for (const { name } of SYSTEMS) {
  const own = records.filter(record => record.system === name);
  const looks = own.map(lookOf).filter(value => value !== null);
  summary[name] = {
    runs: own.length,
    passed: own.filter(record => record.pass).length,
    meanToolCalls: Number(mean(own.map(record => record.toolCalls)).toFixed(1)),
    meanFixRounds: fixRoundsOf(own),
    meanTokens: Math.round(mean(own.map(tokensOf))),
    meanLook: Number(mean(looks).toFixed(3)),
    meanWallSeconds: Math.round(mean(own.map(record => record.wallSeconds))),
  };
  const row = summary[name];
  totals.push(`| ${name} | ${row.passed}/${row.runs} | ${row.meanToolCalls} | ${row.meanFixRounds ?? '-'} | ${thousands(row.meanTokens)} | ${row.meanLook} | ${row.meanWallSeconds} |`);
}

const pairwise = options.pairwise ? JSON.parse(await readFile(options.pairwise, 'utf8')) : null;
const output = {
  run: '2026-11-07-threejs-vs-67js',
  issue: 31,
  model: mcpRun.model,
  date: new Date().toISOString(),
  scope: 'three.js half and 67js MCP side; the official Blender MCP half needs a VM and is not run',
  threeVersion: codeRun.threeVersion,
  runsPerTaskPerSystem: 1,
  summary,
  ...(pairwise ? { pairwise } : {}),
  records,
};
await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`);
console.log(`${totals.join('\n')}\n\n${lines.join('\n')}${pairwise ? `\n\n${pairwiseTable(pairwise)}` : ''}`);
