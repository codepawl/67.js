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
