import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { constants, setPriority, tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createFrameEncoder } from './frame-encoder.mjs';
setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL);
const directory = await mkdtemp(join(tmpdir(), 'crucible-frame-encoder-'));
function run(executable, argumentsValue, binary = false) {
  const result = spawnSync(executable, argumentsValue, { windowsHide: true, encoding: binary ? undefined : 'utf8', maxBuffer: 16 * 1024 * 1024 });
  assert.equal(result.status, 0, String(result.stderr));
  return result.stdout;
}
function frame(color) {
  return run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=${color}:s=64x64`, '-frames:v', '1', '-threads', '1', '-f', 'image2pipe', '-vcodec', 'png', 'pipe:1'], true);
}
const frames = [frame('red'), frame('blue')];
const output = join(directory, 'render.mp4.partial');
const encoder = createFrameEncoder({ output, fps: 4, format: 'png' });
let metrics;
try {
  for (let index = 0; index < 8; index++) await encoder.writeFrame(frames[index % 2]);
  metrics = await encoder.finish();
} finally { await encoder.close(); }
assert.equal(metrics.frames, 8);
assert.equal(metrics.maximumPendingFrames, 1);
assert.throws(() => process.kill(encoder.pid, 0), /ESRCH/);
const probe = JSON.parse(run('ffprobe', ['-v', 'error', '-count_frames', '-show_entries', 'stream=width,height,codec_name,nb_read_frames,color_space:format=duration,size', '-of', 'json', output]));
assert.equal(probe.streams[0].codec_name, 'h264');
assert.equal(probe.streams[0].nb_read_frames, '8');
assert.equal(probe.streams[0].width, 64);
assert.equal(probe.streams[0].color_space, 'bt709');
assert.equal(Number(probe.format.duration), 2);
const decoded = run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', output, '-frames:v', '2', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], true);
assert.notDeepEqual(decoded.subarray(0, 64 * 64 * 3), decoded.subarray(64 * 64 * 3));
// Raw frames are bottom-up RGBA, as readPixels gives them: the first row written (red) must decode at the bottom.
const rawPixels = Buffer.alloc(64 * 64 * 4);
for (let row = 0; row < 64; row++) {
  for (let column = 0; column < 64; column++) {
    const offset = (row * 64 + column) * 4;
    rawPixels[offset + (row < 32 ? 0 : 2)] = 255;
    rawPixels[offset + 3] = 255;
  }
}
const rawOutput = join(directory, 'raw.mp4.partial');
const rawEncoder = createFrameEncoder({ output: rawOutput, fps: 4, format: 'rawvideo', width: 64, height: 64 });
try {
  for (let index = 0; index < 4; index++) await rawEncoder.writeFrame(rawPixels);
  await rawEncoder.finish();
} finally { await rawEncoder.close(); }
const rawDecoded = run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', rawOutput, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], true);
const pixelAt = (row) => rawDecoded.subarray((row * 64 + 32) * 3, (row * 64 + 32) * 3 + 3);
assert.ok(pixelAt(60)[0] > 200 && pixelAt(60)[2] < 60, 'the first row written must decode at the bottom as red');
assert.ok(pixelAt(4)[2] > 200 && pixelAt(4)[0] < 60, 'the last rows written must decode at the top as blue');
assert.throws(() => createFrameEncoder({ output: rawOutput, fps: 4, format: 'rawvideo' }), /width and a height/);
const cancelled = new AbortController();
const abortEncoder = createFrameEncoder({ output: join(directory, 'cancel.mp4.partial'), fps: 24, format: 'png', signal: cancelled.signal });
await abortEncoder.writeFrame(frames[0]);
cancelled.abort(new Error('Native cancellation proof'));
await assert.rejects(abortEncoder.writeFrame(frames[1]), /Native cancellation proof/);
await abortEncoder.close();
assert.throws(() => process.kill(abortEncoder.pid, 0), /ESRCH/);
const capped = createFrameEncoder({ output: join(directory, 'limit.mp4.partial'), fps: 4, format: 'png', maximumOutputBytes: 1 });
try {
  await assert.rejects(async () => {
    await capped.writeFrame(frames[0]);
    await capped.finish();
  }, /byte budget/);
} finally { await capped.close(); }
const unavailable = createFrameEncoder({ executable: join(directory, 'missing-encoder'), output: join(directory, 'missing.mp4'), fps: 4 });
await assert.rejects(unavailable.finish(), /encoder stopped/i);
await unavailable.close();
await writeFile('artifacts/frame-encoder-proof.mp4', await readFile(output));
const report = { frames: 8, duration: 2, codec: 'h264', colorSpace: 'bt709', bytes: (await stat(output)).size,
  metrics, decodedFramesDiffer: true, cancellationExited: true, outputLimitRejects: true, missingExecutableRejects: true };
await writeFile('artifacts/frame-encoder-proof.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
