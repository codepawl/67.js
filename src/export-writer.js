const COMPONENT_COUNTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
const COMPONENT_TYPES = [[Float32Array, 5126], [Uint32Array, 5125], [Uint16Array, 5123], [Uint8Array, 5121]];

export function paddedLength(length) {
  return Math.ceil(length / 4) * 4;
}

function componentTypeOf(data) {
  const match = COMPONENT_TYPES.find(([type]) => data instanceof type);
  if (!match) throw new TypeError('GLB accessors require Float32, Uint32, Uint16 or Uint8 arrays.');
  return match[1];
}

function componentBounds(data, componentCount) {
  const minimum = new Array(componentCount).fill(Infinity);
  const maximum = new Array(componentCount).fill(-Infinity);
  for (let index = 0; index < data.length; index++) {
    const component = index % componentCount;
    minimum[component] = Math.min(minimum[component], data[index]);
    maximum[component] = Math.max(maximum[component], data[index]);
  }
  return { min: minimum, max: maximum };
}

/** Collects the JSON document and the binary chunk of one GLB. */
export function createGlbWriter() {
  const document = {
    asset: { version: '2.0', generator: 'crucible' },
    scene: 0,
    scenes: [{ nodes: [] }],
    nodes: [],
    meshes: [],
    materials: [],
    accessors: [],
    bufferViews: [],
    buffers: [],
  };
  const chunks = [];
  let byteLength = 0;

  function addBufferView(bytes, target) {
    const view = { buffer: 0, byteOffset: byteLength, byteLength: bytes.byteLength };
    if (target !== undefined) view.target = target;
    document.bufferViews.push(view);
    chunks.push({ offset: byteLength, data: bytes });
    byteLength += paddedLength(bytes.byteLength);
    return document.bufferViews.length - 1;
  }

  function addAccessor(data, type, target, { bounds = type === 'VEC3' } = {}) {
    const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    const componentCount = COMPONENT_COUNTS[type];
    const entry = { bufferView: addBufferView(bytes, target), componentType: componentTypeOf(data), count: data.length / componentCount, type };
    if (bounds) Object.assign(entry, componentBounds(data, componentCount));
    document.accessors.push(entry);
    return document.accessors.length - 1;
  }

  function addExtension(name, { required = false } = {}) {
    document.extensionsUsed = [...new Set([...document.extensionsUsed ?? [], name])];
    if (required) document.extensionsRequired = [...new Set([...document.extensionsRequired ?? [], name])];
  }

  function finish() {
    document.buffers.push({ byteLength });
    for (const key of ['skins', 'animations', 'images', 'samplers', 'textures']) {
      if (document[key]?.length === 0) delete document[key];
    }
    const json = new TextEncoder().encode(JSON.stringify(document));
    const jsonLength = paddedLength(json.length);
    const result = new ArrayBuffer(12 + 8 + jsonLength + 8 + byteLength);
    const header = new DataView(result);
    header.setUint32(0, 0x46546c67, true);
    header.setUint32(4, 2, true);
    header.setUint32(8, result.byteLength, true);
    header.setUint32(12, jsonLength, true);
    header.setUint32(16, 0x4e4f534a, true);
    const bytes = new Uint8Array(result);
    bytes.fill(32, 20, 20 + jsonLength);
    bytes.set(json, 20);
    const binaryHeader = 20 + jsonLength;
    header.setUint32(binaryHeader, byteLength, true);
    header.setUint32(binaryHeader + 4, 0x004e4942, true);
    for (const chunk of chunks) bytes.set(chunk.data, binaryHeader + 8 + chunk.offset);
    return result;
  }

  return { document, addBufferView, addAccessor, addExtension, finish };
}
