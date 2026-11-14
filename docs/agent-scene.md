# Agent scene authoring

This addon is included in npm release `0.5.0` and later.

The optional `agent-scene` addon creates bounded CPU scenes from JSON recipes and applies atomic editing commands.
It returns retained renderer parts with shared geometry and material resources.
It does not execute JavaScript, access the DOM, or provide an MCP transport.
Recipes also retain [lighting, fog, effects and directional shadow coverage](agent-look.md).
Their patches and checkpoints share the same atomic revision contract as model edits.

To see what changed, including changes not yet released, read `https://crucible.codepawl.com/changelog.json`.

Release `0.7.0` adds optional [procedural motion](agent-motion.md) and transient `sampleMotion(time)` seeks.
Recipe edits retain authored keyframes. Sampling preserves revisions and geometry while updating rendered transforms, materials and camera.

```js
import { CrucibleRenderer } from 'crucible';
import { createAgentScene, AGENT_SCENE_CAPABILITIES } from 'crucible/addons/agent-scene';

const scene = createAgentScene({
  format: 'crucible.scene',
  schemaVersion: 1,
  geometries: [{ id: 'cube', type: 'box', bevel: 0 }],
  materials: [{ id: 'blue', color: [0.1, 0.3, 0.8] }],
  nodes: [
    { id: 'group', label: 'Assembly' },
    { id: 'mesh', parent: 'group', geometry: 'cube', material: 'blue' },
  ],
});

const renderer = new CrucibleRenderer(canvas, scene.parts, { ground: false });
const checkpoint = scene.checkpoint();
scene.apply([
  { type: 'set-node', id: 'group', translation: [1, 0, 0] },
  { type: 'set-material', id: 'blue', roughness: 0.3 },
], { expectedRevision: scene.revision });
renderer.updateParts(scene.parts);
renderer.render(scene.camera);
scene.restore(checkpoint, { expectedRevision: scene.revision });
renderer.updateParts(scene.parts);
renderer.render(scene.camera);
scene.releaseCheckpoint(checkpoint);
```

`AGENT_SCENE_CAPABILITIES` and `scene.capabilities` describe the same frozen capability object.
The renderer owns GPU allocation and disposal.
The authoring session does not allocate GPU resources.
The normal frame loop can render retained parts without calling inspection or exporting the recipe.

### On-demand code

Mesh editing, `lathe`, `extrude`, `tube` and `curve` geometry, `text` geometry with its font, `terrain` geometry, material `pattern`, `motion` and node `relations` load on demand, so a recipe of
primitives pays about half the bytes. `createAgentScene` and `apply` stay synchronous. When a recipe uses one of them,
load its code first; a missing module throws an error that names this call.

```js
import { createAgentScene, loadAgentSceneModules } from 'crucible/addons/agent-scene';

await loadAgentSceneModules(recipe);
const scene = createAgentScene(recipe);
```

`loadAllAgentSceneModules()` loads everything, for a host that runs any recipe an agent writes (the MCP preview does).
Call `loadAgentSceneModules(operations)` before `apply` when the operations add such features.

## Recipe contract

The recipe must contain `format`, `schemaVersion`, `geometries`, `materials`, and `nodes`.
The optional `camera` object supplies a perspective camera, or an orthographic one with `projection: 'orthographic'` and `orthoScale` (view height in metres, default 4). The lens is `fov` (vertical degrees) or `focalLength` in millimetres with `sensorWidth` (default 36); giving both is an error. `shift: [x, y]` moves the frame by a fraction of its width and height, positive right and up. `fStop` (0.7 to 64) turns on depth of field focused on `target` (1.4 or lower is full blur) and cannot be combined with `effects.depthOfField.blur`. The path tracer draws perspective cameras without shift.
All objects reject unknown keys.
Inputs must contain plain, finite, acyclic JSON data without accessors, sparse arrays, or executable values.
JSON nesting has a fixed maximum of 64 levels.

Each resource and node has a unique `id` within its collection.
IDs contain 1 to 128 characters and must contain a non-space character.
Node labels contain at most 256 characters.
Labels can repeat and change without changing identity.
Renderer `part.name` contains the stable node ID.

Geometry records contain `id`, `type`, and the flat fields below.
Omitted parameters use the existing generator defaults.
The generators also enforce their existing numeric and modeling constraints.

| Type | Fields | Defaults |
| --- | --- | --- |
| `box` | `bevel`, `subdivisions` | `0.08`, `6` |
| `cylinder` | `segments`, `bevel`, `bevelSegments` | `80`, `0.025`, `6` |
| `sphere` | `segments`, `rings` | `64`, `40` |
| `torus` | `tubeRadius`, `segments`, `sides`, `arc`, `start` | `0.08`, `96`, `24`, `2π`, `0` |
| `lathe` | `profile`, `segments`, `startAngle`, `sweep` | Required XY profile, `64`, `0`, `2π` |
| `extrude` | `contour`, `holes`, `depth`, `steps`, `bevel`, `bevelThickness`, `bevelSegments` | Required XY contour, `[]`, `1`, `1`, `0`, bevel, `3` |
| `tube` | `path`, `radius`, `segments`, `radialSegments`, `closed` | Required XYZ path, `0.1`, `64`, `12`, `false` |
| `curve` | `points` or `shape` or `splines`, `closed`, `kind`, `weights`, `trim`, `grow`, `radius`, `taper`, `profile`, `resolution`, `radialSegments` | One of points, shape or splines, `false`, `bezier`, 1, none, none, `0.05`, none, round, `12`, `8` |
| `text` | `text`, `size`, `depth`, `font`, `align`, `curveSegments` | Required string, `1`, `0.2`, `default`, `left`, `4` |
| `terrain` | `size`, `resolution`, `seed`, `amplitude`, `holes` | `40` m, `64` cells, `1`, `1` m, none |

`terrain` is one seeded ground mesh from `-size / 2` to `size / 2` on X and Z with hills about y = 0 and up to 16 round `holes` (`{ center: [x, z], radius }`) that leave no surface; it loads on demand. Details are in `scene_capabilities` under `terrain`.

`curve` and `text` are described in full by `scene_capabilities` under `curveText.details`; see [modeling.md](modeling.md).

Modeling point inputs have a maximum of 4096 points.
An extrusion has at most 128 holes and 4096 total contour points.
Shared resource IDs generate geometry once, regardless of the number of mesh nodes.

Materials contain `id`, `tag`, `color`, `metallic`, `roughness`, `emission`, optional `emissiveColor`, `opacity`, `alphaMode`, `doubleSided`, `pattern` and `map`.
The defaults are `surface`, `[0.5, 0.5, 0.5]`, `0`, `0.5`, `0`, opacity `1`, `opaque` and `false`.
The tag can be `surface`, `unlit`, `liquid`, `foam`, `water`, `foliage` or `grass` (the last two sway in `environment.wind`) and remains fixed during editing.
`liquid` refracts and tints what lies behind it: its color is the light one metre lets through, so `[0.56, 0.84, 0.88]` is clear water. `foam` draws soft blended droplets.
`water` is a flat mirror sheet (a plane or thin box). The largest one sets the water level: everything below it fades by `exp(-absorption * depth)` per colour channel (`absorption` is RGB per metre), and its shadows are lifted and softened with depth times `turbidity` (0 clear to 1 murky). `waterPreset` fills both: `lake` (default), `sea` or `river`. A shadow on the surface is faint and never darkens the reflection; give the sheet an `opacity` below one when the bed should show. The sun's leg to a bed is bent at n = 1.33 and absorbed over `depth / cos(theta_t)`, so a clear lake keeps little shadow contrast on a bed 4 m down, and a murky river keeps about a quarter.
Any `opacity` below one draws the material blended after opaque geometry, which suits glass, windows and visors. `alphaMode` accepts `opaque`, `blend` or `add` (additive light for sparks, trails and glow); cutout masking needs a texture and is not available in procedural recipes.
`doubleSided` draws and lights both faces of thin sheets.
Changing the tag, opacity, blending, sidedness or pattern replaces the affected parts in the renderer; color, metallic, roughness and emission edits keep them.
Set liquid optics with `environment.liquid`: `thickness`, `ior`, `refraction`, `scattering`, `foamOpacity` and `foamSoftness`.
Colors use linear RGB.

Base color, metallic, and roughness range from zero to one.
Emission and independent emissive color must be nonnegative finite Float32 numbers.
Their component products must also remain finite at Float32 precision.
Unlit emissive radiance is capped at 65500 per component to fit the half-float HDR target.
Image textures and the other procedural material tags are outside this version.

### Material patterns

`pattern` gives a `surface` material a procedural texture, baked once and shared by every material with the same definition:

```json
{ "id": "oak", "pattern": { "type": "wood", "size": 0.6, "axis": "z" }, "roughness": 1 }
```

| Field | Meaning |
| --- | --- |
| `type` | `noise`, `wood`, `planks`, `bricks`, `tiles`, `marble`, `stone`, `concrete`, `metal`, `rust` or `fabric`, or `graph` (with `graph`) |
| `colors` | Two linear RGB colours to mix, darker first. `bricks` also takes a third, for the mortar. Each type has defaults |
| `size` | Metres per repeat of the texture, from 0.01 to 100 |
| `count` | Features per repeat, from 1 to 64: planks, bricks or tiles across, wood rings, or noise cells |
| `bump` | Relief strength, from 0 (flat) to 4 |
| `seed` | Nonnegative whole number. The same definition always bakes the same pixels |
| `axis` | Object axis the grain runs along: `x`, `y` (default) or `z` |
| `resolution` | Texture size: 256, 512 (default) or 1024 |
| `mapping` | `box` (default) or `uv`: how the texture is placed. See Material graphs |

A pattern needs no UVs. The texture is projected along the object's three axes and blended by the surface normal, so it
works on every geometry type and after mesh edits. Coordinates are in metres on the object, after its node scale, so a
stretched box keeps the texture's real size and the pattern moves with the node. Corners between faces show where one
projection meets another; set `mapping: "uv"` to follow `uv_unwrap` results instead (see Material graphs).

`color` defaults to white and tints the pattern. `roughness` and `metallic` scale what the pattern stores, so use
`roughness: 1` for its own surface and `metallic: 1` for `metal` and `rust` (rust stores where it is no longer metal).

A scene holds at most 16 different patterns, and materials that differ only in `color`, `roughness` or `metallic`
share one. Each takes about 4 MiB of texture memory at 512. Measured in Node on a Ryzen 5 5600X, baking at 512 took
about 0.2 to 0.55 s per pattern, which happens when the scene first renders it. Changing a pattern rebuilds the
renderer.

### Material graphs

`pattern` with `type: "graph"` bakes your own node graph on the CPU into textures. A graph is plain JSON and never code:
it is read against a fixed table of operators, checked against its limits before any pixel is computed, and turned into
texture images, so no text from a recipe ever reaches the shader. The language shares the shape of the field expressions
(one operator per object, numbers are constants, `[r, g, b]` is a constant vector).

```json
{ "id": "brick", "pattern": { "type": "graph", "mapping": "uv", "bump": 1.5, "graph": {
  "color": { "ramp": { "value": { "noise": { "scale": 8, "seed": 3 } }, "stops": [[0, [0.15, 0.05, 0.03]], [1, [0.6, 0.25, 0.15]]] } },
  "roughness": 0.9,
  "height": { "noise": { "scale": 8, "seed": 3 } } } } }
```

| Graph output | Becomes |
| --- | --- |
| `color` | Base colour map, linear RGB (a number is grey). Without it the material `color` stands alone |
| `roughness`, `metallic` | The metallic-roughness map. A material that has either output defaults the matching factor to 1 |
| `emission` | The emissive map. The material `emission` defaults to 1 when the graph has it |
| `height` | A normal map, so it gives bump. `bump` (0 to 4, default 1) scales the relief |
| `opacity` | The alpha of the base colour map. The material blends unless `alphaMode` says otherwise. The path tracer cuts it out at 0.5 |
| `clearcoat` | A per-pixel mask of the clear coat (the red channel of `layerMaps.clearcoatTexture`). The material `clearcoat` defaults to 1. The rasterizer and the CPU path tracer read it |
| `transmission` | A per-pixel mask of transmission (`transmissionMap`). The material `transmission` defaults to 1. Only the CPU path tracer reads the mask; the rasterizer and GPU tracers use the factor |

Nodes: `uv` (`"u"`, `"v"` or `"both"`), `noise`, `voronoi` (`output`: `distance`, `edge` or `cell`, a random value per cell),
`wave` (`sine`, `saw` or `triangle` along `u`, `v` or `diagonal`), `checker`, `gradient` (`u`, `v` or `radial`), `ramp`
(2 to 8 stops of numbers or colours), `vec`, and the maths nodes `add`, `sub`, `mul`, `div`, `min`, `max`, `pow`, `abs`, `floor`,
`fract`, `sqrt`, `invert`, `clamp`, `smoothstep` and `mix`. Mixing nodes: `layer` (`base`, `top`, `mask`, `edge` 0.5, `softness` 0.1) puts `top` over `base` where the mask passes the edge, so `{ "layer": { "base": [0.45, 0.18, 0.06], "top": [0.1, 0.35, 0.7], "mask": chipMask } }` is paint over rust; `hue` (`color`, `shift` in turns, `saturation`, `value`) and `curve` (`value`, 2 to 8 `points` `[x, y]` with rising x, straight segments). Maths nodes work on each component of a vector. Every texture
node takes `at`, a vector expression such as `{ "add": [{ "uv": "both" }, { "mul": [{ "vec": [0.1, 0, 0] }, 1] }] }`, to warp
it. Scales and counts are whole numbers (1 to 64, even for `checker`), so every texture node tiles. `noise` is Blender's Noise Texture
(2D, detail `octaves - 1`, roughness 0.5, lacunarity 2, normalized; `seed` moves the lattice by whole cells) with the lattice
wrapped so it repeats. `"tile": false` matches Blender's Noise Texture exactly, does not repeat.

Placement and pattern nodes:

- `brick` (`columns` 8, `rows` 8 and even, `mortar` 0.05 of a brick, `offset` 0.5 for every other row, `seed`, `output`: `mortar` is 1 in the joint, `edge` is 0 at a joint and 1 at the brick centre, `cell` is one random value per brick) lays a running bond and costs 4. Whole columns and even rows keep it tiling.
- `whiteNoise` (`scale` 16, `seed`, `output`: `value` or `color` for three independent values) is one random value per cell of a `scale` by `scale` grid. It tiles and is the same for the same seed.
- `image` (`asset`, the 64 hexadecimal characters of a catalog image ID from `scene_asset_catalog`; `output`: `color` is linear RGB decoded from sRGB, or `alpha`; `at` as for the other textures) reads a catalog image with bilinear filtering and repeats it across the tile, and costs 4. The host decodes the image into the same pool as texture sequence frames, so it follows their limits (1024 pixels a side, 64 MiB decoded in all); remote URLs are not accepted. Row 0 of the image is the top of the tile, as with a baked graph. A graph that names an image the host did not load fails when the material is baked, naming the asset.
- `fresnel` (`ior` 1.5, from 1.01 to 3) is Schlick's Fresnel reflectance at the angle between the view and the surface: about 0.04 face on for glass, rising to 1 at grazing angles. It depends on the camera, so no baked texture can hold it, and it works only as a factor of `emission`, alone or in a `mul` with the rest: `"emission": { "mul": [[1, 0.5, 0.2], { "fresnel": { "ior": 1.5 } }] }`. The graph bakes the colour; the rasterizer and the CPU path tracer multiply it by the curve per pixel with the same formula. The GPU path tracers do not read it yet and draw the unscaled emission. Anywhere else, `fresnel` is an error.
- `coord` (`"generated"`, `"object"` or `"world"`) is a vector for `at`. `generated` is the unit tile, `object` and `world` are metres across the tile (texture u and v times the pattern `size`). A baked texture is projected onto the mesh, so it knows only the two axes of that projection and the third is 0; `object` and `world` are the same because box mapping reads the placed, scaled position.
- `mapping` (`vector`, default `{ "coord": "generated" }`; `scale` a number or `[x, y, z]`; `rotate` radians around Z; `offset` `[x, y, z]`) scales, turns and moves a vector, as Blender's Mapping node does. Feed it to `at`.

These make a material work on a mesh without UVs: box mapping (the default) projects the baked graph along the object axes, so a brick wall or a noise pattern needs no unwrap. `vertex_color` on a mesh already multiplies the baked colour. Not in graphs yet: ambient occlusion, bevel and curvature masks, fresnel anywhere but as an emission factor, and a vertex group node (they need per-vertex or per-pixel data that a bake from `u` and `v` alone does not have).

Limits, checked while the recipe is read: at most 64 nodes in all outputs, depth 12 (the field expression limits), at most 8 ramp
stops, `resolution` of 256, 512 or 1024, and a work budget of 30 million units, where a plain node costs 1, a `noise` octave 3
and a `voronoi` 8, per pixel and per pixel of the texture. A heavy graph at 1024 can be over it; use 512. A graph that is over a
limit, holds an unknown operator or key, or holds any text other than the fixed names above is rejected with a message that
names the problem. Baking the heaviest graph the budget allows took about 2 seconds in Node.

#### Mapping

`mapping` is `box` (default) or `uv`, and it applies to presets as well as graphs. `uv` samples the texture with the
geometry's UVs, so a mesh with a `uv_unwrap` stack node (or `geometry.uvs`) carries it without box projection seams; the
texture repeats outside 0 to 1 and tiles. `size` and `axis` only apply to `box`. A `uv` pattern on geometry without UVs
fails at render and at `scene_export_glb` with a message that names `uv_unwrap`. GLB export writes the baked graph textures
and the geometry UVs.

### Image sequence maps

`map: { sequence: { frames, fps, loop } }` gives a `surface` material a colour map that plays a list of images, such as the output of a video or a simulation. It covers the colour map only (`map`; normal, roughness and emissive maps stay with `pattern`), needs geometry with UVs (`grid`, `box`, a `uv_unwrap`ped mesh), and does not combine with `pattern`. `color` defaults to white and tints the frames.

```json
{ "id": "screen", "map": { "sequence": { "frames": ["<catalog image id>", "<catalog image id>"], "fps": 12 } } }
```

- `frames` lists 2 to 64 IDs from `scene_asset_catalog`. The `--assets` folder takes PNG, JPEG and WebP files next to GLBs, with the same 64 MiB file budget, content-bound SHA-256 IDs and no links. An extension that does not match the file signature rejects the catalog. Entries report `kind: "image"` and `mimeType`; GLBs report `kind: "glb"`. No remote URLs are read.
- All frames share one size, at most 1024 pixels a side, and a scene decodes at most 64 MiB of frames. Frames are read without colour conversion and should be opaque.
- `fps` is above 0 and at most 60. The frame at scene time `t` is `floor(t * fps)`: wrapped around the list when `loop` is true (the default), held on the last frame when `loop` is false. Frame 0 shows before any motion time is set.
- The clock is `motionTime`, the one `scene_look`, `scene_review` and `motion` use. A seek is deterministic: the same time gives the same frame and the same PNG bytes. `scene_render_submit` reads it from `settings.motion.start` plus the elapsed time (or a timeline shot), so a still or video frame shows the frame that `scene_look` shows at that time. A recipe with a sequence and no authored `motion` accepts `settings.motion`.
- The renderer uploads a frame with `updateTexture` only when the frame index changes. `scene_inspect` reports `textureSequences`: material, frame count, `fps`, `loop`, current `index` and its asset ID.
- `set-material` and `add-material` take `map`; the frames must be catalog images, which the host decodes before the edit.

Nodes contain `id`, optional `label`, `parent`, `translation`, `rotation`, and `scale`.
Mesh nodes also require both `geometry` and `material` resource IDs.
Group nodes have neither resource reference.
The default parent is `null`.
The default transform is `[0, 0, 0]`, `[0, 0, 0, 1]`, and `[1, 1, 1]`.
Rotation uses an XYZW quaternion that the session normalizes.

Quaternions must be finite and nonzero.
Scales must remain positive at Float32 precision.
The scene graph rejects missing parents, cycles, excessive depth, singular transforms, and world transforms that overflow Float32.
Normal transforms must also remain finite.
Cached local geometry bounds provide a conservative world Float32 check from eight corners per mesh.
The check bounds the sum of absolute matrix products, so intermediate shader arithmetic cannot overflow before cancellation.

The camera contains `eye`, `target`, `up`, `fov`, `near`, and `far`, plus the optional `projection`, `orthoScale`, `focalLength`, `sensorWidth`, `shift` and `fStop` when the recipe sets them.
Its defaults are `[4, 3, 5]`, `[0, 0, 0]`, `[0, 1, 0]`, `45`, `0.1`, and `1000`.
FOV uses degrees and ranges between zero and 180.
The clipping range must satisfy `0 < near < far` at Float32 precision.
Eye and target must differ at Float32 precision.
The session normalizes the nonzero up vector and rejects collinear view directions.

View and projection matrices must remain finite and nonsingular at Float32 precision.
Projection validation uses aspect one because the renderer owns the actual target aspect.
An explicit top view can use `eye: [0, 3, 0]`, `target: [0, 0, 0]`, and `up: [0, 0, -1]`.

### Instances on points

A node with `instances` repeats its geometry and material at points. At `scene_create` it becomes a group node (the
node's id, with its transform and parent) and one child node per point (`<id>.0`, `<id>.1`, and so on), all sharing
the geometry and material, so the renderer draws them as one instanced batch. After that they are ordinary nodes.
`instances` is accepted in the recipe, not in an `add-node` operation.

```text
{ "id": "grass", "geometry": "blade", "material": "green", "parent": "ground",
  "instances": { "surface": { "geometry": "ground-shape", "count": 300 }, "seed": 3,
                 "where": { "gt": [{ "attr": "position", "component": "x" }, 0] },
                 "yaw": true, "scale": [0.7, 1.3] } }
```

Give exactly one point source. `grid` is `{ counts: [nx, ny, nz], spacing: [dx, dy, dz] }`, centred on the group.
`scatter` is `{ count, min, max }`, seeded random points in a box. `surface` is `{ geometry, count }`, seeded points
on the triangles of a recipe geometry in proportion to their area; they are in that geometry's own space, so parent
the group to the node that carries it. `seed` (default 0) fixes the placement. `where` is a number
[field expression](mesh.md#field-expressions) over the points (position, normal, index): points where it is 0 are
dropped. `curve` is `{ points, count, length, closed, fillet }`: `count` points at equal arc length along the polyline through `points` (2 to 256, the first and last on its ends unless `closed`), or `length` spacing in metres between samples (not both `count` and `length`), with `fillet` rounding every corner by that radius (reduced where it does not fit). `yaw` turns each instance randomly about up, `alignToNormal` (surface or curve) turns up to the surface normal or the direction of the curve, and `scale`
is a random uniform `[min, max]`. At most 2048 candidate points per node, and the scene's node limit still applies.
The group's own scale applies to the spacing and the points, because they are in its space.

`place` shapes the points once the source made them, and every choice is seeded and repeatable:

```text
"place": { "spacing": 1.4,
           "density": { "saturate": { "sub": [1.4, { "mul": [0.1, { "length": [{ "attr": "position" }] }] }] } },
           "variants": ["rockRound", "rockTall", { "geometry": "rockBlock", "material": "moss" }],
           "size": { "vec": [1, { "add": [0.6, { "mul": [0.5, { "fract": { "mul": [{ "attr": "index" }, 0.37] } }] }] }, 1] } }
```

- `spacing`: Poisson-disk minimum distance. Points are kept in order, so a point is dropped when a kept one is closer; give enough candidates (`count`) to fill the area. Runs after `where` and `density`.
- `density`: number field, the chance (0 to 1) that a point stays. Same seed, same points.
- `variants`: 1 to 16 geometry ids or `{ geometry, material }`. Each point takes one at random, or the one `variant` (a number field, rounded down and wrapped) names. The node needs only a material when it lists variants.
- `rotation`: vector field of extra Euler angles in radians, turned after `yaw` and `alignToNormal`. `size`: number or vector field, a scale per point, multiplied by the `scale` range and kept from 0.001 to 1000.
- `at`: with a `surface` source, `"vertices"` (welded by position) or `"faces"` (centres, normal of the face) place on the mesh itself; `count` is then the most points allowed, and more is an error.
- `realize` (on `instances` or `place`): when `true`, merges the placed instances into one realized mesh per material under the group node, bounded by `maxVertices`.

### Placed catalog assets

A node with an `asset` field places a GLB from the `--assets` catalog inside the recipe, so one scene holds terrain, lights, procedural meshes and imported models (`scene_create_asset` opens one asset alone). The node is a group: its transform places the asset, and its parts become generated child nodes named `<node>/<part index>` that `scene_inspect` and `scene_export_recipe` leave out.

```json
{ "id": "tree-1", "translation": [4, 0, -2], "asset": { "id": "<64 hex asset id>",
  "materials": [{ "name": "Leaves", "color": [0.2, 0.5, 0.1] }],
  "clip": { "index": 0, "start": 0.5, "speed": 1, "loop": true } } }
```

- `id` is an id from `scene_asset_catalog`. `materials` override source materials by glTF material name (`color`, `metallic`, `roughness`, `opacity`, `emission`, `emissiveColor`, and `tag`: `foliage` or `grass` makes the leaves of an imported tree sway in `environment.wind` and cast moving shadows, like grown ones); `scene_inspect` lists the names. Placements with the same overrides share one material. An override with an `id` (1 to 128 characters, one per placement, not an existing material id) gets a material of its own that a `motion` material track names: `{ "kind": "material", "id": "stool-heat", "property": "emission" }` (also `emissiveColor`, `color`, `metallic`, `roughness`) fades a heat glow without another `scene_create`; textures and shading stay.
- Placements of the same asset share geometry and materials, so they draw as one instanced batch per material (`drawBatches` in the render status stays flat as copies are added). Skins and morphs keep working.
- `clip` plays that clip, held at its first frame until scene time `start`, then at `speed`, looping unless `loop` is false. Each placement that plays a clip gets a decoded copy of its own (its geometry is not shared), because a pose is state of one decoded asset. A seek gives the same frame as playing to that time. `set-motion` tracks still move the node itself, so a walking figure is a clip plus a motion track on the same node.
- Bounds: 512 placements, 16 different assets, 16 placements playing a clip, and `maxNodes` for the generated parts. Placed geometry does not count against `maxVertices`; each asset keeps the decoder limits of the catalog.
- `scene_inspect` adds `assets`: per placement the asset id, part count, world bounds, clips (index, name, duration), material names and the playing clip.
- `scene_apply` places a catalog asset with `add-node` even when the scene had none: the first `add-node` with an `asset` loads it, a second node with the same asset id shares its geometry. An id the catalog does not list fails with an error that names it and points at `scene_asset_catalog`, and the placement and asset bounds below still hold. A session made by `scene_create_asset` holds one imported asset and cannot place others. Render jobs draw placed assets and play their clips on scene time (`settings.motion.start`).

### Vegetation

A node with a `vegetation` field is a group that grows trees from the addon in [Vegetation](https://crucible.codepawl.com/vegetation.md). Its parts become generated child nodes like placed assets (`<node>/<instance>/<bark|foliage>`), left out of `scene_inspect` nodes and `scene_export_recipe`.

```json
{ "id": "forest", "vegetation": { "mix": { "broadleaf": 3, "conifer": 2, "bush": 2 }, "seed": 11, "season": 0.4,
  "scatter": { "ground": "hills", "density": 0.014, "slopeLimit": 30, "exclude": [{ "center": [0, 0], "radius": 8 }, { "node": "cabin", "radius": 3 }] } } }
```

- One tree: `{ "species": "conifer", "seed": 2, "height": 9, "leaves": "cards" }` grows at the node transform. A scatter takes `mix` (species weights, also `grass` and `flowers`) and `scatter`: `ground` (a node drawing a terrain geometry; give the group the same transform), `density` per square metre, `slopeLimit` degrees, `area` `{min,max}` in `[x,z]`, `exclude` (circles, boxes or a node and radius; terrain holes always stay clear), `variants` and `scale`.
- The same options give the same instances as `scatterVegetation` from `crucible/addons/vegetation`: the recipe path calls it with the terrain's `heightAt` and `isHole`.
- Levels of detail come from the recipe camera `eye` when the scene is built or edited (`distanceScale`, `cullDistance`), never from the frame being drawn, so a seek, a camera track or a shot cannot change them. Edit the camera with `set-camera` to regrow the levels for another viewpoint.
- `season` runs 0 summer, 0.35 gold, 0.6 orange, 0.85 brown; 0.9 and above drops the leaves of broadleaf, birch and bush, while conifer and palm stay green. Cards recolour their leaf sprite and mesh leaves and grass blades recolour the material.
- Materials with tag `foliage` or `grass` sway. `environment.wind` is `{ "strength": 0.3, "direction": 0 }` (strength 0 to 4; direction in degrees, 0 toward +x and 90 toward +z, turning the sway and the grass gusts). The wind clock is the render time, so a render job or `scene_review` `rendererTime` gives the same frame at the same time.
- At most 1000 instances (a scatter whose area times density is above 4000 is refused first), and `maxNodes` for the generated parts. `scene_inspect` adds `vegetation`: per node the instances, culled count, triangles, and per species the instances and the count at each level.

### Crowds

An asset placement with a `crowd` field fills its group node with `count` (1 to 1000) copies of one catalog character playing one clip, each at its own time offset and rate, drawn as one batch per material. Options and measurements are in [Crowds](https://crucible.codepawl.com/retarget.md).

```json
{ "id": "people", "asset": { "id": "<catalog asset id>", "crowd": { "clip": 3, "count": 200, "seed": 7, "spacing": 2, "farDistance": 25, "farRate": 6 } } }
```

- `clip` is a clip index, `layout` is `grid` or `scatter`, and the pose is a pure function of scene time, `seed` and the recipe camera, so a render at a time equals the frame reached by playing. People farther than `farDistance` from the recipe camera hold each pose for `1 / farRate` seconds.
- The crowd takes one decoded copy of the asset, the generated part nodes (count times materials) count against `maxNodes`, and `scene_inspect` lists it under `assets` with `kind: "crowd"`, `instances`, `batches`, `frames`, `paletteBytes` and `boundsRadius`.

### Seams between meshes

Three node fields fix what looks wrong where meshes meet; `add-node` and `set-node` take all of them. `blend: { "radius": 0.15 }` (metres, 0.005 to 2) softens the seam where a rock or trunk cuts into the ground and needs a preview with depth; see [mesh-blend.md](mesh-blend.md). `decal: true` and `depthLayer` (0 to 4) stop z-fighting on flush faces; see `depthBias` in `scene_capabilities`.

### Visibility and render flags

Five node fields change how a node renders; `add-node` and `set-node` take them, and `scene_capabilities` lists them as `renderFlags`.

- `visible: false` hides the node and every child: nothing is drawn and nothing casts a shadow, but the parts stay in their batches, so a film can cut between shots without parking parts out of view. Key it in a motion track with `{ "kind": "node", "id": "robot", "property": "visible", "keyframes": [{ "time": 0, "value": 1 }, { "time": 2, "value": 0 }] }`; values are 1 or 0 and the track steps by default.
- `castShadow: false` and `receiveShadow: false` (mesh nodes) stop a mesh casting or receiving shadows. Both default to true; glass casts none unless `castShadow` is set.
- `holdout: true` writes zero colour and zero alpha where the mesh covers, and still hides what is behind it and still casts its shadow. `shadowCatcher: true` draws only the shadow it receives, black with the shadow as premultiplied alpha, and casts none. Both are for compositing over footage and need a transparent canvas: `new CrucibleRenderer(canvas, parts, { transparent: true })`. A node is never both. The shadow catcher shows the sun shadow only.

- `shadowOnly: true` (mesh nodes) keeps the node in the shadow passes and leaves it out of the picture, the same as Blender's Ray Visibility > Camera off. Use it for a gobo, such as a window frame outside the shot that throws bars of sun onto a wall. It is also left out of depth, object ID and wireframe passes. It defaults to false, so no scene changes. A node cannot set `shadowOnly` together with `castShadow: false`, `holdout` or `shadowCatcher`. Every backend honours it: the raster renderer, and Cook on the cpu, gpu (WebGL2), webgpu and native backends (both native kernels). Cook leaves the node out of camera rays (the first hit of each path) and keeps it for shadow and bounce rays, so a mirror or glass can still show it. No backend lists it as an ignored feature.

Parts with different `castShadow`, `receiveShadow`, `holdout`, `shadowCatcher` or `shadowOnly` values batch apart; `visible` never splits a batch. `receiveShadow`, `holdout`, `shadowCatcher` and `shadowOnly` changes need `replaceParts`, not `updateParts`.

### Relations between parts

A mesh node can list `relations` that place it against other mesh nodes, so a resized body keeps its handle where it
belongs. They work on world bounds, are solved after the geometry exists, and are solved again on every `scene_apply`
(a `set-node` that moves or resizes the target, an `edit-mesh` that changes its faces), so one edit to the body moves
every part that sits against it.

```text
{ "id": "handle", "geometry": "grip", "material": "steel",
  "relations": [ { "kind": "attach", "to": "body", "side": "+x" } ] }
```

| `kind` | Fields | Decides |
| --- | --- | --- |
| `attach` | `side`, `offset` | Touches the target's face on `side` (`+x`, `-x`, `+y`, `-y`, `+z`, `-z`) and centres on the other two axes. |
| `gap` | `side`, `offset` | Only the touching axis: `offset` metres from the face, negative sinks into the target. |
| `flush` | `side`, `offset` | Puts its own face on `side` level with the same face of the target. |
| `align` | `axis`, `at`, `offset` | Puts its `min`, `center` or `max` on that axis at the target's. |
| `centered` | `axes` (default all three) | Centres on those axes. |

Every relation takes `to` (a mesh node ID) and an optional `region`, a mesh tag: only the faces of the target that carry
that tag count as its bounds, so a part can sit on the tagged top of a tank and not on its tallest point. A relation
decides only its own axes and replaces the node's `translation` on them; the other axes keep the authored value.

Limits: at most 8 relations per node and 256 nodes with relations. Targets and nodes must be mesh nodes. Two relations
on one node cannot decide the same axis. Relations form a graph over parts and parents; a loop (a part waiting on its own
child included) is rejected with the loop spelled out. Solving is deterministic: the same recipe gives the same
translations, whatever the order of the nodes. A relation that cannot be satisfied, such as an unknown tag, rejects the
whole edit and names the relation. `relations: []` in `set-node` removes them and keeps the part where it is. The
exported recipe holds both the relations and the solved translations. Motion and physics move nodes after the solve and
know nothing of relations. The code loads on demand (`relations`, see On-demand code). The MCP schema only says `relations` is a list; the kinds and fields are in `scene_capabilities` under `relations`.

## Transactions and ownership

`apply(operations, { expectedRevision })` requires the current revision and returns the new revision.
It rejects an empty command list.
Each successful application increments the revision once, including a command that retains existing values.
Stale revisions and invalid commands leave canonical state, published matrices, materials, and the revision unchanged.
Every command in a batch stages before any command publishes.

Commands run sequentially against a private candidate recipe.
Final resource references and hierarchy must be valid before publication.

| Operation | Fields |
| --- | --- |
| `set-node` | `id`, optional `translation`, `rotation`, `scale`, `parent`, `label`, `geometry`, `material` |
| `set-material` | `id`, optional `color`, `metallic`, `roughness`, `emission`, `emissiveColor`, `pattern`, `map` |
| `set-camera` | Optional `eye`, `target`, `up`, `fov`, `near`, `far`, `projection`, `orthoScale`, `focalLength`, `sensorWidth`, `shift`, `fStop` directly on the command; `focalLength` replaces `fov` and `fov` replaces `focalLength` |
| `add-geometry` | `geometry`, containing a complete geometry record |
| `remove-geometry` | `id` |
| `add-material` | `material`, containing a complete material record |
| `remove-material` | `id` |
| `add-node` | `node`, containing a complete node record |
| `remove-node` | `id`, optional boolean `recursive`, default `false` |

Reparenting changes hierarchy while preserving each node's local transform.
Commands can add or remove nodes and resources.
Adding a duplicate ID or removing a missing ID fails.
Resource removal can precede rebinding or dependent node removal in the same batch.
The final recipe must contain every resource and parent referenced by surviving nodes.
Mesh nodes require both geometry and material IDs in the final recipe. A node in `scene_create` that names a geometry and leaves out the material gets the material `default` (grey, every field at its default), which is added to `materials` when missing, so the exported recipe names it. `geometries` and `materials` may be left out of a recipe and read as empty; `nodes` is required. A node that names a material without a geometry is rejected: name a geometry or drop the material.

Nonrecursive removal rejects a node that has children at that command's position in the batch.
Child removal or reparenting must precede nonrecursive parent removal.
Recursive removal explicitly removes that node and its entire current subtree.
Node removal leaves geometry and materials intact until explicit resource removal.
Changing a geometry definition or material tag requires removing and adding its resource record.
Direct `set-material` commands still reject tag changes.

The session copies input recipes and commands.
`exportRecipe()` and `camera` return detached JSON snapshots.
Published material objects are frozen and expose immutable arrays through retained getters.
Material reads do not allocate arrays or scan resource collections.

Surviving nodes retain their part and matrix identities when geometry and material bindings retain their resource identities.
Rebinding replaces the part and its matrix.
Removing and adding the same node ID also replaces its part.

Geometry identity survives when its ID and complete definition match an active or checkpoint resource.
Object key order does not affect that comparison.
Omitted parameters and explicit defaults remain distinct definitions.
A changed definition creates new immutable geometry and replaces parts bound to that resource.
Multiple nodes referencing the same resource ID share its geometry.

`parts` returns a frozen current list.
The list retains its identity while its ordered part identities remain unchanged.
Transform, material value, camera, and group-only edits can retain the list.
Removed parts leave the current list and are no longer renderer update targets.
Removed material handles remain readable with their last committed snapshot.

`parts` is a privileged renderer adapter surface.
Its geometry typed arrays follow the engine's immutable geometry contract and must never change or detach.
The session does not duplicate geometry buffers or regenerate unchanged geometry during transactions.
Writes to retained matrices cannot poison the private recipe or inspection transforms.

A successful transaction overwrites those matrices from canonical state.
Detached matrices reject publication before canonical state changes.
An agent adapter must expose JSON commands and snapshots rather than renderer typed arrays.

`topologyRevision` starts at zero and increments only when ordered part identities or membership change.
Restore follows the same rule.
Failed transactions leave both revisions unchanged.
Unused resource or group-only edits do not increment `topologyRevision`.
Renderer adapters can compare it to choose topology replacement or retained instance updates.
The session does not replace renderer GPU resources itself.

`checkpoint()` returns an opaque, frozen handle that belongs to its session.
Checkpoint snapshots are private and cannot change through the handle.
Checkpoints retain recipe snapshots and references to their geometry, material handles, and parts.
Restore reuses those resources without regenerating geometry.
Unchanged active parts take priority when their bindings still match.
Otherwise, restore can recover the checkpoint's original part and matrix identities.

`restore(handle, { expectedRevision })` applies the same atomic validation and increments the revision.
Released and foreign handles fail.
`releaseCheckpoint(handle)` frees its slot and does not change the scene revision.
Released geometry references leave session ownership unless the active scene or another checkpoint still needs them.
There is no separate unbounded geometry history cache.

## Budgets and inspection

The optional second constructor argument overrides the following positive integer limits.
`scene.limits` reports the resolved, frozen values.

| Limit | Default |
| --- | --- |
| `maxNodes` | `4096`, also the hard maximum |
| `maxDepth` | `256`, counting a root as depth one |
| `maxGeometries` | `256` |
| `maxMaterials` | `256` |
| `maxVertices` | `250000`, across unique active, checkpoint, and staged geometry allocations |
| `maxGeometryBytes` | `33554432` |
| `maxOperations` | `256`, per application |
| `maxCheckpoints` | `16` |
| `maxRecipeBytes` | `1048576`, also used for each command batch |

Preflight accounts for peak geometry ownership before generating any new resource.
It counts each unique active or checkpoint allocation once, using actual vertices and typed array bytes.
New resources contribute their conservative vertex and byte bounds.
Its byte bound uses 56 bytes per vertex for eight floats and at most six Uint32 indices.
Actual generated geometry bytes must also fit the budget.

Atomic replacement retains the old active geometry until the candidate commits, so both allocations count during preflight.
A single replacement can fail even when the final geometry fits alone.
Checkpoint sharing does not duplicate geometry bytes.
Unused active resources still count until explicitly removed.
Releasing checkpoints can free ownership for later additions.

Byte counts include position, normal, UV, and index typed arrays across unique owned geometry allocations.
They exclude JavaScript objects, temporary generator allocations, transaction matrices, checkpoint recipes, and renderer GPU memory.
External renderer adapters can retain removed arrays beyond the session's ownership accounting.
The JSON budget uses conservative UTF-8 traversal accounting and also checks serialized JSON size.
Normalization can increase serialized size, so normalized recipes also pass the JSON budget.
Each checkpoint stores at most one normalized recipe within that limit.

`inspect({ ids, limit, includeBounds })` returns JSON with both revisions, global counts, and selected node records.
Its default limit is 64, capped by `maxNodes`.
Requested IDs must exist.

`truncated` reports whether the result omitted selected nodes.
Global counts include nodes, render parts, unique geometries, materials, and unique geometry vertices.
`geometryBytes` reports actual unique typed array bytes.
`estimatedGeometryBytes` reports the conservative preflight bound.

Those fields describe active resources, including unused resources.
`residentGeometryBytes` and `residentGeometryVertices` include unique active and checkpoint allocations.
Inspection does not report GPU timing or renderer allocation.

With `includeBounds: true`, each mesh record includes `{ min, max }` from every transformed geometry vertex.
Group bounds are `null`.
Bounds use published canonical world matrices, not externally modified renderer matrices.
They describe the authored mesh surface without shader effects or displacement.

## Design choice

| Design | Benefit | Cost |
| --- | --- | --- |
| Evaluate arbitrary JavaScript scene functions | Full access to existing engine functions | Execution authority, mutable ownership, and replay depend on external isolation |
| Validate JSON recipes and typed commands | Bounded inputs, private ownership, atomic batches, and reproducible snapshots | A deliberately limited geometry and editing vocabulary |

The addon uses validated JSON because ownership and atomic editing form its public contract.
The separate [source MCP adapter](mcp.md) translates tool calls into this API without placing transport logic inside the scene session.
This version does not claim Blender feature parity.

| Geometry ownership design | Benefit | Cost |
| --- | --- | --- |
| Regenerate the full scene after every command | Simple replacement ownership | Repeated geometry allocation and lost renderer identities |
| Retain immutable resource records in active state and bounded checkpoints | Shared geometry, replay, stable parts, and peak allocation preflight | Explicit staging and checkpoint ownership accounting |

The addon retains immutable resource records because topology editing must preserve unaffected geometry and renderer handles.
