import { invalidField } from './field-error.js';

// Surface wear: a material takes one or two vertex groups (see the vertex_group `measure`) and blends its own paint
// toward a metal layer where the first group is high, then toward dirt where the second group is high. The blend runs per
// pixel in the main fragment shader, so a mesh with no UVs shows bare metal on its edges and dirt in its cavities.
// The two weights ride in the fourth component of the vertex colour attribute as one integer (the attribute that carries
// sky visibility, which is below 2), so no vertex attribute is added.

export const WEAR_LIMITS = Object.freeze({
  threshold: Object.freeze([0, 1]),
  softness: Object.freeze([0.001, 0.5]),
  levels: 2047,
});
export const WEAR_DEFAULTS = Object.freeze({ threshold: 0.5, softness: 0.25 });
export const WEAR_METAL_DEFAULTS = Object.freeze({ color: Object.freeze([0.56, 0.57, 0.58]), metallic: 1, roughness: 0.3 });
export const WEAR_DIRT_DEFAULTS = Object.freeze({ color: Object.freeze([0.05, 0.04, 0.03]), roughness: 0.9 });

// Sky visibility is at most 1, so a packed value of 2 or more marks a vertex that carries wear.
const PACK_OFFSET = 2;
const PACK_BASE = WEAR_LIMITS.levels + 1;

const WEAR_FIELDS = ['mask', 'threshold', 'softness', 'metal', 'dirt'];
const DIRT_FIELDS = ['mask', 'threshold', 'softness', 'color', 'roughness'];
const METAL_FIELDS = ['color', 'metallic', 'roughness'];

function unitNumber(value, label, fallback, [minimum, maximum] = [0, 1]) {
  const result = value ?? fallback;
  if (typeof result !== 'number' || !(result >= minimum && result <= maximum)) {
    throw invalidField(label, value, `a number from ${minimum} to ${maximum}, such as ${fallback}`, TypeError);
  }
  return result;
}

function colorOf(value, label, fallback) {
  const result = value ?? fallback;
  if (!Array.isArray(result) || result.length !== 3 || result.some(channel => typeof channel !== 'number' || !(channel >= 0 && channel <= 1))) {
    throw invalidField(label, value, `three numbers from 0 to 1, such as [${fallback.join(', ')}]`, TypeError);
  }
  return Object.freeze([...result]);
}

function onlyKeys(value, allowed, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidField(label, value, 'an object, such as {}', TypeError);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw invalidField(`${label}.${key}`, value[key], `one of the fields ${allowed.join(', ')}; remove ${key}`, TypeError);
  }
}

function maskName(value, label) {
  if (typeof value !== 'string' || value === '' || value.length > 128) {
    throw invalidField(label, value, 'the name of a vertex group of the mesh, such as "edge"; make it with a vertex_group mesh edit', TypeError);
  }
  return value;
}

/** Validate a material `wear` field and return a frozen copy with every default filled in. */
export function normalizeMaterialWear(value) {
  onlyKeys(value, WEAR_FIELDS, 'wear');
  const metal = value.metal ?? {};
  onlyKeys(metal, METAL_FIELDS, 'wear.metal');
  const result = {
    mask: maskName(value.mask, 'wear.mask'),
    threshold: unitNumber(value.threshold, 'wear.threshold', WEAR_DEFAULTS.threshold, WEAR_LIMITS.threshold),
    softness: unitNumber(value.softness, 'wear.softness', WEAR_DEFAULTS.softness, WEAR_LIMITS.softness),
    metal: Object.freeze({
      color: colorOf(metal.color, 'wear.metal.color', WEAR_METAL_DEFAULTS.color),
      metallic: unitNumber(metal.metallic, 'wear.metal.metallic', WEAR_METAL_DEFAULTS.metallic),
      roughness: unitNumber(metal.roughness, 'wear.metal.roughness', WEAR_METAL_DEFAULTS.roughness),
    }),
  };
  if (value.dirt !== undefined) {
    onlyKeys(value.dirt, DIRT_FIELDS, 'wear.dirt');
    result.dirt = Object.freeze({
      mask: maskName(value.dirt.mask, 'wear.dirt.mask'),
      threshold: unitNumber(value.dirt.threshold, 'wear.dirt.threshold', WEAR_DEFAULTS.threshold, WEAR_LIMITS.threshold),
      softness: unitNumber(value.dirt.softness, 'wear.dirt.softness', WEAR_DEFAULTS.softness, WEAR_LIMITS.softness),
      color: colorOf(value.dirt.color, 'wear.dirt.color', WEAR_DIRT_DEFAULTS.color),
      roughness: unitNumber(value.dirt.roughness, 'wear.dirt.roughness', WEAR_DIRT_DEFAULTS.roughness),
    });
  }
  return Object.freeze(result);
}

function groupWeights(geometry, name, label, nodeId) {
  const weights = geometry.vertexGroups?.[name];
  if (!weights) {
    const known = Object.keys(geometry.vertexGroups ?? {});
    throw invalidField(label, name, `a vertex group of the mesh of node ${nodeId} (known groups: ${known.join(', ') || 'none'}); make one with a vertex_group mesh edit`);
  }
  return weights;
}

/** One packed number per vertex holding the quantized wear weight and dirt weight (0 without a dirt group). */
export function packSurfaceMasks(geometry, wear, nodeId) {
  const wearWeights = groupWeights(geometry, wear.mask, 'wear.mask', nodeId);
  const dirtWeights = wear.dirt ? groupWeights(geometry, wear.dirt.mask, 'wear.dirt.mask', nodeId) : null;
  const packed = new Float32Array(wearWeights.length);
  const levels = WEAR_LIMITS.levels;
  for (let vertex = 0; vertex < packed.length; vertex++) {
    const wearLevel = Math.round(Math.min(1, Math.max(0, wearWeights[vertex])) * levels);
    const dirtLevel = dirtWeights ? Math.round(Math.min(1, Math.max(0, dirtWeights[vertex])) * levels) : 0;
    packed[vertex] = PACK_OFFSET + wearLevel * PACK_BASE + dirtLevel;
  }
  return packed;
}

/** Fractions of the packed value, as the vertex shader decodes it. Used by tests and the debug views. */
export function unpackSurfaceMask(packed) {
  if (packed < PACK_OFFSET) return { wear: 0, dirt: 0 };
  const bits = packed - PACK_OFFSET;
  const wearLevel = Math.floor(bits / PACK_BASE);
  return { wear: wearLevel / WEAR_LIMITS.levels, dirt: (bits - wearLevel * PACK_BASE) / WEAR_LIMITS.levels };
}

const maskedByGeometry = new WeakMap();

/**
 * The geometry with `surfaceMasks` packed from the vertex groups the wear names. Cached per source geometry and wear,
 * so a part keeps its identity between rebuilds and the renderer does not upload it again.
 */
export function geometryWithSurfaceMasks(geometry, wear, nodeId) {
  if (geometry.skyVisibility) {
    throw invalidField('wear', wear.mask, `a mesh without baked sky visibility (node ${nodeId} has it); remove wear or the floor sky bake`);
  }
  const key = `${wear.mask}|${wear.dirt?.mask ?? ''}`;
  let variants = maskedByGeometry.get(geometry);
  if (!variants) {
    variants = new Map();
    maskedByGeometry.set(geometry, variants);
  }
  let masked = variants.get(key);
  if (!masked) {
    masked = { ...geometry, surfaceMasks: packSurfaceMasks(geometry, wear, nodeId) };
    variants.set(key, masked);
  }
  return masked;
}

/** The numbers the fragment shader reads: metal (rgb, metallic), dirt (rgb, roughness), shape (metal roughness, threshold, softness, dirt on) and dirt shape (threshold, softness). */
export function wearUniformValues(wear) {
  const dirt = wear.dirt;
  return {
    metal: [...wear.metal.color, wear.metal.metallic],
    dirt: dirt ? [...dirt.color, dirt.roughness] : [0, 0, 0, 0],
    shape: [wear.metal.roughness, wear.threshold, wear.softness, dirt ? 1 : 0],
    dirtShape: dirt ? [dirt.threshold, dirt.softness] : [0.5, 0.25],
  };
}
