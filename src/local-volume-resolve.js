import { finiteRange, vectorField } from './volumetric.js';

// Local volumes: up to MAX_LOCAL_VOLUMES boxes, spheres or parts (shape "mesh") that absorb and emit light and, with `scatter`, scatter
// the key light and the sky, for candle haze, smoke puffs and glowing fog in one place. They sit beside environment.volumeFog (the one scattering volume) and need no fog. The post pass marches
// each one separately and composites them from the nearest entry to the farthest, so overlapping volumes are an approximation.
// This file holds only the checks, so a scene that has no grid volume does not carry the grid code (local-volume-grid.js, volume-grid.js).

export const MAX_LOCAL_VOLUMES = 8;
export const LOCAL_VOLUME_SHAPES = Object.freeze(['box', 'sphere', 'mesh', 'grid']);
export const LOCAL_VOLUME_FIT = Object.freeze(['bounds', 'mesh']);
export const LOCAL_VOLUME_FIELDS = Object.freeze(['shape', 'part', 'fit', 'center', 'size', 'radius', 'density', 'falloff', 'absorption', 'emission', 'emissionStrength', 'scatter', 'blur', 'noiseAmount', 'noiseScale', 'steps', 'grid', 'frames', 'fps', 'loop', 'temperatureScale', 'blackbodyIntensity', 'anisotropy']);
// The fields only a grid volume takes (#1045), and the steps its denser march may take (the shader's grid loop is bounded by the same number).
export const LOCAL_VOLUME_GRID_FIELDS = Object.freeze(['grid', 'frames', 'fps', 'loop', 'temperatureScale', 'blackbodyIntensity', 'anisotropy']);
export const LOCAL_VOLUME_MAXIMUM_STEPS = 32;

function resolveLocalVolume(input, label, resolveGrid) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError(`${label} must be an object`);
  for (const field of Object.keys(input)) {
    if (!LOCAL_VOLUME_FIELDS.includes(field)) throw new TypeError(`${label} has no field "${field}"; use ${LOCAL_VOLUME_FIELDS.join(', ')}`);
  }
  const shape = input.shape ?? 'box';
  if (!LOCAL_VOLUME_SHAPES.includes(shape)) throw new RangeError(`${label}.shape must be one of ${LOCAL_VOLUME_SHAPES.join(', ')}`);
  const resolved = {
    shape,
    ...(shape === 'mesh' ? {} : { center: vectorField(input.center, -1e5, 1e5, `${label}.center`) }),
    density: finiteRange(input.density ?? 1, 0, 100, `${label}.density`),
    falloff: finiteRange(input.falloff ?? 0.5, 0, 1, `${label}.falloff`),
    absorption: vectorField(input.absorption ?? [1, 1, 1], 0, 1, `${label}.absorption`),
    emission: vectorField(input.emission ?? [0, 0, 0], 0, 1, `${label}.emission`),
    emissionStrength: finiteRange(input.emissionStrength ?? 1, 0, 1000, `${label}.emissionStrength`),
    scatter: finiteRange(input.scatter ?? 0, 0, 1, `${label}.scatter`),
    blur: finiteRange(input.blur ?? 1, 0, 1, `${label}.blur`),
    noiseAmount: finiteRange(input.noiseAmount ?? 0, 0, 1, `${label}.noiseAmount`),
    noiseScale: finiteRange(input.noiseScale ?? 1, 0.001, 100, `${label}.noiseScale`),
    steps: shape === 'grid' ? 0 : finiteRange(input.steps ?? 16, 4, LOCAL_VOLUME_MAXIMUM_STEPS, `${label}.steps`),
  };
  if (shape === 'grid') return resolveGrid(input, resolved, label);
  const gridField = LOCAL_VOLUME_GRID_FIELDS.find(field => input[field] !== undefined);
  if (gridField) throw new TypeError(`${label}.${gridField} belongs to shape "grid"`);
  if (!Number.isInteger(resolved.steps)) throw new RangeError(`${label}.steps must be an integer`);
  if (shape === 'mesh') {
    if (typeof input.part !== 'string' || input.part === '') throw new TypeError(`${label}.part must be the name of the part that bounds the volume`);
    for (const field of ['center', 'size', 'radius']) {
      if (input[field] !== undefined) throw new TypeError(`${label}.${field} belongs to a box or a sphere; a mesh volume takes its place and size from the part named in ${label}.part`);
    }
    if (resolved.scatter > 0 && (input.fit ?? 'bounds') === 'mesh') throw new RangeError(`${label}.scatter is not drawn inside a volume that fits the closed mesh; use fit "bounds" or scatter 0`);
    resolved.part = input.part;
    resolved.fit = input.fit ?? 'bounds';
    if (!LOCAL_VOLUME_FIT.includes(resolved.fit)) throw new RangeError(`${label}.fit must be one of ${LOCAL_VOLUME_FIT.join(', ')}`);
    return resolved;
  }
  if (input.part !== undefined || input.fit !== undefined) throw new TypeError(`${label}.part and ${label}.fit belong to shape "mesh"`);
  if (shape === 'sphere') {
    if (input.size !== undefined) throw new TypeError(`${label}.size belongs to a box; a sphere takes radius`);
    resolved.radius = finiteRange(input.radius, 0.001, 1e4, `${label}.radius`);
  } else {
    if (input.radius !== undefined) throw new TypeError(`${label}.radius belongs to a sphere; a box takes size [width, height, depth]`);
    resolved.size = vectorField(input.size, 0.001, 1e4, `${label}.size`);
  }
  return resolved;
}

/** As resolveLocalVolumes, with the function that resolves a volume of shape "grid" passed in. */
export function resolveLocalVolumesWith(resolveGrid, input, label = 'localVolumes') {
  if (!Array.isArray(input)) throw new TypeError(`${label} must be an array of volumes`);
  if (input.length > MAX_LOCAL_VOLUMES) throw new RangeError(`${label} holds at most ${MAX_LOCAL_VOLUMES} volumes, got ${input.length}`);
  return input.map((volume, index) => resolveLocalVolume(volume, `${label}[${index}]`, resolveGrid));
}
