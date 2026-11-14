// Measures frame-to-frame flicker of a native path traced video with and without the temporal blend (issue 1120).
//   node bench/native-tracer/temporal-job.mjs <output directory> [--browser <chrome path>] [--runtime-backend gpu|cpu] [--samples 32] [--width 960] [--height 540] [--ffmpeg ffmpeg] [--reuse plain,reference]
// `--reuse` scores the named videos from the output directory instead of rendering them again.
// The scene is the demo room lit only by the area light in its window and the sky through the open front, with the particle
// systems and every track but the camera removed, so the session reuses the scene and only the camera moves. The camera drifts
// slowly into the room for 2 s, then cuts to another view and holds it for 1 s. The job runs three times through the MCP
// server: with the blend, with JS67_NATIVE_TEMPORAL=off, and with it off at 256 samples as the reference that shows how much of
// the score is the camera's own motion. The videos are read back as 8-bit grey frames.
// The score is the mean of |f[t+1] - 2 f[t] + f[t-1]| over the pixels and the frames of the fly-through: smooth camera motion
// cancels in it and noise that changes from frame to frame stays. `againstReference` is the mean absolute difference from the
// reference video, which shows a blend that lags or dims the picture. Prints one TEMPORAL_JOB line of JSON and exits 1 when
// the blended video scores 1.5 or more, or when a frame did not render on the native tracer.
import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const runFile = promisify(execFile);
const argumentList = process.argv.slice(2);
const outputDirectory = resolve(argumentList[0]);
const flag = (name, fallback) => (argumentList.includes(name) ? argumentList[argumentList.indexOf(name) + 1] : fallback);
const width = Number(flag('--width', 960));
const height = Number(flag('--height', 540));
const samples = Number(flag('--samples', 32));
const browserPath = flag('--browser', '');
const runtimeBackend = flag('--runtime-backend', 'gpu');
const ffmpegPath = flag('--ffmpeg', 'ffmpeg');
const reusedNames = flag('--reuse', '').split(',').filter(Boolean);
const FPS = 24;
const FLY_SECONDS = 2;
const TOTAL_SECONDS = 3;
const FLY_FRAMES = FPS * FLY_SECONDS;
const SCORE_LIMIT = 1.5;
const REFERENCE_SAMPLES = 256;
const WINDOW_LIGHT_INTENSITY = 220;

function cameraTrack(property, flyStart, flyEnd, afterCut) {
  const keyframes = [
    { time: 0, value: flyStart },
    { time: FLY_SECONDS - 0.001, value: flyEnd },
    { time: FLY_SECONDS, value: afterCut },
    { time: TOTAL_SECONDS, value: afterCut },
  ];
  return { kind: 'camera', property, interpolation: 'LINEAR', keyframes };
}

function windowLitRoom(recipe) {
  const kept = Object.fromEntries(Object.entries(recipe).filter(([key]) => key !== 'particles' && key !== 'timeline'));
  const windowLight = { ...recipe.environment.areaLights[0], intensity: WINDOW_LIGHT_INTENSITY };
  const environment = { ...recipe.environment, pointLights: [], spotLights: [], areaLights: [windowLight] };
  const tracks = [
    cameraTrack('eye', [1.4, 2.1, 7], [1.3, 2.075, 6.85], [3.9, 0.6, 2.8]),
    cameraTrack('target', [0, 1.6, -2], [0.025, 1.6125, -2], [0.3, 1.5, -2.3]),
    cameraTrack('fov', 50, 50, 55),
  ];
  return { ...kept, environment, motion: { duration: TOTAL_SECONDS, loop: false, tracks } };
}

async function renderVideo(recipe, { name, blend, jobSamples }) {
  const workDirectory = await mkdtemp(join(tmpdir(), 'crucible-temporal-job-'));
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [resolve('bin/crucible-mcp.mjs'), '--backend', runtimeBackend, '--memory', '384', '--jobs', join(workDirectory, 'jobs'), ...(browserPath ? ['--browser', browserPath] : [])],
    cwd: workDirectory, stderr: 'pipe', env: { ...process.env, JS67_NATIVE_TEMPORAL: blend ? 'on' : 'off' } });
  let diagnostics = '';
  transport.stderr.on('data', bytes => { diagnostics = (diagnostics + bytes).slice(-4096); });
  const client = new Client({ name: 'crucible-temporal-job', version: '1' });
  const call = (name, toolArguments) => client.callTool({ name, arguments: toolArguments }, { timeout: 600000 });
  try {
    await client.connect(transport);
    const createResult = await call('scene_create', { recipe });
    const created = createResult.structuredContent;
    if (!created) throw new Error(`scene_create failed: ${createResult.content?.[0]?.text}`);
    const settings = { kind: 'video', fps: FPS, duration: TOTAL_SECONDS, motion: { start: 0 }, width, height,
      renderer: { type: 'pathTracer', backend: 'native', samples: jobSamples, bounces: 6, maxSeconds: 120, seed: 3 } };
    const submitted = await call('scene_render_submit', { sessionId: created.sessionId, expectedRevision: 0, settings });
    if (submitted.isError) throw new Error(submitted.content?.[0]?.text);
    const { jobId } = submitted.structuredContent;
    let record;
    for (;;) {
      record = (await call('scene_render_status', { jobId })).structuredContent;
      if (['completed', 'cancelled', 'failed'].includes(record.state)) break;
      await delay(250);
    }
    if (record.state !== 'completed') throw new Error(`job ${record.state}: ${JSON.stringify(record.reason ?? record.error)}`);
    const result = (await call('scene_render_result', { jobId })).structuredContent;
    const video = result.artifacts.find(artifact => artifact.path.endsWith('.mp4'));
    if (!video) throw new Error(`the job wrote no mp4: ${JSON.stringify(result.artifacts.map(artifact => artifact.path))}`);
    const videoPath = join(outputDirectory, `${name}.mp4`);
    await copyFile(video.path, videoPath);
    const pathTracer = result.metrics.pathTracer ?? {};
    await call('scene_render_release', { jobId });
    return { videoPath, renderSeconds: record.seconds ?? null, backend: pathTracer.backend, backendNote: pathTracer.backendNote, denoiser: pathTracer.denoiser,
      routes: result.metrics.nativeSessionRoutes ?? [], lastFrameTemporal: pathTracer.temporal ?? null };
  } catch (error) {
    console.error(diagnostics);
    throw error;
  } finally {
    await client.close();
  }
}

async function greyFrames(videoPath) {
  const { stdout } = await runFile(ffmpegPath, ['-v', 'error', '-i', videoPath, '-f', 'rawvideo', '-pix_fmt', 'gray', '-'],
    { encoding: 'buffer', maxBuffer: width * height * FPS * TOTAL_SECONDS * 2 });
  const frameBytes = width * height;
  const frames = [];
  for (let offset = 0; offset + frameBytes <= stdout.length; offset += frameBytes) {
    frames.push(stdout.subarray(offset, offset + frameBytes));
  }
  return frames;
}

// Mean of |f[t+1] - 2 f[t] + f[t-1]| over the pixels, for every t whose three frames lie in [firstFrame, lastFrame].
function flickerScores(frames, firstFrame, lastFrame) {
  const scores = [];
  for (let middle = firstFrame + 1; middle < lastFrame; middle++) {
    const before = frames[middle - 1];
    const current = frames[middle];
    const after = frames[middle + 1];
    let total = 0;
    for (let pixel = 0; pixel < current.length; pixel++) {
      total += Math.abs(after[pixel] - 2 * current[pixel] + before[pixel]);
    }
    scores.push(total / current.length);
  }
  return scores;
}

// Mean absolute difference between two videos over the frames [firstFrame, lastFrame], in 8-bit grey levels.
function meanDifference(frames, referenceFrames, firstFrame, lastFrame) {
  let total = 0;
  for (let frame = firstFrame; frame <= lastFrame; frame++) {
    const current = frames[frame];
    const reference = referenceFrames[frame];
    for (let pixel = 0; pixel < current.length; pixel++) {
      total += Math.abs(current[pixel] - reference[pixel]);
    }
  }
  return Number((total / ((lastFrame - firstFrame + 1) * frames[firstFrame].length)).toFixed(3));
}

function summarize(scores) {
  const mean = scores.reduce((sum, score) => sum + score, 0) / scores.length;
  return { mean: Number(mean.toFixed(3)), lowest: Number(Math.min(...scores).toFixed(3)), highest: Number(Math.max(...scores).toFixed(3)) };
}

async function writeStill(videoPath, frame, name) {
  await runFile(ffmpegPath, ['-v', 'error', '-y', '-i', videoPath, '-vf', `select=eq(n\\,${frame})`, '-frames:v', '1', join(outputDirectory, name)]);
}

await mkdir(outputDirectory, { recursive: true });
const recipe = windowLitRoom(JSON.parse(await readFile('tests/fixtures/demo-room.recipe.json', 'utf8')));
const report = { width, height, samples, fps: FPS, flyFrames: FLY_FRAMES, frames: FPS * TOTAL_SECONDS, scoreLimit: SCORE_LIMIT };
let failed = false;
const variants = [
  { name: 'blended', blend: true, jobSamples: samples },
  { name: 'plain', blend: false, jobSamples: samples },
  { name: 'reference', blend: false, jobSamples: REFERENCE_SAMPLES },
];
const framesByName = {};
for (const variant of variants) {
  const { name } = variant;
  if (reusedNames.includes(name)) {
    const frames = await greyFrames(join(outputDirectory, `${name}.mp4`));
    framesByName[name] = frames;
    report[name] = { samples: variant.jobSamples, fly: summarize(flickerScores(frames, 0, FLY_FRAMES - 1)),
      afterCut: summarize(flickerScores(frames, FLY_FRAMES, frames.length - 1)), frameCount: frames.length, reused: true };
    continue;
  }
  const rendered = await renderVideo(recipe, variant);
  const frames = await greyFrames(rendered.videoPath);
  framesByName[name] = frames;
  const fly = summarize(flickerScores(frames, 0, FLY_FRAMES - 1));
  const afterCut = summarize(flickerScores(frames, FLY_FRAMES, frames.length - 1));
  for (const frame of [FLY_FRAMES - 1, FLY_FRAMES, FLY_FRAMES + 1]) {
    await writeStill(rendered.videoPath, frame, `${name}-frame-${frame}.png`);
  }
  const laterRoutes = rendered.routes.slice(1);
  const allReused = laterRoutes.length === frames.length - 1 && laterRoutes.every(route => route === 'reused');
  report[name] = { samples: variant.jobSamples, fly, afterCut, frameCount: frames.length, backend: rendered.backend, backendNote: rendered.backendNote, denoiser: rendered.denoiser,
    allLaterFramesReused: allReused, lastFrameTemporal: rendered.lastFrameTemporal, renderSeconds: rendered.renderSeconds };
  if (rendered.backend !== 'native' || !allReused) failed = true;
}
for (const name of ['blended', 'plain']) {
  report[name].againstReference = { fly: meanDifference(framesByName[name], framesByName.reference, 0, FLY_FRAMES - 1),
    afterCut: meanDifference(framesByName[name], framesByName.reference, FLY_FRAMES, framesByName[name].length - 1) };
}
if (!(report.blended.fly.mean < SCORE_LIMIT)) failed = true;
await writeFile(join(outputDirectory, 'temporal-job.json'), JSON.stringify(report, null, 1));
console.log(`TEMPORAL_JOB ${JSON.stringify(report)}`);
process.exit(failed ? 1 : 0);
