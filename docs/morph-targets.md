# Relative morph targets

The source renderer blends relative position and normal targets on the GPU before skinning.
Color, benchmark and shadow passes share the same target texture and committed weights.
Available from version `0.4.0`. The source [glTF bridge](gltf-morph.md) imports relative targets and weight animations.
The core module exports `createMorphPose` and `MAX_MORPH_TARGETS` without adding a dependency.

Each morph target contains mesh-local changes from the base geometry.
Position and normal channels use XYZ triples, independently of material color.
The blend uses `base + sum(weight * delta)` for each channel.
Weights can be negative or exceed one without normalization or clamping.

```js
import {
  createMorphPose, validateMorphGeometry, validateMorphPose, packMorphTargets,
} from '../src/morph.js';
import { skinTextureLayout } from '../src/skinning.js';

const geometry = {
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
  normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
  morphTargets: [
    { positions: new Float32Array([0, 0, 0, 0, 0, 0, 0, 0.2, 0]) },
    { normals: new Float32Array([0, 0.1, 0, 0, 0.1, 0, 0, 0.1, 0]) },
  ],
};
const pose = createMorphPose(2);
const metadata = validateMorphGeometry(geometry, pose);
const layout = skinTextureLayout(metadata.texelCount, maximumTextureSize, 2);
const textureData = packMorphTargets(geometry, layout);
const part = { geometry, morph: pose }; // Other part fields come from the renderer contract.

pose.weights.set([0.75, -0.2]);
validateMorphPose(pose, metadata); // Validation does not change any weights or target arrays.
```

## Geometry and pose contract

`geometry.morphTargets` contains between one and `MAX_MORPH_TARGETS`, which is `64`.
Each target accepts only optional `positions` and `normals` fields, with at least one channel present.
Every present channel must be a `Float32Array` containing three finite values per base vertex.
A missing channel contributes zero changes.
Base positions and normals also require matching, nonempty `Float32Array` triples.

Base normal squared lengths must remain finite normal Float32 values, at least `2 ** -126`.
This condition prevents a zero or numerically unusable fallback normal.
Target deltas can cancel a normal during blending.
The renderer shader must use the base normal when the blended normal cannot normalize safely.
This module validates numerical bounds without calculating or replacing each blended normal.

`createMorphPose(targetCount)` returns `{ weights: new Float32Array(targetCount) }`, initially zero.
`validateMorphGeometry(geometry, pose)` performs full static preflight and validates the initial weights.
Geometry without morph targets and without a pose returns `undefined`.
Targets without a pose, or a pose without targets, fail validation.

`validateMorphPose(pose, metadata)` accepts any matching Float32 weight array and returns the same metadata.
One geometry metadata object supports several independent poses.
Renderer records must separately retain pose and weight identities after upload.
Shared pose identity can share a batch, while different pose identities need separate batches.

## Static data and atomic updates

Base arrays, target arrays and their contents remain static after upload.
Metadata stores geometry, target and channel identities plus frozen component maxima.
Each frame validates those identities without rescanning channel contents.
Replacing a channel or a target fails the identity check.
In-place content changes violate the static contract and require new geometry, preflight and upload.

Weight contents remain mutable.
The renderer must validate every pending pose before committing instance changes or uploading uniforms.
An invalid pose must leave the last rendered frame intact.
Validation throws without modifying caller arrays, clamping weights or partially applying a pose.
Retained arrays avoid allocation during `validateMorphPose`.

## Bounds and texture layout

Metadata exposes `vertexCount`, `targetCount`, `texelCount`, base component maxima and per-target component maxima.
Its `targets` snapshots contain the original target and channel identities.

The component bound is `abs(base maximum) + sum(abs(weight) * target maximum)`.
Float32 product and accumulation checks reject unsafe intermediate values.
Bounds round upward to cover fused shader arithmetic as well as separate multiply and add operations.
Position and normal component bounds must remain finite in Float32.
The normal squared length bound must also remain finite in Float32.

These bounds deliberately ignore cancellation and maxima occurring at different vertices.
They can reject a finite final blend when large opposing deltas cancel.
The renderer also checks conservative position bounds through its world and weighted skin matrix product.
Shared pose updates validate consumers outside the submitted part list using their committed world matrices.
The palette bound covers four normalized Float32 influences and can reject large cancelling transforms.
These checks do not cover camera projections, displacement, lighting or every transformed normal calculation.

`packMorphTargets(geometry, layout)` validates static channels and returns a new packed `Float32Array`.
Each target vertex occupies two RGBA texels, with a scalar offset of `(target * vertexCount + vertex) * 8`.
The first texel contains position XYZ and zero.
The second contains normal XYZ and zero.
Missing channels and unused texture padding contain zero.

`skinTextureLayout(vertexCount * targetCount * 2, maximumTextureSize, 2)` provides a compatible layout.
Even widths keep the two texels together across rows.
Packing rejects insufficient capacity, inconsistent byte counts and allocations exceeding `2 ** 31 - 1` bytes.
The renderer still needs an explicit texture memory budget before allocation.
Its shader can use a bounded loop of 64 targets and skip zero weights.

## Design choice and verification

Two designs were considered before fixing the data contract.

| Design | Geometry changes | Frame cost | Resource ownership |
| --- | --- | --- | --- |
| CPU blend and mesh upload | Rewrites each position and normal buffer | Visits every affected vertex and uploads buffers | Each pose needs its own mutable geometry. |
| Cached GPU targets and uniform weights | Retains base geometry and static target texture | Validates at most 64 weights and component bounds | Geometry shares a texture across independent poses. |

The selected GPU contract preserves geometry identity and avoids vertex rewrites during playback.
Uniform weights allow this design without consuming more vertex attributes.
Different poses split batches because their uniforms differ.
The parent renderer owns that batching and texture lifecycle.

Node tests compare signed relative position blends with literal expected values and the installed Three.js `Mesh.getVertexPosition` implementation.
Other checks cover channel packing, independent poses, normal cancellation, identity changes, overflow and texture capacity.

`scripts/smoke-morph.mjs` compares the actual built GPU module with a CPU-authored reference image.
It checks independent signed poses, the 64th target, retained buffers, atomic rejection and texture disposal.
`scripts/smoke-morph-composition.mjs` compares combined skinning, normal deltas, normal cancellation and shadow receivers with CPU-baked geometry.

The film scientist uses shared head geometry with separate retained expression weights per actor.
Its four channels control blink, brow tension, mouth tension and gaze.
The sampled targets and normals stay fixed while deterministic scene cues update weights.
Visual quality and frame performance require separate scene measurements.

Numerical validation does not detect self-intersections or guarantee that an eyelid covers its entire eyeball.
Close views must check corners, intermediate weights and combined expressions as well as the central surface.
The film smoke compares blink pixels independently of head motion and the other expression channels.

Additive target normals approximate normals on the combined surface.
The film checks compare open and closed expressions against normals sampled from that surface.
One triangle normal can differ from a smooth vertex normal even on the undeformed mesh.

## GLB snapshots

`exportGlb(parts)` preserves relative position and normal target accessors and each node's current weights.
Repeated instances retain shared meshes while their signed weights remain independent.
The export contains editable targets and a static pose, rather than baked vertex positions.
It does not serialize animation clips. Skinning and material textures still fail explicitly at export.

The source importer opens these snapshots. Morph import generates base normals when none are authored (dropping the morph normal deltas) and rejects tangent targets.
The source [exporter](export-glb.md) also preserves opaque vertex colors, UVs and independent active HDR emission.
Skinning, textures, procedural shaders and animation clips still prevent a complete asset roundtrip.

The output follows [glTF morph target and node weight semantics](https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html#morph-targets).
Export tests inspect the serialized accessors and load the GLB with the independent Three.js loader.
