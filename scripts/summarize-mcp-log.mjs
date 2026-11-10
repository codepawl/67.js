#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function readCalls(logPaths) {
  const calls = [];
  for (const logPath of logPaths) {
    for (const line of readFileSync(logPath, 'utf8').split('\n')) {
      if (line.trim() === '') {
        continue;
      }
      try {
        calls.push(JSON.parse(line));
      } catch {
        console.error(`Skipped a line in ${logPath} that is not JSON.`);
      }
    }
  }
  return calls;
}

function median(values) {
  const sorted = [...values].sort((first, second) => first - second);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function summarizeCalls(calls) {
  const byTool = new Map();
  for (const call of calls) {
    const entry = byTool.get(call.tool) ?? { tool: call.tool, calls: 0, errors: 0, durations: [] };
    entry.calls += 1;
    entry.errors += call.ok === false ? 1 : 0;
    entry.durations.push(call.durationMs);
    byTool.set(call.tool, entry);
  }
  return [...byTool.values()]
    .map(entry => ({ tool: entry.tool, calls: entry.calls, errors: entry.errors, errorRate: entry.errors / entry.calls, medianMs: median(entry.durations) }))
    .sort((first, second) => second.calls - first.calls || first.tool.localeCompare(second.tool));
}

export function formatSummary(rows) {
  const header = ['tool', 'calls', 'errors', 'error rate', 'median ms'];
  const body = rows.map(row => [row.tool, String(row.calls), String(row.errors), `${(row.errorRate * 100).toFixed(1)}%`, row.medianMs.toFixed(1)]);
  const widths = header.map((title, column) => Math.max(title.length, ...body.map(cells => cells[column].length)));
  const render = cells => cells.map((cell, column) => (column === 0 ? cell.padEnd(widths[column]) : cell.padStart(widths[column]))).join('  ');
  return [render(header), ...body.map(render)].join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const logPaths = process.argv.slice(2);
  if (logPaths.length === 0) {
    console.error('Usage: node scripts/summarize-mcp-log.mjs <log file...>');
    process.exitCode = 1;
  } else {
    console.log(formatSummary(summarizeCalls(readCalls(logPaths))));
  }
}
