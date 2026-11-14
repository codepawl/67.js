import { invalidField } from './field-error.js';

// The emission mask (#1217) validator lives here, outside the core bundle, so only a recipe that sets an emissionMask
// loads it (agent-scene-modules.js). material-layers.js carries the three numbers the renderer binds; the GLSL is in
// material-layer-shaders.js.
const EMISSION_MASK_AXES = Object.freeze(['x', 'y', 'z']);
const EMISSION_MASK_FIELDS = Object.freeze(['axis', 'from', 'to']);
const EMISSION_MASK_LIMIT = 100000;

/**
 * Validate an emission mask, a smooth ramp that multiplies emission along one axis of the part's own space (metres).
 * Returns the canonical { axis, from, to }. `from` is where the glow is 0 and `to` where it is full, so from above to flips the ramp.
 */
export function normalizeEmissionMask(value, label = 'emissionMask') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidField(label, value, 'an object such as { "axis": "y", "from": 0, "to": 0.4 }', TypeError);
  }
  for (const key of Object.keys(value)) {
    if (!EMISSION_MASK_FIELDS.includes(key)) {
      throw invalidField(`${label}.${key}`, value[key], `no such field; use ${EMISSION_MASK_FIELDS.join(', ')}`, TypeError);
    }
  }
  if (!EMISSION_MASK_AXES.includes(value.axis)) {
    throw invalidField(`${label}.axis`, value.axis, `one of ${EMISSION_MASK_AXES.join(', ')}, the object axis the glow ramps along, such as "y"`);
  }
  for (const field of ['from', 'to']) {
    const edge = value[field];
    if (typeof edge !== 'number' || !Number.isFinite(edge) || Math.abs(edge) > EMISSION_MASK_LIMIT) {
      throw invalidField(`${label}.${field}`, edge, `a finite coordinate in metres along the axis within ${EMISSION_MASK_LIMIT}, such as 0.4`);
    }
  }
  if (value.from === value.to) {
    throw invalidField(`${label}.to`, value.to, `a coordinate different from from (${value.from}), since a ramp needs two, such as from 0 to 0.4`);
  }
  return { axis: value.axis, from: value.from, to: value.to };
}
