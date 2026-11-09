// Recipe terrain: a seeded rolling ground with optional round holes, built with the terrain addon as one mesh.
// It loads on demand with the recipes that contain a terrain geometry, so the scene entry does not carry it.
import './world-material-shader.js';
import { createTerrain } from './terrain.js';
import { invalidField } from './field-error.js';

export const TERRAIN_LIMITS = Object.freeze({
  size: [1, 2000],
  resolution: [2, 256],
  amplitude: [0, 200],
  defaultSize: 40,
  defaultResolution: 64,
  defaultAmplitude: 1,
  maximumHoles: 16,
});

function numberWithin(value, fallback, [minimum, maximum], label) {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved < minimum || resolved > maximum) {
    throw invalidField(`terrain.${label}`, resolved, `a number from ${minimum} to ${maximum}, such as ${fallback}`);
  }
  return resolved;
}

function integerWithin(value, fallback, [minimum, maximum], label) {
  const resolved = numberWithin(value, fallback, [minimum, maximum], label);
  if (!Number.isInteger(resolved)) throw invalidField(`terrain.${label}`, resolved, `a whole number, such as ${fallback}`);
  return resolved;
}

/** Vertex count of a terrain record, checked against the recipe limits before any ground is built. */
export function terrainVertexEstimate(value) {
  const resolution = integerWithin(value.resolution, TERRAIN_LIMITS.defaultResolution, TERRAIN_LIMITS.resolution, 'resolution');
  numberWithin(value.size, TERRAIN_LIMITS.defaultSize, TERRAIN_LIMITS.size, 'size');
  numberWithin(value.amplitude, TERRAIN_LIMITS.defaultAmplitude, TERRAIN_LIMITS.amplitude, 'amplitude');
  if (value.holes !== undefined && (!Array.isArray(value.holes) || value.holes.length > TERRAIN_LIMITS.maximumHoles)) {
    throw invalidField('terrain.holes', value.holes, `a list of at most ${TERRAIN_LIMITS.maximumHoles} circles, such as [{ "center": [0, 0], "radius": 2 }]`);
  }
  return (resolution + 1) * (resolution + 1);
}

/** The terrain addon object of a terrain record: render parts plus heightAt, isHole and bounds. Vegetation scatters over the same ground. */
export function createRecipeTerrain(value) {
  const size = value.size ?? TERRAIN_LIMITS.defaultSize;
  const seed = Number.isInteger(value.seed) ? value.seed : 1;
  return createTerrain({
    size,
    chunks: 1,
    levels: 1,
    resolution: value.resolution ?? TERRAIN_LIMITS.defaultResolution,
    seed,
    holes: value.holes,
    height: {
      amplitude: value.amplitude ?? TERRAIN_LIMITS.defaultAmplitude,
      featureSize: size / 4,
      warp: 0,
      mountainMask: () => 0,
    },
  });
}

/** Render geometry of a terrain record: ground from -size / 2 to size / 2 on X and Z, hills of the given amplitude, holes cut out. */
export function generateTerrainGeometry(value, maxVertices) {
  const vertices = terrainVertexEstimate(value);
  if (vertices > maxVertices) throw invalidField('terrain.resolution', value.resolution ?? TERRAIN_LIMITS.defaultResolution, `a resolution whose ${vertices} vertices fit maxVertices ${maxVertices}; lower it`);
  return createRecipeTerrain(value).parts[0].geometry;
}
