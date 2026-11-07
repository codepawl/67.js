// Prints the test files of one shard, one path per line: node scripts/shard-test-files.mjs <shard 1..count> <count>
// A file goes to the shard its name hashes to, so adding or removing a test file never moves the others. That keeps the merged
// coverage figures steady: `node --test --test-shard` deals files out by position, and every new file would reshuffle them.
import { createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const shard = Number(process.argv[2]);
const count = Number(process.argv[3]);
if (!Number.isInteger(shard) || !Number.isInteger(count) || shard < 1 || shard > count) {
  console.error('Usage: node scripts/shard-test-files.mjs <shard 1..count> <count>');
  process.exit(2);
}

function shardOf(fileName) {
  const digest = createHash('sha1').update(fileName).digest();
  return (digest.readUInt32BE(0) % count) + 1;
}

const testsDirectory = join(import.meta.dirname, '..', 'tests');
const names = readdirSync(testsDirectory)
  .filter(name => name.endsWith('.test.js'))
  .sort();
for (const name of names) {
  if (shardOf(name) === shard) console.log(`tests/${name}`);
}
