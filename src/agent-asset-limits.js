// Limits for GLB files an agent imports through the MCP asset catalog. The catalog, the runtime, the preview page and the
// render jobs all read this one object, so the numbers cannot drift apart.
//
// These are tighter than the loadGltf defaults (256 MiB, 8,000,000 vertices) on purpose. The server reads the whole file,
// turns it into a base64 string and hands it to the preview page in one browser call. Measured with a local Chrome:
// 64 MiB and 72 MiB crossed that call (a rise of 128 and 264 MiB in server memory, in 2.7 s and 4.9 s), and 80 MiB and
// above crashed the page. 64 MiB keeps a margin under that ceiling. A scene beyond it loads through loadGltf in code, where the file never
// crosses that call.
export const AGENT_ASSET_LIMITS = Object.freeze({
  maxBytes: 64 * 1024 * 1024,
  maxAssets: 64,
  // The same ceiling for the sum of every asset one call hands to the preview page in one browser message (placed assets,
  // motion sources and sequence frames together). Files that are each under maxBytes can still cross the crash size together.
  maxCombinedBytes: 64 * 1024 * 1024,
  // About 32 bytes a vertex fills a 64 MiB file with 2,000,000; half of that keeps the decoded copy inside the preview memory budget.
  maxVertices: 1_000_000,
  maxParts: 4096,
  maxTexturePixels: 4_194_304,
  maxJoints: 1024,
  maxClips: 256,
});

const MEBIBYTE = 1024 * 1024;

/** The options `parseGltf` takes for a catalog file. */
export function agentAssetDecodeOptions() {
  const { maxBytes, maxVertices, maxParts, maxTexturePixels, maxJoints } = AGENT_ASSET_LIMITS;
  return { maxBytes, maxVertices, maxParts, maxTexturePixels, maxJoints };
}

/** "64 MiB" for byte limits, so a message and the docs read the same. */
export function describeAssetBytes(bytes) {
  return bytes % MEBIBYTE === 0 ? `${bytes / MEBIBYTE} MiB` : `${bytes} bytes`;
}

/** Message for a catalog file over its byte limit; it names the limit, the size it hit and the way out. */
export function assetBytesLimitMessage(size) {
  const limit = AGENT_ASSET_LIMITS.maxBytes;
  return `Asset is ${size} bytes, over the catalog maxBytes ${limit} (${describeAssetBytes(limit)}). Shrink it (meshopt compression, smaller textures) or split it into parts; a larger scene loads through loadGltf in code.`;
}

/** Message for one call whose assets together pass the combined limit; it names the limit, the total and the way out. */
export function combinedAssetBytesLimitMessage(total) {
  const limit = AGENT_ASSET_LIMITS.maxCombinedBytes;
  return `This call sends ${total} bytes of assets to the preview page at once, over the catalog maxCombinedBytes ${limit} (${describeAssetBytes(limit)}). Place fewer or smaller assets in one call and add the rest in later calls, or shrink them (meshopt compression, smaller textures).`;
}

function decodedBase64Bytes(text) {
  const padding = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0;
  return Math.floor(text.length * 3 / 4) - padding;
}

/** Decoded bytes of every base64 asset field in the input of one preview call. */
export function combinedAssetBytes(input) {
  let total = 0;
  for (const field of ['assetData', 'sequenceData', 'sources']) {
    for (const text of Object.values(input?.[field] ?? {})) {
      if (typeof text === 'string') total += decodedBase64Bytes(text);
    }
  }
  if (typeof input?.data === 'string') total += decodedBase64Bytes(input.data);
  return total;
}

/** Throws a RangeError when the assets in one preview call pass the combined limit. */
export function assertCombinedAssetBytes(input) {
  const total = combinedAssetBytes(input);
  if (total > AGENT_ASSET_LIMITS.maxCombinedBytes) throw new RangeError(combinedAssetBytesLimitMessage(total));
}

/**
 * parseGltf tells a code caller to "pass { maxVertices: n }", which an MCP agent cannot do. Swap that advice for the
 * catalog limits and the way out.
 */
export function withCatalogLimitAdvice(error) {
  if (!(error instanceof RangeError) || !/Fix: pass \{[^}]*\}\./.test(error.message)) return error;
  const { maxBytes, maxVertices, maxParts, maxJoints, maxTexturePixels } = AGENT_ASSET_LIMITS;
  const advice = `The MCP catalog limits are maxBytes ${maxBytes}, maxVertices ${maxVertices}, maxParts ${maxParts}, maxJoints ${maxJoints} and maxTexturePixels ${maxTexturePixels}, and an agent cannot raise them. Simplify the asset (fewer vertices, meshopt compression, smaller textures) or load it with loadGltf in code.`;
  return new RangeError(error.message.replace(/Fix: pass \{[^}]*\}\./, advice));
}
