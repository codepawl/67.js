import { compileAnimationSampler, createAnimationClip } from './animation.js';

function cameraTrack(name, property, channel) {
  if (channel && typeof channel === 'object' && !Array.isArray(channel) && !ArrayBuffer.isView(channel)) {
    return { ...channel, target: name, property };
  }
  return { target: name, property, keyframes: [{ time: 0, value: channel }] };
}

function validateVector(vector, name) {
  if ((!Array.isArray(vector) && !ArrayBuffer.isView(vector)) || vector.length !== 3) {
    throw new TypeError(`${name} must contain three finite components.`);
  }
  for (const component of vector) {
    if (!Number.isFinite(component)) throw new RangeError(`${name} must contain three finite components.`);
  }
}

function validatePose(eye, target, up) {
  validateVector(eye, 'Camera eye');
  validateVector(target, 'Camera target');
  validateVector(up, 'Camera up');
  const horizontal = target[0] - eye[0];
  const vertical = target[1] - eye[1];
  const depth = target[2] - eye[2];
  const distance = Math.hypot(horizontal, vertical, depth);
  const upLength = Math.hypot(...up);
  if (!Number.isFinite(distance) || distance <= 1e-8 || !Number.isFinite(upLength) || upLength <= 1e-8) {
    throw new RangeError('Camera eye and target must be distinct, with a nonzero up vector.');
  }
  const alignment = Math.abs((horizontal / distance * (up[0] / upLength)) + (vertical / distance * (up[1] / upLength)) + (depth / distance * (up[2] / upLength)));
  if (!Number.isFinite(alignment) || alignment >= 1 - 1e-10) {
    throw new RangeError('Camera up must not be parallel to the viewing direction.');
  }
}

function validateLens(fov, near, far) {
  if (!Number.isFinite(fov) || fov <= 0 || fov >= 180) {
    throw new RangeError('Camera field of view must be between 0 and 180 degrees.');
  }
  if (!Number.isFinite(near) || !Number.isFinite(far) || near <= 0 || far <= near) {
    throw new RangeError('Camera clipping planes must satisfy 0 < near < far.');
  }
}

function validateWritableField(object, property) {
  const ownDescriptor = Object.getOwnPropertyDescriptor(object, property);
  let descriptor = ownDescriptor;
  let prototype = Object.getPrototypeOf(object);
  while (!descriptor && prototype !== null) {
    descriptor = Object.getOwnPropertyDescriptor(prototype, property);
    prototype = Object.getPrototypeOf(prototype);
  }
  if ((descriptor && (!('value' in descriptor) || !descriptor.writable)) || (!ownDescriptor && !Object.isExtensible(object))) {
    throw new TypeError('Camera output fields must be writable data properties.');
  }
}

function transformTarget(target, matrix) {
  if ((!Array.isArray(matrix) && !ArrayBuffer.isView(matrix)) || matrix.length !== 16 || !Array.from(matrix).every(Number.isFinite)) {
    throw new TypeError('Tracking requires a finite affine target matrix.');
  }
  if (matrix[3] !== 0 || matrix[7] !== 0 || matrix[11] !== 0 || matrix[15] !== 1) {
    throw new RangeError('Tracking requires an affine target matrix.');
  }
  const horizontal = target[0];
  const vertical = target[1];
  const depth = target[2];
  for (let axis = 0; axis < 3; axis++) {
    target[axis] = matrix[axis] * horizontal + matrix[axis + 4] * vertical + matrix[axis + 8] * depth + matrix[axis + 12];
  }
}

/** Vertical field of view in degrees; focal length and sensor height use the same unit. */
export function fovFromFocalLength(focalLength, { sensorHeight = 24 } = {}) {
  if (!Number.isFinite(focalLength) || focalLength <= 0 || !Number.isFinite(sensorHeight) || sensorHeight <= 0) {
    throw new RangeError('Focal length and sensor height must be positive and finite.');
  }
  const fov = 2 * Math.atan(sensorHeight / focalLength / 2) * 180 / Math.PI;
  validateLens(fov, 0.1, 100);
  return fov;
}

// A driver replaces single components after the tracks: `overrides.eye[1]` is a number, or undefined to keep the track.
function applyVectorOverrides(vector, components) {
  if (!components) return;
  for (let axis = 0; axis < 3; axis++) {
    if (components[axis] !== undefined) vector[axis] = components[axis];
  }
}

/** Absolute-time camera channels reuse the same interpolation as animation clips. */
export function createCameraPath({ duration, loop = false, eye, target = [0, 0, 0], fov = 45, roll = 0, up = [0, 1, 0], near = 0.1, far = 100 } = {}) {
  validateVector(up, 'Camera up');
  validateLens(45, near, far);
  if (Math.hypot(...up) <= 1e-8) throw new RangeError('Camera up must be nonzero.');
  const baseUp = Object.freeze(Array.from(up));
  const upLength = Math.hypot(...baseUp);
  const normalizedUp = baseUp.map(component => component / upLength);
  const clip = createAnimationClip({ duration, loop, tracks: [
    cameraTrack('eye', 'translation', eye),
    cameraTrack('target', 'translation', target),
    cameraTrack('fov', 'value', fov),
    cameraTrack('roll', 'value', roll),
  ] });
  for (const keyframe of clip.tracks[2].keyframes) validateLens(keyframe.value, near, far);
  const sampler = compileAnimationSampler(clip);
  const stagedEye = new Float64Array(3);
  const stagedTarget = new Float64Array(3);
  const stagedUp = new Float64Array(3);
  const direction = new Float64Array(3);

  function sample(time, output = { eye: [0, 0, 0], target: [0, 0, 0], up: [0, 0, 0] }, { targetMatrix, overrides } = {}) {
    const destinations = [output.eye, output.target, output.up];
    for (const destination of destinations) {
      if (!(Array.isArray(destination) || destination instanceof Float32Array || destination instanceof Float64Array) || destination.length !== 3) {
        throw new TypeError('Camera output needs writable three-component eye, target and up arrays.');
      }
      if (Object.isFrozen(destination)) throw new TypeError('Camera output arrays must be writable.');
      if (Array.isArray(destination)) {
        for (let axis = 0; axis < 3; axis++) {
          validateWritableField(destination, axis);
        }
      }
    }
    if (new Set(destinations).size !== 3 || Object.isFrozen(output)) {
      throw new TypeError('Camera output must be writable and its vectors must be distinct.');
    }
    for (let first = 0; first < destinations.length; first++) {
      for (let second = first + 1; second < destinations.length; second++) {
        const left = destinations[first];
        const right = destinations[second];
        if (ArrayBuffer.isView(left) && ArrayBuffer.isView(right) && left.buffer === right.buffer &&
          left.byteOffset < right.byteOffset + right.byteLength && right.byteOffset < left.byteOffset + left.byteLength) {
          throw new TypeError('Camera output vectors must not overlap in memory.');
        }
      }
    }
    for (const property of ['fov', 'near', 'far', 'projection']) {
      validateWritableField(output, property);
    }
    const tracks = sampler.sample(time);
    stagedEye.set(tracks[0].output);
    stagedTarget.set(tracks[1].output);
    applyVectorOverrides(stagedEye, overrides?.eye);
    applyVectorOverrides(stagedTarget, overrides?.target);
    if (targetMatrix !== undefined) transformTarget(stagedTarget, targetMatrix);
    validatePose(stagedEye, stagedTarget, baseUp);
    const fieldOfView = overrides?.fov ?? tracks[2].output[0];
    validateLens(fieldOfView, near, far);
    const angle = overrides?.roll ?? tracks[3].output[0];
    const directionLength = Math.hypot(stagedTarget[0] - stagedEye[0], stagedTarget[1] - stagedEye[1], stagedTarget[2] - stagedEye[2]);
    for (let axis = 0; axis < 3; axis++) direction[axis] = (stagedTarget[axis] - stagedEye[axis]) / directionLength;
    const cosine = Math.cos(angle);
    const sine = Math.sin(angle);
    const dot = direction[0] * normalizedUp[0] + direction[1] * normalizedUp[1] + direction[2] * normalizedUp[2];
    for (let axis = 0; axis < 3; axis++) {
      const next = (axis + 1) % 3;
      const last = (axis + 2) % 3;
      const cross = direction[next] * normalizedUp[last] - direction[last] * normalizedUp[next];
      stagedUp[axis] = normalizedUp[axis] * cosine + cross * sine + direction[axis] * dot * (1 - cosine);
    }
    const stagedVectors = [stagedEye, stagedTarget, stagedUp];
    for (let index = 0; index < destinations.length; index++) {
      if (destinations[index] instanceof Float32Array) {
        for (let axis = 0; axis < 3; axis++) stagedVectors[index][axis] = Math.fround(stagedVectors[index][axis]);
      }
    }
    validatePose(stagedEye, stagedTarget, stagedUp);
    for (let index = 0; index < destinations.length; index++) {
      for (let axis = 0; axis < 3; axis++) destinations[index][axis] = stagedVectors[index][axis];
    }
    output.fov = fieldOfView;
    output.near = near;
    output.far = far;
    output.projection = 'perspective';
    return output;
  }

  sample(0);
  return Object.freeze({ duration: clip.duration, loop: clip.loop, clip, sample });
}
