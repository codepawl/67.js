// Prints the test files of one shard, one path per line: node scripts/shard-test-files.mjs <shard 1..count> <count> [--untimed=hash]
//
// Files listed in test-timings.json (milliseconds per file, measured on CI) are dealt out longest first, each to the shard with the
// least time so far, which keeps every shard close to the same length.
//
// A file without a timing (a test file added since the last refresh) is dealt after all timed files, using the median timing as its
// estimate, so it goes to the lightest shard and never moves a timed file. Hashing the name instead (--untimed=hash, the behaviour
// before #996) kept the coverage gate steady, because the gate compared function totals that depended on how files were grouped.
// #993 makes those totals independent of the layout, so the estimate is the default; the hash path stays behind the flag until
// #993 has merged and the flag has no user left.
//
// Refresh the timings after a change that makes tests much slower or faster, from any finished Test run (its shard artifacts hold
// the per-file times):
//   node scripts/shard-test-files.mjs --from-run <run id>
// or from timings files you already downloaded (several runs give the median per file):
//   node scripts/shard-test-files.mjs --merge-timings <files>
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const rootDirectory = join(import.meta.dirname, '..');
const timingsPath = join(rootDirectory, 'test-timings.json');

function hashedShard(fileName, count) {
  const digest = createHash('sha1').update(fileName).digest();
  return digest.readUInt32BE(0) % count;
}

export function medianOf(numbers) {
  if (numbers.length === 0) return 0;
  const sorted = [...numbers].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function assignShards(fileNames, timings, count, { untimed = 'estimate' } = {}) {
  const shardOfFile = new Map();
  const shardTotals = new Array(count).fill(0);
  const estimate = medianOf(Object.values(timings));
  const timingOf = name => timings[name] ?? estimate;
  const isTimed = name => timings[name] !== undefined;
  const dealt = untimed === 'hash' ? fileNames.filter(isTimed) : fileNames;
  // Timed files first, then untimed ones: the position of a timed file never depends on which untimed files exist.
  const order = (a, b) => Number(isTimed(b)) - Number(isTimed(a)) || timingOf(b) - timingOf(a) || a.localeCompare(b);
  for (const name of [...dealt].sort(order)) {
    let lightest = 0;
    for (let shard = 1; shard < count; shard += 1) {
      if (shardTotals[shard] < shardTotals[lightest]) lightest = shard;
    }
    shardOfFile.set(name, lightest);
    shardTotals[lightest] += timingOf(name);
  }
  if (untimed === 'hash') {
    for (const name of fileNames) {
      if (!isTimed(name)) shardOfFile.set(name, hashedShard(name, count));
    }
  }
  return shardOfFile;
}

function listTestFiles() {
  return readdirSync(join(rootDirectory, 'tests'))
    .filter(name => name.endsWith('.test.js'))
    .map(name => `tests/${name}`)
    .sort();
}

function mergeTimings(paths) {
  const measurements = new Map();
  for (const path of paths) {
    for (const [name, milliseconds] of Object.entries(JSON.parse(readFileSync(path, 'utf8')))) {
      measurements.set(name, [...(measurements.get(name) ?? []), milliseconds]);
    }
  }
  const sorted = Object.fromEntries(
    [...measurements.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, values]) => [name, Math.round(medianOf(values))])
  );
  writeFileSync(timingsPath, `${JSON.stringify(sorted, null, 2)}\n`);
  console.log(`Wrote ${Object.keys(sorted).length} timings to test-timings.json`);
}

function mergeTimingsFromRun(runId) {
  const downloadDirectory = mkdtempSync(join(tmpdir(), 'test-timings-'));
  try {
    execFileSync('gh', ['run', 'download', runId, '--pattern', 'lcov-shard-*', '-D', downloadDirectory], { stdio: 'inherit' });
    const timingsFiles = readdirSync(downloadDirectory, { recursive: true })
      .filter(name => /timings-\d+\.json$/.test(name))
      .map(name => join(downloadDirectory, name));
    if (timingsFiles.length === 0) throw new Error(`Run ${runId} has no timings-*.json in its lcov-shard-* artifacts.`);
    mergeTimings(timingsFiles);
  } finally {
    rmSync(downloadDirectory, { recursive: true, force: true });
  }
}

if (process.argv[1] === import.meta.filename) {
  const arguments_ = process.argv.slice(2);
  if (arguments_[0] === '--merge-timings') {
    mergeTimings(arguments_.slice(1));
  } else if (arguments_[0] === '--from-run') {
    mergeTimingsFromRun(arguments_[1]);
  } else {
    const untimed = arguments_.includes('--untimed=hash') ? 'hash' : 'estimate';
    const [shard, count] = arguments_.filter(argument => !argument.startsWith('--')).map(Number);
    if (!Number.isInteger(shard) || !Number.isInteger(count) || shard < 1 || shard > count) {
      console.error('Usage: node scripts/shard-test-files.mjs <shard 1..count> <count> [--untimed=hash]');
      process.exit(2);
    }
    const timings = JSON.parse(readFileSync(timingsPath, 'utf8'));
    const shardOfFile = assignShards(listTestFiles(), timings, count, { untimed });
    for (const [name, assigned] of shardOfFile) {
      if (assigned === shard - 1) console.log(name);
    }
  }
}
