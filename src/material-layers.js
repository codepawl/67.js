// Extra PBR layers on top of the base metallic-roughness material, named as in the glTF KHR_materials_* extensions.
// This module holds plain data only, so the MCP server, recipes, the glTF code and the renderer share one set of ranges.

const UNIT = Object.freeze([0, 1]);
// Bit 0 is the sun, then the point, spot and area lights in that order (light-link-bits.js). Every bit of the 32 bit integer is set.
export const ALL_LIGHTS_MASK = -1;

export const MATERIAL_LAYER_DEFAULTS = Object.freeze({
  clearcoat: 0,
  clearcoatRoughness: 0,
  transmission: 0,
  thickness: 0,
  ior: 1.5,
  attenuationColor: Object.freeze([1, 1, 1]),
  attenuationDistance: Infinity,
  sheenColor: Object.freeze([0, 0, 0]),
  sheenRoughness: 0,
  specular: 1,
  specularColor: Object.freeze([1, 1, 1]),
  anisotropy: 0,
  anisotropyRotation: 0,
  iridescence: 0,
  iridescenceIor: 1.3,
  iridescenceThickness: 400,
  toon: 0,
});

export const MATERIAL_LAYER_FIELDS = Object.freeze(Object.keys(MATERIAL_LAYER_DEFAULTS));

export const MATERIAL_LAYER_SCALAR_RANGES = Object.freeze({
  clearcoat: UNIT,
  clearcoatRoughness: UNIT,
  transmission: UNIT,
  thickness: Object.freeze([0, 1000]),
  ior: Object.freeze([1, 2.5]),
  sheenRoughness: UNIT,
  specular: Object.freeze([0, 4]),
  anisotropy: UNIT,
  anisotropyRotation: Object.freeze([-2 * Math.PI, 2 * Math.PI]),
  iridescence: UNIT,
  iridescenceIor: Object.freeze([1, 3]),
  iridescenceThickness: Object.freeze([0, 1200]),
  toon: Object.freeze([0, 8]),
});

export const MATERIAL_LAYER_COLOR_RANGES = Object.freeze({
  attenuationColor: UNIT,
  sheenColor: UNIT,
  specularColor: Object.freeze([0, 4]),
});

function describeRange([minimum, maximum]) {
  return `between ${minimum} and ${maximum}`;
}

function checkScalar(field, value) {
  const [minimum, maximum] = MATERIAL_LAYER_SCALAR_RANGES[field];
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new RangeError(`${field} must be ${describeRange(MATERIAL_LAYER_SCALAR_RANGES[field])}, got ${value}. Use a number inside that range.`);
  }
}

function checkColor(field, value) {
  const [minimum, maximum] = MATERIAL_LAYER_COLOR_RANGES[field];
  const isLinearColor = Array.isArray(value) && value.length === 3 &&
    value.every(component => typeof component === 'number' && Number.isFinite(component) && component >= minimum && component <= maximum);
  if (!isLinearColor) {
    throw new RangeError(`${field} must be three linear RGB numbers ${describeRange(MATERIAL_LAYER_COLOR_RANGES[field])}. Pass [red, green, blue].`);
  }
}

function checkAttenuationDistance(value) {
  const isPositive = typeof value === 'number' && value > 0 && Number.isFinite(value);
  if (!isPositive) {
    throw new RangeError(`attenuationDistance must be a finite number above 0 (metres), got ${value}. Leave it out for no absorption.`);
  }
}

/** Throws a RangeError that names the field and the fix for the first layer value that is out of range. */
export function validateMaterialLayers(material) {
  for (const field of Object.keys(MATERIAL_LAYER_SCALAR_RANGES)) {
    if (material[field] !== undefined) checkScalar(field, material[field]);
  }
  for (const field of Object.keys(MATERIAL_LAYER_COLOR_RANGES)) {
    if (material[field] !== undefined) checkColor(field, material[field]);
  }
  if (material.attenuationDistance !== undefined && material.attenuationDistance !== Infinity) {
    checkAttenuationDistance(material.attenuationDistance);
  }
  if (material.transmission > 0 && material.tag !== undefined && material.tag !== 'surface' && material.tag !== 'gltf' && material.tag !== 'liquid') {
    throw new RangeError(`transmission needs a standard PBR material tag, got ${material.tag}. Use the surface tag.`);
  }
}

// A material graph's {"fresnel":{"ior":n}} factor of emission (material-graph.js) reaches the renderers as `emissionFresnel`:
// the IOR, or 0 for none. The raster shader and the CPU path tracer both evaluate this same curve per pixel.
export const EMISSION_FRESNEL_IOR_RANGE = Object.freeze([1.01, 3]);

/** Schlick's Fresnel reflectance of a dielectric at the cosine between the view and the normal: 1 at grazing angles. */
export function fresnelSchlick(cosine, ior) {
  const normalIncidence = ((ior - 1) / (ior + 1)) ** 2;
  const clamped = Math.min(Math.max(cosine, 0), 1);
  return normalIncidence + (1 - normalIncidence) * (1 - clamped) ** 5;
}

export function materialLayerValue(material, field) {
  return material[field] ?? MATERIAL_LAYER_DEFAULTS[field];
}

/** True when the material asks for any layer beyond the base material. */
export function hasMaterialLayers(material) {
  return MATERIAL_LAYER_FIELDS.some(field => material[field] !== undefined && material[field] !== MATERIAL_LAYER_DEFAULTS[field]
    && JSON.stringify(material[field]) !== JSON.stringify(MATERIAL_LAYER_DEFAULTS[field]));
}

/** Reflectance of a dielectric at normal incidence, as the glTF specular and IOR extensions combine it. */
export function dielectricReflectance(material) {
  const ior = materialLayerValue(material, 'ior');
  const fromIor = ((ior - 1) / (ior + 1)) ** 2;
  const weight = materialLayerValue(material, 'specular');
  return materialLayerValue(material, 'specularColor').map(component => Math.min(fromIor * component, 1) * weight);
}

/**
 * Plain values the renderer batches by: dielectric F0 (3), coat (2), sheen (4), transmission (4), attenuation colour (3),
 * anisotropy strength and rotation (2), iridescence factor, film IOR and film thickness in nanometres (3), light mask (1), toon bands (1), and the subsurface block as JSON, or '' (1; subsurface-limits.js and the addon read it).
 */
export function materialLayerState(material) {
  validateMaterialLayers(material);
  return [
    ...dielectricReflectance(material),
    materialLayerValue(material, 'clearcoat'),
    materialLayerValue(material, 'clearcoatRoughness'),
    ...materialLayerValue(material, 'sheenColor'),
    materialLayerValue(material, 'sheenRoughness'),
    materialLayerValue(material, 'transmission'),
    materialLayerValue(material, 'ior'),
    materialLayerValue(material, 'thickness'),
    materialLayerValue(material, 'attenuationDistance'),
    ...materialLayerValue(material, 'attenuationColor'),
    materialLayerValue(material, 'anisotropy'),
    materialLayerValue(material, 'anisotropyRotation'),
    materialLayerValue(material, 'iridescence'),
    materialLayerValue(material, 'iridescenceIor'),
    materialLayerValue(material, 'iridescenceThickness'),
    material.lightMask ?? ALL_LIGHTS_MASK,
    materialLayerValue(material, 'toon'),
    material.subsurface ? JSON.stringify(material.subsurface) : '',
    material.emissionFresnel ?? 0,
  ];
}

export const MATERIAL_LAYER_STATE_LENGTH = 25;
