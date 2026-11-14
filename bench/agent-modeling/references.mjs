// One hand-built solution per task. tests/agent-modeling-suite.test.js grades them, so a checker that rejects a
// correct object, or a task whose numbers do not add up, fails before any agent run is spent on it.

// A unit cube subdivided three times spans 0.8492 on each axis, so a scale of size / 0.8492 gives the wanted size.
const SUBDIVIDED_CUBE_SPAN = 0.8492;
const PEBBLE_SIZE = [0.08, 0.03, 0.05];

import { walkerRecipe } from './walker.mjs';
import { KETTLE_RESIZED, KETTLE_RESIZED_PLAIN } from './kettle.mjs';
import { LAMP_SOLUTION } from './lamp.mjs';
import { GALLERY_SOLUTION } from './gallery.mjs';
import { DUSK_SOLUTION } from './dusk.mjs';
import { COLONNADE_SOLUTION } from './colonnade.mjs';
import { DESK_FINAL, DESK_FINAL_PLAIN } from './desk.mjs';
import { CABINET_FINAL, CABINET_FINAL_PLAIN } from './cabinet.mjs';
import { SCENE_REFERENCES } from './scenes.mjs';
import { EASING_PLAIN_SOLUTION, EASING_SOLUTION } from './easing.mjs';

const material = [{ id: 'paint', color: [0.6, 0.55, 0.5] }];

function scene(geometries, nodes) {
  return { format: 'crucible.scene', schemaVersion: 1, geometries, materials: material, nodes: nodes.map(node => ({ material: 'paint', ...node })) };
}

function axisRotation(axis, angle) {
  const half = angle / 2;
  const quaternion = [0, 0, 0, Math.cos(half)];
  quaternion['xyz'.indexOf(axis)] = Math.sin(half);
  return quaternion;
}

function circle(radius, points, centerX = 0, centerY = 0, clockwise = false) {
  return Array.from({ length: points }, (_, index) => {
    const angle = (clockwise ? -1 : 1) * index / points * Math.PI * 2;
    return [centerX + radius * Math.cos(angle), centerY + radius * Math.sin(angle)];
  });
}

function rectangle(minimumX, minimumY, maximumX, maximumY, clockwise = false) {
  const ring = [[minimumX, minimumY], [maximumX, minimumY], [maximumX, maximumY], [minimumX, maximumY]];
  return clockwise ? ring.reverse() : ring;
}

const crateEdits = [
  { op: 'translate', select: { tag: 'right' }, offset: [-0.2, 0, 0] },
  { op: 'translate', select: { tag: 'left' }, offset: [0.2, 0, 0] },
  { op: 'translate', select: { tag: 'front' }, offset: [0, 0, -0.2] },
  { op: 'translate', select: { tag: 'back' }, offset: [0, 0, 0.2] },
  { op: 'translate', select: { tag: 'top' }, offset: [0, -0.2, 0] },
  { op: 'translate', select: { tag: 'bottom' }, offset: [0, 0.2, 0] },
  { op: 'inset_individual', select: { tag: 'side' }, thickness: 0.04, name: 'panel' },
  { op: 'extrude_individual', select: { tag: 'panel.cap' }, offset: -0.02 },
  { op: 'inset_region', select: { tag: 'top' }, thickness: 0.05, name: 'lid' },
  { op: 'extrude_face_region', select: { tag: 'lid.cap' }, offset: 0.03 },
];

function hexagon(acrossFlats) {
  const radius = acrossFlats / Math.sqrt(3);
  return circle(radius, 6);
}

function gearContour(teeth, tipRadius, rootRadius) {
  const points = [];
  for (let tooth = 0; tooth < teeth; tooth++) {
    const base = tooth / teeth * Math.PI * 2;
    const step = Math.PI * 2 / teeth;
    for (const [fraction, radius] of [[0, rootRadius], [0.15, rootRadius], [0.3, tipRadius], [0.55, tipRadius], [0.7, rootRadius]]) {
      const angle = base + fraction * step;
      points.push([radius * Math.cos(angle), radius * Math.sin(angle)]);
    }
  }
  return points;
}

const PIP_LAYOUTS = {
  1: [[0, 0]],
  2: [[-1, -1], [1, 1]],
  3: [[-1, -1], [0, 0], [1, 1]],
  4: [[-1, -1], [-1, 1], [1, -1], [1, 1]],
  5: [[-1, -1], [-1, 1], [0, 0], [1, -1], [1, 1]],
  6: [[-1, -1], [-1, 0], [-1, 1], [1, -1], [1, 0], [1, 1]],
};
const DIE_FACES = [
  { pips: 1, point: (first, second) => [first, 0.5, second] },
  { pips: 6, point: (first, second) => [first, -0.5, second] },
  { pips: 2, point: (first, second) => [0.5, first, second] },
  { pips: 5, point: (first, second) => [-0.5, first, second] },
  { pips: 3, point: (first, second) => [first, second, 0.5] },
  { pips: 4, point: (first, second) => [first, second, -0.5] },
];

function dieEdits() {
  const pipEdits = [];
  for (const face of DIE_FACES) {
    for (const [first, second] of PIP_LAYOUTS[face.pips]) {
      pipEdits.push({
        op: 'boolean', operation: 'difference', name: `pip-${pipEdits.length}`,
        cutter: { type: 'sphere', segments: 16, rings: 8 },
        translation: face.point(first * 0.25, second * 0.25), scale: [0.1, 0.1, 0.1],
      });
    }
  }
  return [{ op: 'bevel', edges: { all: true }, width: 0.1, segments: 3 }, ...pipEdits];
}

function boltHoleEdits() {
  const edits = [];
  for (const height of [0.01, 0.29]) {
    for (let hole = 0; hole < 6; hole++) {
      const angle = hole / 6 * Math.PI * 2;
      edits.push({
        op: 'boolean', operation: 'difference', name: `bolt-${edits.length}`,
        cutter: { type: 'cylinder', segments: 24, bevel: 0 },
        translation: [0.07 * Math.cos(angle), height, 0.07 * Math.sin(angle)], scale: [0.008, 0.04, 0.008],
      });
    }
  }
  return edits;
}

/** Resize the unit box to half extents by moving each tagged face, the way the crate and soap references do. */
function boxFaceEdits([halfX, halfY, halfZ]) {
  return [
    { op: 'translate', select: { tag: 'right' }, offset: [halfX - 0.5, 0, 0] },
    { op: 'translate', select: { tag: 'left' }, offset: [0.5 - halfX, 0, 0] },
    { op: 'translate', select: { tag: 'top' }, offset: [0, halfY - 0.5, 0] },
    { op: 'translate', select: { tag: 'bottom' }, offset: [0, 0.5 - halfY, 0] },
    { op: 'translate', select: { tag: 'front' }, offset: [0, 0, halfZ - 0.5] },
    { op: 'translate', select: { tag: 'back' }, offset: [0, 0, 0.5 - halfZ] },
  ];
}

function boxCut(name, center, size) {
  return { op: 'boolean', operation: 'difference', name, cutter: { type: 'box', bevel: 0 }, translation: center, scale: size };
}

function pocketEdits() {
  const edits = [];
  for (const x of [-0.055, 0, 0.055]) {
    for (const z of [-0.0275, 0.0275]) edits.push(boxCut(`pocket-${edits.length}`, [x, 0.015, z], [0.04, 0.02, 0.04]));
  }
  return edits;
}

function slotEdits() {
  return [-0.16, -0.08, 0, 0.08, 0.16].map((x, index) => boxCut(`slot-${index}`, [x, 0, 0], [0.05, 0.1, 0.02]));
}

const revisedCrateEdits = [
  ...crateEdits.map(edit => (edit.op === 'extrude_face_region' ? { ...edit, offset: 0.06 } : edit)),
  { op: 'boolean', operation: 'difference', name: 'drill', cutter: { type: 'cylinder', segments: 32, bevel: 0 }, translation: [0, 0.3, 0], scale: [0.03, 0.2, 0.03] },
];

function workshopNodes() {
  const legs = (prefix, centerZ, halfSpanX, halfSpanZ, size, height, centerY) => [[-1, -1], [-1, 1], [1, -1], [1, 1]].map(([signX, signZ], index) => ({
    id: `${prefix}-leg-${index}`, geometry: 'block', translation: [signX * halfSpanX, centerY, centerZ + signZ * halfSpanZ], scale: [size, height, size],
  }));
  return [
    { id: 'floor', geometry: 'block', translation: [0, 0.025, 0], scale: [3, 0.05, 3] },
    { id: 'table-top', geometry: 'block', translation: [0, 0.78, 0], scale: [1.2, 0.04, 0.6] },
    ...legs('table', 0, 0.525, 0.225, 0.05, 0.71, 0.405),
    { id: 'seat', geometry: 'block', translation: [0, 0.485, 0.8], scale: [0.4, 0.03, 0.4] },
    ...legs('chair', 0.8, 0.18, 0.18, 0.04, 0.42, 0.26),
    { id: 'mug', geometry: 'cup', translation: [0.3, 0.85, -0.05], scale: [0.04, 0.1, 0.04] },
  ];
}

function robotArmSolver(root, middle, end, target) {
  return { type: 'two-bone', root, middle, end, keepEndRotation: false, target };
}

export const REFERENCES = {
  ...SCENE_REFERENCES,
  'best-of-three': LAMP_SOLUTION,
  'render-pick': GALLERY_SOLUTION,
  'light-pick-hard': COLONNADE_SOLUTION,
  'look-pick': DUSK_SOLUTION,
  'kettle-resize': KETTLE_RESIZED,
  'kettle-resize-plain': KETTLE_RESIZED_PLAIN,
  'desk-resize': DESK_FINAL,
  'desk-resize-plain': DESK_FINAL_PLAIN,
  'cabinet-resize': CABINET_FINAL,
  'cabinet-resize-plain': CABINET_FINAL_PLAIN,
  'chamfer-plate': scene(
    [{
      id: 'plate', type: 'mesh', base: { type: 'box', bevel: 0 }, edits: [
        ...boxFaceEdits([0.1, 0.015, 0.06]),
        { op: 'bevel', edges: { between: [{ tag: 'top' }, { tag: 'side' }] }, width: 0.005, segments: 1 },
        ...pocketEdits(),
      ],
    }],
    [{ id: 'plate', geometry: 'plate', translation: [0, 0.015, 0] }],
  ),
  'slotted-rail': scene(
    [{
      id: 'rail', type: 'mesh', base: { type: 'box', bevel: 0 }, edits: [
        ...boxFaceEdits([0.2, 0.015, 0.03]),
        { op: 'bevel', edges: { all: true }, width: 0.004, segments: 1 },
        ...slotEdits(),
      ],
    }],
    [{ id: 'rail', geometry: 'rail', translation: [0, 0.015, 0] }],
  ),
  'crate-revision': scene(
    [{ id: 'crate', type: 'mesh', base: { type: 'box', bevel: 0 }, edits: revisedCrateEdits }],
    [{ id: 'crate', geometry: 'crate', translation: [0, 0.3, 0] }],
  ),
  'bracket-revision': scene(
    [
      { id: 'base', type: 'extrude', depth: 0.02, contour: rectangle(-0.15, -0.05, 0.15, 0.05), holes: [-0.05, 0.03, 0.11].map(x => circle(0.01, 32, x, 0, true)) },
      { id: 'block', type: 'box', bevel: 0 },
    ],
    [
      { id: 'base', geometry: 'base', rotation: axisRotation('x', -Math.PI / 2) },
      { id: 'upright', geometry: 'block', translation: [-0.14, 0.095, 0], scale: [0.02, 0.15, 0.1] },
    ],
  ),
  workshop: scene(
    [{ id: 'block', type: 'box', bevel: 0 }, { id: 'cup', type: 'cylinder', segments: 32, bevel: 0 }],
    workshopNodes(),
  ),
  'robot-shot': {
    format: 'crucible.asset', schemaVersion: 1, assetId: 'ab'.repeat(32),
    animation: { clip: 2, time: 0 },
    camera: { target: [0, 2, 0], eye: [7, 2.5, 0.5], up: [0, 1, 0], fov: 45, near: 0.1, far: 100 },
    motion: {
      duration: 1, tracks: [],
      ik: [
        robotArmSolver('node-37', 'node-39', 'node-40', [-1.3, 2.6, 0.8]),
        robotArmSolver('node-17', 'node-19', 'node-20', [1.3, 2.4, 0.8]),
      ],
    },
  },
  'robot-leg-hole': {
    format: 'crucible.asset', schemaVersion: 1, assetId: 'ab'.repeat(32),
    meshEdits: [{
      id: 'mesh-10',
      edits: [{ op: 'boolean', operation: 'difference', cutter: { type: 'cylinder', segments: 24 }, scale: [0.0003, 0.01, 0.0003] }],
    }],
  },
  'robot-reach': {
    format: 'crucible.asset', schemaVersion: 1, assetId: 'ab'.repeat(32),
    animation: { clip: 2, time: 0 },
    motion: {
      duration: 2, tracks: [],
      ik: [{
        type: 'two-bone', root: 'node-37', middle: 'node-39', end: 'node-40', keepEndRotation: false,
        target: { keyframes: [{ time: 0, value: [-1.3, 2.6, 0.8] }, { time: 2, value: [-1, 1.7, 1.1] }] },
      }],
    },
  },
  'robot-ragdoll': {
    format: 'crucible.asset', schemaVersion: 1, assetId: 'ab'.repeat(32),
    root: { translation: [0, 2, 0] },
    physics: { duration: 4, ragdoll: {} },
  },
  'robot-walk-wave': {
    format: 'crucible.asset', schemaVersion: 1, assetId: 'ab'.repeat(32),
    motion: {
      duration: 2, loop: true,
      layers: [
        { clip: 10 },
        { clip: 12, mask: { joints: ['node-37'] }, morph: false },
      ],
    },
  },
  'tray-drop': {
    ...scene(
      [
        { id: 'tray', type: 'mesh', base: { type: 'box', bevel: 0 }, edits: [
          { op: 'inset_region', select: { tag: 'top' }, thickness: 0.2, name: 'pocket' },
          { op: 'extrude_face_region', select: { tag: 'pocket.cap' }, offset: -0.75 },
        ] },
        { id: 'ball', type: 'sphere', segments: 16, rings: 8 },
      ],
      [
        { id: 'tray', geometry: 'tray', translation: [0, 0.2, 0], scale: [2, 0.4, 2] },
        { id: 'ball-1', geometry: 'ball', translation: [0, 1, 0], scale: [0.1, 0.1, 0.1] },
        { id: 'ball-2', geometry: 'ball', translation: [0.25, 1.5, 0.1], scale: [0.1, 0.1, 0.1] },
        { id: 'ball-3', geometry: 'ball', translation: [-0.25, 2, -0.1], scale: [0.1, 0.1, 0.1] },
      ],
    ),
    physics: {
      duration: 3,
      bodies: [
        { node: 'tray', type: 'fixed', shape: 'trimesh' },
        { node: 'ball-1', shape: 'ball' },
        { node: 'ball-2', shape: 'ball' },
        { node: 'ball-3', shape: 'ball' },
      ],
    },
  },
  'arm-reach': {
    ...scene(
      [{ id: 'ball', type: 'sphere', segments: 16, rings: 8 }],
      [
        { id: 'shoulder', geometry: 'ball', translation: [0, 1, 0], scale: [0.03, 0.03, 0.03] },
        { id: 'elbow', geometry: 'ball', parent: 'shoulder', translation: [0.5 / 0.03, 0, 0] },
        { id: 'tip', geometry: 'ball', parent: 'elbow', translation: [0.4 / 0.03, 0, 0] },
      ],
    ),
    motion: {
      duration: 2, tracks: [],
      ik: [{
        type: 'two-bone', root: 'shoulder', middle: 'elbow', end: 'tip', pole: [0, 3, 0],
        target: { keyframes: [{ time: 0, value: [0.4, 1.5, 0.3] }, { time: 2, value: [0.2, 1.2, -0.5] }] },
      }],
    },
  },
  'leg-plant': {
    ...scene(
      [{ id: 'ball', type: 'sphere', segments: 16, rings: 8 }],
      [
        { id: 'hip', geometry: 'ball', translation: [0, 1, 0], scale: [0.03, 0.03, 0.03] },
        { id: 'knee', geometry: 'ball', parent: 'hip', translation: [0, -0.5 / 0.03, 0] },
        { id: 'foot', geometry: 'ball', parent: 'knee', translation: [0, -0.5 / 0.03, 0] },
      ],
    ),
    motion: {
      duration: 2, tracks: [],
      ik: [{
        type: 'two-bone', root: 'hip', middle: 'knee', end: 'foot', pole: [0, 0.5, 3], bendToward: [0, 0, 1],
        limits: { middle: { x: [-150, 150] } },
        target: { keyframes: [{ time: 0, value: [0.1, 0.5, 0.35] }, { time: 2, value: [0.1, 0.6, 0.2] }] },
      }],
    },
  },
  dice: scene(
    [{ id: 'die', type: 'mesh', base: { type: 'box', bevel: 0 }, edits: dieEdits() }],
    [{ id: 'die', geometry: 'die', translation: [0, 0.05, 0], scale: [0.1, 0.1, 0.1] }],
  ),
  flange: scene(
    [{
      id: 'pipe', type: 'mesh',
      base: { type: 'lathe', segments: 64, profile: [[0.04, 0.3], [0.04, 0], [0.09, 0], [0.09, 0.02], [0.05, 0.02], [0.05, 0.28], [0.09, 0.28], [0.09, 0.3], [0.04, 0.3]] },
      edits: boltHoleEdits(),
    }],
    [{ id: 'pipe', geometry: 'pipe' }],
  ),
  chair: scene(
    [{ id: 'block', type: 'box', bevel: 0 }],
    [
      { id: 'seat', geometry: 'block', translation: [0, 0.435, 0], scale: [0.45, 0.03, 0.45] },
      { id: 'front-left', geometry: 'block', translation: [-0.205, 0.21, 0.205], scale: [0.04, 0.42, 0.04] },
      { id: 'front-right', geometry: 'block', translation: [0.205, 0.21, 0.205], scale: [0.04, 0.42, 0.04] },
      { id: 'post-left', geometry: 'block', translation: [-0.205, 0.45, -0.205], scale: [0.04, 0.9, 0.04] },
      { id: 'post-right', geometry: 'block', translation: [0.205, 0.45, -0.205], scale: [0.04, 0.9, 0.04] },
      ...[0.6, 0.7, 0.8].map((height, index) => ({ id: `slat-${index}`, geometry: 'block', translation: [0, height, -0.205], scale: [0.37, 0.06, 0.02] })),
    ],
  ),
  crate: scene(
    [{ id: 'crate', type: 'mesh', base: { type: 'box', bevel: 0 }, edits: crateEdits }],
    [{ id: 'crate', geometry: 'crate', translation: [0, 0.3, 0] }],
  ),
  'crate-wood': {
    ...scene(
      [{ id: 'crate', type: 'mesh', base: { type: 'box', bevel: 0 }, edits: crateEdits }],
      [{ id: 'crate', geometry: 'crate', translation: [0, 0.3, 0] }],
    ),
    materials: [{ id: 'paint', pattern: { type: 'planks', size: 0.6, count: 5 }, roughness: 1 }],
  },
  'crate-graph': {
    ...scene(
      [{ id: 'crate', type: 'mesh', base: { type: 'box', bevel: 0 }, edits: [...crateEdits, { op: 'uv_unwrap' }] }],
      [{ id: 'crate', geometry: 'crate', translation: [0, 0.3, 0] }],
    ),
    materials: [{
      id: 'paint',
      pattern: {
        type: 'graph', mapping: 'uv', bump: 0.6,
        graph: {
          color: { ramp: { value: { add: [{ mul: [{ wave: { frequency: 6, direction: 'u', shape: 'triangle' } }, 0.7] }, { mul: [{ noise: { scale: 16, seed: 4 } }, 0.3] }] }, stops: [[0, [0.05, 0.12, 0.2]], [1, [0.8, 0.7, 0.45]]] } },
          roughness: { mix: [0.5, 0.9, { noise: { scale: 16, seed: 4 } }] },
          height: { noise: { scale: 24, seed: 7 } },
        },
      },
    }],
  },
  'crate-uv': scene(
    [{ id: 'crate', type: 'mesh', base: { type: 'box', bevel: 0 }, edits: [...crateEdits, { op: 'uv_unwrap' }] }],
    [{ id: 'crate', geometry: 'crate', translation: [0, 0.3, 0] }],
  ),
  bolt: scene(
    [
      { id: 'shaft', type: 'cylinder', segments: 32, bevel: 0 },
      { id: 'head', type: 'extrude', contour: hexagon(0.05), depth: 0.02 },
    ],
    [
      { id: 'shaft', geometry: 'shaft', translation: [0, 0.06, 0], scale: [0.015, 0.12, 0.015] },
      { id: 'head', geometry: 'head', translation: [0, 0.12, 0], rotation: axisRotation('x', -Math.PI / 2) },
    ],
  ),
  'rigged-walker': walkerRecipe(),
  'overshoot-lift': EASING_SOLUTION,
  'overshoot-lift-plain': EASING_PLAIN_SOLUTION,
  'terrain-hole-walk': {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [
      { id: 'hills', type: 'terrain', size: 40, resolution: 64, seed: 3, amplitude: 1, holes: [{ center: [0, 0], radius: 3 }] },
      { id: 'body', type: 'box', bevel: 0 },
    ],
    materials: [{ id: 'grass', color: [0.3, 0.55, 0.2] }, { id: 'coat', color: [0.8, 0.3, 0.2] }],
    nodes: [
      { id: 'ground', geometry: 'hills', material: 'grass' },
      { id: 'walker', geometry: 'body', material: 'coat', translation: [-15, 0.5, -15], scale: [0.4, 1, 0.4] },
    ],
    motion: {
      duration: 10,
      tracks: [{
        kind: 'node', id: 'walker', property: 'translation', interpolation: 'LINEAR',
        keyframes: [[0, [-15, 0.5, -15]], [3, [-6, 0.5, -6]], [5, [6, 0.5, -6]], [10, [15, 0.5, 15]]].map(([time, value]) => ({ time, value })),
      }],
    },
  },
  'terrain-path-walk': {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [
      { id: 'hills', type: 'terrain', size: 40, resolution: 64, seed: 3, amplitude: 1, holes: [{ center: [0, 0], radius: 3 }, { center: [9, 9], radius: 2.5 }] },
      { id: 'body', type: 'box', bevel: 0 },
    ],
    materials: [{ id: 'grass', color: [0.3, 0.55, 0.2] }, { id: 'coat', color: [0.8, 0.3, 0.2] }],
    nodes: [
      { id: 'ground', geometry: 'hills', material: 'grass' },
      { id: 'rock', geometry: 'body', material: 'coat', translation: [-8, 1, -8], scale: [3, 2, 3] },
      { id: 'walker', geometry: 'body', material: 'coat', translation: [-15, 0.5, -15], scale: [0.4, 1, 0.4] },
    ],
    motion: {
      duration: 10,
      tracks: [{
        kind: 'node', id: 'walker', property: 'translation', interpolation: 'LINEAR',
        keyframes: [[0, [-15, 0.5, -15]], [2.5, [-4, 0.5, -12]], [4, [-4, 0.5, -5]], [5.5, [5, 0.5, -5]], [7, [5, 0.5, 13]], [10, [15, 0.5, 15]]].map(([time, value]) => ({ time, value })),
      }],
    },
  },
  'pillar-court': scene(
    [{ id: 'pillar', type: 'box', bevel: 0 }],
    [{
      id: 'court', geometry: 'pillar', translation: [0, 0.25, 0], scale: [0.1, 0.5, 0.1],
      // The group's scale is 0.1 by 0.5 by 0.1, so a grid step of 4 by 5 is 0.4 m by 0.5 m.
      instances: { grid: { counts: [5, 1, 3], spacing: [4, 1, 5] } },
    }],
  ),
  window: scene(
    [{
      id: 'frame', type: 'extrude', depth: 0.08,
      contour: rectangle(-0.5, 0, 0.5, 1.2),
      holes: [
        rectangle(-0.44, 0.06, -0.03, 0.57, true), rectangle(0.03, 0.06, 0.44, 0.57, true),
        rectangle(-0.44, 0.63, -0.03, 1.14, true), rectangle(0.03, 0.63, 0.44, 1.14, true),
      ],
    }],
    [{ id: 'frame', geometry: 'frame', translation: [0, 0, -0.04] }],
  ),
  table: scene(
    [{ id: 'block', type: 'box', bevel: 0 }],
    [
      { id: 'top', geometry: 'block', translation: [0, 0.73, 0], scale: [1.2, 0.04, 0.75] },
      ...[[-1, -1], [-1, 1], [1, -1], [1, 1]].map(([signX, signZ], index) => ({
        id: `leg-${index}`, geometry: 'block', translation: [signX * 0.525, 0.355, signZ * 0.2], scale: [0.05, 0.71, 0.05],
      })),
    ],
  ),
  mug: scene(
    [{
      id: 'mug', type: 'mesh', base: { type: 'cylinder', segments: 48, bevel: 0 }, edits: [
        { op: 'boolean', operation: 'union', name: 'handle', cutter: { type: 'torus', tubeRadius: 0.25, segments: 48, sides: 12 }, translation: [1.19, 0, 0], scale: [0.45, 0.28, 0.45] },
        { op: 'boolean', operation: 'difference', name: 'cavity', cutter: { type: 'cylinder', segments: 48, bevel: 0 }, translation: [0, 0.05, 0], scale: [0.875, 1, 0.875] },
      ],
    }],
    [{ id: 'mug', geometry: 'mug', translation: [0, 0.05, 0], scale: [0.04, 0.1, 0.04] }],
  ),
  gear: scene(
    [{ id: 'gear', type: 'extrude', contour: gearContour(12, 0.1, 0.085), holes: [circle(0.02, 32, 0, 0, true)], depth: 0.02 }],
    [{ id: 'gear', geometry: 'gear', rotation: axisRotation('x', -Math.PI / 2) }],
  ),
  fence: scene(
    [{ id: 'block', type: 'box', bevel: 0 }],
    [
      ...[-1, -0.5, 0, 0.5, 1].map((x, index) => ({ id: `post-${index}`, geometry: 'block', translation: [x, 0.5, 0], scale: [0.08, 1, 0.08] })),
      { id: 'rail-low', geometry: 'block', translation: [0, 0.3, 0], scale: [2.08, 0.04, 0.06] },
      { id: 'rail-high', geometry: 'block', translation: [0, 0.8, 0], scale: [2.08, 0.04, 0.06] },
    ],
  ),
  bracket: scene(
    [
      { id: 'base', type: 'extrude', depth: 0.02, contour: rectangle(-0.1, -0.05, 0.1, 0.05), holes: [circle(0.01, 32, 0, 0, true), circle(0.01, 32, 0.06, 0, true)] },
      { id: 'block', type: 'box', bevel: 0 },
    ],
    [
      { id: 'base', geometry: 'base', rotation: axisRotation('x', -Math.PI / 2) },
      { id: 'upright', geometry: 'block', translation: [-0.09, 0.095, 0], scale: [0.02, 0.15, 0.1] },
    ],
  ),
  soap: scene(
    [{ id: 'soap', type: 'mesh', base: { type: 'box', bevel: 0 }, edits: [
      { op: 'translate', select: { tag: 'right' }, offset: [-0.455, 0, 0] },
      { op: 'translate', select: { tag: 'left' }, offset: [0.455, 0, 0] },
      { op: 'translate', select: { tag: 'top' }, offset: [0, -0.485, 0] },
      { op: 'translate', select: { tag: 'bottom' }, offset: [0, 0.485, 0] },
      { op: 'translate', select: { tag: 'front' }, offset: [0, 0, -0.47] },
      { op: 'translate', select: { tag: 'back' }, offset: [0, 0, 0.47] },
      { op: 'bevel', edges: { all: true }, width: 0.01, segments: 4 },
    ] }],
    [{ id: 'soap', geometry: 'soap', translation: [0, 0.015, 0] }],
  ),
  'ball-badge': scene(
    [
      { id: 'ball', type: 'sphere' },
      {
        id: 'badge', type: 'mesh', base: { type: 'grid', segments: 16 },
        edits: [
          { op: 'set_position', position: { vec: [{ mul: [{ attr: 'position', component: 'x' }, 0.8] }, { mul: [{ attr: 'position', component: 'y' }, 0.8] }, 1.6] } },
          { op: 'shrinkwrap', target: { type: 'sphere' }, mode: 'project', direction: [0, 0, -1], offset: 0.02 },
          { op: 'solidify', thickness: 0.02, offset: -1 },
        ],
      },
    ],
    [
      { id: 'ball', geometry: 'ball', translation: [0, 0.5, 0], scale: [0.5, 0.5, 0.5] },
      { id: 'badge', geometry: 'badge', translation: [0, 0.5, 0], scale: [0.5, 0.5, 0.5] },
    ],
  ),
  pebble: scene(
    [{ id: 'pebble', type: 'mesh', base: { type: 'box', bevel: 0 }, stack: [{ op: 'subdivide', levels: 3 }] }],
    [{ id: 'pebble', geometry: 'pebble', translation: [0, PEBBLE_SIZE[1] / 2, 0], scale: PEBBLE_SIZE.map(size => size / SUBDIVIDED_CUBE_SPAN) }],
  ),
};
