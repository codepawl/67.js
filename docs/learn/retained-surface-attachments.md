# Retained surface attachments

`createSurfaceAttachment` is introduced in `0.4.1`. Published npm `0.4.0` does not include this addon. It binds a rigid accessory to one triangle through world transforms, relative morphs and four-influence skinning. The accessory uses the attachment's retained world matrix. Its positive Z axis follows the posed triangle's geometric winding.

The workflow has five steps:

1. Choose an original triangle number and barycentric coordinates for the contact point.
2. Bind the target with `createSurfaceAttachment` from `crucible/addons/surface-attachment` using `0.4.1` or a current source build.
3. Assign `attachment.matrix` to the accessory part before creating the renderer.
4. Update the target matrix, morph weights and skin palette for the frame.
5. Call `attachment.update()` before `renderer.updateParts()`.

## A spike that follows a squashing, turning sphere

A ray from the camera side picks the triangle: `createMeshQueryIndex(...).raycast` returns the `triangle` and `barycentric` that the binding takes. The target sphere has one relative morph target that flattens it. The first slider turns the target, and the second one squashes it. The spike follows both, because each frame calls `attachment.update()` and then `renderer.updateParts()`.

```js live poster=attachment-spike
import { CrucibleRenderer, sphere, box, createMorphPose } from 'crucible';
import { createMeshQueryIndex } from 'crucible/addons/mesh-query';
import { createSurfaceAttachment } from 'crucible/addons/surface-attachment';

// A morph target that flattens the sphere to half its height. Deltas are relative to the base mesh.
const base = sphere(48, 30);
const flatten = 0.5;
const positionDeltas = new Float32Array(base.positions.length);
const normalDeltas = new Float32Array(base.normals.length);
for (let offset = 0; offset < base.positions.length; offset += 3) {
  positionDeltas[offset + 1] = base.positions[offset + 1] * (flatten - 1);
  const x = base.positions[offset];
  const y = base.positions[offset + 1] / flatten;
  const z = base.positions[offset + 2];
  const length = Math.hypot(x, y, z);
  normalDeltas[offset] = x / length - base.normals[offset];
  normalDeltas[offset + 1] = y / length - base.normals[offset + 1];
  normalDeltas[offset + 2] = z / length - base.normals[offset + 2];
}
const targetGeometry = { ...base, morphTargets: [{ positions: positionDeltas, normals: normalDeltas }] };
const morph = createMorphPose(1);
const target = {
  name: 'Ball',
  geometry: targetGeometry,
  morph,
  matrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
  material: { color: [0.25, 0.4, 0.6], metallic: 0, roughness: 0.5 },
};

// Pick the triangle with a static ray against the undeformed mesh.
const index = createMeshQueryIndex(base);
const hit = index.raycast(target.matrix, { origin: [0.45, 0.4, 4], direction: [0, 0, -1] });
console.log(`ray hit: triangle ${hit.triangle}, barycentric ${hit.barycentric.map(value => value.toFixed(2)).join(', ')}`);
const attachment = createSurfaceAttachment(target, { triangle: hit.triangle, barycentric: hit.barycentric, clearance: 0.003 });

// The accessory's +Z axis points out of the surface, so the spike is long along Z and starts at the origin.
const spikeGeometry = box(0, 1);
const spikePositions = Float32Array.from(spikeGeometry.positions, (value, position) => [value * 0.12, value * 0.12, value * 0.4 + 0.2][position % 3]);
const spike = {
  name: 'Spike',
  geometry: { ...spikeGeometry, positions: spikePositions },
  matrix: attachment.matrix,
  material: { color: [1, 0.55, 0.15], metallic: 0, roughness: 0.4 },
};

const canvas = document.querySelector('#scene');
const renderer = new CrucibleRenderer(canvas, [target, spike], { ground: false, samples: 4, pixelRatio: 1.25 });
const state = { turn: 0.4, squash: 0 };

function update(logIt) {
  const cosine = Math.cos(state.turn);
  const sine = Math.sin(state.turn);
  target.matrix.set([cosine, 0, -sine, 0, 0, 1, 0, 0, sine, 0, cosine, 0, 0, 0, 0, 1]);
  morph.weights[0] = state.squash;
  attachment.update();
  renderer.updateParts([target, spike]);
  renderer.render({ eye: [1.5, 1.6, 4.2], target: [0, 0.2, 0], fov: 40 });
  if (logIt) {
    const matrix = attachment.matrix;
    console.log(`turn ${state.turn.toFixed(2)}, squash ${state.squash.toFixed(2)}: attachment at (${matrix[12].toFixed(3)}, ${matrix[13].toFixed(3)}, ${matrix[14].toFixed(3)}), Z axis (${matrix[8].toFixed(2)}, ${matrix[9].toFixed(2)}, ${matrix[10].toFixed(2)})`);
  }
}

const panel = document.createElement('div');
panel.style.cssText = 'position:fixed;left:12px;bottom:12px;display:grid;gap:6px;padding:8px 12px;border-radius:8px;background:#000b;color:#eee;font:12px system-ui';
function addSlider(label, key, minimum, maximum) {
  const row = document.createElement('label');
  row.style.cssText = 'display:flex;gap:8px;align-items:center;justify-content:space-between';
  const input = document.createElement('input');
  Object.assign(input, { type: 'range', min: minimum, max: maximum, step: 0.01, value: state[key] });
  input.addEventListener('input', () => {
    state[key] = Number(input.value);
    update(false);
  });
  input.addEventListener('change', () => update(true));
  row.append(label, input);
  panel.append(row);
}
addSlider('Turn the ball', 'turn', -3.1, 3.1);
addSlider('Squash', 'squash', 0, 1);
document.body.append(panel);

new ResizeObserver(() => {
  renderer.resize();
  update(false);
}).observe(canvas);
update(true);
```

The spike stays on the same triangle at the same barycentric point through the turn and the squash. Its Z axis stays perpendicular to the posed triangle, so when the squash flattens the top of the sphere, the spike leans with the surface. Nothing rebuilds a BVH: `update()` samples the one selected triangle and returns the same `Float32Array(16)` every time.

## Binding options

| Option | Default | Contract |
| --- | --- | --- |
| `triangle` | Required | Integer from zero through the target triangle count minus one. It is an original index-buffer triangle number, as in a `createMeshQueryIndex` hit. |
| `barycentric` | Required | Three nonnegative finite Float32-representable components that sum to one within `1e-6`. |
| `clearance` | 0 | Nonnegative finite distance in world units along the geometric Z axis. |
| `rotation` | 0 | Finite twist in radians about local positive Z. |
| `maxVertices` | 250000 | Integer from 1 through 1000000. |
| `maxTriangles` | 250000 | Integer from 1 through 1000000. |

Unknown option fields throw. The target needs Float32 positions and matching unit normals, a `Uint32Array` triangle index buffer and a retained `Float32Array(16)` matrix that stays finite, affine and nonsingular. Morph targets need the matching retained morph pose, and skin channels need the matching retained joint palette.

The frame follows the posed world triangle: local X runs along edge zero-to-one, local Z is the normalized cross product of edges zero-to-one and zero-to-two, and local Y completes the right-handed frame. The output matrix has unit scale and does not inherit shear or nonuniform scale of the target.

Updates sample the selected triangle without rebuilding a BVH. Static raycast hits can supply binding coordinates, but query indices cannot raycast a visibly skinned or morphed surface, so pick the triangle on the static mesh first. The [attachment contract](https://github.com/codepawl/crucible/blob/main/docs/surface-attachment.md) defines retained identities, world-unit clearance and unsupported shader deformation.

## Common mistakes

- **Using the 0.4.0 npm package.** `createSurfaceAttachment` is introduced in `0.4.1`. Use that version or a current source build.
- **Skipping `attachment.update()`.** The matrix only changes when you call it, and it must come after you change the target matrix, morph weights or skin palette and before `renderer.updateParts()`.
- **Copying the matrix.** Assign `attachment.matrix` itself to the part. It is a retained buffer that the attachment owns, so a copy never moves.
- **Replacing a retained identity.** The binding retains the target part, geometry, matrix, channel buffers and pose objects. Replace any of them and you must bind again, and after rebuilding or uploading edited geometry as well.
- **Expecting more than one rigid frame.** An attachment positions one rigid frame. It does not conform the accessory footprint or prevent every intersection, and it does not follow shader displacement beyond morph and skin deformation.
- **Raycasting the deformed mesh.** Raycast the static mesh and keep the `triangle` and `barycentric` it returns.
