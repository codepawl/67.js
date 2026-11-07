import { parseGltf } from '../src/gltf.js';
import { createSceneQuery } from '../src/scene-query.js';
import { summarizeWalkMap, walkOptionsFor } from './agent-walkmap.js';

// Query-only load path: raycasts and walk maps over a local catalog GLB that is too big to render through MCP. The file is
// read and parsed in the server process (never sent to the preview page), with its textures dropped before decoding, so
// only positions, indices and node matrices are held. Every number below is a hard ceiling the agent cannot raise.
export const QUERY_ASSET_LIMITS = Object.freeze({
  maxVertices: 6_000_000,
  maxTriangles: 6_000_000,
  maxParts: 16_384,
  // Per part BVH budget; the mesh query itself refuses a part over 1,000,000 triangles.
  memoryBudgetMiB: 256,
});

const JSON_CHUNK = 0x4e4f534a;
const TEXTURE_KEY = /Texture$/;

function withoutTextureReferences(value) {
  if (Array.isArray(value)) {
    value.forEach(withoutTextureReferences);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const key of Object.keys(value)) {
    if (TEXTURE_KEY.test(key) && Number.isInteger(value[key]?.index)) delete value[key];
    else withoutTextureReferences(value[key]);
  }
}

/** The same GLB with no images, textures or texture references; the binary chunk is untouched. */
export function geometryOnlyGlb(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 20 || view.getUint32(0, true) !== 0x46546c67 || view.getUint32(16, true) !== JSON_CHUNK) {
    throw new Error('Query-only assets must be GLB files with a JSON chunk first.');
  }
  const jsonLength = view.getUint32(12, true);
  const document = JSON.parse(Buffer.from(bytes.subarray(20, 20 + jsonLength)).toString('utf8'));
  delete document.images;
  delete document.textures;
  delete document.samplers;
  withoutTextureReferences(document.materials);
  const padded = Buffer.from(JSON.stringify(document));
  const jsonBytes = Buffer.concat([padded, Buffer.alloc((4 - (padded.length % 4)) % 4, 0x20)]);
  const rest = bytes.subarray(20 + jsonLength);
  const header = Buffer.alloc(20);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(20 + jsonBytes.length + rest.length, 8);
  header.writeUInt32LE(jsonBytes.length, 12);
  header.writeUInt32LE(JSON_CHUNK, 16);
  return Buffer.concat([header, jsonBytes, rest]);
}

/** Parses the geometry of a catalog GLB inside the query-only limits and returns a scene query over it. */
export async function loadQueryOnlyScene(bytes) {
  const stripped = geometryOnlyGlb(bytes);
  const buffer = stripped.buffer.slice(stripped.byteOffset, stripped.byteOffset + stripped.byteLength);
  const asset = await parseGltf(buffer, { maxBytes: bytes.length + 1024, maxVertices: QUERY_ASSET_LIMITS.maxVertices, maxParts: QUERY_ASSET_LIMITS.maxParts });
  let triangles = 0;
  let vertices = 0;
  for (const part of asset.parts) {
    triangles += part.geometry.indices.length / 3;
    vertices += part.geometry.positions.length / 3;
  }
  if (triangles > QUERY_ASSET_LIMITS.maxTriangles) {
    throw new RangeError(`Query-only asset has ${triangles} triangles, over the query maxTriangles ${QUERY_ASSET_LIMITS.maxTriangles}. Split it or decimate it.`);
  }
  const parts = asset.parts.map((part, position) => ({ id: part.name ?? `part-${position}`, geometry: part.geometry, matrix: part.matrix, material: part.material?.id }));
  const query = createSceneQuery(parts, { memoryBudgetMiB: QUERY_ASSET_LIMITS.memoryBudgetMiB });
  return { query, parts: parts.length, triangles, vertices };
}

/** One loaded scene at a time, keyed by the catalog asset ID. A different asset replaces and disposes the first. */
export function createQueryOnlyCache() {
  let current = null;
  return Object.freeze({
    async walkMap({ assetId, bytes, clearance = 2, groundRange, keepOut, streetY, includeCells = false, ...options }) {
      const started = performance.now();
      if (current?.assetId !== assetId) {
        current?.scene.query.dispose();
        current = null;
        current = { assetId, scene: await loadQueryOnlyScene(await bytes()) };
      }
      const { query, parts, triangles } = current.scene;
      const map = query.walkMap(walkOptionsFor(options, keepOut, streetY));
      return {
        assetId, queryOnly: true, parts, triangles,
        ...summarizeWalkMap(map, { clearance, groundRange, keepOut, includeCells }),
        skippedParts: query.skipped.length, milliseconds: Math.round(performance.now() - started),
      };
    },
    dispose() {
      current?.scene.query.dispose();
      current = null;
    },
  });
}
