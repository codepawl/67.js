import { parseGltf } from './gltf.js';
import { agentAssetDecodeOptions } from './agent-asset-limits.js';
import { assetCopyKey, recipeAssetNeeds } from './agent-scene-assets.js';

// The catalog assets a game recipe places or retargets clips from, decoded for startGame. The web export writes each asset
// as assets/<id>.glb and tells the page its URL; this file fetches and decodes them, one decoded copy per copy the scene needs.

export const GAME_ASSET_LIMITS = Object.freeze({ maxAssets: 16, maxCopiesPerAsset: 18 });
const ASSET_ID = /^[a-f0-9]{64}$/;

/** The ids of every catalog asset the game needs: the placed ones and the sources of its animation clips. */
export function gameAssetIds(recipe) {
  const ids = new Set(recipeAssetNeeds(recipe).map(need => need.id));
  const animations = [recipe.game?.player?.animation, ...(recipe.game?.npcs ?? []).map(npc => npc.animation)];
  for (const animation of animations) {
    for (const clip of Object.values(animation?.clips ?? {})) {
      const id = clip?.from?.asset;
      if (typeof id === 'string' && ASSET_ID.test(id)) ids.add(id);
    }
  }
  return [...ids];
}

/**
 * Fetch and decode the assets of a recipe. `assetUrls` maps an asset id to the URL of its GLB; `fetchBytes(url)` returns an
 * ArrayBuffer (the global fetch by default). Returns the Map that createAgentScene takes, keyed by assetCopyKey(id, copy).
 */
export async function loadGameAssets(recipe, assetUrls, fetchBytes = defaultFetchBytes) {
  const ids = gameAssetIds(recipe);
  if (ids.length > GAME_ASSET_LIMITS.maxAssets) {
    throw new RangeError(`This game uses ${ids.length} catalog assets; the limit is ${GAME_ASSET_LIMITS.maxAssets}.`);
  }
  const copiesById = new Map(recipeAssetNeeds(recipe).map(need => [need.id, need.copies]));
  const assets = new Map();
  for (const id of ids) {
    const url = assetUrls?.[id];
    if (typeof url !== 'string') {
      throw new RangeError(`The game places or retargets from asset ${id.slice(0, 12)}, but assetUrls has no URL for it. Export the game again with the web export, which writes assets/<id>.glb.`);
    }
    const bytes = await fetchBytes(url);
    const copies = Math.min(copiesById.get(id) ?? 1, GAME_ASSET_LIMITS.maxCopiesPerAsset);
    for (let copy = 0; copy < copies; copy++) {
      assets.set(assetCopyKey(id, copy), await parseGltf(bytes.slice(0), agentAssetDecodeOptions()));
    }
  }
  return assets;
}

async function defaultFetchBytes(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not load ${url}: HTTP ${response.status}.`);
  return response.arrayBuffer();
}
