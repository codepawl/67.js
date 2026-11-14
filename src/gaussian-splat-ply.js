// Reads a standard 3D Gaussian splat PLY: the file written by the original 3DGS training code and by most tools that
// export splats. It is binary little endian with one vertex per splat and the properties x, y, z, f_dc_0 to f_dc_2,
// opacity, scale_0 to scale_2 and rot_0 to rot_3. Higher-order spherical harmonics (f_rest_*) and normals are skipped,
// so a splat shows one colour from every direction. Other splat formats (.spz, .ksplat, .splat) are not read here.

import { runInChunks } from './gaussian-splat-chunks.js';

export const GAUSSIAN_SPLAT_LIMITS = Object.freeze({
  // A file this large cannot be read into memory safely in a browser tab.
  maximumBytes: 512 * 1024 * 1024,
  maximumCount: 2_000_000,
});
/** No option raises the splat count above this: the data texture then needs 192 MB of GPU memory. */
export const GAUSSIAN_SPLAT_HARD_COUNT_LIMIT = 4_000_000;

const REQUIRED_PROPERTIES = ['x', 'y', 'z', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3'];
const SPHERICAL_HARMONIC_DC = 0.28209479177387814;
const HEADER_END = 'end_header\n';
const MAXIMUM_HEADER_BYTES = 64 * 1024;

const PROPERTY_TYPES = {
  char: { bytes: 1, read: (view, offset) => view.getInt8(offset) },
  int8: { bytes: 1, read: (view, offset) => view.getInt8(offset) },
  uchar: { bytes: 1, read: (view, offset) => view.getUint8(offset) },
  uint8: { bytes: 1, read: (view, offset) => view.getUint8(offset) },
  short: { bytes: 2, read: (view, offset) => view.getInt16(offset, true) },
  int16: { bytes: 2, read: (view, offset) => view.getInt16(offset, true) },
  ushort: { bytes: 2, read: (view, offset) => view.getUint16(offset, true) },
  uint16: { bytes: 2, read: (view, offset) => view.getUint16(offset, true) },
  int: { bytes: 4, read: (view, offset) => view.getInt32(offset, true) },
  int32: { bytes: 4, read: (view, offset) => view.getInt32(offset, true) },
  uint: { bytes: 4, read: (view, offset) => view.getUint32(offset, true) },
  uint32: { bytes: 4, read: (view, offset) => view.getUint32(offset, true) },
  float: { bytes: 4, read: (view, offset) => view.getFloat32(offset, true) },
  float32: { bytes: 4, read: (view, offset) => view.getFloat32(offset, true) },
  double: { bytes: 8, read: (view, offset) => view.getFloat64(offset, true) },
  float64: { bytes: 8, read: (view, offset) => view.getFloat64(offset, true) },
};

function readHeaderText(bytes) {
  const searchLimit = Math.min(bytes.length, MAXIMUM_HEADER_BYTES);
  const text = new TextDecoder('latin1').decode(bytes.subarray(0, searchLimit));
  const endIndex = text.indexOf(HEADER_END);
  if (!text.startsWith('ply') || endIndex < 0) {
    throw new Error('Not a PLY file: the header must start with "ply" and end with "end_header"');
  }
  return { text: text.slice(0, endIndex), bodyStart: endIndex + HEADER_END.length };
}

function parseHeader(headerText) {
  const lines = headerText.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const formatLine = lines.find(line => line.startsWith('format '));
  if (formatLine?.split(/\s+/)[1] !== 'binary_little_endian') {
    throw new Error(`Gaussian splat PLY must be binary_little_endian, got "${formatLine ?? 'no format line'}"`);
  }
  let vertexCount = 0;
  let inVertexElement = false;
  let vertexElementSeen = false;
  const properties = [];
  for (const line of lines) {
    const words = line.split(/\s+/);
    if (words[0] === 'element') {
      inVertexElement = words[1] === 'vertex' && !vertexElementSeen;
      if (inVertexElement) {
        vertexElementSeen = true;
        vertexCount = Number(words[2]);
      }
    } else if (words[0] === 'property' && inVertexElement) {
      if (words[1] === 'list' || !PROPERTY_TYPES[words[1]]) {
        throw new Error(`Gaussian splat PLY has an unsupported property type "${words[1]}"`);
      }
      properties.push({ name: words[2], type: words[1] });
    }
  }
  if (!Number.isInteger(vertexCount) || vertexCount <= 0) {
    throw new Error('Gaussian splat PLY has no vertex element with a positive count');
  }
  return { vertexCount, properties };
}

function propertyLayout(properties) {
  const layout = new Map();
  let offset = 0;
  for (const { name, type } of properties) {
    layout.set(name, { offset, read: PROPERTY_TYPES[type].read });
    offset += PROPERTY_TYPES[type].bytes;
  }
  const missing = REQUIRED_PROPERTIES.filter(name => !layout.has(name));
  if (missing.length > 0) {
    throw new Error(`Gaussian splat PLY lacks the properties ${missing.join(', ')}`);
  }
  return { layout, stride: offset };
}

function resolveLimits(options) {
  const maximumBytes = options.maximumBytes ?? GAUSSIAN_SPLAT_LIMITS.maximumBytes;
  const maximumCount = options.maximumCount ?? GAUSSIAN_SPLAT_LIMITS.maximumCount;
  if (!(maximumBytes > 0) || !(maximumCount > 0)) {
    throw new RangeError('maximumBytes and maximumCount must be positive');
  }
  return { maximumBytes, maximumCount: Math.min(maximumCount, GAUSSIAN_SPLAT_HARD_COUNT_LIMIT) };
}

function toByte(unit) {
  return Math.max(0, Math.min(255, Math.round(unit * 255)));
}

/**
 * Parses a standard 3DGS PLY into flat typed arrays. Throws a RangeError, before reading any splat, when the file is
 * larger than `maximumBytes` (default 512 MiB) or holds more than `maximumCount` splats (default 2,000,000; never more
 * than 4,000,000). Returns `{ count, positions, colors, scales, rotations, bounds }`: positions are xyz, colors are
 * RGBA bytes (RGB from the DC spherical harmonic, A from the sigmoid of opacity), scales are the exponentiated
 * axis lengths in metres and rotations are unit quaternions in w, x, y, z order.
 */
export function parseGaussianSplatPly(buffer, options = {}) {
  const source = openSplatPly(buffer, options, 'parseGaussianSplatPly');
  const reader = createSplatReader(source);
  reader.readRange(0, source.vertexCount);
  return reader.result();
}

/**
 * The same result as `parseGaussianSplatPly`, byte for byte, read in slices of `chunkSize` splats (default 32,768) with a
 * wait of one macrotask between slices, so the page keeps drawing and answering input. `onProgress(fraction)` is called
 * after each slice with a rising fraction that ends at exactly 1. An aborted `signal` stops the read and rejects with an
 * error named `AbortError`. The header checks and size limits run first and reject before any splat is read.
 */
export async function parseGaussianSplatPlyAsync(buffer, options = {}) {
  const source = openSplatPly(buffer, options, 'parseGaussianSplatPlyAsync');
  const reader = createSplatReader(source);
  await runInChunks(source.vertexCount, options, 'parseGaussianSplatPlyAsync', reader.readRange);
  return reader.result();
}

function openSplatPly(buffer, options, caller) {
  const { maximumBytes, maximumCount } = resolveLimits(options);
  if (!(buffer instanceof ArrayBuffer) && !ArrayBuffer.isView(buffer)) {
    throw new TypeError(`${caller} expects an ArrayBuffer or a typed array`);
  }
  if (buffer.byteLength > maximumBytes) {
    throw new RangeError(`Gaussian splat file is ${buffer.byteLength} bytes, over the limit of ${maximumBytes}`);
  }
  const bytes = buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const { text, bodyStart } = readHeaderText(bytes);
  const { vertexCount, properties } = parseHeader(text);
  if (vertexCount > maximumCount) {
    throw new RangeError(`Gaussian splat file holds ${vertexCount} splats, over the limit of ${maximumCount}`);
  }
  const { layout, stride } = propertyLayout(properties);
  if (bytes.length - bodyStart < vertexCount * stride) {
    throw new Error(`Gaussian splat PLY is truncated: ${vertexCount} splats need ${vertexCount * stride} bytes, ${bytes.length - bodyStart} are present`);
  }
  const body = new DataView(bytes.buffer, bytes.byteOffset + bodyStart, vertexCount * stride);
  return { view: body, vertexCount, layout, stride };
}

function createSplatReader({ view, vertexCount: count, layout, stride }) {
  const positions = new Float32Array(count * 3);
  const colors = new Uint8Array(count * 4);
  const scales = new Float32Array(count * 3);
  const rotations = new Float32Array(count * 4);
  const minimum = [Infinity, Infinity, Infinity];
  const maximum = [-Infinity, -Infinity, -Infinity];
  const positionFields = ['x', 'y', 'z'].map(name => layout.get(name));
  const colorFields = ['f_dc_0', 'f_dc_1', 'f_dc_2'].map(name => layout.get(name));
  const opacityField = layout.get('opacity');
  const scaleFields = ['scale_0', 'scale_1', 'scale_2'].map(name => layout.get(name));
  const rotationFields = ['rot_0', 'rot_1', 'rot_2', 'rot_3'].map(name => layout.get(name));
  function readRange(start, end) {
    for (let index = start; index < end; index++) readSplat(index);
  }
  function readSplat(index) {
    const row = index * stride;
    for (let axis = 0; axis < 3; axis++) {
      const field = positionFields[axis];
      const coordinate = field.read(view, row + field.offset);
      if (!Number.isFinite(coordinate)) {
        throw new Error(`Gaussian splat ${index} has a non-finite position`);
      }
      positions[index * 3 + axis] = coordinate;
      if (coordinate < minimum[axis]) minimum[axis] = coordinate;
      if (coordinate > maximum[axis]) maximum[axis] = coordinate;
      const colorField = colorFields[axis];
      colors[index * 4 + axis] = toByte(0.5 + SPHERICAL_HARMONIC_DC * colorField.read(view, row + colorField.offset));
      const scaleField = scaleFields[axis];
      scales[index * 3 + axis] = Math.exp(scaleField.read(view, row + scaleField.offset));
    }
    colors[index * 4 + 3] = toByte(1 / (1 + Math.exp(-opacityField.read(view, row + opacityField.offset))));
    writeUnitQuaternion(rotations, index, view, row, rotationFields);
  }
  function result() {
    return { count, positions, colors, scales, rotations, bounds: { minimum, maximum } };
  }
  return { readRange, result };
}

function writeUnitQuaternion(rotations, index, view, row, fields) {
  const base = index * 4;
  for (let component = 0; component < 4; component++) {
    rotations[base + component] = fields[component].read(view, row + fields[component].offset);
  }
  const length = Math.hypot(rotations[base], rotations[base + 1], rotations[base + 2], rotations[base + 3]);
  if (length > 1e-12) {
    for (let component = 0; component < 4; component++) rotations[base + component] /= length;
  } else {
    rotations.set([1, 0, 0, 0], base);
  }
}
