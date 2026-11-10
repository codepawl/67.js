import { createAnimationClip } from '../../src/animation.js';
import { createAnimationGraph } from '../../src/animation-graph.js';
import { createSkeletonPose } from '../../src/skeleton-pose.js';

// A biped gait for measuring foot slide. The rig faces +z like a glTF model. Each foot is driven directly in the space of
// the in-place root, so a foot in contact moves back at exactly the speed the root travels and stays still in the world.

export const FOOT_SLIDE_STEP = 1 / 60;
const LIFT_HEIGHT = 0.12;
const CONTACT_HEIGHT = 1e-6;
const SWING_KEYS = 8;
const SIDES = Object.freeze([{ foot: 'FootL', x: 0.1, phase: 0 }, { foot: 'FootR', x: -0.1, phase: 0.5 }]);

function wrap(fraction) {
  return ((fraction % 1) + 1) % 1;
}

function footKeyframes({ x, phase }, { cycle, stride, stanceFraction }) {
  // Phase 0 is the instant the foot lands. Over the stance it moves back by `stride`, then swings forward and up.
  const position = (cycleFraction) => {
    const fraction = wrap(cycleFraction + phase);
    if (fraction < stanceFraction) return [x, 0, stride / 2 - stride * (fraction / stanceFraction)];
    const swing = (fraction - stanceFraction) / (1 - stanceFraction);
    return [x, Math.sin(swing * Math.PI) * LIFT_HEIGHT, -stride / 2 + stride * swing];
  };
  const fractions = new Set([0, 1, wrap(-phase), wrap(stanceFraction - phase)]);
  for (let index = 1; index < SWING_KEYS; index++) fractions.add(wrap(stanceFraction + (1 - stanceFraction) * index / SWING_KEYS - phase));
  return [...fractions].sort((a, b) => a - b).map(fraction => ({ time: fraction * cycle, value: position(fraction) }));
}

/** A looping gait whose root travels `speed` m/s along +z and whose planted feet move back at the same rate. */
export function gaitClip({ speed, cycle, stanceFraction = 0.6 }) {
  const stride = speed * cycle * stanceFraction;
  const tracks = [{
    target: 'Root',
    property: 'translation',
    keyframes: [{ time: 0, value: [0, 0, 0] }, { time: cycle, value: [0, 0, speed * cycle] }],
  }];
  for (const side of SIDES) tracks.push({ target: side.foot, property: 'translation', keyframes: footKeyframes(side, { cycle, stride, stanceFraction }) });
  return createAnimationClip({ duration: cycle, loop: true, tracks });
}

export function standClip() {
  const tracks = SIDES.map(side => ({ target: side.foot, property: 'translation', keyframes: [{ time: 0, value: [side.x, 0, 0] }, { time: 1, value: [side.x, 0, 0] }] }));
  return createAnimationClip({ duration: 1, loop: true, tracks });
}

export function bipedRig() {
  const joints = [{ name: 'Root', parent: -1, translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }];
  for (const side of SIDES) joints.push({ name: side.foot, parent: 0, translation: [side.x, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] });
  return { joints };
}

export function locomotionGraph({ walkSpeed = 1.4, runSpeed = 3.6 } = {}) {
  return createAnimationGraph({
    rootMotion: { bone: 'Root' },
    clips: {
      idle: standClip(),
      walk: gaitClip({ speed: walkSpeed, cycle: 1.0 }),
      run: gaitClip({ speed: runSpeed, cycle: 0.6 }),
    },
    parameters: { speed: { type: 'number' } },
    layers: [{
      name: 'base',
      states: [{ name: 'move', blend: { parameter: 'speed', motions: [{ clip: 'idle', threshold: 0 }, { clip: 'walk', threshold: walkSpeed }, { clip: 'run', threshold: runSpeed }] } }],
    }],
  });
}

/**
 * Play the graph while `speedAt(time)` sets its speed parameter and follow each foot in the world. A contact is a run of
 * frames with the foot on the ground; its drift is how far the foot strays from where it landed. Returns per-foot contacts.
 */
export function measureFootSlide({ graph = locomotionGraph(), seconds = 12, speedAt }) {
  const pose = createSkeletonPose({ rig: bipedRig(), layers: graph.poseLayers() });
  const position = [0, 0];
  const feet = new Map(SIDES.map(side => [side.foot, { contacts: [], current: null }]));
  for (let step = 0; step < Math.round(seconds / FOOT_SLIDE_STEP); step++) {
    graph.set('speed', speedAt(graph.time));
    graph.advance(FOOT_SLIDE_STEP);
    position[0] += graph.rootMotion.delta[0];
    position[1] += graph.rootMotion.delta[1];
    pose.apply(graph.time);
    for (const [name, record] of feet) {
      const local = pose.jointWorld(name).position;
      // The model faces +z while the player convention faces -z, so the model is turned half a turn about y.
      const world = [position[0] - local[0], position[1] - local[2]];
      if (local[1] > CONTACT_HEIGHT) {
        record.current = null;
        continue;
      }
      if (!record.current) {
        record.current = { start: graph.time, anchor: world, drift: 0, frames: 0 };
        record.contacts.push(record.current);
      }
      record.current.drift = Math.max(record.current.drift, Math.hypot(world[0] - record.current.anchor[0], world[1] - record.current.anchor[1]));
      record.current.frames++;
    }
  }
  return Object.fromEntries([...feet].map(([name, record]) => [name, record.contacts.map(({ start, drift, frames }) => ({ start, drift, frames }))]));
}
