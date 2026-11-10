import { bounded, denseArray, knownKeys, valueFrom } from './motion-validation.js';
import { invalidField } from './field-error.js';

// Custom properties of nodes and bones: named control values that driver expressions read, such as an `open` slider
// of 0 to 1 that moves a lid and dims a light. A property holds one number, a vector or a colour, stays inside its
// min and max, and is constant or animated by linear keys. Its value is a pure function of the time.

export const MAX_PROPERTIES = 32;
export const MAX_PROPERTY_KEYS = 16;
export const PROPERTY_KINDS = Object.freeze(['number', 'vector', 'color']);
const MAX_NAME_LENGTH = 64;
const MAX_MAGNITUDE = 1e6;
const DEFAULT_RANGES = { number: [-MAX_MAGNITUDE, MAX_MAGNITUDE], vector: [-MAX_MAGNITUDE, MAX_MAGNITUDE], color: [0, 1] };

function sizeOf(kind) {
  return kind === 'number' ? 1 : 3;
}

function checkedValue(raw, kind, minimum, maximum, label) {
  if (sizeOf(kind) === 1) return bounded(raw, minimum, maximum, label);
  const value = valueFrom(raw, 3, label);
  for (const component of value) bounded(component, minimum, maximum, label);
  return value;
}

function defaultValue(kind, minimum, maximum) {
  const zero = Math.min(maximum, Math.max(minimum, 0));
  return sizeOf(kind) === 1 ? zero : [zero, zero, zero];
}

function normalizeProperty(input, position, duration, nodeIds) {
  const label = `Motion property ${position}`;
  knownKeys(input, ['node', 'name', 'kind', 'value', 'min', 'max', 'keys'], label);
  if (!nodeIds.has(input.node)) {
    throw invalidField(`${label} node`, input.node, 'a node or bone ID in this recipe, such as "lid"');
  }
  if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > MAX_NAME_LENGTH) {
    throw invalidField(`${label} name`, input.name, `a name of 1 to ${MAX_NAME_LENGTH} characters, such as "open"`);
  }
  const kind = input.kind ?? 'number';
  if (!PROPERTY_KINDS.includes(kind)) {
    throw invalidField(`${label} kind`, kind, `one of ${PROPERTY_KINDS.join(', ')}`);
  }
  const [defaultMinimum, defaultMaximum] = DEFAULT_RANGES[kind];
  const minimum = bounded(input.min ?? defaultMinimum, -MAX_MAGNITUDE, MAX_MAGNITUDE, `${label} min`);
  const maximum = bounded(input.max ?? defaultMaximum, -MAX_MAGNITUDE, MAX_MAGNITUDE, `${label} max`);
  if (!(minimum < maximum)) {
    throw invalidField(`${label} min`, minimum, `a number below max (${maximum})`);
  }
  const result = { node: input.node, name: input.name, kind, min: minimum, max: maximum };
  if (input.keys === undefined) {
    result.value = checkedValue(input.value ?? defaultValue(kind, minimum, maximum), kind, minimum, maximum, `${label} value`);
    return result;
  }
  if (input.value !== undefined) {
    throw invalidField(`${label} value`, input.value, 'a field left out when keys are given, since the keys set the value');
  }
  denseArray(input.keys, MAX_PROPERTY_KEYS, `${label} keys`);
  if (!input.keys.length) {
    throw invalidField(`${label} keys`, input.keys, 'at least one key, such as [{ "time": 0, "value": 0 }, { "time": 1, "value": 1 }]');
  }
  result.keys = input.keys.map((key, index) => {
    knownKeys(key, ['time', 'value'], `${label} key ${index}`);
    return {
      time: bounded(key.time, 0, duration, `${label} key ${index} time`),
      value: checkedValue(key.value, kind, minimum, maximum, `${label} key ${index} value`),
    };
  });
  if (result.keys.some((key, index) => index && key.time <= result.keys[index - 1].time)) {
    throw invalidField(`${label} keys`, input.keys.map(key => key.time), 'keys with rising times, one value per time');
  }
  return result;
}

/** Validate a property list against the node IDs a motion may read. Returns plain data. */
export function normalizeProperties(input, duration, nodeIds) {
  denseArray(input, MAX_PROPERTIES, 'Motion properties');
  const seen = new Set();
  return input.map((property, position) => {
    const normalized = normalizeProperty(property, position, duration, nodeIds);
    const identity = JSON.stringify([normalized.node, normalized.name]);
    if (seen.has(identity)) {
      throw invalidField(`Motion property ${position} name`, normalized.name, `a name no other property of node ${normalized.node} has`);
    }
    seen.add(identity);
    return normalized;
  });
}

/** node ID -> property name -> kind, for compiling expressions that read properties. */
export function propertyKinds(properties = []) {
  const kinds = new Map();
  for (const { node, name, kind } of properties) {
    if (!kinds.has(node)) kinds.set(node, new Map());
    kinds.get(node).set(name, kind);
  }
  return kinds;
}

function valueAt(property, time) {
  const { keys } = property;
  if (!keys) return property.value;
  if (time <= keys[0].time) return keys[0].value;
  const last = keys[keys.length - 1];
  if (time >= last.time) return last.value;
  const after = keys.findIndex(key => key.time > time);
  const before = keys[after - 1];
  const fraction = (time - before.time) / (keys[after].time - before.time);
  const mixed = (start, end) => start + (end - start) * fraction;
  return typeof before.value === 'number' ? mixed(before.value, keys[after].value) : before.value.map((start, index) => mixed(start, keys[after].value[index]));
}

/** `read(node, name, componentIndex, time)` gives a number property or one component of a vector or colour. */
export function createPropertyReader(properties = []) {
  const byNode = new Map();
  for (const property of properties) {
    if (!byNode.has(property.node)) byNode.set(property.node, new Map());
    byNode.get(property.node).set(property.name, property);
  }
  return (node, name, componentIndex, time) => {
    const value = valueAt(byNode.get(node).get(name), time);
    return typeof value === 'number' ? value : value[componentIndex];
  };
}
