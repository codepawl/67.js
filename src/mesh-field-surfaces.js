import { compileNode, constantScalar, isBoundedNumber, isPlainObject, scalarValue, vectorValue } from './expression.js';

// Field inputs that read another surface: "nearest" (Geometry Proximity and Sample Nearest Surface) and "raycast"
// (Raycast). The surface is named by the caller's context: a geometry id when instances scatter, a geometry record
// inside a mesh edit. The surface sits in the same local space as the elements asking, and answers come from a
// triangle BVH, so the same input always gives the same value.
//
//   { "nearest": { "surface": "path", "read": "distance" } }
//   { "raycast": { "surface": "terrain", "at": { "add": [{ "attr": "position" }, [0, 100, 0] ] }, "direction": [0, -1, 0], "read": "point" } }

const NEAREST_READS = Object.freeze(['distance', 'point', 'normal']);
const RAYCAST_READS = Object.freeze(['hit', 'distance', 'point', 'normal']);
const VECTOR_READS = new Set(['point', 'normal']);
export const MAX_SURFACE_TRIANGLE_TESTS = 20_000_000;

function surfaceError(message) {
  return new TypeError(`Field expression: ${message}`);
}

function onlyKeys(settings, allowed, label) {
  for (const key of Object.keys(settings)) {
    if (!allowed.includes(key)) throw surfaceError(`${label} does not take ${JSON.stringify(key.slice(0, 24))}; fields: ${allowed.join(', ')}.`);
  }
}

/**
 * Build the lookup a context hands to surface inputs, with one shared work budget. `loadSurface(surface)` returns a
 * mesh query index (nearest and project); it is called once per distinct surface. The caller builds the index, so
 * contexts that never read a surface do not pull the query code into their bundle.
 */
export function createSurfaceLookup(loadSurface) {
  const indices = new Map();
  const budget = { remaining: MAX_SURFACE_TRIANGLE_TESTS };
  return {
    budget,
    indexOf(surface) {
      if (!loadSurface) throw new RangeError('This context has no surfaces to sample.');
      const key = typeof surface === 'string' ? surface : JSON.stringify(surface);
      if (!indices.has(key)) indices.set(key, loadSurface(surface));
      return indices.get(key);
    },
  };
}

function checkedSurface(settings, label) {
  const surface = settings.surface;
  if (typeof surface !== 'string' && !isPlainObject(surface)) throw surfaceError(`${label} needs a surface: a geometry id or a geometry record.`);
  return surface;
}

function checkedRead(settings, allowed, fallback, label) {
  const read = settings.read ?? fallback;
  if (!allowed.includes(read)) throw surfaceError(`${label} read must be one of ${allowed.join(', ')}.`);
  return read;
}

function atParts(settings, state, depth, label, positionInput) {
  const at = settings.at === undefined ? positionInput() : compileNode(settings.at, state, depth + 1);
  if (at.kind !== 'vector') throw surfaceError(`${label} "at" needs a vector.`);
  return at.parts;
}

// Run the query once per element and share the answer between the three parts of a vector read.
function readResult(read, queryAt, miss) {
  const missingValue = miss ?? 0;
  const cache = { index: -1, found: null };
  const foundAt = index => {
    if (cache.index !== index) {
      cache.found = queryAt(index);
      cache.index = index;
    }
    return cache.found;
  };
  if (!VECTOR_READS.has(read)) {
    return scalarValue(index => {
      const found = foundAt(index);
      if (read === 'hit') return found ? 1 : 0;
      return found ? found.distance : missingValue;
    });
  }
  const part = axis => index => {
    const found = foundAt(index);
    return found ? found[read][axis] : missingValue;
  };
  return vectorValue(part(0), part(1), part(2));
}

function chargedQuery(state, run) {
  const { budget } = state.context.surfaceLookup;
  const result = run(budget.remaining);
  budget.remaining -= result.triangleTests;
  if (budget.remaining <= 0) throw new RangeError('Field expression searched too many surface triangles. Use fewer elements or a simpler surface.');
  return result.hit;
}

export function compileNearest(node, state, depth, positionInput) {
  const settings = node.nearest;
  if (!isPlainObject(settings)) throw surfaceError('nearest takes { surface, at, read }.');
  onlyKeys(settings, ['surface', 'at', 'read'], 'nearest');
  const surface = checkedSurface(settings, 'nearest');
  const read = checkedRead(settings, NEAREST_READS, 'distance', 'nearest');
  const [partX, partY, partZ] = atParts(settings, state, depth, 'nearest', positionInput);
  const lookup = state.context.surfaceLookup;
  if (!lookup) return VECTOR_READS.has(read) ? vectorValue(() => 0, () => 0, () => 0) : constantScalar(0);
  const surfaceIndex = lookup.indexOf(surface);
  return readResult(read, index => chargedQuery(state, remaining => surfaceIndex.nearest([partX(index), partY(index), partZ(index)], { maxTriangleTests: remaining })), 0);
}

export function compileRaycast(node, state, depth, positionInput) {
  const settings = node.raycast;
  if (!isPlainObject(settings)) throw surfaceError('raycast takes { surface, at, direction, read, miss }.');
  onlyKeys(settings, ['surface', 'at', 'direction', 'read', 'miss', 'maxDistance'], 'raycast');
  const surface = checkedSurface(settings, 'raycast');
  const read = checkedRead(settings, RAYCAST_READS, 'hit', 'raycast');
  const direction = settings.direction;
  if (!Array.isArray(direction) || direction.length !== 3 || !direction.every(isBoundedNumber) || direction.every(component => component === 0)) {
    throw surfaceError('raycast direction needs three numbers, not all 0.');
  }
  if (settings.miss !== undefined && !isBoundedNumber(settings.miss)) throw surfaceError('raycast miss must be a number.');
  if (settings.maxDistance !== undefined && !(isBoundedNumber(settings.maxDistance) && settings.maxDistance > 0)) throw surfaceError('raycast maxDistance must be above 0.');
  const [partX, partY, partZ] = atParts(settings, state, depth, 'raycast', positionInput);
  const lookup = state.context.surfaceLookup;
  if (!lookup) return VECTOR_READS.has(read) ? vectorValue(() => 0, () => 0, () => 0) : constantScalar(0);
  const surfaceIndex = lookup.indexOf(surface);
  const maxDistance = settings.maxDistance ?? Infinity;
  return readResult(read, index => chargedQuery(state, remaining => surfaceIndex.project({
    origin: [partX(index), partY(index), partZ(index)], direction, maxDistance, maxTriangleTests: remaining,
  })), settings.miss);
}
