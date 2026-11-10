import { finiteRange } from './volumetric.js';

// Local volumes: up to MAX_LOCAL_VOLUMES boxes, spheres or parts (shape "mesh") that absorb and emit light, for candle haze, smoke puffs and glowing
// fog in one place. They sit beside environment.volumeFog (the one scattering volume) and need no fog. The post pass marches
// each one separately and composites them from the nearest entry to the farthest, so overlapping volumes are an approximation.

export const MAX_LOCAL_VOLUMES = 8;
export const LOCAL_VOLUME_SHAPES = Object.freeze(['box', 'sphere', 'mesh']);
export const LOCAL_VOLUME_FIT = Object.freeze(['bounds', 'mesh']);
export const LOCAL_VOLUME_FIELDS = Object.freeze(['shape', 'part', 'fit', 'center', 'size', 'radius', 'density', 'falloff', 'absorption', 'emission', 'emissionStrength', 'noiseAmount', 'noiseScale', 'steps']);
export const LOCAL_VOLUME_MAXIMUM_STEPS = 32;

function vectorField(value, minimum, maximum, label) {
  if (!Array.isArray(value) || value.length !== 3) throw new TypeError(`${label} must be an array of three numbers`);
  return value.map(component => finiteRange(component, minimum, maximum, label));
}

function resolveLocalVolume(input, label) {
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
    noiseAmount: finiteRange(input.noiseAmount ?? 0, 0, 1, `${label}.noiseAmount`),
    noiseScale: finiteRange(input.noiseScale ?? 1, 0.001, 100, `${label}.noiseScale`),
    steps: finiteRange(input.steps ?? 16, 4, LOCAL_VOLUME_MAXIMUM_STEPS, `${label}.steps`),
  };
  if (!Number.isInteger(resolved.steps)) throw new RangeError(`${label}.steps must be an integer`);
  if (shape === 'mesh') {
    if (typeof input.part !== 'string' || input.part === '') throw new TypeError(`${label}.part must be the name of the part that bounds the volume`);
    for (const field of ['center', 'size', 'radius']) {
      if (input[field] !== undefined) throw new TypeError(`${label}.${field} belongs to a box or a sphere; a mesh volume takes its place and size from the part named in ${label}.part`);
    }
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

/** Checks a list of local volumes and returns them with every default filled in. Throws an error that names the field. */
export function resolveLocalVolumes(input, label = 'localVolumes') {
  if (!Array.isArray(input)) throw new TypeError(`${label} must be an array of volumes`);
  if (input.length > MAX_LOCAL_VOLUMES) throw new RangeError(`${label} holds at most ${MAX_LOCAL_VOLUMES} volumes, got ${input.length}`);
  return input.map((volume, index) => resolveLocalVolume(volume, `${label}[${index}]`));
}

/** The uniform arrays the post shader reads, one vec4 per volume. Pass resolved volumes. */
export function createLocalVolumeBuffers() {
  const size = MAX_LOCAL_VOLUMES * 4;
  return { count: 0, centers: new Float32Array(size), extents: new Float32Array(size), absorption: new Float32Array(size), emission: new Float32Array(size), steps: new Float32Array(size), axes: new Float32Array(size * 3) };
}

const IDENTITY_AXES = Object.freeze([1, 0, 0, 0, 1, 0, 0, 0, 1]);

export function packLocalVolumes(volumes, buffers) {
  if (volumes.some(volume => volume.shape === 'mesh')) throw new RangeError('A mesh volume names a part: bind it with bindLocalVolumeParts before packing');
  buffers.count = volumes.length;
  volumes.forEach((volume, index) => {
    const at = index * 4;
    const half = volume.shape === 'sphere' ? [volume.radius, volume.radius, volume.radius] : volume.size.map(extent => extent / 2);
    buffers.centers.set([...volume.center, volume.shape === 'sphere' ? 1 : 0], at);
    buffers.extents.set([...half, volume.falloff], at);
    buffers.absorption.set([...volume.absorption.map(channel => channel * volume.density), volume.noiseAmount], at);
    buffers.emission.set([...volume.emission.map(channel => channel * volume.emissionStrength), volume.noiseScale], at);
    buffers.steps.set([volume.steps, 0, 0, 0], at);
    const axes = volume.axes ?? IDENTITY_AXES;
    for (let axis = 0; axis < 3; axis++) buffers.axes.set([axes[axis * 3], axes[axis * 3 + 1], axes[axis * 3 + 2], 0], (index * 3 + axis) * 4);
  });
  return buffers;
}

/** The density factor of a volume at a point, 0 to 1, without noise: 1 at the core, fading over the outer `falloff` share. */
export function localVolumeProfile(volume, x, y, z) {
  if (volume.shape === 'mesh') return 1;
  let offsetX = x - volume.center[0];
  let offsetY = y - volume.center[1];
  let offsetZ = z - volume.center[2];
  if (volume.axes) {
    const axes = volume.axes;
    const alongX = axes[0] * offsetX + axes[1] * offsetY + axes[2] * offsetZ;
    const alongY = axes[3] * offsetX + axes[4] * offsetY + axes[5] * offsetZ;
    offsetZ = axes[6] * offsetX + axes[7] * offsetY + axes[8] * offsetZ;
    offsetX = alongX;
    offsetY = alongY;
  }
  const distance = volume.shape === 'sphere'
    ? Math.hypot(offsetX, offsetY, offsetZ) / volume.radius
    : Math.max(Math.abs(offsetX) / (volume.size[0] / 2), Math.abs(offsetY) / (volume.size[1] / 2), Math.abs(offsetZ) / (volume.size[2] / 2));
  if (distance >= 1) return 0;
  if (volume.falloff === 0) return 1;
  const ratio = Math.min(1, Math.max(0, (distance - (1 - volume.falloff)) / volume.falloff));
  return 1 - ratio * ratio * (3 - 2 * ratio);
}

/** Where a ray is inside a volume, as distances along it: writes `[entry, exit]` into `out`, clipped to `[0, limit]`, and returns true; false when it misses. */
export function localVolumeInterval(volume, originX, originY, originZ, directionX, directionY, directionZ, limit, out) {
  let entry = 0;
  let exit = limit;
  if (volume.shape === 'sphere') {
    const offsetX = originX - volume.center[0];
    const offsetY = originY - volume.center[1];
    const offsetZ = originZ - volume.center[2];
    const along = offsetX * directionX + offsetY * directionY + offsetZ * directionZ;
    const discriminant = along * along - (offsetX * offsetX + offsetY * offsetY + offsetZ * offsetZ - volume.radius * volume.radius);
    if (discriminant <= 0) return false;
    const root = Math.sqrt(discriminant);
    entry = Math.max(entry, -along - root);
    exit = Math.min(exit, -along + root);
  } else {
    const axes = volume.axes;
    const offsetX = originX - volume.center[0];
    const offsetY = originY - volume.center[1];
    const offsetZ = originZ - volume.center[2];
    for (let axis = 0; axis < 3; axis++) {
      const origin = axis === 0 ? originX : axis === 1 ? originY : originZ;
      let direction = axis === 0 ? directionX : axis === 1 ? directionY : directionZ;
      let relative = volume.center[axis] - origin;
      if (axes) {
        const at = axis * 3;
        relative = -(axes[at] * offsetX + axes[at + 1] * offsetY + axes[at + 2] * offsetZ);
        direction = axes[at] * directionX + axes[at + 1] * directionY + axes[at + 2] * directionZ;
      }
      const halfSize = volume.size[axis] / 2;
      if (direction === 0) {
        if (Math.abs(relative) > halfSize) return false;
        continue;
      }
      const first = (relative - halfSize) / direction;
      const second = (relative + halfSize) / direction;
      entry = Math.max(entry, Math.min(first, second));
      exit = Math.min(exit, Math.max(first, second));
    }
  }
  if (!(entry < exit)) return false;
  out[0] = entry;
  out[1] = exit;
  return true;
}
