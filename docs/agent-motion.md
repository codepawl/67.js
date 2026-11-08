# Agent motion

Release `0.7.0` adds procedural motion to agent recipes, preview seeks and snapshot render jobs.
The `agent-scene` addon and packaged MCP server share this contract.
The installed package version determines availability.

## Scene and MCP usage

```js
import { createAgentScene } from '67js/addons/agent-scene';

const scene = createAgentScene(recipe);
scene.apply([{ type: 'set-motion', motion }], { expectedRevision: scene.revision });
scene.sampleMotion(1);
renderer.updateParts(scene.parts);
renderer.render(scene.camera);
scene.sampleMotion(null); // Restore the authored base pose.
```

The example assumes a valid recipe, a motion record and a renderer bound to `scene.parts`.
Creation, successful edits and checkpoint restore sample time zero when the recipe contains motion.
`sampleMotion(time)` accepts absolute seconds or `null` to restore base transforms, materials and camera.
It preserves part, matrix, material handle and geometry identities.
It does not regenerate geometry or advance revisions.

MCP `scene_look` accepts optional `motionTime` with the same seconds and `null` semantics.
Omitting `motionTime` preserves the current preview pose.
`scene_inspect` reports authored motion duration, loop, track count and transient time.
Its bounds remain in `authored-base-world` space, independent of the sampled pose.

`set-motion` requires a complete motion record or explicit `null` to clear it.
The final batch must resolve every track reference, including after node or material removal.
Failed edits or seeks preserve the previous recipe, rendered pose and revisions.

Snapshot jobs select motion with `settings.motion: { start: 0 }`.
Frames use `start + elapsed` independently of imported clips and renderer shader time.
Omitting this setting holds the initial motion pose.
Nonlooping job samples must fit the authored duration.
Looping samples wrap, with an absolute maximum of 3600 seconds.
Completion and cancellation preserve the source preview time, revision and checkpoints.

## Authored data

A motion contains one duration, an optional loop flag, and typed keyframe tracks.
Node tracks address final recipe node IDs, including nodes without geometry.
Their values represent absolute local translation, XYZW quaternion rotation, or positive scale.
Material tracks address material IDs and affect every node that shares that material.
Camera tracks omit an ID and address eye, target, vertical FOV, or roll.
Roll uses radians, and FOV uses degrees.

```js
const motion = {
  duration: 2,
  loop: false,
  tracks: [{
    kind: 'node',
    id: 'hinge',
    property: 'rotation',
    interpolation: 'SMOOTH',
    keyframes: [
      { time: 0, value: [0, 0, 0, 1] },
      { time: 2, value: [0, 0, 0.70710678, 0.70710678] },
    ],
  }],
};
```

Node properties are `translation`, `rotation`, and `scale`.
Material properties are `color`, `emissiveColor`, `emission`, `metallic`, and `roughness`.
Camera properties are `eye`, `target`, `fov`, and `roll`.
Untracked properties retain authored base values.
Clipping planes retain authored values. Roll rotates the authored camera up direction.

Tracks support `LINEAR`, `STEP`, `SMOOTH`, and `CUBICSPLINE` interpolation.
Cubic keys require both `inTangent` and `outTangent`, with the same dimensions as the value.
Tangents use change per second.
Quaternion values normalize through the existing animation core.
Quaternion tangents retain their authored values.
Other interpolation modes reject tangents.

### Easing

A keyframe on a `LINEAR` or `SMOOTH` track takes `easing` for the segment that starts there, so a hit, a settle or an overshoot needs two keyframes instead of several:

```json
{ "kind": "node", "id": "lid", "property": "translation", "keyframes": [
  { "time": 0, "value": [0, 0.2, 0], "easing": "easeOutBack" },
  { "time": 1, "value": [0, 1.2, 0] }
] }
```

Values: `linear`, `cubic-bezier(x1, y1, x2, y2)` (x from 0 to 1, y from -4 to 5), or `ease` + `In`, `Out` or `InOut` + `Sine`, `Quad`, `Cubic`, `Quart`, `Quint`, `Expo`, `Circ`, `Back`, `Bounce` or `Elastic`.
`easeOutBack` is the overshoot and `easeOutBounce` the drop; they match Blender's easings of the same family.
`easeOutBack(overshoot)` takes 0 to 10 (default 1.70158). `easeOutElastic(amplitude, period)` takes an amplitude of 1 to 10 times the change (default 1) and a period of 0.05 to 2 of the segment (default 0.3, or 0.45 for `easeInOutElastic`); either argument can be left out from the right. Other easings take no arguments.
An unknown name, a parameter on the wrong family, or easing on `STEP` or `CUBICSPLINE` is an error that says what to use instead.
Camera and material tracks take the same fields. GLB export bakes an eased track to linear samples.

## Inverse kinematics

`motion.ik` computes node rotations from a goal, so a recipe can say where a hand should be without any quaternions. It
works on procedural recipes and imported assets, and runs after the tracks and any selected clip at every sample, in list order. `tracks` can be empty when a
motion has `ik`.

```json
{ "duration": 2, "tracks": [], "ik": [
  { "type": "two-bone", "root": "shoulder", "middle": "elbow", "end": "wrist", "target": { "node": "ball" }, "pole": [0, 3, -1] },
  { "type": "aim", "joint": "lamp", "target": { "node": "ball" }, "maxAngle": 120 }
] }
```

A `two-bone` solver takes `root`, `middle` and `end` node IDs, each a descendant of the one before. `pole` is the world
point the middle node bends toward; give one, because a straight limb has no bend direction of its own. `keepEndRotation`
defaults to `true`, so a gripper or foot keeps its world rotation.

An `aim` solver takes `joint`, or `joints` from the base of a chain to the aiming node, which then share the turn.
`worldForward` is the world direction the character faces at rest, which is the one to use on imported rigs because their
bone axes vary. Otherwise `forward` is the aiming node's local axis (default `[0, 0, 1]`). `maxAngle` limits the whole
turn in degrees.

`target` and `pole` are each `[x, y, z]` in world metres, `{ "node": id }` to follow a node, or
`{ "keyframes": [{ "time", "value" }], "interpolation" }`. `weight` is 0 to 1 (default 1), or keyframes to fade a solve in
or out. Keyframes count toward the motion's limit of 2048. A motion holds at most 16 solvers.

A node with IK nodes below it needs uniform scale and no scale track, because a non-uniform parent would shear the chain.
Put sizes on a child node with the geometry, or on the last node of the chain, whose own scale does not matter.

`scene_inspect` returns `motionIk`, one `{ type, reached, worstError, atTime }` per solver, from 33 samples across the
clip. `worstError` is metres for two-bone and radians for aim, so a target out of reach shows up without looking at every
frame. A limb that cannot reach stretches toward the target.

On an imported asset, joints are its `node-N` IDs from `scene_inspect` with `kind: "hierarchy"`, and they must be editable.
Each sample stages the clip and overrides, reads the local pose, solves, and stages again, so the rest of the body stays on
the selected clip and skins and rigid parts all follow. Targets are in world space, under the asset's `root`, which needs a
uniform scale. Some rigs have no chain to the foot: if the foot is not a descendant of the lower leg, two-bone IK refuses it.

### Clip layers on an asset

`motion.layers` plays the file's own clips at motion time, so a character can walk and wave at once. Up to 8 layers, in order,
each blending over the pose so far, before tracks and IK:

| Field | Meaning |
| --- | --- |
| `clip` | The `id` of an entry in `scene_inspect` `animations` |
| `mask` | `{ joints, descendants = true, exclude }`, up to 32 node IDs or names each. The layer moves only these joints and what hangs below them; mesh parts follow their bone, and morph weights follow the bone that owns the mesh |
| `weight` | 0 to 1, default 1 |
| `speed`, `offset` | Layer time is `time * speed + offset`. `speed` 0.05 to 8, `offset` within 30 seconds |
| `loop` | Default `true`: the clip repeats. `false` holds its last key |
| `additive`, `reference` | Add the clip's change from `reference` seconds instead of replacing the pose |
| `bones` | Retarget by name: `{ "UpperArmR": "node-20" }` makes the clip's track for `UpperArmR` move that node of this asset. Up to 64 entries; the clip must have the track |
| `morph` | `false` leaves morph weights alone. Default: the clip's morph tracks play |

```json
"motion": { "duration": 2, "loop": true, "layers": [
  { "clip": 10 },
  { "clip": 12, "mask": { "joints": ["node-37"] }, "morph": false }
] }
```

`tracks` can be left out when there are layers. Layers need an imported asset: a procedural recipe refuses them. Everything is
checked against the asset (clip indexes, node IDs and names, track names) and bounded before anything is built, and the
pose is rebuilt from the rest pose for each time, so a seek equals playing. `bones` renames tracks inside one asset.

[Skeleton pose layers](skeleton-pose.md) have the same layers in code.

### A clip from another catalog asset

A layer takes `from: { "asset": "<catalog ID>", "clip": 0 }` instead of `clip`: the clip of another file in the catalog, moved
onto this asset with `retargetClip` and the humanoid bone map. Both skeletons must map the required bones (hips, spine, head,
arms and legs) or the call fails and lists what is missing. `scale` (0.1 to 10) and `rootMotion` (boolean) are the
`retargetClip` options of the same names. `from` replaces `clip` and `bones`, and morph tracks of the source are not carried.
The runtime reads the other asset by its catalog ID (at most 4 at once); a session made without a catalog cannot use it.
The source can be a skeleton-only file (`meshes: 0` in `scene_asset_catalog`, such as the 100STYLE clips): only its clips and joints are read. `scene_create_asset` on such a file fails, since it has nothing to draw.
`scene_inspect` `kind: "hierarchy"` returns `retargets`: per `from` layer, `source` and `target` with `mapped` (bones
matched), `unmapped` (joints no bone claimed, up to 24, with `unmappedCount`) and `missing`.

```json
"motion": { "duration": 1, "loop": true, "layers": [{ "from": { "asset": "<id of the walking file>", "clip": 0 }, "scale": 1.1 }] }
```

### Drive

`motion.drive` (imported assets only; a placed asset takes `asset.drive`) drives a car GLB along a path: wheels found by name and geometry roll and steer with Ackermann angles, the body leans with the speed profile, legs can reverse, and tail lights glow with the brake.
`motion.duration` may be left out and becomes the drive time.
Fields, the `motionDrive` report of `scene_inspect` and the limits are in [vehicle.md](https://67js.codepawl.com/vehicle.md#driving-through-mcp).

### Foot lock

`motion.footLock` (opt-in, needs `layers`) plants the feet. The layers are sampled at 30 frames per second once, and a foot
counts as planted while its ankle is within `contactHeight` of its lowest point in the clip and its horizontal speed is under
`contactSpeed`, for at least three frames. During each planted phase the leg is solved with two-bone IK to where the ankle
touched down, faded in and out over `blend` seconds. The leg bones must map to the humanoid bones, and the root needs a
uniform scale. `true` takes the defaults:

| Field | Default | Meaning |
| --- | --- | --- |
| `contactHeight` | 0.05 | Metres above the lowest ankle height (0.001 to 1) |
| `contactSpeed` | 0.35 | Metres per second (0.01 to 5). A retargeted foot that slides may need a higher value to be found |
| `blend` | 0.1 | Seconds to fade the pin in and out (0.01 to 1) |
| `ground` | none | `{ height = 0, normal = [0, 1, 0] }` in world space: the planted ankle is put on that plane and the sole is turned to the normal. The normal must lean less than 60 degrees from +Y |

The lock reads the layers only: tracks and `ik` are applied after it. `scene_inspect` returns `footLock.feet` with the
planted phases per foot. The hips do not move, so a ground far from the character's floor can be out of reach.

### Light, sun, sky and exposure tracks

On a scene recipe (not an imported asset) four more kinds animate the look, with the keyframes, interpolations and `easing` of
any other track. `light` takes an `id` of `point:N`, `spot:N` or `area:N` (the index in `environment.pointLights` and so on) and
the properties `position`, `color`, `intensity`, plus `direction` on spot and area lights. `sun` (no ID) takes `direction`,
`color` and `intensity`, which set `lightDirection`, `keyColor` and `keyIntensity`. `environment` takes `skyTop`, `skyBottom`,
`fogColor`, `fogDensity`, `volumeFogDensity`, `ambientIntensity`, `fillIntensity`, `environmentIntensity` and
`environmentRotation` (radians; these dim and turn the sky map shown when `environment.world` is true). `effects` takes `exposure`
and `focusDistance`, which needs `effects.depthOfField.blur` above 0 (a camera with an `fStop` focuses on its target, so move the
camera `target` track for a rack focus). Values keep the range of the environment field, and an unknown light, property or kind
fails with the valid ones. Untracked values keep their authored value, and a scene with no such track renders as before.

After `scene.sampleMotion(time)`, `scene.environment` and `scene.effects` return the sampled values (the exported recipe keeps
the authored ones), so a renderer that reads them per frame follows the tracks without a rebuild. Baked light (`bake`) is computed
once and does not follow a moving light.

```js
// A sunset: the sun drops to the horizon, the sky map turns and dims, the exposure rises to compensate.
const sunset = {
  duration: 4,
  tracks: [
    { kind: 'sun', property: 'direction', keyframes: [{ time: 0, value: [-1, 4, 1] }, { time: 4, value: [-4, 0.3, 1] }] },
    { kind: 'sun', property: 'color', keyframes: [{ time: 0, value: [3, 2.8, 2.5] }, { time: 4, value: [3.4, 1.4, 0.6] }] },
    { kind: 'environment', property: 'environmentIntensity', keyframes: [{ time: 0, value: 1 }, { time: 4, value: 0.4 }] },
    { kind: 'light', id: 'point:0', property: 'intensity', keyframes: [{ time: 0, value: 0 }, { time: 4, value: 3 }] },
    { kind: 'effects', property: 'exposure', keyframes: [{ time: 0, value: 1 }, { time: 4, value: 1.4 }] },
  ],
};
```

### Morph weight tracks

A track `{ "kind": "morph", "id": "eyeBlinkLeft", "property": "weight", "keyframes": [...] }` keys the weight (0 to 1) of every
morph target of that name, with the interpolations and `easing` of any other track. It replaces what a layer or the file
gives that target; targets without a track keep theirs. Names come from the file (`extras.targetNames`, the glTF convention
that Blender and face rigs with ARKit names such as `eyeBlinkLeft` and `jawOpen` export); `scene_inspect` returns them as
`morphTargetNames`, and an unknown name fails with the first ones. Tracks can address morph targets only on an imported asset.

### Joint limits and sanity warnings

A two-bone solver takes `limits: { "root": { "x": [min, max], "y": [...], "z": [...] }, "middle": {...} }` in degrees. Each
range bounds how far that joint turns away from its rest rotation, per axis of the joint's own frame, as Euler XYZ (the
order Blender uses). A limited joint is clamped after the solve and the end rotation is restored, so a clamped knee leaves
the foot short of its target and `reached` turns false. `motionIk[n].limited` lists each joint and axis a limit changed:
`{ joint, axis, requested, applied, atTime }`, degrees, first time it happens.

`motionIk[n].warnings` lists `{ code, message, atTime }` once per code:

| Code | When |
| --- | --- |
| `hyperextended` | The middle joint is within 5 degrees of straight: the target is at or past the limb's reach |
| `wrong-bend` | The middle joint bends opposite to its natural side, which a pole on the wrong side produces while the foot still arrives |

The natural side is `bendToward` (a world direction, such as `[0, 0, 1]` for a knee on a character that faces +z) or, when
that is absent, the way the limb is bent in its rest pose. A limb that rests perfectly straight and has no `bendToward` is
never checked for the wrong bend, so give legs and arms one.

## Constraints

`motion.constraints` is a list of Blender-style node constraints, at most 32. Each names the constrained `node` (a recipe
node, or an editable asset node), a `type`, a `target` node where the type needs one, and an `influence`: 0 to 1 (default 1)
or an expression. Influence blends the node's matrix before and after the constraint, location, rotation and scale
separately, as Blender does. Euler angles are XYZ in degrees. `space` is `world` (default) or `local`, local being the node's
own transform under its parent.

| Type | Fields | Meaning |
| --- | --- | --- |
| `copy_location` | `target`, `axes`, `invert`, `offset`, `space` | The chosen axes take the target's location; `offset` adds it to the node's own |
| `copy_rotation` | `target`, `axes`, `invert`, `mix` (`replace` or `add`), `space` | The chosen Euler axes take the target's |
| `copy_scale` | `target`, `axes`, `offset`, `space` | The chosen axes take the target's scale; `offset` multiplies |
| `limit_location` | `x`, `y`, `z` as `[min, max]`, `space` | Clamp the location per axis |
| `limit_rotation` | `x`, `y`, `z` as `[min, max]` degrees, `space` | Clamp the Euler angles per axis |
| `track_to` | `target`, `trackAxis` (default `-z`), `upAxis` (default `y`), `worldUp` (default `[0, 1, 0]`) | Turn the node so its track axis points at the target and its up axis leans toward `worldUp`. Blender's up is Z, so its numbers match with `worldUp: [0, 0, 1]` |
| `child_of` | `target`, `inverse` (`rest` or `none`) | The node follows the target: its world matrix becomes target * inverse * its own. `rest` uses the inverse of the target's rest matrix, so the node stays put until the target moves; Blender's default is `none` |
| `floor` | `target`, `axis` (default `+y`), `offset` | Keep the node on the positive side of the plane through the target, along `axis`, plus `offset` |

| `copy_transforms` | `target` | The node's world matrix becomes the target's |
| `limit_distance` | `target`, `distance`, `mode` (`inside` default, `outside`, `surface`) | Keep the node's world position inside, outside or on the sphere of that radius around the target |
| `limit_scale` | `x`, `y`, `z` as `[min, max]` above 0, `space` | Clamp the scale per axis |
| `stretch_to` | `target`, `restLength` (default: the rest distance), `volume` (`xz` default, `x`, `z`, `none`), `bulge` (0 to 4, default 1), `worldUp` | Aim +y at the target, scale y by distance over `restLength` and x and z by that ratio to the power of minus `bulge` (its square root for `xz`). Z leans toward `worldUp` |
| `locked_track` | `target`, `trackAxis` (default `+y`), `lockAxis` (default `z`) | Turn only about the node's own lock axis so the track axis points toward the target |
| `transformation` | `target`, `source`, `destination` (`translation`, `rotation` or `scale`), `map` (the source axis for each destination x, y, z), `fromMin`, `fromMax` (per source axis), `toMin`, `toMax` (per destination axis), `space` | The target's channel, clamped to its range, sets the node's channel over its range. Rotation is Euler degrees |
| `action` | `target`, `source`, `axis`, `min`, `max`, `destination`, `keys` (2 to 16 of `{ at, value }`, `at` 0 to 1 rising), `space` | Read the curve where the target's channel sits between `min` and `max`; its value sets the node's channel |

Over MCP, the seven newest types (`copy_transforms` to `action`) take `node`, `type` and `args`, an object holding every other
field above (`target`, `influence` and the type's own); the validator names the allowed fields when one is wrong. Direct fields
also work from code, but not both for the same key.

Not covered yet: `use_*` switches on `child_of`, `damped_track`, bone sub-targets and `head_tail`.

## Drivers

`motion.drivers` sets one node component or material property from a bounded expression, at most 32. A target is
`{ "kind": "node", "id", "property": "translation" | "rotation" | "scale", "component": "x" | "y" | "z" }` (rotation is Euler
XYZ in degrees) or `{ "kind": "material", "id", "property" }` for `emission`, `metallic` and `roughness`, or with a
`component` for `color` and `emissiveColor` (`x`, `y`, `z` for red, green, blue). A driven property cannot also have a track.

An expression is JSON data and is never run as code. It is the motion context of the one expression language described in
[field expressions](mesh.md#field-expressions): the same operators with the same results, the same syntax, and limits of 64
parts and 8 levels. Where a field reads mesh attributes, a driver reads `"time"` (seconds) or a node
`{ "node", "property", "component", "space" }`, for example `{ "mul": ["time", 2] }`; vectors, attributes and noise are field
inputs and are rejected here with a message that says so. `sin` and `cos` take radians. One difference remains: `div` by zero
gives 0 in a field but is a non-finite result in a driver, which is an error, so a mistaken driver is reported.

### Evaluation order

For any time, the pose is built in this order and keeps no state between samples, so seeking gives the same pose as playing
to that time:

1. For an asset, the selected clip, then `motion.layers`, then tracks.
2. IK, in list order.
3. Drivers. They read the pose from steps 1 and 2, so one driver never sees another's result.
4. Constraints, in list order. Each reads the pose the ones before it left. Expressions in `influence` read the pose from
   step 2.

IK targets that follow a node see that node before drivers and constraints move it. Material drivers on an imported asset
read node values from the tracks and rest pose, not the clip.

## Authored rigs

A recipe `armatures` list holds skeletons. Each bone has a `name`, a `parent` (a bone name or `null`), a rest `head` in the
armature's own space and an optional `tail`; without one the tail is the mean of the children's heads. Instead of
`bones`, give `preset: "humanoid"` or `"quadruped"` and `fit: { node }` (a mesh node whose bounds size the rig) or
`fit: { bounds: { min, max } }`. `fit.landmarks` moves a bone head by name, or its tail as `<name>Tail`. Presets are
resolved to explicit bones when the recipe is read, so a stored recipe does not change when the mesh does. A humanoid
faces +Z with Y up and uses the `HUMANOID_BONES` names, so `retargetClip` maps it without overrides. Its knees sit a little
forward of the leg line and its elbows a little behind, so a two-bone solve without a pole folds them the right way.
A quadruped lies along Z and names its legs `leftFrontUpperLeg`, `rightHindFoot` and so on.

Every bone becomes a recipe node (ID is `prefix` plus the name; the armature root is a node with the armature's ID), parented
like the bones and carrying the `armature` field. Those nodes are regenerated from `armatures` each time the recipe is read, so edit
bones with `set-armatures`, not `set-node`. Node rotation tracks and `motion.ik` address bones like any node; rotation is local
to the bone head, and at rest it is the identity. Positive X rotation swings a hanging limb backward, so a thigh swings from
negative to positive and a shin folds with positive values.

A mesh node binds with `skin: { armature, maxInfluences, maxDistance }`. Weights are the distance from each vertex to each bone
segment, `((nearest + softness) / (distance + softness))^4`, with the nearest four kept and normalised. Bone heat diffusion
or a geodesic falloff would be smoother where two limbs pass close, but needs a sparse solve per bone; this method depends only on
position, so vertices split at a hard edge get identical weights and seams never open. A vertex farther than `maxDistance`
(default a quarter of the rig's size) from every bone still binds to its nearest bones and is reported as unweighted.
`scene_inspect` returns `rig` per armature with `skinned` (vertices and `unweightedVertices` per node), `bonesWithNoVertices`
and `jointAxisProblems` (`zero-length`, `straight-chain`, `knee-bends-backward`, `elbow-bends-forward`).

`scene_export_glb` writes the bones at rest, the skins and a clip named `motion` baked at 30 frames a second from tracks and
IK (bone nodes only). In code, `scene.rigExport()` returns the `nodes` and `clips` options for `exportGlb`. Skinned parts render and export their
bone-driven shape; the node transform of a skinned mesh does not move it, move the armature instead. The `rigged-walker`
task in `bench/agent-modeling` builds and walks a character this way.

## Internal sampling helpers

`normalizeAgentMotion(input, recipe)` returns canonical plain JSON, or `null` for absent motion.
It copies values, sorts keyframes, and rejects duplicate times, unknown fields, missing references, and duplicate target properties.
References must exist in the final recipe after the entire edit batch.

`compileAgentMotion(motion, recipe)` returns a retained sampler, or `null` for absent motion.
The sampler copies its inputs and reuses the existing animation core and camera path implementation.
Its `sample(time)` method returns `{nodes, materials, camera}`.
The node and material maps contain patches keyed by recipe IDs.
Vector patches use retained `Float64Array` values, while scalar patches use numbers.

Camera vectors use retained `Float32Array` values to validate rounded poses.
The camera output is `null` when no camera tracks exist.

Outputs are borrowed staging buffers.
Callers must copy them before retaining a pose and must not mutate the returned maps, patches, or arrays.
A failed sample leaves previously published sampler outputs unchanged.
The caller must validate composed hierarchy transforms, geometry bounds, and renderer constraints before publishing the rendered pose.
This helper does not regenerate geometry or bind directly to renderer parts.

## Sampling and state

Sampling uses absolute time and does not depend on previous seeks.
Nonlooping clips clamp to the duration, while looping clips wrap modulo the duration.
Sample times must be finite and within zero and 3600 seconds.
Cubic scale and material overshoot fails validation rather than silently clamping.

Material samples retain the agent material domain, including roughness zero.
Combined emission and emissive color must remain within Float32 radiance limits.
Unlit materials also obey the HDR radiance ceiling.

Camera samples reject coincident eye and target positions, invalid up directions, and invalid lenses.

Authoring changes belong in revisioned recipe transactions.
Transient sampling must preserve the canonical recipe, source revision, topology revision, and checkpoint contents.
Checkpoint restore must reconstruct bindings from the restored recipe.
Job snapshots must retain authored motion independently of imported animation and renderer shader time.
Release `0.8.0` reuses this motion contract for [imported character joints](agent-character-motion.md).
The helper does not implement mixer controls, facial morph tracks or live playback clocks.

## Physics beside motion

A recipe can also carry a `physics` section (see "Recipe physics" in `docs/physics.md`). It is recorded once with Rapier and played back through the same `sampleMotion(time)` and MCP `motionTime`, so one seek moves tracks, IK and bodies together.
A body node takes its pose from the recording. A node cannot have a body and a motion translation or rotation track, and a scene may have physics without any motion tracks.

## Bounds and checks

The controller accepts durations between 0.1 and 30 seconds.
A motion requires at least one track.
It can contain at most 128 tracks, 64 keys per track, and 2048 keys in total.
Values and tangents must remain finite at Float32 precision.
The scene integration must also enforce its total recipe byte budget.

1. Run `node --test tests/agent-motion.test.js`.

The CPU tests cover curves, looping, references, bounds, backward seeks, retained buffers, and failed sample publication.
Native rendering and published MCP verification belong to the integration layer.
