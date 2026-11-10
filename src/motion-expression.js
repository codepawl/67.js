import { knownKeys } from './motion-validation.js';
import { COMPONENTS, compileNode, createOperators, isPlainObject, liftOperator, scalarValue } from './expression.js';

// Bounded motion expressions: the motion context of the one expression language in expression.js, for drivers and
// constraint influence. An expression is data, never code. See that file for the operators and how they behave.
//
//   { "mul": [{ "node": "wheel", "property": "rotation", "component": "x" }, 0.01] }
//   { "clamp": [{ "mul": ["time", 0.5] }, 0, 1] }
//
// Variables, besides "time" (the motion time in seconds):
//   { "custom": { "node": "lid", "name": "open", "component": "x" } }   a custom property (component for vector and colour)
//   { "distance": { "from": "a", "to": "b" } }                          world distance between two nodes
//   { "rotationDifference": { "from": "a", "to": "b" } }                angle between two world rotations, 0 to 180 degrees
// The string "time" is the motion time in seconds. A node read takes a component (x, y or z) of a node's translation,
// scale, or rotation (Euler XYZ in degrees), in "local" (default) or "world" space. Vectors, attributes and noise
// belong to fields and are rejected here. sin and cos take radians.

export const MAX_EXPRESSION_NODES = 64;
export const MAX_EXPRESSION_DEPTH = 8;
const READ_PROPERTIES = ['translation', 'rotation', 'scale'];

// The one operator that differs from fields. A driver that divides by zero is a mistake the agent should hear about:
// the result is non-finite and `evaluate` rejects it, where a field turns it into 0.
const OPERATORS = createOperators();
OPERATORS.set('div', liftOperator(2, 2, (left, right) => left / right));

function compileRead(input, state) {
  const { label, nodeIds } = state;
  knownKeys(input, ['node', 'property', 'component', 'space'], `${label} node read`);
  if (!nodeIds.has(input.node)) throw new RangeError(`${label}: node ${JSON.stringify(input.node)} is not in this scene.`);
  if (!READ_PROPERTIES.includes(input.property)) throw new RangeError(`${label}: property must be translation, rotation or scale.`);
  if (!Object.hasOwn(COMPONENTS, input.component)) throw new RangeError(`${label}: component must be x, y or z.`);
  const space = input.space ?? 'local';
  if (space !== 'local' && space !== 'world') throw new RangeError(`${label}: space must be local or world.`);
  state.reads.add(input.node);
  const component = COMPONENTS[input.component];
  return scalarValue(context => context.read(input.node, input.property, component, space));
}

function compileCustom(input, state) {
  const { label, nodeIds, properties } = state;
  knownKeys(input, ['node', 'name', 'component'], `${label} custom property read`);
  if (!nodeIds.has(input.node)) throw new RangeError(`${label}: node ${JSON.stringify(input.node)} is not in this scene.`);
  const kind = properties.get(input.node)?.get(input.name);
  if (!kind) {
    const names = [...(properties.get(input.node)?.keys() ?? [])];
    throw new RangeError(`${label}: node ${JSON.stringify(input.node)} has no custom property ${JSON.stringify(input.name)}; add it to motion.properties first${names.length ? ` (it has ${names.join(', ')})` : ''}.`);
  }
  if (kind === 'number' && input.component !== undefined) throw new RangeError(`${label}: custom property ${JSON.stringify(input.name)} is a number and takes no component.`);
  if (kind !== 'number' && !Object.hasOwn(COMPONENTS, input.component)) throw new RangeError(`${label}: custom property ${JSON.stringify(input.name)} is a ${kind}; component must be x, y or z.`);
  state.reads.add(input.node);
  const componentIndex = COMPONENTS[input.component] ?? 0;
  return scalarValue(context => context.custom(input.node, input.name, componentIndex));
}

function compilePair(input, state, name, read) {
  const { label, nodeIds } = state;
  knownKeys(input, ['from', 'to'], `${label} ${name}`);
  for (const id of [input.from, input.to]) {
    if (!nodeIds.has(id)) throw new RangeError(`${label}: ${name} node ${JSON.stringify(id)} is not in this scene.`);
    state.reads.add(id);
  }
  return scalarValue(context => read(context, input.from, input.to));
}

const PAIR_READS = new Map([
  ['distance', (context, from, to) => context.distance(from, to)],
  ['rotationDifference', (context, from, to) => context.rotationDifference(from, to)],
]);

function compileInput(node, state) {
  if (node === 'time') return scalarValue(context => context.time);
  if (!isPlainObject(node)) return undefined;
  if (Object.hasOwn(node, 'node')) return compileRead(node, state);
  const keys = Object.keys(node);
  if (keys.length !== 1) return undefined;
  if (keys[0] === 'custom') return compileCustom(node.custom, state);
  if (PAIR_READS.has(keys[0])) return compilePair(node[keys[0]], state, keys[0], PAIR_READS.get(keys[0]));
  return undefined;
}

const MOTION_DIALECT = Object.freeze({
  name: 'motion',
  accepts: 'a number, "time", a node read, a custom property, a distance, a rotationDifference or an operator object',
  maxNodes: MAX_EXPRESSION_NODES,
  maxDepth: MAX_EXPRESSION_DEPTH,
  operators: OPERATORS,
  sourceNames: Object.freeze(['time', 'node', 'custom', 'distance', 'rotationDifference']),
  reject: (message, state) => new TypeError(`${state.label}: ${message}`),
  compileInput,
});

/**
 * Compile an expression. `evaluate({ time, read, custom, distance, rotationDifference })` returns a finite number;
 * `read(id, property, component, space)` supplies node values, `custom(node, name, componentIndex)` a custom property
 * and the last two the world distance and rotation difference of two nodes. `properties` is node -> name -> kind. `reads` lists the node IDs the expression looks at.
 */
export function compileMotionExpression(input, nodeIds, label, properties = new Map()) {
  const state = { dialect: MOTION_DIALECT, nodeCount: 0, label, nodeIds, properties, reads: new Set() };
  const { evaluate: evaluateTree } = compileNode(input, state, 0);
  return Object.freeze({
    reads: [...state.reads],
    evaluate(context) {
      const value = evaluateTree(context);
      if (!Number.isFinite(value)) throw new RangeError(`${label} produced ${value} at time ${context.time}; it must stay finite.`);
      return value;
    },
  });
}
