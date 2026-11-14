import { invalidField } from './field-error.js';

// FORMAT-v2 instance visibility bits, the same names a part's `rayVisibility` takes.
export const RAY_VISIBILITY_BITS = Object.freeze({ camera: 1, diffuse: 2, glossy: 4, transmission: 8, shadow: 16, volumeScatter: 32 });

// The shorthand for thin clear glass: shadow rays pass, so sun and sky are sampled through the pane, while camera,
// bounce and volume rays still see it (the pane keeps showing and refracting).
export const GLASS_RAY_VISIBILITY = Object.freeze({ shadow: false });

const RAY_KIND_NAMES = Object.keys(RAY_VISIBILITY_BITS).join(', ');

/**
 * Checks a node's `rayVisibility` at the public boundary and returns the object the path tracer reads:
 * `'glass'` becomes `{ shadow: false }`, an object keeps only booleans for the six ray kinds, and an empty object or
 * all true means nothing is hidden (returned as undefined so the scene packs as before).
 */
export function normalizeRayVisibility(value, path = 'rayVisibility') {
  if (value === undefined) return undefined;
  if (value === 'glass') return GLASS_RAY_VISIBILITY;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidField(path, value, `'glass' or an object such as { "shadow": false } with keys from ${RAY_KIND_NAMES}`, TypeError);
  }
  const resolved = {};
  for (const [kind, flag] of Object.entries(value)) {
    if (RAY_VISIBILITY_BITS[kind] === undefined) {
      throw invalidField(`${path}.${kind}`, flag, `a ray kind from ${RAY_KIND_NAMES}`, TypeError);
    }
    if (typeof flag !== 'boolean') {
      throw invalidField(`${path}.${kind}`, flag, 'true or false', TypeError);
    }
    resolved[kind] = flag;
  }
  return Object.values(resolved).includes(false) ? Object.freeze(resolved) : undefined;
}
