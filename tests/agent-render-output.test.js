import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';

import { createAgentRenderJobs, artifactNames } from '../scripts/agent-render-jobs.mjs';
import { encodePng16, encodeExr, encodeRenderOutput, toHalfBits } from '../scripts/render-output-encoders.mjs';

const limits = { maxOutputBytes: 1024 ** 2, maxFrameBytes: 128, maxStoreBytes: 8 * 1024 ** 2, cleanupMs: 100 };
const submission = settings => ({ sourceRevision: 1, snapshot: { recipe: { format: 'fixture' } }, settings });

async function withController(context, run) {
  const root = await mkdtemp(join(tmpdir(), 'crucible-render-output-'));
  const controller = await createAgentRenderJobs({ root, limits, run });
  context.after(async () => {
    await controller.close();
    await rm(root, { recursive: true, force: true });
  });
  return controller;
}

// A runner that records the settings it got and writes the artifacts those settings name, with the right MIME types.
function recordingRunner(seen) {
  return async ({ directory, settings, progress }) => {
    seen.push(settings);
    const mimeType = settings.kind === 'video' ? 'video/mp4' : settings.format === 'exr' ? 'image/x-exr' : 'image/png';
    const artifacts = [];
    for (const filename of artifactNames(settings.kind, settings.passes, settings.format)) {
      await writeFile(join(directory, `${filename}.partial`), Buffer.alloc(100, 1));
      artifacts.push({ temporary: `${filename}.partial`, filename, mimeType });
    }
    await progress({ frames: settings.frameCount, maximumPendingFrames: 1 });
    return { artifacts, metrics: {} };
  };
}

async function finished(controller, settings) {
  const { jobId } = await controller.submit(submission(settings));
  while (controller.status(jobId).state === 'queued' || controller.status(jobId).state === 'running' || controller.status(jobId).state === 'finalizing') {
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  return { status: controller.status(jobId), result: controller.status(jobId).state === 'completed' ? controller.result(jobId) : undefined };
}

test('defaults leave transparent, format and region out of the settings, so a plain job is unchanged', async context => {
  const seen = [];
  const controller = await withController(context, recordingRunner(seen));
  const { status, result } = await finished(controller, { kind: 'stills', width: 64, height: 64, passes: ['depth'] });
  assert.deepEqual(Object.keys(status.settings).sort(), ['duration', 'fps', 'frameCount', 'height', 'kind', 'passes', 'rendererTime', 'width']);
  assert.equal(result.artifacts.length, 16);
  assert.ok(result.artifacts.every(artifact => artifact.mimeType === 'image/png' && artifact.filename.endsWith('.png')));
  const explicit = await finished(controller, { kind: 'image', width: 64, height: 64, transparent: false, format: 'png' });
  assert.equal('transparent' in explicit.status.settings || 'format' in explicit.status.settings, false);
});

test('transparent is kept for an image job and refused for video and the path tracer', async context => {
  const seen = [];
  const controller = await withController(context, recordingRunner(seen));
  const { status } = await finished(controller, { kind: 'image', width: 64, height: 64, transparent: true });
  assert.equal(status.state, 'completed');
  assert.equal(status.settings.transparent, true);
  await assert.rejects(controller.submit(submission({ kind: 'video', width: 64, height: 64, transparent: true })), /no alpha/);
  await assert.rejects(controller.submit(submission({ kind: 'image', width: 64, height: 64, transparent: true, renderer: { type: 'pathTracer' } })), /transparent cannot combine/);
  await assert.rejects(controller.submit(submission({ kind: 'image', width: 64, height: 64, transparent: 1 })), /transparent must be boolean/);
});

test('png16 and exr jobs name their files and MIME types, and pass files follow the format', async context => {
  const seen = [];
  const controller = await withController(context, recordingRunner(seen));
  const exr = await finished(controller, { kind: 'image', width: 64, height: 64, format: 'exr', passes: ['depth', 'objectId'] });
  assert.deepEqual(exr.result.artifacts.map(artifact => artifact.filename), ['render.exr', 'render-depth.exr', 'render-objectId.exr']);
  assert.ok(exr.result.artifacts.every(artifact => artifact.mimeType === 'image/x-exr'));
  const png16 = await finished(controller, { kind: 'stills', width: 64, height: 64, format: 'png16' });
  assert.equal(png16.status.settings.format, 'png16');
  assert.equal(png16.result.artifacts.length, 8);
  assert.ok(png16.result.artifacts.every(artifact => artifact.mimeType === 'image/png' && artifact.filename.endsWith('.png')));
  await assert.rejects(controller.submit(submission({ kind: 'image', width: 64, height: 64, format: 'tiff' })), /format must be one of png, png16, exr/);
  await assert.rejects(controller.submit(submission({ kind: 'video', width: 64, height: 64, format: 'exr' })), /format needs kind image or stills/);
  await assert.rejects(controller.submit(submission({ kind: 'image', width: 64, height: 64, format: 'exr', renderer: { type: 'pathTracer' } })), /format cannot combine/);
});

test('a high-precision frame may be four times the 8-bit frame limit', async context => {
  const controller = await withController(context, async ({ directory, settings, progress }) => {
    const filename = `render.${settings.format === 'exr' ? 'exr' : 'png'}`;
    await writeFile(join(directory, `${filename}.partial`), Buffer.alloc(limits.maxFrameBytes * 3, 1));
    await progress({ frames: 1, maximumPendingFrames: 1 });
    return { artifacts: [{ temporary: `${filename}.partial`, filename, mimeType: settings.format === 'exr' ? 'image/x-exr' : 'image/png' }], metrics: {} };
  });
  assert.equal((await finished(controller, { kind: 'image', width: 64, height: 64, format: 'exr' })).status.state, 'completed');
  assert.equal((await finished(controller, { kind: 'image', width: 64, height: 64 })).status.state, 'failed');
});

test('a region must lie inside the frame, and a video region keeps even sides', async context => {
  const seen = [];
  const controller = await withController(context, recordingRunner(seen));
  const region = { x: 8, y: 4, width: 32, height: 24 };
  const { status } = await finished(controller, { kind: 'image', width: 64, height: 64, region });
  assert.deepEqual(status.settings.region, region);
  await assert.rejects(controller.submit(submission({ kind: 'image', width: 64, height: 64, region: { x: 40, y: 0, width: 32, height: 32 } })), /inside the frame/);
  await assert.rejects(controller.submit(submission({ kind: 'image', width: 64, height: 64, region: { x: 0, y: 0, width: 8, height: 32 } })), /region width/);
  await assert.rejects(controller.submit(submission({ kind: 'image', width: 64, height: 64, region: { x: 0, y: 0, width: 32, height: 32, extra: 1 } })), /Unknown region field/);
  await assert.rejects(controller.submit(submission({ kind: 'video', width: 64, height: 64, region: { x: 0, y: 0, width: 31, height: 32 } })), /even width and height/);
  await assert.rejects(controller.submit(submission({ kind: 'image', width: 64, height: 64, region, renderer: { type: 'pathTracer' } })), /region cannot combine/);
  const video = await finished(controller, { kind: 'video', width: 64, height: 64, region });
  assert.deepEqual(video.status.settings.region, region);
});

test('a video may run at 60 fps and no faster', async context => {
  const seen = [];
  const controller = await withController(context, recordingRunner(seen));
  const { status } = await finished(controller, { kind: 'video', width: 64, height: 64, fps: 60, duration: 0.5 });
  assert.equal(status.settings.fps, 60);
  assert.equal(status.settings.frameCount, 30);
  await assert.rejects(controller.submit(submission({ kind: 'video', width: 64, height: 64, fps: 61 })), /fps must be within 1 and 60/);
  await assert.rejects(controller.submit(submission({ kind: 'video', width: 64, height: 64, fps: 60, duration: 16 })), /900 frames/);
});

test('options survive a restart of the job store', async context => {
  const root = await mkdtemp(join(tmpdir(), 'crucible-render-output-'));
  const first = await createAgentRenderJobs({ root, limits, run: recordingRunner([]) });
  const settings = { kind: 'image', width: 64, height: 64, format: 'exr', transparent: true, region: { x: 0, y: 0, width: 32, height: 32 } };
  const { jobId } = await first.submit(submission(settings));
  while (!['completed', 'failed'].includes(first.status(jobId).state)) await new Promise(resolve => setTimeout(resolve, 2));
  await first.close();
  const second = await createAgentRenderJobs({ root, limits, run: recordingRunner([]) });
  context.after(async () => {
    await second.close();
    await rm(root, { recursive: true, force: true });
  });
  assert.equal(second.status(jobId).state, 'completed');
  assert.equal(second.status(jobId).settings.format, 'exr');
  assert.equal(second.result(jobId).artifacts[0].mimeType, 'image/x-exr');
});

// Encoders

function decodePng16(bytes) {
  assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  assert.equal(bytes[24], 16);
  const channels = { 0: 1, 2: 3, 6: 4 }[bytes[25]];
  const data = [];
  let offset = 8;
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset);
    if (bytes.toString('latin1', offset + 4, offset + 8) === 'IDAT') data.push(bytes.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(data));
  const rowBytes = width * channels * 2;
  const samples = [];
  for (let row = 0; row < height; row++) {
    const line = Buffer.from(raw.subarray(row * (rowBytes + 1) + 1, (row + 1) * (rowBytes + 1)));
    assert.equal(raw[row * (rowBytes + 1)], 1);
    for (let index = channels * 2; index < rowBytes; index++) line[index] = (line[index] + line[index - channels * 2]) & 0xff;
    for (let index = 0; index < rowBytes; index += 2) samples.push(line.readUInt16BE(index));
  }
  return { width, height, channels, samples };
}

test('encodePng16 writes 16-bit samples that decode back exactly', () => {
  const samples = Uint16Array.from([0, 1, 255, 256, 65535, 12345, 40000, 7, 500, 65534, 3, 9]);
  for (const [channels, width, height] of [[1, 4, 3], [3, 2, 2], [4, 3, 1]]) {
    const decoded = decodePng16(encodePng16(samples.subarray(0, width * height * channels), width, height, channels));
    assert.deepEqual([decoded.width, decoded.height, decoded.channels], [width, height, channels]);
    assert.deepEqual(decoded.samples, [...samples.subarray(0, width * height * channels)]);
  }
  assert.throws(() => encodePng16(samples, 2, 2, 2), /1, 3 or 4 channels/);
});

test('toHalfBits rounds to IEEE half floats and clamps to the finite range', () => {
  assert.equal(toHalfBits(0), 0);
  assert.equal(toHalfBits(1), 0x3c00);
  assert.equal(toHalfBits(-2), 0xc000);
  assert.equal(toHalfBits(0.5), 0x3800);
  assert.equal(toHalfBits(65504), 0x7bff);
  assert.equal(toHalfBits(1e9), 0x7bff);
  assert.equal(toHalfBits(Number.NaN), 0);
  assert.equal(toHalfBits(1 / 3), 0x3555);
});

/** Reads an EXR written by encodeExr back into one float array per channel, undoing the ZIP step. */
function decodeExr(bytes) {
  assert.deepEqual([...bytes.subarray(0, 4)], [0x76, 0x2f, 0x31, 0x01]);
  let offset = 8;
  const attributes = {};
  while (bytes[offset] !== 0) {
    const nameEnd = bytes.indexOf(0, offset);
    const name = bytes.toString('latin1', offset, nameEnd);
    const typeEnd = bytes.indexOf(0, nameEnd + 1);
    const size = bytes.readInt32LE(typeEnd + 1);
    attributes[name] = bytes.subarray(typeEnd + 5, typeEnd + 5 + size);
    offset = typeEnd + 5 + size;
  }
  offset += 1;
  const window = attributes.dataWindow;
  const width = window.readInt32LE(8) + 1;
  const height = window.readInt32LE(12) + 1;
  const channels = [];
  let position = 0;
  while (attributes.channels[position] !== 0) {
    const nameEnd = attributes.channels.indexOf(0, position);
    channels.push({ name: attributes.channels.toString('latin1', position, nameEnd), pixelType: attributes.channels.readInt32LE(nameEnd + 1) });
    position = nameEnd + 17;
  }
  const rowsPerBlock = 16;
  const blockCount = Math.ceil(height / rowsPerBlock);
  const output = Object.fromEntries(channels.map(channel => [channel.name, new Float32Array(width * height)]));
  const bytesPerPixel = channels.reduce((total, channel) => total + (channel.pixelType === 2 ? 4 : 2), 0);
  for (let block = 0; block < blockCount; block++) {
    const start = Number(bytes.readBigUInt64LE(offset + block * 8));
    const firstRow = bytes.readInt32LE(start);
    const dataSize = bytes.readInt32LE(start + 4);
    const rowCount = Math.min(rowsPerBlock, height - firstRow);
    const expected = rowCount * width * bytesPerPixel;
    let raw = bytes.subarray(start + 8, start + 8 + dataSize);
    if (dataSize < expected) {
      const delta = Buffer.from(inflateSync(raw));
      for (let index = 1; index < delta.length; index++) delta[index] = (delta[index - 1] + delta[index] - 128) & 0xff;
      raw = Buffer.alloc(delta.length);
      const half = (delta.length + 1) >> 1;
      for (let index = 0; index < delta.length; index++) raw[index] = delta[index % 2 === 0 ? index / 2 : half + (index - 1) / 2];
    }
    let read = 0;
    for (let row = 0; row < rowCount; row++) {
      for (const channel of channels) {
        for (let column = 0; column < width; column++) {
          if (channel.pixelType === 2) {
            output[channel.name][(firstRow + row) * width + column] = raw.readFloatLE(read);
            read += 4;
          } else {
            const bits = raw.readUInt16LE(read);
            const exponent = (bits >> 10) & 0x1f;
            const mantissa = bits & 0x3ff;
            const magnitude = exponent === 0 ? mantissa * 2 ** -24 : (1 + mantissa / 1024) * 2 ** (exponent - 15);
            output[channel.name][(firstRow + row) * width + column] = bits & 0x8000 ? -magnitude : magnitude;
            read += 2;
          }
        }
      }
    }
  }
  return { width, height, channels: channels.map(channel => channel.name), compression: attributes.compression[0], values: output };
}

test('encodeExr writes ZIP scanline blocks that decode back, in channel name order', () => {
  const width = 37;
  const height = 35;
  const red = Float32Array.from({ length: width * height }, (_, index) => (index % 11) / 4);
  const alpha = Float32Array.from({ length: width * height }, (_, index) => (index % 3 === 0 ? 0 : 1));
  const depth = Float32Array.from({ length: width * height }, (_, index) => index * 0.37);
  const colour = decodeExr(encodeExr(width, height, [{ name: 'R', type: 'half', values: red }, { name: 'A', type: 'half', values: alpha }]));
  assert.deepEqual(colour.channels, ['A', 'R']);
  assert.equal(colour.compression, 3);
  assert.deepEqual([...colour.values.R], [...red]);
  assert.deepEqual([...colour.values.A], [...alpha]);
  const metres = decodeExr(encodeExr(width, height, [{ name: 'Z', type: 'float', values: depth }]));
  assert.deepEqual([...metres.values.Z], [...depth]);
});

function floatPixels(width, height, make) {
  const pixels = new Float32Array(width * height * 4);
  for (let row = 0; row < height; row++) {
    for (let column = 0; column < width; column++) pixels.set(make(column, height - 1 - row), (row * width + column) * 4);
  }
  return pixels;
}

test('encodeRenderOutput flips the bottom-up readback and decodes depth, object IDs and premultiplied alpha', () => {
  // Pixel (column, topRow); the readback holds the bottom row first.
  const pixels = floatPixels(2, 2, (column, topRow) => {
    const steps = topRow * 2 + column + 1;
    return [Math.floor(steps / 256) / 255, (steps % 256) / 255, 0, 1];
  });
  const depth = decodeExr(encodeRenderOutput({ format: 'exr', pixels, width: 2, height: 2, pass: 'depth', depthRange: 65535 }));
  assert.deepEqual([...depth.values.Z], [1, 2, 3, 4]);
  const depthPng = decodePng16(encodeRenderOutput({ format: 'png16', pixels, width: 2, height: 2, pass: 'depth' }));
  assert.deepEqual([depthPng.channels, depthPng.samples], [1, [1, 2, 3, 4]]);

  const identifiers = floatPixels(2, 1, column => [(column + 1) / 255, 1 / 255, 0, 1]);
  const identifierExr = decodeExr(encodeRenderOutput({ format: 'exr', pixels: identifiers, width: 2, height: 1, pass: 'objectId' }));
  assert.deepEqual([...identifierExr.values.id], [257, 258]);
  const tooMany = floatPixels(1, 1, () => [0, 0, 1 / 255, 1]);
  assert.throws(() => encodeRenderOutput({ format: 'png16', pixels: tooMany, width: 1, height: 1, pass: 'objectId' }), /exr/);

  const lit = floatPixels(2, 1, column => (column === 0 ? [0.25, 0.25, 0.25, 0.5] : [0, 0, 0, 0]));
  const litPng = decodePng16(encodeRenderOutput({ format: 'png16', pixels: lit, width: 2, height: 1, hasAlpha: true }));
  assert.deepEqual(litPng.samples, [32768, 32768, 32768, 32768, 0, 0, 0, 0]);
  const opaquePng = decodePng16(encodeRenderOutput({ format: 'png16', pixels: lit, width: 2, height: 1 }));
  assert.equal(opaquePng.channels, 3);
  const litExr = decodeExr(encodeRenderOutput({ format: 'exr', pixels: lit, width: 2, height: 1, hasAlpha: true }));
  assert.deepEqual(litExr.channels, ['A', 'B', 'G', 'R']);
  assert.deepEqual([...litExr.values.R], [0.25, 0]);
  assert.throws(() => encodeRenderOutput({ format: 'bmp', pixels: lit, width: 2, height: 1 }), /png16 or exr/);
  assert.throws(() => encodeRenderOutput({ format: 'exr', pixels: lit, width: 3, height: 1 }), /pixel count/);
});
