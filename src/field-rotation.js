import { partsOf, requireScalar, vectorValue } from './expression.js';

// Rotation and matrix operators of the field language, kept apart from the vector basics in mesh-fields.js.
// Angles are radians and an Euler triple is X then Y then Z (the rotation of a node), like sin and cos.
//
//   { "rotate": [vector, axis, angle] }          turn a vector about an axis
//   { "align": [direction] }                     Euler angles that turn +Y onto the direction
//   { "transform": [point, move, euler, size] }  scale, rotate, then move a point (move, euler and size are optional)

const UP = Object.freeze([0, 1, 0]);
const PARALLEL_LIMIT = 1 - 1e-12;
const GIMBAL_LIMIT = 1 - 1e-9;

function normalizedOrZero(vector) {
  const length = Math.hypot(vector[0], vector[1], vector[2]);
  return length === 0 ? [0, 0, 0] : [vector[0] / length, vector[1] / length, vector[2] / length];
}

/** Rodrigues rotation of a vector about an axis; a zero axis leaves the vector as it is. */
export function rotateAboutAxis(vector, axis, angle) {
  const unit = normalizedOrZero(axis);
  if (unit[0] === 0 && unit[1] === 0 && unit[2] === 0) return [...vector];
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  const along = unit[0] * vector[0] + unit[1] * vector[1] + unit[2] * vector[2];
  const crossed = [
    unit[1] * vector[2] - unit[2] * vector[1],
    unit[2] * vector[0] - unit[0] * vector[2],
    unit[0] * vector[1] - unit[1] * vector[0],
  ];
  return vector.map((component, axisIndex) => component * cosine + crossed[axisIndex] * sine + unit[axisIndex] * along * (1 - cosine));
}

/** Rotation matrix (row major, 9 numbers) for XYZ Euler angles: Rz * Ry * Rx. */
export function eulerMatrix([angleX, angleY, angleZ]) {
  const [sinX, cosX, sinY, cosY, sinZ, cosZ] = [Math.sin(angleX), Math.cos(angleX), Math.sin(angleY), Math.cos(angleY), Math.sin(angleZ), Math.cos(angleZ)];
  return [
    cosZ * cosY, cosZ * sinY * sinX - sinZ * cosX, cosZ * sinY * cosX + sinZ * sinX,
    sinZ * cosY, sinZ * sinY * sinX + cosZ * cosX, sinZ * sinY * cosX - cosZ * sinX,
    -sinY, cosY * sinX, cosY * cosX,
  ];
}

/** XYZ Euler angles of the shortest turn that takes +Y onto the direction; a zero direction gives no turn. */
export function alignEuler(direction) {
  const target = normalizedOrZero(direction);
  const cosine = target[1];
  if (target[0] === 0 && target[1] === 0 && target[2] === 0) return [0, 0, 0];
  let axis = [UP[1] * target[2] - UP[2] * target[1], UP[2] * target[0] - UP[0] * target[2], UP[0] * target[1] - UP[1] * target[0]];
  if (cosine <= -PARALLEL_LIMIT) axis = [1, 0, 0];
  const angle = Math.acos(Math.min(1, Math.max(-1, cosine)));
  const columns = [[1, 0, 0], [0, 1, 0], [0, 0, 1]].map(basis => rotateAboutAxis(basis, axis, angle));
  const entry = (row, column) => columns[column][row];
  if (Math.abs(entry(2, 0)) >= GIMBAL_LIMIT) {
    return [Math.atan2(-entry(1, 2), entry(1, 1)), Math.asin(Math.max(-1, Math.min(1, -entry(2, 0)))), 0];
  }
  return [Math.atan2(entry(2, 1), entry(2, 2)), Math.asin(-entry(2, 0)), Math.atan2(entry(1, 0), entry(0, 0))];
}

function vectorOperand(value, label) {
  if (value.kind !== 'vector') throw new TypeError(`${label} needs a vector.`);
  return value.parts;
}

// One result per element is shared by the three parts, so a vector result is computed once per element.
function sharedVector(compute) {
  let cachedIndex = -1;
  let cachedResult = null;
  return axis => index => {
    if (index !== cachedIndex) {
      cachedResult = compute(index);
      cachedIndex = index;
    }
    return cachedResult[axis];
  };
}

function readVector(parts, index) {
  return [parts[0](index), parts[1](index), parts[2](index)];
}

function buildRotate([vector, axis, angle]) {
  const vectorParts = vectorOperand(vector, 'rotate');
  const axisParts = vectorOperand(axis, 'rotate');
  const angleAt = requireScalar(angle, 'rotate');
  const part = sharedVector(index => rotateAboutAxis(readVector(vectorParts, index), readVector(axisParts, index), angleAt(index)));
  return vectorValue(part(0), part(1), part(2));
}

function buildAlign([direction]) {
  const directionParts = vectorOperand(direction, 'align');
  const part = sharedVector(index => alignEuler(readVector(directionParts, index)));
  return vectorValue(part(0), part(1), part(2));
}

function buildTransform([point, move, euler, size]) {
  const pointParts = vectorOperand(point, 'transform');
  const moveParts = move === undefined ? null : partsOf(move);
  const eulerParts = euler === undefined ? null : vectorOperand(euler, 'transform');
  const sizeParts = size === undefined ? null : partsOf(size);
  const part = sharedVector(index => {
    const scaled = readVector(pointParts, index).map((component, axis) => (sizeParts ? component * sizeParts[axis](index) : component));
    const matrix = eulerParts ? eulerMatrix(readVector(eulerParts, index)) : null;
    const turned = matrix
      ? [0, 1, 2].map(row => matrix[row * 3] * scaled[0] + matrix[row * 3 + 1] * scaled[1] + matrix[row * 3 + 2] * scaled[2])
      : scaled;
    return turned.map((component, axis) => (moveParts ? component + moveParts[axis](index) : component));
  });
  return vectorValue(part(0), part(1), part(2));
}

export const ROTATION_OPERATORS = Object.freeze({
  rotate: { min: 3, max: 3, build: buildRotate },
  align: { min: 1, max: 1, build: buildAlign },
  transform: { min: 1, max: 4, build: buildTransform },
});
