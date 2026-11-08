# Recorded rigid-body physics

This optional addon uses Rapier 3D to bake collisions and joint motion into a timeline.
Scene playback can seek forward or backward without changing the simulation.
The main renderer does not need Rapier for playback.
Available from version `0.4.0`.
The library build exports it through `67js/addons/physics` when using the npm alias.
Rapier is an optional peer dependency and remains outside the core and library archive.

```sh
npm install @dimforge/rapier3d-compat@0.21.0
```

Use a package-aware development server such as Vite to resolve the solver import.

```js
import { createPhysicsScene, planPhysicsScene } from '../src/physics.js';

const definition = {
  gravity: [0, -9.81, 0],
  bodies: [
    { name: 'floor', type: 'fixed', translation: [0, -0.5, 0] },
    { name: 'box', type: 'dynamic', translation: [0, 3, 0] },
  ],
  colliders: [
    { name: 'floor', body: 'floor', shape: 'cuboid', halfExtents: [5, 0.5, 5] },
    { name: 'box', body: 'box', shape: 'cuboid', halfExtents: [0.5, 0.5, 0.5], mass: 1 },
  ],
  events: [{ tick: 120, body: 'box', impulse: [2, 4, 0] }],
};
const options = { frameCount: 601, timestep: 1 / 60, maxMemoryBytes: 64 * 1024 * 1024 };
const plan = planPhysicsScene(definition, options);
const physics = await createPhysicsScene(definition, options);
const bindings = physics.bindParts([{ body: 'box', part: boxPart }]);
const updatedParts = [boxPart];

function applyAnimation(time) {
  bindings.apply(time);
  renderer.updateParts(updatedParts);
}

applyAnimation(5);
applyAnimation(1); // A backward seek produces the same recorded pose.
physics.dispose();
```

`boxPart` is an existing 67js part with a retained `Float32Array(16)` matrix.
The binding replaces its world translation and rotation while keeping its scale and matrix identity.
The physics body origin must match the visual part origin.
Multiple visual parts can bind to one body when they share that origin.
Visual offsets need separate parts or body definitions.

## Definition

Names must be nonempty and unique within each body, collider, or joint list.
References use body names.
Arrays follow their declared creation order.
Unknown properties fail validation instead of changing the simulation silently.
Inputs are copied before asynchronous initialization.

Bodies use `dynamic`, `fixed`, or `kinematic` types.
The default type is `dynamic`.
Each body accepts `translation` and `rotation` in world space.
Rotation uses a unit quaternion `[x, y, z, w]`.
Dynamic bodies also accept `linearVelocity`, `angularVelocity`, `linearDamping`, `angularDamping`, and boolean `ccd`.
Every dynamic body needs at least one collider.

Colliders attach to a named body through `body`.
Their `translation` and `rotation` are relative to that body.
Multiple colliders form a compound body.
Collider scales come from their dimensions, independently of visual part scales.

| Shape | Required dimensions |
| --- | --- |
| `ball` | Positive `radius`. |
| `cuboid` | Three positive `halfExtents`. |
| `capsule` | Positive `radius` and `halfHeight` for its cylindrical segment along local Y. |

Each collider accepts either positive `mass` or positive `density`.
The default density is `1`.
Rapier computes the center of mass and angular inertia from these collider properties.
The default `friction` is `0.5` and the default `restitution` is `0`.
Restitution must stay between zero and one.

Joints connect `bodyA` and `bodyB` at local `anchorA` and `anchorB` points.
The default anchors are `[0, 0, 0]`.
Connected bodies do not collide unless `contactsEnabled` is `true`.

| Joint type | Additional fields |
| --- | --- |
| `spherical` | None. The joint permits relative rotation. |
| `revolute` | Required unit `axis` expressed in both bodies' local frames. Optional `limits` and `motor`. |
| `prismatic` | Required unit `axis` expressed in both bodies' local frames. Optional `limits` and `motor`. |
| `fixed` | Optional unit `frameA` and `frameB` quaternions. Both default to identity. |

An articulated ragdoll is a graph of dynamic bodies, colliders, and joints.
This example connects two capsule bodies named `upperArm` and `forearm`.
Their initial translations and rotations must place these anchors together.

```js
definition.joints = [{
  name: 'elbow', type: 'revolute',
  bodyA: 'upperArm', bodyB: 'forearm',
  anchorA: [0, -0.5, 0], anchorB: [0, 0.5, 0],
  axis: [0, 0, 1], contactsEnabled: false,
}];
```

## Joint limits and motors

Revolute joints permit one relative rotation, and prismatic joints permit one relative translation along their axis.
Their optional `limits: [minimum, maximum]` restrict that coordinate.
Revolute coordinates use radians. Prismatic coordinates use scene distance units.
Both endpoints must remain strictly increasing after Float32 rounding.

Position motor targets must stay inside the rounded limits. Velocity targets can push against a limit, which the solver enforces.

The prismatic coordinate is the signed distance between the world anchors, projected onto the first body's world axis.
Its initial anchors must align along that axis, and its body orientations must match.
Controlled revolute joints require initially coincident anchors and matching world axes.
Their initial relative twist angle must fit the limits.
Initial coordinate membership uses the Float32-rounded coordinate, matching the solver's numeric precision.
Uncontrolled revolute joints retain their existing initialization behavior.

At an exact half-turn, `+Math.PI` and `-Math.PI` describe the same orientation.
Limit validation uses whichever endpoint the range permits, while nearby excluded angles still fail.
Exact half-turn quaternion antipodes use a canonical sign before baking so their solver trajectories agree.

```js
definition.joints = [{
  name: 'slider', type: 'prismatic',
  bodyA: 'base', bodyB: 'carriage', axis: [1, 0, 0],
  limits: [-1, 1],
  motor: { mode: 'position', target: 0.5, stiffness: 40, damping: 8, maxForce: 10 },
}];
```

Motors use complete serializable snapshots with the fields below.
The addon fixes their Rapier model to `ForceBased` and requires a positive force cap.
An active motor needs at least one directly attached dynamic body.

| Mode | Required fields | Behavior |
| --- | --- | --- |
| `position` | `target`, positive `stiffness`, nonnegative `damping`, positive `maxForce` | Drives toward the relative coordinate with zero target velocity. |
| `velocity` | `target`, positive `damping`, positive `maxForce` | Drives toward the relative speed without a position target. `stiffness` is unsupported. |

For revolute motors, `target` uses radians or radians per second, and `maxForce` caps torque.
For prismatic motors, `target` uses distance or distance per second, and `maxForce` caps force.
Motor response depends on mass, inertia, contacts and the force cap. Targets are not prescribed poses.

`motor: null` disables actuation by zeroing the gains and force cap.
It retains momentum and joint constraints instead of holding the current pose.
Disabling an already disabled motor is a valid no-op.

Spherical and fixed joints reject these single-coordinate limits and motor fields, including `motor: null`.
Rapier `0.21.0` exposes per-axis spherical motor methods, but this addon does not yet define their multi-axis data contract.
Its spherical binding does not expose the single-coordinate limit methods used here.

## Tick events

Events run before their tick's integration step.
Frame zero records the initial pose.
Tick zero events affect frame one.
The final valid tick is `frameCount - 2`.
Events run in ascending tick order, preserving declaration order within each tick.

An `impulse` event targets a dynamic body.
The default event type is `impulse`.
Its `impulse` and `torqueImpulse` vectors use world space.
An optional world `point` applies the linear impulse away from the center of mass.
At least one impulse vector is required.

```js
definition.events = [
  { tick: 0, body: 'forearm', torqueImpulse: [0, 0, 0.2] },
  { tick: 60, body: 'upperArm', impulse: [1, 2, 0], point: [0, 1, 0] },
];
```

A `kinematicPose` event targets a position-based kinematic body.
Its optional `translation` and `rotation` define the next world pose.
At least one field is required.
Rapier computes velocity from this target, so a moving kinematic collider can push dynamic bodies.
An unchanged target holds its previous position.

```js
definition.events = [
  { tick: 0, type: 'kinematicPose', body: 'platform', translation: [0, 1, 0] },
];
```

A `jointMotor` event replaces the complete motor snapshot of a named revolute or prismatic joint.
Its fields are `tick`, `type`, `joint` and `motor`. Body impulse and pose fields are unsupported.
The replacement persists until another motor event, and both attached bodies wake when the event runs.
Same-tick snapshots preserve declaration order, so the final snapshot controls that tick's integration.

```js
definition.events = [
  { tick: 60, type: 'jointMotor', joint: 'slider', motor: { mode: 'position', target: -0.5, stiffness: 40, damping: 8, maxForce: 10 } },
  { tick: 120, type: 'jointMotor', joint: 'slider', motor: null },
];
```

Motor events obey the same tick range and before-integration timing as impulses.
Initial motors, limits and nested event snapshots are copied before awaiting WASM initialization.
Recorded sampling never changes motor state or reruns the solver.

## Sampling and bindings

`physics.sample(time, out)` returns packed poses in `physics.bodyNames` order.
Each body occupies seven Float32 values `[x, y, z, qx, qy, qz, qw]`.
`physics.bodyIndex(name)` returns that body's index.
The output must have exactly `bodyNames.length * 7` values.
Omitting `out` allocates a new array.
Supplying a retained output avoids allocations during playback.

```js
const pose = new Float32Array(physics.bodyNames.length * 7);
physics.sample(1.25, pose);
const boxOffset = physics.bodyIndex('box') * 7;
const boxHeight = pose[boxOffset + 1];
```

Sampling clamps finite times to `[0, physics.duration]`.
Translations use linear interpolation.
Quaternions use normalized interpolation along the shortest arc.
Times at recorded ticks return their stored poses.
Interpolated poses do not run collision detection and can show small penetrations between frames.
A smaller timestep reduces these interpolation artifacts.

Bindings retain their sample buffer and transformation scratch matrices.
Their `apply(time)` method allocates no arrays during playback.
Bindings validate every target before updating any matrix.
Replacing a target matrix fails before any target changes.
Distinct matrix views must also occupy nonoverlapping byte ranges in their shared buffer.

Affine matrices with independent nonzero scales are supported.
Shear and perspective matrices fail validation.
Reflections use a negative X scale with the same handedness as the original matrix.

## Limits and disposal

`frameCount` defaults to `601` and includes frame zero.
`timestep` defaults to `1 / 60` seconds, rounded to Float32.
The maximum timestep is one second.
`solverIterations` defaults to `8` and accepts integers from `1` through `128`.
`duration` equals `(frameCount - 1) * timestep`.
Long timelines require larger frame limits and memory budgets.

| Option | Default | Maximum configurable value |
| --- | --- | --- |
| `maxBodies` | `256` | `4096` |
| `maxColliders` | `1024` | `8192` |
| `maxJoints` | `512` | `8192` |
| `maxEvents` | `10000` | `100000` |
| `maxFrames` | `3601` | `1000000` |
| `maxMemoryBytes` | `134217728` | `2147483647` |

`planPhysicsScene` validates the full definition without loading Rapier or allocating its world.
Its frozen result contains exact `timelineBytes` and an estimated `solverReserveBytes`.
The reservation accounts for body, collider, joint, and potential contact counts.
`estimatedPeakBytes` must fit `maxMemoryBytes` before WASM initialization and timeline allocation.
The reservation is not a hard measurement or cap on Rapier's WASM heap.
Shared WASM initialization, JavaScript metadata, caller outputs, and visual bindings are outside this estimate.

Numbers must remain finite in Float32.
Positive dimensions, mass, density, and timestep must remain positive after rounding.
Collider volume and inertia scales must also remain finite and positive.

Effective collider masses and conservative minimum inertia estimates must remain normal Float32 values, at least `2 ** -126`.
Their reciprocals and the timestep reciprocal must remain finite and positive.
This restriction prevents Rapier from treating very small masses or inertias as zero.
The minimum inertia estimate uses `0.1 * mass * smallestExtent ** 2` for each collider.
Compound bodies add these lower bounds.

Gravity, initial velocities, and impulse vectors must have finite Float32 squared norms.
Preflight also bounds accumulated velocity from gravity and declared impulses.
Angular bounds include torque impulses and off-center impulses divided by the minimum inertia estimate.
Lever-arm estimates include initial positions, collider offsets, and conservative travel over the whole recording.
These estimates ignore damping and contact resistance, so they can reject otherwise usable configurations.

Joint controls also have explicit public bounds after Float32 rounding.
Revolute limits and position targets stay within `[-Math.fround(Math.PI), Math.fround(Math.PI)]`.
Prismatic limits and position targets stay within `[-1e6, 1e6]`.
Motor speed targets stay within `[-1e4, 1e4]`, gains cannot exceed `1e6`, and force caps cannot exceed `1e8`.
Nonzero targets and damping must not round to zero.

Preflight checks motor force and step-impulse squared norms, gain products with the timestep, and nonzero target-driven impulse estimates.
Positive squared estimates must remain normal Float32 values, so extremely weak controls can fail validation.
It aggregates peak force caps across connected joint components for the complete recording duration.
Every dynamic body in such a component receives conservative linear and angular acceleration bounds from those forces and torques.
Anchor lengths and collider offsets bound motor torque and the corresponding linear motion.
The resulting acceleration, speed and position estimates must remain within their validated Float32 ranges.

These bounds deliberately ignore motor disable intervals, joint limits, damping and contact resistance.
They can reject long recordings or unusual mass and inertia ratios that can otherwise simulate successfully.
They preserve the existing mass and inertia checks and include motor-induced motion instead of checking authored targets alone.

Kinematic translation changes divided by the timestep must have finite Float32 squared norms.
Kinematic rotation targets require a finite squared bound of `(Math.PI / timestep) ** 2`.
Same-tick translation targets use the previous integrated translation for these checks.
These checks cover declared motion, without guaranteeing bounds on every force from contact or constraint solving.

Rapier's internal motion limits can also change finite extreme velocities.
The preflight checks prevent known overflow cases.
They do not promise preservation of arbitrarily large authored speeds.

Large translations can lose small movements through Float32 rounding.
For example, `16777217` becomes `16777216`.
Nonfinite solver outputs fail the bake and release the world.
The bake also validates actual linear and angular velocity squared norms at every recorded frame.

Every completed or failed bake frees the Rapier world and its contained solver resources.
`physics.dispose()` releases the recorded timeline reference and is safe to call repeatedly.
Sampling, binding creation, body lookup, and existing bindings fail after disposal.
Caller-owned arrays and part matrices remain available.
The shared Rapier module and its reusable WASM memory remain initialized.

JavaScript and WASM allocators can retain freed capacity for reuse.

## Design and boundaries

Two API shapes were considered.
One exposed a mutable solver world with delta-time callbacks.
The selected shape accepts a serializable body graph and explicit tick events, then records a bounded timeline.
This shape makes film seeks independent of playback order and keeps solver state out of render callbacks.

Two motor control shapes were considered.
A live `scene.joint(name).setMotor(...)` API exposes mutable solver state and callbacks during playback.
The selected shape adds complete joint motor snapshots to the existing serializable definitions and tick events.
This preserves pre-async validation, deterministic bake order and arbitrary recorded seeks after the solver world is freed.

The addon supports rigid-body contacts, compound colliders, impulses, kinematics, articulated graphs, and single-coordinate joint limits and motors.
It does not implement soft bodies, spherical multi-axis controls, or live solver editing.
It does not bind physics directly to skeletal bones or generate a humanoid skeleton.
Those features need additional public contracts.
Creating a scene bakes synchronously after asynchronous WASM initialization and can block the main thread.
A worker integration can move that bake off the render thread.

## Mesh colliders, sensors and masks

A collider takes `shape: 'convexHull'` with `points` (flat xyz, at most `maxHullPoints`, default 2048) or `shape: 'trimesh'` with `vertices` and `indices` (at most `maxColliderTriangles` triangles across the scene, default 20000).
Counts are checked before any typed array is allocated, and indices must point at a vertex.
A trimesh needs a `fixed` or `kinematic` body, because it encloses no volume to take a mass from.
Use a convex hull for a dynamic body; its true mass comes from the hull, and the bounding box only sizes the safety checks.

`sensor: true` makes a collider report overlaps without pushing anything.
`groups` and `mask` are 16-bit integers. Two colliders touch only when each one's `groups` shares a bit with the other's `mask`.
Both default to `0xffff`.

The recorded scene lists what happened:

- `contactEvents`: `{ frame, kind: 'contact' | 'sensor', started, colliderA, colliderB }` in step order, with indices into `colliderNames`. `contactEventsTruncated` is true past `maxContactEvents` (default 4096).
- `restFrames`: per body, the frame from which it stays under 0.02 m/s and 0.05 rad/s until the end, or `-1` while it still moves.

`bakePhysicsScene` is the synchronous twin of `createPhysicsScene`. Await `loadPhysicsEngine()` once, then bake without awaiting.
`setPhysicsModuleLoader` replaces how Rapier is imported, for a host that serves it from a URL, as the MCP preview does.

## Recipe physics

A scene recipe takes a `physics` section, and `set-physics` edits it (`null` clears it):

```json
"physics": {
  "duration": 3,
  "gravity": [0, -9.81, 0],
  "bodies": [
    { "node": "tray", "type": "fixed", "shape": "trimesh" },
    { "node": "ball-1", "shape": "ball", "restitution": 0.3, "layer": 1, "collidesWith": [0] }
  ],
  "joints": [{ "type": "revolute", "bodyA": "door", "bodyB": "frame", "axis": [0, 1, 0], "limits": [0, 1.5] }]
}
```

Each body is a root node with a geometry. Its collider is fitted to that geometry at the node scale: `box`, `ball` and `capsule` from the bounds, `convex` from at most 2048 distinct vertices, `trimesh` from every triangle.
Defaults are `box` for dynamic bodies and sensors, `trimesh` for fixed ones.
`layer` (0 to 15) and `collidesWith` replace raw bit masks.
A node cannot have both a physics body and a motion `translation` or `rotation` track.
Limits: 64 bodies, 64 joints, 10 seconds, 60 steps a second, so at most 601 frames.

The bake runs once, when the scene is created or the section changes, and is reused while the section and the geometry stay the same.
After that the scene treats physics like motion: `sampleMotion(time)` and the MCP `motionTime` read the recording, so a seek back gives the same matrices. A time past `duration` holds the last pose, and `null` restores the authored pose.
Rapier is loaded on demand, an optional peer dependency. The MCP runtime serves it from `node_modules` to the preview page, like Manifold, so the server bundle does not carry it.

`scene_inspect` returns a `physics` report: per body the `finalPosition`, `finalSpeed` and `restsAtTime` (null while moving), the `contacts` between bodies with `firstTime`, `count` and `touchingAtEnd`, and the sensor `enter` and `leave` events with times.
An agent can check that a ball came to rest on a mesh from these numbers, without a picture.

## Recipe ragdoll

Part of issue #96. A ragdoll binds one physics body to every bone of a rig and writes the simulated result back as the local pose of each bone node, so skinning, export and seeking work as for any other pose.

```json
{ "physics": { "duration": 4, "bodies": [{ "node": "floor", "type": "fixed" }], "ragdoll": { "armature": "rig" } } }
```

For a recipe armature, `ragdoll.armature` names it. The optional `density`, `friction`, `restitution` and `layer` (default 1) apply to every bone. An imported asset takes `physics: { duration, floor, gravity, ragdoll }` in its own recipe (`set-physics` edits it); every joint of the asset becomes a bone, `floor` is a world height (default 0) and the character falls from the pose its clip and overrides give at the start.

- Each bone is one capsule from its head to its tail, joined to its parent bone by a spherical joint. Bones never touch each other, so the capsules at a joint do not push apart. The lightest bone weighs a quarter of the longest, because a joint between a very light and a very heavy body blows up the solver.
- The bake is a table of poses by time, recorded at 60 frames a second for at most 10 seconds and 48 bones. A seek to the same time gives the same bytes, and an unchanged section on an unchanged rig reuses the last bake.
- Joints have no swing limits, and Rapier has none for a spherical joint. Linear blend skinning inverts where neighbouring joints turn about 180 degrees apart, and the engine refuses such a pose, so a posed bone stays within 120 degrees of its rest pose. In a deep fold the drawn bone can therefore differ from its collider, and a joint can sit below the floor by a fraction of a bone length. The report is read from the colliders.
- Rigs need uniform scale above the bones (a scale of 100 on an armature node is fine). A bone with no length, more than 48 bones, a bone with a translation or rotation track in the same recipe, or a missing floor body in a scene recipe is refused or falls forever.
- On an asset, physics wins over motion tracks and `ik` on joints.
- `scene_inspect` returns `physics.ragdoll`: `bones`, `lowestY`, `highestY`, `fastestFinalSpeed` and `restsAtTime` (null while still moving). Read those instead of a picture.
- Rapier stays an optional peer. A recipe without `physics` loads none of this code.

## Recipe cloth

A recipe `cloth` section records deformable sheets with a position-based solver (`src/cloth.js`, `src/agent-cloth.js`). It needs no peer dependency and loads on demand with the `cloth` module, so a scene without cloth pays nothing.

```json
{ "geometries": [{ "id": "flag", "type": "grid", "segments": 20 }, { "id": "ball", "type": "sphere" }],
  "nodes": [{ "id": "flag", "geometry": "flag", "material": "cloth", "translation": [0, 2.5, 0], "scale": [2, 1.2, 1] },
            { "id": "ball", "geometry": "ball", "material": "stone", "translation": [0.2, 1.4, 0.35], "scale": [0.3, 0.3, 0.3] }],
  "cloth": { "duration": 3, "wind": [4, 0, 2],
             "sheets": [{ "node": "flag", "pin": ["left"] }],
             "colliders": [{ "node": "ball", "shape": "ball" }] } }
```

- A sheet is a root node with any triangle mesh. The `grid` geometry (`segments` 1 to 64) is a flat unit sheet in XY facing +Z, sized by the node scale. Vertices at one position share a particle, so a seam does not tear.
- `pin` holds edges of the local bounds in place: `top`, `bottom`, `left`, `right` or a corner such as `topLeft`.
- Sheet fields: `stiffness` (0.01 to 1, default 0.9), `bend` (0 to 1, default 0.1), `density` in kg/m2 (default 0.2), `damping` in 1/s (default 0.3), `friction` (default 0.3) and `thickness` in metres (default 0.01). `gravity` and a steady `wind` in m/s sit on the section.
- Colliders are fixed root nodes fitted to their geometry bounds as a `ball` or an oriented `box` (default). A thin box is a floor.
- A sheet or fixed collider cannot have a motion translation or rotation track or a physics body. No cloth-to-cloth or self collision, and no soft bodies yet.
- Moving colliders and pins follow any node or bone, including a walking character, and are read at every solver substep, so a seek still equals playing to that time:
  - `{ "attach": "leftHand", "shape": "ball", "radius": 0.08, "offset": [0, 0, 0] }` is a ball on a node. `{ "attach": "upperArm", "shape": "capsule", "to": "lowerArm", "radius": 0.05 }` runs a capsule from one node (plus `offset`) to another (plus `toOffset`). Radius 0.001 to 10 m.
  - `{ "armature": "rig", "radiusFraction": 0.2, "exclude": ["head"] }` adds one capsule per bone, head to tail, the radius a fraction (0.02 to 0.5, default 0.2) of the bone length as the ragdoll fits it. A bone with no length is skipped.
  - A sheet on a mesh geometry can hold chosen vertices with `pinGroup: "hem"`, the name of a vertex group made by a `vertex_group` mesh edit; vertices of weight 0.5 or more are pinned, on their own or together with `pin`. An unknown name fails and lists the groups the mesh has.
  - A sheet's `pinTo: { "node": "chest", "weight": 1 }` makes the pinned edges (`pin`) ride that node, keeping their rest offset in its space. Weight 1 holds them on the node; 0.01 to under 1 pulls them toward it by that fraction on every pass, so they sag and lag.
  - Up to 64 moving balls and capsules, counting every bone. The node poses come from the recipe's motion tracks and IK; a physics ragdoll or body is not followed. Points are pushed out of the capsules, not whole triangles, so a coarse sheet can still cut a corner of a thin limb: use a finer grid than the limb is wide. A cape on the reference walker (24 by 24 grid, 5 s, about 2.5 s to bake on the dev machine) stays outside every limb capsule in `tests/cloth-moving.test.js`.
- The bake runs when the scene is created: 60 frames a second, 4 substeps and 8 constraint passes a frame, constraints solved in a fixed order with no random numbers. `sample(time)` blends the two nearest frames, so the same time always gives the same positions and a seek backwards repeats them. Time zero is the authored sheet and a time past `duration` holds the last frame.
- Limits: 8 sheets, 16 fixed colliders, 64 moving ones, 10 seconds, 5000 particles a sheet, 3 million recorded particle positions and 150 million solver operations a bake (about 3 seconds). Larger input is rejected with the limit in the message. A 32 by 32 grid for 4 seconds bakes in about 1.4 s.
- A seek replaces the sheet's part, so the renderer sees a topology change (`topologyRevision`); the MCP preview uses `replaceParts` and `scene_look` with `motionTime` repeats the same PNG bytes (`npm run smoke:agent-cloth`).
- `scene_inspect` returns a `cloth` report: particles, triangles, pinned count and the final bounds of each sheet.

Blender comparison (`scripts/blender-cloth.py`, Blender 5.2.2, default stiffness, mass set from the same kg/m2; `tests/cloth-blender.test.js`):

| Case | Result |
| --- | --- |
| 2 x 1.5 m sheet pinned along its top, 2 s | Mean vertex distance 0.08 percent of the height, free edge 1.2485 m against 1.25 m. Both hang straight, so this is a weak test. |
| 1.6 m sheet dropped on a 0.4 m ball, drag matched | Falls and lands alike: mean vertex distance 5.6 percent of the sheet size at 0.25 s and 4.9 percent at 0.5 s. Blender then drapes more slowly (17 percent at 1 s, 35 percent at 2 s). No parity is claimed for draping. |

Why the first drape comparison said 63 percent (found while comparing pictures, measured):

- The comparison paired vertices in the wrong order. `scripts/blender-cloth.py` built the flat grid with row 0 on the near edge, while the 67js grid turned flat has row 0 on the far edge, so every vertex was compared with its mirror across the sheet. A flat sheet falling straight scores about 50 percent that way. Pairing the rows correctly takes the mean distance at 2 s from 53 to 7.5 percent for the same two bakes.
- The drag was 180 times apart. Blender's air damping of 1 on a particle of 0.003 kg is a drag of about 54 per second: a falling sheet reaches a terminal speed of 0.18 m/s (measured in free fall, 1 to 2 s and 2 to 8 s both 0.17 to 0.18 m/s). 67js defaults to 0.3 per second, so one sheet landed in 0.4 s and the other took over 2 s. The earlier note tried damping 3 and 8; the matching value is about 54, so `damping` now accepts up to 100. Blender air damping 0.1 (5.4 per second) lands like 67js within 5 percent.
- With air damping 0 Blender's sheet falls through the ball at 2 s (centre vertex at -1.1 m), so a lower drag in Blender is not free either.
- What remains is a model difference, not a defect: matched, the mean distance is 17 percent at 1 s and 35 percent at 2 s, because Blender's sheet drapes slowly as a wrinkled bell (friction 5 on collision, tension 15, bending 0.5) and this one hangs smooth flat panels over the ball (pictures in `bench/reference/images/cloth-drape-*.jpg`). Nothing was tuned to close that gap.

Earlier drape measurements (old pairing, Blender air damping 1, 67js defaults; same 13 x 13 grid, 1.6 m sheet at 1 m, ball radius 0.4 m, mass 0.2 kg/m2, Blender 5.2.2 default stiffness, quality 8). Only the stretch rows still say something:

| | 67js | Blender |
| --- | --- | --- |
| Longest edge over rest length, at 2 s | 1.021 | 1.048 |
| Mean edge over rest length, at 2 s | 1.001 | 1.007 |
| Sheet area over rest area, at 2 s | 1.003 | 1.013 |
| Frames simulated | 481 (8 s, 4 substeps each) | 481 (8 s) |
| Nearest vertex to the ball centre when resting on it | 0.410 (radius + 0.01 thickness) | 0.427 (radius + 0.01 ball distance + 0.01 cloth distance, plus the 48-segment sphere) |
| Mean vertex motion in the last 2 s | 0.025 m, nearly settled | 0.30 m, still sliding off the ball |

- Stretch is far inside 10 percent in both solvers, so stiffness or iteration count does not explain the gap; `tests/cloth-blender.test.js` pins the 67js drape to 10 percent per edge and 5 percent in area.
- The setups match except collision margins, which differ by 17 mm and are too small to matter.

Picture comparison (`npm run reference -- --cloth`, scores in `bench/reference/cloth.json`, method and table in `bench/reference/README.md`): the banner scores at the EEVEE yardstick (FLIP 0.043 and 0.044 against Cycles, EEVEE 0.042) and the drape at about twice it (0.080 to 0.093 against 0.039 to 0.043). By eye, Blender's cloth wrinkles and bells over the ball, and this solver gives smooth flat panels. The solvers differ in kind, so these scores say how alike the motion is, not that one is right. Soft bodies are not built; see the ledger.

Repeat recordings require identical inputs, creation order, timestep, solver options, and Rapier version.
Rapier documents cross-platform determinism for its WASM solver under identical initial conditions.
Input calculations such as `Math.sin` can differ across platforms and invalidate that guarantee.
This addon does not promise identical trajectories across different Rapier versions.
The implementation uses `@dimforge/rapier3d-compat` version `0.21.0`, licensed under Apache 2.0.

Sources: [Rapier JavaScript setup](https://rapier.rs/docs/user_guides/javascript/getting_started_js/), [Rapier joints](https://rapier.rs/docs/user_guides/javascript/joints/) and [Rapier determinism](https://rapier.rs/docs/user_guides/javascript/determinism/).

## Live cloth

A game steps cloth one frame at a time, with pins that move and change while it runs. `createCloth(positions, triangles, options)` is the solver `bakeCloth` records from (`bakeCloth` is now a loop over it), so a live run and a baked recording of the same input give the same numbers, frame for frame. It lives in `src/cloth.js`; the recipe `cloth` section above still bakes ahead of time.

```js
import { createCloth } from '@codepawlhq/67js/addons/cloth';

// A 1 m square sheet, 33 x 33 particles, with two grippers holding two corners.
const cloth = createCloth(positions, triangles, { density: 0.2, bend: 0.1 });
const leftCorner = 0;
const rightCorner = 32;
cloth.pin(leftCorner, leftGripper.position);
cloth.pin(rightCorner, rightGripper.position);

function frame(deltaSeconds) {
  // Move the grippers first, then hand the targets to the sheet. Each step carries the pins there in even strides.
  cloth.pin(leftCorner, leftGripper.position);
  cloth.pin(rightCorner, rightGripper.position);
  cloth.step(deltaSeconds, { wind: [0, 0, 1] });
  const pull = cloth.pinForce(leftCorner);
  if (Math.hypot(...pull) > gripStrength) cloth.unpin(leftCorner); // the grip slips and the sheet falls on that side
  sheetGeometryPositions.set(cloth.positions);
}
```

- `step(deltaSeconds, { wind, colliders })` runs 4 substeps of 8 constraint passes. `wind` (m/s) and `colliders` replace the ones in the options for this step only; the other options are fixed at creation. `cloth.positions` is one `Float32Array`, 3 numbers a particle, rewritten in place by every step.
- `pin(index, position)` holds a particle at `position`, or where it is now when none is given. Calling it again moves the target, so a gripper that follows a hand calls it every frame. `unpin(index)` lets go; the particle keeps its velocity. `isPinned(index)` reads the state.
- `pinForce(index, out)` writes the force the cloth pulls the pinned particle with, in newtons, averaged over the last step: `out = [x, y, z]`, so its length is the load. It is an estimate taken from the corrections the solver made, not a measurement: a sheet hanging still from its top row loads the pins with roughly its weight (`cloth.particleMass * particleCount * 9.81`).
- `setExtraMass(index, kilograms)` hangs mass on a particle on top of `cloth.particleMass` (density times area, shared evenly). A heavy particle moves less when the constraints pull, so the sheet sags around it.
- Tearing: `tearStretch` (a stretch constraint breaks when its length passes this multiple of its rest length) and `tearForce` (it breaks when it carries more than this many newtons) are options; both default to never. The bend constraint across a broken edge breaks with it. `cloth.broken` lists them in order as `{ constraint, first, second, kind }`, where `first` and `second` are particle indices and `kind` is `'stretch'` or `'bend'`; `breakConstraint(edge)` tears one by hand. A broken constraint never heals, and the triangles are not removed: hide a triangle whose edge is in the list to show the tear.
- A particle index is a welded particle (`weldVertices` maps mesh vertices to them), as in `bakeCloth`.

## Deforming a drawn part in place

`updatePartVertices(renderer, part, positions, normals)` writes new vertex positions, and normals when given, into the buffers a rigid part already uses, with `bufferSubData`. It needs no `replaceParts`, no new geometry object and no new draw batch. It comes from `@codepawlhq/67js/addons/update-part-vertices`, takes the renderer as its first argument and imports nothing from the renderer, so a scene that never deforms a mesh does not carry it.

```js
import { updatePartVertices } from '@codepawlhq/67js/addons/update-part-vertices';

updatePartVertices(renderer, sheetPart, sheetPositions, sheetNormals);
renderer.render(frame);
```

- The vertex count cannot change, and the arrays are `Float32Array`s of 3 numbers a vertex. The values are copied into the part's geometry, so the geometry stays the truth, and every part that uses the same geometry deforms with it.
- It refuses skinned, morphed, crowd and level-of-detail parts. A textured part works, since only positions and normals move.
- The culling bounds and the shadow map follow the new positions.
- Per vertex a cloth steps on welded particles, so copy each vertex from its particle (`weldVertices(...).particleOfVertex`) and recompute normals (`recomputeNormals`) before the call.

## Force fields

One list of up to 8 fields, `fields` on the `particles` section and on the `cloth` section, accelerates every particle, hair strand and cloth particle through the same evaluation (`src/force-fields.js`, `evaluateForceFields`). Each field has a `type`:

| type | acceleration | keys |
| --- | --- | --- |
| `wind` | `strength` m/s2 along `direction` (default +x) | `direction` |
| `drag` | `-strength` times the velocity, in 1/s | |
| `vortex` | `strength` m/s2 around `axis` (default +y) through `position`, along axis cross offset | `axis` |
| `magnet` | `strength` m/s2 toward `position`; a negative strength pushes away | |
| `turbulence` | smooth seeded value noise, each component within `strength` | `seed`, `scale` (cycles per metre, 1), `rate` (cycles per second, 0.5) |

Every field also takes `strength` (default 1, -1000 to 1000), `position` (default the origin), `falloff` (exponent of 1 / (1 + distance from `position`), 0 means none) and `radius` (cutoff distance, 0 means none). Unknown keys are rejected with the list of known ones.

- Particles under fields have no closed form, so each one is integrated from its own birth at a fixed 1/120 s (semi-implicit Euler, gravity, drag toward the wind, then the fields) every time it is asked. It is still a pure function of time: a seek back repeats exactly, and the same seed gives the same frames. The floor stops a particle where it lands. Cost grows with age, about the age times 120 steps for each live particle.
- Cloth adds the fields to the velocity of every particle at each of the four substeps, with the substep time as the turbulence time, so the recording stays deterministic.
- Hair leans: the strand tip moves by 0.02 m for each m/s2 of field acceleration at the strand root (no velocity, so drag does nothing), clamped to the strand length. A strand without turbulence builds once.
- `tests/force-fields.test.js` checks each type against a known particle path (wind against constant acceleration, drag against the exponential, magnet against free fall toward a point, vortex against the swirl direction), falloff, seeds and seeks.

## Recipe particles and hair

A recipe `particles` section holds up to 4 systems (`src/particles.js`, `src/hair.js`, `src/agent-particles.js`). It needs no peer dependency and loads on demand with the `particles` module, so a scene without particles pays nothing. Blender's particle system has the same two kinds, Emitter and Hair.

```json
{ "geometries": [{ "id": "speck", "type": "box" }],
  "nodes": [{ "id": "sparks", "geometry": "speck", "material": "glow" }],
  "particles": { "systems": [{ "node": "sparks", "seed": 11, "count": 300, "rate": 150, "lifetime": [0.8, 1.6],
                               "speed": [2, 4], "spread": 35, "size": 0.035, "drag": 0.3, "floor": 0, "scale": "shrink",
                               "emitter": { "shape": "disc", "position": [-0.8, 0, 0], "radius": 0.15 } }] } }
```

- An emitter system draws its root node's own geometry once per particle, so keep the shape low-poly. The node's transform does not move or scale particles. `count` is at most 2000 a system and 4000 in total, and at most 100000 vertices are drawn in total (a box is 24 per particle, so a default sphere is too heavy).
- Fields and defaults are in `scene_capabilities` under `particles`: `seed`, `count`, `rate` (omit for one burst at time 0), `lifetime`, `speed` and `size` (a number or `[min, max]`), `direction`, `spread` (cone half angle, degrees), `emitter` (`point`, `box`, `sphere` or `disc`), `scale` (`constant`, `shrink`, `grow`), `drag` and `floor`. `gravity` and a steady `wind` sit on the section; wind pulls the velocity only where `drag` is above zero.
- A particle is a closed-form function of its own seeded launch values and the time (drag, wind and gravity have an exact solution), checked against a 1e-5 s integration in `tests/particles.test.js`. There is no stepping, so the state at time t never depends on earlier seeks: the same time gives the same particles, a seek backwards repeats them, the same seed gives identical bytes, and raising `count` keeps the particles already there. The landing time on a `floor` is found once per particle from its launch values.
- A hair system (`type: "hair"`) grows `count` strands from area-weighted seeded points of a `surface` node into its own `node` (the surface is only read, so several systems can share one). A strand is a triangular tube of 1 to 8 segments tapering to 15 percent, leaning off the surface normal by `lean`, bending with `droop`, and swaying by `sway` metres along the horizontal wind at `swayRate` hertz. Without `sway` the mesh is built once.
- Both kinds replace their node's part at each sampled time, so the renderer sees a topology change. `npm run smoke:agent-particles` seeks sparks and hair through the MCP preview, repeats the PNG bytes after a seek back and checks that a second session renders the same bytes.
- `scene_inspect` returns a `particles` report: per emitter the particle count, vertices per particle, `maxAlive` and `endsAt`; per hair system the strands, segments and vertices per strand.
- Collision (#614): `colliders` lists up to 8 static root nodes (4096 triangles in total, read only); particles bounce off their triangles and the floor plane with `bounce` (0 to 1; 0 sticks where it lands; 0.3 with colliders, 0 on a floor alone) and `friction` (0 to 1, 0.5): Coulomb friction removes friction times the normal impulse from the speed along the surface, so a slider slows and stops, and spin is damped by each contact. A particle on a collider, a force field or a bounce is stepped at 1/120 s from its birth with the path tested against the triangles, so a fast particle cannot tunnel through a thin mesh. A bounce slower than 0.4 m/s is zeroed (no micro-bounces), so the particle slides, and a slow slider settles. `spin` (deg/s, a number or [min, max]) turns each particle about a seeded axis until it settles. `color` ([r,g,b] at birth, [r,g,b] at death) and `alpha` (a number or [birth, death]) become vertex colours; the renderer has no per-vertex alpha, so alpha multiplies the colour: a particle fades toward black, which reads as a fade on a dark background but does not become see-through. Whole steps are remembered per particle, so playback costs one frame of steps and a seek back replays from birth, with the same bytes. Measured with 2000 particles of 60 s bouncing on a box: a seek to the end took about 0.5 s and playback about 3.5 ms a frame; most particles settle early, a particle under a field that never settles costs its whole age at every seek back.
- Not included: collision between particles, collision with a moving node, particles that follow a moving node, hair collision, combing, clumping, children, hair on a skinned surface, UVs on hair (so textured materials do not apply) and fur shading.
- Measured on the dev machine: creating a scene with 4000 box particles (96000 vertices) takes about 57 ms, and each seek takes 8 to 15 ms; the test bounds a seek at 150 ms.

No Blender parity is claimed for either kind: Blender's particle physics, force fields, children and hair dynamics are not reproduced, and no comparison against a Blender render was run.

### Decision: smoke, fire and liquid in the browser

Smoke and fire: not built. The grid solver is the cost, not the volume look. A naive CPU step (semi-Lagrangian advection of density plus 20 pressure passes, unoptimised JavaScript, measured on the dev machine) takes about 0.09 s on a 32 cubed grid, 0.14 s on 48 cubed, 0.46 s on 64 cubed and 1.3 s on 96 cubed. A 10 second clip at 60 frames is 600 steps: about 4.6 minutes of baking at 64 cubed, and 157 MB of density frames at 4 bytes a cell, before velocity and temperature. That does not fit an agent's tool call or the package budget. A recipe can already use the depth-clipped volumetric fog, and emitter particles with `scale: "grow"` for puffs. If smoke or fire becomes a goal, bake a density sequence outside the browser, as Spume does for liquid, and play it back through a volume object, which needs the volume rendering work first.

Liquid: keep `addons/spume` playback and do not add a browser solver. Spume plays a baked liquid as parts in 8793 bytes gzip (the `entry:spume` baseline from `npm run size`), and the bake runs offline in another project. A browser FLIP or SPH solver would add its own code, a bounded step budget and a surface reconstruction, and it would face the same step times as the grid above. No browser liquid solver was written or measured, so no speed claim is made about one. Revisit only when an agent task needs a liquid that Spume cannot play back.
