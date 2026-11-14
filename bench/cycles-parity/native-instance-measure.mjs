// Measures the page-side pack of a card field with many instances (#1055), and optionally traces it on the native tracer.
//   node bench/cycles-parity/native-instance-measure.mjs --count 250000 [--variant instanced|merged] [--trace] [--samples 16]
//     [--no-encode] [--png <file>]
// One process per case, so the peak memory is the case's own. It prints one NATIVE_INSTANCE_CASE line of JSON.
// instanced: buildTraceScene({ instancing: true, maximumInstances }) + buildJobNativeInput + encodeNativeInputV2, the job export path.
// merged: the same cards written into two world-space meshes and exported as a flattened scene.
// --no-encode stops after the pack: a table above 536,870,888 base64 characters cannot be encoded in V8.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import * as pack from '../../src/path-tracer-gpu-pack.js';
import { buildFlattenedJobNativeInput, buildJobNativeInput } from '@codepawlhq/cook/job-input';
import { MAX_NATIVE_TRACE_INSTANCES, buildTraceScene, resolveTexture } from '../../src/path-tracer-scene.js';
import { encodeNativeInputV2 } from '../../scripts/native-bake-page.js';
import { readFlag } from './sequence-bench-core.mjs';
import { CARD_FIELD_ENVIRONMENT, CARD_FIELD_PACK_OPTIONS, buildCardField, buildCardFieldMerged, cardFieldCamera } from './native-instance-scene.mjs';

const V8_STRING_LIMIT = 536_870_888;
const BYTES_PER_MEGABYTE = 1024 * 1024;

function secondsSince(startedAt) {
  return Number(((performance.now() - startedAt) / 1000).toFixed(3));
}

function megabytes(bytes) {
  return Number((bytes / BYTES_PER_MEGABYTE).toFixed(1));
}

function tableBytes(input) {
  const bytes = {};
  for (const [name, value] of Object.entries(input)) {
    if (ArrayBuffer.isView(value)) bytes[name] = value.byteLength;
  }
  return bytes;
}

async function traceExported(exported, samples, pngPath) {
  const tracer = await import('@codepawlhq/cook');
  const { traceFrameNative } = await import('../../scripts/agent-native-trace.mjs');
  const { width, height } = CARD_FIELD_PACK_OPTIONS;
  const frame = await traceFrameNative({ tracer, exported: { ...exported, ignored: [] }, width, height, samples, bounces: CARD_FIELD_PACK_OPTIONS.bounces, seed: 1, denoise: 'none', kernel: 'cycles' });
  const png = Buffer.from(frame.data, 'base64');
  if (pngPath) {
    mkdirSync(dirname(pngPath), { recursive: true });
    writeFileSync(pngPath, png);
  }
  const { report } = frame;
  return { tracedSeconds: Number(report.tracedSeconds.toFixed(3)), accelerationBuildSeconds: report.accelerationBuildSeconds, uploadSeconds: report.uploadSeconds,
    adapter: report.gpu, inputBytes: report.inputBytes, pngSha256: createHash('sha256').update(png).digest('hex') };
}

// The card memory in use, sampled by an nvidia-smi child while the trace blocks this process; the first sample is the idle level.
function startCardMeter() {
  const samples = [];
  let pending = '';
  const meter = spawn('nvidia-smi', ['--query-gpu=memory.used', '--format=csv,noheader,nounits', '-lms', '100'], { stdio: ['ignore', 'pipe', 'ignore'] });
  meter.on('error', () => {});
  meter.stdout.on('data', chunk => {
    pending += chunk;
    const lines = pending.split('\n');
    pending = lines.pop();
    for (const line of lines) if (line.trim() !== '') samples.push(Number(line));
  });
  return async function stopCardMeter() {
    await new Promise(resolve => setTimeout(resolve, 400));
    meter.kill();
    return samples.length === 0 ? null : { idleMegabytes: samples[0], peakMegabytes: Math.max(...samples) };
  };
}

const argumentList = process.argv.slice(2);
const count = Number(readFlag(argumentList, '--count', 250000));
const variant = readFlag(argumentList, '--variant', 'instanced');
const samples = Number(readFlag(argumentList, '--samples', 16));
const encode = !argumentList.includes('--no-encode');
if (argumentList.includes('--trace') && !encode) {
  console.error('--trace needs the encoded tables: drop --no-encode, or drop --trace.');
  process.exit(2);
}
const redFrom = Math.max(0, count - Math.floor(count / 4));
const camera = cardFieldCamera(count);
const result = { variant, count };
const phases = {};

let startedAt = performance.now();
const parts = variant === 'instanced' ? buildCardField(count, redFrom) : buildCardFieldMerged(count, redFrom);
phases.buildPartsSeconds = secondsSince(startedAt);
startedAt = performance.now();
const traceScene = variant === 'instanced'
  ? buildTraceScene(parts, CARD_FIELD_ENVIRONMENT, { instancing: true, maximumTriangles: 1_500_000, maximumInstances: MAX_NATIVE_TRACE_INSTANCES })
  : buildTraceScene(parts, CARD_FIELD_ENVIRONMENT, { maximumTriangles: 1_500_000 });
phases.buildSceneSeconds = secondsSince(startedAt);
startedAt = performance.now();
const input = variant === 'instanced'
  ? buildJobNativeInput(traceScene, camera, CARD_FIELD_PACK_OPTIONS, pack, resolveTexture)
  : buildFlattenedJobNativeInput(traceScene, camera, CARD_FIELD_PACK_OPTIONS, pack, resolveTexture);
phases.packSeconds = secondsSince(startedAt);
Object.assign(result, phases, { instances: input.instanceCount, triangles: input.triangleCount, tableBytes: tableBytes(input) });
let exported;
if (encode) {
  startedAt = performance.now();
  exported = { ...encodeNativeInputV2(input), triangleCount: input.triangleCount, triangles: input.triangleCount, instances: input.instanceCount, wholeMaterials: true };
  result.encodeSeconds = secondsSince(startedAt);
  const lengths = Object.fromEntries(Object.entries(exported.tables).map(([name, text]) => [name, text.length]));
  result.largestBase64Table = Object.entries(lengths).sort((first, second) => second[1] - first[1])[0];
  result.base64Characters = Object.values(lengths).reduce((total, length) => total + length, 0);
  result.overStringLimit = result.largestBase64Table[1] > V8_STRING_LIMIT || result.base64Characters > V8_STRING_LIMIT;
}
result.heapUsedMegabytes = megabytes(process.memoryUsage().heapUsed);
result.peakResidentMegabytes = megabytes(process.resourceUsage().maxRSS * 1024);
if (argumentList.includes('--trace')) {
  const stopCardMeter = startCardMeter();
  await new Promise(resolve => setTimeout(resolve, 400));
  result.trace = await traceExported(exported, samples, readFlag(argumentList, '--png', null));
  result.trace.card = await stopCardMeter();
}
console.log(`NATIVE_INSTANCE_CASE ${JSON.stringify(result)}`);
