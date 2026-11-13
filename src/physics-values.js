// Checks and a vector rotation shared by the floating-body code (physics-buoyancy.js, physics-boat.js).

export function rejectUnknownKeys(value, allowed, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object like { ${allowed[0]}: 1 }`);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new TypeError(`${label}.${key} is unsupported; use one of ${allowed.join(', ')}`);
  }
}

export function boundedNumber(value, label, minimum, maximum, example, exclusiveMinimum = false) {
  const belowMinimum = exclusiveMinimum ? value <= minimum : value < minimum;
  if (typeof value !== 'number' || !Number.isFinite(value) || belowMinimum || value > maximum) {
    throw new RangeError(`${label} must be a number ${exclusiveMinimum ? 'above' : 'from'} ${minimum} to ${maximum}, such as ${example}`);
  }
  return value;
}

export function boundedInteger(value, label, minimum, maximum, example) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${label} must be an integer from ${minimum} to ${maximum}, such as ${example}`);
  }
  return value;
}

/** Rotate [x, y, z] by a unit quaternion { x, y, z, w }. */
export function rotateByQuaternion(point, rotation) {
  const [pointX, pointY, pointZ] = point;
  const { x, y, z, w } = rotation;
  const crossX = 2 * (y * pointZ - z * pointY);
  const crossY = 2 * (z * pointX - x * pointZ);
  const crossZ = 2 * (x * pointY - y * pointX);
  return [
    pointX + w * crossX + (y * crossZ - z * crossY),
    pointY + w * crossY + (z * crossX - x * crossZ),
    pointZ + w * crossZ + (x * crossY - y * crossX),
  ];
}
