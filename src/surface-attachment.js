import { mat3 } from 'gl-matrix';
import { validateMorphGeometry, validateMorphPose, validateMorphTransform } from './morph.js';
import { validateSkinGeometry, validateSkinPose } from './skinning.js';

const OPTION_FIELDS = new Set(['triangle', 'barycentric', 'clearance', 'rotation', 'maxVertices', 'maxTriangles']);
const VERTEX_PROCEDURAL_TAGS = new Set(['water', 'foliage', 'grass', 'fire', 'smoke']);
const DEFORMATION_PROCEDURAL_TAGS = new Set(['water', 'foliage', 'grass', 'terrain', 'floor', 'fire', 'smoke']);

function finiteFloat(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isFinite(Math.fround(value))) {
    throw new RangeError(`${label} must be finite and Float32-representable.`);
  }
  return value;
}

function limit(value, label) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_000_000) {
    throw new RangeError(`${label} must be an integer from 1 through 1000000.`);
  }
  return value;
}

function determinant(matrix, offset = 0) {
  return matrix[offset] * (matrix[offset + 5] * matrix[offset + 10] - matrix[offset + 9] * matrix[offset + 6])
    - matrix[offset + 4] * (matrix[offset + 1] * matrix[offset + 10] - matrix[offset + 9] * matrix[offset + 2])
    + matrix[offset + 8] * (matrix[offset + 1] * matrix[offset + 6] - matrix[offset + 5] * matrix[offset + 2]);
}

function validateMatrix(matrix, offset, label, minimumDeterminant = 0) {
  for (let component = 0; component < 16; component++) finiteFloat(matrix[offset + component], label);
  if (matrix[offset + 3] !== 0 || matrix[offset + 7] !== 0 || matrix[offset + 11] !== 0 || matrix[offset + 15] !== 1) {
    throw new RangeError(`${label} must remain affine.`);
  }
  const value = determinant(matrix, offset);
  if (!Number.isFinite(value) || value === 0 || Math.abs(value) < minimumDeterminant) {
    throw new RangeError(`${label} must remain nonsingular.`);
  }
  return value;
}

function validateTargetMode(target) {
  if (target.assembly !== undefined && target.assembly !== null) throw new RangeError('Surface attachments cannot follow assembly shader offsets.');
  const tag = target.material?.tag;
  if (VERTEX_PROCEDURAL_TAGS.has(tag) || ((target.skin || target.morph) && DEFORMATION_PROCEDURAL_TAGS.has(tag))) {
    throw new RangeError('Surface attachment target uses unsupported procedural deformation or a deformed procedural material.');
  }
}

function validateGeometry(geometry, maxVertices, maxTriangles) {
  const { positions, normals, indices } = geometry ?? {};
  if (!(positions instanceof Float32Array) || positions.length < 9 || positions.length % 3 !== 0 ||
      !(normals instanceof Float32Array) || normals.length !== positions.length ||
      !(indices instanceof Uint32Array) || indices.length < 3 || indices.length % 3 !== 0) {
    throw new TypeError('Surface attachments require indexed Float32 positions/normals and Uint32 triangles.');
  }
  const vertexCount = positions.length / 3;
  const triangleCount = indices.length / 3;
  if (vertexCount > maxVertices || triangleCount > maxTriangles) throw new RangeError('Attachment target exceeds maxVertices or maxTriangles.');
  for (const value of positions) finiteFloat(value, 'Target position');
  for (let offset = 0; offset < normals.length; offset += 3) {
    const length = Math.hypot(normals[offset], normals[offset + 1], normals[offset + 2]);
    if (!Number.isFinite(length) || Math.abs(length - 1) > 0.001) throw new RangeError('Target normals must remain finite unit vectors.');
  }
  for (const index of indices) if (index >= vertexCount) throw new RangeError('Target triangle index exceeds the vertex count.');
  for (let offset = 0; offset < indices.length; offset += 3) {
    const first = indices[offset] * 3;
    const second = indices[offset + 1] * 3;
    const third = indices[offset + 2] * 3;
    const edgeFirstX = positions[second] - positions[first];
    const edgeFirstY = positions[second + 1] - positions[first + 1];
    const edgeFirstZ = positions[second + 2] - positions[first + 2];
    const edgeSecondX = positions[third] - positions[first];
    const edgeSecondY = positions[third + 1] - positions[first + 1];
    const edgeSecondZ = positions[third + 2] - positions[first + 2];
    if (Math.hypot(edgeFirstY * edgeSecondZ - edgeFirstZ * edgeSecondY, edgeFirstZ * edgeSecondX - edgeFirstX * edgeSecondZ, edgeFirstX * edgeSecondY - edgeFirstY * edgeSecondX) === 0) {
      throw new RangeError('Attachment target contains a degenerate triangle.');
    }
  }
  return { vertexCount, triangleCount };
}

function rounded(value) {
  const result = Math.fround(value);
  if (!Number.isFinite(result)) throw new RangeError('Attachment deformation exceeds finite Float32 arithmetic.');
  return result;
}

/** Bind one original triangle and retain a rigid world-space frame for current deformation poses. */
export function createSurfaceAttachment(target, options = {}) {
  if (!target || typeof target !== 'object') throw new TypeError('Surface attachments require a target part.');
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('Attachment options require an object.');
  for (const field of Object.keys(options)) if (!OPTION_FIELDS.has(field)) throw new TypeError(`Unsupported attachment option ${field}.`);
  const maxVertices = limit(options.maxVertices ?? 250_000, 'maxVertices');
  const maxTriangles = limit(options.maxTriangles ?? 250_000, 'maxTriangles');
  const geometry = target.geometry;
  const counts = validateGeometry(geometry, maxVertices, maxTriangles);
  const triangle = options.triangle;
  if (!Number.isSafeInteger(triangle) || triangle < 0 || triangle >= counts.triangleCount) throw new RangeError('Attachment triangle must reference an original target triangle.');
  const inputWeights = options.barycentric;
  if ((!Array.isArray(inputWeights) && !ArrayBuffer.isView(inputWeights)) || inputWeights.length !== 3) throw new TypeError('Attachment barycentric coordinates require three components.');
  const barycentric = new Float64Array(3);
  let total = 0;
  for (let corner = 0; corner < 3; corner++) {
    const value = finiteFloat(inputWeights[corner], 'Barycentric coordinate');
    if (value < 0) throw new RangeError('Barycentric coordinates must be nonnegative.');
    barycentric[corner] = value;
    total += value;
  }
  if (Math.abs(total - 1) > 1e-6) throw new RangeError('Barycentric coordinates must sum to one within 1e-6.');
  for (let corner = 0; corner < 3; corner++) barycentric[corner] /= total;
  const clearance = finiteFloat(options.clearance ?? 0, 'Clearance');
  if (clearance < 0) throw new RangeError('Clearance must be nonnegative.');
  const rotation = finiteFloat(options.rotation ?? 0, 'Rotation');
  const cosine = Math.cos(rotation);
  const sine = Math.sin(rotation);
  const worldMatrix = target.matrix;
  if (!(worldMatrix instanceof Float32Array) || worldMatrix.length !== 16) throw new TypeError('Target matrix requires a retained Float32Array of 16 components.');
  validateTargetMode(target);
  validateMatrix(worldMatrix, 0, 'Target matrix');
  const skin = target.skin ?? null;
  const morph = target.morph ?? null;
  validateSkinGeometry(geometry, skin);
  if (skin) validateSkinPose(skin, geometry, worldMatrix);
  const morphMetadata = validateMorphGeometry(geometry, morph);
  if (morph) validateMorphTransform(morph, morphMetadata, worldMatrix, skin);
  const positionsIdentity = geometry.positions;
  const normalsIdentity = geometry.normals;
  const indicesIdentity = geometry.indices;
  const skinIndicesIdentity = geometry.skinIndices;
  const skinWeightsIdentity = geometry.skinWeights;
  const palette = skin?.jointMatrices;
  const paletteLength = palette?.length;
  const morphWeights = morph?.weights;
  const selectedPositions = new Float32Array(9);
  const selectedDeltas = new Float32Array((morphMetadata?.targetCount ?? 0) * 9);
  const selectedJoints = new Uint32Array(12);
  const selectedWeights = new Float32Array(12);
  for (let corner = 0; corner < 3; corner++) {
    const vertex = geometry.indices[triangle * 3 + corner];
    selectedPositions.set(geometry.positions.subarray(vertex * 3, vertex * 3 + 3), corner * 3);
    for (let targetIndex = 0; targetIndex < (morphMetadata?.targetCount ?? 0); targetIndex++) {
      const deltas = morphMetadata.targets[targetIndex].positions;
      if (deltas) selectedDeltas.set(deltas.subarray(vertex * 3, vertex * 3 + 3), targetIndex * 9 + corner * 3);
    }
    if (skin) {
      let skinTotal = 0;
      for (let influence = 0; influence < 4; influence++) skinTotal += geometry.skinWeights[vertex * 4 + influence];
      for (let influence = 0; influence < 4; influence++) {
        selectedJoints[corner * 4 + influence] = geometry.skinIndices[vertex * 4 + influence];
        selectedWeights[corner * 4 + influence] = Math.fround(geometry.skinWeights[vertex * 4 + influence] / skinTotal);
      }
    }
  }
  const matrix = new Float32Array(16);
  const pending = new Float32Array(16);
  pending[15] = 1;
  const vertex = new Float32Array(4);
  vertex[3] = 1;
  const blended = new Float32Array(16);
  const combined = new Float32Array(16);
  const worldVertices = new Float64Array(9);
  const normalWorkspace = new Float32Array(9);

  function update() {
    if (target.geometry !== geometry || geometry.positions !== positionsIdentity || geometry.normals !== normalsIdentity || geometry.indices !== indicesIdentity ||
        positionsIdentity.length !== counts.vertexCount * 3 || normalsIdentity.length !== counts.vertexCount * 3 || indicesIdentity.length !== counts.triangleCount * 3 ||
        target.matrix !== worldMatrix || worldMatrix.length !== 16 || (target.skin ?? null) !== skin || (target.morph ?? null) !== morph ||
        geometry.skinIndices !== skinIndicesIdentity || geometry.skinWeights !== skinWeightsIdentity || skin?.jointMatrices !== palette || palette?.length !== paletteLength || morph?.weights !== morphWeights) {
      throw new Error('Attachment target buffer or pose identities changed. Bind a new attachment.');
    }
    if (skin && (skinIndicesIdentity.length !== counts.vertexCount * 4 || skinWeightsIdentity.length !== counts.vertexCount * 4)) {
      throw new Error('Attachment skin channel lengths changed. Bind a new attachment.');
    }
    validateTargetMode(target);
    const worldDeterminant = validateMatrix(worldMatrix, 0, 'Target matrix');
    if (!mat3.normalFromMat4(normalWorkspace, worldMatrix)) throw new RangeError('Target matrix has no finite normal transform.');
    for (let component = 0; component < 9; component++) finiteFloat(normalWorkspace[component], 'Target normal transform');
    if (morph) {
      validateMorphPose(morph, morphMetadata);
      for (let targetIndex = 0; targetIndex < morphMetadata.targetCount; targetIndex++) {
        const channels = morphMetadata.targets[targetIndex];
        if ((channels.positions && channels.positions.length !== counts.vertexCount * 3) || (channels.normals && channels.normals.length !== counts.vertexCount * 3)) {
          throw new Error('Attachment morph channel lengths changed. Bind a new attachment.');
        }
      }
    }
    if (skin) {
      for (let influence = 0; influence < 12; influence++) validateMatrix(palette, selectedJoints[influence] * 16, 'Referenced joint palette', 1e-10);
    }
    for (let corner = 0; corner < 3; corner++) {
      for (let axis = 0; axis < 3; axis++) {
        let coordinate = selectedPositions[corner * 3 + axis];
        for (let targetIndex = 0; targetIndex < (morphMetadata?.targetCount ?? 0); targetIndex++) {
          coordinate = rounded(coordinate + rounded(selectedDeltas[targetIndex * 9 + corner * 3 + axis] * morphWeights[targetIndex]));
        }
        vertex[axis] = coordinate;
      }
      if (skin) {
        for (let component = 0; component < 16; component++) {
          let coefficient = 0;
          for (let influence = 0; influence < 4; influence++) {
            const offset = corner * 4 + influence;
            coefficient = rounded(coefficient + rounded(palette[selectedJoints[offset] * 16 + component] * selectedWeights[offset]));
          }
          blended[component] = coefficient;
        }
        const blendedDeterminant = determinant(blended);
        if (!Number.isFinite(blendedDeterminant) || Math.abs(blendedDeterminant) < 1e-8) throw new RangeError('Attachment has a singular weighted skin transform.');
        if (blendedDeterminant * worldDeterminant < 0) throw new RangeError('A surface attachment cannot sit on a mirrored weighted skin vertex. Move it to a face whose joints do not turn opposite ways.');
        for (let column = 0; column < 4; column++) {
          for (let row = 0; row < 4; row++) {
            let coefficient = 0;
            for (let axis = 0; axis < 4; axis++) coefficient = rounded(coefficient + rounded(worldMatrix[axis * 4 + row] * blended[column * 4 + axis]));
            combined[column * 4 + row] = coefficient;
          }
        }
      } else {
        combined.set(worldMatrix);
      }
      let homogeneous = 0;
      for (let axis = 0; axis < 4; axis++) homogeneous = rounded(homogeneous + rounded(combined[axis * 4 + 3] * vertex[axis]));
      if (!(homogeneous > 0)) throw new RangeError('Attachment has an invalid homogeneous vertex coordinate.');
      for (let row = 0; row < 3; row++) {
        let coordinate = 0;
        for (let axis = 0; axis < 4; axis++) coordinate = rounded(coordinate + rounded(combined[axis * 4 + row] * vertex[axis]));
        worldVertices[corner * 3 + row] = finiteFloat(coordinate / homogeneous, 'Posed world vertex');
      }
    }
    const edgeX = worldVertices[3] - worldVertices[0];
    const edgeY = worldVertices[4] - worldVertices[1];
    const edgeZ = worldVertices[5] - worldVertices[2];
    const otherX = worldVertices[6] - worldVertices[0];
    const otherY = worldVertices[7] - worldVertices[1];
    const otherZ = worldVertices[8] - worldVertices[2];
    const crossX = edgeY * otherZ - edgeZ * otherY;
    const crossY = edgeZ * otherX - edgeX * otherZ;
    const crossZ = edgeX * otherY - edgeY * otherX;
    const edgeLength = Math.hypot(edgeX, edgeY, edgeZ);
    const area = Math.hypot(crossX, crossY, crossZ);
    const longest = Math.max(edgeLength, Math.hypot(otherX, otherY, otherZ), Math.hypot(otherX - edgeX, otherY - edgeY, otherZ - edgeZ));
    let maximumCoordinate = 0;
    for (let component = 0; component < 9; component++) maximumCoordinate = Math.max(maximumCoordinate, Math.abs(worldVertices[component]));
    const altitude = area / longest;
    if (!Number.isFinite(altitude) || altitude <= maximumCoordinate * 2 ** -21 + 2 ** -149) throw new RangeError('Attachment triangle collapses within Float32 world precision.');
    const tangentX = edgeX / edgeLength;
    const tangentY = edgeY / edgeLength;
    const tangentZ = edgeZ / edgeLength;
    const normalX = crossX / area;
    const normalY = crossY / area;
    const normalZ = crossZ / area;
    const secondX = normalY * tangentZ - normalZ * tangentY;
    const secondY = normalZ * tangentX - normalX * tangentZ;
    const secondZ = normalX * tangentY - normalY * tangentX;
    pending[0] = tangentX * cosine + secondX * sine;
    pending[1] = tangentY * cosine + secondY * sine;
    pending[2] = tangentZ * cosine + secondZ * sine;
    pending[4] = secondX * cosine - tangentX * sine;
    pending[5] = secondY * cosine - tangentY * sine;
    pending[6] = secondZ * cosine - tangentZ * sine;
    pending[8] = normalX;
    pending[9] = normalY;
    pending[10] = normalZ;
    let originX = 0;
    let originY = 0;
    let originZ = 0;
    for (let corner = 0; corner < 3; corner++) {
      originX += worldVertices[corner * 3] * barycentric[corner];
      originY += worldVertices[corner * 3 + 1] * barycentric[corner];
      originZ += worldVertices[corner * 3 + 2] * barycentric[corner];
    }
    pending[12] = finiteFloat(originX + normalX * clearance, 'Attachment translation');
    pending[13] = finiteFloat(originY + normalY * clearance, 'Attachment translation');
    pending[14] = finiteFloat(originZ + normalZ * clearance, 'Attachment translation');
    if (clearance > 0) {
      const gap = (pending[12] - originX) * normalX + (pending[13] - originY) * normalY + (pending[14] - originZ) * normalZ;
      const movement = (pending[12] - Math.fround(originX)) * normalX + (pending[13] - Math.fround(originY)) * normalY + (pending[14] - Math.fround(originZ)) * normalZ;
      if (!(gap > 0 && movement > 0)) throw new RangeError('Attachment clearance collapses against the geometric face at Float32 precision.');
    }
    matrix.set(pending);
    return matrix;
  }

  update();
  return Object.freeze({ matrix, update });
}
