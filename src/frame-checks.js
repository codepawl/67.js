/**
 * Cheap checks on a frame that renders without error but shows nothing useful: an empty frame, a subject out of frame
 * or too small, and clipped or black exposure. They use the shape of `agent-diagnostics.js` (kind, severity, target,
 * message, fix); each fix names a field and a value to try. Framing is sphere-against-frustum math on part bounds and
 * exposure reads a 64 by 64 copy of the frame. The stale bake check lives in `agent-bake.js`, which loads with a bake.
 */
const TINY_SUBJECT_RATIO = 0.05;
const BLACK_LUMA = 5 / 255;
const WHITE_LUMA = 250 / 255;
const BLACK_FRAME_SHARE = 0.98;
const CLIPPED_FRAME_SHARE = 0.35;

function warning(kind, target, message, fix) {
  return { kind, severity: 'warning', target, message, fix };
}

function subtract(first, second) {
  return [first[0] - second[0], first[1] - second[1], first[2] - second[2]];
}

function dot(first, second) {
  return first[0] * second[0] + first[1] * second[1] + first[2] * second[2];
}

function cross(first, second) {
  return [first[1] * second[2] - first[2] * second[1], first[2] * second[0] - first[0] * second[2], first[0] * second[1] - first[1] * second[0]];
}

function normalize(vector) {
  const length = Math.hypot(...vector) || 1;
  return vector.map(component => component / length);
}

function round(value) {
  return Math.round(value * 100) / 100;
}

/** Half the vertical field of view as a tangent, or null for a camera these checks do not model. */
function halfHeightTangent(camera, aspect) {
  if (camera.projection === 'orthographic' || camera.shift) return null;
  if (Number.isFinite(camera.fov)) return Math.tan(camera.fov * Math.PI / 360);
  if (Number.isFinite(camera.focalLength)) return (camera.sensorWidth ?? 36) / aspect / 2 / camera.focalLength;
  return null;
}

function sphereOf(box) {
  const center = [0, 1, 2].map(axis => (box.min[axis] + box.max[axis]) / 2);
  return { center, radius: Math.hypot(...subtract(box.max, center)) };
}

function unionOf(boxes) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const box of boxes) {
    for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis], box.min[axis]);
      max[axis] = Math.max(max[axis], box.max[axis]);
    }
  }
  return { min, max };
}

/** A camera that keeps the viewing direction, aims at the middle of the boxes and backs off until they fit. */
function framingSuggestion(camera, boxes, tangent) {
  const { center, radius } = sphereOf(unionOf(boxes));
  const direction = normalize(subtract(camera.eye, camera.target));
  const distance = Math.max(radius / tangent * 1.15, camera.near * 2);
  const eye = center.map((value, axis) => value + direction[axis] * distance);
  return `Set camera.target to [${center.map(round)}] and camera.eye to [${eye.map(round)}]`;
}

/**
 * Warnings for where the camera points. `boxes` are world bounds ({ min, max }) of the visible parts; a camera that is
 * orthographic or shifted gets none, because the frustum test below assumes a centered perspective view.
 */
export function framingProblems({ camera, aspect, boxes }) {
  const tangent = halfHeightTangent(camera, aspect);
  if (!tangent) return [];
  if (boxes.length === 0) {
    return [warning('empty-frame', 'nodes', 'The scene has no visible parts, so the frame shows only the background.',
      'Add a mesh node with scene_apply add-node (and add-geometry, add-material), or set visible: true on a hidden node.')];
  }
  const tangentWide = tangent * aspect;
  const forward = normalize(subtract(camera.target, camera.eye));
  const right = normalize(cross(forward, camera.up));
  const upward = cross(right, forward);
  const sideScale = Math.sqrt(1 + tangent * tangent);
  const wideScale = Math.sqrt(1 + tangentWide * tangentWide);
  const visibleBoxes = boxes.filter(box => {
    const { center, radius } = sphereOf(box);
    const offset = subtract(center, camera.eye);
    const depth = dot(offset, forward);
    if (depth + radius < camera.near || depth - radius > camera.far) return false;
    const sideways = (Math.abs(dot(offset, right)) - tangentWide * depth) / wideScale;
    const vertical = (Math.abs(dot(offset, upward)) - tangent * depth) / sideScale;
    return sideways <= radius && vertical <= radius;
  });
  if (visibleBoxes.length * 2 < boxes.length) {
    return [warning('subject-out-of-frame', 'camera',
      `${boxes.length - visibleBoxes.length} of ${boxes.length} parts are outside the camera frustum.`,
      `${framingSuggestion(camera, boxes, tangent)} to put every part in view.`)];
  }
  const { center, radius } = sphereOf(unionOf(visibleBoxes));
  const depth = dot(subtract(center, camera.eye), forward);
  if (depth > 0 && radius / (depth * tangent) < TINY_SUBJECT_RATIO) {
    return [warning('subject-too-small', 'camera',
      `The visible parts fill under ${Math.round(TINY_SUBJECT_RATIO * 100)} percent of the frame height.`,
      `${framingSuggestion(camera, visibleBoxes, tangent)} to fill the frame, or lower camera.fov.`)];
  }
  return [];
}

/** The share of pixels near black and near white in RGBA bytes, by Rec. 709 luma. */
export function lumaShares(rgba) {
  let black = 0;
  let white = 0;
  const pixels = rgba.length / 4;
  for (let offset = 0; offset < rgba.length; offset += 4) {
    const luma = (0.2126 * rgba[offset] + 0.7152 * rgba[offset + 1] + 0.0722 * rgba[offset + 2]) / 255;
    if (luma <= BLACK_LUMA) black++;
    else if (luma >= WHITE_LUMA) white++;
  }
  return { black: black / pixels, white: white / pixels };
}

/** Warnings for a frame that is nearly all black or has a large clipped area; `exposure` is the current effects.exposure. */
export function exposureProblems({ shares, exposure }) {
  if (shares.black >= BLACK_FRAME_SHARE) {
    return [warning('exposure-black', 'effects.exposure',
      `${Math.round(shares.black * 100)} percent of the frame is black after tone mapping.`,
      `Raise effects.exposure from ${exposure} to ${round(Math.max(exposure, 0.25) * 4)}, raise environment.keyIntensity, or aim a light at the subject.`)];
  }
  if (shares.white >= CLIPPED_FRAME_SHARE) {
    return [warning('exposure-clipped', 'effects.exposure',
      `${Math.round(shares.white * 100)} percent of the frame is clipped to white after tone mapping.`,
      `Lower effects.exposure from ${exposure} to ${round(exposure / 2)}, or lower environment.keyIntensity.`)];
  }
  return [];
}

/** Adds a frame's diagnostics to `metrics.diagnostics`, keeping one entry per kind, target and message across a job's frames. */
export function mergeFrameDiagnostics(metrics, frameDiagnostics) {
  if (!frameDiagnostics?.length) return;
  metrics.diagnostics ??= [];
  for (const problem of frameDiagnostics) {
    const known = metrics.diagnostics.some(entry => entry.kind === problem.kind && entry.target === problem.target && entry.message === problem.message);
    if (!known) metrics.diagnostics.push(problem);
  }
}
