# Skeletal and morph animation

A skinned mesh follows a skeleton, and a morph target moves its vertices by stored changes. 67js blends the morph targets first, then deforms the result with the joint palette, all on the GPU. Both poses are small retained arrays that you write each frame and upload with `renderer.updateParts(parts)`.

## A bending column with a bulge

The column has two joints. The upper joint bends it at the middle. A morph target makes it bulge. Drag the sliders for the bend angle and the bulge weight. The console prints the retained palette size and the weights.

```js live poster=skeletal-morph
import { Renderer67, box, createSkinPose, updateSkinPose, createMorphPose } from '67js';


function translation(x, y, z) {
  return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]);
}
function bendZ(angle, pivotY) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  // Rotate about Z around (0, pivotY, 0): T(pivot) * R * T(-pivot).
  return new Float32Array([c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, pivotY * s, pivotY - pivotY * c, 0, 1]);
}

// A box with subdivisions gives vertices along its height. Stretch it to a 2 m column on the floor.
const unit = box(0.02, 10);
const vertexCount = unit.positions.length / 3;
const positions = new Float32Array(unit.positions.length);
const skinIndices = new Uint16Array(vertexCount * 4);
const skinWeights = new Float32Array(vertexCount * 4);
const bulge = new Float32Array(unit.positions.length);
for (let vertex = 0; vertex < vertexCount; vertex++) {
  const x = unit.positions[vertex * 3] * 0.5;
  const y = unit.positions[vertex * 3 + 1] * 2 + 1;
  const z = unit.positions[vertex * 3 + 2] * 0.5;
  positions.set([x, y, z], vertex * 3);
  const upper = Math.min(1, Math.max(0, (y - 0.6) / 0.8));
  skinIndices.set([0, 1, 0, 0], vertex * 4);
  skinWeights.set([1 - upper, upper, 0, 0], vertex * 4);
  const swell = Math.max(0, 1 - Math.abs(y - 1)) * 0.35;
  bulge.set([Math.sign(x) * swell, 0, Math.sign(z) * swell], vertex * 3);
}

const skin = createSkinPose(2);
const morph = createMorphPose(1);
const geometry = {
  positions,
  normals: unit.normals,
  indices: unit.indices,
  skinIndices,
  skinWeights,
  morphTargets: [{ positions: bulge }],
};
const part = { name: 'Column', geometry, matrix: translation(0, 0, 0), material: { color: [0.85, 0.5, 0.3], metallic: 0, roughness: 0.5 }, skin, morph };
const parts = [part];

const jointRest = new Float32Array([...translation(0, 0, 0), ...translation(0, 1, 0)]);
const inverseBind = new Float32Array([...translation(0, 0, 0), ...translation(0, -1, 0)]);
console.log('skin palette floats:', skin.jointMatrices.length, '(2 joints x 16)');
console.log('vertices:', vertexCount, 'morph targets:', morph.weights.length);

const canvas = document.querySelector('#scene');
const renderer = new Renderer67(canvas, parts);
const state = { bend: 0.6, swell: 0.5 };
function draw() {
  const joints = new Float32Array(jointRest);
  joints.set(bendZ(state.bend, 1), 16);
  updateSkinPose(skin, joints, inverseBind, part.matrix);
  morph.weights[0] = state.swell;
  renderer.updateParts(parts);
  renderer.render({ eye: [0, 1.4, 5], target: [0, 1, 0], fov: 38 });
}

const bar = document.createElement('div');
bar.style.cssText = 'position:fixed;left:8px;bottom:8px;display:flex;gap:12px;align-items:center;color:#dde;font:12px system-ui;background:#000a;padding:6px 8px;border-radius:6px';
function slider(label, min, max, key) {
  const wrap = document.createElement('label');
  const input = document.createElement('input');
  input.type = 'range';
  input.min = min;
  input.max = max;
  input.step = 0.01;
  input.value = state[key];
  input.addEventListener('input', () => { state[key] = Number(input.value); draw(); });
  input.addEventListener('change', () => console.log(`${key} = ${state[key].toFixed(2)}`, 'weights:', morph.weights));
  wrap.append(label + ' ', input);
  bar.append(wrap);
}
slider('bend', -1.2, 1.2, 'bend');
slider('swell', -0.5, 1.5, 'swell');
document.body.append(bar);
draw();
addEventListener('pagehide', () => renderer.dispose());
```

The sliders reach beyond 0 to 1 on purpose: morph weights are not clamped, so `-0.5` pinches the column and `1.5` overshoots.

## How the pieces fit

Version `0.4.0` supports four-influence GPU skinning and relative position and normal morph targets.

1. Define static skin influences or relative morph channels before the renderer is built: `skinIndices` and `skinWeights` (four per vertex) and `morphTargets` on the geometry.
2. Assign the matching retained `skin` and `morph` poses to each part.
3. Update the joint palette and the morph weights for the frame you want.
4. Call `renderer.updateParts(parts)` to validate and upload the poses.

`createSkinPose(jointCount)` holds a retained `Float32Array` named `jointMatrices`, 16 floats per joint in column-major order, starting as identity. `updateSkinPose(pose, jointWorldMatrices, inverseBindMatrices, meshWorldMatrix, bindMatrix)` computes `inverse(meshWorld) * jointWorld * inverseBind * bindMatrix` for each joint. `createMorphPose(count)` holds the retained `weights`. The renderer applies the morph deltas before skinning.

Changing topology, influences or pose identities needs a new renderer. Parts that share one pose instance into one batch; separate poses make separate batches.

## Import from glTF

The glTF addon imports supported skins and relative targets, including joint and weight animation. `asset.applyAnimation(time, clipIndex)` updates the retained parts and poses, and you then call `renderer.updateParts`. The [glTF morph contract](https://github.com/codepawl/67.js/blob/main/docs/gltf-morph.md) and the [asset contract](/gltf.md) define the supported subset. The [skinning contract](https://github.com/codepawl/67.js/blob/main/docs/skinning.md) defines supported transforms, four influences and identity requirements. The [morph contract](https://github.com/codepawl/67.js/blob/main/docs/morph-targets.md) defines channel shapes, weight bounds and resource estimates.

## Options

| Field | Where | Rule |
| --- | --- | --- |
| `skinIndices` | geometry | `Uint16Array`, four joint indices per vertex; indices must be valid even when their weight is 0. |
| `skinWeights` | geometry | `Float32Array`, four finite weights in 0 to 1 per vertex, total above 0. The renderer normalizes a copy. |
| `morphTargets` | geometry | 1 to 64 (`MAX_MORPH_TARGETS`) targets, each with `positions` and/or `normals` as `Float32Array` XYZ deltas per vertex. |
| `skin`, `morph` | part | The retained poses from `createSkinPose` and `createMorphPose`. |

Joint matrices must be finite, affine and nonsingular. Weights can be negative or above one.

## Common mistakes

- Replacing the pose object each frame. Write into the retained `jointMatrices` and `weights`, because pose identity picks the batch.
- Joint indices that point past the palette, even with zero weight.
- Forgetting the inverse bind matrix, so the mesh jumps away from its rest pose.
- A morph channel that is not `Float32Array`, or has the wrong length.
- Expecting culling and levels of detail on skinned parts. They are skipped for skinned and morphed parts.
