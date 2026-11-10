// The jelly cube of the soft body film: a rounded cube 0.5 m across dropped from 1.95 m above the floor, baked through
// the agent scene so a test measures what a render job would show.
import { createHash } from 'node:crypto';
import './load-agent-scene-modules.mjs';
import { createAgentScene } from '../../src/agent-scene.js';

export const JELLY_FRAMES_PER_SECOND = 60;
const FLOOR_THICKNESS = 0.01;
const LIFT_OFF_HEIGHT = 0.02;

/** The recipe for one jelly cube; `softBody` and `sheet` override the film's softBody fields and sheet fields. */
export function jellyCubeRecipe({ softBody = {}, sheet = {}, x = 0, duration = 2 } = {}) {
  return {
    format: '67js.scene', schemaVersion: 1,
    geometries: [{ id: 'jelly', type: 'box', bevel: 0.12, subdivisions: 3 }, { id: 'floor', type: 'box', bevel: 0 }],
    materials: [{ id: 'gel', color: [0.25, 0.85, 0.45] }, { id: 'stone', color: [0.55, 0.55, 0.58] }],
    nodes: [
      { id: 'cube', geometry: 'jelly', material: 'gel', translation: [x, 2.2, 0], scale: [0.5, 0.5, 0.5] },
      { id: 'clock' },
      { id: 'ground', geometry: 'floor', material: 'stone', translation: [0, -0.5, 0], scale: [8, 1, 8] },
    ],
    camera: { fov: 34, eye: [0.45, 0.22, 1.75], target: [0, 0.3, 0] },
    motion: { duration, loop: false, tracks: [{ kind: 'node', id: 'clock', property: 'translation', interpolation: 'LINEAR', keyframes: [{ time: 0, value: [0, 0, 0] }, { time: duration, value: [0, 0, 0] }] }] },
    cloth: {
      duration,
      sheets: [{ node: 'cube', softBody: { shape: 0.15, pressure: 1, ...softBody }, stiffness: 0.9, bend: 0, damping: 2, ...sheet }],
      colliders: [{ node: 'ground', shape: 'box' }],
    },
  };
}

/** World-space vertices of every frame of the cube, at 60 frames a second. */
export function recordJelly(recipe, frameCount) {
  const node = recipe.nodes.find(candidate => candidate.id === 'cube');
  const scene = createAgentScene(recipe);
  const frames = [];
  for (let frame = 0; frame < frameCount; frame++) {
    scene.sampleMotion(frame / JELLY_FRAMES_PER_SECOND);
    const local = scene.parts.find(part => part.name === 'cube').geometry.positions;
    const world = new Float32Array(local.length);
    for (let index = 0; index < local.length; index++) world[index] = local[index] * node.scale[index % 3] + node.translation[index % 3];
    frames.push(world);
  }
  return frames;
}

export function frameHashes(frames) {
  return frames.map(frame => createHash('sha256').update(Buffer.from(frame.buffer)).digest('hex'));
}

function verticalRange(frame) {
  let low = Infinity;
  let high = -Infinity;
  for (let index = 1; index < frame.length; index += 3) {
    low = Math.min(low, frame[index]);
    high = Math.max(high, frame[index]);
  }
  return { low, extent: high - low };
}

/**
 * First contact, the deepest dent after it and the top of the first rebound. Rebound height is how far the lowest
 * vertex rises above the floor before the body falls back; the dent is the rest height minus the shortest height.
 */
export function measureBounce(frames) {
  const ranges = frames.map(verticalRange);
  const restHeight = ranges[0].extent;
  const contact = ranges.findIndex(range => range.low <= FLOOR_THICKNESS + 1e-3);
  if (contact === -1) throw new Error(`measureBounce: the body never reached the floor in ${frames.length} frames.`);
  let liftOff = contact + 1;
  while (liftOff < frames.length && ranges[liftOff].low <= FLOOR_THICKNESS + LIFT_OFF_HEIGHT) liftOff++;
  let deepestFrame = contact;
  for (let frame = contact; frame < Math.min(liftOff, frames.length); frame++) {
    if (ranges[frame].extent < ranges[deepestFrame].extent) deepestFrame = frame;
  }
  let topFrame = liftOff;
  while (topFrame + 1 < frames.length && ranges[topFrame + 1].low >= ranges[topFrame].low) topFrame++;
  const reboundHeight = liftOff >= frames.length ? 0 : ranges[topFrame].low - FLOOR_THICKNESS;
  return { restHeight, contact, deepestFrame, topFrame: Math.min(topFrame, frames.length - 1), dent: restHeight - ranges[deepestFrame].extent, reboundHeight };
}

/**
 * The three jellies of the preview, from firm to soft. The soft one keeps `shape` at 0.15: below about 0.1 the surface
 * folds over itself on impact (see `foldedTriangles`), which is how a deeper dent was paid for before.
 */
export const JELLY_PRESETS = [
  { id: 'firm', colorName: 'blue', softBody: { shape: 1, bounce: 0 }, sheet: {} },
  { id: 'medium', colorName: 'amber', softBody: { shape: 0.3, bounce: 0.6 }, sheet: { stiffness: 0.2 } },
  { id: 'soft', colorName: 'pink', softBody: { shape: 0.15, bounce: 1 }, sheet: { stiffness: 0.05 } },
];

/**
 * Most triangles facing toward the body's centre in any one frame. A closed convex-ish jelly keeps every triangle facing
 * out, so a count above zero means the surface folded over itself (a fold shows as ragged doubled edges).
 */
export function foldedTriangles(recipe, frameCount) {
  const scene = createAgentScene(recipe);
  let worst = 0;
  for (let frame = 0; frame < frameCount; frame++) {
    scene.sampleMotion(frame / JELLY_FRAMES_PER_SECOND);
    const { positions, indices } = scene.parts.find(part => part.name === 'cube').geometry;
    const center = [0, 0, 0];
    for (let index = 0; index < positions.length; index++) center[index % 3] += positions[index] / (positions.length / 3);
    let folded = 0;
    for (let corner = 0; corner < indices.length; corner += 3) {
      const a = indices[corner] * 3;
      const b = indices[corner + 1] * 3;
      const c = indices[corner + 2] * 3;
      const edgeOne = [positions[b] - positions[a], positions[b + 1] - positions[a + 1], positions[b + 2] - positions[a + 2]];
      const edgeTwo = [positions[c] - positions[a], positions[c + 1] - positions[a + 1], positions[c + 2] - positions[a + 2]];
      const facing = (edgeOne[1] * edgeTwo[2] - edgeOne[2] * edgeTwo[1]) * (positions[a] - center[0])
        + (edgeOne[2] * edgeTwo[0] - edgeOne[0] * edgeTwo[2]) * (positions[a + 1] - center[1])
        + (edgeOne[0] * edgeTwo[1] - edgeOne[1] * edgeTwo[0]) * (positions[a + 2] - center[2]);
      if (facing <= 0) folded++;
    }
    worst = Math.max(worst, folded);
  }
  return worst;
}
