import { TAG_PREFIX, meshTags, vertexGroupWeights } from './mesh-data.js';
import { compileNearest, compileRaycast, createSurfaceLookup } from './mesh-field-surfaces.js';
import { MAX_FIELD_NODES, MAX_FIELD_DEPTH, MAX_FIELD_ELEMENTS, MAX_FIELD_WORK, FIELD_ATTRIBUTES } from './mesh-operations.js';
import { faceCentroids, faceNormals, vertexNormals } from './mesh-normals.js';
import {
  COMPONENTS, compileNode, createOperators, describeKey, isBoundedNumber, isPlainObject, requireScalar, scalarValue, vectorValue,
} from './expression.js';

// Bounded field expressions: the field context of the one expression language in expression.js. It computes one value
// per mesh element (a number, or a vector of three numbers) from attributes, noise and math. Agents may be following instructions injected into their input,
// so an expression is data and never code: it is read by walking plain objects against a fixed table of operators,
// compiled once into closures over typed arrays, and checked against its limits before anything is evaluated.
// No string is ever executed or used as a property name: operators come from a Map, and the only other strings
// allowed are the attribute names listed below and tag names, which are matched against existing tags.
//
//   { "mul": [{ "attr": "position", "component": "y" }, 0.5] }
//   { "noise": { "scale": 3, "seed": 7 } }
//   { "gt": [{ "dot": [{ "attr": "normal" }, [0, 1, 0]] }, 0.9] }
//
// A number is a constant, true and false are 1 and 0, and an array of three numbers is a constant vector.
// Scalar operators accept vectors and work on each component, with a scalar spread to all three.

const MAX_NOISE_OCTAVES = 4;
const MAX_NOISE_SCALE = 1000;
const MAX_SEED = 0x7fffffff;
const TAG_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/;
const KIND_NAMES = Object.freeze({ scalar: 'number', vector: 'vector' });

function fieldError(message) {
  return new TypeError(`Field expression: ${message}`);
}

// ---------------------------------------------------------------------------------------------------------------
// Hashing and noise. Integer hashing keeps results identical on every platform.

function hashCell(cellX, cellY, cellZ, seed) {
  let hash = Math.imul(cellX, 0x27d4eb2d) ^ Math.imul(cellY, 0x165667b1) ^ Math.imul(cellZ, 0x85ebca77) ^ Math.imul(seed, 0x9e3779b1);
  hash = Math.imul(hash ^ (hash >>> 15), 0x85ebca6b);
  hash = Math.imul(hash ^ (hash >>> 13), 0xc2b2ae35);
  return ((hash ^ (hash >>> 16)) >>> 0) / 4294967296;
}

function fade(fraction) {
  return fraction * fraction * fraction * (fraction * (fraction * 6 - 15) + 10);
}

function interpolate(start, end, fraction) {
  return start + (end - start) * fraction;
}

/** Smooth value noise in 0 to 1. */
export function valueNoise(x, y, z, seed) {
  const cellX = Math.floor(x);
  const cellY = Math.floor(y);
  const cellZ = Math.floor(z);
  const fractionX = fade(x - cellX);
  const fractionY = fade(y - cellY);
  const fractionZ = fade(z - cellZ);
  const corner = (offsetX, offsetY, offsetZ) => hashCell(cellX + offsetX, cellY + offsetY, cellZ + offsetZ, seed);
  const nearY0 = interpolate(interpolate(corner(0, 0, 0), corner(1, 0, 0), fractionX), interpolate(corner(0, 1, 0), corner(1, 1, 0), fractionX), fractionY);
  const nearY1 = interpolate(interpolate(corner(0, 0, 1), corner(1, 0, 1), fractionX), interpolate(corner(0, 1, 1), corner(1, 1, 1), fractionX), fractionY);
  return interpolate(nearY0, nearY1, fractionZ);
}

/** Per-element random number in 0 to 1 from a whole-number key and a seed. */
export function seededRandom(key, channel, seed) {
  return hashCell(key, channel, 0, seed);
}

function fractalNoise(x, y, z, seed, octaves) {
  let total = 0;
  let amplitude = 1;
  let amplitudeSum = 0;
  let frequency = 1;
  for (let octave = 0; octave < octaves; octave++) {
    total += valueNoise(x * frequency, y * frequency, z * frequency, seed + octave) * amplitude;
    amplitudeSum += amplitude;
    amplitude *= 0.5;
    frequency *= 2;
  }
  return total / amplitudeSum;
}

// ---------------------------------------------------------------------------------------------------------------
// Field operators: the math operators come from expression.js, lifted to vectors. What is here is the part only
// fields have: vectors, comparisons and logic that need numbers, and the safe edge cases that keep a value finite.
// ---------------------------------------------------------------------------------------------------------------
// Vector operators, the part of the language only fields have. The scalar operators come from expression.js.

function requireVector(value, label) {
  if (value.kind !== 'vector') throw fieldError(`${label} needs a vector.`);
  return value.parts;
}

function finiteOrZero(number) {
  return Number.isFinite(number) ? number : 0;
}

function dotValues([left, right]) {
  const [leftX, leftY, leftZ] = requireVector(left, 'dot');
  const [rightX, rightY, rightZ] = requireVector(right, 'dot');
  return scalarValue(index => leftX(index) * rightX(index) + leftY(index) * rightY(index) + leftZ(index) * rightZ(index));
}

function crossValues([left, right]) {
  const [leftX, leftY, leftZ] = requireVector(left, 'cross');
  const [rightX, rightY, rightZ] = requireVector(right, 'cross');
  return vectorValue(
    index => leftY(index) * rightZ(index) - leftZ(index) * rightY(index),
    index => leftZ(index) * rightX(index) - leftX(index) * rightZ(index),
    index => leftX(index) * rightY(index) - leftY(index) * rightX(index),
  );
}

function lengthValue([operand]) {
  const [partX, partY, partZ] = requireVector(operand, 'length');
  return scalarValue(index => Math.hypot(partX(index), partY(index), partZ(index)));
}

function distanceValues([left, right]) {
  const [leftX, leftY, leftZ] = requireVector(left, 'distance');
  const [rightX, rightY, rightZ] = requireVector(right, 'distance');
  return scalarValue(index => Math.hypot(leftX(index) - rightX(index), leftY(index) - rightY(index), leftZ(index) - rightZ(index)));
}

function normalizeValue([operand]) {
  const [partX, partY, partZ] = requireVector(operand, 'normalize');
  const lengthAt = index => Math.hypot(partX(index), partY(index), partZ(index));
  const scaled = part => index => {
    const length = lengthAt(index);
    return length === 0 ? 0 : part(index) / length;
  };
  return vectorValue(scaled(partX), scaled(partY), scaled(partZ));
}

function buildVector([partX, partY, partZ]) {
  return vectorValue(
    requireScalar(partX, 'vec'),
    requireScalar(partY, 'vec'),
    requireScalar(partZ, 'vec'),
  );
}

function selectComponent(componentIndex) {
  return ([operand]) => scalarValue(requireVector(operand, 'a component read')[componentIndex]);
}

const vectorOperator = (min, max, build) => ({ min, max, build });

// Operators live in a Map so that input keys such as "__proto__" or "constructor" are plain unknown names.
const OPERATORS = createOperators();
OPERATORS.set('vec', vectorOperator(3, 3, buildVector));
OPERATORS.set('dot', vectorOperator(2, 2, dotValues));
OPERATORS.set('cross', vectorOperator(2, 2, crossValues));
OPERATORS.set('distance', vectorOperator(2, 2, distanceValues));
OPERATORS.set('length', vectorOperator(1, 1, lengthValue));
OPERATORS.set('normalize', vectorOperator(1, 1, normalizeValue));
OPERATORS.set('x', vectorOperator(1, 1, selectComponent(0)));
OPERATORS.set('y', vectorOperator(1, 1, selectComponent(1)));
OPERATORS.set('z', vectorOperator(1, 1, selectComponent(2)));

export { MAX_FIELD_NODES, MAX_FIELD_DEPTH, MAX_FIELD_ELEMENTS, MAX_FIELD_WORK };
const SOURCE_KEYS = Object.freeze(['attr', 'noise', 'random', 'nearest', 'raycast']);
export const FIELD_OPERATORS = Object.freeze([...OPERATORS.keys(), ...SOURCE_KEYS]);

// ---------------------------------------------------------------------------------------------------------------
// Compiling an expression against an element context: { count, positions(), normals(), tag(name) }.

function integerInRange(value, minimum, maximum, label) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw fieldError(`${label} must be an integer from ${minimum} to ${maximum}.`);
  return value;
}

function onlyKeys(node, allowed, label) {
  for (const key of Object.keys(node)) {
    if (!allowed.includes(key)) throw fieldError(`${label} does not take ${describeKey(key)}; fields: ${allowed.join(', ')}.`);
  }
}

function compileAttribute(node, context) {
  onlyKeys(node, ['attr', 'component', 'name'], 'attr');
  if (typeof node.attr !== 'string' || !FIELD_ATTRIBUTES.includes(node.attr)) throw fieldError(`attr must be one of ${FIELD_ATTRIBUTES.join(', ')}.`);
  if (node.attr === 'index') {
    if (node.component !== undefined || node.name !== undefined) throw fieldError('index takes no component or name.');
    return scalarValue(index => index);
  }
  if (node.attr === 'group') {
    if (typeof node.name !== 'string' || !TAG_NAME_PATTERN.test(node.name) || node.component !== undefined) {
      throw fieldError('group needs the name of a vertex group.');
    }
    const weights = context.group(node.name);
    return scalarValue(index => weights[index]);
  }
  if (node.attr === 'tag') {
    if (typeof node.name !== 'string' || !TAG_NAME_PATTERN.test(node.name) || node.component !== undefined) {
      throw fieldError('tag needs a name of 1 to 48 letters, digits, dots, dashes or underscores.');
    }
    const values = context.tag(node.name);
    return scalarValue(index => values[index]);
  }
  if (node.name !== undefined) throw fieldError(`${node.attr} takes no name.`);
  const data = node.attr === 'position' ? context.positions() : context.normals();
  if (node.component === undefined) {
    return vectorValue(index => data[index * 3], index => data[index * 3 + 1], index => data[index * 3 + 2]);
  }
  if (typeof node.component !== 'string' || !Object.hasOwn(COMPONENTS, node.component)) throw fieldError('component must be x, y or z.');
  const offset = COMPONENTS[node.component];
  return scalarValue(index => data[index * 3 + offset]);
}

function compileNoise(node, state, depth) {
  const settings = node.noise;
  if (!isPlainObject(settings)) throw fieldError('noise takes { scale, seed, octaves, at }.');
  onlyKeys(settings, ['scale', 'seed', 'octaves', 'at'], 'noise');
  const scale = settings.scale ?? 1;
  if (typeof scale !== 'number' || !(scale > 0) || scale > MAX_NOISE_SCALE) throw fieldError(`noise scale must be above 0 and at most ${MAX_NOISE_SCALE}.`);
  const seed = integerInRange(settings.seed ?? 0, 0, MAX_SEED, 'noise seed');
  const octaves = integerInRange(settings.octaves ?? 1, 1, MAX_NOISE_OCTAVES, 'noise octaves');
  const at = settings.at === undefined ? compileAttribute({ attr: 'position' }, state.context) : compileNode(settings.at, state, depth + 1);
  const [partX, partY, partZ] = requireVector(at, 'noise "at"');
  return scalarValue(index => fractalNoise(partX(index) * scale, partY(index) * scale, partZ(index) * scale, seed, octaves));
}

function compileRandom(node) {
  const settings = node.random;
  if (!isPlainObject(settings)) throw fieldError('random takes { seed }.');
  onlyKeys(settings, ['seed'], 'random');
  const seed = integerInRange(settings.seed ?? 0, 0, MAX_SEED, 'random seed');
  return scalarValue(index => seededRandom(index, 0, seed));
}

function compileVectorLiteral(node) {
  if (node.length !== 3 || !node.every(isBoundedNumber)) {
    throw fieldError('a vector literal is three finite numbers; build one from expressions with "vec".');
  }
  const [literalX, literalY, literalZ] = node;
  return vectorValue(() => literalX, () => literalY, () => literalZ);
}

// Inputs only a field has: a vector literal, an attribute, noise and random. Anything else is an operator.
function compileInput(node, state, depth) {
  if (Array.isArray(node)) return compileVectorLiteral(node);
  if (!isPlainObject(node)) return undefined;
  if (Object.hasOwn(node, 'attr')) return compileAttribute(node, state.context);
  const keys = Object.keys(node);
  if (keys.length !== 1) return undefined;
  if (keys[0] === 'noise') return compileNoise(node, state, depth);
  if (keys[0] === 'random') return compileRandom(node);
  const positionInput = () => compileAttribute({ attr: 'position' }, state.context);
  if (keys[0] === 'nearest') return compileNearest(node, state, depth, positionInput);
  if (keys[0] === 'raycast') return compileRaycast(node, state, depth, positionInput);
  return undefined;
}

const FIELD_DIALECT = Object.freeze({
  name: 'field',
  accepts: 'a number, a boolean, a vector of three numbers, an attribute, noise, random, nearest, raycast or an operator object',
  maxNodes: MAX_FIELD_NODES,
  maxDepth: MAX_FIELD_DEPTH,
  operators: OPERATORS,
  sourceNames: SOURCE_KEYS,
  reject: fieldError,
  compileInput,
});

/**
 * Compile an expression against a context. The context is { count, positions(), normals(), tag(name) }, or null to
 * only validate. Limits on nodes, depth and elements are enforced here, before any element is evaluated.
 * Returns { kind, nodeCount, evaluate(index), parts }.
 */
export function compileField(expression, context = null) {
  const state = { dialect: FIELD_DIALECT, nodeCount: 0, context: context ?? VALIDATION_CONTEXT };
  const compiled = compileNode(expression, state, 0);
  if (context) {
    if (context.count > MAX_FIELD_ELEMENTS) throw new RangeError(`Field expression: ${context.count} elements is over the limit of ${MAX_FIELD_ELEMENTS}.`);
    if (context.count * state.nodeCount > MAX_FIELD_WORK) throw new RangeError(`Field expression: ${state.nodeCount} nodes over ${context.count} elements is over the work limit of ${MAX_FIELD_WORK}.`);
  }
  return { ...compiled, nodeCount: state.nodeCount };
}

/** Check an expression without a mesh and say whether it is a number or a vector. Throws a TypeError naming the problem. */
export function validateField(expression, { kind } = {}) {
  const compiled = compileField(expression);
  if (kind && compiled.kind !== kind) throw fieldError(`expected a ${KIND_NAMES[kind]} expression, got a ${KIND_NAMES[compiled.kind]}.`);
  return compiled.kind;
}

const EMPTY = new Float64Array(0);
const VALIDATION_CONTEXT = Object.freeze({ count: 0, positions: () => EMPTY, normals: () => EMPTY, tag: () => EMPTY, group: () => EMPTY, surfaceLookup: null });

function finiteValues(source, count, width) {
  const values = new Float64Array(count * width);
  for (let index = 0; index < values.length; index++) values[index] = finiteOrZero(source[index]);
  return values;
}

// ---------------------------------------------------------------------------------------------------------------
// Contexts: the elements an expression runs over.

/** A mesh domain: "point" (one element per vertex) or "face" (one per face). Face values average from points and back. */
export function meshFieldContext(mesh, domain, loadSurface) {
  if (domain !== 'point' && domain !== 'face') throw fieldError('domain must be point or face.');
  const isPoint = domain === 'point';
  const cache = {};
  return {
    count: isPoint ? mesh.vertexCount : mesh.faceCount,
    positions: () => (cache.positions ??= isPoint ? mesh.positions : faceCentroids(mesh)),
    normals: () => (cache.normals ??= isPoint ? vertexNormals(mesh) : faceNormals(mesh).normals),
    surfaceLookup: createSurfaceLookup(loadSurface),
    group: name => {
      const weights = vertexGroupWeights(mesh, name);
      return isPoint ? weights : faceGroupAverage(mesh, weights);
    },
    tag: name => {
      const attribute = mesh.attributes.face[TAG_PREFIX + name];
      if (!attribute) throw new RangeError(`Unknown tag ${name}. Known tags: ${meshTags(mesh).join(', ') || 'none'}.`);
      return isPoint ? pointTagAverage(mesh, attribute.data) : attribute.data;
    },
  };
}

function faceGroupAverage(mesh, pointWeights) {
  const averages = new Float64Array(mesh.faceCount);
  for (let face = 0; face < mesh.faceCount; face++) {
    const start = mesh.faceOffsets[face];
    const end = mesh.faceOffsets[face + 1];
    let sum = 0;
    for (let corner = start; corner < end; corner++) sum += pointWeights[mesh.cornerVertices[corner]];
    averages[face] = sum / (end - start);
  }
  return averages;
}

function pointTagAverage(mesh, faceValues) {
  const sums = new Float64Array(mesh.vertexCount);
  const counts = new Uint32Array(mesh.vertexCount);
  for (let face = 0; face < mesh.faceCount; face++) {
    for (let corner = mesh.faceOffsets[face]; corner < mesh.faceOffsets[face + 1]; corner++) {
      const vertex = mesh.cornerVertices[corner];
      sums[vertex] += faceValues[face];
      counts[vertex]++;
    }
  }
  for (let vertex = 0; vertex < mesh.vertexCount; vertex++) sums[vertex] = counts[vertex] ? sums[vertex] / counts[vertex] : 0;
  return sums;
}

/** A free point set (instance candidates): positions and optional normals, flat arrays of three numbers per point. */
export function pointSetContext(positions, normals, loadSurface) {
  return {
    count: positions.length / 3,
    positions: () => positions,
    normals: () => normals,
    surfaceLookup: createSurfaceLookup(loadSurface),
    group: name => {
      throw new RangeError(`Unknown vertex group ${name}. Point sets carry no groups.`);
    },
    tag: name => {
      throw new RangeError(`Unknown tag ${name}. Point sets carry no tags.`);
    },
  };
}

/**
 * Evaluate an expression over a context. Returns Float64Array: one number per element for a number expression,
 * three per element (x, y, z interleaved) for a vector expression. Non-finite results become 0.
 */
export function evaluateField(expression, context, { kind } = {}) {
  const compiled = compileField(expression, context);
  if (kind && compiled.kind !== kind) throw fieldError(`expected a ${KIND_NAMES[kind]} expression, got a ${KIND_NAMES[compiled.kind]}.`);
  const count = context.count;
  if (compiled.kind === 'scalar') {
    const values = new Float64Array(count);
    for (let index = 0; index < count; index++) values[index] = compiled.evaluate(index);
    return { kind: compiled.kind, values: finiteValues(values, count, 1), nodeCount: compiled.nodeCount };
  }
  const [partX, partY, partZ] = compiled.parts;
  const values = new Float64Array(count * 3);
  for (let index = 0; index < count; index++) {
    values[index * 3] = partX(index);
    values[index * 3 + 1] = partY(index);
    values[index * 3 + 2] = partZ(index);
  }
  return { kind: compiled.kind, values: finiteValues(values, count, 3), nodeCount: compiled.nodeCount };
}

/** Faces for which a number expression is nonzero, as a Uint8Array mask (the "field" selection rule). */
export function fieldFaceMask(mesh, expression) {
  const { values } = evaluateField(expression, meshFieldContext(mesh, 'face'), { kind: 'scalar' });
  const mask = new Uint8Array(mesh.faceCount);
  for (let face = 0; face < mesh.faceCount; face++) mask[face] = values[face] !== 0 ? 1 : 0;
  return mask;
}
