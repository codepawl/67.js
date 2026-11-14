// Reads a gzip SPZ splat file (versions 2 and 3), the compact format of Niantic and the .spz output of World Labs.
// Format source: https://github.com/nianticlabs/spz, src/cc/load-spz.cc (deserializePackedGaussians) and
// src/cc/splat-utils.h (unpackQuaternionFirstThree, unpackQuaternionSmallestThree, colorScale).
//
// The gzip stream holds a 16 byte little endian header, then one column per attribute, each holding all splats:
//   header   uint32 magic 0x5053474e ("NGSP"), uint32 version, uint32 count, uint8 shDegree, uint8 fractionalBits, uint8 flags, uint8 reserved
//   positions  count * 9 bytes: x, y, z as 24 bit two's complement fixed point, value = integer / 2^fractionalBits
//   alphas     count bytes: sigmoid(opacity) * 255
//   colors     count * 3 bytes: (byte / 255 - 0.5) / 0.15 is the DC spherical harmonic
//   scales     count * 3 bytes: log scale = byte / 16 - 10
//   rotations  version 2: count * 3 bytes, x y z as byte / 127.5 - 1 with w rebuilt (w >= 0);
//              version 3: count * 4 bytes, "smallest three": the top 2 bits name the largest component, then three
//              10 bit fields (9 bit magnitude, 1 sign bit) scaled by 1/sqrt(2), for components 3 down to 0 in x y z w order
//   sh         count * shDim * 3 bytes, skipped here (shDim is 0, 3, 8, 15 or 24 for degree 0 to 4)
// Version 4 (a zstd container) and the never released version 1 (float16 positions) are not read.

import { runInChunks } from './gaussian-splat-chunks.js';
import { resolveLimits } from './gaussian-splat-ply.js';

const SPZ_MAGIC = 0x5053474e;
const HEADER_BYTES = 16;
const SUPPORTED_VERSIONS = [2, 3];
const SPHERICAL_HARMONIC_DC = 0.28209479177387814;
const SPZ_COLOR_SCALE = 0.15;
const SH_DIMENSION_BY_DEGREE = [0, 3, 8, 15, 24];
const SMALLEST_THREE_MASK = (1 << 9) - 1;
const SQRT_HALF = Math.SQRT1_2;

function toByte(unit) {
  return Math.max(0, Math.min(255, Math.round(unit * 255)));
}

function toBytes(buffer, caller) {
  if (buffer instanceof ArrayBuffer) return new Uint8Array(buffer);
  if (ArrayBuffer.isView(buffer)) return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  throw new TypeError(`${caller} expects an ArrayBuffer or a typed array`);
}

function readHeader(bytes, maximumCount) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== SPZ_MAGIC) {
    throw new Error('Not an SPZ file: the decompressed data must start with the magic "NGSP"');
  }
  const version = view.getUint32(4, true);
  if (!SUPPORTED_VERSIONS.includes(version)) {
    throw new Error(`SPZ version ${version} is not supported, only versions ${SUPPORTED_VERSIONS.join(' and ')}: export the splats as SPZ version 3 or as PLY`);
  }
  const count = view.getUint32(8, true);
  const shDegree = view.getUint8(12);
  if (count === 0) throw new Error('SPZ file holds no splats');
  if (count > maximumCount) throw new RangeError(`Gaussian splat file holds ${count} splats, over the limit of ${maximumCount}`);
  if (shDegree >= SH_DIMENSION_BY_DEGREE.length) throw new Error(`SPZ file has an unsupported spherical harmonic degree ${shDegree}, the largest is 4`);
  const rotationBytes = version >= 3 ? 4 : 3;
  const shBytes = SH_DIMENSION_BY_DEGREE[shDegree] * 3;
  const alphasOffset = HEADER_BYTES + count * 9;
  const colorsOffset = alphasOffset + count;
  const scalesOffset = colorsOffset + count * 3;
  const rotationsOffset = scalesOffset + count * 3;
  return {
    version,
    count,
    fractionalScale: 2 ** -view.getUint8(13),
    rotationBytes,
    alphasOffset,
    colorsOffset,
    scalesOffset,
    rotationsOffset,
    totalBytes: rotationsOffset + count * (rotationBytes + shBytes),
  };
}

// Inflates the gzip stream and stops reading as soon as the splat columns are complete (an extension zone after them is
// ignored), so a small file cannot expand past the size its own header announces or past `maximumBytes`.
async function inflateSpz(compressed, limits, caller) {
  if (compressed[0] !== 0x1f || compressed[1] !== 0x8b) {
    const looksLikeVersion4 = compressed.length >= 4 && new DataView(compressed.buffer, compressed.byteOffset).getUint32(0, true) === SPZ_MAGIC;
    throw new Error(looksLikeVersion4
      ? 'SPZ version 4 (zstd) is not supported: export the splats as SPZ version 3 or as PLY'
      : 'Not an SPZ file: it must be a gzip stream');
  }
  if (typeof DecompressionStream !== 'function') {
    throw new Error(`${caller} needs DecompressionStream (browsers and Node 18 or later)`);
  }
  const reader = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
  const chunks = [];
  let received = 0;
  let header = null;
  let wanted = Math.min(limits.maximumBytes, HEADER_BYTES);
  try {
    while (received < wanted || !header) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      if (!header && received >= HEADER_BYTES) {
        header = readHeader(concatenate(chunks, received), limits.maximumCount);
        if (header.totalBytes > limits.maximumBytes) {
          throw new RangeError(`Gaussian splat file inflates to ${header.totalBytes} bytes, over the limit of ${limits.maximumBytes}`);
        }
        wanted = header.totalBytes;
      }
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    if (error instanceof RangeError || error.message.includes('SPZ')) throw error;
    throw new Error(`SPZ file is not a valid gzip stream: ${error.message}`);
  }
  await reader.cancel().catch(() => {});
  if (!header) throw new Error('SPZ file is truncated: the decompressed data is shorter than the 16 byte header');
  if (received < header.totalBytes) {
    throw new Error(`SPZ file is truncated: ${header.count} splats need ${header.totalBytes} bytes, ${received} are present`);
  }
  return { bytes: concatenate(chunks, received).subarray(0, header.totalBytes), header };
}

function concatenate(chunks, totalLength) {
  const joined = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.length;
  }
  return joined;
}

async function openSplatSpz(buffer, options, caller) {
  const limits = resolveLimits(options);
  const compressed = toBytes(buffer, caller);
  if (compressed.byteLength > limits.maximumBytes) {
    throw new RangeError(`Gaussian splat file is ${compressed.byteLength} bytes, over the limit of ${limits.maximumBytes}`);
  }
  return inflateSpz(compressed, limits, caller);
}

function readFixedPoint24(bytes, offset) {
  const unsigned = bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
  return unsigned & 0x800000 ? unsigned - 0x1000000 : unsigned;
}

// Quaternion in w, x, y, z order, unit length, for either rotation encoding.
function writeRotation(rotations, index, bytes, offset, version) {
  const base = index * 4;
  let x;
  let y;
  let z;
  let w;
  if (version >= 3) {
    const packed = (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
    const components = [0, 0, 0, 0];
    const largest = packed >>> 30;
    let remaining = packed;
    let sumOfSquares = 0;
    for (let component = 3; component >= 0; component--) {
      if (component === largest) continue;
      const magnitude = remaining & SMALLEST_THREE_MASK;
      const negative = (remaining >>> 9) & 1;
      remaining >>>= 10;
      components[component] = (negative ? -1 : 1) * SQRT_HALF * magnitude / SMALLEST_THREE_MASK;
      sumOfSquares += components[component] ** 2;
    }
    components[largest] = Math.sqrt(Math.max(0, 1 - sumOfSquares));
    [x, y, z, w] = components;
  } else {
    x = bytes[offset] / 127.5 - 1;
    y = bytes[offset + 1] / 127.5 - 1;
    z = bytes[offset + 2] / 127.5 - 1;
    w = Math.sqrt(Math.max(0, 1 - x * x - y * y - z * z));
  }
  const length = Math.hypot(w, x, y, z);
  if (length > 1e-12) {
    rotations[base] = w / length;
    rotations[base + 1] = x / length;
    rotations[base + 2] = y / length;
    rotations[base + 3] = z / length;
  } else {
    rotations.set([1, 0, 0, 0], base);
  }
}

function createSpzReader(bytes, header) {
  const { count, version, fractionalScale, alphasOffset, colorsOffset, scalesOffset, rotationsOffset, rotationBytes } = header;
  const positions = new Float32Array(count * 3);
  const colors = new Uint8Array(count * 4);
  const scales = new Float32Array(count * 3);
  const rotations = new Float32Array(count * 4);
  const minimum = [Infinity, Infinity, Infinity];
  const maximum = [-Infinity, -Infinity, -Infinity];
  function readRange(start, end) {
    for (let index = start; index < end; index++) readSplat(index);
  }
  function readSplat(index) {
    for (let axis = 0; axis < 3; axis++) {
      const coordinate = readFixedPoint24(bytes, HEADER_BYTES + (index * 3 + axis) * 3) * fractionalScale;
      positions[index * 3 + axis] = coordinate;
      if (coordinate < minimum[axis]) minimum[axis] = coordinate;
      if (coordinate > maximum[axis]) maximum[axis] = coordinate;
      const colorByte = bytes[colorsOffset + index * 3 + axis];
      const harmonic = (colorByte / 255 - 0.5) / SPZ_COLOR_SCALE;
      colors[index * 4 + axis] = toByte(0.5 + SPHERICAL_HARMONIC_DC * harmonic);
      scales[index * 3 + axis] = Math.exp(bytes[scalesOffset + index * 3 + axis] / 16 - 10);
    }
    colors[index * 4 + 3] = bytes[alphasOffset + index];
    writeRotation(rotations, index, bytes, rotationsOffset + index * rotationBytes, version);
  }
  function result() {
    return { count, positions, colors, scales, rotations, bounds: { minimum, maximum } };
  }
  return { readRange, result };
}

/**
 * Parses a gzip SPZ file (version 2 or 3, spherical harmonic degree 0 to 4 with the higher bands skipped) into the same
 * `{ count, positions, colors, scales, rotations, bounds }` as `parseGaussianSplatPly`, with the same limits:
 * `maximumBytes` (default 512 MiB, applied to the file and to its inflated size) and `maximumCount` (default 2,000,000,
 * never above 4,000,000) reject with a RangeError before any splat is read. Async because gzip is inflated with
 * `DecompressionStream`. Positions stay in the SPZ axes (x right, y up, z back); a PLY from a trainer is x right,
 * y down, z forward, so place one with `matrix` scale [1, -1, -1] when the two must agree.
 */
export async function parseGaussianSplatSpz(buffer, options = {}) {
  const { bytes, header } = await openSplatSpz(buffer, options, 'parseGaussianSplatSpz');
  const reader = createSpzReader(bytes, header);
  reader.readRange(0, header.count);
  return reader.result();
}

/**
 * The same result as `parseGaussianSplatSpz`, with the splats converted in slices of `chunkSize` (default 32,768) and a
 * wait of one macrotask between slices, as `parseGaussianSplatPlyAsync` does: `onProgress(fraction)` ends at exactly 1 and
 * an aborted `signal` rejects with an error named `AbortError`. Inflating the gzip stream does not block the thread.
 */
export async function parseGaussianSplatSpzAsync(buffer, options = {}) {
  const { bytes, header } = await openSplatSpz(buffer, options, 'parseGaussianSplatSpzAsync');
  const reader = createSpzReader(bytes, header);
  await runInChunks(header.count, options, 'parseGaussianSplatSpzAsync', reader.readRange);
  return reader.result();
}
