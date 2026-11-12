// Runs large-sequence-timing.mjs once per (size, mode) in its own child process, polls nvidia-smi while it runs and prints one
// LARGE_SEQUENCE_MEMORY line of JSON per child plus a hash comparison between the two modes of each size.
// GPU memory is read two ways each poll: the child's own row of `--query-compute-apps=pid,used_memory` (empty inside some containers) and the
// whole card's `--query-gpu=memory.used`. The idle card reading taken before the child starts is reported so the delta can be read.
//   node bench/cycles-parity/large-sequence-memory.mjs --sizes 1000000,2000000,4000000 [--scene terrain] [--out <json file>] [--poll-milliseconds 100]
// Run with NODE_OPTIONS=--max-old-space-size=16384 for sizes of about 4,000,000 triangles.
import { execFile, spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { readFlag } from './sequence-bench-core.mjs';

const runCommand = promisify(execFile);
const TIMING_SCRIPT = fileURLToPath(new URL('./large-sequence-timing.mjs', import.meta.url));
const MODES = ['oneshot', 'session'];

async function queryNvidiaSmi(queryArguments) {
  try {
    const { stdout } = await runCommand('nvidia-smi', [...queryArguments, '--format=csv,noheader,nounits']);
    return stdout.trim();
  } catch (error) {
    return '';
  }
}

async function readCardMegabytes() {
  const text = await queryNvidiaSmi(['--query-gpu=memory.used']);
  return Number(text.split('\n')[0]);
}

async function readProcessMegabytes(processId) {
  const text = await queryNvidiaSmi(['--query-compute-apps=pid,used_memory']);
  const row = text.split('\n').map(line => line.split(',').map(part => part.trim())).find(parts => Number(parts[0]) === processId);
  return row ? Number(row[1]) : null;
}

async function pollWhileRunning(child, pollMilliseconds) {
  const peaks = { processMegabytes: null, cardMegabytes: 0, polls: 0 };
  let finished = false;
  child.once('exit', () => { finished = true; });
  while (!finished) {
    const [processMegabytes, cardMegabytes] = await Promise.all([readProcessMegabytes(child.pid), readCardMegabytes()]);
    peaks.polls += 1;
    if (processMegabytes !== null) peaks.processMegabytes = Math.max(peaks.processMegabytes ?? 0, processMegabytes);
    if (Number.isFinite(cardMegabytes)) peaks.cardMegabytes = Math.max(peaks.cardMegabytes, cardMegabytes);
    await new Promise(resolve => setTimeout(resolve, pollMilliseconds));
  }
  return peaks;
}

async function runOne(scene, size, mode, pollMilliseconds) {
  const idleCardMegabytes = await readCardMegabytes();
  const child = spawn(process.execPath, [TIMING_SCRIPT, '--scene', scene, '--size', String(size), '--mode', mode], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  let errorOutput = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { errorOutput += chunk; });
  const exited = new Promise(resolve => child.once('exit', code => resolve(code)));
  const peaks = await pollWhileRunning(child, pollMilliseconds);
  const exitCode = await exited;
  const timingLine = output.split('\n').find(line => line.startsWith('LARGE_SEQUENCE_TIMING '));
  const timing = timingLine ? JSON.parse(timingLine.slice('LARGE_SEQUENCE_TIMING '.length)) : null;
  const record = { scene, size, mode, exitCode, idleCardMegabytes, ...peaks, timing };
  if (!timing) record.error = errorOutput.trim().split('\n').slice(-12).join('\n');
  return record;
}

function compareHashes(oneshot, session) {
  if (!oneshot?.timing || !session?.timing) return null;
  return oneshot.timing.results.map((oneshotResult, index) => {
    const sessionHashes = session.timing.results[index].frameHashes;
    return { variant: oneshotResult.variant, frames: sessionHashes.length, equalFrames: sessionHashes.filter((hash, frame) => hash === oneshotResult.frameHashes[frame]).length };
  });
}

async function main() {
  const argumentList = process.argv.slice(2);
  const scene = readFlag(argumentList, '--scene', 'terrain');
  const sizes = readFlag(argumentList, '--sizes', '1000000,4000000').split(',').map(Number);
  const pollMilliseconds = Number(readFlag(argumentList, '--poll-milliseconds', 100));
  const outputPath = readFlag(argumentList, '--out', null);
  const records = [];
  for (const size of sizes) {
    const byMode = {};
    for (const mode of MODES) {
      const record = await runOne(scene, size, mode, pollMilliseconds);
      byMode[mode] = record;
      records.push(record);
      console.log(`LARGE_SEQUENCE_MEMORY ${JSON.stringify(record)}`);
    }
    console.log(`LARGE_SEQUENCE_HASHES ${JSON.stringify({ size, comparison: compareHashes(byMode.oneshot, byMode.session) })}`);
  }
  if (outputPath) {
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, JSON.stringify(records, null, 2));
  }
}

main();
