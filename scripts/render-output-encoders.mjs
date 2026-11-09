import { deflateSync } from 'node:zlib';

import { PNG_SIGNATURE, pngChunk } from '../src/export-png.js';

// Node-side writers for the high-precision files of a render job: 16-bit PNG and OpenEXR. Both are small hand-written
// encoders (no dependency) and both take the float pixels the page reads back (RGBA float32, rows bottom to top).

const EXR_MAGIC = [0x76, 0x2f, 0x31, 0x01];
const EXR_VERSION = [2, 0, 0, 0];
const EXR_ZIP_COMPRESSION = 3;
const EXR_ZIP_ROWS_PER_BLOCK = 16;
const EXR_HALF = 1;
const EXR_FLOAT = 2;
const HALF_MAXIMUM = 65504;
const PNG_COLOR_TYPES = Object.freeze({ 1: 0, 3: 2, 4: 6 });
const PNG_SUB_FILTER = 1;
const MAXIMUM_PNG16_OBJECT_ID = 65535;

/** The 16 bit value of a colour channel in 0 to 1. */
function toSixteenBits(value) {
  return Math.round(Math.min(1, Math.max(0, value)) * 65535);
}

/**
 * A 16-bit PNG from interleaved samples (1 gray, 3 RGB or 4 RGBA channels), top row first, compressed with the Sub filter.
 * `samples` holds integers 0 to 65535.
 */
export function encodePng16(samples, width, height, channels) {
  if (!Object.hasOwn(PNG_COLOR_TYPES, channels)) throw new RangeError('A 16-bit PNG has 1, 3 or 4 channels.');
  if (samples.length !== width * height * channels) throw new RangeError('The sample count does not match the image size.');
  const bytesPerPixel = channels * 2;
  const rowBytes = width * bytesPerPixel;
  const filtered = Buffer.alloc((rowBytes + 1) * height);
  const rowSamples = width * channels;
  const row = Buffer.alloc(rowBytes);
  for (let rowIndex = 0; rowIndex < height; rowIndex++) {
    for (let index = 0; index < rowSamples; index++) row.writeUInt16BE(samples[rowIndex * rowSamples + index], index * 2);
    const target = rowIndex * (rowBytes + 1);
    filtered[target] = PNG_SUB_FILTER;
    for (let byteIndex = 0; byteIndex < rowBytes; byteIndex++) {
      const left = byteIndex >= bytesPerPixel ? row[byteIndex - bytesPerPixel] : 0;
      filtered[target + 1 + byteIndex] = (row[byteIndex] - left) & 0xff;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 16;
  header[9] = PNG_COLOR_TYPES[channels];
  return Buffer.concat([Buffer.from(PNG_SIGNATURE), pngChunk('IHDR', header), pngChunk('IDAT', deflateSync(filtered, { level: 6 })), pngChunk('IEND', new Uint8Array(0))]);
}

const float32Scratch = new Float32Array(1);
const uint32Scratch = new Uint32Array(float32Scratch.buffer);

/** IEEE half float bits of a number, rounded to nearest and clamped to the finite range. */
export function toHalfBits(value) {
  const clamped = Number.isNaN(value) ? 0 : Math.min(HALF_MAXIMUM, Math.max(-HALF_MAXIMUM, value));
  float32Scratch[0] = clamped;
  const bits = uint32Scratch[0];
  const sign = (bits >>> 16) & 0x8000;
  const exponent = ((bits >>> 23) & 0xff) - 127 + 15;
  const mantissa = bits & 0x7fffff;
  if (exponent <= 0) {
    if (exponent < -10) return sign;
    const shifted = (mantissa | 0x800000) >> (1 - exponent);
    return sign | ((shifted + 0x1000) >> 13);
  }
  return sign | (((exponent << 10) | (mantissa >> 13)) + ((mantissa >> 12) & 1));
}

function exrAttribute(name, type, value) {
  return Buffer.concat([Buffer.from(`${name}\0${type}\0`), uint32(value.length), value]);
}

function uint32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeInt32LE(value);
  return buffer;
}

function box(minimumX, minimumY, maximumX, maximumY) {
  const buffer = Buffer.alloc(16);
  [minimumX, minimumY, maximumX, maximumY].forEach((value, index) => buffer.writeInt32LE(value, index * 4));
  return buffer;
}

function channelList(channels) {
  const entries = channels.map(({ name, pixelType }) => {
    const entry = Buffer.alloc(name.length + 1 + 16);
    entry.write(name, 0, 'latin1');
    entry.writeInt32LE(pixelType, name.length + 1);
    entry.writeInt32LE(1, name.length + 9);
    entry.writeInt32LE(1, name.length + 13);
    return entry;
  });
  return Buffer.concat([...entries, Buffer.alloc(1)]);
}

/** The OpenEXR ZIP step: split even and odd bytes, delta code, deflate; a block that does not shrink is stored as it is. */
function zipBlock(raw) {
  const reordered = Buffer.alloc(raw.length);
  const half = (raw.length + 1) >> 1;
  for (let index = 0; index < raw.length; index++) {
    const target = index % 2 === 0 ? index / 2 : half + (index - 1) / 2;
    reordered[target] = raw[index];
  }
  let previous = reordered[0];
  for (let index = 1; index < reordered.length; index++) {
    const current = reordered[index];
    reordered[index] = (current - previous + 128 + 256) & 0xff;
    previous = current;
  }
  const compressed = deflateSync(reordered);
  return compressed.length < raw.length ? compressed : raw;
}

/**
 * An OpenEXR file (scanline, ZIP compression, one part). `channels` is [{ name, type: 'half' | 'float', values }] where
 * `values` is a Float32Array of width x height numbers, top row first. Channels are written in name order, as the format requires.
 */
export function encodeExr(width, height, channels) {
  const ordered = [...channels].sort((left, right) => (left.name < right.name ? -1 : 1))
    .map(channel => ({ ...channel, pixelType: channel.type === 'float' ? EXR_FLOAT : EXR_HALF }));
  const bytesPerPixel = ordered.reduce((total, channel) => total + (channel.pixelType === EXR_FLOAT ? 4 : 2), 0);
  const header = Buffer.concat([
    Buffer.from([...EXR_MAGIC, ...EXR_VERSION]),
    exrAttribute('channels', 'chlist', channelList(ordered)),
    exrAttribute('compression', 'compression', Buffer.from([EXR_ZIP_COMPRESSION])),
    exrAttribute('dataWindow', 'box2i', box(0, 0, width - 1, height - 1)),
    exrAttribute('displayWindow', 'box2i', box(0, 0, width - 1, height - 1)),
    exrAttribute('lineOrder', 'lineOrder', Buffer.from([0])),
    exrAttribute('pixelAspectRatio', 'float', Buffer.from(new Float32Array([1]).buffer)),
    exrAttribute('screenWindowCenter', 'v2f', Buffer.from(new Float32Array([0, 0]).buffer)),
    exrAttribute('screenWindowWidth', 'float', Buffer.from(new Float32Array([1]).buffer)),
    Buffer.alloc(1),
  ]);
  const blocks = [];
  for (let firstRow = 0; firstRow < height; firstRow += EXR_ZIP_ROWS_PER_BLOCK) {
    const rowCount = Math.min(EXR_ZIP_ROWS_PER_BLOCK, height - firstRow);
    const raw = Buffer.alloc(rowCount * width * bytesPerPixel);
    let offset = 0;
    for (let row = 0; row < rowCount; row++) {
      for (const channel of ordered) {
        for (let column = 0; column < width; column++) {
          const value = channel.values[(firstRow + row) * width + column];
          if (channel.pixelType === EXR_FLOAT) {
            raw.writeFloatLE(value, offset);
            offset += 4;
          } else {
            raw.writeUInt16LE(toHalfBits(value), offset);
            offset += 2;
          }
        }
      }
    }
    const data = zipBlock(raw);
    const blockHeader = Buffer.alloc(8);
    blockHeader.writeInt32LE(firstRow, 0);
    blockHeader.writeInt32LE(data.length, 4);
    blocks.push(Buffer.concat([blockHeader, data]));
  }
  const table = Buffer.alloc(blocks.length * 8);
  let position = header.length + table.length;
  blocks.forEach((block, index) => {
    table.writeBigUInt64LE(BigInt(position), index * 8);
    position += block.length;
  });
  return Buffer.concat([header, table, ...blocks]);
}

/** Interleaved bottom-up RGBA floats into one planar top-down Float32Array per requested component (0 to 3). */
function planes(pixels, width, height, components) {
  return components.map(component => {
    const plane = new Float32Array(width * height);
    for (let row = 0; row < height; row++) {
      const sourceRow = height - 1 - row;
      for (let column = 0; column < width; column++) plane[row * width + column] = pixels[(sourceRow * width + column) * 4 + component];
    }
    return plane;
  });
}

function byteOf(value) {
  return Math.round(Math.min(1, Math.max(0, value)) * 255);
}

/** The 16 bit depth step of a depth pass pixel: red is the high byte and green the low byte. */
function depthSteps(pixels, offset) {
  return byteOf(pixels[offset]) * 256 + byteOf(pixels[offset + 1]);
}

/** The 24 bit object ID of an object ID pass pixel, zero for no object. */
function objectIdentifier(pixels, offset) {
  return byteOf(pixels[offset]) + byteOf(pixels[offset + 1]) * 256 + byteOf(pixels[offset + 2]) * 65536;
}

function exrChannelsForPass({ pixels, width, height, pass, hasAlpha, depthRange, prefix = '' }) {
  if (pass === 'depth' || pass === 'objectId') {
    const values = new Float32Array(width * height);
    for (let row = 0; row < height; row++) {
      const sourceRow = height - 1 - row;
      for (let column = 0; column < width; column++) {
        const offset = (sourceRow * width + column) * 4;
        values[row * width + column] = pass === 'depth' ? depthSteps(pixels, offset) / 65535 * depthRange : objectIdentifier(pixels, offset);
      }
    }
    return [{ name: `${prefix}${pass === 'depth' ? 'Z' : 'id'}`, type: 'float', values }];
  }
  const [red, green, blue, alpha] = planes(pixels, width, height, [0, 1, 2, 3]);
  if (pass === 'uv') return [{ name: `${prefix}U`, type: 'half', values: red }, { name: `${prefix}V`, type: 'half', values: green }];
  if (pass === 'velocity') return [{ name: `${prefix}X`, type: 'half', values: red }, { name: `${prefix}Y`, type: 'half', values: green }];
  if (pass === 'position') return [{ name: `${prefix}X`, type: 'float', values: red }, { name: `${prefix}Y`, type: 'float', values: green }, { name: `${prefix}Z`, type: 'float', values: blue }];
  const channels = [{ name: `${prefix}R`, type: 'half', values: red }, { name: `${prefix}G`, type: 'half', values: green }, { name: `${prefix}B`, type: 'half', values: blue }];
  if (hasAlpha) channels.push({ name: `${prefix}A`, type: 'half', values: alpha });
  return channels;
}

function encodeExrPass(options) {
  return encodeExr(options.width, options.height, exrChannelsForPass(options));
}

export function encodeMultilayerExr({ width, height, beauty, passes = {}, hasAlpha = false, depthRange = 100 }) {
  if (beauty.length !== width * height * 4) throw new RangeError('The beauty pixel count does not match the image size.');
  const channels = [...exrChannelsForPass({ pixels: beauty, width, height, pass: undefined, hasAlpha, depthRange, prefix: 'Combined.' })];
  for (const [pass, pixels] of Object.entries(passes)) {
    if (pixels.length !== width * height * 4) throw new RangeError(`The ${pass} pixel count does not match the image size.`);
    channels.push(...exrChannelsForPass({ pixels, width, height, pass, hasAlpha: false, depthRange, prefix: `${pass}.` }));
  }
  return encodeExr(width, height, channels);
}

function encodePng16Pass({ pixels, width, height, pass, hasAlpha, depthRange = 100 }) {
  const pixelCount = width * height;
  if (pass === 'depth' || pass === 'objectId') {
    const samples = new Uint16Array(pixelCount);
    for (let row = 0; row < height; row++) {
      for (let column = 0; column < width; column++) {
        const offset = ((height - 1 - row) * width + column) * 4;
        const value = pass === 'depth' ? depthSteps(pixels, offset) : objectIdentifier(pixels, offset);
        if (value > MAXIMUM_PNG16_OBJECT_ID && pass === 'objectId') throw new RangeError('A 16-bit PNG holds object IDs up to 65535. Use format exr for this scene.');
        samples[row * width + column] = value;
      }
    }
    return encodePng16(samples, width, height, 1);
  }
  const channels = hasAlpha ? 4 : 3;
  const samples = new Uint16Array(pixelCount * channels);
  for (let row = 0; row < height; row++) {
    for (let column = 0; column < width; column++) {
      const offset = ((height - 1 - row) * width + column) * 4;
      const target = (row * width + column) * channels;
      const alpha = pixels[offset + 3];
      // The lit frame is premultiplied by alpha; a PNG stores straight colour.
      const scale = hasAlpha && alpha > 0 ? 1 / alpha : 1;
      for (let component = 0; component < 3; component++) {
        const raw = pixels[offset + component];
        const mapped = pass === 'position' ? raw / depthRange * 0.5 + 0.5
          : pass === 'velocity' ? (component < 2 ? raw * 0.5 + 0.5 : 0)
          : raw * scale;
        samples[target + component] = toSixteenBits(mapped);
      }
      if (hasAlpha) samples[target + 3] = toSixteenBits(alpha);
    }
  }
  return encodePng16(samples, width, height, channels);
}

/**
 * The file bytes of one rendered image in a high-precision format. `pixels` is the page's RGBA float readback
 * (rows bottom to top), `pass` names the render pass or is undefined for the lit image, and `hasAlpha` keeps the alpha
 * of a transparent lit image. Depth is written as metres over `depthRange` in EXR and as the raw 16-bit step in PNG.
 */
export function encodeRenderOutput({ format, pixels, width, height, pass, hasAlpha = false, depthRange = 100 }) {
  if (pixels.length !== width * height * 4) throw new RangeError('The pixel count does not match the image size.');
  const options = { pixels, width, height, pass, hasAlpha: hasAlpha && pass === undefined, depthRange };
  if (format === 'png16') return encodePng16Pass(options);
  if (format === 'exr') return encodeExrPass(options);
  throw new TypeError('format must be png16 or exr.');
}
