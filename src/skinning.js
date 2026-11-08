import { mat4 } from 'gl-matrix';
import { registerShaderFeatureCode, registerDeformationSupport } from './shader-registry.js';

const poseWorkspaces = new WeakMap();
const IDENTITY_MATRIX = mat4.create();
const MAX_SKIN_WEIGHT = 1.000001;

function finiteFloat(value) {
  return Number.isFinite(value) && Number.isFinite(Math.fround(value));
}

export function matrixDeterminant(values, offset) {
  const matrixXX = Math.fround(values[offset]);
  const matrixYX = Math.fround(values[offset + 1]);
  const matrixZX = Math.fround(values[offset + 2]);
  const matrixXY = Math.fround(values[offset + 4]);
  const matrixYY = Math.fround(values[offset + 5]);
  const matrixZY = Math.fround(values[offset + 6]);
  const matrixXZ = Math.fround(values[offset + 8]);
  const matrixYZ = Math.fround(values[offset + 9]);
  const matrixZZ = Math.fround(values[offset + 10]);
  return matrixXX * (matrixYY * matrixZZ - matrixYZ * matrixZY)
    - matrixXY * (matrixYX * matrixZZ - matrixYZ * matrixZX)
    + matrixXZ * (matrixYX * matrixZY - matrixYY * matrixZX);
}

function validateMatrices(values, count, label) {
  if (values?.length !== count * 16) throw new Error(`${label} must contain one matrix per joint.`);
  // A Float32Array element is already a float, so finiteness is the whole check; other arrays must also fit a Float32.
  if (values instanceof Float32Array) {
    for (let index = 0; index < values.length; index++) if (!Number.isFinite(values[index])) throw new Error(`${label} must contain finite floats.`);
  } else {
    for (const value of values) if (!finiteFloat(value)) throw new Error(`${label} must contain finite floats.`);
  }
  for (let offset = 0; offset < values.length; offset += 16) {
    if (values[offset + 3] !== 0 || values[offset + 7] !== 0 || values[offset + 11] !== 0 || values[offset + 15] !== 1) throw new Error(`${label} must contain affine matrices.`);
    if (Math.abs(matrixDeterminant(values, offset)) < 1e-10) throw new Error(`${label} contains a singular joint transform.`);
  }
}

/** Create a retained mesh-local joint palette. Shared pose identity shares a GPU palette. */
export function createSkinPose(jointCount) {
  if (!Number.isSafeInteger(jointCount) || jointCount < 1 || jointCount > 65536) throw new Error('Joint count must be within one and 65536.');
  const jointMatrices = new Float32Array(jointCount * 16);
  for (let joint = 0; joint < jointCount; joint++) jointMatrices.set(IDENTITY_MATRIX, joint * 16);
  const pose = { jointMatrices };
  poseWorkspaces.set(pose, {
    jointMatrices,
    pending: new Float32Array(jointMatrices.length),
    meshWorld: mat4.create(), meshInverse: mat4.create(), bind: mat4.create(), world: mat4.create(), inverseBind: mat4.create(), product: mat4.create(),
  });
  return pose;
}

/** Atomically calculate inverse(meshWorld) * jointWorld * inverseBind * bindMatrix. */
export function updateSkinPose(pose, jointWorldMatrices, inverseBindMatrices, meshWorldMatrix = IDENTITY_MATRIX, bindMatrix = IDENTITY_MATRIX) {
  const workspace = poseWorkspaces.get(pose);
  if (!workspace || pose.jointMatrices !== workspace.jointMatrices) throw new Error('Use an unchanged pose from createSkinPose().');
  const count = pose.jointMatrices.length / 16;
  validateMatrices(jointWorldMatrices, count, 'Joint world matrices');
  validateMatrices(inverseBindMatrices, count, 'Inverse bind matrices');
  validateMatrices(meshWorldMatrix, 1, 'Mesh world matrix');
  validateMatrices(bindMatrix, 1, 'Bind matrix');
  workspace.meshWorld.set(meshWorldMatrix);
  workspace.bind.set(bindMatrix);
  if (!mat4.invert(workspace.meshInverse, workspace.meshWorld)) throw new Error('Mesh world matrix cannot be inverted.');
  validateMatrices(workspace.meshInverse, 1, 'Inverse mesh world matrix');
  for (let joint = 0; joint < count; joint++) {
    const offset = joint * 16;
    for (let component = 0; component < 16; component++) {
      workspace.world[component] = jointWorldMatrices[offset + component];
      workspace.inverseBind[component] = inverseBindMatrices[offset + component];
    }
    mat4.multiply(workspace.product, workspace.world, workspace.inverseBind);
    mat4.multiply(workspace.product, workspace.product, workspace.bind);
    mat4.multiply(workspace.product, workspace.meshInverse, workspace.product);
    workspace.pending.set(workspace.product, offset);
  }
  validateMatrices(workspace.pending, count, 'Joint palette');
  pose.jointMatrices.set(workspace.pending);
  return pose;
}

export function skinTextureLayout(texelCount, maximumSize, groupSize = 1) {
  if (!Number.isSafeInteger(texelCount) || texelCount < 1 || !Number.isInteger(maximumSize) || maximumSize < groupSize) throw new Error('Invalid skin texture dimensions.');
  const width = Math.min(Math.floor(maximumSize / groupSize) * groupSize, Math.max(groupSize, Math.ceil(Math.sqrt(texelCount) / groupSize) * groupSize));
  const height = Math.ceil(texelCount / width);
  if (height > maximumSize) throw new Error('Skin texture exceeds MAX_TEXTURE_SIZE.');
  return { width, height, bytes: width * height * 16 };
}

export function validateSkinGeometry(geometry, pose) {
  if (!pose) {
    if (geometry.skinIndices || geometry.skinWeights) throw new Error('Skin attributes require a skin pose.');
    return;
  }
  const jointCount = pose.jointMatrices?.length / 16;
  if (!Number.isInteger(jointCount) || jointCount < 1 || jointCount > 65536 || !(pose.jointMatrices instanceof Float32Array)) throw new Error('Skin pose requires a Float32 joint palette.');
  const vertexCount = geometry.positions.length / 3;
  if (geometry.skinIndices?.length !== vertexCount * 4 || geometry.skinWeights?.length !== vertexCount * 4) throw new Error('Skin indices and weights require four values per vertex.');
  for (let vertex = 0; vertex < vertexCount; vertex++) {
    let total = 0;
    for (let influence = 0; influence < 4; influence++) {
      const offset = vertex * 4 + influence;
      const joint = geometry.skinIndices[offset];
      const weight = geometry.skinWeights[offset];
      if (!Number.isInteger(joint) || joint < 0 || joint >= jointCount) throw new Error('Skin joint index is out of range.');
      // Exporters write a full weight as the next Float32 above one, so one unit of rounding must pass.
      if (!finiteFloat(weight) || weight < 0 || weight > MAX_SKIN_WEIGHT) throw new Error('Skin weights must be finite values within zero and one.');
      total += weight;
    }
    if (total <= 1e-8) throw new Error('Skin vertex weights must have a positive total.');
  }
  validateSkinPose(pose, geometry);
}

// Distinct (joints, normalized weights) sets of a geometry, keyed by its weight array. The renderer refuses a changed
// skinIndices or skinWeights identity and packs influences to the GPU once, so the arrays are fixed for a renderer's life.
const influenceSetCache = new WeakMap();

/** The distinct influence sets in vertex order of first use. Many vertices share one set, and each set gives one transform. */
export function skinInfluenceSets(geometry) {
  const cached = influenceSetCache.get(geometry.skinWeights);
  if (cached && cached.skinIndices === geometry.skinIndices) return cached;
  const vertexCount = geometry.skinWeights.length / 4;
  const seen = new Map();
  const joints = [];
  const weights = [];
  for (let vertex = 0; vertex < vertexCount; vertex++) {
    let total = 0;
    for (let influence = 0; influence < 4; influence++) total += geometry.skinWeights[vertex * 4 + influence];
    const setJoints = [];
    const setWeights = [];
    for (let influence = 0; influence < 4; influence++) {
      setJoints.push(geometry.skinIndices[vertex * 4 + influence]);
      setWeights.push(Math.fround(geometry.skinWeights[vertex * 4 + influence] / total));
    }
    const key = `${setJoints.join(',')}|${setWeights.join(',')}`;
    if (seen.has(key)) continue;
    seen.set(key, true);
    joints.push(...setJoints);
    weights.push(...setWeights);
  }
  const sets = { skinIndices: geometry.skinIndices, joints: Int32Array.from(joints), weights: Float32Array.from(weights) };
  influenceSetCache.set(geometry.skinWeights, sets);
  return sets;
}

/** Validate weighted normal transforms without allocating temporary matrices, once per distinct influence set. */
export function validateSkinPose(pose, geometry, worldMatrix) {
  const matrices = pose.jointMatrices;
  validateMatrices(matrices, matrices.length / 16, 'Joint palette');
  if (!geometry) return;
  const { joints, weights } = skinInfluenceSets(geometry);
  const worldDeterminant = worldMatrix ? matrixDeterminant(worldMatrix, 0) : 0;
  for (let set = 0; set < joints.length / 4; set++) {
    let matrixXX = 0;
    let matrixYX = 0;
    let matrixZX = 0;
    let matrixXY = 0;
    let matrixYY = 0;
    let matrixZY = 0;
    let matrixXZ = 0;
    let matrixYZ = 0;
    let matrixZZ = 0;
    for (let influence = 0; influence < 4; influence++) {
      const weight = weights[set * 4 + influence];
      const offset = joints[set * 4 + influence] * 16;
      matrixXX += matrices[offset] * weight;
      matrixYX += matrices[offset + 1] * weight;
      matrixZX += matrices[offset + 2] * weight;
      matrixXY += matrices[offset + 4] * weight;
      matrixYY += matrices[offset + 5] * weight;
      matrixZY += matrices[offset + 6] * weight;
      matrixXZ += matrices[offset + 8] * weight;
      matrixYZ += matrices[offset + 9] * weight;
      matrixZZ += matrices[offset + 10] * weight;
    }
    const determinant = matrixXX * (matrixYY * matrixZZ - matrixYZ * matrixZY) - matrixXY * (matrixYX * matrixZZ - matrixYZ * matrixZX) + matrixXZ * (matrixYX * matrixZY - matrixYY * matrixZX);
    if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-8) throw new Error('Skin pose produces a singular weighted vertex transform.');
    if (worldMatrix && determinant * worldDeterminant < 0) throw new Error('Reflected weighted skin transforms are unsupported.');
  }
}

export function packSkinInfluences(geometry, layout) {
  const data = new Float32Array(layout.width * layout.height * 4);
  for (let vertex = 0; vertex < geometry.skinWeights.length / 4; vertex++) {
    let total = 0;
    for (let influence = 0; influence < 4; influence++) total += geometry.skinWeights[vertex * 4 + influence];
    for (let influence = 0; influence < 4; influence++) {
      data[vertex * 8 + influence] = geometry.skinIndices[vertex * 4 + influence];
      data[vertex * 8 + 4 + influence] = Math.fround(geometry.skinWeights[vertex * 4 + influence] / total);
    }
  }
  return data;
}

// The vertex GLSL of skinned parts, spliced by shaders.js around the crowd code, which reads skinTexel and jointPalette.
registerShaderFeatureCode('skin', {
  vertexHead: `
uniform float skinEnabled;
uniform highp sampler2D skinInfluences;
uniform highp sampler2D jointPalette;
vec4 skinTexel(sampler2D source, int index) {
  int width = textureSize(source, 0).x;
  return texelFetch(source, ivec2(index % width, index / width), 0);
}
mat4 jointMatrix(int joint) {
  int offset = joint * 4;
  return mat4(skinTexel(jointPalette, offset), skinTexel(jointPalette, offset + 1),
    skinTexel(jointPalette, offset + 2), skinTexel(jointPalette, offset + 3));
}
`,
  vertexTail: `mat4 skinTransform() {
  if (skinEnabled < 0.5) return mat4(1.0);
  ivec4 joints = ivec4(skinTexel(skinInfluences, gl_VertexID * 2));
  vec4 weights = skinTexel(skinInfluences, gl_VertexID * 2 + 1);
  return jointMatrix(joints.x) * weights.x + jointMatrix(joints.y) * weights.y
    + jointMatrix(joints.z) * weights.z + jointMatrix(joints.w) * weights.w;
}
`,
});

registerDeformationSupport({ validateSkinGeometry, validateSkinPose, skinTextureLayout, packSkinInfluences });
