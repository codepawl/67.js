// The agent modeling tasks. Each prompt gives sizes in metres, so every check is objective. Checks run on the recipe
// the agent exports (see measure.mjs and check.mjs); none of them looks at how the object was built.

import { REFERENCES } from './references.mjs';
import { KETTLE_START, KETTLE_START_PLAIN } from './kettle.mjs';
import { DESK_START, DESK_START_PLAIN, DESK_CHECKS } from './desk.mjs';
import { CABINET_START, CABINET_START_PLAIN, CABINET_CHECKS } from './cabinet.mjs';
import { LAMP_START, LAMP_PROMPT, LAMP_CHECKS } from './lamp.mjs';
import { GALLERY_START, GALLERY_PROMPT, GALLERY_CHECKS } from './gallery.mjs';
import { DUSK_START, DUSK_PROMPT, DUSK_CHECKS } from './dusk.mjs';
import { COLONNADE_START, COLONNADE_PROMPT, COLONNADE_CHECKS } from './colonnade.mjs';
import { TERRAIN_TASKS } from './terrain.mjs';
import { EASING_TASKS } from './easing.mjs';
import { SCENE_TASKS } from './scenes.mjs';

export const PROMPT_PREAMBLE = `You are modeling with the Crucible MCP tools. Build the object described below as a procedural recipe scene:
start it with scene_create, refine it with mesh_edit, mesh_stack and scene_apply, and look at it with scene_look when
that helps. Units are metres and Y is up. Rest the object on the ground (lowest point at Y = 0), centred on X = 0 and
Z = 0. Build it as closed, watertight solids. When the object is finished, call scene_export_recipe once: the exported
recipe is what gets graded.`;

const crateChecks = [
  { kind: 'lint' },
  { kind: 'size', expected: [0.6, 0.63, 0.6] },
  { kind: 'ground' },
  { kind: 'holes', equals: 0 },
  { kind: 'volume', min: 0.19, max: 0.212 },
  { kind: 'section', axis: 'x', at: 0.29, equals: 2, label: 'recessed panel on +X' },
  { kind: 'section', axis: 'z', at: -0.29, equals: 2, label: 'recessed panel on -Z' },
  { kind: 'section', axis: 'y', at: 0.615, equals: 1, label: 'raised lid' },
];

// The long tasks need sub-element edits, several steps or a whole scene. Two of them start from a recipe given in the
// prompt, which the agent has to change instead of rebuilding from nothing.
const START_INSTRUCTION = 'Start by calling scene_create with exactly this recipe, then change that scene (do not start over):';
const compactRecipe = recipe => JSON.stringify(recipe);

// The same resize twice: the start recipe either states where the lid, handle and spout sit (relations) or holds
// absolute positions. The difference in tool calls is what relations are worth to an agent.
const KETTLE_PROMPT = `The kettle scene below has a body with a lid, a handle and a spout against it. Make the body 0.3 m wide (X)
and 0.24 m tall (Y), still 0.12 m deep, resting on the ground and centred on X = 0. The lid must still sit on top of the body,
the handle against its +X side and the spout against its -X side, each touching the body and centred on it as before. Keep
the lid, handle and spout the size they are.`;
const KETTLE_CHECKS = [
  { kind: 'lint' },
  { kind: 'size', expected: [0.37, 0.26, 0.12] },
  { kind: 'ground' },
  { kind: 'touches', node: 'lid', against: 'body', side: '+y' },
  { kind: 'touches', node: 'handle', against: 'body', side: '+x' },
  { kind: 'touches', node: 'spout', against: 'body', side: '-x' },
];
const KETTLE_TASKS = [
  { id: 'kettle-resize', startRecipe: KETTLE_START, prompt: KETTLE_PROMPT, checks: KETTLE_CHECKS },
  { id: 'kettle-resize-plain', startRecipe: KETTLE_START_PLAIN, prompt: KETTLE_PROMPT, checks: KETTLE_CHECKS },
];

// Twelve stacked parts and three resizes, one after the other, with a check between steps. The start recipe either
// holds relations or absolute positions; the same checks grade both after the last step.
const DESK_PROMPT = `The desk scene below has 12 parts stacked on each other: a top, four legs, two drawers hanging under the top
with a handle on the front (+Z) of each, a lamp on a base and a book on the top. Do three steps in order, and after each step
call scene_inspect with includeBounds to check the result before the next. Step 1: widen the top to 1.6 m along X.
Step 2: deepen the top to 0.8 m along Z and deepen both drawers to 0.7 m along Z. Step 3: thicken the top to 0.08 m while its
upper surface stays at 0.75 m, and shorten the legs so they still run from the ground to the underside of the top. Keep the
size of every other part. After the last step every part must sit where it sat before, relative to what it sits against: legs
0.05 m in from the edges of the top, drawers 0.1 m in from the ends of the top and centred in Z, a handle touching the front
of its drawer and centred on it, the lamp base and the book on the top at the same offsets from its ends, the lamp on its base.`;
const DESK_TASKS = [
  { id: 'desk-resize', startRecipe: DESK_START, prompt: DESK_PROMPT, checks: DESK_CHECKS },
  { id: 'desk-resize-plain', startRecipe: DESK_START_PLAIN, prompt: DESK_PROMPT, checks: DESK_CHECKS },
];

// One resize of a 10-part cabinet. The plain start recipe is the one for comparing --relations on and off: the agent
// either recomputes every dependent part or states the attachments itself.
const CABINET_PROMPT = `The cabinet scene below has a body on four feet, two doors on its front (+Z) face that together cover the
width of the body, a handle on each door, and a cornice on top. Make the cabinet 30% wider (body 1.3 m instead of 1 m) and
10 cm taller (1.9 m from the ground to the top of the cornice, so only the body gets taller). Keep the body depth and the size
of the feet, handles and cornice overhang. Afterwards the feet must still stand 0.04 m in from the body's corners, each
door must still be half the body width, flush with its end of the body and centred in Y with a 0.04 m margin at top and bottom,
each handle 0.04 m in from the middle seam of its door and centred in Y, and the cornice centred on top of the body.`;
const CABINET_TASKS = [
  { id: 'cabinet-resize', startRecipe: CABINET_START, prompt: CABINET_PROMPT, checks: CABINET_CHECKS },
  { id: 'cabinet-resize-plain', startRecipe: CABINET_START_PLAIN, prompt: CABINET_PROMPT, checks: CABINET_CHECKS },
];

const LONG_TASKS = [
  {
    id: 'chamfer-plate',
    prompt: `A hard-surface plate lying on the ground, one solid piece: 0.2 m long (X), 0.03 m thick (Y) and 0.12 m deep
(Z). The four edges around its top face are chamfered 0.005 m. The top face carries six rectangular pockets sunk 0.01 m,
each 0.04 m by 0.04 m, in three columns along X (centres at X = -0.055, 0 and 0.055) and two rows along Z (centres at
Z = -0.0275 and 0.0275). The pockets leave a solid rim around the plate and walls between them.`,
    checks: [
      { kind: 'lint' },
      { kind: 'parts', max: 1 },
      { kind: 'size', expected: [0.2, 0.03, 0.12] },
      { kind: 'ground' },
      { kind: 'holes', equals: 0 },
      { kind: 'volume', min: 5.9e-4, max: 6.4e-4 },
      { kind: 'section', axis: 'y', at: 0.025, equals: 7, label: 'plate outline and six pockets' },
      { kind: 'section', axis: 'y', at: 0.005, equals: 1, label: 'pockets are blind' },
      {
        kind: 'through', axis: 'z', label: 'chamfered top edge',
        open: [[0.0995, 0.0295], [-0.0995, 0.0295]],
        solid: [[0.0995, 0.0155], [0, 0.0295]],
      },
    ],
  },
  {
    id: 'slotted-rail',
    prompt: `A slotted rail lying on the ground, one solid piece: a bar 0.4 m long (X), 0.03 m tall (Y) and 0.06 m deep (Z),
with every outer edge chamfered 0.004 m. Five rectangular slots go straight down through it, each 0.05 m along X and
0.02 m along Z, centred in Z, at X = -0.16, -0.08, 0, 0.08 and 0.16.`,
    checks: [
      { kind: 'lint' },
      { kind: 'parts', max: 1 },
      { kind: 'size', expected: [0.4, 0.03, 0.06] },
      { kind: 'ground' },
      { kind: 'holes', equals: 5 },
      { kind: 'volume', min: 5.0e-4, max: 5.7e-4 },
      { kind: 'section', axis: 'y', at: 0.015, equals: 6, label: 'bar outline and five slots' },
      {
        kind: 'through', axis: 'y', label: 'slots open, bars between them solid',
        open: [[-0.16, 0], [-0.08, 0], [0, 0], [0.08, 0], [0.16, 0]],
        solid: [[-0.12, 0], [-0.04, 0], [0.04, 0], [0.12, 0], [0, 0.025]],
      },
      {
        kind: 'through', axis: 'z', label: 'chamfered end edges',
        open: [[0.1995, 0.0295], [-0.1995, 0.0005]],
        solid: [[0.1995, 0.015], [0, 0.0295]],
      },
    ],
  },
  {
    id: 'crate-revision',
    startRecipe: REFERENCES.crate,
    prompt: `A wooden crate scene is already designed as the recipe below: a 0.6 m cube with recessed side panels and a raised
lid 0.03 m tall. Make two changes. Raise the lid to 0.06 m tall. Then drill a round blind hole of 0.06 m diameter straight
down from the top of the lid, centred on the crate, ending 0.5 m above the ground. Keep everything else as it is.`,
    checks: [
      { kind: 'lint' },
      { kind: 'parts', max: 1 },
      { kind: 'size', expected: [0.6, 0.66, 0.6] },
      { kind: 'ground' },
      { kind: 'holes', equals: 0 },
      { kind: 'volume', min: 0.2, max: 0.218 },
      { kind: 'section', axis: 'y', at: 0.645, equals: 2, label: 'raised lid with the hole' },
      { kind: 'section', axis: 'y', at: 0.55, equals: 2, label: 'body with the hole' },
      { kind: 'section', axis: 'y', at: 0.45, equals: 1, label: 'hole stops at 0.5 m' },
      { kind: 'section', axis: 'x', at: 0.29, equals: 2, label: 'recessed panel on +X kept' },
    ],
  },
  {
    id: 'bracket-revision',
    startRecipe: REFERENCES.bracket,
    prompt: `An L bracket is already designed as the recipe below. Change it: lengthen the base plate to 0.3 m along X and
keep the whole bracket centred on X = 0, with the upright still flush with the base's -X end, the same height and the same
thickness. Replace the two holes by three round holes, 0.02 m in diameter, going straight down through the base at X = -0.05,
0.03 and 0.11, centred in Z. The bracket is 0.17 m tall overall, as before.`,
    checks: [
      { kind: 'lint' },
      { kind: 'size', expected: [0.3, 0.17, 0.1] },
      { kind: 'ground' },
      { kind: 'holes', equals: 3 },
      { kind: 'volume', min: 8.2e-4, max: 9.4e-4 },
      { kind: 'section', axis: 'y', at: 0.01, equals: 4, label: 'base with three holes' },
      {
        kind: 'through', axis: 'y', label: 'holes at the new positions',
        open: [[-0.05, 0], [0.03, 0], [0.11, 0]],
        solid: [[0.06, 0], [0.14, 0], [-0.1, 0]],
      },
    ],
  },
  {
    id: 'workshop',
    prompt: `A small workshop scene on a square floor slab 3 m by 3 m and 0.05 m thick, with its top face 0.05 m above the
ground (Y = 0). The scene is centred on X = 0 and Z = 0. On the slab stand a table and a chair, plus a mug. The table top is 1.2 m
long (X), 0.6 m deep (Z) and 0.04 m thick, with its upper surface 0.75 m above the slab; four square legs, 0.05 m on a
side, run from the slab to the underside of the top, their outer faces 0.05 m in from the top's edges. The table is centred
on the slab. The chair sits 0.8 m toward +Z from the table's centre: its seat is 0.4 m square and 0.03 m thick, with the
upper surface 0.45 m above the slab, on four square legs 0.04 m on a side in the seat's corners, flush with its edges
and stopping at the underside of the seat. The mug is a closed solid cylinder 0.08 m in diameter and 0.1 m tall, standing
on the table top at X = 0.3, Z = -0.05. Every object rests on what is below it, and the objects do not overlap.`,
    checks: [
      { kind: 'lint' },
      { kind: 'parts', min: 12 },
      { kind: 'size', expected: [3, 0.9, 3] },
      { kind: 'ground' },
      { kind: 'section', axis: 'y', at: 0.02, equals: 1, label: 'floor slab' },
      { kind: 'section', axis: 'y', at: 0.3, equals: 8, label: 'four table legs and four chair legs' },
      { kind: 'section', axis: 'y', at: 0.49, equals: 5, label: 'chair seat and four table legs' },
      { kind: 'section', axis: 'y', at: 0.78, equals: 1, label: 'table top' },
      { kind: 'section', axis: 'y', at: 0.85, equals: 1, label: 'mug on the table' },
      { kind: 'volume', min: 0.47, max: 0.52 },
    ],
  },
  {
    id: 'robot-shot',
    assets: true,
    prompt: `The asset catalog holds an imported robot character. Create a scene from it with its Idle clip selected at
time 0, and make a still shot of it with both hands raised. Add IK so that the palm joint of the right arm (Palm2.R) is at
world position [-1.3, 2.6, 0.8] and the palm joint of the left arm (Palm2.L) is at [1.3, 2.4, 0.8], with the rest of the
body on the clip. Then set the camera for a side-on shot: from the +X side of the robot, looking at it, with the eye 3 to
12 m from the look-at target, at most 2 m off the robot's front-to-back axis (Z), and the look-at target between 0.5 m
and 4 m above the ground. Look at the result with scene_look to confirm both hands are in the picture. When it is
finished, call scene_export_recipe once: the exported recipe is what gets graded.`,
    ownPreamble: true,
    checks: [
      { kind: 'assetClip', name: 'Idle' },
      { kind: 'assetReach', endLabel: 'Palm2.R', from: [-1.3, 2.6, 0.8], to: [-1.3, 2.6, 0.8] },
      { kind: 'assetReach', endLabel: 'Palm2.L', from: [1.3, 2.4, 0.8], to: [1.3, 2.4, 0.8] },
      { kind: 'shot', minSideOffset: 2, maxDepthOffset: 2, targetHeight: [0.5, 4], distance: [3, 12] },
    ],
  },
  {
    id: 'robot-leg-hole',
    assets: true,
    prompt: `The asset catalog holds an imported robot character. Create a scene from it. Cut one round hole, about 0.06 m
across in scene units, straight through the robot's left leg (the part labelled LegL), so that the leg is still a single
closed solid with exactly one hole through it. Do not change any other part. Check the leg with mesh_inspect when you are
done. When it is finished, call scene_export_recipe once: the exported recipe is what gets graded.`,
    ownPreamble: true,
    checks: [
      { kind: 'assetHole', part: 'LegL', genus: 1, volumeKept: [0.9, 0.995] },
    ],
  },
];

export const TASKS = [
  {
    id: 'crate',
    prompt: `A wooden crate. The body is a 0.6 m cube. Each of its four sides has a recessed panel: a frame about
0.04 m wide around a panel sunk about 0.02 m into the side. On top sits a raised lid, inset about 0.05 m from the top
edges and 0.03 m tall.`,
    checks: crateChecks,
  },
  {
    id: 'bolt',
    prompt: `A hex bolt standing upright with the shaft pointing down. The shaft is a cylinder 0.03 m in diameter and
0.12 m long, its tip on the ground. The head on top is a regular hexagonal prism 0.05 m across the flats and 0.02 m
tall.`,
    checks: [
      { kind: 'lint' },
      { kind: 'size', expected: [null, 0.14, null] },
      { kind: 'extent', axes: ['x', 'z'], min: 0.0495, max: 0.0585 },
      { kind: 'ground' },
      { kind: 'holes', equals: 0 },
      { kind: 'volume', min: 1.13e-4, max: 1.43e-4 },
      { kind: 'section', axis: 'y', at: 0.06, equals: 1, label: 'one shaft' },
    ],
  },
  {
    id: 'window',
    prompt: `A window frame standing upright in the XY plane: 1.0 m wide (X), 1.2 m tall (Y) and 0.08 m deep (Z). The
outer frame and the cross bars are all 0.06 m wide, dividing it into four open panes of equal size, two by two. No
glass: the panes are open.`,
    checks: [
      { kind: 'lint' },
      { kind: 'size', expected: [1.0, 1.2, 0.08] },
      { kind: 'ground' },
      {
        kind: 'through', axis: 'z', label: 'four open panes',
        open: [[-0.235, 0.315], [0.235, 0.315], [-0.235, 0.885], [0.235, 0.885]],
        solid: [[-0.47, 0.6], [0.47, 0.6], [0.013, 0.3], [0.013, 0.9], [-0.2, 0.6], [0.2, 0.6], [-0.2, 0.03], [0.2, 1.17]],
      },
      { kind: 'volume', min: 0.0256, max: 0.0326 },
    ],
  },
  {
    id: 'table',
    prompt: `A table. The top is 1.2 m long (X), 0.75 m deep (Z) and 0.04 m thick, with its upper surface 0.75 m above
the ground. Four square legs, 0.05 m on a side, run from the ground to the underside of the top; each leg's outer faces
sit 0.05 m in from the edges of the top.`,
    checks: [
      { kind: 'lint' },
      { kind: 'size', expected: [1.2, 0.75, 0.75] },
      { kind: 'ground' },
      { kind: 'section', axis: 'y', at: 0.02, equals: 4, label: 'four legs at the floor' },
      { kind: 'section', axis: 'y', at: 0.7, equals: 4, label: 'four legs under the top' },
      { kind: 'volume', min: 0.0388, max: 0.0474 },
    ],
  },
  {
    id: 'mug',
    prompt: `A mug made as one solid piece. The cup is a cylinder 0.08 m in diameter and 0.1 m tall, open at the top,
with 0.005 m thick walls and a 0.005 m thick bottom. A loop handle on the +X side joins the outer wall at two points,
leaving a gap for fingers, and reaches about 0.03 m out from the wall.`,
    checks: [
      { kind: 'lint' },
      { kind: 'parts', max: 1 },
      { kind: 'size', expected: [null, 0.1, 0.08] },
      { kind: 'extent', axes: ['x'], min: 0.1, max: 0.13 },
      { kind: 'ground', centred: false },
      { kind: 'holes', equals: 1 },
      { kind: 'volume', min: 1.1e-4, max: 2.4e-4 },
    ],
  },
  {
    id: 'gear',
    prompt: `A spur gear lying flat on the ground: 12 teeth, outer (tip) radius 0.1 m, root radius 0.085 m, 0.02 m
thick, with a round centre bore of radius 0.02 m going all the way through.`,
    checks: [
      { kind: 'lint' },
      { kind: 'size', expected: [0.2, 0.02, 0.2] },
      { kind: 'ground' },
      { kind: 'holes', equals: 1 },
      { kind: 'tips', equals: 12 },
    ],
  },
  {
    id: 'fence',
    prompt: `A fence section. Five square posts, 0.08 m on a side and 1.0 m tall, stand in a row along X with their
centres 0.5 m apart. Two horizontal rails, 0.04 m tall and 0.06 m deep, run the full length from the outer face of the
first post to the outer face of the last, centred at heights 0.3 m and 0.8 m and centred on the posts in Z.`,
    checks: [
      { kind: 'lint' },
      { kind: 'size', expected: [2.08, 1.0, 0.08] },
      { kind: 'ground' },
      { kind: 'section', axis: 'y', at: 0.1, equals: 5, label: 'five posts' },
      { kind: 'section', axis: 'x', at: 0.25, equals: 2, label: 'two rails between posts' },
      { kind: 'volume', min: 0.037, max: 0.047 },
    ],
  },
  {
    id: 'bracket',
    prompt: `An L bracket. The base plate is 0.2 m long (X), 0.02 m thick (Y) and 0.1 m deep (Z), lying on the ground.
An upright plate 0.02 m thick (X) and 0.1 m deep stands on top of the base, flush with its -X end, and rises 0.15 m
above it, so the bracket is 0.17 m tall overall. Two round
holes, 0.02 m in diameter, go straight down through the base at X = 0 and X = 0.06 (centred in Z).`,
    checks: [
      { kind: 'lint' },
      { kind: 'size', expected: [0.2, 0.17, 0.1] },
      { kind: 'ground' },
      { kind: 'holes', equals: 2 },
      { kind: 'volume', min: 6.2e-4, max: 7.6e-4 },
      { kind: 'section', axis: 'y', at: 0.01, equals: 3, label: 'base with two holes' },
    ],
  },
  {
    id: 'soap',
    prompt: `A bar of soap: 0.09 m long (X), 0.03 m tall (Y) and 0.06 m deep (Z), with every edge and corner smoothly
rounded to a radius of about 0.01 m.`,
    checks: [
      { kind: 'lint' },
      { kind: 'parts', max: 1 },
      { kind: 'size', expected: [0.09, 0.03, 0.06] },
      { kind: 'ground' },
      { kind: 'holes', equals: 0 },
      { kind: 'volume', min: 1.3e-4, max: 1.56e-4 },
      { kind: 'triangles', min: 200 },
    ],
  },
  {
    id: 'pebble',
    prompt: `A smooth river pebble: 0.08 m long (X), 0.03 m tall (Y) and 0.05 m deep (Z), one closed solid with no flat
faces and no sharp edges, resting on the ground.`,
    checks: [
      { kind: 'lint' },
      { kind: 'parts', max: 1 },
      { kind: 'size', expected: [0.08, 0.03, 0.05] },
      { kind: 'ground' },
      { kind: 'holes', equals: 0 },
      { kind: 'volume', min: 5.5e-5, max: 8e-5 },
      { kind: 'triangles', min: 200 },
    ],
  },
  {
    id: 'ball-badge',
    prompt: `A ball with a badge on it, as two nodes. Node ball: a sphere of radius 0.5 m resting on the ground, centred on X = 0 and Z = 0.
Node badge: a thin plate that was a flat square 0.4 m by 0.4 m (X by Y) and 0.01 m thick, bent so it follows the ball's curved
surface over the front of the ball (+Z side) and centred on it, with its back face lying on the ball (within 5 mm) and its front
face 0.01 m outside it. The plate must keep a smooth grid of at least 12 by 12 cells so the curve is round, and be one closed solid.`,
    checks: [
      { kind: 'lint' },
      { kind: 'parts', max: 2 },
      { kind: 'ground' },
      { kind: 'size', expected: [1, 1, null] },
      { kind: 'shell', node: 'badge', centre: [0, 0.5, 0], min: 0.495, max: 0.515, spread: [0.35, 0.35, 0.04] },
      { kind: 'triangles', min: 500 },
    ],
  },
  {
    id: 'crate-uv',
    prompt: `A wooden crate that will get a tiled wood texture. The body is a 0.6 m cube. Each of its four sides has a
recessed panel: a frame about 0.04 m wide around a panel sunk about 0.02 m into the side. On top sits a raised lid,
inset about 0.05 m from the top edges and 0.03 m tall. Give every part UV coordinates with even texel density and no
stretching.`,
    checks: [...crateChecks, { kind: 'uv', maxStretch: 0.15 }],
  },
  {
    id: 'crate-wood',
    prompt: `A wooden crate that looks like real wood, not a flat colour. The body is a 0.6 m cube. Each of its four
sides has a recessed panel: a frame about 0.04 m wide around a panel sunk about 0.02 m into the side. On top sits a
raised lid, inset about 0.05 m from the top edges and 0.03 m tall.`,
    checks: [...crateChecks, { kind: 'pattern', types: ['wood', 'planks'] }],
  },
  {
    id: 'crate-graph',
    prompt: `A crate with a painted look of your own design: dark and light stripes with a worn, noisy edge, not a ready-made wood or
planks preset. The body is a 0.6 m cube. Each of its four sides has a recessed panel: a frame about 0.04 m wide around a
panel sunk about 0.02 m into the side. On top sits a raised lid, inset about 0.05 m from the top edges and 0.03 m tall.
The stripes must follow the crate's own UV coordinates, so they stay put on the panels and the lid. Give every part UV
coordinates with even texel density and no stretching.`,
    checks: [...crateChecks, { kind: 'uvPattern', maxStretch: 0.15 }],
  },
  {
    id: 'dice',
    prompt: `A six-sided die as one solid piece: a 0.1 m cube with every edge and corner rounded to a radius of about
0.01 m. The faces carry round recessed pips, each about 0.02 m across and at least 0.005 m deep, in the usual layouts
with a spacing of 0.025 m between neighbouring pips: 1 pip on +Y, 6 on -Y, 2 on +X, 5 on -X, 3 on +Z and 4 on -Z.`,
    checks: [
      { kind: 'lint' },
      { kind: 'parts', max: 1 },
      { kind: 'size', expected: [0.1, 0.1, 0.1] },
      { kind: 'ground' },
      { kind: 'holes', equals: 0 },
      { kind: 'volume', min: 8.5e-4, max: 9.8e-4 },
      { kind: 'section', axis: 'y', at: 0.097, equals: 2, label: '1 pip on +Y' },
      { kind: 'section', axis: 'y', at: 0.003, equals: 7, label: '6 pips on -Y' },
      { kind: 'section', axis: 'x', at: 0.047, equals: 3, label: '2 pips on +X' },
      { kind: 'section', axis: 'x', at: -0.047, equals: 6, label: '5 pips on -X' },
      { kind: 'section', axis: 'z', at: 0.047, equals: 4, label: '3 pips on +Z' },
      { kind: 'section', axis: 'z', at: -0.047, equals: 5, label: '4 pips on -Z' },
    ],
  },
  {
    id: 'flange',
    prompt: `A flanged pipe standing upright as one solid piece, 0.3 m tall overall. The pipe has an outer radius of
0.05 m and a bore of radius 0.04 m that goes all the way through. Each end has a round flange of radius 0.09 m and
thickness 0.02 m, flush with the pipe's end. Each flange has six round bolt holes of radius 0.008 m going through it,
evenly spaced on a circle of radius 0.07 m, the first one on the +X side.`,
    checks: [
      { kind: 'lint' },
      { kind: 'parts', max: 1 },
      { kind: 'size', expected: [0.18, 0.3, 0.18] },
      { kind: 'ground' },
      { kind: 'holes', equals: 13 },
      { kind: 'volume', min: 1.35e-3, max: 1.65e-3 },
      { kind: 'section', axis: 'y', at: 0.15, equals: 2, label: 'pipe wall' },
      { kind: 'section', axis: 'y', at: 0.01, equals: 8, label: 'lower flange with bore and six holes' },
      { kind: 'section', axis: 'y', at: 0.29, equals: 8, label: 'upper flange with bore and six holes' },
    ],
  },
  {
    id: 'chair',
    prompt: `A chair facing +Z. The seat is 0.45 m wide (X), 0.45 m deep (Z) and 0.03 m thick, with its upper surface
0.45 m above the ground. Four square legs, 0.04 m on a side, sit in the seat's corners with their outer faces flush
with its edges. The two front legs stop at the underside of the seat; the two rear legs continue up as posts to 0.9 m.
Three horizontal back slats, 0.06 m tall and 0.02 m thick, run between the posts, centred on them in Z, at centre
heights 0.6 m, 0.7 m and 0.8 m.`,
    checks: [
      { kind: 'lint' },
      { kind: 'size', expected: [0.45, 0.9, 0.45] },
      { kind: 'ground' },
      { kind: 'section', axis: 'y', at: 0.2, equals: 4, label: 'four legs' },
      { kind: 'section', axis: 'y', at: 0.52, equals: 2, label: 'two posts above the seat' },
      {
        kind: 'through', axis: 'z', label: 'three slats with gaps',
        open: [[0.003, 0.55], [0.003, 0.65], [0.003, 0.75], [0.003, 0.86]],
        solid: [[0.003, 0.6], [0.003, 0.7], [0.003, 0.8], [0.207, 0.86], [-0.207, 0.86]],
      },
      { kind: 'volume', min: 9.4e-3, max: 1.28e-2 },
    ],
  },
  {
    id: 'arm-reach',
    prompt: `A two-segment robot arm that reaches between two points. Use three nodes with these exact IDs, each with a
small visible geometry: shoulder at [0, 1, 0], elbow 0.5 m from the shoulder, and tip 0.4 m from the elbow. Make elbow a child of
shoulder and tip a child of elbow, so they stay connected. Add a 2 second motion in which the tip is exactly at
[0.4, 1.5, 0.3] at time 0 and exactly at [0.2, 1.2, -0.5] at time 2, with the segments keeping their lengths throughout.
For this task the object does not need to rest on the ground.`,
    checks: [
      { kind: 'nodeAt', node: 'tip', time: 0, position: [0.4, 1.5, 0.3] },
      { kind: 'nodeAt', node: 'tip', time: 2, position: [0.2, 1.2, -0.5] },
      { kind: 'nodeAt', node: 'shoulder', time: 1, position: [0, 1, 0] },
      { kind: 'nodeDistance', from: 'shoulder', to: 'elbow', time: 1, distance: 0.5 },
      { kind: 'nodeDistance', from: 'elbow', to: 'tip', time: 1, distance: 0.4 },
    ],
  },
  {
    id: 'leg-plant',
    prompt: `A walking character's leg that plants its foot on two points, the way a real knee bends. Use three nodes with
these exact IDs, each with a small visible geometry: hip at [0, 1, 0], knee 0.5 m below the hip, and foot 0.5 m below the knee.
Make knee a child of hip and foot a child of knee. The character faces +z, so the knee must bend forward, never backward.
Add a 2 second motion in which the foot is exactly at [0.1, 0.5, 0.35] at time 0 and exactly at [0.1, 0.6, 0.2] at time 2,
with both bones keeping their lengths and the knee in front of the hip-to-foot line at both times.
For this task the object does not need to rest on the ground.`,
    checks: [
      { kind: 'nodeAt', node: 'foot', time: 0, position: [0.1, 0.5, 0.35] },
      { kind: 'nodeAt', node: 'foot', time: 2, position: [0.1, 0.6, 0.2] },
      { kind: 'nodeDistance', from: 'hip', to: 'knee', time: 1, distance: 0.5 },
      { kind: 'nodeDistance', from: 'knee', to: 'foot', time: 1, distance: 0.5 },
      { kind: 'bendsToward', from: 'hip', node: 'knee', to: 'foot', time: 0, direction: [0, 0, 1], minOffset: 0.02 },
      { kind: 'bendsToward', from: 'hip', node: 'knee', to: 'foot', time: 2, direction: [0, 0, 1], minOffset: 0.02 },
    ],
  },
  {
    id: 'tray-drop',
    prompt: `A pocketed block with three balls dropped into it, using recipe physics. The block is node "tray", a mesh of
2 m by 0.4 m by 2 m (X, Y, Z) standing on the ground, with a square pocket 1.2 m wide cut 0.3 m deep into the middle of
its top face. Three balls of radius 0.1 m are nodes "ball-1", "ball-2" and "ball-3", starting above the pocket at
[0, 1, 0], [0.25, 1.5, 0.1] and [-0.25, 2, -0.1]. Add a 3 second physics section: the tray is a fixed body with a
trimesh collider, so it follows the pocket, and the balls are dynamic ball bodies. The balls must end resting on the
pocket floor, not on the block's top. Check the result with scene_inspect.
For this task the balls do not need to rest on the ground at time 0.`,
    checks: [
      { kind: 'lint' },
      { kind: 'physicsBody', node: 'tray', type: 'fixed', shape: 'trimesh', label: 'tray is a fixed trimesh' },
      { kind: 'physicsRest', nodes: ['ball-1', 'ball-2', 'ball-3'], height: [0.17, 0.23], within: 0.5, touching: 'tray', label: 'balls rest on the pocket floor' },
      { kind: 'physicsSeek', label: 'seek back repeats the frame' },
    ],
  },
  {
    id: 'pillar-court',
    prompt: `A pillar court: a grid of 5 pillars along X by 3 along Z. Each pillar is a square column 0.1 m wide and
0.5 m tall. Pillars are 0.4 m apart along X and 0.5 m apart along Z, centre to centre, the whole grid centred on
X = 0 and Z = 0, every pillar standing on the ground. Repeat one pillar over the grid instead of modelling fifteen.`,
    checks: [
      { kind: 'lint' },
      { kind: 'size', expected: [1.7, 0.5, 1.1] },
      { kind: 'ground' },
      { kind: 'holes', equals: 0 },
      { kind: 'volume', min: 0.0725, max: 0.0775 },
      { kind: 'section', axis: 'y', at: 0.25, equals: 15, label: 'fifteen pillars' },
      { kind: 'section', axis: 'x', at: 0.4, equals: 3, label: 'three pillars along Z in the column at X = 0.4' },
    ],
  },
  {
    id: 'rigged-walker',
    prompt: `A blocky humanoid character 1.8 m tall, facing +Z, built from rounded blocks: a torso 0.34 m wide, 0.5 m tall and
0.2 m deep (centre at 1.15 m), a head, and for each side an upper arm, lower arm and hand (the arms hang at the sides)
and an upper leg, lower leg and foot, the feet flat on the ground. Give it a humanoid armature fitted to its height, bind
every block to it with automatic weights, and give it a looping 1 second walk: legs and arms swing in opposite phase,
knees bend forward and elbows bend back, and nothing stretches or collapses. Name the bones in the canonical humanoid
way (hips, spine, head, leftUpperArm, leftLowerLeg, rightFoot and so on).`,
    checks: [
      { kind: 'lint' },
      { kind: 'size', expected: [null, 1.8, null] },
      { kind: 'ground', centred: false },
      { kind: 'rigBones' },
      { kind: 'rigSkinned' },
      { kind: 'rigWalk', footTravel: 0.3, label: 'walk cycle' },
    ],
  },
  {
    id: 'robot-reach',
    assets: true,
    prompt: `The asset catalog holds an imported robot character. Create a scene from it with its Idle clip selected at
time 0. Add a 2 second motion in which the robot's right hand reaches for a moving point: the palm joint (labelled
Palm2.R) is at world position [-1.3, 2.6, 0.8] at time 0 and [-1, 1.7, 1.1] at time 2, while the rest of the body stays on the clip.
Find the joints you need by inspecting the scene. When it is finished, call scene_export_recipe once: the exported
recipe is what gets graded.`,
    ownPreamble: true,
    checks: [
      { kind: 'assetClip', name: 'Idle' },
      { kind: 'assetReach', endLabel: 'Palm2.R', from: [-1.3, 2.6, 0.8], to: [-1, 1.7, 1.1] },
    ],
  },
  {
    id: 'robot-ragdoll',
    assets: true,
    prompt: `The asset catalog holds an imported robot character, about 3 m tall. Create a scene from it with its root lifted so its
feet start 2 m above the ground plane (world height 0), and make it fall limp: it drops, hits the ground and collapses in a
heap within 4 seconds, its body lying low on the ground at the end. When it is finished, call scene_export_recipe once: the
exported recipe is what gets graded.`,
    ownPreamble: true,
    checks: [
      { kind: 'assetRagdoll', minimumDrop: 1.5, minimumDuration: 3, floorTolerance: 0.3, maximumHeight: 1.6 },
    ],
  },
  { id: 'best-of-three', startRecipe: LAMP_START, prompt: LAMP_PROMPT, checks: LAMP_CHECKS },
  { id: 'render-pick', startRecipe: GALLERY_START, prompt: GALLERY_PROMPT, checks: GALLERY_CHECKS },
  { id: 'light-pick-hard', startRecipe: COLONNADE_START, prompt: COLONNADE_PROMPT, checks: COLONNADE_CHECKS },
  { id: 'look-pick', startRecipe: DUSK_START, prompt: DUSK_PROMPT, checks: DUSK_CHECKS },
  ...KETTLE_TASKS,
  ...DESK_TASKS,
  ...CABINET_TASKS,
  {
    id: 'robot-walk-wave',
    assets: true,
    prompt: `The asset catalog holds an imported robot character. Create a scene from it, then give it a 2 second looping motion in
which it walks and waves at the same time: its legs and body play the Walking clip, and only its right arm (the
joint labelled UpperArm.R and everything below it) plays the Wave clip instead. Find the clips and joints by inspecting the
scene. When it is finished, call scene_export_recipe once: the exported recipe is what gets graded.`,
    ownPreamble: true,
    checks: [
      { kind: 'assetWalkAndWave', walk: 'Walking', wave: 'Wave', legs: ['LegL', 'LegR', 'LowerLegL_1', 'LowerLegR_1'], arm: 'ArmR', otherArm: 'ArmL' },
    ],
  },
  ...LONG_TASKS,
  ...TERRAIN_TASKS,
  ...EASING_TASKS,
  ...SCENE_TASKS,
];

/** The task text an agent receives, with the starting recipe appended when the task changes an existing scene. */
export function taskPrompt(task) {
  const text = task.prompt.replace(/\n/g, ' ');
  return task.startRecipe ? `${text} ${START_INSTRUCTION} ${compactRecipe(task.startRecipe)}` : text;
}

export function taskById(id) {
  const task = TASKS.find(candidate => candidate.id === id);
  if (!task) throw new RangeError(`Unknown task ${id}. Tasks: ${TASKS.map(candidate => candidate.id).join(', ')}.`);
  return task;
}
