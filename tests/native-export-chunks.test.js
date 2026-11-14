import assert from 'node:assert/strict';
import test from 'node:test';

import { collectExportChunks } from '../scripts/agent-native-trace.mjs';
import {
  NATIVE_CHUNKED_MAXIMUM_TRIANGLES, NATIVE_EXPORT_CHUNK_BYTES, NATIVE_EXPORT_MAXIMUM_CHARACTERS, NATIVE_JOB_MAXIMUM_TRIANGLES,
  encodedExportLength, exportNativeSceneTables, nativeTableBytes, readExportChunk, splitExportForChunks,
} from '../scripts/native-bake-page.js';
import { MAX_NATIVE_TRACE_TRIANGLES } from '../src/path-tracer-scene.js';

const TRIANGLE_RECORD_BYTES = 224;

function patternedBytes(byteLength) {
  const bytes = new Uint8Array(byteLength);
  for (let index = 0; index < byteLength; index += 4093) {
    bytes[index] = (index * 31 + 7) & 0xff;
  }
  bytes[byteLength - 1] = 0xa5;
  return bytes;
}

function readerOf(tables, calls = []) {
  return async (name, offset) => {
    calls.push([name, offset]);
    return readExportChunk(tables, name, offset);
  };
}

test('a chunk holds a whole number of base64 groups, so chunks decode on their own', () => {
  assert.equal(NATIVE_EXPORT_CHUNK_BYTES % 3, 0);
  assert.ok(encodedExportLength([NATIVE_EXPORT_CHUNK_BYTES]) < NATIVE_EXPORT_MAXIMUM_CHARACTERS / 4, 'one chunk is far below one message');
});

test('the chunked triangle bound is the bound buildTraceScene accepts, above what one message carries', () => {
  assert.equal(NATIVE_CHUNKED_MAXIMUM_TRIANGLES, MAX_NATIVE_TRACE_TRIANGLES);
  assert.ok(NATIVE_CHUNKED_MAXIMUM_TRIANGLES > NATIVE_JOB_MAXIMUM_TRIANGLES);
  assert.ok(encodedExportLength([NATIVE_CHUNKED_MAXIMUM_TRIANGLES * TRIANGLE_RECORD_BYTES]) > NATIVE_EXPORT_MAXIMUM_CHARACTERS,
    'the triangles of the chunked bound would not fit one message');
});

test('nativeTableBytes views the typed arrays of an input without copying and leaves the counts out', () => {
  const triangles = new Float32Array([1, 2, 3, 4]);
  const words = new Uint32Array(8).subarray(2, 5);
  const tables = nativeTableBytes({ schemaVersion: 2, triangleCount: 1, triangles, words });
  assert.deepEqual(Object.keys(tables), ['triangles', 'words']);
  assert.equal(tables.triangles.buffer, triangles.buffer);
  assert.equal(tables.triangles.byteLength, 16);
  assert.equal(tables.words.byteOffset, 8);
  assert.equal(tables.words.byteLength, 12);
});

test('a table longer than one chunk arrives byte for byte, and the manifest is small', async () => {
  const large = patternedBytes(NATIVE_EXPORT_CHUNK_BYTES + 7);
  const small = Uint8Array.from([9, 8, 7, 6, 5]);
  const empty = new Uint8Array(0);
  const exported = { schemaVersion: 2, tables: { large, small, empty }, types: { large: 'Uint8Array', small: 'Uint8Array', empty: 'Uint8Array' },
    counts: { triangleCount: 3 }, triangles: 3, wholeMaterials: true };
  const { manifest, tables } = splitExportForChunks(exported);
  assert.equal(manifest.tables, undefined, 'the manifest carries no table');
  assert.deepEqual(manifest.chunks, { tables: { large: large.byteLength, small: 5, empty: 0 }, chunkBytes: NATIVE_EXPORT_CHUNK_BYTES });
  assert.ok(JSON.stringify(manifest).length < 1000);
  const calls = [];
  const collected = await collectExportChunks(JSON.parse(JSON.stringify(manifest)), readerOf(tables, calls));
  assert.deepEqual(calls, [['large', 0], ['large', NATIVE_EXPORT_CHUNK_BYTES], ['small', 0]], 'an empty table needs no read');
  assert.equal(collected.chunks, undefined);
  assert.equal(collected.triangles, 3);
  assert.deepEqual(collected.counts, { triangleCount: 3 });
  assert.equal(Buffer.compare(collected.tables.large, large), 0);
  assert.deepEqual([...collected.tables.small], [9, 8, 7, 6, 5]);
  assert.equal(collected.tables.empty.byteLength, 0);
  assert.equal(collected.tables.large.byteOffset, 0, 'a collected table starts its own buffer');
});

test('reading a chunk names what is wrong with the request', () => {
  const tables = { triangles: new Uint8Array(10) };
  assert.throws(() => readExportChunk(tables, 'materials', 0), /there is no table "materials" in the held export \(tables: triangles\)/);
  assert.throws(() => readExportChunk(null, 'triangles', 0), /tables: none/);
  assert.throws(() => readExportChunk(tables, 'triangles', 10), /offset 10 of table "triangles" must be a multiple of \d+ below its 10 bytes/);
  assert.throws(() => readExportChunk(tables, 'triangles', 3), /must be a multiple of/);
});

test('a chunk of the wrong length, or an export without a manifest, is refused', async () => {
  const manifest = { chunks: { tables: { triangles: 12 }, chunkBytes: NATIVE_EXPORT_CHUNK_BYTES } };
  const shortReader = async () => Buffer.alloc(9).toString('base64');
  await assert.rejects(collectExportChunks(manifest, shortReader), /sent 9 bytes of table "triangles" at offset 0, expected 12/);
  await assert.rejects(collectExportChunks({ tables: {} }, shortReader), /carries no `chunks` manifest/);
});

test('splitExportForChunks refuses the base64 tables of a one-message export', () => {
  assert.throws(() => splitExportForChunks({ tables: { triangles: 'AAAA' } }), /table "triangles" is not bytes\. Export with transport "chunks"/);
});

test('the chunk transport returns byte tables and skips the one-message check; an unknown transport is refused', () => {
  const huge = new Uint8Array(1);
  Object.defineProperty(huge, 'byteLength', { value: 400_000_000 });
  const oversizedInput = () => ({ schemaVersion: 2, triangles: huge, triangleCount: 1, instanceCount: 2 });
  const traceScene = { instances: [], indices: new Uint32Array(3) };
  const modules = { buildTraceScene: () => traceScene, refuseLocalVolumes: () => {}, resolveTexture: () => null, buildNativeInput: oversizedInput,
    buildJobNativeInput: oversizedInput, buildFlattenedJobNativeInput: oversizedInput, pack: {} };
  const request = { parts: [], environment: {}, camera: {}, options: {}, kernel: 'cycles', instancing: true, modules };
  assert.throws(() => exportNativeSceneTables(request), error => error.exportTooLarge === true);
  // The chunk transport never measures the tables against a message: the same oversized input fails only where a view of
  // 400 MB that the one real byte cannot back is made, not with the export refusal.
  assert.throws(() => exportNativeSceneTables({ ...request, transport: 'chunks' }), error => error.exportTooLarge !== true);
  const smallInput = () => ({ schemaVersion: 2, triangles: new Float32Array([1, 2]), triangleCount: 1, instanceCount: 2 });
  const chunked = exportNativeSceneTables({ ...request, transport: 'chunks', modules: { ...modules, buildJobNativeInput: smallInput } });
  assert.ok(chunked.tables.triangles instanceof Uint8Array);
  assert.equal(chunked.tables.triangles.byteLength, 8);
  assert.equal(chunked.types.triangles, 'Float32Array');
  assert.throws(() => exportNativeSceneTables({ ...request, transport: 'file' }), /transport must be "message" or "chunks", got "file"/);
});

test('the chunk transport asks buildTraceScene for the chunked triangle bound', () => {
  const asked = [];
  const input = () => ({ schemaVersion: 2, triangles: new Float32Array(4), triangleCount: 1, instanceCount: 1 });
  const modules = { buildTraceScene: (parts, environment, options) => { asked.push(options.maximumTriangles); return { instances: [], indices: new Uint32Array(3) }; },
    refuseLocalVolumes: () => {}, resolveTexture: () => null, buildNativeInput: input, buildJobNativeInput: input, buildFlattenedJobNativeInput: input, pack: {} };
  const request = { parts: [], environment: {}, camera: {}, options: {}, kernel: 'cycles', instancing: true, modules };
  exportNativeSceneTables(request);
  exportNativeSceneTables({ ...request, transport: 'chunks' });
  assert.deepEqual(asked, [NATIVE_JOB_MAXIMUM_TRIANGLES, NATIVE_CHUNKED_MAXIMUM_TRIANGLES]);
});
