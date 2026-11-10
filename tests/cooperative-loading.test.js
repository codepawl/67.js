import assert from 'node:assert/strict';
import test from 'node:test';
import { CHUNK_ELEMENTS, createSlicer, forEachChunk } from '../src/cooperative.js';
import { attributeFloats, attributeFloatsInSlices, createAccessorReader } from '../src/gltf-accessors.js';
import { parseRadianceHdr, parseRadianceHdrInSlices } from '../src/hdri.js';

function countingCheckpoint() {
  const checkpoint = async () => { checkpoint.calls++; };
  checkpoint.calls = 0;
  return checkpoint;
}

test('a slicer returns at once inside its slice and yields after it', async () => {
  let yields = 0;
  const original = globalThis.scheduler;
  globalThis.scheduler = { yield: async () => { yields++; } };
  try {
    await createSlicer(60000)();
    assert.equal(yields, 0);
    const alwaysDue = createSlicer(-1);
    await alwaysDue();
    await alwaysDue();
    assert.equal(yields, 2);
  } finally {
    if (original) globalThis.scheduler = original;
    else delete globalThis.scheduler;
  }
});

test('forEachChunk covers every element once and checks the clock after each chunk', async () => {
  const checkpoint = countingCheckpoint();
  const length = CHUNK_ELEMENTS * 2 + 5;
  const seen = new Uint8Array(length);
  await forEachChunk(length, checkpoint, (from, to) => {
    for (let index = from; index < to; index++) seen[index]++;
  });
  assert.ok(seen.every(count => count === 1));
  assert.equal(checkpoint.calls, 3);
});

test('attributeFloatsInSlices matches attributeFloats for normalized and plain data, in several chunks', async () => {
  const count = CHUNK_ELEMENTS + 100;
  const array = new Uint8Array(count * 3).map((_, index) => index % 256);
  for (const normalized of [true, false]) {
    const attribute = { array, count, itemSize: 3, normalized, componentType: 5121 };
    const checkpoint = countingCheckpoint();
    assert.deepEqual(await attributeFloatsInSlices(attribute, checkpoint), attributeFloats(attribute));
    assert.ok(checkpoint.calls > 1);
  }
});

function accessorDocument() {
  return {
    buffers: [{ byteLength: 0 }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 24 },
      { buffer: 0, byteOffset: 24, byteLength: 40, byteStride: 20 },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 2, type: 'VEC3' },
      { bufferView: 1, componentType: 5126, count: 2, type: 'VEC3' },
      { bufferView: 0, componentType: 5126, count: 6, type: 'SCALAR', sparse: { count: 1, indices: { bufferView: 0, componentType: 5125, byteOffset: 0 }, values: { bufferView: 0, byteOffset: 4 } } },
      { componentType: 5126, count: 3, type: 'VEC2' },
    ],
  };
}

function accessorBytes() {
  const bytes = new Uint8Array(64);
  const view = new DataView(bytes.buffer);
  for (let value = 0; value < 6; value++) view.setFloat32(value * 4, value + 0.5, true);
  view.setUint32(0, 1, true);
  for (let value = 0; value < 5; value++) view.setFloat32(24 + value * 4, 10 + value, true);
  for (let value = 0; value < 5; value++) view.setFloat32(44 + value * 4, 20 + value, true);
  return bytes;
}

test('readAccessorInSlices returns the same accessor as readAccessor for tight, strided, sparse and empty views', async () => {
  const sources = [accessorBytes(), Buffer.from(accessorBytes())];
  for (const source of sources) {
    const reader = createAccessorReader(accessorDocument(), () => source);
    for (let index = 0; index < 4; index++) {
      const expected = reader.readAccessor(index);
      const actual = await reader.readAccessorInSlices(index, countingCheckpoint());
      assert.deepEqual(actual, expected, `accessor ${index}`);
    }
  }
});

test('a tightly packed accessor is copied, not viewed, so changing it leaves the file bytes alone', async () => {
  const source = Buffer.from(accessorBytes());
  const reader = createAccessorReader(accessorDocument(), () => source);
  const before = Buffer.from(source);
  const accessor = await reader.readAccessorInSlices(0, countingCheckpoint());
  accessor.array.fill(0);
  assert.deepEqual(source, before);
});

test('a strided accessor is copied in chunks with a checkpoint between them', async () => {
  const count = CHUNK_ELEMENTS * 2 + 1;
  const source = new Uint8Array(count * 8);
  source.forEach((_, index) => { source[index] = index % 251; });
  const document = {
    buffers: [{ byteLength: source.length }],
    bufferViews: [{ buffer: 0, byteLength: source.length, byteStride: 8 }],
    accessors: [{ bufferView: 0, componentType: 5123, count, type: 'VEC2' }],
  };
  const reader = createAccessorReader(document, () => source);
  const checkpoint = countingCheckpoint();
  assert.deepEqual(await reader.readAccessorInSlices(0, checkpoint), reader.readAccessor(0));
  assert.equal(checkpoint.calls, 3);
});

test('an accessor that overruns its buffer view is refused by the sliced reader too', async () => {
  const document = accessorDocument();
  document.accessors[0].count = 100;
  const reader = createAccessorReader(document, () => accessorBytes());
  await assert.rejects(reader.readAccessorInSlices(0, countingCheckpoint()), /exceeds its buffer view/);
});

function radianceBytes(width, height) {
  const header = new TextEncoder().encode(`#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y ${height} +X ${width}\n`);
  const pixels = new Uint8Array(width * height * 4).map((_, index) => (index % 4 === 3 ? 128 + (index % 7) : (index * 13) % 256));
  const bytes = new Uint8Array(header.length + pixels.length);
  bytes.set(header);
  bytes.set(pixels, header.length);
  return bytes;
}

test('parseRadianceHdrInSlices matches parseRadianceHdr and checks the clock once per row', async () => {
  const bytes = radianceBytes(4, 6);
  const checkpoint = countingCheckpoint();
  assert.deepEqual(await parseRadianceHdrInSlices(bytes, checkpoint), parseRadianceHdr(bytes));
  assert.equal(checkpoint.calls, 6);
});

test('parseRadianceHdrInSlices refuses a bad header with the same error', async () => {
  await assert.rejects(parseRadianceHdrInSlices(new TextEncoder().encode('#?RADIANCE\nFORMAT=other\n\n'), countingCheckpoint()), /Unsupported Radiance HDR format/);
  assert.throws(() => parseRadianceHdr(new TextEncoder().encode('#?RADIANCE\nFORMAT=other\n\n')), /Unsupported Radiance HDR format/);
});

function recordingContext(calls) {
  const constants = { FRAMEBUFFER_COMPLETE: 36053, TEXTURE_2D: 3553 };
  return new Proxy({}, {
    get(_, name) {
      if (name in constants) return constants[name];
      if (name === 'getExtension') return () => ({});
      if (name === 'checkFramebufferStatus') return () => constants.FRAMEBUFFER_COMPLETE;
      return (...callArguments) => {
        calls.push(`${String(name)}(${callArguments.filter(value => typeof value === 'number').join(',')})`);
        return {};
      };
    },
  });
}

test('the sliced environment prefilter issues the same GL calls as the one-piece build and checks the clock between steps', async () => {
  const { createEnvironmentMap, createEnvironmentResources, createEnvironmentResourcesInSlices } = await import('../src/environment.js');
  const width = 64;
  const height = 32;
  const data = new Float32Array(width * height * 3).map((_, index) => (index % 11) / 3);
  const map = createEnvironmentMap({ width, height, data });
  const programs = { compileProgram: () => ({}), fullscreenVertex: '' };
  const wholeCalls = [];
  const slicedCalls = [];
  const whole = createEnvironmentResources(recordingContext(wholeCalls), map, programs);
  const checkpoint = countingCheckpoint();
  const sliced = await createEnvironmentResourcesInSlices(recordingContext(slicedCalls), map, programs, checkpoint);
  assert.deepEqual(slicedCalls, wholeCalls);
  assert.deepEqual(sliced.irradiance, whole.irradiance);
  assert.equal(sliced.levelCount, whole.levelCount);
  assert.ok(checkpoint.calls >= 3 + whole.levelCount, `expected a checkpoint per step, got ${checkpoint.calls}`);
});
