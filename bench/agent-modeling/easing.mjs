// The overshoot-lift task: a block that rises and settles with an overshoot. A named easing does it in two keyframes;
// without one the agent has to place the peak and the settle by hand. EASING_PLAIN_SOLUTION is that hand-placed version,
// kept to compare how many keyframes the same result costs.

const BLOCK_SIZE = 0.4;
const REST_HEIGHT = 0.2;
const TARGET_HEIGHT = 1.2;
const DURATION = 1;

const OVERSHOOT_PROMPT = `You are working with the Crucible MCP tools. Units are metres and Y is up. Build a node named block, a box ${BLOCK_SIZE} m on every side, standing on the ground at X = 0, Z = 0 (its centre ${REST_HEIGHT} m high), with a material.
Add a ${DURATION} second motion that lifts the block straight up until its centre is ${TARGET_HEIGHT} m high, with an overshoot: on the way up it passes ${TARGET_HEIGHT} m, peaks between 1.25 m and 1.45 m, and settles back to
exactly ${TARGET_HEIGHT} m by the end of the motion, where it stays. When it is finished, call scene_export_recipe once: the exported recipe is what gets graded.`;

const OVERSHOOT_CHECKS = [
  { kind: 'lint' },
  { kind: 'overshoot', node: 'block', axis: 'y', from: REST_HEIGHT, to: TARGET_HEIGHT, duration: DURATION, peak: [1.25, 1.45] },
];

export const EASING_TASKS = [
  { id: 'overshoot-lift', prompt: OVERSHOOT_PROMPT, ownPreamble: true, checks: OVERSHOOT_CHECKS },
  {
    // The same task with the named easings ruled out, so the agent places the peak and the settle by hand.
    id: 'overshoot-lift-plain',
    prompt: OVERSHOOT_PROMPT.replace('with an overshoot:', 'with an overshoot, using only plain keyframes (do not use the easing field on any keyframe):'),
    ownPreamble: true,
    checks: OVERSHOOT_CHECKS,
  },
];

function liftRecipe(keyframes, interpolation) {
  return {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'body', type: 'box', bevel: 0 }],
    materials: [{ id: 'steel', color: [0.6, 0.62, 0.65] }],
    nodes: [{ id: 'block', geometry: 'body', material: 'steel', translation: [0, REST_HEIGHT, 0], scale: [BLOCK_SIZE, BLOCK_SIZE, BLOCK_SIZE] }],
    motion: {
      duration: DURATION,
      tracks: [{
        kind: 'node', id: 'block', property: 'translation', interpolation,
        keyframes: keyframes.map(([time, height, easing]) => ({ time, value: [0, height, 0], ...(easing ? { easing } : {}) })),
      }],
    },
  };
}

/** Two keyframes and one named easing. */
export const EASING_SOLUTION = liftRecipe([[0, REST_HEIGHT, 'easeOutBack'], [DURATION, TARGET_HEIGHT]], 'LINEAR');

/** The same motion with plain keyframes: smooth segments through the rise, the peak and the settle. */
export const EASING_PLAIN_SOLUTION = liftRecipe([[0, REST_HEIGHT], [0.55, 1.32], [DURATION, TARGET_HEIGHT]], 'SMOOTH');
