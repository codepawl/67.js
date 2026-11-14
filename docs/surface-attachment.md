# Retained triangle attachments

This addon is available from version `0.4.1`.

`createSurfaceAttachment` follows one triangle through rigid transforms, relative morphs, and skinning.
It returns a retained rigid world matrix for an accessory placed at a barycentric point.
The accessory's local positive Z axis faces along the posed triangle's geometric winding.

```js
import { createSurfaceAttachment } from 'crucible/addons/surface-attachment';

const attachment = createSurfaceAttachment(targetPart, {
  triangle: hit.triangle,
  barycentric: hit.barycentric,
  clearance: 0.003,
  rotation: 0,
});
const accessoryPart = {
  geometry: accessoryGeometry,
  matrix: attachment.matrix,
  material: accessoryMaterial,
};

// Update the target's retained matrix, morph weights, and skin palette first.
attachment.update();
renderer.updateParts([targetPart, accessoryPart]);
```

`triangle` uses the original target index-buffer triangle number.
This matches the triangle number from `createMeshQueryIndex` ray hits.
The binding uses that triangle's three original index entries in order.
An attachment does not perform another raycast or choose another triangle during updates.

## Binding options

| Option | Default | Contract |
| --- | --- | --- |
| `triangle` | Required | Integer from zero through the target triangle count minus one |
| `barycentric` | Required | Three nonnegative finite Float32-representable components |
| `clearance` | 0 | Nonnegative finite Float32-representable distance in world units |
| `rotation` | 0 | Finite Float32-representable twist in radians about local positive Z |
| `maxVertices` | 250000 | Integer from 1 through 1000000 |
| `maxTriangles` | 250000 | Integer from 1 through 1000000 |

The barycentric components must sum to one within `1e-6`.
The binding copies and normalizes those components before use.
It also copies the clearance and rotation values.
Changing the caller's option arrays after binding does not change the attachment.
Unknown option fields cause an error.

The target requires Float32 XYZ positions and matching finite unit Float32 normals.
Its nonempty triangle index buffer must use `Uint32Array`.
The retained target matrix must use `Float32Array(16)`.
It must remain finite, affine, and nonsingular.
Binding checks all target vertices and triangle indices within the supplied budgets.
It rejects degenerate base triangles.

Morph and skin bindings use the renderer's existing geometry validators.
These validators check all declared channels and the initial deformation pose once at binding.
Morph targets require the matching retained morph pose.
Skin channels require the matching retained mesh-local joint palette.
The constructor evaluates the initial attachment before returning it.

## Frame and clearance

The position is the barycentric point on the three posed world vertices.
The local X axis follows triangle edge zero-to-one.
The local Z axis is the normalized cross product of edges zero-to-one and zero-to-two.
The local Y axis completes the right-handed orthonormal frame.
`rotation` twists X and Y around Z.
The output matrix carries unit scale and does not inherit target shear or nonuniform scale.

Static target reflections reverse the geometric winding and therefore reverse the attachment's Z axis.
This frame does not use interpolated vertex normals or morphed shading normals.
If an animated triangle reverses its winding without collapsing at the sampled time, its attachment frame follows that winding.
The operation does not track unsampled intermediate times.

Clearance moves the barycentric point along that geometric Z axis in world units.
It remains a world distance under target nonuniform scaling and shear.
Positive clearance must produce a positive outward face gap after the translation rounds to Float32.
The implementation also checks that the offset changes the rounded base position outward.
A collapsed or tangent-only offset causes an error.
Zero clearance places the rounded origin on the sampled surface without promising depth-buffer separation.

## Deformation order and precision

The attachment adds relative morph position deltas to each selected base vertex.
It then applies the weighted four-influence skin matrix and the target world matrix.
The skin influences use the renderer's normalized Float32 weights.
The implementation preserves the resulting homogeneous coordinate and divides each world vertex by it.
The barycentric frame therefore follows the visible post-divide geometric triangle.

Intermediate matrix and vertex operations round to Float32 and reject nonfinite results.
Frame construction uses Double precision before publishing a Float32 matrix.
The CPU calculation follows the renderer's deformation order, but GPU fused arithmetic can produce small rounding differences.
It does not promise bit-identical GPU positions.
The attachment also does not follow shader displacement beyond morph and skin deformation.

The selected triangle must retain a minimum altitude above a conservative world precision margin.
That margin uses approximately four Float32 units at the largest posed world coordinate.
Large translations can reject small triangles even when every input remains finite.
Collapsed triangles, singular weighted skin transforms, and unsupported reflected skin transforms cause errors.
Skin reflection restrictions match the renderer.

## Snapshots, identities, and updates

Binding snapshots only the selected three base positions, selected morph position deltas, and twelve skin influence entries.
Static channel contents follow the renderer's immutable-upload contract.
Changing those contents in place does not change an existing attachment.
Rebind after rebuilding or uploading edited geometry.

The binding retains the target part, geometry, matrix, channel buffers, and pose identities.
Replacing those identities requires another binding.
Morph target objects and channel identities must also remain unchanged.
The output handle is frozen, while its matrix remains a retained mutable buffer for renderer use.
Treat that output matrix as owned by the attachment.

`update()` reads current retained matrix values, morph weights, and referenced joint matrices.
It returns the same `Float32Array(16)` on every successful call.
The update performs no BVH build, mesh reconstruction, GPU readback, or full palette scan.
Its work depends on three vertices, at most 64 morph targets, and at most twelve skin influences.
Static geometry contents are not rescanned during an update.

Validation uses a private pending matrix before publishing the retained output.
An error leaves the last successful matrix unchanged.
After repairing the invalid pose or restoring an identity, another update can succeed.
Sampling current pose values in arbitrary order gives the same matrix for the same pose.
The attachment does not advance an animation clock or remember previous pose values.

An update validates only the selected triangle and its referenced palette entries.
It does not certify unrelated vertices or unused joints.
Run the renderer's full validation when committing the target's complete pose.

## Supported targets and limits

Assembly shader offsets are unsupported.
The vertex-deforming tags `water`, `foliage`, `grass`, `fire`, and `smoke` are unsupported.
Morphed or skinned targets also reject the renderer's procedural `terrain` and `floor` tags.
Static `terrain` and `floor` targets retain their geometry-based attachment frame.
Standard material changes do not change the binding.

This attachment positions a rigid accessory at one contact point.
It does not conform the accessory's footprint to a curved surface.
It does not certify accessory clearance, prevent every mesh intersection, remesh a decal, or reproduce Blender's Surface Deform modifier.
Use shrinkwrap for static vertex projection and a surface patch for clipped triangle overlays.

Two designs were considered: rebuilding a full posed mesh and BVH, or retaining one sparse triangle binding.
The sparse binding keeps update work bounded and avoids repeated mesh allocation.
It preserves an explicit original triangle identity instead of silently choosing a new surface point after deformation.

## References

[Three.js Mesh](https://threejs.org/docs/pages/Mesh.html) documents vertex sampling with morphing and skinning.
[Blender Surface Deform](https://docs.blender.org/manual/en/3.6/modeling/modifiers/deform/surface_deform.html) describes binding an entire surface to another deforming mesh.
The sparse rigid attachment here does not implement that full modifier.
