import { MAX_MORPH_TARGETS, MAX_STORED_MORPH_TARGETS, registerShaderFeatureCode, registerDeformationSupport } from './shader-registry.js';
import { skinTextureLayout } from './skinning.js';

export { MAX_MORPH_TARGETS, MAX_STORED_MORPH_TARGETS };

const validatedMetadata = new WeakSet();
const MIN_NORMAL_FLOAT32 = 2 ** -126;

// Round nonnegative bounds upward so fused shader arithmetic cannot exceed them.
function upperFloatBound(value) {
  const rounded = Math.fround(value);
  if (rounded >= value || !Number.isFinite(rounded)) return rounded;
  return Math.fround(rounded + Math.max(2 ** -149, rounded * 2 ** -23));
}

function targetCount(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_STORED_MORPH_TARGETS) {
    throw new RangeError('Morph target count must be within one and 256.');
  }
  return value;
}

export function createMorphPose(count) {
  return { weights: new Float32Array(targetCount(count)) };
}

function componentMaxima(values, length, label, requireNormal = false) {
  if (!(values instanceof Float32Array) || values.length !== length) {
    throw new TypeError(`${label} requires one Float32 RGB vector per vertex.`);
  }
  const maxima = [0, 0, 0];
  for (let offset = 0; offset < length; offset += 3) {
    let squaredLength = 0;
    for (let component = 0; component < 3; component++) {
      const value = values[offset + component];
      if (!Number.isFinite(value)) throw new RangeError(`${label} must contain finite Float32 values.`);
      maxima[component] = Math.max(maxima[component], Math.abs(value));
      squaredLength = Math.fround(squaredLength + Math.fround(value * value));
    }
    if (requireNormal && (!Number.isFinite(squaredLength) || squaredLength < MIN_NORMAL_FLOAT32)) {
      throw new RangeError('Base morph normals require a finite normal Float32 squared length.');
    }
  }
  return Object.freeze(maxima);
}

function geometryMetadata(geometry) {
  const componentCount = geometry?.positions?.length;
  if (!Number.isSafeInteger(componentCount) || componentCount < 3 || componentCount % 3 !== 0) {
    throw new TypeError('Morph base positions require a nonempty RGB vertex array.');
  }
  const basePositionMaxima = componentMaxima(geometry.positions, componentCount, 'Morph base positions');
  const baseNormalMaxima = componentMaxima(geometry.normals, componentCount, 'Morph base normals', true);
  if (!Array.isArray(geometry.morphTargets)) throw new TypeError('Morph geometry requires a target array.');
  const count = targetCount(geometry.morphTargets.length);
  const targets = [];
  for (let index = 0; index < count; index++) {
    const target = geometry.morphTargets[index];
    if (!target || typeof target !== 'object' || Array.isArray(target)) throw new TypeError('Each morph target must be an object.');
    for (const key of Object.keys(target)) {
      if (key !== 'positions' && key !== 'normals') throw new TypeError(`Morph target ${key} is unsupported.`);
    }
    if (target.positions === undefined && target.normals === undefined) throw new TypeError('Each morph target requires positions or normals.');
    const positionMaxima = target.positions === undefined ? Object.freeze([0, 0, 0]) : componentMaxima(target.positions, componentCount, 'Morph position deltas');
    const normalMaxima = target.normals === undefined ? Object.freeze([0, 0, 0]) : componentMaxima(target.normals, componentCount, 'Morph normal deltas');
    targets.push(Object.freeze({ target, positions: target.positions, normals: target.normals, positionMaxima, normalMaxima }));
  }
  const metadata = Object.freeze({
    geometry,
    positions: geometry.positions,
    normals: geometry.normals,
    morphTargets: geometry.morphTargets,
    vertexCount: componentCount / 3,
    targetCount: count,
    texelCount: componentCount / 3 * count * 2,
    basePositionMaxima,
    baseNormalMaxima,
    targets: Object.freeze(targets),
  });
  validatedMetadata.add(metadata);
  return metadata;
}

function validateIdentities(metadata) {
  if (!validatedMetadata.has(metadata)) throw new TypeError('Use metadata from validateMorphGeometry().');
  const geometry = metadata.geometry;
  if (geometry.positions !== metadata.positions || geometry.normals !== metadata.normals || geometry.morphTargets !== metadata.morphTargets
      || geometry.morphTargets.length !== metadata.targetCount) {
    throw new Error('Morph geometry array identities must remain unchanged after preflight.');
  }
  for (let index = 0; index < metadata.targetCount; index++) {
    const snapshot = metadata.targets[index];
    if (geometry.morphTargets[index] !== snapshot.target || snapshot.target.positions !== snapshot.positions || snapshot.target.normals !== snapshot.normals) {
      throw new Error('Morph target and channel identities must remain unchanged after preflight.');
    }
  }
}

/** Full static preflight. One geometry metadata object serves independent poses. */
export function validateMorphGeometry(geometry, pose) {
  if (!pose) {
    if (geometry?.morphTargets !== undefined) throw new TypeError('Morph targets require a morph pose.');
    return undefined;
  }
  const metadata = geometryMetadata(geometry);
  validateMorphPose(pose, metadata);
  return metadata;
}

/** Bounded validation of mutable weights without rescanning uploaded channel contents. */
export function validateMorphPose(pose, metadata) {
  validateIdentities(metadata);
  const weights = pose?.weights;
  if (!(weights instanceof Float32Array) || weights.length !== metadata.targetCount) {
    throw new TypeError('Morph pose requires one Float32 weight per target.');
  }
  for (let index = 0; index < weights.length; index++) {
    if (!Number.isFinite(weights[index])) throw new RangeError('Morph weights must remain finite Float32 values.');
  }
  let squaredNormalBound = 0;
  for (let component = 0; component < 3; component++) {
    let positionBound = metadata.basePositionMaxima[component];
    let normalBound = metadata.baseNormalMaxima[component];
    for (let index = 0; index < weights.length; index++) {
      const magnitude = Math.abs(weights[index]);
      positionBound = upperFloatBound(positionBound + upperFloatBound(magnitude * metadata.targets[index].positionMaxima[component]));
      normalBound = upperFloatBound(normalBound + upperFloatBound(magnitude * metadata.targets[index].normalMaxima[component]));
    }
    if (!Number.isFinite(positionBound) || !Number.isFinite(normalBound)) {
      throw new RangeError('Morph weights exceed finite Float32 position or normal bounds.');
    }
    squaredNormalBound = upperFloatBound(squaredNormalBound + upperFloatBound(normalBound * normalBound));
  }
  if (!Number.isFinite(squaredNormalBound)) throw new RangeError('Morph weights exceed a finite Float32 normal squared length bound.');
  return metadata;
}

/** Conservative Float32 bounds for the shader's world * skin * morphed position. */
export function validateMorphTransform(pose, metadata, worldMatrix, skin) {
  validateMorphPose(pose, metadata);
  for (let row = 0; row < 4; row++) {
    let coordinateBound = 0;
    for (let column = 0; column < 4; column++) {
      let localBound = column === 3 ? 1 : metadata.basePositionMaxima[column];
      if (column < 3) {
        for (let target = 0; target < metadata.targetCount; target++) {
          localBound = upperFloatBound(localBound + upperFloatBound(Math.abs(pose.weights[target]) * metadata.targets[target].positionMaxima[column]));
        }
      }
      let coefficientBound = Math.abs(Math.fround(worldMatrix[column * 4 + row]));
      if (skin) {
        coefficientBound = 0;
        for (let axis = 0; axis < 4; axis++) {
          let paletteBound = 0;
          for (let offset = column * 4 + axis; offset < skin.jointMatrices.length; offset += 16) {
            paletteBound = Math.max(paletteBound, Math.abs(Math.fround(skin.jointMatrices[offset])));
          }
          // Four normalized Float32 influences can sum slightly above one.
          paletteBound = upperFloatBound(paletteBound * (1 + 2 ** -21));
          coefficientBound = upperFloatBound(coefficientBound + upperFloatBound(Math.abs(Math.fround(worldMatrix[axis * 4 + row])) * paletteBound));
        }
      }
      if (!Number.isFinite(coefficientBound)) throw new RangeError('Morph world/skin matrix product exceeds finite Float32 bounds.');
      coordinateBound = upperFloatBound(coordinateBound + upperFloatBound(coefficientBound * localBound));
    }
    if (!Number.isFinite(coordinateBound)) throw new RangeError('Morph world position exceeds finite Float32 bounds.');
  }
}

/**
 * For a geometry with more than MAX_MORPH_TARGETS targets, chooses the nonzero weights that are largest in magnitude (the
 * lower target wins a tie) for one draw. Writes the target index and weight of each slot into the two outputs and returns
 * the slot count. A geometry with fewer targets draws all of them in order and needs no selection.
 */
export function selectMorphSlots(weights, slotTargets, slotWeights) {
  const active = [];
  for (let target = 0; target < weights.length; target++) {
    if (weights[target] !== 0) active.push(target);
  }
  active.sort((first, second) => Math.abs(weights[second]) - Math.abs(weights[first]) || first - second);
  const count = Math.min(active.length, MAX_MORPH_TARGETS);
  for (let slot = 0; slot < count; slot++) {
    slotTargets[slot] = active[slot];
    slotWeights[slot] = weights[active[slot]];
  }
  return count;
}

/** Pack relative RGB channels as two RGBA texels per target vertex. */
export function packMorphTargets(geometry, layout) {
  const metadata = geometryMetadata(geometry);
  const width = layout?.width;
  const height = layout?.height;
  const texels = width * height;
  const bytes = texels * 16;
  if (!Number.isSafeInteger(width) || width < 2 || width % 2 !== 0 || !Number.isSafeInteger(height) || height < 1
      || !Number.isSafeInteger(bytes) || bytes > 2 ** 31 - 1 || texels < metadata.texelCount || (layout.bytes !== undefined && layout.bytes !== bytes)) {
    throw new RangeError('Morph texture layout requires even width, sufficient capacity and a bounded byte length.');
  }
  const data = new Float32Array(texels * 4);
  for (let target = 0; target < metadata.targetCount; target++) {
    const channels = metadata.targets[target];
    for (let vertex = 0; vertex < metadata.vertexCount; vertex++) {
      const offset = (target * metadata.vertexCount + vertex) * 8;
      for (let component = 0; component < 3; component++) {
        data[offset + component] = channels.positions?.[vertex * 3 + component] ?? 0;
        data[offset + 4 + component] = channels.normals?.[vertex * 3 + component] ?? 0;
      }
    }
  }
  return data;
}

// The vertex GLSL of morphed parts, spliced by shaders.js. Morph targets sit in one texture, on its own unit.
registerShaderFeatureCode('morph', {
  vertex: `
uniform float morphEnabled;
uniform int morphVertexCount;
uniform int morphTargetCount; // slots in use: the weights and target indices of the draw
uniform float morphWeights[${MAX_MORPH_TARGETS}];
uniform float morphSlotTargets[${MAX_MORPH_TARGETS}];
uniform highp sampler2D morphTargets;
vec3 morphDelta(int target, int channel) {
  int index = (target * morphVertexCount + gl_VertexID) * 2 + channel;
  int width = textureSize(morphTargets, 0).x;
  return texelFetch(morphTargets, ivec2(index % width, index / width), 0).xyz;
}
vec3 morphedPosition(vec3 base) {
  if (morphEnabled < 0.5) return base;
  vec3 result = base;
  for (int target = 0; target < ${MAX_MORPH_TARGETS}; target++) {
    if (target >= morphTargetCount) break;
    if (morphWeights[target] != 0.0) result += morphDelta(int(morphSlotTargets[target]), 0) * morphWeights[target];
  }
  return result;
}
vec3 morphedNormal(vec3 base) {
  if (morphEnabled < 0.5) return base;
  vec3 result = base;
  for (int target = 0; target < ${MAX_MORPH_TARGETS}; target++) {
    if (target >= morphTargetCount) break;
    if (morphWeights[target] != 0.0) result += morphDelta(int(morphSlotTargets[target]), 1) * morphWeights[target];
  }
  float largest = max(max(abs(result.x), abs(result.y)), abs(result.z));
  return largest > 0.0 ? normalize(result / largest) : base;
}
`
});

registerDeformationSupport({ selectMorphSlots, validateMorphGeometry, validateMorphPose, validateMorphTransform, packMorphTargets, skinTextureLayout });
