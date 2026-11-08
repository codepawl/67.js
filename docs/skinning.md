# GPU skeletal deformation

Available from version `0.4.0`.

`Renderer67` deforms skinned vertices in its color, shadow, and benchmark vertex shaders.
The implementation uses four normalized influences per vertex and a mesh-local joint palette.
All five PBR map channels remain available.

```js
const pose = createSkinPose(2);
const part = {
  geometry: {
    positions,
    normals,
    indices,
    skinIndices: new Uint16Array(joints),
    skinWeights: new Float32Array(weights),
  },
  matrix: meshWorldMatrix,
  material,
  skin: pose,
};
updateSkinPose(pose, jointWorldMatrices, inverseBindMatrices, meshWorldMatrix, bindMatrix);
renderer.updateParts([part]);
```

`createSkinPose(jointCount)` creates a retained `Float32Array` named `jointMatrices`.
Each joint occupies 16 floats in column-major order. The initial palette contains identity matrices.
`updateSkinPose()` calculates `inverse(meshWorldMatrix) * jointWorldMatrix * inverseBindMatrix * bindMatrix` for each joint.
Both optional matrices default to identity. Invalid input leaves the public palette unchanged.

The helper retains its scratch matrices and staging buffer.

Each vertex requires four joint indices and four weights.
Indices must reference the pose palette, including indices paired with zero weights.
Weights must be finite and within zero and one. Their total must be positive.

The renderer normalizes weights when packing its immutable influence texture. It does not modify the supplied weight array.
Joint matrices must be finite, affine, and nonsingular.

## GPU data and batching

Two RGBA32F textures hold the deformation data.
The influence texture stores four indices and four normalized weights in two texels per vertex.
The palette texture stores each joint matrix in four texels.
The shader fetches influences with `gl_VertexID`, so skinning uses no additional vertex attributes.

| Design | Consequence |
| --- | --- |
| Conventional attributes, with instance normals calculated in GLSL | Frees attribute slots but changes the rigid shader and its per-vertex cost. |
| Influence and palette textures | Preserves all 16 existing attribute locations and adds vertex texture fetches. |

The renderer uses textures to preserve the existing instance layout and PBR inputs.
Geometry identity shares influence textures. Pose identity shares palette textures.
A batch includes geometry, material maps, fixed map scales, and pose identity.
Parts sharing one pose can instance together. Independent poses form separate batches.

`updateParts()` uploads each submitted pose once through `texSubImage2D` using a retained padded buffer.
It validates all submitted parts and weighted transforms before modifying packed data or submitting GPU writes.
The palette and influence GPU textures retain their identities across updates.
Input validation is atomic. A WebGL failure during submission cannot roll back earlier GPU writes.

Geometry, influence arrays, pose identity, and the `jointMatrices` array identity must remain unchanged while the renderer uses them.
The matrix values inside `jointMatrices` can change before `updateParts()`.
Changing topology, influences, joint count, or pose identity requires a new renderer.
Pose changes mark shadows dirty unless the caller explicitly disables shadow updates.

## Normals and supported transforms

Positions use the weighted matrix blend. Normals use the inverse-transpose of its upper-left 3×3 matrix, followed by the instance normal matrix.
This preserves perpendicularity under nonuniform joint scaling.
The installed Three.js skin shader transforms normals directly with the blended matrix.

The methods agree when the blended matrix represents a rigid transform. They can differ under nonuniform scale or blended rotations.
Tests compare positions with Three.js and verify the normal's perpendicularity to a transformed tangent.

Singular joints and singular weighted vertex transforms fail explicitly. A vertex whose weighted transform mirrors the mesh, as when linear blend skinning pinches a finger between two joints that turn opposite ways, draws pinched as in other engines. The renderer lists it in `renderer.diagnostics` as `skin-reflected-vertices`, with the count and the joints and weights of the first one. `{ checks: false }` skips the check, so the warning then keeps its last value.
The renderer validates weighted transforms on the CPU before uploads. This validation visits every influenced vertex in submitted parts.
Skinning uses linear matrix blending. It does not implement dual-quaternion deformation or preserve volume around bent joints.

## glTF import and animation

The [glTF skin contract](https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html#skins) defines joint indices, weights, and inverse binds.
`parseGltf()` and `loadGltf()` import `JOINTS_0`, `WEIGHTS_0`, ordered joints, and inverse bind matrices.
Normalized unsigned byte and short weights are supported. Missing inverse binds use identity matrices.
The importer validates raw influences before Three.js can replace zero weight totals during normalization.

Imported parts expose `part.skin`. `asset.skins` contains the corresponding pose objects.
Each imported pose also contains `joints`, `inverseBindMatrices`, `jointWorldMatrices`, and `bindMatrix`.
Each joint descriptor contains its name and parent index within the palette. A parent index of `-1` means no palette parent.

`asset.applyAnimation(time, clipIndex)` samples node and joint tracks at an absolute, clamped time.
It prepares every pose before updating public part matrices or palettes.
Invalid animation transforms leave those arrays unchanged. Subsequent valid seeks can recover.
The renderer requires `updateParts(asset.parts)` after each seek.
Skinned mesh node transforms cancel through the mesh-local palette, following glTF skin semantics.

The bending fixture is `tests/fixtures/skinned-strip.js`. Its `skinnedStripAsset()` function returns a self-contained GLB.
The lower row stays fixed while the upper segment bends. The middle row blends both joints.
The fixture includes separate bend and translation clips for deterministic seek tests.

## Budgets and lifetime

GPU skinning requires at least two vertex texture units and eight combined texture units.
Texture dimensions must fit `MAX_TEXTURE_SIZE`.
Both RGBA32F textures, including padding, contribute to the renderer's existing texture memory budget.
Palette textures use 64 bytes per joint before padding. Influence textures use 32 bytes per vertex before padding.

The importer limits declared joints and the combined joint count of instantiated poses through `maxJoints`, which defaults to `4096`.
Existing byte, vertex, part, image, and resource limits remain active.
Palette creation supports at most `65536` joints, subject to GPU texture capacity and memory budgets.

1. Dispose the renderer before disposing its imported asset.
2. Call `asset.dispose()` to release decoder skeletons, geometry, materials, textures, and decoded images.

Renderer disposal deletes every cached palette and influence texture.
The caller owns the native geometry and pose arrays.

## Remaining limits

Additional influence sets, morph targets, reflected skin transforms, and singular weighted transforms remain unsupported.
Procedural material tags cannot combine with skinning. Standard PBR and unlit materials can.
The existing glTF restrictions on transparency, texture transforms, unsupported extensions, and compressed textures remain active.
GLB export rejects skinned parts, rather than silently discarding their skeleton and current deformation.

This unit does not add skin export, pose-aware bounds, picking, retargeting, animation blending, or a bone editor.
It does not establish full Three.js or Blender parity.
