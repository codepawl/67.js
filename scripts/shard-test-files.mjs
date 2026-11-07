// Prints the test files of one shard, one path per line: node scripts/shard-test-files.mjs <shard 1..count> <count>
//
// Files listed in test-timings.json (milliseconds per file, measured on CI) are dealt out longest first, each to the shard with the
// least time so far, which keeps every shard close to the same length. A file without a timing goes to the shard its name hashes to,
// so adding a test file never moves another file and the merged coverage figures stay steady. Refresh the timings after a change that
// makes tests much slower or faster: download the `timings-*.json` files from a CI run and run `node scripts/shard-test-files.mjs --merge-timings <files>`.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const rootDirectory = join(import.meta.dirname, '..');
const timingsPath = join(rootDirectory, 'test-timings.json');

function hashedShard(fileName, count) {
  const digest = createHash('sha1').update(fileName).digest();
  return digest.readUInt32BE(0) % count;
}

export function assignShards(fileNames, timings, count) {
  const shardOfFile = new Map();
  const shardTotals = new Array(count).fill(0);
  const timed = fileNames
    .filter(name => timings[name] !== undefined)
    .sort((a, b) => timings[b] - timings[a] || a.localeCompare(b));
  for (const name of timed) {
    let lightest = 0;
    for (let shard = 1; shard < count; shard += 1) {
      if (shardTotals[shard] < shardTotals[lightest]) lightest = shard;
    }
    shardOfFile.set(name, lightest);
    shardTotals[lightest] += timings[name];
  }
  for (const name of fileNames) {
    if (timings[name] === undefined) shardOfFile.set(name, hashedShard(name, count));
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
  const merged = {};
  for (const path of paths) Object.assign(merged, JSON.parse(readFileSync(path, 'utf8')));
  const sorted = Object.fromEntries(Object.entries(merged).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(timingsPath, `${JSON.stringify(sorted, null, 2)}\n`);
  console.log(`Wrote ${Object.keys(sorted).length} timings to test-timings.json`);
}

if (process.argv[1] === import.meta.filename) {
  if (process.argv[2] === '--merge-timings') {
    mergeTimings(process.argv.slice(3));
  } else {
    const shard = Number(process.argv[2]);
    const count = Number(process.argv[3]);
    if (!Number.isInteger(shard) || !Number.isInteger(count) || shard < 1 || shard > count) {
      console.error('Usage: node scripts/shard-test-files.mjs <shard 1..count> <count>');
      process.exit(2);
    }
    const timings = JSON.parse(readFileSync(timingsPath, 'utf8'));
    const shardOfFile = assignShards(listTestFiles(), timings, count);
    for (const [name, assigned] of shardOfFile) {
      if (assigned === shard - 1) console.log(name);
    }
  }
}
