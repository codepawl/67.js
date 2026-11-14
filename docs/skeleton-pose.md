# Skeleton pose layers and IK

`crucible/addons/skeleton-pose` builds a skeletal pose from clip layers, then corrects it with inverse kinematics. Use it to
wave while walking, add breathing on top of any clip, keep feet on uneven ground, reach for an object or look at a point.

```js
import { loadGltf } from 'crucible/addons/gltf';
import { clipFromGltfAnimation, createAssetPose } from 'crucible/addons/skeleton-pose';

const character = await loadGltf(url);
const clip = name => clipFromGltfAnimation(character.animations.find(animation => animation.name === name), { loop: true });

const pose = createAssetPose(character, {
  layers: [
    { clip: clip('Walk') },
    { clip: clip('Wave'), mask: { joints: ['rightShoulder'] } },
    { clip: clip('Breathe'), additive: true },
  ],
  ik: [
    { type: 'two-bone', root: 'leftUpperLeg', middle: 'leftLowerLeg', end: 'leftFoot', target: (time, foot) => [foot[0], terrain.heightAt(foot[0], foot[2]) + ankleHeight, foot[2]] },
    { type: 'aim', joints: ['spine', 'neck', 'head'], worldForward: [0, 0, 1], maxAngle: 60, target: [2, 1.6, 3] },
  ],
});

pose.apply(seconds);
renderer.updateParts(character.parts);
```

Every `apply(time)` rebuilds the pose from the rest pose: layers in order, then solvers in order. Nothing carries over
between calls, so a backward seek gives the same pose as playing forward, provided your weight and target functions
depend only on their arguments.

## Setup

Use `createAssetPose(asset, { layers, ik })` for a loaded glTF asset. It solves on the asset's whole node hierarchy and
writes through its pose transaction, so every skin moves, and so does every rigid part attached to a bone. Many characters
are built that way, or have several skins. Targets are in the asset's world space, including any scaled or rotated
armature above the bones.

`clipFromGltfAnimation(asset.animations[n], { loop })` converts a clip from the file. `asset.animations` holds three.js
clips, which layers and `retargetClip` cannot read directly. `rename: { clipName: jointName }` sends a clip's track to another
joint of the asset, a retarget by name. Morph weight tracks are not part of this clip.

`morphClipFromGltfAnimation(asset.animations[n], { loop })` reads those morph weight tracks. Give the result as `morphs` on a
layer of `createAssetPose` and the layer drives the face too, with the same `weight`, `speed`, `offset`, `additive` and `reference`.
A layer's `mask` picks mesh parts by the bone that owns them: a mask on an arm leaves the face alone. A layer with `morphs` and
no `clip` drives only morph weights. `asset.stagePose` takes the weights as `morphWeights: [{ part, weights }]`, by index into
`asset.parts`, each between 0 and 1. The RobotExpressive clips carry morph tracks that are all zero, so a real face needs a clip
that sets them.

`createAssetLayerEvaluator(asset, layers).evaluate(time)` returns `{ nodeOverrides, morphWeights }` for a host that stages the
pose itself (the MCP asset recipe does, before it solves IK). The same time always gives the same result.

`createSkeletonPose({ skin, rig, meshWorldMatrix, layers, ik })` is the lower level: it writes one skin's palette, or with
only a `rig` just computes joint positions. `rig` defaults to `createRigFromSkin(skin)` from `crucible/addons/retarget`; pass
one with `rootMatrix` when a scaled node sits above the root joints.

Anywhere a joint is named you can use the joint name or a humanoid bone name such as `leftUpperArm`
(see [retargeting](https://crucible.codepawl.com/retarget.md)), so a setup can move between rigs. An asset's joint names are its decoded node names, in
`asset.nodes[n].name`: the loader removes characters such as dots, so `Foot.L` in the file is `FootL` here.

## Layers

| Field | Meaning |
| --- | --- |
| `clip` | From `createAnimationClip`. Tracks that name no rig joint are ignored; at least one must match |
| `weight` | 0 to 1 (default 1), or a function of time |
| `mask` | `{ joints, descendants = true, exclude }`. The layer touches only these joints. `exclude` removes joints with their descendants |
| `additive` | `true` adds the clip's change from `reference` instead of replacing the pose |
| `reference` | The clip time an additive layer counts as no change, in seconds (default 0) |
| `speed`, `offset` | Layer time is `time * speed + offset`. The clip decides looping |

A normal layer blends toward its clip by `weight`: spherical interpolation for rotation, linear for translation. Joints
its clip does not track keep the pose so far. An additive rotation is `inverse(reference) * sample`, applied in the
joint's own frame (`local = local * delta`), and weight scales the delta. An additive translation adds
`(sample - reference) * weight`. So an additive clip is the same at `reference` as no layer at all.

## Two-bone IK

| Field | Meaning |
| --- | --- |
| `root`, `middle`, `end` | The chain, such as hip, knee and ankle. `end` must descend from `middle`, and `middle` from `root`; twist joints in between are fine |
| `target` | World position, or `(time, endPosition) => position` |
| `pole` | World point the middle joint bends toward, or `(time, middlePosition) => point`. Without one, it keeps the current bend |
| `weight` | 0 to 1 (default 1), or a function of time |
| `keepEndRotation` | Default `true`: the end joint keeps its world rotation, so a foot stays flat while the leg moves |
| `limits` | `{ root: { x: [min, max], y, z }, middle: {...} }` in degrees: the turn away from the joint's rest rotation, per axis of its own, as Euler XYZ. Applied after the solve; `ikResults[n].limited` lists each change as `{ joint, axis, requested, applied }` |
| `bendToward` | World direction the middle joint should bend toward. `ikResults[n].warnings` gets `wrong-bend` when the solve bends the other way, and `hyperextended` when the limb is locked straight. Without it, a limb that rests bent is checked against its rest bend |

The solve is analytic, keeps bone lengths, and turns the two upper joints by the shortest rotations, so twist already in
the pose survives. A limb that is straight in the pose with its target straight ahead has no bend direction, so give
legs and arms a `pole`.

A target out of reach leaves the limb extended toward it. The limit is kept just short of fully straight, because a
perfectly straight limb has no defined bend for the next frame.

## Aim IK

| Field | Meaning |
| --- | --- |
| `joint` or `joints` | One joint, or a chain listed from its base to the aiming joint. A chain shares the turn evenly |
| `worldForward` | The world direction the character faces in its rest pose, such as `[0, 0, 1]`. Use this on real rigs, where bone axes differ |
| `forward` | Instead of `worldForward`: the aiming joint's local axis to point at the target (default `[0, 0, 1]`) |
| `target` | World position, or `(time, jointPosition) => position` |
| `maxAngle` | Degrees (default 180). Limits the whole turn; past it the joint stops at the limit |
| `weight` | 0 to 1 (default 1), or a function of time |

The turn is the shortest rotation, so `aim` does not hold an up direction and can add a little roll.

## Multi-bone Chain IK and Spline IK

`{ type: 'chain', chain: ['b0', 'b1', 'b2', 'end'], target, pole, poleAngle, stretch, iterations, limits, keepEndRotation, weight }` (or `{ type: 'chain', root: 'b0', end: 'end', ... }`, alias `'ik'`) solves chains of two or more bones with cyclic coordinate descent (1 to 64 iterations, default 16). `pole` sets the bend plane and `poleAngle` (-180 to 180 degrees) turns that plane around the root-to-target line. `stretch` (boolean or 0 to 1, default 0) scales bone translations when the target is beyond the chain length, and `limits` clamps per-joint Euler XYZ ranges in degrees.

`{ type: 'spline', chain: ['b0', 'b1', 'b2', 'end'], curve, stretch, weight }` (or `root` and `end`, alias `'spline_ik'`) fits the bone chain along a Catmull-Rom curve of 2 to 64 world points `[x, y, z]` (or a function `time => points`). `stretch` defaults to `true` (1), scaling each bone segment to its arc-length span along the curve; `false` (0) keeps rest bone lengths.

## Reading the result

`pose.jointWorld(name)` returns `{ position, rotation }` after the last `apply`, in world space, for attaching props or
chaining targets. `pose.ikResults` holds one `{ reached, error }` per solver: `error` is metres from the target for
two-bone and radians off target for aim.

## Rigs seen so far

Checked on two real characters. RobotExpressive (rigid parts on bones, four skinned hands, an armature scaled by 100) ran
walk, wave masked to one arm, an additive nod, arm reach and head aim; its clip playback matches the decoder's own within
5e-4, and `tests/skeleton-pose-asset.test.js` runs on it. A Mixamo-style skinned soldier ran walk, feet held on a slope, and
a three-joint aim, by eye only.

Some rigs do not have a limb chain ending at the foot. RobotExpressive's feet are Blender IK controllers, children of the
root rather than of the lower leg, so two-bone IK refuses them with an error; its arms work.

## Limits

- A foot or hand held by IK keeps its rotation from the clip, so a foot on a slope does not tilt to match the ground.
- Uniform scale only, as in the [retargeting](https://crucible.codepawl.com/retarget.md) rig. Clip scale tracks are ignored.
- No joint angle limits. A pole keeps a knee on the right side, but nothing stops a target from bending it too far.
- No full-body solve: moving a hand does not move the hips. Solvers run one at a time, so order them from the base of the
  body outward.
- Clip layers and masks are code only. Recipes and imported assets get IK through MCP with [`motion.ik`](agent-motion.md#inverse-kinematics).
- The [animation mixer](https://crucible.codepawl.com/animation-mixer.md) works on rigid part transforms and has no layers, masks or IK. Use this addon
  for skinned rigs.
