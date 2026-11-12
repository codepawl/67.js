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

const MAXIMUM_FINDING_NODES = 8;
const MAXIMUM_JOB_DIAGNOSTICS = 16;

/** A finding names the parts it concerns in `nodes` and carries its numbers as extra fields. */
function warning(kind, target, message, fix, details = {}) {
  return { kind, severity: 'warning', target, message, fix, ...details };
}

/** At most 8 part names for a finding, with `nodeCount` when more were left out. */
export function namedNodes(names) {
  const nodes = names.slice(0, MAXIMUM_FINDING_NODES);
  return names.length > nodes.length ? { nodes, nodeCount: names.length } : { nodes };
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
  const outside = [];
  const visibleBoxes = boxes.filter(box => {
    const { center, radius } = sphereOf(box);
    const offset = subtract(center, camera.eye);
    const depth = dot(offset, forward);
    if (depth + radius < camera.near || depth - radius > camera.far) {
      outside.push(box.name);
      return false;
    }
    const sideways = (Math.abs(dot(offset, right)) - tangentWide * depth) / wideScale;
    const vertical = (Math.abs(dot(offset, upward)) - tangent * depth) / sideScale;
    const inView = sideways <= radius && vertical <= radius;
    if (!inView) outside.push(box.name);
    return inView;
  });
  const outsideDetails = { ...namedNodes(outside), outsideCount: outside.length, partCount: boxes.length };
  if (visibleBoxes.length * 2 < boxes.length) {
    return [warning('subject-out-of-frame', 'camera',
      `${boxes.length - visibleBoxes.length} of ${boxes.length} parts are outside the camera frustum.`,
      `${framingSuggestion(camera, boxes, tangent)} to put every part in view.`, outsideDetails)];
  }
  const { center, radius } = sphereOf(unionOf(visibleBoxes));
  const depth = dot(subtract(center, camera.eye), forward);
  if (depth > 0 && radius / (depth * tangent) < TINY_SUBJECT_RATIO) {
    return [warning('subject-too-small', 'camera',
      `The visible parts fill under ${Math.round(TINY_SUBJECT_RATIO * 100)} percent of the frame height.`,
      `${framingSuggestion(camera, visibleBoxes, tangent)} to fill the frame, or lower camera.fov.`,
      { heightPercent: Math.round(radius / (depth * tangent) * 100) })];
  }
  if (outside.length > 0) {
    return [warning('part-outside-frame', 'camera',
      `${outside.length} of ${boxes.length} parts are outside the camera frustum, so the picture does not show them.`,
      `Move them into view with scene_apply set-node, or ${framingSuggestion(camera, boxes, tangent)} to put every part in view.`,
      outsideDetails)];
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

function percents(shares) {
  return { blackPercent: Math.round(shares.black * 100), whitePercent: Math.round(shares.white * 100) };
}

/** Warnings for a frame that is nearly all black or has a large clipped area; `exposure` is the current effects.exposure. */
export function exposureProblems({ shares, exposure }) {
  if (shares.black >= BLACK_FRAME_SHARE) {
    return [warning('exposure-black', 'effects.exposure',
      `${Math.round(shares.black * 100)} percent of the frame is black after tone mapping.`,
      `Raise effects.exposure from ${exposure} to ${round(Math.max(exposure, 0.25) * 4)}, raise environment.keyIntensity, or aim a light at the subject.`, percents(shares))];
  }
  if (shares.white >= CLIPPED_FRAME_SHARE) {
    return [warning('exposure-clipped', 'effects.exposure',
      `${Math.round(shares.white * 100)} percent of the frame is clipped to white after tone mapping.`,
      `Lower effects.exposure from ${exposure} to ${round(exposure / 2)}, or lower environment.keyIntensity.`, percents(shares))];
  }
  return [];
}

const FLOATING_GAP = 0.02;
const MINIMUM_PENETRATION = 0.02;
const MAXIMUM_PAIR_PARTS = 256;
const MAXIMUM_PLACEMENT_FINDINGS = 8;

/** Distance between two boxes along each axis; 0 where they touch or overlap on that axis. */
function axisGaps(first, second) {
  return [0, 1, 2].map(axis => Math.max(first.min[axis] - second.max[axis], second.min[axis] - first.max[axis], 0));
}

/** How far two boxes overlap along each axis, or null when they are apart on any axis. */
function axisPenetrations(first, second) {
  const depths = [0, 1, 2].map(axis => Math.min(first.max[axis], second.max[axis]) - Math.max(first.min[axis], second.min[axis]));
  return depths.every(depth => depth > 0) ? depths : null;
}

function droppedCount(total) {
  return total > MAXIMUM_PLACEMENT_FINDINGS ? { droppedCount: total - MAXIMUM_PLACEMENT_FINDINGS } : {};
}

/**
 * Findings about where parts sit, from world bounds ({ name, min, max }, y up): a part with nothing within 2 cm of it
 * that is above the lowest point of the scene (`floating-node`, `gapMeters` to the nearest part or floor), and two
 * parts whose bounds overlap by 2 cm or more on every axis (`intersecting-nodes`, `penetrationMeters`). Bounds are
 * axis aligned, so a rotated part may report an overlap its surface does not have. Each kind lists at most 8 and says
 * how many more there were in `droppedCount`. Scenes of over 256 parts are not checked.
 */
export function placementProblems({ boxes }) {
  if (boxes.length < 1 || boxes.length > MAXIMUM_PAIR_PARTS) return [];
  const floorHeight = Math.min(...boxes.map(box => box.min[1]));
  const floating = [];
  const intersecting = [];
  boxes.forEach((box, index) => {
    let nearest = { gap: box.min[1] - floorHeight, name: 'floor' };
    for (let otherIndex = 0; otherIndex < boxes.length; otherIndex++) {
      if (otherIndex === index) continue;
      const other = boxes[otherIndex];
      const gap = Math.hypot(...axisGaps(box, other));
      if (gap < nearest.gap) nearest = { gap, name: other.name };
      const penetrations = otherIndex > index ? axisPenetrations(box, other) : null;
      if (penetrations && Math.min(...penetrations) >= MINIMUM_PENETRATION) {
        intersecting.push({ nodes: [box.name, other.name], penetrationMeters: round(Math.min(...penetrations)) });
      }
    }
    if (nearest.gap > FLOATING_GAP) floating.push({ node: box.name, gapMeters: round(nearest.gap), nearest: nearest.name });
  });
  const problems = [];
  const floatingWorstFirst = floating.sort((first, second) => second.gapMeters - first.gapMeters);
  for (const entry of floatingWorstFirst.slice(0, MAXIMUM_PLACEMENT_FINDINGS)) {
    problems.push(warning('floating-node', entry.node,
      `${entry.node} touches nothing: it is ${entry.gapMeters} m from ${entry.nearest === 'floor' ? 'the floor level' : entry.nearest}.`,
      'Lower it with scene_apply set-node, or give it a relation that rests it on a part, unless it is meant to fly.',
      { nodes: [entry.node], gapMeters: entry.gapMeters, nearest: entry.nearest, ...droppedCount(floating.length) }));
  }
  const intersectingDeepestFirst = intersecting.sort((first, second) => second.penetrationMeters - first.penetrationMeters);
  for (const entry of intersectingDeepestFirst.slice(0, MAXIMUM_PLACEMENT_FINDINGS)) {
    problems.push(warning('intersecting-nodes', entry.nodes[0],
      `${entry.nodes[0]} and ${entry.nodes[1]} overlap by ${entry.penetrationMeters} m inside their bounds.`,
      'Move one of them apart with scene_apply set-node, or ignore it where the overlap is meant, such as a part sunk into the ground.',
      { nodes: entry.nodes, penetrationMeters: entry.penetrationMeters, ...droppedCount(intersecting.length) }));
  }
  return problems;
}

/** Adds a frame's diagnostics to `metrics.diagnostics`, keeping one entry per kind, target and message across a job's frames, up to 16 entries. */
export function mergeFrameDiagnostics(metrics, frameDiagnostics) {
  if (!frameDiagnostics?.length) return;
  metrics.diagnostics ??= [];
  for (const problem of frameDiagnostics) {
    const known = metrics.diagnostics.some(entry => entry.kind === problem.kind && entry.target === problem.target && entry.message === problem.message);
    if (!known && metrics.diagnostics.length < MAXIMUM_JOB_DIAGNOSTICS) metrics.diagnostics.push(problem);
  }
}
