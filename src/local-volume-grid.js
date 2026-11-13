import { finiteRange, vectorField } from './volumetric.js';

// Resolves a local volume of shape "grid" (#1045). It loads on demand (the volumeGrid module), so a scene without grid volumes does not carry it.
export const LOCAL_VOLUME_GRID_MAXIMUM_STEPS = 128;

// A grid volume is a box (center, size) whose density, temperature and flame come from a registered grid (volume-grid.js). Its size defaults to the
// grid file's own size once the grid is bound. The faded edge and the noise belong to the other shapes: a grid has its own detail.
export function resolveGridVolume(input, resolved, label) {
  if (typeof input.grid !== 'string' || input.grid === '') throw new TypeError(`${label}.grid must be the name of a registered grid (registerVolumeGrid), made from a VDB by scripts/vdb-to-grid.py`);
  for (const field of ['part', 'fit', 'radius']) {
    if (input[field] !== undefined) throw new TypeError(`${label}.${field} does not apply to a grid volume; it takes center, size and grid`);
  }
  for (const field of ['falloff', 'noiseAmount', 'noiseScale']) {
    if (input[field] !== undefined) throw new TypeError(`${label}.${field} does not apply to a grid volume: its detail comes from the grid`);
  }
  const steps = finiteRange(input.steps ?? 64, 4, LOCAL_VOLUME_GRID_MAXIMUM_STEPS, `${label}.steps`);
  if (!Number.isInteger(steps)) throw new RangeError(`${label}.steps must be an integer`);
  return {
    ...resolved,
    falloff: 0,
    steps,
    grid: input.grid,
    ...(input.size === undefined ? {} : { size: vectorField(input.size, 0.001, 1e4, `${label}.size`) }),
    temperatureScale: finiteRange(input.temperatureScale ?? 1, 0, 1e5, `${label}.temperatureScale`),
    blackbodyIntensity: finiteRange(input.blackbodyIntensity ?? 0, 0, 1, `${label}.blackbodyIntensity`),
    anisotropy: finiteRange(input.anisotropy ?? 0, -0.9, 0.9, `${label}.anisotropy`),
  };
}
