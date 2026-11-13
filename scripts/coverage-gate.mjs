// Merges the lcov files of the test shards, prints and summarises line, branch and function coverage, and fails when
// any figure falls more than the allowed margin below the committed baseline (config/coverage-baseline.json).
// Raising the baseline is a manual edit of that file. The function figure counts each function once per source line,
// so the baseline was re-measured (93.4 to 92.28 on the same commit) when unnamed functions stopped being counted per shard.
// The branch figure counts each branch once per source line and position on that line, for the same reason (see branchKey).
// Usage: node scripts/coverage-gate.mjs <lcov file or folder>... [--baseline config/coverage-baseline.json] [--merged-out merged.lcov]
import { appendFileSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Branch totals move by up to about 0.8 points between runs of the same commit (merged V8 block ranges across shards),
// so branches get more room than lines and functions, which stay within a few hundredths.
const ALLOWED_DROP_POINTS = Object.freeze({ lines: 0.5, branches: 1.5, functions: 0.5 });
const METRICS = ['lines', 'branches', 'functions'];

function collectLcovPaths(inputs) {
  const paths = [];
  for (const input of inputs) {
    if (statSync(input).isDirectory()) {
      for (const entry of readdirSync(input, { recursive: true })) {
        const name = String(entry);
        if (name.endsWith('.info') || name.endsWith('.lcov')) paths.push(join(input, name));
      }
    } else {
      paths.push(input);
    }
  }
  return paths;
}

function fileRecord(files, path) {
  if (!files.has(path)) files.set(path, { lines: new Map(), branches: new Map(), functions: new Map() });
  return files.get(path);
}

function addHits(map, key, hits) {
  map.set(key, (map.get(key) ?? 0) + hits);
}

// V8 numbers the unnamed functions of a file per process (`anonymous_7`), so the same name points at different
// functions in different shards. A function is therefore identified by its line, plus its name when it has one.
const ANONYMOUS_FUNCTION_NAME = /^anonymous_\d+$/;

function functionKey(line, name) {
  return ANONYMOUS_FUNCTION_NAME.test(name) ? `${line},anonymous` : `${line},${name}`;
}

function functionEntry(record, key, line, name) {
  if (!record.functions.has(key)) {
    const mergedName = ANONYMOUS_FUNCTION_NAME.test(name) ? `anonymous_at_line_${line}` : name;
    record.functions.set(key, { line, name: mergedName, hits: 0 });
  }
  return record.functions.get(key);
}

// V8 numbers the blocks of a file per process, in the order it reports them, and a shard that never runs a function reports
// that function as one range instead of its nested blocks. The same block id therefore points at different branches in
// different shards, and keying by it counted one branch once per shard layout (more shards, lower figure). A branch is
// identified by its line and by its position among the branches reported for that line, which every shard agrees on
// for the branches it reports. A shard that reports fewer branches on a line only adds hits to the first ones.
function branchKey(line, branch, positionByLine) {
  const lineAndBranch = `${line},${branch}`;
  const position = positionByLine.get(lineAndBranch) ?? 0;
  positionByLine.set(lineAndBranch, position + 1);
  return `${line},${position},${branch}`;
}

export function mergeLcov(texts) {
  const files = new Map();
  for (const text of texts) {
    let record = null;
    let keyByName = new Map();
    let branchPositionByLine = new Map();
    for (const row of text.split(/\r?\n/)) {
      const separator = row.indexOf(':');
      const tag = separator < 0 ? row : row.slice(0, separator);
      const value = separator < 0 ? '' : row.slice(separator + 1);
      if (tag === 'SF') {
        record = fileRecord(files, value);
        keyByName = new Map();
        branchPositionByLine = new Map();
      } else if (!record) {
        continue;
      } else if (tag === 'DA') {
        const [line, hits] = value.split(',');
        addHits(record.lines, line, Number(hits));
      } else if (tag === 'BRDA') {
        const [line, , branch, hits] = value.split(',');
        addHits(record.branches, branchKey(line, branch, branchPositionByLine), hits === '-' ? 0 : Number(hits));
      } else if (tag === 'FN') {
        const [line, name] = value.split(',');
        const key = functionKey(line, name);
        keyByName.set(name, key);
        functionEntry(record, key, line, name);
      } else if (tag === 'FNDA') {
        const [hits, name] = value.split(',');
        const key = keyByName.get(name) ?? functionKey('0', name);
        const entry = functionEntry(record, key, key.split(',')[0], name);
        entry.hits += Number(hits);
      }
    }
  }
  return files;
}

export function totalsOf(files) {
  const totals = { lines: [0, 0], branches: [0, 0], functions: [0, 0] };
  for (const record of files.values()) {
    for (const hits of record.lines.values()) {
      totals.lines[1]++;
      if (hits > 0) totals.lines[0]++;
    }
    for (const hits of record.branches.values()) {
      totals.branches[1]++;
      if (hits > 0) totals.branches[0]++;
    }
    for (const entry of record.functions.values()) {
      totals.functions[1]++;
      if (entry.hits > 0) totals.functions[0]++;
    }
  }
  const percentages = {};
  for (const metric of METRICS) {
    const [covered, found] = totals[metric];
    percentages[metric] = found === 0 ? 100 : Math.round((covered / found) * 10000) / 100;
  }
  return { totals, percentages };
}

export function compareWithBaseline(percentages, baseline) {
  return METRICS.map(metric => ({
    metric,
    actual: percentages[metric],
    baseline: baseline[metric],
    ok: percentages[metric] >= baseline[metric] - ALLOWED_DROP_POINTS[metric],
  }));
}

function toLcov(files) {
  const rows = [];
  for (const [path, record] of files) {
    rows.push('TN:', `SF:${path}`);
    for (const entry of record.functions.values()) rows.push(`FN:${entry.line},${entry.name}`);
    for (const entry of record.functions.values()) rows.push(`FNDA:${entry.hits},${entry.name}`);
    for (const [key, hits] of record.branches) rows.push(`BRDA:${key},${hits}`);
    for (const [line, hits] of record.lines) rows.push(`DA:${line},${hits}`);
    rows.push('end_of_record');
  }
  return rows.join('\n') + '\n';
}

function main() {
  const args = process.argv.slice(2);
  const inputs = [];
  let baselinePath = 'config/coverage-baseline.json';
  let mergedOut = null;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--baseline') baselinePath = args[++index];
    else if (args[index] === '--merged-out') mergedOut = args[++index];
    else inputs.push(args[index]);
  }
  const paths = collectLcovPaths(inputs);
  if (paths.length === 0) throw new Error('No lcov files found.');
  const files = mergeLcov(paths.map(path => readFileSync(path, 'utf8')));
  if (mergedOut) writeFileSync(mergedOut, toLcov(files));
  const { totals, percentages } = totalsOf(files);
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
  const results = compareWithBaseline(percentages, baseline);

  const table = [
    `Coverage from ${paths.length} lcov file(s), ${files.size} source files. A drop below the baseline of more than ${ALLOWED_DROP_POINTS.lines} points (lines, functions) or ${ALLOWED_DROP_POINTS.branches} points (branches) fails.`,
    '',
    '| Metric | Covered | Total | Actual % | Baseline % | Result |',
    '| --- | ---: | ---: | ---: | ---: | --- |',
    ...results.map(
      result => `| ${result.metric} | ${totals[result.metric][0]} | ${totals[result.metric][1]} | ${result.actual} | ${result.baseline} | ${result.ok ? 'pass' : 'FAIL'} |`,
    ),
    '',
  ].join('\n');
  console.log(table);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Coverage\n\n${table}\n`);
  if (results.some(result => !result.ok)) {
    console.error('Coverage fell below the baseline. Add tests, or lower config/coverage-baseline.json on purpose.');
    process.exit(1);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
