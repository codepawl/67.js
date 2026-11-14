// Proves the timeline through the real MCP runtime: a seek to any time gives the same PNG bytes as that frame inside a
// sequence, across shots and in any order of seeks; and a video with sound keeps picture and sound in sync, measured
// by finding the cut in the decoded frames and the click in the decoded audio.
// Usage: node scripts/smoke-film-timeline.mjs [cli] [cpu|gpu]. FILM_SECONDS=60 renders the long case (15 fps, 900 frames).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir, constants, setPriority } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL);
const directory = await mkdtemp(join(tmpdir(), 'crucible-mcp-timeline-'));
const jobs = join(directory, 'jobs');
const audioFolder = join(directory, 'audio');
await mkdir(audioFolder);
const cli = resolve(process.argv[2] ?? 'bin/crucible-mcp.mjs');
const backend = process.argv[3] ?? 'cpu';
const transport = new StdioClientTransport({ command: process.execPath,
  args: [cli, '--backend', backend, '--memory', '128', '--jobs', jobs, '--audio', audioFolder], cwd: directory, stderr: 'pipe' });
let diagnostics = '';
transport.stderr.on('data', bytes => { diagnostics = (diagnostics + bytes).slice(-8192); });
const client = new Client({ name: 'crucible-timeline-proof', version: '1' });
const SIZE = 128;
const FILM_SECONDS = Number(process.env.FILM_SECONDS ?? 6);
const FRAMES_PER_SECOND = FILM_SECONDS > 30 ? 15 : 10;
const SAMPLE_RATE = 16000;

async function call(name, argumentsValue = {}, timeout = 60000) {
  const result = await client.callTool({ name, arguments: argumentsValue }, { timeout });
  assert.equal(result.isError, undefined, result.content?.find(item => item.type === 'text')?.text);
  return result;
}

async function expectError(name, argumentsValue, pattern) {
  const result = await client.callTool({ name, arguments: argumentsValue }, { timeout: 60000 });
  assert.equal(result.isError, true, `${name} should have been rejected.`);
  assert.match(result.content.find(item => item.type === 'text').text, pattern);
}

async function finished(jobId, seconds = 900) {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    const record = (await call('scene_render_status', { jobId })).structuredContent;
    if (['completed', 'cancelled', 'failed'].includes(record.state)) return record;
    await delay(200);
  }
  throw new Error('Job did not finish in time.');
}

async function runJob(sessionId, settings) {
  const submitted = (await call('scene_render_submit', { sessionId, expectedRevision: 0, settings })).structuredContent;
  const record = await finished(submitted.jobId);
  assert.equal(record.state, 'completed', record.reason);
  const result = (await call('scene_render_result', { jobId: submitted.jobId })).structuredContent;
  const files = new Map();
  for (const artifact of result.artifacts) {
    const bytes = await readFile(artifact.path);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), artifact.sha256);
    files.set(artifact.path.split(/[\\/]/).pop(), { bytes, path: artifact.path });
  }
  return { files, metrics: result.metrics ?? record.metrics, jobId: submitted.jobId, elapsedSeconds: record.metrics?.elapsedSeconds };
}

// Three shots over a moving sphere: a wide shot, a close shot that fills the frame with light, and a shot that dips in.
function recipe() {
  const shotSeconds = FILM_SECONDS / 3;
  return {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'box', type: 'box' }, { id: 'sphere', type: 'sphere', segments: 24, rings: 16 }],
    materials: [{ id: 'floor', color: [0.05, 0.05, 0.06], roughness: 0.9 }, { id: 'glow', color: [1, 1, 1], emission: 3 }],
    nodes: [
      { id: 'floor', geometry: 'box', material: 'floor', translation: [0, -0.1, 0], scale: [12, 0.2, 12] },
      { id: 'lamp', geometry: 'sphere', material: 'glow', translation: [0, 0.6, 0] },
    ],
    camera: { eye: [0, 1.6, 7], target: [0, 0.5, 0], fov: 40 },
    effects: { motionBlur: { shutter: 0.25 } },
    motion: { duration: 4, loop: true, tracks: [{ kind: 'node', id: 'lamp', property: 'translation', keyframes: [
      { time: 0, value: [-1.5, 0.6, 0] }, { time: 4, value: [1.5, 0.6, 0] },
    ] }] },
    timeline: { shots: [
      { name: 'wide', duration: shotSeconds, camera: { eye: [0, 3, 14], target: [0, -2, 0] } },
      { name: 'close', duration: shotSeconds, motionStart: 1, camera: { eye: [0, 0.6, 2.4], target: [0, 0.6, 0], fov: 50 } },
      { name: 'dusk', duration: shotSeconds, dip: 1, camera: { eye: [4, 1.2, 5], target: [0, 0.5, 0] } },
    ] },
  };
}

// A short click at `clickSeconds` in a silent mono file, so the decoded audio shows where the sound lands.
function clickWav(totalSeconds, clickSeconds) {
  const samples = Math.ceil(totalSeconds * SAMPLE_RATE);
  const pcm = Buffer.alloc(samples * 2);
  const clickStart = Math.round(clickSeconds * SAMPLE_RATE);
  for (let index = 0; index < SAMPLE_RATE * 0.03; index++) {
    pcm.writeInt16LE(Math.round(20000 * Math.sin(2 * Math.PI * 1000 * index / SAMPLE_RATE)), (clickStart + index) * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24); header.writeUInt32LE(SAMPLE_RATE * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

function decode(path, outputArguments) {
  const result = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', path, ...outputArguments, 'pipe:1'], { maxBuffer: 512 * 1024 ** 2 });
  assert.equal(result.status, 0, String(result.stderr));
  return result.stdout;
}

// Finds the first cut as the frame whose picture changes most from the one before it (before any dip), and the click as
// the first decoded audio sample above a threshold, both in seconds from the start of the file.
function measureSync(videoPath, fps, searchEndSeconds) {
  const frameSize = 8 * 8;
  const raw = decode(videoPath, ['-map', '0:v:0', '-vf', 'scale=8:8,format=gray', '-f', 'rawvideo']);
  const frames = [];
  for (let offset = 0; offset + frameSize <= raw.length; offset += frameSize) frames.push(raw.subarray(offset, offset + frameSize));
  const means = frames.map(frame => frame.reduce((sum, value) => sum + value, 0) / frameSize);
  let cutFrame = 1;
  let largestChange = -1;
  for (let frame = 1; frame < Math.min(frames.length, Math.floor(searchEndSeconds * fps)); frame++) {
    let change = 0;
    for (let index = 0; index < frameSize; index++) change += Math.abs(frames[frame][index] - frames[frame - 1][index]);
    if (change > largestChange) {
      largestChange = change;
      cutFrame = frame;
    }
  }
  const audio = decode(videoPath, ['-map', '0:a:0', '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 's16le']);
  let onset = 0;
  while (onset < audio.length / 2 && Math.abs(audio.readInt16LE(onset * 2)) < 3000) onset++;
  const cutAt = cutFrame / fps;
  const clickAt = onset / SAMPLE_RATE;
  return { frames: frames.length, cutAt, clickAt, offsetMilliseconds: (clickAt - cutAt) * 1000, means };
}

try {
  await client.connect(transport);
  const created = (await call('scene_create', { recipe: recipe() }, 180000)).structuredContent;
  const sessionId = created.sessionId;
  const shotSeconds = FILM_SECONDS / 3;
  const timeline = { start: 0 };

  // Seek determinism across shots: eight stills over the whole timeline, then each frame again as a single image,
  // in a shuffled order and twice for one of them. The frames fall in all three shots and on the dip.
  const stills = await runJob(sessionId, { kind: 'stills', width: SIZE, height: SIZE, timeline });
  assert.equal(stills.files.size, 8);
  const distinct = new Set([...stills.files.values()].map(file => createHash('sha256').update(file.bytes).digest('hex')));
  assert.ok(distinct.size >= 7, 'The stills across three shots should almost all differ.');
  const frameTimes = Array.from({ length: 8 }, (unused, frame) => FILM_SECONDS * frame / 7);
  const seekOrder = [5, 0, 3, 7, 3, 1, 6, 2, 4];
  for (const frame of seekOrder) {
    const seek = await runJob(sessionId, { kind: 'image', width: SIZE, height: SIZE, timeline: { start: frameTimes[frame] } });
    assert.deepEqual(seek.files.get('render.png').bytes, stills.files.get(`frame-${frame}.png`).bytes, `Frame ${frame} differs after a seek.`);
  }
  console.log(`seek: ${seekOrder.length} PNG seeks over ${frameTimes.length} stills identical to the byte (${backend}, ${stills.metrics.graphics})`);

  // Hostile settings through the real tool schema.
  await expectError('scene_render_submit', { sessionId, expectedRevision: 0, settings: { kind: 'video', width: SIZE, height: SIZE, encoder: 'libx264 -f lavfi' } }, /encoder|Invalid/i);
  await expectError('scene_render_submit', { sessionId, expectedRevision: 0, settings: { kind: 'video', width: SIZE, height: SIZE, audio: { file: 'http://example.com/a.wav' } } }, /audio|string|Invalid/i);
  await expectError('scene_render_submit', { sessionId, expectedRevision: 0, settings: { kind: 'video', width: SIZE, height: SIZE, audio: { file: '../outside.wav' } } }, /audio/i);
  await expectError('scene_render_submit', { sessionId, expectedRevision: 0, settings: { kind: 'video', width: SIZE, height: SIZE, audio: { file: 'missing.wav' } } }, /not in the audio folder/);
  await expectError('scene_render_submit', { sessionId, expectedRevision: 0, settings: { kind: 'video', width: SIZE, height: SIZE, audio: { file: 'score.wav' }, ffmpegArguments: ['-i', 'x'] } }, /Unrecognized|ffmpegArguments|Invalid/i);

  // Sync: a click placed on the first cut of the timeline, rendered into a video with sound. The audio file is longer
  // than the film, so the click sits at the cut when the offset is zero.
  await writeFile(join(audioFolder, 'score.wav'), clickWav(FILM_SECONDS + 1, shotSeconds));
  await writeFile(join(audioFolder, 'short.wav'), clickWav(1, 0.5));
  const submittedShort = (await call('scene_render_submit', { sessionId, expectedRevision: 0, settings: { kind: 'video', width: SIZE, height: SIZE, fps: FRAMES_PER_SECOND, timeline, audio: { file: 'short.wav' } } })).structuredContent;
  const shortRecord = await finished(submittedShort.jobId);
  assert.equal(shortRecord.state, 'failed');
  assert.match(shortRecord.reason ?? '', /Audio has .* s after its offset/);

  const film = await runJob(sessionId, { kind: 'video', width: SIZE, height: SIZE, fps: FRAMES_PER_SECOND, timeline, audio: { file: 'score.wav' } });
  assert.ok(film.metrics.sync, 'The job must report its sync measurement.');
  assert.deepEqual(film.metrics.shots.map(shot => shot.name), ['wide', 'close', 'dusk']);
  const measured = measureSync(film.files.get('render.mp4').path, FRAMES_PER_SECOND, 2 * shotSeconds - 0.5);
  console.log(`film: ${FILM_SECONDS} s at ${FRAMES_PER_SECOND} fps, ${measured.frames} frames decoded, encoder ${film.metrics.videoEncoder}, ${film.metrics.elapsedSeconds.toFixed(1)} s to render`);
  console.log(JSON.stringify(film.metrics.sync)); console.log(`sync: decoded streams differ by ${(film.metrics.sync.differenceSeconds * 1000).toFixed(1)} ms; cut at ${measured.cutAt.toFixed(3)} s, click at ${measured.clickAt.toFixed(3)} s, offset ${measured.offsetMilliseconds.toFixed(1)} ms`);
  assert.equal(measured.frames, FILM_SECONDS * FRAMES_PER_SECOND);
  assert.ok(Math.abs(measured.offsetMilliseconds) <= 1000 / FRAMES_PER_SECOND + 25, 'Sound lands more than a frame and an encoder delay from the cut.');
  const middleOfDip = Math.round((2 * shotSeconds) * FRAMES_PER_SECOND);
  assert.ok(measured.means[middleOfDip] < measured.means[middleOfDip - 3] / 2, 'The dip should darken the frame at the cut into the last shot.');

  // An offset moves the sound earlier: the click now lands half a second before the cut.
  const windowStart = shotSeconds - 1.5;
  const early = await runJob(sessionId, { kind: 'video', width: SIZE, height: SIZE, fps: FRAMES_PER_SECOND, timeline: { start: windowStart }, duration: 3, audio: { file: 'score.wav', offset: windowStart + 0.5 } });
  const earlyMeasured = measureSync(early.files.get('render.mp4').path, FRAMES_PER_SECOND, 3);
  assert.ok(Math.abs(earlyMeasured.offsetMilliseconds + 500) <= 1000 / FRAMES_PER_SECOND + 25, `An audio offset of 0.5 s should move the click 500 ms earlier, got ${earlyMeasured.offsetMilliseconds.toFixed(1)} ms.`);
  console.log(`timeline smoke passed on ${backend}`);
} catch (error) {
  console.error(diagnostics);
  throw error;
} finally {
  await client.close();
}
