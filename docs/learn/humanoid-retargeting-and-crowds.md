# Humanoid retargeting and crowds

`crucible/addons/retarget` is available from version `0.10.0`. It moves a humanoid clip onto another skeleton and offsets many copies in time, so a crowd does not march in step.

## One clip, many walkers

The example calls the real `createCrowd` for a seeded placement, a time offset and a playback rate per walker, and `crowd.sample(seconds)` for each walker's pose tracks. The docs host cannot load a rigged character, so the walkers are blocks posed from those tracks, and the clip only has rotations, so it plays on figures of any size, which is the same reason a retargeted clip works on another skeleton. Drag the slider to change the count and press the button to switch between a grid and a scatter layout. The console prints the first instances, how `mapHumanoidBones` reads the joint names of two rig families, and the cost of each batch of frames.

```js live poster=crowd-walk
import { CrucibleRenderer, box, sphere, createAnimationClip } from 'crucible';
import { createCrowd, mapHumanoidBones } from 'crucible/addons/retarget';

const multiply = (a, b) => {
  const out = new Float32Array(16);
  for (let column = 0; column < 4; column++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k * 4 + row] * b[column * 4 + k];
      out[column * 4 + row] = sum;
    }
  }
  return out;
};
const move = (x, y, z) => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]);
const scale = (x, y, z) => new Float32Array([x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1]);
function fromQuaternion([x, y, z, w]) {
  return new Float32Array([
    1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w), 0,
    2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w), 0,
    2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y), 0,
    0, 0, 0, 1,
  ]);
}

const swing = angle => [Math.sin(angle / 2), 0, 0, Math.cos(angle / 2)];
const track = (target, phase) => ({
  target, property: 'rotation', interpolation: 'SMOOTH',
  keyframes: [{ time: 0, value: swing(0.7 * phase) }, { time: 0.5, value: swing(-0.7 * phase) }, { time: 1, value: swing(0.7 * phase) }],
});
const clip = createAnimationClip({ duration: 1, loop: true, tracks: [track('LegL', 1), track('LegR', -1), track('ArmL', -1), track('ArmR', 1)] });

// Which canonical bones does the addon find in a rig? Real joint names of two families.
for (const [family, jointNames] of [
  ['Mixamo', ['mixamorig:Hips', 'mixamorig:Spine', 'mixamorig:Head', 'mixamorig:LeftArm', 'mixamorig:LeftHand', 'mixamorig:RightArm', 'mixamorig:RightHand', 'mixamorig:LeftUpLeg', 'mixamorig:LeftFoot', 'mixamorig:RightUpLeg', 'mixamorig:RightFoot']],
  ['Unreal', ['pelvis', 'spine_01', 'head', 'upperarm_l', 'hand_l', 'upperarm_r', 'hand_r', 'thigh_l', 'foot_l', 'thigh_r', 'foot_r']],
]) {
  const { mapping, unmapped, missing } = mapHumanoidBones(jointNames);
  console.log(`${family}: ${Object.keys(mapping).length} bones mapped, ${unmapped.length} unmapped, missing`, missing);
}

const shirts = [[0.8, 0.25, 0.2], [0.2, 0.5, 0.8], [0.9, 0.75, 0.2], [0.3, 0.65, 0.35]].map(color => ({ color, metallic: 0, roughness: 0.7 }));
const skin = { color: [0.85, 0.65, 0.5], metallic: 0, roughness: 0.6 };
const trousers = { color: [0.2, 0.22, 0.3], metallic: 0, roughness: 0.8 };
const block = box(0.06, 2);
const headShape = sphere(14, 10);
const limbs = [
  { name: 'ArmL', pivot: [0.33, 1.3, 0], size: [0.14, 0.6, 0.14] },
  { name: 'ArmR', pivot: [-0.33, 1.3, 0], size: [0.14, 0.6, 0.14] },
  { name: 'LegL', pivot: [0.13, 0.7, 0], size: [0.18, 0.7, 0.18] },
  { name: 'LegR', pivot: [-0.13, 0.7, 0], size: [0.18, 0.7, 0.18] },
];

function buildParts(crowd) {
  return crowd.instances.flatMap(instance => [
    { name: `P${instance.index} torso`, geometry: block, matrix: scale(1, 1, 1), material: shirts[instance.index % 4] },
    { name: `P${instance.index} head`, geometry: headShape, matrix: scale(1, 1, 1), material: skin },
    ...limbs.map(limb => ({ name: `P${instance.index} ${limb.name}`, geometry: block, matrix: scale(1, 1, 1), material: limb.name.startsWith('Leg') ? trousers : skin })),
  ]);
}

function pose(parts, crowd, seconds) {
  crowd.sample(seconds).forEach(({ instance, tracks }) => {
    const height = 0.9 + (instance.index * 7 % 5) * 0.06;
    const frame = multiply(instance.matrix, scale(height, height, height));
    const base = instance.index * 6;
    parts[base].matrix = multiply(frame, multiply(move(0, 1.0, 0), scale(0.5, 0.7, 0.28)));
    parts[base + 1].matrix = multiply(frame, multiply(move(0, 1.55, 0), scale(0.18, 0.18, 0.18)));
    limbs.forEach((limb, limbIndex) => {
      const rotation = tracks.find(sample => sample.target === limb.name).output;
      parts[base + 2 + limbIndex].matrix = multiply(frame, multiply(move(...limb.pivot), multiply(fromQuaternion(rotation), multiply(move(0, -limb.size[1] / 2, 0), scale(...limb.size)))));
    });
  });
}

const canvas = document.querySelector('#scene');
const state = { count: 24, layout: 'grid' };
const makeCrowd = () => createCrowd({ count: state.count, clip, seed: 7, layout: state.layout, spacing: 1.4, columns: 6, size: 8, randomYaw: state.layout === 'scatter' });
let crowd = makeCrowd();
let parts = buildParts(crowd);
const renderer = new CrucibleRenderer(canvas, parts);
console.log('first instances:', crowd.instances.slice(0, 3).map(instance => ({ timeOffset: instance.timeOffset, playbackRate: instance.playbackRate })));

const bar = document.createElement('div');
bar.style.cssText = 'position:fixed;left:8px;bottom:8px;display:flex;gap:10px;align-items:center;color:#dde;font:12px system-ui;background:#000a;padding:6px 8px;border-radius:6px';
const slider = document.createElement('input');
slider.type = 'range';
slider.min = 6;
slider.max = 60;
slider.step = 6;
slider.value = state.count;
const layoutButton = document.createElement('button');
layoutButton.textContent = 'layout: grid';
function rebuild() {
  crowd = makeCrowd();
  parts = buildParts(crowd);
  renderer.replaceParts(parts);
  console.log(`crowd of ${state.count} in a ${state.layout}: ${parts.length} parts`);
}
slider.addEventListener('change', () => { state.count = Number(slider.value); rebuild(); });
layoutButton.addEventListener('click', () => {
  state.layout = state.layout === 'grid' ? 'scatter' : 'grid';
  layoutButton.textContent = `layout: ${state.layout}`;
  rebuild();
});
bar.append('count', slider, layoutButton);
document.body.append(bar);

const started = performance.now();
let nextReport = 2000;
function frame(now) {
  const elapsed = now - started;
  const before = performance.now();
  pose(parts, crowd, elapsed / 1000);
  renderer.updateParts(parts);
  renderer.render({ eye: [0, 6, 10], target: [0, 0.9, 0], fov: 42 });
  if (elapsed > nextReport) {
    console.log(`sample + pose + upload + render: ${(performance.now() - before).toFixed(2)} ms for ${crowd.instances.length} walkers`);
    nextReport = elapsed + 3000;
  }
  requestAnimationFrame(frame);
}
new ResizeObserver(() => renderer.resize()).observe(canvas);
requestAnimationFrame(frame);
addEventListener('pagehide', () => renderer.dispose());
```

Every walker plays the same clip at its own time and rate, so the legs are never in step. The pose code touches every instance each frame, which is the cost the GPU crowd path removes. A real character is retargeted with `retargetClip` and baked with `crowd-skinning`, as in the next section.

## Retarget a real clip

1. Build rigs with `createRigFromSkin(asset.skins[0])`. Name families (Mixamo, VRM, Unreal, Rigify, Quaternius) map through `mapHumanoidBones`. Fix a miss with `targetOverrides`.
2. Call `retargetClip(sourceRig, targetRig, clip, { rootMotion })`.
3. Play it with `createSkinClipPlayer(skin, clip).apply(seconds)`, then `renderer.updateParts(parts)`.
4. For a crowd, `createCrowd({ count, clip, seed })` gives placement, time offsets and playback rates. For dozens or hundreds of animated instances, bake the clip once with `crucible/addons/crowd-skinning`, so they draw as a few instanced batches. The plain path needs one skin pose per instance.

```js
import { mapHumanoidBones, createRigFromSkin, retargetClip, createSkinClipPlayer, createCrowd } from 'crucible/addons/retarget';
import { createCrowdRig, bakeCrowdPalette, createCrowdParts } from 'crucible/addons/crowd-skinning'; // import it before the CrucibleRenderer is made

const source = createRigFromSkin(mixamoAsset.skins[0]);
const target = createRigFromSkin(characterAsset.skins[0], { rootMatrix: armatureWorldMatrix });
// asset.animations holds three.js clips; convert them first with clipFromGltfAnimation from crucible/addons/skeleton-pose.
const clip = retargetClip(source, target, clipFromGltfAnimation(mixamoAsset.animations[0]), { rootMotion: false });
console.log(mapHumanoidBones(jointNames, { overrides: { leftLowerLeg: 'shinbone_left' } }));

const rig = createCrowdRig(asset.parts);
const player = createSkinClipPlayer(characterAsset.skins[0], clip);
const palette = bakeCrowdPalette(rig, seconds => player.apply(seconds), { duration: clip.duration, frameRate: 30 });
const crowd = createCrowd({ count: 500, clip, seed: 7 });
const set = createCrowdParts({ rig, palette, instances: crowd.instances });
const renderer = new CrucibleRenderer(canvas, set.parts, options);
// each frame:
set.setTimes(index => crowd.clipTime(index, seconds));
renderer.updateParts(set.parts);
```

## Options

| Call | Option | Meaning |
| --- | --- | --- |
| `mapHumanoidBones(jointNames, { overrides })` | `overrides` | Returns `{ mapping, unmapped, missing }`. Pass `{ leftLowerLeg: 'shinbone_left' }` to fix a miss. |
| `retargetClip(source, target, clip, options)` | `bones` | Default every shared bone: the canonical bones to transfer. |
| | `rootMotion` | Default `true`. `false` removes horizontal hips travel and keeps vertical bob. |
| | `scale` | Default `1`. Extra multiplier on the hips translation. |
| | `frameRate` | Default `30`. Resampling rate; output keyframes are linear. |
| | `sourceOverrides`, `targetOverrides` | Bone fixes, as in `mapHumanoidBones`. |
| `createCrowd({ count, clip, seed, layout, spacing, columns, size, rateJitter, randomYaw })` | `layout` | `'grid'` (centred, `columns` wide) or `'scatter'` (rejection sampling with at least `0.75 * spacing` where room allows). |

Each crowd instance has `position`, `yawRadians`, a `timeOffset` in the clip duration, a `playbackRate` within `1 ± rateJitter` and a column-major `matrix`. `clipTime(index, seconds)` gives the instance's clip time and `sample(seconds)` returns every instance's tracks.

Canonical bone names are in `HUMANOID_BONES`: `hips`, `spine`, `chest`, `upperChest`, `neck`, `head`, then per side `leftShoulder`, `leftUpperArm`, `leftLowerArm`, `leftHand`, `leftUpperLeg`, `leftLowerLeg`, `leftFoot`, `leftToes`, plus optional fingers. `REQUIRED_HUMANOID_BONES` (hips, spine, head, both arms with hands, both legs with feet) must all be mapped, or a `RangeError` lists the `missingBones`.

| Family | Examples |
| --- | --- |
| Mixamo | `mixamorig:Hips`, `mixamorig1:LeftUpLeg`; `Spine1` and `Spine2` are chest and upper chest |
| VRM and Unity humanoid | `leftUpperArm`, `upperChest`, `J_Bip_L_UpperArm` |
| Unreal mannequin | `pelvis`, `spine_01` to `spine_03`, `upperarm_l`, `thigh_l`, `calf_l` |
| Blender and Rigify | `DEF-spine` is the pelvis, `DEF-upper_arm.L`, `DEF-thigh.L`; twist bones stay unmapped |
| Quaternius | `Abdomen`, `Torso`, `UpperArm.L`, `Fist.L` |

## Cost and limits

`npm run benchmark:crowd` draws the CC0 RobotExpressive (19 parts, 3 materials, 187 joints, 29 baked frames, 7,214 vertices) walking at 1280 by 720, no multisampling, with a ground and one shadow map. On an RTX 3060, one run each, 10 frames, update and render included, 500 instances took a median of 5.75 ms (best 4.51) with joints and weights in two attributes, and 8.27 ms (best 6.44) with them packed in one attribute for maps and morph targets. The second run shared the card with other jobs, so read the two as a range of about 5 to 8 ms (docs/retarget.md). The plain path cost about 0.26 ms of JavaScript per instance on a synthetic 3,000-vertex chain, so about 50 instances fit 60 fps.

- Both rigs face the same direction with +Y up, and both rest poses must be the bind pose.
- The clip is resampled at `frameRate`, so cubic-spline and step curves are baked to linear keys. Source scale and non-hips translation tracks are ignored.
- There is no IK, so different proportions can make feet slide or arms intersect the body.

The [retarget contract](https://github.com/codepawl/crucible/blob/main/docs/retarget.md) covers rest-pose assumptions and measured cost. Mixamo clips need the owner's Adobe login to download. The code only consumes files.

## Common mistakes

- Mapping a rig with a missing required bone and not reading `missingBones`.
- A source that faces the other way. Rotate its root first.
- Hundreds of instances on the plain path. Bake with `crowd-skinning` instead.
- Importing `crowd-skinning` after the renderer is created. Import it first.
- A shared seed for every crowd, so all crowds look the same.
