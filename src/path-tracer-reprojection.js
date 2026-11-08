// Temporal reprojection for the real-time path tracer (issue #624): where a surface point seen now was on screen in the
// previous frame, which of the four neighbouring history pixels may be reused, and the shader text that does the same.
// The camera is the object `createCamera` of path-tracer.js returns (eye, forward, right, above, halfWidth, halfHeight).
// The JavaScript functions are the reference the tests check; the GLSL below repeats them line by line.

export const DEPTH_TOLERANCE = 0.06;
export const NORMAL_AGREEMENT = 0.9;

/** The world direction of the camera ray through a pixel position (pixel centres sit at +0.5). */
export function pixelRayDirection(camera, pixelX, pixelY, width, height) {
  const screenX = (pixelX / width * 2 - 1) * camera.halfWidth;
  const screenY = (1 - pixelY / height * 2) * camera.halfHeight;
  const direction = [0, 1, 2].map(axis => camera.forward[axis] + camera.right[axis] * screenX + camera.above[axis] * screenY);
  const length = Math.hypot(...direction);
  return direction.map(component => component / length);
}

/** The pixel position and the eye distance of a world point in a camera, or null when the point is behind it. */
export function projectToPixel(camera, point, width, height) {
  const offset = [0, 1, 2].map(axis => point[axis] - camera.eye[axis]);
  const dot = vector => offset[0] * vector[0] + offset[1] * vector[1] + offset[2] * vector[2];
  const alongView = dot(camera.forward);
  if (!(alongView > 1e-6)) return null;
  const screenX = dot(camera.right) / alongView / camera.halfWidth;
  const screenY = dot(camera.above) / alongView / camera.halfHeight;
  return { x: (screenX * 0.5 + 0.5) * width, y: (0.5 - screenY * 0.5) * height, distance: Math.hypot(...offset) };
}

/**
 * The motion vector of a pixel, in pixels, from the previous frame to this one: the surface point the pixel sees at
 * `distance` along its ray is projected into the previous camera. Null when it was behind the previous camera.
 * `previous` holds where that point was and how far from the previous eye.
 */
export function motionVector(camera, previousCamera, pixelX, pixelY, distance, width, height) {
  const direction = pixelRayDirection(camera, pixelX, pixelY, width, height);
  const point = [0, 1, 2].map(axis => camera.eye[axis] + direction[axis] * distance);
  const previous = projectToPixel(previousCamera, point, width, height);
  if (!previous) return null;
  return { x: pixelX - previous.x, y: pixelY - previous.y, previous };
}

/** The four history pixels around a position and their bilinear weights (the weights add up to 1). */
export function bilinearTaps(positionX, positionY) {
  const left = Math.floor(positionX - 0.5);
  const top = Math.floor(positionY - 0.5);
  const fractionX = positionX - 0.5 - left;
  const fractionY = positionY - 0.5 - top;
  return [
    { column: left, row: top, weight: (1 - fractionX) * (1 - fractionY) },
    { column: left + 1, row: top, weight: fractionX * (1 - fractionY) },
    { column: left, row: top + 1, weight: (1 - fractionX) * fractionY },
    { column: left + 1, row: top + 1, weight: fractionX * fractionY },
  ];
}

/** Whether a history pixel shows the same surface: its distance within a relative tolerance and its normal close. */
export function isHistoryConsistent({ expectedDistance, historyDistance, normal, historyNormal }) {
  const closeInDepth = Math.abs(historyDistance - expectedDistance) <= DEPTH_TOLERANCE * expectedDistance;
  const normalDot = normal[0] * historyNormal[0] + normal[1] * historyNormal[1] + normal[2] * historyNormal[2];
  return closeInDepth && normalDot >= NORMAL_AGREEMENT;
}

export const REPROJECTION_GLSL = `
uniform vec3 uEye;
uniform vec3 uForward;
uniform vec3 uRight;
uniform vec3 uAbove;
uniform vec2 uHalfSize;
uniform vec3 uPreviousEye;
uniform vec3 uPreviousForward;
uniform vec3 uPreviousRight;
uniform vec3 uPreviousAbove;
uniform vec2 uPreviousHalfSize;
const float DEPTH_TOLERANCE = ${DEPTH_TOLERANCE};
const float NORMAL_AGREEMENT = ${NORMAL_AGREEMENT};

vec3 pixelRayDirection(vec2 pixelPosition, vec2 size) {
  float screenX = (pixelPosition.x / size.x * 2.0 - 1.0) * uHalfSize.x;
  float screenY = (1.0 - pixelPosition.y / size.y * 2.0) * uHalfSize.y;
  return normalize(uForward + uRight * screenX + uAbove * screenY);
}

// The pixel position of a world point in the previous frame; false when it was behind the previous camera.
bool projectToPrevious(vec3 point, vec2 size, out vec2 pixelPosition, out float distanceToEye) {
  vec3 offset = point - uPreviousEye;
  float alongView = dot(offset, uPreviousForward);
  distanceToEye = length(offset);
  pixelPosition = vec2(0.0);
  if (!(alongView > 1e-6)) return false;
  float screenX = dot(offset, uPreviousRight) / alongView / uPreviousHalfSize.x;
  float screenY = dot(offset, uPreviousAbove) / alongView / uPreviousHalfSize.y;
  pixelPosition = vec2(screenX * 0.5 + 0.5, 0.5 - screenY * 0.5) * size;
  return true;
}

bool isHistoryConsistent(float expectedDistance, float historyDistance, vec3 normal, vec3 historyNormal) {
  return abs(historyDistance - expectedDistance) <= DEPTH_TOLERANCE * expectedDistance && dot(normal, historyNormal) >= NORMAL_AGREEMENT;
}
`;

/** Uploads the current and previous camera to a pass that includes REPROJECTION_GLSL (the pass is the one in use). */
export function uploadCameraPair(gl, locate, camera, previousCamera) {
  gl.uniform3fv(locate('uEye'), camera.eye);
  gl.uniform3fv(locate('uForward'), camera.forward);
  gl.uniform3fv(locate('uRight'), camera.right);
  gl.uniform3fv(locate('uAbove'), camera.above);
  gl.uniform2f(locate('uHalfSize'), camera.halfWidth, camera.halfHeight);
  gl.uniform3fv(locate('uPreviousEye'), previousCamera.eye);
  gl.uniform3fv(locate('uPreviousForward'), previousCamera.forward);
  gl.uniform3fv(locate('uPreviousRight'), previousCamera.right);
  gl.uniform3fv(locate('uPreviousAbove'), previousCamera.above);
  gl.uniform2f(locate('uPreviousHalfSize'), previousCamera.halfWidth, previousCamera.halfHeight);
}
