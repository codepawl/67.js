import { writeFile } from 'node:fs/promises';

const NPY_MAGIC_PREFIX = Buffer.from([0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59, 0x01, 0x00]);
const HEADER_ALIGNMENT_BYTES = 64;

function validateFloat32Shape(pixels, shape) {
  if (!(pixels instanceof Float32Array)) {
    throw new TypeError('writeFloat32Npy requires pixels to be a Float32Array.');
  }
  if (!Array.isArray(shape) || shape.length === 0 || shape.some((dimension) => !Number.isInteger(dimension) || dimension <= 0)) {
    throw new RangeError('writeFloat32Npy requires shape to be a non-empty array of positive integers.');
  }
  const expectedLength = shape.reduce((product, dimension) => product * dimension, 1);
  if (pixels.length !== expectedLength) {
    throw new RangeError(`writeFloat32Npy expected ${expectedLength} float32 values for shape (${shape.join(', ')}), got ${pixels.length}.`);
  }
}

function buildNpyHeader(shape) {
  const shapeTuple = shape.length === 1 ? `${shape[0]},` : shape.join(', ');
  const dictionary = `{'descr': '<f4', 'fortran_order': False, 'shape': (${shapeTuple}), }`;
  const unpaddedLength = NPY_MAGIC_PREFIX.length + 2 + dictionary.length + 1;
  const remainder = unpaddedLength % HEADER_ALIGNMENT_BYTES;
  const paddingCount = remainder === 0 ? 0 : HEADER_ALIGNMENT_BYTES - remainder;
  const headerText = `${dictionary}${' '.repeat(paddingCount)}\n`;
  const headerBytes = Buffer.from(headerText, 'ascii');
  const lengthBytes = Buffer.alloc(2);
  lengthBytes.writeUInt16LE(headerBytes.length, 0);
  return Buffer.concat([NPY_MAGIC_PREFIX, lengthBytes, headerBytes]);
}

export async function writeFloat32Npy(filePath, pixels, shape) {
  validateFloat32Shape(pixels, shape);
  const header = buildNpyHeader(shape);
  const body = Buffer.from(pixels.buffer, pixels.byteOffset, pixels.byteLength);
  await writeFile(filePath, Buffer.concat([header, body]));
}
