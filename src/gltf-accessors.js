import { forEachChunk } from './cooperative.js';

export const COMPONENT_TYPES = {
  5120: Int8Array,
  5121: Uint8Array,
  5122: Int16Array,
  5123: Uint16Array,
  5125: Uint32Array,
  5126: Float32Array,
};
const COMPONENT_COUNTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };
const NORMALIZATION_DIVISORS = { 5120: 127, 5121: 255, 5122: 32767, 5123: 65535 };

function fillFloats(attribute, values, divisor, from, to) {
  for (let index = from; index < to; index++) {
    const value = attribute.array[index];
    values[index] = divisor === 1 ? value : Math.max(value / divisor, -1);
  }
}

/** Float values of an attribute, with normalized integers scaled into zero to one or minus one to one. */
export function attributeFloats(attribute) {
  const length = attribute.count * attribute.itemSize;
  const values = new Float32Array(length);
  fillFloats(attribute, values, attribute.normalized ? NORMALIZATION_DIVISORS[attribute.componentType] : 1, 0, length);
  return values;
}

/** The same values as attributeFloats, converted a chunk at a time with `checkpoint()` between chunks so a large attribute does not block the page. */
export async function attributeFloatsInSlices(attribute, checkpoint) {
  const length = attribute.count * attribute.itemSize;
  const values = new Float32Array(length);
  const divisor = attribute.normalized ? NORMALIZATION_DIVISORS[attribute.componentType] : 1;
  await forEachChunk(length, checkpoint, (from, to) => fillFloats(attribute, values, divisor, from, to));
  return values;
}

function elementBytesOf(accessor) {
  return COMPONENT_TYPES[accessor.componentType].BYTES_PER_ELEMENT * COMPONENT_COUNTS[accessor.type];
}

function checkElementsFit(source, offset, stride, count, elementBytes) {
  if (count > 0 && offset + (count - 1) * stride + elementBytes > source.length) {
    throw new Error('glTF accessor exceeds its buffer view.');
  }
}

// Tightly packed elements are one block of bytes. Uint8Array.prototype.slice copies even when `source` is a Node Buffer, whose own slice is a view.
function copyTightly(source, offset, count, elementBytes) {
  return Uint8Array.prototype.slice.call(source, offset, offset + count * elementBytes);
}

function copyStridedRange(source, offset, stride, elementBytes, packed, from, to) {
  for (let element = from; element < to; element++) {
    const start = offset + element * stride;
    packed.set(source.subarray(start, start + elementBytes), element * elementBytes);
  }
}

function copyElements(source, offset, stride, count, elementBytes) {
  checkElementsFit(source, offset, stride, count, elementBytes);
  if (stride === elementBytes) return copyTightly(source, offset, count, elementBytes);
  const packed = new Uint8Array(count * elementBytes);
  copyStridedRange(source, offset, stride, elementBytes, packed, 0, count);
  return packed;
}

async function copyElementsInSlices(source, offset, stride, count, elementBytes, checkpoint) {
  checkElementsFit(source, offset, stride, count, elementBytes);
  if (stride === elementBytes) return copyTightly(source, offset, count, elementBytes);
  const packed = new Uint8Array(count * elementBytes);
  await forEachChunk(count, checkpoint, (from, to) => copyStridedRange(source, offset, stride, elementBytes, packed, from, to));
  return packed;
}

/**
 * Reads accessors as tightly packed typed arrays, with sparse substitution and meshopt buffer views.
 * `bufferBytes(index)` returns the bytes of a glTF buffer. `meshoptDecoder` replaces the built-in decoder of compressed views.
 */
export function createAccessorReader(document, bufferBytes, meshoptDecoder) {
  const viewCache = new Map();

  function plainViewBytes(view) {
    const source = bufferBytes(view.buffer);
    const offset = view.byteOffset ?? 0;
    const length = view.byteLength;
    if (!source || !Number.isSafeInteger(length) || length < 0 || offset < 0 || offset + length > source.length) {
      throw new Error('glTF buffer view exceeds its buffer.');
    }
    return source.subarray(offset, offset + length);
  }

  /** Decode every meshopt view before any accessor is read, so reading stays synchronous. The decoder loads only for a file that has one. */
  async function prepare() {
    const views = document.bufferViews ?? [];
    if (!views.some(view => view.extensions?.EXT_meshopt_compression)) return;
    const { decodeMeshoptViews } = await import('./gltf-meshopt.js');
    for (const [index, bytes] of await decodeMeshoptViews(views, bufferBytes, meshoptDecoder)) viewCache.set(index, bytes);
  }

  function viewBytes(index) {
    const view = document.bufferViews?.[index];
    if (!view) throw new Error('Invalid glTF buffer view index.');
    if (!viewCache.has(index)) viewCache.set(index, plainViewBytes(view));
    return viewCache.get(index);
  }

  function planAccessor(index) {
    const accessor = document.accessors?.[index];
    if (!accessor) throw new Error('Invalid glTF accessor index.');
    const ArrayType = COMPONENT_TYPES[accessor.componentType];
    if (!ArrayType) throw new Error('Unsupported glTF accessor component type.');
    const elementBytes = elementBytesOf(accessor);
    const stride = accessor.bufferView === undefined ? 0 : document.bufferViews[accessor.bufferView].byteStride || elementBytes;
    return { accessor, ArrayType, itemSize: COMPONENT_COUNTS[accessor.type], elementBytes, stride };
  }

  function finishAccessor({ accessor, ArrayType, itemSize }, packed) {
    const array = new ArrayType(packed.buffer);
    if (accessor.sparse) applySparse(accessor, array, itemSize);
    return { array, itemSize, count: accessor.count, normalized: accessor.normalized === true, componentType: accessor.componentType };
  }

  function readAccessor(index) {
    const plan = planAccessor(index);
    const { accessor, elementBytes, stride } = plan;
    const packed = accessor.bufferView === undefined
      ? new Uint8Array(accessor.count * elementBytes)
      : copyElements(viewBytes(accessor.bufferView), accessor.byteOffset ?? 0, stride, accessor.count, elementBytes);
    return finishAccessor(plan, packed);
  }

  /** The same accessor as readAccessor, copied a chunk at a time with `checkpoint()` between chunks. */
  async function readAccessorInSlices(index, checkpoint) {
    const plan = planAccessor(index);
    const { accessor, elementBytes, stride } = plan;
    const packed = accessor.bufferView === undefined
      ? new Uint8Array(accessor.count * elementBytes)
      : await copyElementsInSlices(viewBytes(accessor.bufferView), accessor.byteOffset ?? 0, stride, accessor.count, elementBytes, checkpoint);
    return finishAccessor(plan, packed);
  }

  function applySparse(accessor, array, itemSize) {
    const { count, indices, values } = accessor.sparse;
    const IndexType = COMPONENT_TYPES[indices.componentType];
    if (!IndexType) throw new Error('Unsupported sparse index component type.');
    const indexBytes = copyElements(viewBytes(indices.bufferView), indices.byteOffset ?? 0, IndexType.BYTES_PER_ELEMENT, count, IndexType.BYTES_PER_ELEMENT);
    const sparseIndices = new IndexType(indexBytes.buffer);
    const itemBytes = array.BYTES_PER_ELEMENT * itemSize;
    const valueBytes = copyElements(viewBytes(values.bufferView), values.byteOffset ?? 0, itemBytes, count, itemBytes);
    const sparseValues = new array.constructor(valueBytes.buffer);
    for (let item = 0; item < count; item++) {
      if (sparseIndices[item] >= accessor.count) throw new Error('Sparse accessor index is out of range.');
      array.set(sparseValues.subarray(item * itemSize, (item + 1) * itemSize), sparseIndices[item] * itemSize);
    }
  }

  return { prepare, readAccessor, readAccessorInSlices, viewBytes };
}
