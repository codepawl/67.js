# Editable static GLB export

`exportGlb(parts)` returns a self-contained GLB `ArrayBuffer` for the current static scene.
`downloadGlb(parts)` saves that same snapshot through the browser.
The exporter stores each part matrix as a root node transform.
It preserves shared geometry accessors and shared meshes when materials match.
Available from version `0.4.0`.

```js
const geometry = box();
geometry.colors = new Float32Array(geometry.positions.length).fill(0.5);
geometry.uvs = new Float32Array(geometry.positions.length / 3 * 2);
const part = {
  name: 'Editable surface',
  geometry,
  matrix: mat4.create(),
  material: {
    color: [0.2, 0.4, 0.6],
    metallic: 0,
    roughness: 0.7,
    emissiveColor: [1, 0.1, 0.05],
    emission: 8,
  },
};
const binary = exportGlb([part]);
```

## Stored channels

| Input | GLB data | Rules |
| --- | --- | --- |
| `geometry.positions` | `POSITION`, Float32 `VEC3` | Nonempty finite XYZ vectors. |
| `geometry.normals` | `NORMAL`, Float32 `VEC3` | One finite unit vector per vertex, with length tolerance `0.001`. |
| `geometry.indices` | Unsigned integer `SCALAR` | Nonempty `Uint32Array` of triangles with valid vertex indices. |
| `geometry.colors` | `COLOR_0`, Float32 `VEC3` | Optional opaque linear RGB multipliers within `[0,1]`. |
| `geometry.uvs` | `TEXCOORD_0`, Float32 `VEC2` | Optional finite coordinates, including values outside `[0,1]`. |
| `geometry.morphTargets` | Relative `POSITION` and `NORMAL` accessors | One to 64 targets with matching Float32 channel counts. |
| `part.morph.weights` | Independent `node.weights` | Current finite signed Float32 weights. |

Every vertex channel must match the position count.
Typed arrays can reference a subsection of a larger buffer.
The exporter stores only that subsection and preserves its Float32 values.
Colors multiply the base material color in linear space, following the [glTF geometry specification](https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html#meshes).
UV coordinates remain editable even though this exporter rejects textures.

## Materials and emission

`material.color` and `material.emissiveColor` contain three linear RGB components within `[0,1]`.
`metallic` and `roughness` must each lie within `[0,1]`.
`emission` defaults to zero and must be finite, nonnegative, and representable as Float32.
An omitted `emissiveColor` uses `material.color`.

Positive emission keeps the emissive RGB factor separate from its scalar intensity.
A positive intensity other than one uses [KHR_materials_emissive_strength](https://github.com/KhronosGroup/glTF/tree/main/extensions/2.0/Khronos/KHR_materials_emissive_strength).
The file requires that extension so unsupported viewers cannot silently reinterpret its radiance.
An intensity of one uses the core emissive factor without an extension.
Zero emission writes a black emissive factor without an extension.
The snapshot does not preserve a dormant emissive color when its intensity is zero.

The exporter validates every part before constructing accessors or allocating the GLB binary.
Malformed channels, factors, matrices, morph pairs, and indices throw errors instead of undergoing conversion or clamping.

Matrices must contain 16 finite Float32-representable values and have an affine last row.
Their Float32 linear columns must have nonzero lengths and represent rotation with independent scales.
Shear fails when normalized column dot products exceed `8 * 2 ** -23`, allowing Float32 rotation rounding.
Zero scales and scales that collapse to Float32 zero fail before allocation.
Negative scales remain valid.

## Design choice

| Design | Editing and fidelity | Cost |
| --- | --- | --- |
| Vertex accessors and standard material factors | Preserves RGB, UV, morph channels, and active emission independently. | Stores the authored channels once per shared geometry. |
| Bake appearance into textures | Requires a texture bake and obscures authored vertex colors and material factors. | Requires texture support, UV baking, and image storage. |

The exporter uses accessors because its callers already supply editable vertex data.
A texture bake introduces a separate asset pipeline and cannot preserve the same source channels.

## Textures

`material.map`, `normalMap`, `metallicRoughnessMap`, `occlusionMap` and `emissiveMap` are renderer texture descriptors: `{ image, wrapS, wrapT, minFilter, magFilter, flipY }`.
Each distinct image is written once as an embedded PNG, as RGB when it has no transparent texel, and samplers and textures are shared between channels.
`normalScale[0]` and `occlusionStrength` are written with their textures.
`image` is `{ width, height, data }` with RGBA8 data, or a browser image, bitmap or canvas, which is read back through a canvas.
Rows are reversed for `flipY: true`.
The PNG is stored without compression so the export stays synchronous: a 2048 px RGBA map is about 16 MB.

Geometry with textures needs `uvs`.
Without them the export fails and names `uv_unwrap` (a mesh stack node) or `geometry.uvs`.
An image larger than `maxTextureSize` (default 2048, up to 16384) fails with that option's name.

### Pattern materials

A recipe `pattern` is box projected in the shader, and glTF has no box projection.
The export writes the same projection as `TEXCOORD_0`: each triangle takes the object axis its normal is closest to, using the pattern's `size` and `axis` and the part's scale, and vertices are split only where neighbouring triangles choose different axes.
The baked textures go out as the three channels above.
This keeps the picture closest and needs no authoring step, so it was chosen over requiring `uv_unwrap`.
It replaces any `uvs` the geometry has, because the renderer ignores those for a pattern too.
Differences: the shader blends the three projections across an edge and the export switches at the edge, and the importer computes tangents for the normal map from these UVs.

## Skeletons and clips

A skinned part (`part.skin` with `joints`, `inverseBindMatrices` and `jointWorldMatrices`) needs joint nodes.
Pass `options.nodes`, the `nodes` of the parsed asset, to keep the asset's hierarchy and mesh nodes.
Without it the exporter derives one node per joint from the current joint world matrices.
Weights are normalised to sum to one, the skin's `bindMatrix` is folded into the inverse bind matrices, and a skinned mesh sits at the origin.

`options.clips` takes clips in `createAnimationClip` form (`clipFromGltfAnimation` converts an imported one) whose track targets are node names.
Translation, rotation and scale tracks are written as LINEAR, STEP or CUBICSPLINE.
SMOOTH becomes CUBICSPLINE with zero tangents, which equals its scalar easing and approximates rotation slerp.
A track with eased keyframes (`easing`) is written as LINEAR with 32 samples per segment, because glTF has no easing.
A track on another property, or on a node that is not exported, fails with the fix.

```js
const asset = await parseGltf(bytes);
const clips = asset.animations.map(clipFromGltfAnimation);
const glb = exportGlb(asset.parts, { nodes: asset.nodes, clips });
```

### Morph weight clips

A track `{ target: 'Face', property: 'weights', keyframes: [{ time, value: [w0, w1] }] }` writes a `weights` channel with one SCALAR output per target and keyframe.
Every keyframe needs the same nonzero count of finite weights, and the target is the node that carries the morph mesh.
`clipFromGltfAnimation` skips weight tracks because the mixer samples fixed-size properties.
`weightTracksFromGltfAnimation(animation)` in `src/export-skeleton.js` reads them from an imported animation, for linear and step keys; cubic weight keys fail.

## MCP tool

`scene_export_glb` exports the active MCP scene, recipe or imported asset, with `--jobs` configured.
The file goes to `<jobs>/exports/<uuid>.glb`; the call takes no path and the result has the path, `bytes`, `sha256`, `parts` and `clips`.
The newest eight files stay, the GLB is at most 32 MiB, and `maxTextureSize` goes up to 4096.
Without `clip` it writes the current pose: pattern and imported textures, skins, morph weights and IK as posed.
`motionTime` seeks authored motion first and leaves the preview there, like `scene_look`.
With `clip` (imported assets) it writes that source clip, translation, rotation, scale and weights, on the source skeleton, so the scene must carry no animation, node overrides or motion.
`node scripts/smoke-glb-export.mjs cpu` runs a patterned recipe, the robot with IK and its Walking clip through the real server and leaves the files in `artifacts/`.

## OBJ and STL

`exportObj(parts, { mtlFilename })` returns `{ obj, mtl }` as text, and `exportStl(parts)` returns a binary STL `ArrayBuffer`.
Both take the same `parts` as `exportGlb`, apply each part matrix so every vertex is in world space, and write the same bytes for the same input.
Save the OBJ and MTL side by side; the OBJ names the MTL by `mtlFilename` (default `model.mtl`, a plain file name ending in `.mtl`).

They live in the `@codepawlhq/67js/addons/export-mesh` addon, so the core bundle does not grow.

```js
import { exportObj, exportStl } from '@codepawlhq/67js/addons/export-mesh';

const { obj, mtl } = exportObj(parts);
const stl = exportStl(parts);
```

| Format | Written | Not written |
| --- | --- | --- |
| OBJ | One `o` object per part, positions, UVs and normals when the geometry has them, faces as triangles | Textures, lights, cameras, animation, skins, morph weights |
| MTL | One material per distinct base color, emission, roughness and metallic: `Kd`, `Ke` (when emission is positive), `Pr`, `Pm` | Texture maps, layers, patterns |
| STL | Triangles with face normals, 80 byte header, no color | Everything but shape |

Y stays up and units stay as authored (67js uses meters); set the axis and unit in the importer or slicer.
A mirrored part (negative scale) has its winding swapped so faces still point outward.
A skinned part exports its bind shape.
Export stops with an error past `MAX_MESH_EXPORT_TRIANGLES` (1,000,000), and names the field it rejected: positions, indices or `part.matrix`.
Colors in the MTL are the linear base colors of the parts.
Blender 5.2 imports both files with the same triangle count (`File > Import > Wavefront (.obj)` and `STL (.stl)`).
These two functions are library calls; the `scene_export_glb` tool still writes GLB only.

## Limits

Recipe motion tracks are not converted to clips, and an imported clip cannot be combined with IK or node overrides in the MCP tool.
A glTF mesh with several primitives comes back as one Blender object per part, so Blender counts more objects than the original, with the same bones, actions and materials.
Material tracks, IK and the camera are not exported; bake IK into rotation tracks first.
It stores opaque metallic roughness materials without renderer tags, procedural weathering, custom shaders, lighting, cameras, or postprocessing.
It does not promise identical rendered pixels across tools.
Materials tagged `unlit` still export through this documented metallic roughness snapshot contract.

The [Blender glTF workflow](https://docs.blender.org/manual/en/5.3/addons/scene_gltf2.html) supports vertex colors, UV coordinates, shape keys, and emissive strength.
These editable fields remain available to compatible tools after import.

## Render verification

`node scripts/smoke-glb-fidelity.mjs 960 540` compares source parts and imported GLB parts through the built modules in native Chrome.
The fixture covers the film head, a cube with RGB multipliers and UVs outside `[0,1]`, and independent HDR emission.
At 960 by 540 and 540 by 960, all three source and imported images matched exactly on the RTX 3060.
Every draw reported zero WebGL errors.

The original exporter lost vertex channels and produced maximum channel differences of 31, 194 and 185 in those respective fixtures.
Each draw uses one renderer, which is disposed before the next draw.
These measurements establish fidelity for the fixtures, not identical rendering across tools or recognizable character quality.
