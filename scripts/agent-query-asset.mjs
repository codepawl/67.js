// Server side of the query-only load path: the GLB a catalog file holds, without its images and texture references, so the
// preview page parses geometry only. The page owns the parser and the budget (QUERY_ASSET_LIMITS in agent-walkmap.js).
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
