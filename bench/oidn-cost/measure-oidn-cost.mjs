// Measures what one OIDN call costs, and what the persistent in-process device saves (issue #1025).
//
//   node bench/oidn-cost/measure-oidn-cost.mjs --out <result.json> [--sizes 960x540,1920x1080] [--devices cpu,cuda] [--warm 7]
//
// Needs the oidnDenoise tool and its library (npm run fetch in packages/denoise-oidn, or OIDN_DENOISE_PATH) and the built
// Cook addon. For each size and device it reports:
//   - the oidnDenoise tool call split into PFM encode, PFM file write, process start to exit, PFM read and decode,
//     with the bare process start (`--version`) beside it;
//   - the in-process device: creation, first call and warm calls split into commit, buffer writes, execute and read;
//   - output equality: tool against in-process (largest absolute difference and byte identity), first against warm call;
//   - the host copy cost of the three guide images, which is the floor left when the tracer and OIDN share no memory.
// Inputs are synthetic and seeded (shaded blocks with noise), so the timings do not depend on a scene.
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { createOidnDenoiser, decodePfm, denoiseWithOidn, encodePfm, findOidnBinary } from '../../packages/denoise-oidn/index.mjs';
import { createNativeOidnDenoiser, findNativeAddon } from '@codepawlhq/cook';

function readOption(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function median(values) {
  const sorted = [...values].sort((first, second) => first - second);
  return sorted[Math.floor(sorted.length / 2)];
}

function seconds(started) {
  return (performance.now() - started) / 1000;
}

function round(value) {
  return Number(value.toFixed(6));
}

/** A small seeded generator, so every run and every machine denoises the same pixels. */
function createRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function makeImages(width, height) {
  const random = createRandom(1025);
  const pixelCount = width * height;
  const color = new Float32Array(pixelCount * 3);
  const albedo = new Float32Array(pixelCount * 3);
  const normal = new Float32Array(pixelCount * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 3;
      const block = (Math.floor(x / 64) + Math.floor(y / 64)) % 3;
      const base = [0.8, 0.3, 0.5][block];
      const tilt = block * 0.4;
      const length = Math.hypot(tilt, 1);
      const shade = 0.5 + 2 * (x / width);
      for (let channel = 0; channel < 3; channel++) {
        albedo[offset + channel] = base * (0.7 + 0.1 * channel);
        color[offset + channel] = Math.max(0, albedo[offset + channel] * shade * (0.4 + 1.2 * random()));
      }
      normal[offset] = tilt / length;
      normal[offset + 1] = 1 / length;
      normal[offset + 2] = 0;
    }
  }
  return { color, albedo, normal };
}

function maxAbsoluteDifference(first, second) {
  let largest = 0;
  for (let index = 0; index < first.length; index++) largest = Math.max(largest, Math.abs(first[index] - second[index]));
  return largest;
}

function byteIdentical(first, second) {
  return Buffer.compare(Buffer.from(first.buffer, first.byteOffset, first.byteLength), Buffer.from(second.buffer, second.byteOffset, second.byteLength)) === 0;
}

function runProcess(binary, toolArguments) {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const child = spawn(binary, toolArguments, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, seconds: seconds(started), output }));
  });
}

/** One tool call, timed phase by phase with the same steps denoiseWithOidn takes. */
async function timeToolCall(binary, frame, device) {
  const { width, height, color, albedo, normal } = frame;
  const directory = await mkdtemp(join(tmpdir(), '67js-oidn-cost-'));
  try {
    let started = performance.now();
    const encoded = [encodePfm(color, width, height), encodePfm(albedo, width, height), encodePfm(normal, width, height)];
    const encodeSeconds = seconds(started);
    started = performance.now();
    await Promise.all([
      writeFile(join(directory, 'color.pfm'), encoded[0]),
      writeFile(join(directory, 'albedo.pfm'), encoded[1]),
      writeFile(join(directory, 'normal.pfm'), encoded[2]),
    ]);
    const writeSeconds = seconds(started);
    const toolArguments = ['--device', device, '--quality', 'high', '--hdr', join(directory, 'color.pfm'), '--alb', join(directory, 'albedo.pfm'),
      '--nrm', join(directory, 'normal.pfm'), '--output', join(directory, 'out.pfm')];
    const run = await runProcess(binary, toolArguments);
    if (run.code !== 0) throw new Error(`oidnDenoise exited with ${run.code}: ${run.output.slice(0, 400)}`);
    started = performance.now();
    decodePfm(await readFile(join(directory, 'out.pfm')), width, height);
    const readSeconds = seconds(started);
    return { encodeSeconds, writeSeconds, processSeconds: run.seconds, readSeconds, totalSeconds: encodeSeconds + writeSeconds + run.seconds + readSeconds };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function medianOf(rows, key) {
  return round(median(rows.map(row => row[key])));
}

async function measureTool(binary, frame, device, warmCount) {
  const rows = [];
  for (let call = 0; call < warmCount; call++) rows.push(await timeToolCall(binary, frame, device));
  const bare = [];
  for (let call = 0; call < warmCount; call++) bare.push((await runProcess(binary, ['--version'])).seconds);
  // Verbose output shows where the tool spends its time on this machine; a flag the tool rejects is recorded, not fatal.
  const directory = await mkdtemp(join(tmpdir(), '67js-oidn-cost-'));
  let verbose;
  try {
    await Promise.all([
      writeFile(join(directory, 'color.pfm'), encodePfm(frame.color, frame.width, frame.height)),
      writeFile(join(directory, 'albedo.pfm'), encodePfm(frame.albedo, frame.width, frame.height)),
      writeFile(join(directory, 'normal.pfm'), encodePfm(frame.normal, frame.width, frame.height)),
    ]);
    const run = await runProcess(binary, ['--device', device, '--quality', 'high', '--hdr', join(directory, 'color.pfm'), '--alb', join(directory, 'albedo.pfm'),
      '--nrm', join(directory, 'normal.pfm'), '--output', join(directory, 'out.pfm'), '--verbose', '2']);
    verbose = { exit: run.code, seconds: round(run.seconds), output: run.output.slice(0, 3000) };
  } catch (error) {
    verbose = { error: String(error.message).slice(0, 300) };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  return {
    warmCalls: warmCount,
    encodeSeconds: medianOf(rows, 'encodeSeconds'),
    fileWriteSeconds: medianOf(rows, 'writeSeconds'),
    processStartToExitSeconds: medianOf(rows, 'processSeconds'),
    bareProcessSeconds: round(median(bare)),
    fileReadDecodeSeconds: medianOf(rows, 'readSeconds'),
    totalSeconds: medianOf(rows, 'totalSeconds'),
    verbose,
  };
}

async function measureInProcess(frame, device, warmCount) {
  const created = performance.now();
  const denoiser = createOidnDenoiser({ createNative: createNativeOidnDenoiser, device });
  const createSeconds = seconds(created);
  try {
    let started = performance.now();
    const firstOutput = await denoiser.denoise(frame);
    const firstCallSeconds = seconds(started);
    const firstTimings = denoiser.lastTimings;
    const warm = [];
    let warmOutput;
    for (let call = 0; call < warmCount; call++) {
      started = performance.now();
      warmOutput = await denoiser.denoise(frame);
      warm.push({ wallSeconds: seconds(started), ...denoiser.lastTimings });
    }
    // A different size recommits the filter; the same size afterwards recommits once more and gives the same bytes.
    const otherSize = await denoiser.denoise({ width: 64, height: 64, color: new Float32Array(64 * 64 * 3).fill(0.5), albedo: new Float32Array(64 * 64 * 3).fill(0.5), normal: new Float32Array(64 * 64 * 3) });
    const afterResize = denoiser.lastTimings.recommitted;
    const againOutput = await denoiser.denoise(frame);
    return {
      libraryPath: denoiser.libraryPath,
      createSeconds: round(createSeconds),
      deviceSeconds: round(denoiser.deviceSeconds),
      firstCall: { wallSeconds: round(firstCallSeconds), ...Object.fromEntries(Object.entries(firstTimings).map(([key, value]) => [key, typeof value === 'number' ? round(value) : value])) },
      warm: {
        calls: warmCount,
        wallSeconds: medianOf(warm, 'wallSeconds'),
        commitSeconds: medianOf(warm, 'commitSeconds'),
        writeSeconds: medianOf(warm, 'writeSeconds'),
        executeSeconds: medianOf(warm, 'executeSeconds'),
        readSeconds: medianOf(warm, 'readSeconds'),
        anyRecommitted: warm.some(row => row.recommitted),
      },
      resize: { recommittedAfterSizeChange: afterResize, smallOutputLength: otherSize.length, recommittedBackAtFullSize: denoiser.lastTimings.recommitted },
      outputs: { firstOutput, warmOutput, againOutput },
    };
  } finally {
    denoiser.close();
  }
}

function measureHostCopies(frame, repeats) {
  const timings = [];
  for (let repeat = 0; repeat < repeats; repeat++) {
    const started = performance.now();
    const copies = [frame.color.slice(), frame.albedo.slice(), frame.normal.slice()];
    timings.push(seconds(started));
    if (copies[0].length !== frame.color.length) throw new Error('copy failed');
  }
  return round(median(timings));
}

async function main() {
  const outputPath = readOption('--out', '');
  if (!outputPath) throw new RangeError('Usage: node bench/oidn-cost/measure-oidn-cost.mjs --out <result.json> [--sizes 960x540,1920x1080] [--devices cpu,cuda] [--warm 7]');
  const sizes = readOption('--sizes', '960x540,1920x1080').split(',').map(text => text.split('x').map(Number));
  const devices = readOption('--devices', 'cpu,cuda').split(',');
  const warmCount = Number(readOption('--warm', '7'));
  const binary = findOidnBinary();
  if (!binary) throw new Error('The oidnDenoise tool is not installed: run `npm run fetch` in packages/denoise-oidn, or set OIDN_DENOISE_PATH.');
  if (!findNativeAddon()) throw new Error('The Cook addon is not built: run `npm run cook:build`.');
  const result = { oidnBinary: 'oidnDenoise', devices, sizes: [], rows: [] };
  for (const [width, height] of sizes) {
    const images = makeImages(width, height);
    const frame = { width, height, ...images };
    const hostCopySeconds = measureHostCopies(frame, warmCount);
    for (const device of devices) {
      const row = { width, height, device, hostCopyThreeImagesSeconds: hostCopySeconds };
      try {
        row.tool = await measureTool(binary, frame, device, warmCount);
        const toolOutput = await denoiseWithOidn({ ...frame, device });
        const inProcess = await measureInProcess(frame, device, warmCount);
        const { firstOutput, warmOutput, againOutput } = inProcess.outputs;
        delete inProcess.outputs;
        row.inProcess = inProcess;
        row.equality = {
          toolVsWarm: { maxAbsoluteDifference: maxAbsoluteDifference(toolOutput, warmOutput), byteIdentical: byteIdentical(toolOutput, warmOutput) },
          firstVsWarm: { maxAbsoluteDifference: maxAbsoluteDifference(firstOutput, warmOutput), byteIdentical: byteIdentical(firstOutput, warmOutput) },
          warmVsAfterRecommit: { maxAbsoluteDifference: maxAbsoluteDifference(againOutput, warmOutput), byteIdentical: byteIdentical(againOutput, warmOutput) },
        };
        row.speedupWarmVersusTool = round(row.tool.totalSeconds / inProcess.warm.wallSeconds);
      } catch (error) {
        row.error = String(error.message).slice(0, 600);
      }
      result.rows.push(row);
      console.log('ROW', JSON.stringify(row));
    }
  }
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, JSON.stringify(result, null, 1));
  console.log('WROTE', outputPath);
}

await main();
