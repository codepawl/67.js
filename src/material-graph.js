import { MATERIAL_GRAPH_LIMITS, MATERIAL_GRAPH_OUTPUTS, MATERIAL_GRAPH_OPERATORS } from './agent-scene-capabilities.js';
import { clampUnit, smoothStep, wrapCell, hashCell, cellularNoise, linearToSrgbByte, createImage, normalMapFromHeightFunction } from './material-texture-kit.js';

// A bounded material node graph. Like a field expression (src/mesh-fields.js), a graph is data and never code: it is
// walked as plain objects against a fixed table of operators, checked against its limits before any pixel is
// evaluated, and baked on the CPU into textures. Nothing here builds shader source, and the only strings accepted are
// the fixed names listed below, so agent input can not reach the GPU as text. Issue 98 will merge this with the field
// language; the shape (one operator per object, numbers are constants, [r, g, b] is a constant vector) already matches.
//
//   { "color": { "ramp": { "value": { "noise": { "scale": 8 } }, "stops": [[0, [0.1, 0.05, 0.02]], [1, [0.6, 0.4, 0.2]]] } },
//     "height": { "noise": { "scale": 8 } } }
//
// Every texture node is periodic over the unit square, so a baked graph tiles. Values are numbers or vectors of three.

const MAX_LITERAL = 1e6;
const MAX_SEED = 0x7fffffff;
const MAX_REPORTED_KEY_LENGTH = 24;
const NOISE_SCALE_LIMIT = 64;
const NOISE_OCTAVE_LIMIT = 6;
// Work units per pixel for the nodes that cost more than a plain operator.
const VORONOI_COST = 8;
const NOISE_COST_PER_OCTAVE = 3;

function graphError(message) {
  return new TypeError(`Material graph: ${message}`);
}

function describeKey(key) {
  const clipped = key.length > MAX_REPORTED_KEY_LENGTH ? `${key.slice(0, MAX_REPORTED_KEY_LENGTH)}...` : key;
  return JSON.stringify(clipped);
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function onlyKeys(node, allowed, label) {
  for (const key of Object.keys(node)) {
    if (!allowed.includes(key)) throw graphError(`${label} does not take ${describeKey(key)}; fields: ${allowed.join(', ')}.`);
  }
}

function integerInRange(value, minimum, maximum, label) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw graphError(`${label} must be a whole number from ${minimum} to ${maximum}.`);
  return value;
}

function oneOf(value, names, label) {
  if (typeof value !== 'string' || !names.includes(value)) throw graphError(`${label} must be one of ${names.join(', ')}.`);
  return value;
}

function finiteLiteral(value) {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= MAX_LITERAL;
}

// ---------------------------------------------------------------------------------------------------------------
// Compiled values take the pixel position: { kind: 'scalar', evaluate(u, v) } or { kind: 'vector', parts: [x, y, z] }.

const scalarValue = evaluate => ({ kind: 'scalar', evaluate });
const vectorValue = (partX, partY, partZ) => ({ kind: 'vector', parts: [partX, partY, partZ] });
const partsOf = value => (value.kind === 'vector' ? value.parts : [value.evaluate, value.evaluate, value.evaluate]);

function liftComponentwise(values, compute) {
  if (values.every(value => value.kind === 'scalar')) {
    const [first, second, third] = values.map(value => value.evaluate);
    return scalarValue((u, v) => compute(first(u, v), second?.(u, v), third?.(u, v)));
  }
  const [first, second, third] = values.map(partsOf);
  const channel = index => (u, v) => compute(first[index](u, v), second?.[index](u, v), third?.[index](u, v));
  return vectorValue(channel(0), channel(1), channel(2));
}

const finiteOrZero = value => (Number.isFinite(value) ? value : 0);
const fract = value => value - Math.floor(value);
const mixNumbers = (start, end, factor) => start + (end - start) * factor;

// name: [argument count, compute(first, second, third)]
const MATH_OPERATORS = new Map([
  ['add', [2, (a, b) => a + b]],
  ['sub', [2, (a, b) => a - b]],
  ['mul', [2, (a, b) => a * b]],
  ['div', [2, (a, b) => (b === 0 ? 0 : a / b)]],
  ['min', [2, (a, b) => Math.min(a, b)]],
  ['max', [2, (a, b) => Math.max(a, b)]],
  ['pow', [2, (a, b) => Math.abs(a) ** Math.min(Math.max(b, -16), 16)]],
  ['abs', [1, Math.abs]],
  ['floor', [1, Math.floor]],
  ['fract', [1, fract]],
  ['sqrt', [1, value => Math.sqrt(Math.max(value, 0))]],
  ['invert', [1, value => 1 - value]],
  ['clamp', [3, (value, low, high) => Math.min(Math.max(value, low), Math.max(low, high))]],
  ['smoothstep', [3, (low, high, value) => (low === high ? (value < low ? 0 : 1) : smoothStep(low, high, value))]],
  ['mix', [3, mixNumbers]],
]);

// ---------------------------------------------------------------------------------------------------------------
// Compiling. The state counts nodes, the work each costs per pixel and the deepest nesting.

function compileCoordinates(node) {
  const axis = oneOf(node.uv, ['u', 'v', 'both'], 'uv');
  if (Object.keys(node).length !== 1) throw graphError('uv takes no other fields.');
  if (axis === 'u') return scalarValue(u => u);
  if (axis === 'v') return scalarValue((u, v) => v);
  return vectorValue(u => u, (u, v) => v, () => 0);
}

function compilePosition(settings, state, depth) {
  if (settings.at === undefined) return [u => u, (u, v) => v];
  const position = compileNode(settings.at, state, depth + 1);
  if (position.kind !== 'vector') throw graphError('"at" needs a vector such as {"uv":"both"}.');
  return position.parts;
}

function textureSettings(node, name, allowed) {
  const settings = node[name];
  if (!isPlainObject(settings) || Object.keys(node).length !== 1) throw graphError(`${name} takes { ${allowed.join(', ')} } and nothing else.`);
  onlyKeys(settings, allowed, name);
  return settings;
}

// Blender's Noise Texture node (2D, Perlin, fractal Brownian motion, Normalize on): Jenkins lookup3 hash of the lattice
// corner, the 8 gradients of its 2D Perlin, 6t^5 - 15t^4 + 10t^3 fade, and the octave sum divided by the amplitude sum.
// Detail is octaves - 1, Roughness 0.5 and Lacunarity 2, the node's defaults.
const HASH_START = (0xdeadbeef + (2 << 2) + 13) >>> 0;
const rotateLeft = (value, bits) => (value << bits) | (value >>> (32 - bits));
const PERLIN_OUTPUT_SCALE = 0.6616;
const NOISE_ROUGHNESS = 0.5;
const NOISE_LACUNARITY = 2;

function hashLatticeCorner(cellX, cellY) {
  let a = (HASH_START + cellX) >>> 0;
  let b = (HASH_START + cellY) >>> 0;
  let c = HASH_START;
  c = (c ^ b) - rotateLeft(b, 14);
  a = ((a ^ c) >>> 0) - rotateLeft(c, 11);
  b = ((b ^ a) >>> 0) - rotateLeft(a, 25);
  c = ((c ^ b) >>> 0) - rotateLeft(b, 16);
  a = ((a ^ c) >>> 0) - rotateLeft(c, 4);
  b = ((b ^ a) >>> 0) - rotateLeft(a, 14);
  c = ((c ^ b) >>> 0) - rotateLeft(b, 24);
  return c >>> 0;
}

function cornerGradient(hash, offsetX, offsetY) {
  const choice = hash & 7;
  const major = choice < 4 ? offsetX : offsetY;
  const minor = 2 * (choice < 4 ? offsetY : offsetX);
  return ((choice & 1) ? -major : major) + ((choice & 2) ? -minor : minor);
}

const fade = value => value * value * value * (value * (value * 6 - 15) + 10);

// A period of 0 leaves the lattice unwrapped, which is Blender's. A period in cells wraps the corner indices so the
// noise repeats every period cells (only the cells at the far edge of the unit square then differ from Blender).
function latticeHash(cellX, cellY, period) {
  if (period === 0) return hashLatticeCorner(cellX, cellY);
  return hashLatticeCorner(wrapCell(cellX, period), wrapCell(cellY, period));
}

function perlinNoise(x, y, period) {
  const cellX = Math.floor(x);
  const cellY = Math.floor(y);
  const fractionX = x - cellX;
  const fractionY = y - cellY;
  const blendX = fade(fractionX);
  const blendY = fade(fractionY);
  const bottom = mixNumbers(
    cornerGradient(latticeHash(cellX, cellY, period), fractionX, fractionY),
    cornerGradient(latticeHash(cellX + 1, cellY, period), fractionX - 1, fractionY),
    blendX,
  );
  const top = mixNumbers(
    cornerGradient(latticeHash(cellX, cellY + 1, period), fractionX, fractionY - 1),
    cornerGradient(latticeHash(cellX + 1, cellY + 1, period), fractionX - 1, fractionY - 1),
    blendX,
  );
  return PERLIN_OUTPUT_SCALE * mixNumbers(bottom, top, blendY);
}

/**
 * Blender's Noise Texture Fac at (x, y), already scaled by the node's Scale. `tileCells` is the first octave's number of
 * cells across the unit square when the noise must repeat, or 0 for Blender's endless lattice.
 */
export function blenderNoise(x, y, octaves, tileCells = 0) {
  let total = 0;
  let amplitude = 1;
  let amplitudeSum = 0;
  let frequency = 1;
  for (let octave = 0; octave < octaves; octave++) {
    total += perlinNoise(x * frequency, y * frequency, tileCells * frequency) * amplitude;
    amplitudeSum += amplitude;
    amplitude *= NOISE_ROUGHNESS;
    frequency *= NOISE_LACUNARITY;
  }
  return 0.5 * total / amplitudeSum + 0.5;
}

// The seed moves the lattice by whole cells, the same for Blender's side (bench/reference/render-blender.py).
const SEED_SHIFT_X = 7919;
const SEED_SHIFT_Y = 104729;
const SEED_SHIFT_RANGE = 1024;

function compileNoise(node, state, depth) {
  const settings = textureSettings(node, 'noise', ['scale', 'seed', 'octaves', 'tile', 'at']);
  const scale = integerInRange(settings.scale ?? 4, 1, NOISE_SCALE_LIMIT, 'noise scale');
  const seed = integerInRange(settings.seed ?? 0, 0, MAX_SEED, 'noise seed');
  const octaves = integerInRange(settings.octaves ?? 4, 1, NOISE_OCTAVE_LIMIT, 'noise octaves');
  if (settings.tile !== undefined && typeof settings.tile !== 'boolean') throw graphError('noise tile must be true or false.');
  const tileCells = settings.tile === false ? 0 : scale;
  const shiftX = (seed * SEED_SHIFT_X) % SEED_SHIFT_RANGE;
  const shiftY = (seed * SEED_SHIFT_Y) % SEED_SHIFT_RANGE;
  state.cost += octaves * NOISE_COST_PER_OCTAVE;
  const [positionU, positionV] = compilePosition(settings, state, depth);
  return scalarValue((u, v) => blenderNoise(positionU(u, v) * scale + shiftX, positionV(u, v) * scale + shiftY, octaves, tileCells));
}

const VORONOI_OUTPUTS = ['distance', 'edge', 'cell'];

function compileVoronoi(node, state, depth) {
  const settings = textureSettings(node, 'voronoi', ['scale', 'seed', 'output', 'at']);
  const scale = integerInRange(settings.scale ?? 4, 1, NOISE_SCALE_LIMIT, 'voronoi scale');
  const seed = integerInRange(settings.seed ?? 0, 0, MAX_SEED, 'voronoi seed');
  const output = oneOf(settings.output ?? 'distance', VORONOI_OUTPUTS, 'voronoi output');
  state.cost += VORONOI_COST;
  const [positionU, positionV] = compilePosition(settings, state, depth);
  return scalarValue((u, v) => {
    const { nearest, second, cell } = cellularNoise(positionU(u, v), positionV(u, v), scale, seed);
    if (output === 'cell') return cell / 4294967296;
    return clampUnit(output === 'edge' ? second - nearest : nearest);
  });
}

const WAVE_DIRECTIONS = ['u', 'v', 'diagonal'];
const WAVE_SHAPES = ['sine', 'saw', 'triangle'];

function compileWave(node, state, depth) {
  const settings = textureSettings(node, 'wave', ['frequency', 'direction', 'shape', 'at']);
  const frequency = integerInRange(settings.frequency ?? 4, 1, NOISE_SCALE_LIMIT, 'wave frequency');
  const direction = oneOf(settings.direction ?? 'u', WAVE_DIRECTIONS, 'wave direction');
  const shape = oneOf(settings.shape ?? 'sine', WAVE_SHAPES, 'wave shape');
  const [positionU, positionV] = compilePosition(settings, state, depth);
  return scalarValue((u, v) => {
    const along = direction === 'u' ? positionU(u, v) : direction === 'v' ? positionV(u, v) : positionU(u, v) + positionV(u, v);
    const phase = along * frequency;
    if (shape === 'sine') return Math.sin(phase * Math.PI * 2) * 0.5 + 0.5;
    return shape === 'saw' ? fract(phase) : 1 - Math.abs(fract(phase) * 2 - 1);
  });
}

function compileChecker(node, state, depth) {
  const settings = textureSettings(node, 'checker', ['count', 'at']);
  const count = integerInRange(settings.count ?? 8, 2, NOISE_SCALE_LIMIT, 'checker count');
  // An odd count would flip the pattern across the tiling seam.
  if (count % 2 !== 0) throw graphError('checker count must be even so it tiles.');
  const [positionU, positionV] = compilePosition(settings, state, depth);
  return scalarValue((u, v) => (Math.floor(positionU(u, v) * count) + Math.floor(positionV(u, v) * count)) % 2 === 0 ? 0 : 1);
}

const GRADIENT_TYPES = ['u', 'v', 'radial'];

function compileGradient(node, state, depth) {
  const settings = textureSettings(node, 'gradient', ['type', 'at']);
  const type = oneOf(settings.type ?? 'u', GRADIENT_TYPES, 'gradient type');
  const [positionU, positionV] = compilePosition(settings, state, depth);
  return scalarValue((u, v) => {
    if (type === 'u') return clampUnit(positionU(u, v));
    if (type === 'v') return clampUnit(positionV(u, v));
    return clampUnit(1 - Math.hypot(positionU(u, v) - 0.5, positionV(u, v) - 0.5) * 2);
  });
}

function checkedStop(stop, index, previousPosition) {
  if (!Array.isArray(stop) || stop.length !== 2) throw graphError(`ramp stop ${index} must be [position, value].`);
  const [position, value] = stop;
  if (typeof position !== 'number' || !Number.isFinite(position) || position < 0 || position > 1 || position <= previousPosition) {
    throw graphError('ramp stop positions must rise strictly from 0 to 1.');
  }
  const isVector = Array.isArray(value);
  if (isVector ? value.length !== 3 || !value.every(finiteLiteral) : !finiteLiteral(value)) {
    throw graphError(`ramp stop ${index} value must be a number or [r, g, b] of finite numbers.`);
  }
  return { position, value, isVector };
}

function compileRamp(node, state, depth) {
  const settings = textureSettings(node, 'ramp', ['value', 'stops']);
  const { stops: rawStops } = settings;
  if (!Array.isArray(rawStops) || rawStops.length < 2 || rawStops.length > MATERIAL_GRAPH_LIMITS.maxStops) {
    throw graphError(`ramp needs 2 to ${MATERIAL_GRAPH_LIMITS.maxStops} stops.`);
  }
  let previousPosition = -1;
  const stops = rawStops.map((stop, index) => {
    const checked = checkedStop(stop, index, previousPosition);
    previousPosition = checked.position;
    return checked;
  });
  if (!stops.every(stop => stop.isVector === stops[0].isVector)) throw graphError('ramp stops are all numbers or all [r, g, b].');
  const input = compileNode(settings.value, state, depth + 1);
  if (input.kind !== 'scalar') throw graphError('ramp "value" needs a number.');
  const channelRamp = channel => (u, v) => {
    const position = clampUnit(input.evaluate(u, v));
    const valueOf = stop => (stop.isVector ? stop.value[channel] : stop.value);
    if (position <= stops[0].position) return valueOf(stops[0]);
    for (let index = 1; index < stops.length; index++) {
      if (position <= stops[index].position) {
        const from = stops[index - 1];
        const to = stops[index];
        return mixNumbers(valueOf(from), valueOf(to), (position - from.position) / (to.position - from.position));
      }
    }
    return valueOf(stops[stops.length - 1]);
  };
  state.cost += 2;
  return stops[0].isVector ? vectorValue(channelRamp(0), channelRamp(1), channelRamp(2)) : scalarValue(channelRamp(0));
}

function compileVector(node, state, depth) {
  if (!Array.isArray(node.vec) || node.vec.length !== 3 || Object.keys(node).length !== 1) throw graphError('vec needs [x, y, z] in an array.');
  const [partX, partY, partZ] = node.vec.map(part => {
    const compiled = compileNode(part, state, depth + 1);
    if (compiled.kind !== 'scalar') throw graphError('vec parts must be numbers.');
    return compiled.evaluate;
  });
  return vectorValue(partX, partY, partZ);
}

function compileMath(name, node, state, depth) {
  const [argumentCount, compute] = MATH_OPERATORS.get(name);
  const operands = argumentCount === 1 && !Array.isArray(node[name]) ? [node[name]] : node[name];
  if (!Array.isArray(operands) || operands.length !== argumentCount) throw graphError(`${name} needs ${argumentCount} argument${argumentCount === 1 ? '' : 's'}.`);
  return liftComponentwise(operands.map(operand => compileNode(operand, state, depth + 1)), compute);
}

// ---------------------------------------------------------------------------------------------------------------
// Mixing nodes: a layer put over another where a mask passes, a hue shift and a curve.

function compileScalarInput(node, state, depth, label) {
  const compiled = compileNode(node, state, depth + 1);
  if (compiled.kind !== 'scalar') throw graphError(`${label} needs a number.`);
  return compiled;
}

function compileLayer(node, state, depth) {
  const settings = textureSettings(node, 'layer', ['base', 'top', 'mask', 'edge', 'softness']);
  for (const required of ['base', 'top', 'mask']) {
    if (settings[required] === undefined) throw graphError(`layer needs "${required}".`);
  }
  const edge = settings.edge ?? 0.5;
  const softness = settings.softness ?? 0.1;
  if (!finiteLiteral(edge) || !finiteLiteral(softness) || softness < 0) throw graphError('layer edge is a number and softness a number from 0.');
  const base = compileNode(settings.base, state, depth + 1);
  const top = compileNode(settings.top, state, depth + 1);
  const mask = compileScalarInput(settings.mask, state, depth, 'layer "mask"');
  const coverage = scalarValue((u, v) => {
    const value = mask.evaluate(u, v);
    return softness === 0 ? (value >= edge ? 1 : 0) : smoothStep(edge - softness, edge + softness, value);
  });
  return liftComponentwise([base, top, coverage], mixNumbers);
}

function rgbToHsv(red, green, blue) {
  const high = Math.max(red, green, blue);
  const spread = high - Math.min(red, green, blue);
  let hue = 0;
  if (spread > 0) {
    if (high === red) hue = ((green - blue) / spread + 6) % 6;
    else if (high === green) hue = (blue - red) / spread + 2;
    else hue = (red - green) / spread + 4;
  }
  return [hue / 6, high === 0 ? 0 : spread / high, high];
}

function hsvToRgb(hue, saturation, value) {
  const channel = offset => {
    const sector = (offset + hue * 6) % 6;
    return value * (1 - saturation * Math.max(0, Math.min(sector, 4 - sector, 1)));
  };
  return [channel(5), channel(3), channel(1)];
}

function compileHue(node, state, depth) {
  const settings = textureSettings(node, 'hue', ['color', 'shift', 'saturation', 'value']);
  const saturation = settings.saturation ?? 1;
  const brightness = settings.value ?? 1;
  for (const factor of [saturation, brightness]) {
    if (typeof factor !== 'number' || !Number.isFinite(factor) || factor < 0 || factor > 4) throw graphError('hue saturation and value are numbers from 0 to 4.');
  }
  const color = compileNode(settings.color, state, depth + 1);
  if (color.kind !== 'vector') throw graphError('hue "color" needs a colour such as [r, g, b].');
  const shift = compileScalarInput(settings.shift ?? 0, state, depth, 'hue "shift"');
  state.cost += 4;
  const [red, green, blue] = color.parts;
  // The three channels read the same pixel in a row, so the last result is kept instead of converting three times.
  let lastU = NaN;
  let lastV = NaN;
  let lastResult = [0, 0, 0];
  const shifted = (u, v) => {
    if (u !== lastU || v !== lastV) {
      const [hue, sourceSaturation, sourceValue] = rgbToHsv(finiteOrZero(red(u, v)), finiteOrZero(green(u, v)), finiteOrZero(blue(u, v)));
      lastResult = hsvToRgb(fract(hue + finiteOrZero(shift.evaluate(u, v))), clampUnit(sourceSaturation * saturation), sourceValue * brightness);
      lastU = u;
      lastV = v;
    }
    return lastResult;
  };
  return vectorValue((u, v) => shifted(u, v)[0], (u, v) => shifted(u, v)[1], (u, v) => shifted(u, v)[2]);
}

function compileCurve(node, state, depth) {
  const settings = textureSettings(node, 'curve', ['value', 'points']);
  const { points } = settings;
  if (!Array.isArray(points) || points.length < 2 || points.length > MATERIAL_GRAPH_LIMITS.maxStops) throw graphError(`curve needs 2 to ${MATERIAL_GRAPH_LIMITS.maxStops} points.`);
  let previousX = -Infinity;
  for (const point of points) {
    if (!Array.isArray(point) || point.length !== 2 || !point.every(finiteLiteral) || point[0] <= previousX) throw graphError('curve points are [x, y] with x rising.');
    previousX = point[0];
  }
  const remap = input => {
    if (input <= points[0][0]) return points[0][1];
    for (let index = 1; index < points.length; index++) {
      if (input <= points[index][0]) {
        const [fromX, fromY] = points[index - 1];
        const [toX, toY] = points[index];
        return mixNumbers(fromY, toY, (input - fromX) / (toX - fromX));
      }
    }
    return points[points.length - 1][1];
  };
  state.cost += 2;
  return liftComponentwise([compileNode(settings.value, state, depth + 1)], remap);
}

const COORDINATE_SPACES = ['generated', 'object', 'world'];

// Where a texel sits on the surface. A baked texture is projected onto the mesh (box mapping along the object axes, or
// its UVs), so the two axes it knows are the only ones a texel can report: the third is 0. "generated" is the unit tile,
// "object" and "world" are metres across the tile (u * size). Box mapping reads the placed, scaled position, so the
// two are the same here.
function compileCoordinate(node, state) {
  const space = oneOf(node.coord, COORDINATE_SPACES, 'coord');
  if (Object.keys(node).length !== 1) throw graphError('coord takes no other fields.');
  const metres = space === 'generated' ? 1 : state.size;
  return vectorValue(u => u * metres, (u, v) => v * metres, () => 0);
}

const MAPPING_FIELDS = ['vector', 'scale', 'offset', 'rotate'];

function mappingTriple(value, fallback, label) {
  if (value === undefined) return fallback;
  const triple = typeof value === 'number' ? [value, value, value] : value;
  if (!Array.isArray(triple) || triple.length !== 3 || !triple.every(finiteLiteral)) throw graphError(`mapping "${label}" is a number or [x, y, z] of finite numbers.`);
  return triple;
}

// Blender's Mapping node (point): scale, then rotate around Z, then move. The vector defaults to {"coord":"generated"}.
function compileMapping(node, state, depth) {
  const settings = textureSettings(node, 'mapping', MAPPING_FIELDS);
  const [scaleX, scaleY, scaleZ] = mappingTriple(settings.scale, [1, 1, 1], 'scale');
  const [offsetX, offsetY, offsetZ] = mappingTriple(settings.offset, [0, 0, 0], 'offset');
  const rotation = settings.rotate ?? 0;
  if (!finiteLiteral(rotation)) throw graphError('mapping "rotate" is an angle in radians around Z.');
  const input = compileNode(settings.vector ?? { coord: 'generated' }, state, depth + 1);
  if (input.kind !== 'vector') throw graphError('mapping "vector" needs a vector such as {"coord":"generated"}.');
  const [inputX, inputY, inputZ] = input.parts;
  const cosine = Math.cos(rotation);
  const sine = Math.sin(rotation);
  const rotatedX = (u, v) => inputX(u, v) * scaleX * cosine - inputY(u, v) * scaleY * sine + offsetX;
  const rotatedY = (u, v) => inputX(u, v) * scaleX * sine + inputY(u, v) * scaleY * cosine + offsetY;
  return vectorValue(rotatedX, rotatedY, (u, v) => inputZ(u, v) * scaleZ + offsetZ);
}

const BRICK_OUTPUTS = ['mortar', 'edge', 'cell'];
const BRICK_COST = 4;

// Blender's Brick Texture, laid in a running bond. Whole columns and an even number of rows keep it tileable.
function compileBrick(node, state, depth) {
  const settings = textureSettings(node, 'brick', ['columns', 'rows', 'mortar', 'offset', 'seed', 'output', 'at']);
  const columns = integerInRange(settings.columns ?? 8, 1, NOISE_SCALE_LIMIT, 'brick columns');
  const rows = integerInRange(settings.rows ?? 8, 2, NOISE_SCALE_LIMIT, 'brick rows');
  if (rows % 2 !== 0) throw graphError('brick rows must be even so the bond tiles.');
  const seed = integerInRange(settings.seed ?? 0, 0, MAX_SEED, 'brick seed');
  const output = oneOf(settings.output ?? 'mortar', BRICK_OUTPUTS, 'brick output');
  const mortar = settings.mortar ?? 0.05;
  const offset = settings.offset ?? 0.5;
  if (!finiteLiteral(mortar) || mortar < 0 || mortar > 0.5) throw graphError('brick mortar is the joint width as a share of a brick, from 0 to 0.5.');
  if (!finiteLiteral(offset) || offset < 0 || offset >= 1) throw graphError('brick offset is the shift of every other row as a share of a brick, from 0 up to 1.');
  state.cost += BRICK_COST;
  const [positionU, positionV] = compilePosition(settings, state, depth);
  return scalarValue((u, v) => {
    const scaledV = positionV(u, v) * rows;
    const row = Math.floor(scaledV);
    const scaledU = positionU(u, v) * columns + (wrapCell(row, 2) === 1 ? offset : 0);
    const column = Math.floor(scaledU);
    if (output === 'cell') return hashCell(wrapCell(column, columns), wrapCell(row, rows), seed) / 4294967296;
    const fractionU = scaledU - column;
    const fractionV = scaledV - row;
    const distance = Math.min(fractionU, 1 - fractionU, fractionV, 1 - fractionV);
    if (output === 'edge') return clampUnit(distance * 2);
    return mortar === 0 ? 0 : 1 - smoothStep(mortar * 0.5, mortar, distance);
  });
}

const WHITE_NOISE_OUTPUTS = ['value', 'color'];

// A random value per cell of a scale by scale grid; the cells wrap, so it tiles. "color" is three independent values.
function compileWhiteNoise(node, state, depth) {
  const settings = textureSettings(node, 'whiteNoise', ['scale', 'seed', 'output', 'at']);
  const scale = integerInRange(settings.scale ?? 16, 1, NOISE_SCALE_LIMIT, 'whiteNoise scale');
  const seed = integerInRange(settings.seed ?? 0, 0, MAX_SEED, 'whiteNoise seed');
  const output = oneOf(settings.output ?? 'value', WHITE_NOISE_OUTPUTS, 'whiteNoise output');
  const [positionU, positionV] = compilePosition(settings, state, depth);
  const channel = channelIndex => (u, v) => {
    const cellX = wrapCell(Math.floor(positionU(u, v) * scale), scale);
    const cellY = wrapCell(Math.floor(positionV(u, v) * scale), scale);
    return hashCell(cellX, cellY, (seed + channelIndex * 7919) | 0) / 4294967296;
  };
  return output === 'color' ? vectorValue(channel(1), channel(2), channel(3)) : scalarValue(channel(0));
}

const TEXTURE_COMPILERS = new Map([
  ['noise', compileNoise], ['whiteNoise', compileWhiteNoise], ['brick', compileBrick], ['voronoi', compileVoronoi], ['wave', compileWave], ['checker', compileChecker], ['gradient', compileGradient],
]);

function compileNode(node, state, depth) {
  state.nodeCount++;
  state.cost++;
  if (state.nodeCount > MATERIAL_GRAPH_LIMITS.maxNodes) throw graphError(`more than ${MATERIAL_GRAPH_LIMITS.maxNodes} nodes.`);
  if (depth > MATERIAL_GRAPH_LIMITS.maxDepth) throw graphError(`nesting deeper than ${MATERIAL_GRAPH_LIMITS.maxDepth}.`);
  if (typeof node === 'number') {
    if (!finiteLiteral(node)) throw graphError(`numbers must be finite and within ${MAX_LITERAL}.`);
    return scalarValue(() => node);
  }
  if (Array.isArray(node)) {
    if (node.length !== 3 || !node.every(finiteLiteral)) throw graphError('a vector literal is three finite numbers; build one from expressions with "vec".');
    const [literalX, literalY, literalZ] = node;
    return vectorValue(() => literalX, () => literalY, () => literalZ);
  }
  if (!isPlainObject(node)) throw graphError('each node is a number, a vector of three numbers or an object with one operator.');
  const keys = Object.keys(node);
  if (keys.length !== 1) throw graphError(`a node holds exactly one operator; got ${keys.length}.`);
  const name = keys[0];
  if (name === 'uv') return compileCoordinates(node);
  if (name === 'coord') return compileCoordinate(node, state);
  if (name === 'mapping') return compileMapping(node, state, depth);
  if (name === 'vec') return compileVector(node, state, depth);
  if (name === 'ramp') return compileRamp(node, state, depth);
  if (name === 'layer') return compileLayer(node, state, depth);
  if (name === 'hue') return compileHue(node, state, depth);
  if (name === 'curve') return compileCurve(node, state, depth);
  if (TEXTURE_COMPILERS.has(name)) return TEXTURE_COMPILERS.get(name)(node, state, depth);
  if (MATH_OPERATORS.has(name)) return compileMath(name, node, state, depth);
  throw graphError(`unknown operator ${describeKey(name)}. Use one of ${MATERIAL_GRAPH_OPERATORS.join(', ')}.`);
}

const SCALAR_OUTPUTS = ['roughness', 'metallic', 'height', 'opacity', 'clearcoat', 'transmission'];

/**
 * Check a graph and compile each output. `size` is the metres one texture tile covers, which object and world coordinates report. Limits on nodes, depth and work per pixel are enforced here, before any
 * pixel is evaluated. Returns { outputs: { name: compiled }, nodeCount, cost }.
 */
export function compileMaterialGraph(graph, { size = 1 } = {}) {
  if (!isPlainObject(graph)) throw graphError(`graph must be an object with outputs: ${MATERIAL_GRAPH_OUTPUTS.join(', ')}.`);
  onlyKeys(graph, MATERIAL_GRAPH_OUTPUTS, 'graph');
  const names = Object.keys(graph);
  if (names.length === 0) throw graphError(`graph needs at least one output: ${MATERIAL_GRAPH_OUTPUTS.join(', ')}.`);
  const state = { nodeCount: 0, cost: 0, size };
  const outputs = {};
  for (const name of names) {
    outputs[name] = compileNode(graph[name], state, 0);
    if (SCALAR_OUTPUTS.includes(name) && outputs[name].kind !== 'scalar') throw graphError(`${name} needs a number, not a vector.`);
  }
  return { outputs, nodeCount: state.nodeCount, cost: state.cost };
}

/** Throw when a graph is too costly to bake at this size. Called while normalizing, so a bad scene fails at once. */
export function checkMaterialGraphWork(compiled, resolution) {
  const work = compiled.cost * resolution * resolution;
  if (work > MATERIAL_GRAPH_LIMITS.maxWork) {
    throw new RangeError(`Material graph: ${compiled.cost} work units per pixel at ${resolution} by ${resolution} is over the limit of ${MATERIAL_GRAPH_LIMITS.maxWork}. Use fewer nodes or a smaller resolution.`);
  }
}

/** Validate a graph and return a plain copy of it. A normalized graph normalizes to itself. */
export function normalizeMaterialGraph(graph, resolution) {
  const compiled = compileMaterialGraph(graph);
  checkMaterialGraphWork(compiled, resolution);
  return JSON.parse(JSON.stringify(graph));
}

// ---------------------------------------------------------------------------------------------------------------
// Baking. Colours are linear RGB, as recipe colours are.

function sampleChannels(compiled, u, v) {
  if (compiled.kind === 'scalar') {
    const value = finiteOrZero(compiled.evaluate(u, v));
    return [value, value, value];
  }
  return [finiteOrZero(compiled.parts[0](u, v)), finiteOrZero(compiled.parts[1](u, v)), finiteOrZero(compiled.parts[2](u, v))];
}

const unitByte = value => Math.round(clampUnit(finiteOrZero(value)) * 255);

// A mask is read from the red channel, as glTF reads clearcoatTexture and transmissionTexture.
function writeMask(data, offset, value) {
  data[offset] = unitByte(value);
  data[offset + 3] = 255;
}

function writeColor(data, offset, channels) {
  for (let channel = 0; channel < 3; channel++) data[offset + channel] = linearToSrgbByte(channels[channel]);
  data[offset + 3] = 255;
}

/** Bake a normalized graph into texture descriptors, one for each output the graph has. Deterministic. */
export function bakeMaterialGraph(graph, { resolution, bump, size = 1 }) {
  const compiled = compileMaterialGraph(graph, { size });
  checkMaterialGraphWork(compiled, resolution);
  const { color, roughness, metallic, emission, height, opacity, clearcoat, transmission, aov } = compiled.outputs;
  const pixelCount = resolution * resolution;
  // Opacity travels in the alpha of the base texture, so an opacity-only graph still gets a (white) base texture.
  const colorData = color || opacity ? new Uint8ClampedArray(pixelCount * 4).fill(255) : null;
  const clearcoatData = clearcoat ? new Uint8ClampedArray(pixelCount * 4) : null;
  const transmissionData = transmission ? new Uint8ClampedArray(pixelCount * 4) : null;
  const emissionData = emission ? new Uint8ClampedArray(pixelCount * 4) : null;
  const aovData = aov ? new Uint8ClampedArray(pixelCount * 4) : null;
  const surfaceData = roughness || metallic ? new Uint8ClampedArray(pixelCount * 4) : null;
  for (let row = 0; row < resolution; row++) {
    for (let column = 0; column < resolution; column++) {
      const pixel = row * resolution + column;
      const u = (column + 0.5) / resolution;
      const v = (row + 0.5) / resolution;
      const offset = pixel * 4;
      if (color) writeColor(colorData, offset, sampleChannels(color, u, v));
      if (opacity) colorData[offset + 3] = unitByte(opacity.evaluate(u, v));
      if (clearcoat) writeMask(clearcoatData, offset, clearcoat.evaluate(u, v));
      if (transmission) writeMask(transmissionData, offset, transmission.evaluate(u, v));
      if (emission) writeColor(emissionData, offset, sampleChannels(emission, u, v));
      if (aov) {
        const channels = sampleChannels(aov, u, v);
        for (let channel = 0; channel < 3; channel++) aovData[offset + channel] = unitByte(channels[channel]);
        aovData[offset + 3] = 255;
      }
      if (surfaceData) {
        surfaceData[offset] = 255;
        surfaceData[offset + 1] = roughness ? Math.round(clampUnit(finiteOrZero(roughness.evaluate(u, v))) * 255) : 255;
        surfaceData[offset + 2] = metallic ? Math.round(clampUnit(finiteOrZero(metallic.evaluate(u, v))) * 255) : 255;
        surfaceData[offset + 3] = 255;
      }
    }
  }
  const descriptor = (data, colorSpace) => (data ? { image: createImage(data, resolution, resolution), colorSpace } : undefined);
  return {
    map: descriptor(colorData, 'srgb'),
    emissiveMap: descriptor(emissionData, 'srgb'),
    metallicRoughnessMap: descriptor(surfaceData, 'linear'),
    // The rasterizer binds clearcoatTexture from layerMaps; transmission has no layer slot, so the tracer reads transmissionMap.
    layerMaps: clearcoatData ? { clearcoatTexture: descriptor(clearcoatData, 'linear') } : undefined,
    transmissionMap: descriptor(transmissionData, 'linear'),
    aovMap: descriptor(aovData, 'linear'),
    normalMap: descriptor(height ? normalMapFromHeightFunction((u, v) => finiteOrZero(height.evaluate(u, v)), resolution, bump) : null, 'linear'),
  };
}
