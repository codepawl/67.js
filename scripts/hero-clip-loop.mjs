// Turns the one-way animation clip of a hero world into a clip that loops without a seam, so a world that stays on screen longer than
// the clip still moves (a clip played once stops on its last pose).
//
//   node scripts/hero-clip-loop.mjs <in.glb> <out.glb> [--leg-seconds 12] [--corner-seconds 0.5] [--start-seconds 0.6] [--rate 15] [--engineer-speed 0.9]
//        [--walk-source <UAL1_Standard.glb> --walk-clip Walk_Loop] [--cycle-seconds 1.3333]
//
// The input clip is one leg: every mover (an engineer, a hoist vehicle, a pod, a cable) goes from its start to its end in
// --leg-seconds. The output clip lasts twice that. The movers go there and back with a rounded turn, and each engineer turns around
// while it slows. The walk cycle of an engineer's bones always plays forward and repeats every --cycle-seconds, from the input
// clip or from the --walk-clip of a Quaternius Universal Animation Library GLB (CC0) when one is given. The clip starts
// --start-seconds into the first leg, so the first turn comes at the end of the time a world is normally on screen.
// The last key equals the first, so playing the clip with its time modulo its duration has no jump.
// The geometry bytes are copied unchanged; only the animation data is replaced. Nothing is read from the network.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const GLB_MAGIC = 0x46546c67;
const JSON_CHUNK = 0x4e4f534a;
const BINARY_CHUNK = 0x004e4942;
const FLOAT = 5126;
const TYPE_WIDTH = { SCALAR: 1, VEC3: 3, VEC4: 4 };
const WIDTH_TYPE = { 1: 'SCALAR', 3: 'VEC3', 4: 'VEC4' };
const PATH_WIDTH = { translation: 3, rotation: 4, scale: 3 };
const ENGINEER_NAME = /^engineer_\d+$/;
const CONSTANT_TOLERANCE = 1e-6;

export const LOOP_DEFAULTS = { legSeconds: 12, cornerSeconds: 0.5, startSeconds: 0.6, rate: 15, cycleSeconds: 4 / 3, walkClip: 'Walk_Loop' };

export function readGlb(buffer) {
  if (buffer.readUInt32LE(0) !== GLB_MAGIC) throw new Error('Not a GLB file.');
  const jsonLength = buffer.readUInt32LE(12);
  const json = JSON.parse(buffer.subarray(20, 20 + jsonLength).toString('utf8'));
  const binaryStart = 20 + jsonLength;
  if (buffer.readUInt32LE(binaryStart + 4) !== BINARY_CHUNK) throw new Error('The GLB has no binary chunk.');
  const binary = buffer.subarray(binaryStart + 8, binaryStart + 8 + buffer.readUInt32LE(binaryStart));
  return { json, binary };
}

export function writeGlb(json, binary) {
  const jsonBytes = Buffer.from(JSON.stringify(json), 'utf8');
  const jsonPadded = Buffer.concat([jsonBytes, Buffer.alloc((4 - (jsonBytes.length % 4)) % 4, 0x20)]);
  const binaryPadded = Buffer.concat([binary, Buffer.alloc((4 - (binary.length % 4)) % 4)]);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(GLB_MAGIC, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonPadded.length + 8 + binaryPadded.length, 8);
  const jsonHeader = Buffer.alloc(8);
  jsonHeader.writeUInt32LE(jsonPadded.length, 0);
  jsonHeader.writeUInt32LE(JSON_CHUNK, 4);
  const binaryHeader = Buffer.alloc(8);
  binaryHeader.writeUInt32LE(binaryPadded.length, 0);
  binaryHeader.writeUInt32LE(BINARY_CHUNK, 4);
  return Buffer.concat([header, jsonHeader, jsonPadded, binaryHeader, binaryPadded]);
}

function readAccessor(json, binary, index) {
  const accessor = json.accessors[index];
  const view = json.bufferViews[accessor.bufferView];
  if (accessor.componentType !== FLOAT || view.buffer !== 0 || view.extensions) throw new Error(`Accessor ${index} is not plain float data in the first buffer.`);
  const width = TYPE_WIDTH[accessor.type];
  const start = binary.byteOffset + (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  return new Float32Array(binary.buffer.slice(start, start + accessor.count * width * 4));
}

// Every channel of a clip as plain arrays, with the name of the node it moves.
export function readClipChannels(json, binary, clip) {
  return clip.channels.map(channel => {
    const sampler = clip.samplers[channel.sampler];
    const interpolation = sampler.interpolation ?? 'LINEAR';
    if (interpolation === 'CUBICSPLINE') throw new Error('CUBICSPLINE animation samplers cannot be looped.');
    return {
      node: channel.target.node,
      nodeName: json.nodes[channel.target.node].name,
      path: channel.target.path,
      interpolation,
      times: readAccessor(json, binary, sampler.input),
      values: readAccessor(json, binary, sampler.output),
    };
  });
}

function smoothstep(value) {
  const clamped = Math.min(1, Math.max(0, value));
  return clamped * clamped * (3 - 2 * clamped);
}

// The position along one leg, in seconds of the one-way clip, at a time of the looped clip: out and back, with the turn at each end
// rounded (a parabola over cornerSeconds either side) so a mover slows to a stop instead of reversing at full speed.
export function patrolLegTime(phase, legSeconds, cornerSeconds) {
  const period = 2 * legSeconds;
  const wrapped = ((phase % period) + period) % period;
  const distanceToEnd = Math.abs(wrapped - legSeconds);
  if (distanceToEnd < cornerSeconds) return legSeconds - cornerSeconds / 2 - (distanceToEnd * distanceToEnd) / (2 * cornerSeconds);
  const distanceToStart = Math.min(wrapped, period - wrapped);
  if (distanceToStart < cornerSeconds) return (distanceToStart * distanceToStart) / (2 * cornerSeconds) + cornerSeconds / 2;
  return legSeconds - distanceToEnd;
}

// 0 while an engineer faces the way of the first leg, 1 on the way back, eased across the turn at each end.
export function patrolTurnAmount(phase, legSeconds, cornerSeconds) {
  const period = 2 * legSeconds;
  const wrapped = ((phase % period) + period) % period;
  const unwrapped = wrapped < cornerSeconds ? wrapped + period : wrapped;
  const turnAt = center => smoothstep((unwrapped - (center - cornerSeconds)) / (2 * cornerSeconds));
  return unwrapped < legSeconds + cornerSeconds ? turnAt(legSeconds) : 1 - turnAt(period);
}

function findKeyPair(times, time) {
  if (time <= times[0]) return { lower: 0, upper: 0, blend: 0 };
  const last = times.length - 1;
  if (time >= times[last]) return { lower: last, upper: last, blend: 0 };
  let low = 0;
  let high = last;
  while (high - low > 1) {
    const middle = (low + high) >> 1;
    if (times[middle] <= time) low = middle;
    else high = middle;
  }
  return { lower: low, upper: high, blend: (time - times[low]) / (times[high] - times[low]) };
}

export function sampleChannel(channel, time) {
  const width = PATH_WIDTH[channel.path];
  const { lower, upper, blend } = findKeyPair(channel.times, time);
  const from = channel.values.subarray(lower * width, lower * width + width);
  const to = channel.values.subarray(upper * width, upper * width + width);
  const result = new Float32Array(width);
  const sign = channel.path === 'rotation' && from.reduce((sum, value, index) => sum + value * to[index], 0) < 0 ? -1 : 1;
  for (let index = 0; index < width; index++) result[index] = from[index] + (sign * to[index] - from[index]) * blend;
  if (channel.path === 'rotation') {
    const length = Math.hypot(...result) || 1;
    for (let index = 0; index < width; index++) result[index] /= length;
  }
  return result;
}

function multiplyQuaternions(a, b) {
  return new Float32Array([
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ]);
}

function isConstant(channel) {
  // A STEP sampler of two equal keys is how an export writes a pose that never changes.
  const width = PATH_WIDTH[channel.path];
  for (let key = 1; key < channel.times.length; key++) {
    for (let component = 0; component < width; component++) {
      if (Math.abs(channel.values[key * width + component] - channel.values[component]) > CONSTANT_TOLERANCE) return false;
    }
  }
  return true;
}

function descendantsOf(json, rootIndex) {
  const found = new Set();
  const stack = [...(json.nodes[rootIndex].children ?? [])];
  while (stack.length) {
    const index = stack.pop();
    found.add(index);
    stack.push(...(json.nodes[index].children ?? []));
  }
  return found;
}

// The yaw about Y that turns a model facing +Z (the glTF front) toward the way a translation channel goes.
function facingToward(translationChannel) {
  const last = translationChannel.values.length - 3;
  const yaw = Math.atan2(translationChannel.values[last] - translationChannel.values[0], translationChannel.values[last + 2] - translationChannel.values[2]);
  return new Float32Array([0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)]);
}

function constantChannel(channel, source, legSeconds) {
  const width = PATH_WIDTH[channel.path];
  return { node: channel.node, path: channel.path, constant: true, times: Float32Array.of(0, 2 * legSeconds), keys: [source.values.slice(0, width), source.values.slice(0, width)] };
}

// Quaternion keys stay in one hemisphere so the interpolation takes the short way.
function keepOneHemisphere(keys) {
  for (let key = 1; key < keys.length; key++) {
    const dot = keys[key].reduce((sum, value, index) => sum + value * keys[key - 1][index], 0);
    if (dot < 0) keys[key] = keys[key].map(value => -value);
  }
  return keys;
}

// The channels of the looped clip: { node, path, constant, times, keys: Float32Array[] } sampled at rate keys a second over two legs.
// An engineer exported without a rotation channel gets one that faces it along its path: a GLB with no rotation on the
// engineer node makes it walk sideways. engineerSpeed (metres a second) shortens or lengthens the path so the planted foot does not slide.
export function buildLoopedChannels(json, sourceChannels, options = {}) {
  const { legSeconds, cornerSeconds, startSeconds, rate, cycleSeconds } = { ...LOOP_DEFAULTS, ...options };
  const walkChannels = options.walkChannels ?? null;
  const walkCycleSeconds = options.walkCycleSeconds ?? cycleSeconds;
  const keyCount = Math.round(2 * legSeconds * rate) + 1;
  if (Math.abs(walkCycleSeconds * rate - Math.round(walkCycleSeconds * rate)) > 1e-3) throw new Error(`The walk cycle of ${walkCycleSeconds} s is not a whole number of keys at ${rate} keys a second, so it would jump at the seam.`);
  if (Math.abs((2 * legSeconds) / walkCycleSeconds - Math.round((2 * legSeconds) / walkCycleSeconds)) > 1e-3) throw new Error('The looped clip must hold a whole number of walk cycles.');
  const skeletonNodes = new Set();
  const engineerNodes = new Set();
  json.nodes.forEach((node, index) => {
    if (!ENGINEER_NAME.test(node.name ?? '')) return;
    engineerNodes.add(index);
    for (const descendant of descendantsOf(json, index)) skeletonNodes.add(descendant);
  });
  const walkByName = new Map((walkChannels ?? []).map(channel => [`${channel.nodeName}/${channel.path}`, channel]));
  const times = Float32Array.from({ length: keyCount }, (_, key) => key / rate);
  const channelsByNode = path => new Map(sourceChannels.filter(channel => channel.path === path).map(channel => [channel.node, channel]));
  const translations = channelsByNode('translation');
  const rotations = channelsByNode('rotation');

  const patrolChannel = channel => {
    const isEngineer = engineerNodes.has(channel.node);
    const travel = translations.get(channel.node);
    const originalSpeed = isEngineer && travel ? Math.hypot(travel.values.at(-3) - travel.values[0], travel.values.at(-1) - travel.values[2]) / legSeconds : 0;
    const speedScale = isEngineer && options.engineerSpeed && originalSpeed > 0 ? options.engineerSpeed / originalSpeed : 1;
    const keys = Array.from(times, time => {
      const sampled = sampleChannel(channel, patrolLegTime(time + startSeconds, legSeconds, cornerSeconds));
      if (channel.path !== 'translation' || speedScale === 1) return sampled;
      return sampled.map((value, axis) => channel.values[axis] + (value - channel.values[axis]) * speedScale);
    });
    return { node: channel.node, path: channel.path, constant: false, times, keys };
  };

  const gaitChannel = (channel, source) => ({ node: channel.node, path: channel.path, constant: false, times, keys: keepOneHemisphere(Array.from(times, time => sampleChannel(source, time % walkCycleSeconds))) });

  const looped = sourceChannels.map(channel => {
    const gaitSource = skeletonNodes.has(channel.node) ? (walkByName.get(`${channel.nodeName}/${channel.path}`) ?? channel) : null;
    const source = gaitSource ?? channel;
    if (isConstant(source)) return constantChannel(channel, source, legSeconds);
    if (source.interpolation === 'STEP') throw new Error(`The channel ${channel.nodeName}/${channel.path} changes but uses STEP interpolation, which would be sampled as linear.`);
    return gaitSource ? gaitChannel(channel, gaitSource) : patrolChannel(channel);
  });

  for (const node of engineerNodes) {
    const existing = rotations.get(node);
    const travel = translations.get(node);
    if (existing || !travel) continue;
    const facing = facingToward(travel);
    const keys = Array.from(times, time => {
      const halfTurn = (Math.PI * patrolTurnAmount(time + startSeconds, legSeconds, cornerSeconds)) / 2;
      return multiplyQuaternions(new Float32Array([0, Math.sin(halfTurn), 0, Math.cos(halfTurn)]), facing);
    });
    looped.push({ node, path: 'rotation', constant: false, times, keys: keepOneHemisphere(keys) });
  }
  return looped;
}

function alignedEnd(length) {
  return length + ((4 - (length % 4)) % 4);
}

// The byte ranges of the first buffer that hold geometry, in order: a plain view, or the compressed range a meshopt view points at.
function bufferRanges(json, skippedViews) {
  const ranges = [];
  json.bufferViews.forEach((view, index) => {
    if (skippedViews.has(index)) return;
    if (view.buffer === 0) ranges.push({ holder: view, offset: view.byteOffset ?? 0, length: view.byteLength });
    const compressed = view.extensions?.EXT_meshopt_compression;
    if (compressed?.buffer === 0) ranges.push({ holder: compressed, offset: compressed.byteOffset ?? 0, length: compressed.byteLength });
  });
  return ranges;
}

// Removes the animation accessors, their buffer views and their bytes, and moves whatever came after those bytes (an image) up.
// The animation accessors must be the tail of the accessor list and their views one contiguous run that nothing else shares;
// anything else is refused instead of guessed. Returns the binary without the animation data.
function removeAnimationData(json, binary) {
  const oldAccessors = new Set(json.animations[0].samplers.flatMap(sampler => [sampler.input, sampler.output]));
  const firstAccessor = Math.min(...oldAccessors);
  if (Math.max(...oldAccessors) !== json.accessors.length - 1 || json.accessors.length - firstAccessor !== oldAccessors.size) throw new Error('The animation accessors are not the tail of the accessor list.');
  const oldViews = new Set(json.accessors.slice(firstAccessor).map(accessor => accessor.bufferView));
  const firstView = Math.min(...oldViews);
  const viewRunLength = oldViews.size;
  if (Math.max(...oldViews) !== firstView + viewRunLength - 1) throw new Error('The animation buffer views are not one contiguous run.');
  const sharesView = view => view !== undefined && oldViews.has(view);
  if (json.accessors.slice(0, firstAccessor).some(accessor => sharesView(accessor.bufferView)) || (json.images ?? []).some(image => sharesView(image.bufferView))) throw new Error('Something else shares an animation buffer view.');
  const removedStart = Math.min(...[...oldViews].map(index => json.bufferViews[index].byteOffset));
  const removedEnd = Math.max(...[...oldViews].map(index => json.bufferViews[index].byteOffset + json.bufferViews[index].byteLength));
  const others = bufferRanges(json, oldViews);
  if (others.some(range => range.offset < removedEnd && range.offset + range.length > removedStart)) throw new Error('Other data overlaps the animation bytes.');
  const removedLength = removedEnd - removedStart;
  for (const range of others) if (range.offset >= removedEnd) range.holder.byteOffset = range.offset - removedLength;
  const renumber = index => (index === undefined || index < firstView ? index : index - viewRunLength);
  json.accessors.length = firstAccessor;
  for (const accessor of json.accessors) accessor.bufferView = renumber(accessor.bufferView);
  for (const image of json.images ?? []) image.bufferView = renumber(image.bufferView);
  json.bufferViews.splice(firstView, viewRunLength);
  return Buffer.concat([binary.subarray(0, removedStart), binary.subarray(removedEnd)]);
}

export function writeLoopedClip(json, binary, loopedChannels, clipName) {
  const oldClip = json.animations[0];
  const keptBinary = removeAnimationData(json, binary);
  const chunks = [keptBinary];
  let length = keptBinary.length;
  const addView = bytes => {
    const padding = alignedEnd(length) - length;
    if (padding) chunks.push(Buffer.alloc(padding));
    length += padding;
    json.bufferViews.push({ buffer: 0, byteOffset: length, byteLength: bytes.length });
    chunks.push(bytes);
    length += bytes.length;
    return json.bufferViews.length - 1;
  };
  const addAccessor = (array, type, extra = {}) => {
    const bufferView = addView(Buffer.from(array.buffer, array.byteOffset, array.byteLength));
    json.accessors.push({ bufferView, componentType: FLOAT, count: array.length / TYPE_WIDTH[type], type, ...extra });
    return json.accessors.length - 1;
  };

  const sharedAccessors = new Map();
  const shared = (key, create) => {
    if (!sharedAccessors.has(key)) sharedAccessors.set(key, create());
    return sharedAccessors.get(key);
  };
  const samplers = [];
  const samplerIndexByPair = new Map();
  const channels = loopedChannels.map(looped => {
    const timeKey = `t:${looped.times.length}:${looped.times.at(-1)}`;
    const input = shared(timeKey, () => addAccessor(looped.times, 'SCALAR', { min: [looped.times[0]], max: [looped.times.at(-1)] }));
    const flat = Float32Array.from(looped.keys.flatMap(key => Array.from(key)));
    const hash = createHash('sha1').update(Buffer.from(flat.buffer)).digest('hex');
    const output = shared(`v:${hash}`, () => addAccessor(flat, WIDTH_TYPE[PATH_WIDTH[looped.path]]));
    const pair = `${input}/${output}`;
    if (!samplerIndexByPair.has(pair)) {
      samplerIndexByPair.set(pair, samplers.length);
      samplers.push({ input, interpolation: 'LINEAR', output });
    }
    return { sampler: samplerIndexByPair.get(pair), target: { node: looped.node, path: looped.path } };
  });
  json.animations = [{ name: clipName ?? oldClip.name, channels, samplers }];
  const total = Buffer.concat(chunks);
  json.buffers[0].byteLength = total.length;
  return total;
}

export function loopHeroClip(glbBytes, options = {}) {
  const { json, binary } = readGlb(glbBytes);
  if (json.animations?.length !== 1) throw new Error('Expected exactly one merged animation clip.');
  const sourceChannels = readClipChannels(json, binary, json.animations[0]);
  const looped = buildLoopedChannels(json, sourceChannels, options);
  const newBinary = writeLoopedClip(json, binary, looped, json.animations[0].name);
  return writeGlb(json, newBinary);
}

export function readWalkClip(walkGlbBytes, clipName) {
  const { json, binary } = readGlb(walkGlbBytes);
  const clip = json.animations.find(entry => entry.name === clipName);
  if (!clip) throw new Error(`The walk source has no clip named ${clipName}: ${json.animations.map(entry => entry.name).join(', ')}.`);
  const channels = readClipChannels(json, binary, clip);
  return { channels, duration: Math.max(...channels.map(channel => channel.times.at(-1))) };
}

function parseOptions(argv) {
  const positional = [];
  const options = {};
  for (let index = 0; index < argv.length; index++) {
    if (!argv[index].startsWith('--')) { positional.push(argv[index]); continue; }
    const key = argv[index].slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    options[key] = argv[++index];
  }
  return { positional, options };
}

function main() {
  const { positional, options } = parseOptions(process.argv.slice(2));
  if (positional.length !== 2) throw new Error('Pass <in.glb> and <out.glb>.');
  const numeric = ['legSeconds', 'cornerSeconds', 'startSeconds', 'rate', 'cycleSeconds', 'engineerSpeed'];
  const loopOptions = Object.fromEntries(numeric.filter(key => options[key] !== undefined).map(key => [key, Number(options[key])]));
  if (options.walkSource) {
    const walk = readWalkClip(readFileSync(options.walkSource), options.walkClip ?? LOOP_DEFAULTS.walkClip);
    loopOptions.walkChannels = walk.channels;
    loopOptions.walkCycleSeconds = walk.duration;
  }
  const output = loopHeroClip(readFileSync(positional[0]), loopOptions);
  writeFileSync(positional[1], output);
  console.log(`looped clip written: ${output.length} bytes`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
