# Humanoid retargeting and crowds

`crucible/addons/retarget` is available from version `0.10.0`. It moves a humanoid clip from one skeleton onto another and
places many skinned copies with their own timing. It only consumes files: Mixamo clips need the owner's Adobe login to download,
and this package never fetches them.

```js
import { loadGltf } from 'crucible/addons/gltf';
import { mapHumanoidBones, createRigFromSkin, retargetClip, createSkinClipPlayer, createCrowd } from 'crucible/addons/retarget';

const source = createRigFromSkin(mixamoAsset.skins[0]);
const target = createRigFromSkin(characterAsset.skins[0], { rootMatrix: armatureWorldMatrix });
// asset.animations holds three.js clips; convert them first with clipFromGltfAnimation from crucible/addons/skeleton-pose.
const clip = retargetClip(source, target, clipFromGltfAnimation(mixamoAsset.animations[0]), { rootMotion: false });

const player = createSkinClipPlayer(characterAsset.skins[0], clip);
player.apply(seconds);
renderer.updateParts(characterAsset.parts);
```

## Rigs

A rig is `{ joints, rootMatrix?, mapping? }`. Each joint is `{ name, parent, translation, rotation, scale }` with the local rest pose,
`parent` as an index (`-1` for a root) and quaternions in XYZW order.
`createRigFromSkin(skin)` builds one from an imported skin: the bind pose becomes the rest pose.
`rootMatrix` is the world matrix of whatever sits above the root joints, such as a scaled Armature node. Pass it when the clip's root
tracks are authored relative to that node. Uniform scale is assumed throughout.

## Bone names

`mapHumanoidBones(jointNames, { overrides })` returns `{ mapping, unmapped, missing }`. Canonical names are in `HUMANOID_BONES`:
`hips`, `spine`, `chest`, `upperChest`, `neck`, `head`, then per side `leftShoulder`, `leftUpperArm`, `leftLowerArm`, `leftHand`,
`leftUpperLeg`, `leftLowerLeg`, `leftFoot`, `leftToes`, and optional fingers such as `leftIndexProximal`.
`REQUIRED_HUMANOID_BONES` (hips, spine, head, both arms with hands, both legs with feet) must all be mapped.

| Family | Examples |
| --- | --- |
| Mixamo | `mixamorig:Hips`, `mixamorig1:LeftUpLeg`, `mixamorigLeftForeArm`; `Spine1`/`Spine2` are chest and upper chest |
| VRM and Unity humanoid | `leftUpperArm`, `upperChest`, `leftToes`, `J_Bip_L_UpperArm` |
| Unreal mannequin | `pelvis`, `spine_01`..`spine_03`, `clavicle_l`, `upperarm_l`, `thigh_l`, `calf_l`, `ball_l` |
| Blender and Rigify | `DEF-spine` is the pelvis, `DEF-upper_arm.L`, `DEF-thigh.L`, `DEF-shin.L`; twist bones (`.001`) stay unmapped |
| Quaternius | `Abdomen`, `Torso`, `UpperArm.L`, `Fist.L`, `Toes.L` |

Left and right come from `Left`/`Right`, `L`/`R` words or `.L`/`_l` suffixes. The first joint that matches a bone wins, so a second
neck or spine joint stays unmapped. When a bone is missing or wrong, pass `sourceOverrides` or `targetOverrides` to `retargetClip`
(or `overrides` to `mapHumanoidBones`) as `{ leftLowerLeg: 'shinbone_left' }`. A rig that misses required bones throws a `RangeError`
whose `missingBones` array and message list them.

## Retargeting

`retargetClip(sourceRig, targetRig, clip, options)` returns a new `createAnimationClip` clip with one rotation track per shared bone,
named after the target joints, and a hips translation track. Any code that plays clips by joint name can play it.

For every bone, the world-space rotation change of the source from its rest pose is applied to the target's rest pose. The target's
local rotation is then taken relative to its own animated parent. T-pose against A-pose, and different local bone axes, therefore end up
pointing the same way. Unmapped target joints keep their rest pose. The hips move by the source's world offset from its rest position,
scaled by the ratio of rest hip heights above the feet (hips to foot along Y, averaged over both legs).

| Option | Default | Meaning |
| --- | --- | --- |
| `bones` | every shared bone | Canonical bones to transfer |
| `rootMotion` | `true` | `false` removes horizontal (X and Z) hips travel and keeps vertical bob |
| `scale` | `1` | Extra multiplier on the hips translation |
| `frameRate` | `30` | Resampling rate; output keyframes are linear |

Assumptions and limits:

- Both rigs face the same direction, with +Y up. A source that faces the other way needs its root rotated first.
- The clip is resampled at `frameRate`, so cubic-spline and step curves are baked to linear keys.
- Source scale and non-hips translation tracks are ignored. Finger and toe bones transfer only when mapped in both rigs.
- The source and target rest pose must be the bind pose (the node pose equals the inverse bind pose). A file that animates away from it is not detected.
- No IK and no retargeting of rotation limits. Different proportions can make feet slide or arms intersect the body.
- Through MCP, an asset recipe plays a clip of another catalog asset with `motion.layers[].from`, and `motion.footLock` plants
  the feet afterwards (two-bone IK with the sole turned to a ground normal); see "A clip from another catalog asset" and
  "Foot lock" in [agent-motion.md](agent-motion.md). In code, `createFootLock` in `src/foot-lock.js` does the same over an
  asset's nodes.

`createSkinClipPlayer(skin, clip, { rig, meshWorldMatrix })` applies a clip to a skin: `apply(seconds)` samples the clip, composes joint
world matrices and calls `updateSkinPose`. The renderer still needs `updateParts` afterwards.

## Crowds

`createCrowd({ count, clip, seed, layout, spacing, columns, size, rateJitter, randomYaw })` is deterministic for a seed. `layout` is
`'grid'` (centred, `columns` wide) or `'scatter'` (rejection sampling with at least `0.75 * spacing` between instances where room allows).
Each instance has `position`, `yawRadians`, a `timeOffset` in the clip duration, a `playbackRate` within `1 ± rateJitter` and a
column-major `matrix`. `clipTime(index, seconds)` gives the instance's clip time and `sample(seconds)` returns every instance's tracks
(buffers are reused on the next call).

### GPU crowds

The plain path (a skin pose per instance) is one batch and one palette upload per instance, about 0.26 ms of JavaScript per instance on the author's
GPU, so about 50 instances fit 60 fps. `crucible/addons/crowd-skinning` draws a crowd of one character and clip as instanced batches instead:

```js
import { createCrowd } from 'crucible/addons/retarget';
import { createCrowdRig, bakeCrowdPalette, createCrowdParts } from 'crucible/addons/crowd-skinning'; // import it before the CrucibleRenderer is made

const rig = createCrowdRig(asset.parts);                       // one geometry per material, a joint per rigid part and skin joint
const palette = bakeCrowdPalette(rig, seconds => pose.apply(seconds), { duration, frameRate: 30 });
const crowd = createCrowd({ count: 500, clip, seed: 7 });
const set = createCrowdParts({ rig, palette, instances: crowd.instances });
const renderer = new CrucibleRenderer(canvas, set.parts, options);
// each frame:
set.setTimes(index => crowd.clipTime(index, seconds));
renderer.updateParts(set.parts);
```

`bakeCrowdPalette` poses the character at evenly spaced frames and keeps every joint matrix in one table, uploaded as one float texture. `pose`
is anything that poses the parts the rig was made from, such as `createAssetPose(asset, ...)` or `createSkinClipPlayer`. Each instance stores two
frame offsets and a blend (in the assembly offset of its parts), so the vertex shader reads the matrices of that instance's own clip time and
blends the two nearest frames (linear in the matrices, 30 frames a second by default). The pose is a pure function of the clip time, so a frame at
any seek time equals the one reached by playing. `crowdVertexAt(palette, geometry, vertex, seconds)` is the same maths on the CPU.

- **Draw calls** are the number of materials times the levels in view, plus the shadow pass, not the number of instances. All instances of a
  material share a part geometry, `lods` and palette, which is what makes them one batch.
- **Culling** uses `palette.bounds`, a sphere in the space of the instance matrix that covers every vertex in every pose of the clip. Instances
  outside the frustum are not drawn, and an instance far enough away uses a coarser level.
- **Levels** come from `createCrowdLods(geometry, { cells })` (on by default in `createCrowdParts`, `lods: false` turns them off): vertices that
  share a grid cell and a dominant joint merge, and keep the joints and weights of one of them, so every level skins with the same palette.
- **Maps and morph targets.** `createCrowdRig` keeps UVs, so materials with maps draw on a crowd (the joints and weights travel packed in the colour
  attribute, 12 bits of joint and weight each). `createCrowdRig(parts, { morphs: true })` keeps a part with morph targets as its own rig part:
  it draws with the weights it has when the rig is made, the same for every instance, at full detail (no levels, and no culling of that part).
  Without the option morph targets are not applied.
- **Far pose rate.** `createCrowdParts({ ..., farPose: { distance, rate } })` and `setTimes(times, eye)`: an instance more than `distance` from
  `eye` holds each pose for `1 / rate` seconds. The pose is still a pure function of the clip time and the eye, so a seek equals playing.
- Limits: at most 4096 joints in a rig; an `assemblyAmount` does not move a crowd; a clip is baked once, so another clip is another palette and
  another batch.

### Recipe crowds

An agent asks for a crowd in a recipe (`scene_create`, `scene_apply`) with the `crowd` field of an asset placement:

```json
{ "id": "people", "asset": { "id": "<catalog asset id>", "crowd": { "clip": 3, "count": 200, "seed": 7, "spacing": 2, "farDistance": 25, "farRate": 6 } } }
```

`clip` is the clip index (`scene_inspect` lists them), `count` is 1 to 1000, and `layout`, `spacing`, `columns`, `size`, `rateJitter`, `randomYaw`, `speed`,
`frameRate`, `lods`, `morphs`, `farDistance` and `farRate` are the options above. The crowd is a group node of generated part nodes (count times the
materials, which count against `maxNodes`), placed by the node transform. The pose depends on the scene time, the seed and the recipe camera, so
a frame rendered at a time equals the one reached by playing to it. `scene_inspect` lists the crowd under `assets` with `kind: "crowd"`, its instances, batches, clip, baked frames,
palette bytes and bound. It loads on demand with the `"crowd":{` marker, so recipes without one pay nothing.

### Measured cost

`npm run benchmark:crowd` (`--cpu` for SwiftShader, `--counts 100,500`, `--instances 20,50` for the plain path) draws the CC0 RobotExpressive
(19 parts, 3 materials, 187 joints, 29 baked frames, 7,214 vertices) walking, 1280 by 720, no multisampling, a ground and one shadow map.
It is a real humanoid made of rigid parts on bones and four skinned hands, merged into the rig.

RTX 3060 (measured, one run each, default benchmark settings, 10 frames, update and render included, 7 draw calls and 1,564 instance draws after culling for 500 instances):

| Shader | Instances | Median ms | Best ms |
| --- | --- | --- | --- |
| Joints and weights in two attributes (first GPU crowds) | 500 | 5.75 | 4.51 |
| Joints and weights packed in one attribute (maps and morph targets) | 500 | 8.27 | 6.44 |

The second run shared the card with other jobs, so read the two as a range of about 5 to 8 ms rather than a cost of the packing.

That is under the 16.7 ms of 60 fps with room for a scene around it. The plain path (a skin pose and a batch per instance) cost about 0.26 ms of
JavaScript per instance on a synthetic 3,000-vertex chain, so about 50 instances fit 60 fps; the crowd path does not grow with a draw call and a
palette upload per instance.

SwiftShader (the path a headless agent has), the median frame of 5 after warm-up. The machine was running other jobs, so two runs a few minutes
apart are given as a range (in the last run, 500 crowd instances and 50 plain ones both took 208 ms):

| Path | Instances | Draw calls per frame | Frame ms |
| --- | --- | --- | --- |
| Crowd | 100 | 7 | 84 to 134 |
| Crowd | 500 | 7 | 136 to 208 |
| One asset per instance | 20 | 632 | 102 to 156 |
| One asset per instance | 50 | 1,407 | 139 to 208 |

On SwiftShader most of a crowd frame is fill and vertex work that a CPU rasteriser does slowly, so these numbers say that the cost no longer grows
with a draw call and a palette upload per instance, not how fast a GPU is. The 7 calls are 3 materials in the colour pass, 3 in the shadow pass and
the ground, for 20, 100 and 500 instances alike. In a 400-instance field seen from one corner, 340 instance draws were issued across the 7 calls,
where every instance would give 1,200 per pass.

Pictures (SwiftShader): one crowd instance against the same robot drawn through the renderer's own rigid and skinned paths at the same pose differs by a
mean of 0.07 of 255, with 0.2 percent of pixels more than 8 levels apart. A crowd of 24 seeked straight to a time and the same crowd played up to it give
identical pixels. The unit tests check the CPU skinning against per-instance joint matrices at frame times and between frames, that every vertex stays
inside `palette.bounds`, and that the frame offsets of a crowd (with a far pose rate) reached by seeking equal those reached by playing.
