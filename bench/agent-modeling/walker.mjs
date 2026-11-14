// The reference for the rigged-walker task: a blocky character built from subdivided mesh boxes, a humanoid armature
// fitted to it, every part skinned with automatic weights, and a one second walk cycle that loops.

// A box subdivided three times spans 0.8492 on each axis, so a scale of size / 0.8492 gives the wanted size.
const SUBDIVIDED_CUBE_SPAN = 0.8492;
const CHARACTER_HEIGHT = 1.8;
const WALK_SECONDS = 1;

function xRotation(degrees) {
  const half = degrees * Math.PI / 360;
  return [Math.sin(half), 0, 0, Math.cos(half)];
}

function part(id, center, size) {
  return { id: `${id}-mesh`, geometry: 'block', material: 'cloth', skin: { armature: 'rig' }, translation: center, scale: size.map(extent => extent / SUBDIVIDED_CUBE_SPAN) };
}

function characterParts() {
  const parts = [
    part('torso', [0, 1.15, 0], [0.34, 0.5, 0.2]),
    part('head', [0, 1.65, 0], [0.2, 0.3, 0.22]),
  ];
  for (const [side, sign] of [['left', 1], ['right', -1]]) {
    parts.push(
      part(`${side}-upper-arm`, [sign * 0.2, 1.233, 0], [0.09, 0.34, 0.09]),
      part(`${side}-lower-arm`, [sign * 0.23, 0.945, 0], [0.08, 0.3, 0.08]),
      part(`${side}-hand`, [sign * 0.255, 0.74, 0], [0.08, 0.14, 0.05]),
      part(`${side}-upper-leg`, [sign * 0.112, 0.7, 0], [0.15, 0.42, 0.15]),
      part(`${side}-lower-leg`, [sign * 0.12, 0.3, 0], [0.12, 0.42, 0.12]),
      part(`${side}-foot`, [sign * 0.12, 0.04, 0.09], [0.11, 0.08, 0.26]),
    );
  }
  return parts;
}

function rotationTrack(id, degrees) {
  const keyframes = degrees.map((angle, step) => ({ time: step * WALK_SECONDS / (degrees.length - 1), value: xRotation(angle) }));
  return { kind: 'node', id, property: 'rotation', interpolation: 'SMOOTH', keyframes };
}

// Positive X rotation swings a hanging limb backward. A thigh swings from forward (-) to back (+); a knee only folds the shin back (+).
const THIGH = [-25, 0, 25, 0, -25];
const SHIN = [5, 5, 10, 45, 5];
const UPPER_ARM = [20, 0, -20, 0, 20];
const FOREARM = [-10, -10, -30, -10, -10];

function walkTracks() {
  const halfCycle = values => [...values.slice(2, 4), ...values.slice(0, 2), values[2]];
  return [
    rotationTrack('leftUpperLeg', THIGH), rotationTrack('leftLowerLeg', SHIN),
    rotationTrack('rightUpperLeg', halfCycle(THIGH)), rotationTrack('rightLowerLeg', halfCycle(SHIN)),
    rotationTrack('leftUpperArm', UPPER_ARM), rotationTrack('leftLowerArm', FOREARM),
    rotationTrack('rightUpperArm', halfCycle(UPPER_ARM)), rotationTrack('rightLowerArm', halfCycle(FOREARM)),
  ];
}

export function walkerRecipe() {
  return {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'block', type: 'mesh', base: { type: 'box', bevel: 0 }, stack: [{ op: 'subdivide', levels: 3 }] }],
    materials: [{ id: 'cloth', color: [0.55, 0.5, 0.45] }],
    armatures: [{ id: 'rig', preset: 'humanoid', fit: { bounds: { min: [-0.3, 0, -0.1], max: [0.3, CHARACTER_HEIGHT, 0.1] } } }],
    nodes: characterParts(),
    motion: {
      duration: WALK_SECONDS, loop: true, tracks: walkTracks(),
      ik: [{ type: 'aim', joint: 'head', worldForward: [0, 0, 1], target: { keyframes: [{ time: 0, value: [1, 1.7, 3] }, { time: 0.5, value: [-1, 1.7, 3] }, { time: 1, value: [1, 1.7, 3] }] }, maxAngle: 25 }],
    },
  };
}
