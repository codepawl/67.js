// Temporal accumulation for the frames of a native video job (issue 1120). Every path traced frame carries fresh noise, and
// a denoiser turns what is left of it into soft blotches that change from frame to frame, so a film shimmers even when each
// still looks clean. Here each pixel of a new frame finds where its surface point was in the frame before (the first-hit
// distance and the two cameras give that), and the traced light is blended into the light gathered there so far, before the
// denoiser runs. A pixel whose surface was hidden, off screen or another surface in the frame before starts again, and so
// does the whole image when anything but the camera changed.
//
// It assumes a still scene under a moving camera. Light that depends on the view (a sharp reflection, a highlight, what is
// seen through glass) is carried along with the surface, so it trails the camera by a few frames.

const KERNEL_PARAMS_BYTES = 320;
const SEED_BYTES = [28, 32];
const KERNEL_FLAGS_BYTE = 32;
const ORTHOGRAPHIC_CAMERA_FLAG = 8;
const CAMERA_BYTES = [112, 192];
const TILE_ORIGIN_BYTES = [312, 320];
const CAMERA_POSITION_BYTE = 112;
const CAMERA_FORWARD_BYTE = 128;
const CAMERA_RIGHT_BYTE = 144;
const CAMERA_UP_BYTE = 160;
const LENS_SHIFT_BYTE = 176;

export const TEMPORAL_DEFAULTS = Object.freeze({
  // The share of a new frame in a pixel with a long history: a pixel never averages more than 1 / minimumWeight frames.
  minimumWeight: 0.1,
  // A history texel belongs to the same surface when its distance is within this share of the expected one.
  depthTolerance: 0.04,
  // ... and when its normal is within about 26 degrees of the pixel's.
  normalAgreement: 0.9,
  // Below this much bilinear weight from texels of the same surface, the pixel starts again.
  minimumFetchWeight: 0.3,
});

function requirePlane(plane, name, floatsPerPixel, pixelCount) {
  if (!(plane instanceof Float32Array) || plane.length !== pixelCount * floatsPerPixel) {
    const got = plane instanceof Float32Array ? `a Float32Array of ${plane.length}` : typeof plane;
    throw new TypeError(`temporal accumulate: \`${name}\` must be a Float32Array of ${pixelCount * floatsPerPixel} floats (${floatsPerPixel} per pixel), got ${got}.`);
  }
}

function requireKernelParams(kernelParams) {
  if (!(kernelParams instanceof Uint8Array) || kernelParams.length !== KERNEL_PARAMS_BYTES) {
    throw new TypeError(`temporal accumulate: \`kernelParams\` must be the ${KERNEL_PARAMS_BYTES} byte FORMAT-v2 block of the frame (a Uint8Array).`);
  }
}

function readVector(view, byteOffset) {
  return [view.getFloat32(byteOffset, true), view.getFloat32(byteOffset + 4, true), view.getFloat32(byteOffset + 8, true)];
}

function squaredLength(vector) {
  return vector[0] * vector[0] + vector[1] * vector[1] + vector[2] * vector[2];
}

/** The camera of a FORMAT-v2 kernel parameter block, as the kernel's camera ray reads it. */
export function readCameraView(kernelParams) {
  requireKernelParams(kernelParams);
  const view = new DataView(kernelParams.buffer, kernelParams.byteOffset, kernelParams.byteLength);
  const right = readVector(view, CAMERA_RIGHT_BYTE);
  const up = readVector(view, CAMERA_UP_BYTE);
  return {
    position: readVector(view, CAMERA_POSITION_BYTE),
    forward: readVector(view, CAMERA_FORWARD_BYTE),
    right,
    up,
    rightSquaredLength: squaredLength(right),
    upSquaredLength: squaredLength(up),
    lensShift: [view.getFloat32(LENS_SHIFT_BYTE, true), view.getFloat32(LENS_SHIFT_BYTE + 4, true)],
    orthographic: (view.getUint32(KERNEL_FLAGS_BYTE, true) & ORTHOGRAPHIC_CAMERA_FLAG) !== 0,
  };
}

function insideRange(byteOffset, range) {
  return byteOffset >= range[0] && byteOffset < range[1];
}

/**
 * True when two kernel parameter blocks differ in nothing but the camera, the seed and the tile origin the host writes: the
 * frames then show the same scene under the same light and render settings.
 */
export function onlyCameraDiffers(firstParams, secondParams) {
  requireKernelParams(firstParams);
  requireKernelParams(secondParams);
  for (let byteOffset = 0; byteOffset < KERNEL_PARAMS_BYTES; byteOffset++) {
    if (insideRange(byteOffset, SEED_BYTES) || insideRange(byteOffset, CAMERA_BYTES) || insideRange(byteOffset, TILE_ORIGIN_BYTES)) {
      continue;
    }
    const mask = byteOffset === KERNEL_FLAGS_BYTE ? 0xff & ~ORTHOGRAPHIC_CAMERA_FLAG : 0xff;
    if ((firstParams[byteOffset] & mask) !== (secondParams[byteOffset] & mask)) {
      return false;
    }
  }
  return true;
}

function validateShare(value, name) {
  if (typeof value !== 'number' || !(value > 0 && value <= 1)) {
    throw new RangeError(`createTemporalAccumulator: \`${name}\` must be a number above 0 and at most 1, got ${JSON.stringify(value)}.`);
  }
}

/**
 * Holds the history of one job. `accumulate` takes the planes of a traced frame and returns the colour to denoise.
 *
 * @param {{ width: number, height: number, minimumWeight?: number, depthTolerance?: number, normalAgreement?: number, minimumFetchWeight?: number }} options
 */
export function createTemporalAccumulator(options = {}) {
  const { width, height } = options;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new RangeError(`createTemporalAccumulator: \`width\` and \`height\` must be whole numbers of at least 1, got ${JSON.stringify(width)} x ${JSON.stringify(height)}.`);
  }
  const settings = { ...TEMPORAL_DEFAULTS };
  for (const name of Object.keys(TEMPORAL_DEFAULTS)) {
    if (options[name] !== undefined) {
      validateShare(options[name], name);
      settings[name] = options[name];
    }
  }
  const pixelCount = width * height;
  let history = null;
  let pendingRestartReason = 'the first frame of the job';

  function restart(reason) {
    history = null;
    pendingRestartReason = reason;
  }

  function reasonToRestart(kernelParams, sceneChanged, camera) {
    if (history === null) {
      return pendingRestartReason;
    }
    if (sceneChanged) {
      return 'the scene changed since the frame before';
    }
    if (camera.orthographic || history.camera.orthographic) {
      return 'an orthographic camera is not reprojected';
    }
    if (!onlyCameraDiffers(history.kernelParams, kernelParams)) {
      return 'the light or the render settings changed since the frame before';
    }
    return null;
  }

  /**
   * @param {{ color: Float32Array, depth: Float32Array, normal: Float32Array, kernelParams: Uint8Array, sceneChanged?: boolean }} frame
   *   `color` and `normal` hold three floats per pixel (the normal is unit length, or zero where no surface was hit),
   *   `depth` one: the distance along the camera ray to the first surface, 0 for a miss. `kernelParams` is the block the
   *   frame was traced with. `sceneChanged` says a table other than the kernel parameters differs from the frame before.
   *   The accumulator keeps `depth` and `normal` (and the colour it returns) until the next frame: do not write to them.
   * @returns {{ color: Float32Array, historyShare: number, restarted: string | null }} `color` is a new buffer;
   *   `historyShare` is the share of pixels that found their surface in the frame before; `restarted` says why the whole
   *   image started again, or null.
   */
  function accumulate({ color, depth, normal, kernelParams, sceneChanged = false }) {
    requirePlane(color, 'color', 3, pixelCount);
    requirePlane(depth, 'depth', 1, pixelCount);
    requirePlane(normal, 'normal', 3, pixelCount);
    const camera = readCameraView(kernelParams);
    const restarted = reasonToRestart(kernelParams, sceneChanged, camera);
    const blended = new Float32Array(pixelCount * 3);
    const counts = new Float32Array(pixelCount);
    let pixelsWithHistory = 0;
    if (restarted !== null) {
      blended.set(color);
      counts.fill(1);
    } else {
      pixelsWithHistory = blendWithHistory({ color, depth, normal, camera, blended, counts });
    }
    history = { color: blended, depth, normal, counts, camera, kernelParams: Uint8Array.from(kernelParams) };
    pendingRestartReason = null;
    return { color: blended, historyShare: pixelsWithHistory / pixelCount, restarted };
  }

  // Writes `blended` and `counts`, and returns how many pixels found their surface in the history.
  function blendWithHistory({ color, depth, normal, camera, blended, counts }) {
    const past = history;
    const pastCamera = past.camera;
    const { position, forward, right, up, lensShift } = camera;
    let pixelsWithHistory = 0;
    for (let y = 0; y < height; y++) {
      const sensorY = 1 - ((y + 0.5) / height) * 2 + 2 * lensShift[1];
      for (let x = 0; x < width; x++) {
        const pixel = y * width + x;
        const colorIndex = pixel * 3;
        const distance = depth[pixel];
        let pastRed = 0;
        let pastGreen = 0;
        let pastBlue = 0;
        let pastCount = 0;
        let fetchWeight = 0;
        if (distance > 0) {
          const sensorX = ((x + 0.5) / width) * 2 - 1 + 2 * lensShift[0];
          let directionX = forward[0] + right[0] * sensorX + up[0] * sensorY;
          let directionY = forward[1] + right[1] * sensorX + up[1] * sensorY;
          let directionZ = forward[2] + right[2] * sensorX + up[2] * sensorY;
          const directionScale = distance / Math.hypot(directionX, directionY, directionZ);
          directionX *= directionScale;
          directionY *= directionScale;
          directionZ *= directionScale;
          const offsetX = position[0] + directionX - pastCamera.position[0];
          const offsetY = position[1] + directionY - pastCamera.position[1];
          const offsetZ = position[2] + directionZ - pastCamera.position[2];
          const along = offsetX * pastCamera.forward[0] + offsetY * pastCamera.forward[1] + offsetZ * pastCamera.forward[2];
          if (along > 1e-4) {
            const pastSensorX = (offsetX * pastCamera.right[0] + offsetY * pastCamera.right[1] + offsetZ * pastCamera.right[2]) / (along * pastCamera.rightSquaredLength);
            const pastSensorY = (offsetX * pastCamera.up[0] + offsetY * pastCamera.up[1] + offsetZ * pastCamera.up[2]) / (along * pastCamera.upSquaredLength);
            const sourceX = ((pastSensorX - 2 * pastCamera.lensShift[0] + 1) / 2) * width - 0.5;
            const sourceY = ((1 - pastSensorY + 2 * pastCamera.lensShift[1]) / 2) * height - 0.5;
            const left = Math.floor(sourceX);
            const top = Math.floor(sourceY);
            // On screen up to the outer edge of the border pixels; a corner past the border reads the border texel.
            if (sourceX >= -0.5 && sourceY >= -0.5 && sourceX <= width - 0.5 && sourceY <= height - 0.5) {
              const expectedDistance = Math.hypot(offsetX, offsetY, offsetZ);
              const allowedDifference = settings.depthTolerance * expectedDistance;
              const fractionX = sourceX - left;
              const fractionY = sourceY - top;
              const normalX = normal[colorIndex];
              const normalY = normal[colorIndex + 1];
              const normalZ = normal[colorIndex + 2];
              // A bilinear fetch that leaves out the texels of another surface.
              for (let corner = 0; corner < 4; corner++) {
                const cornerX = corner & 1;
                const cornerY = corner >> 1;
                const weight = (cornerX === 1 ? fractionX : 1 - fractionX) * (cornerY === 1 ? fractionY : 1 - fractionY);
                const sourceColumn = Math.min(width - 1, Math.max(0, left + cornerX));
                const sourceRow = Math.min(height - 1, Math.max(0, top + cornerY));
                const source = sourceRow * width + sourceColumn;
                if (Math.abs(past.depth[source] - expectedDistance) > allowedDifference) {
                  continue;
                }
                const sourceIndex = source * 3;
                const agreement = normalX * past.normal[sourceIndex] + normalY * past.normal[sourceIndex + 1] + normalZ * past.normal[sourceIndex + 2];
                if (agreement < settings.normalAgreement) {
                  continue;
                }
                pastRed += past.color[sourceIndex] * weight;
                pastGreen += past.color[sourceIndex + 1] * weight;
                pastBlue += past.color[sourceIndex + 2] * weight;
                pastCount += past.counts[source] * weight;
                fetchWeight += weight;
              }
            }
          }
        }
        if (fetchWeight > settings.minimumFetchWeight) {
          const count = pastCount / fetchWeight + 1;
          const share = Math.max(1 / count, settings.minimumWeight);
          const kept = (1 - share) / fetchWeight;
          blended[colorIndex] = pastRed * kept + color[colorIndex] * share;
          blended[colorIndex + 1] = pastGreen * kept + color[colorIndex + 1] * share;
          blended[colorIndex + 2] = pastBlue * kept + color[colorIndex + 2] * share;
          counts[pixel] = count;
          pixelsWithHistory += 1;
        } else {
          blended[colorIndex] = color[colorIndex];
          blended[colorIndex + 1] = color[colorIndex + 1];
          blended[colorIndex + 2] = color[colorIndex + 2];
          counts[pixel] = 1;
        }
      }
    }
    return pixelsWithHistory;
  }

  return { accumulate, restart };
}

/** Whether a native video job blends its frames over time: on unless JS67_NATIVE_TEMPORAL=off. */
export function chooseNativeTemporal(environment = process.env) {
  return environment.JS67_NATIVE_TEMPORAL !== 'off';
}

/** The seed of one frame of a job that accumulates over time: every frame needs its own noise for the blend to remove any. */
export function temporalFrameSeed(seed, frame) {
  return ((seed ?? 0) + frame) >>> 0;
}
