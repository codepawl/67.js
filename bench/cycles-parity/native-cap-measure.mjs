// Measures the page-side pack of a scene above the CPU and WebGL triangle bound (#1041), and optionally traces it on the native tracer.
// One child process per case, so the peak memory of a case is its own. Each child prints one NATIVE_CAP_CASE line of JSON.
//   node bench/cycles-parity/native-cap-measure.mjs --sizes 400000,1000000 [--variants instanced,flattened] [--trace] [--out <json file>]
//     [--png-directory <dir>] [--samples 16] [--no-encode]
// --no-encode stops after the pack (a table above 536,870,888 base64 characters cannot be encoded in V8) and traces the packed input as it is.
// Run with NODE_OPTIONS=--max-old-space-size=16384 for sizes above 2,000,000 triangles.
// instanced: buildTraceScene({ instancing: true, maximumTriangles }) + buildJobNativeInput + encodeNativeInputV2, the job export path.
// flattened: the four meshes alone, buildTraceScene({ maximumTriangles }) (world-space triangles and a CPU BVH) + buildFlattenedJobNativeInput + encodeNativeInputV2.
// expanded: the same parts as instanced (copies included) but flattened, the picture to compare the instanced one with.
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { getHeapStatistics } from 'node:v8';
import * as pack from '../../src/path-tracer-gpu-pack.js';
import { buildNativeInput } from '../../packages/render-native/pack-input.mjs';
import { buildFlattenedJobNativeInput, buildJobNativeInput } from '../../packages/render-native/job-input.mjs';
import { buildTraceScene, resolveTexture } from '../../src/path-tracer-scene.js';
import { encodeNativeInputV2 } from '../../scripts/native-bake-page.js';
import { readFlag } from './sequence-bench-core.mjs';
import { NATIVE_CAP_ENVIRONMENT, NATIVE_CAP_PACK_OPTIONS, buildNativeCapParts, nativeCapCamera } from './native-cap-scene.mjs';

const runCommand = promisify(execFile);
const THIS_FILE = fileURLToPath(import.meta.url);
const V8_STRING_LIMIT = 536_870_888;
const BYTES_PER_MEGABYTE = 1024 * 1024;

function secondsSince(startedAt) {
  return Number(((performance.now() - startedAt) / 1000).toFixed(3));
}

function megabytes(bytes) {
  return Number((bytes / BYTES_PER_MEGABYTE).toFixed(1));
}

function describeTables(exported) {
  const base64Lengths = Object.values(exported.tables).map(text => text.length);
  const base64Total = base64Lengths.reduce((total, length) => total + length, 0);
  return { base64Megabytes: megabytes(base64Total), largestTableCharacters: Math.max(...base64Lengths), jsonCharacters: base64Total };
}

function packedBytesOf(input) {
  return Object.values(input).reduce((total, value) => total + (ArrayBuffer.isView(value) ? value.byteLength : 0), 0);
}

function packScene(variant, uniqueTriangles, maximumTriangles, encode) {
  const instanced = variant === 'instanced';
  const { parts, uniqueTriangles: actualUnique } = buildNativeCapParts(uniqueTriangles, variant !== 'flattened');
  const camera = nativeCapCamera();
  const phases = {};
  let startedAt = performance.now();
  const traceScene = buildTraceScene(parts, NATIVE_CAP_ENVIRONMENT, { instancing: instanced, maximumTriangles });
  phases.buildSceneSeconds = secondsSince(startedAt);
  startedAt = performance.now();
  const input = instanced
    ? buildJobNativeInput(traceScene, camera, NATIVE_CAP_PACK_OPTIONS, pack, resolveTexture)
    : buildFlattenedJobNativeInput(traceScene, camera, NATIVE_CAP_PACK_OPTIONS, pack, resolveTexture);
  phases.packSeconds = secondsSince(startedAt);
  if (!encode) return { input, phases, actualUnique, packedBytes: packedBytesOf(input), instances: input.instanceCount ?? 0 };
  startedAt = performance.now();
  const encoded = encodeNativeInputV2(input);
  phases.encodeSeconds = secondsSince(startedAt);
  const exported = { ...encoded, triangleCount: input.triangleCount, triangles: instanced ? input.triangleCount : traceScene.indices.length / 3, instances: input.instanceCount, wholeMaterials: true };
  return { exported, phases, actualUnique, packedBytes: packedBytesOf(input), instances: input.instanceCount ?? 0 };
}

// Without the base64 step (a table above the 536,870,888 characters of a V8 string cannot be encoded): the packed input goes to the tracer as it is.
async function traceInput(input, samples) {
  const tracer = await import('../../packages/render-native/index.mjs');
  const { width, height } = NATIVE_CAP_PACK_OPTIONS;
  const startedAt = performance.now();
  const traced = tracer.traceNative(input, { width, height, samples, kernel: 'cycles', noiseThreshold: 0 });
  return { tracedSeconds: secondsSince(startedAt), accelerationBuildSeconds: traced.accelerationBuildSeconds, uploadSeconds: traced.uploadSeconds, adapter: traced.adapter,
    rgbaSha256: createHash('sha256').update(Buffer.from(traced.rgba.buffer, traced.rgba.byteOffset, traced.rgba.byteLength)).digest('hex') };
}

async function traceExported(exported, samples, pngPath) {
  const tracer = await import('../../packages/render-native/index.mjs');
  const { traceFrameNative } = await import('../../scripts/agent-native-trace.mjs');
  const { width, height } = NATIVE_CAP_PACK_OPTIONS;
  const frame = await traceFrameNative({ tracer, exported: { ...exported, ignored: [] }, width, height, samples, bounces: NATIVE_CAP_PACK_OPTIONS.bounces, seed: 1, denoise: 'none', kernel: 'cycles' });
  const png = Buffer.from(frame.data, 'base64');
  if (pngPath) {
    mkdirSync(dirname(pngPath), { recursive: true });
    writeFileSync(pngPath, png);
  }
  const { report } = frame;
  return { tracedSeconds: Number(report.tracedSeconds.toFixed(3)), accelerationBuildSeconds: report.accelerationBuildSeconds, uploadSeconds: report.uploadSeconds, adapter: report.gpu, inputBytes: report.inputBytes, pngSha256: createHash('sha256').update(png).digest('hex') };
}

async function runChild(argumentList) {
  const variant = readFlag(argumentList, '--variant', 'instanced');
  const size = Number(readFlag(argumentList, '--size', 400000));
  const samples = Number(readFlag(argumentList, '--samples', 16));
  const pngDirectory = readFlag(argumentList, '--png-directory', null);
  const maximumTriangles = Number(readFlag(argumentList, '--maximum', 4_000_000));
  const result = { variant, requestedUniqueTriangles: size };
  const startedAt = performance.now();
  const encode = !argumentList.includes('--no-encode');
  const packed = packScene(variant, size, maximumTriangles, encode);
  Object.assign(result, { uniqueTriangles: packed.actualUnique, instances: packed.instances, ...packed.phases, packTotalSeconds: secondsSince(startedAt),
    packedMegabytes: megabytes(packed.packedBytes), ...(encode ? describeTables(packed.exported) : {}) });
  result.overStringLimit = result.largestTableCharacters > V8_STRING_LIMIT || result.jsonCharacters > V8_STRING_LIMIT;
  result.heapUsedMegabytes = megabytes(process.memoryUsage().heapUsed);
  result.peakResidentMegabytes = megabytes(process.resourceUsage().maxRSS * 1024);
  if (argumentList.includes('--trace')) {
    const pngPath = pngDirectory ? join(pngDirectory, `${variant}-${size}.png`) : null;
    Object.assign(result, { trace: encode ? await traceExported(packed.exported, samples, pngPath) : await traceInput(packed.input, samples) });
  }
  console.log(`NATIVE_CAP_CASE ${JSON.stringify(result)}`);
}

async function readCardMegabytes() {
  try {
    const { stdout } = await runCommand('nvidia-smi', ['--query-gpu=memory.used', '--format=csv,noheader,nounits']);
    return Number(stdout.trim().split('\n')[0]);
  } catch (error) {
    return Number.NaN;
  }
}

async function readProcessMegabytes(processId) {
  try {
    const { stdout } = await runCommand('nvidia-smi', ['--query-compute-apps=pid,used_memory', '--format=csv,noheader,nounits']);
    const row = stdout.trim().split('\n').map(line => line.split(',').map(part => part.trim())).find(parts => Number(parts[0]) === processId);
    return row ? Number(row[1]) : null;
  } catch (error) {
    return null;
  }
}

async function runCaseInChild(variant, size, extraArguments) {
  const childArguments = [THIS_FILE, '--child', '--variant', variant, '--size', String(size), ...extraArguments];
  const idleCardMegabytes = await readCardMegabytes();
  const child = spawn(process.execPath, childArguments, { stdio: ['ignore', 'pipe', 'inherit'], env: process.env });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  let finished = false;
  const exited = new Promise(resolve => child.once('exit', code => { finished = true; resolve(code); }));
  let peakCardMegabytes = idleCardMegabytes;
  let peakProcessMegabytes = null;
  while (!finished) {
    const [card, processMegabytes] = await Promise.all([readCardMegabytes(), readProcessMegabytes(child.pid)]);
    if (processMegabytes !== null) peakProcessMegabytes = Math.max(peakProcessMegabytes ?? 0, processMegabytes);
    if (Number.isFinite(card)) peakCardMegabytes = Math.max(peakCardMegabytes, card);
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  const code = await exited;
  const line = output.split('\n').find(text => text.startsWith('NATIVE_CAP_CASE '));
  if (!line) return { variant, requestedUniqueTriangles: size, failed: `child exited with code ${code} and no result line` };
  const result = JSON.parse(line.slice('NATIVE_CAP_CASE '.length));
  if (Number.isFinite(idleCardMegabytes) && result.trace) {
    result.trace.cardIdleMegabytes = idleCardMegabytes;
    result.trace.cardPeakMegabytes = peakCardMegabytes;
    result.trace.cardDeltaMegabytes = peakCardMegabytes - idleCardMegabytes;
    result.trace.processMegabytes = peakProcessMegabytes;
  }
  return result;
}

async function runParent(argumentList) {
  const sizes = readFlag(argumentList, '--sizes', '400000').split(',').map(Number);
  const variants = readFlag(argumentList, '--variants', 'instanced,flattened').split(',');
  const passThrough = ['--samples', '--png-directory', '--maximum'].flatMap(flag => (argumentList.includes(flag) ? [flag, readFlag(argumentList, flag, '')] : []));
  for (const flag of ['--trace', '--no-encode']) if (argumentList.includes(flag)) passThrough.push(flag);
  const results = [];
  for (const size of sizes) {
    for (const variant of variants) {
      const result = await runCaseInChild(variant, size, passThrough);
      console.log(JSON.stringify(result));
      results.push(result);
    }
  }
  const outPath = readFlag(argumentList, '--out', null);
  if (outPath) {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, `${JSON.stringify(results, null, 2)}\n`);
  }
}

const argumentList = process.argv.slice(2);
await (argumentList.includes('--child') ? runChild(argumentList) : runParent(argumentList));
