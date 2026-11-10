// The CC0 RobotExpressive and its locomotion graph, shared by the two samples (main.js and npc.js).
// The Walking and Running clips are in place, so a root travel track at the pace of the stride is added to the armature node:
// the graph takes it out again and the body moves by it, so the feet do not slide.
import { parseGltf } from '/src/gltf.js';
import { clipFromGltfAnimation } from '/src/skeleton-pose.js';
import { createAnimationClip } from '/src/animation.js';
import { createAnimationGraph } from '/src/animation-graph.js';

export const ROBOT_URL = '/tests/fixtures/RobotExpressive.glb';
export const ROOT_BONE = 'RobotArmature';
export const WALK_SPEED = 2.2;
export const RUN_SPEED = 5.5;

function withRootTravel(clip, metersPerSecond) {
  const travel = {
    target: ROOT_BONE,
    property: 'translation',
    keyframes: [{ time: 0, value: [0, 0, 0] }, { time: clip.duration, value: [0, 0, metersPerSecond * clip.duration] }],
  };
  return createAnimationClip({ duration: clip.duration, loop: clip.loop, tracks: [...clip.tracks, travel] });
}

export async function loadRobot() {
  const response = await fetch(ROBOT_URL);
  return parseGltf(await response.arrayBuffer(), { maxVertices: 500000 });
}

// Idle, Walking and Running blended by the `speed` parameter, with root motion on.
export function createLocomotionGraph(asset) {
  const clips = {};
  for (const [name, pace] of [['Idle', 0], ['Walking', WALK_SPEED], ['Running', RUN_SPEED]]) {
    const source = asset.animations.find(animation => animation.name === name);
    const clip = clipFromGltfAnimation(source, { loop: true });
    clips[name] = pace > 0 ? withRootTravel(clip, pace) : clip;
  }
  return createAnimationGraph({
    rootMotion: { bone: ROOT_BONE },
    clips,
    parameters: { speed: { type: 'number' } },
    layers: [{
      name: 'locomotion',
      states: [{
        name: 'move',
        blend: {
          parameter: 'speed',
          motions: [
            { clip: 'Idle', threshold: 0 },
            { clip: 'Walking', threshold: WALK_SPEED },
            { clip: 'Running', threshold: RUN_SPEED },
          ],
        },
      }],
    }],
  });
}
