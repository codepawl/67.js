# Polygon mesh core

`67js/addons/mesh` is the polygon modeling core for agents, available since 0.11.0. It holds polygon topology, converts to and from renderer geometry, checks meshes and runs the editing operators (extrude, inset, booleans and so on) listed below.

```js
import { box } from '67js';
import { meshFromGeometry, editMesh, meshData, validateTopology, extractRender, lintMesh, facesWithTag } from '67js/addons/mesh';

const mesh = meshFromGeometry(box(0, 1));   // 8 vertices, 12 edges, 6 quads, tagged top/bottom/side/...
lintMesh(mesh).ok;                          // true: closed, consistently wound, no degenerate faces
facesWithTag(mesh, 'top');                  // [face index]

const edit = editMesh(mesh);                // half-edge topology for local edits
validateTopology(edit);                     // { vertices, edges, faces, loops, euler }
const back = meshData(edit);                // compact again

const { geometry } = extractRender(back);   // positions, normals, uvs, indices for Renderer67
```

## MeshData

`createMeshData({ positions, faceOffsets, cornerVertices, attributes })` returns a frozen mesh in the layout Blender
uses for evaluated meshes:

| Field | Type | Meaning |
| --- | --- | --- |
| `positions` | `Float32Array`, 3 per vertex | Vertex positions |
| `faceOffsets` | `Uint32Array`, faces + 1 | Face `f` owns corners `faceOffsets[f]` to `faceOffsets[f + 1]` |
| `cornerVertices` | `Uint32Array` | Vertex of each corner, in winding order |
| `edgeVertices` | `Uint32Array`, 2 per edge | Derived unique edges |
| `cornerEdges` | `Uint32Array` | Edge from each corner to the next corner of its face |
| `attributes` | `{ point, edge, face, corner }` | Named `{ data, size }` arrays per domain |

Faces are polygons with three or more corners; consecutive corners cannot repeat a vertex. Inputs are not copied.
Attribute arrays may be `Float32Array`, `Uint8Array`, `Uint16Array`, `Uint32Array` or `Int32Array` with 1 to 16
components. Edge attributes need explicit `edgeVertices` and `cornerEdges`, because derived edge order is internal.

Conventions used by the other functions:

- Corner `uv` (size 2) and `color` (size 3) are UV channel zero and vertex colour.
- Edge `sharp` (`Uint8Array`) marks hard edges.
- Face `tag:<name>` (`Uint8Array`, 0 or 1) marks a face as carrying a tag. `meshTags`, `facesWithTag` and
  `tagCounts` read them. A face can carry several tags.

Limits: 4,000,000 vertices and 16,000,000 corners per mesh.

## EditMesh

`editMesh(meshData)` builds a mutable half-edge mesh in BMesh's model, stored in typed arrays:

- Each edge has two endpoint slots; the slots around a vertex form its disk cycle.
- Each face corner is a loop with `next`/`prev` around its face and `radialNext`/`radialPrev` around its edge.
- Polygons of any size and non-manifold edges are representable.

Element indices start equal to the MeshData vertex, edge, face and corner indices. Methods:
`createVertex`, `createFace(vertices)` (creates missing edges), `ensureEdge`, `findEdge`, `removeFace`, `removeEdge`,
`removeVertex`, `vertexEdges`, `vertexDegree`, `edgeLoops`, `edgeFaceCount`, `faceLoops`, `faceVertices`,
`faceNeighbors`, `liveIndices(domain)`, and `ensureAttribute(domain, name, type, size)` for attributes that grow with
the mesh. Removed indices are reused. `meshData(edit)` compacts the result; wire edges are dropped and loose vertices
kept.

`validateTopology(edit)` checks every disk, radial and face cycle and throws a `RangeError` that names the first
broken element.

## Conversion and rendering

`meshFromGeometry(geometry, { weld, quads = true, tags = 'axis' })` converts renderer geometry (indexed triangles
with vertices split at seams):

- Vertices within `weld` merge; the default is 1e-6 of the bounds diagonal.
- UVs and colours become corner attributes, so seams survive welding.
- Edges where the input normals were split become `sharp`, so hard edges survive.
- With `quads`, flat triangle pairs that agree on every attribute join into convex quads, best-shaped first.
- With `tags: 'axis'`, faces whose normal is within 45 degrees of an axis get `top`, `bottom`, `right` (+X),
  `left` (-X), `front` (+Z) or `back` (-Z); the four horizontal ones also get `side`.

`extractRender(mesh, { sharpAngle })` returns `{ geometry, renderVertexSource, cornerRenderVertex, triangleFaces }`.
Corner normals are angle-weighted and smoothed across an edge unless it is `sharp`, a boundary, non-manifold,
inconsistently wound, or bends more than `sharpAngle`. Render vertices split at hard edges and at UV or colour
seams. Quads split along the shorter diagonal and larger polygons use ear clipping in their own plane (up to 4096
corners). After a deform-only change, `gatherRenderPositions(mesh, renderVertexSource)` re-gathers positions without
rebuilding the topology.

`faceNormals`, `cornerNormals`, `triangulateMesh`, `joinTriangles`, `tagFacesByAxis`, `weldVertices` and
`rebuildFromCorners` are exported for operators that need one step.

## Lint

`lintMesh(mesh, { geometry = false })` returns `{ ok, counts, parts, valence, quadQuality, topologyScore, tags, bounds, problems }`:

- `valence` counts interior vertices by edge degree: `{ regular, poles3, poles5, poles6Plus }` (boundary vertices on open rims are left out).
- `quadQuality` summarizes quad faces: `{ meanAngleError, maxAngleError, maxAspect, maxWarp }` (angles in degrees from $90^\circ$ and across the quad diagonal).
- `topologyScore` is a normalized score in $[0, 1]$ (`0` when `ok` is `false`) combining quad share, interior regular/pole valence and quad angle/planarity health.

Each problem has `kind`, `severity`, `count`, up to eight sample indices and a suggested `fix`:

| Kind | Severity | Sample indices |
| --- | --- | --- |
| `non-manifold-edge` | error | edges used by three or more faces |
| `inconsistent-winding` | error | edges whose two faces wind the same way |
| `inverted-part` | error | closed parts with negative volume |
| `degenerate-face` | error | faces with near-zero area |
| `boundary-edge` | warning | edges with one face (open surfaces) |
| `loose-vertex` | warning | vertices used by no face |
| `non-planar-quad` | warning (`geometry: true`) | quads folded by more than 45 degrees across their diagonal |
| `skewed-quad` | warning (`geometry: true`) | quads with a corner more than 60 degrees from a right angle (outside radial pole fans) |

`ok` is false when any error is present. With `geometry: true`, spatial checks (`intersecting-parts`, `self-intersection`, `thin-wall`, `floating-part`, `asymmetric`) and quad distortion warnings are included.

## Selection and edits

`selectFaces(mesh, rule)` turns a JSON rule into a face mask. `applyMeshEdits(mesh, edits)` runs an edit log and
returns `{ mesh, results }`. Both are what recipe `mesh` geometries and the `mesh_edit` tool use.

Selection rules:

| Rule | Selects |
| --- | --- |
| `{ "all": true }` | every face |
| `{ "tag": "top" }` | faces carrying a tag |
| `{ "normal": [0, 1, 0], "maxAngle": 10 }` | faces facing within `maxAngle` degrees (default 10) of a direction |
| `{ "inside": { "min": [x, y, z], "max": [x, y, z] } }` | faces whose centroid lies in a box |
| `{ "faces": [0, 4] }` | explicit face indices |
| `{ "and": [...] }`, `{ "or": [...] }`, `{ "not": rule }` | combinations |
| `{ "grow": rule, "steps": 1 }` | the selection plus faces sharing an edge, repeated |
| `{ "boundary": rule }` | selected faces that touch an unselected face or an open edge |
| `{ "field": expression }` | faces where a [field expression](#field-expressions) is not 0 |

Edits (names follow Blender's `bmesh.ops` where they match):

| Op | Fields | Creates tags |
| --- | --- | --- |
| `extrude_face_region` | `select`, `offset`, optional `direction` or `alongNormals`, `name` | `<name>.cap`, `<name>.side` |
| `extrude_individual` | same | same, per face |
| `inset_region` | `select`, `thickness`, optional `depth`, `name` | `<name>.cap`, `<name>.rim` |
| `inset_individual` | same | same, per face |
| `delete` | `select` (required) | |
| `flip_normals` | `select` | |
| `translate` | `select`, `offset` [x, y, z], optional `falloff` `{ radius, curve, connected }` | |
| `merge_by_distance` | `distance` (default 1e-4) | |
| `tag` | `select`, `name` (required) | `<name>` |
| `boolean` | `operation` (`union`, `difference`, `intersect`), `cutter`, optional `translation`, `rotation` (XYZW), `scale`, `name` | `<name>.cut` |

- `select` defaults to every face, except for `delete` and `tag`.
- `name` defaults to `<op>-<index>`, for example `extrude-1`.
- With `alongNormals: true`, each vertex of the region moves along its own normal instead, so a ring of faces around
  a cylinder grows outward as one joined hoop (Blender's Extrude Faces Along Normals).
- Extrusions move each group of edge-connected faces along that group's own average normal. Faces in one group
  that face opposite ways (the four sides of a box) cancel out; use the `_individual` op or pass `direction`.
- Caps keep their earlier tags; side and rim faces start without tags.
- Falloff curves follow Blender's proportional editing: `smooth`, `sphere`, `root`, `sharp`, `linear`,
  `constant`, `inverseSquare`. With `connected`, distance is measured along edges.
- An edit that selects no faces, names an unknown tag, or grows the mesh past its limits throws an error naming
  the edit index and op. A log holds at most 64 edits.

Each result records `selected`, the `tags` created with their face counts, op-specific counts (`deletedFaces`,
`movedVertices`, `removedVertices`) and the mesh size `after` the edit.

### Booleans

Booleans run on [Manifold](https://github.com/elalish/manifold) (Apache-2.0), the library behind Blender 4.5's
Manifold solver, compiled to WebAssembly. In a recipe, `cutter` is a primitive or profile record like `base`
(`{ "type": "cylinder", "segments": 32 }`), placed by `scale`, then `rotation`, then `translation` in the mesh's local
space. Faces from the mesh keep their tags; faces the cutter contributes (the walls of a hole, the surface of a
union) get `<name>.cut`. Flat faces come back as polygons; faces with holes come back as triangles, joined into quads
where flat pairs allow.

A `cutter` can also be `{ "geometry": "<id>" }`, naming another geometry in the recipe's `geometries`: a `mesh` with its
own edits and stack, or any primitive record. Meshes then form a directed acyclic graph of cuts, and editing the
cutter rebuilds only the meshes that name it (its record joins their cache key). Put `translation`, `rotation` and
`scale` on the boolean edit; the reference takes no other field. The cutter geometry needs no node; it can stay unseen.
Limits: a chain of at most 4 cutter geometries, and at most 250,000 estimated vertices across the cutters a mesh names.
A self-reference, a cycle (`a -> b -> a`) or an unknown ID fails when the recipe is checked, with the chain and the IDs
that exist. Imported-part edits take inline records only. The same recipe always gives the same bytes.

Both inputs must be closed and consistently wound. A boolean on an open mesh fails with the lint counts and a fix.
A difference that leaves a hollow inside the mesh is valid; `lintMesh` reports it under `parts.cavities` instead of as
an inverted part.

Outside recipes, call `await loadMeshBooleans()` once, then `meshBoolean(mesh, cutter, operation, { cutTag })` or
`applyMeshEdits(mesh, edits, { resolveCutter })`. The library loads `manifold-3d` as an optional peer dependency,
like Rapier for physics: install `manifold-3d@3.5.4` next to `@codepawlhq/67js` to use booleans, in the library and
in the MCP server alike. The MCP runtime serves Manifold's module and binary to its preview page from that
installation, on the page's own origin; the page policy adds only WebAssembly compilation (`'wasm-unsafe-eval'`).
Without the peer, a boolean edit fails with the install command and everything else keeps working. Keeping
Manifold out of the package holds the npm archive under its 1 MiB budget.

Measured on this machine (Node 24, one thread): engine load 26–45 ms; cube minus a 32-sided cylinder 25–30 ms;
a 32,768-face sphere minus a box about 0.6 s including conversion and lint.

### Mirror, array and solidify

These three (and `bevel`, below) work as edits and as stack nodes:

| Op | Fields | Creates tags |
| --- | --- | --- |
| `mirror` | `axis` (`x` default, `y`, `z`), `merge` (default 0.001), `name` | `<name>.mirrored` |
| `array` | `count` (1 to 256, default 2), `offset` [x, y, z], `relativeOffset` [x, y, z] in bounding-box sizes (default [1, 0, 0] unless `offset` is given), `merge`, `name` | `<name>.last` |
| `solidify` | `thickness`, `offset` (-1 inward by default, 1 outward, 0 centred), `evenThickness` (default true), `name` | `<name>.inner`, `<name>.rim` |

- `mirror` reflects across the plane through the local origin. Vertices within `merge` of the plane are shared by
  both halves and faces lying in the plane are removed, so mirroring a closed half that touches the plane gives one
  closed solid. Mirrored faces swap their axis tags (`left` and `right` for x, `top` and `bottom` for y, `front` and
  `back` for z), so tags keep matching where the faces are.
- `array` with `merge` welds touching copies and removes the faces between them, giving one solid.
- `solidify` adds an inner shell and rim quads along open edges. An open surface becomes a closed wall; a closed
  surface becomes a hollow shell (reported as a cavity).

`removeCoincidentFaces(mesh)` is exported for the same cleanup after other operations.

### Modifier stack

A recipe mesh may carry `stack`, a list of `mirror`, `array`, `solidify`, `bevel`, `subdivide`, `uv_unwrap`, `set_position`, `displace`, `decimate`, `remesh`, `weld`, `triangulate`, `edge_split`, `smooth`, `simple_deform`, `cast`, `screw`, `wireframe`, `skin`, `lattice`, `curve`, `hook`, `wave`, `build`, `weighted_normal` and `smooth_by_angle` nodes (up to 16) evaluated after the
edits without changing them, as Blender's modifier stack. Every prefix (the edit result, then each node) is cached
by its recipe text in a least-recently-used cache bounded at 64 entries and 64 MiB, so changing a late node reuses
the earlier work. Results list one entry per node with `cached: true` when reused. `meshCacheStats()` reports hits
and misses. `evaluateMeshStack(mesh, stack, { cache, cacheKey })` runs a stack outside recipes.

The `mesh_stack` tool sets the whole stack in one revision. `apply: n` moves the first `n` nodes into the edit log,
as Blender's Apply modifier, which leaves the result unchanged.

### Shape keys

A recipe `mesh` geometry may carry `shapeKeys` (up to 16), named offsets from the finished mesh that become glTF morph targets.
A key is `{ "name": "blink", "offsets": [{ "select": { "tag": "lid" }, "offset": [0, -0.1, 0] }] }`, a list of moves like the
`translate` edit, or `{ "name": "squash", "edits": [...] }`, mesh edits that only move vertices (`set_position`, `displace`,
`sculpt`, `simple_deform`, `lattice`, `hook`, `wave`) run on the mesh after the stack. A key that adds or removes vertices is
refused with the vertex counts. `value` (0 to 1) is the weight without motion.

Animate a key with the existing morph track: `{ "kind": "morph", "id": "blink", "property": "weight", "keyframes": [...] }`. Weights
from 0 to 1 add up, so two keys blend. A GLB export writes the targets, their names as `mesh.extras.targetNames` and the weights.
Normals stay those of the base mesh. Test: `tests/mesh-shape-keys.test.js`.

### Whole-mesh modifiers

`weld`, `triangulate`, `edge_split`, `smooth`, `simple_deform`, `cast`, `screw`, `wireframe`, `skin`, `lattice`, `curve`, `hook`, `wave`, `bounding_box`, `convex_hull`, `ocean`, `build`, `weighted_normal` and `smooth_by_angle` take no selection and no name, and work as edits or stack nodes. Their fields and defaults are plain data in `MESH_MODIFIER_NOTES` (`src/agent-scene-capabilities.js`), which `scene_capabilities` returns as `meshModifiers`; the code is in `src/mesh-modifiers.js` and `src/mesh-restructure.js`.

| op | fields | does |
| --- | --- | --- |
| `weld` | `distance` (0.001) | Merges vertices closer than the distance, as Merge by Distance; faces that collapse go. |
| `triangulate` | `minVertices` (4) | Cuts faces with that many corners or more into triangles; tags, uv and winding carry over. |
| `edge_split` | `angle` (30) | Gives each smooth fan of faces its own vertex, so edges bending more than `angle` degrees, and edges shared by three faces, come apart. |
| `smooth` | `factor` (0.5), `iterations` (1, up to 64) | Moves each vertex `factor / 2` toward the mean of its edge neighbours. |
| `simple_deform` | `mode`, `axis` (z), `angle` (45) or `factor` (0.5) | Twist and bend take `angle` degrees, taper and stretch take `factor`, both measured over the mesh extent along the axis. A mesh with no extent along it stays as it is. |
| `cast` | `factor` (0.5), `size` (0) | Blends vertices toward a sphere about the local origin; size 0 uses the mean vertex distance. |
| `screw` | `axis` (z), `angle` (360), `steps` (16, up to 256), `iterations` (1, up to 64), `lift` (0) | Revolves every edge of the mesh about the axis through the origin, as Blender Screw; the faces of the input are dropped. A whole number of turns with no lift closes the ring. |
| `wireframe` | `thickness` (0.02), `offset` (0), `evenOffset` (true), `replace` (true) | Leaves a rim of that width on every face, as Blender Wireframe; `offset` -1 to 1 moves the strut from inside to outside the surface. |
| `skin` | `radius` (0.1, a number or a scalar field per vertex) | A closed square tube on every edge. A simple version: tubes that meet overlap, and there is no branch solver. |
| `lattice` | `divisions` ([2,2,2], 2 to 8), `moves` (up to 64 of `{ point, offset }`) | A grid of control points over the mesh bounds; each move shifts one point and vertices follow the trilinear blend. |
| `curve` | `path` (2 to 64 points), `axis` (x) | Bends the mesh along a Catmull-Rom path; the coordinate along the axis is the distance from the path start. |
| `hook` | `center`, `radius` (1), `translation`, `strength` (1), `falloff` (smooth) | Pulls the vertices within the radius by the translation, weighted by the falloff. |
| `wave` | `height` (0.5), `width` (1.5), `narrowness` (1.5), `speed` (0.25), `time` (0), `timeOffset`, `start`, `cyclic` (true), `axes` (xy), `normal` | A travelling gaussian ripple along z, equal to Blender Wave at the same frame. |
| `weighted_normal` | `angle` (30), `weight` (50, 1 to 100) | Stores one shading normal per corner: faces around a vertex share it unless the edge is sharp or bends more than the angle, each face counting by its area to the power weight / 50. Put it last in the stack. |
| `smooth_by_angle` | `angle` (30), `ignoreSharp` (false) | Marks edges bending more than the angle sharp and the others smooth, over the geometry `smoothAngle`; sharp edges made by hand, and the 12 of a box, stay sharp unless `ignoreSharp` is set. |
| `bounding_box` | none | Replaces the mesh with the axis-aligned box around all its vertices: 8 vertices and 6 quads. Tags and attributes are dropped. |
| `convex_hull` | none | Replaces the mesh with its convex hull, outward triangles on the extreme vertices only, from at most 8192 vertices. A mesh whose vertices lie on one line or in one plane has no hull and is refused. Tags and attributes are dropped. |
| `build` | `order` (index, random or axis), `seed` (0, random only), `axis` (y, axis only), `frame` (0), `start` (0), `length` (60 frames, above 0), `reverse` (false) | Shows the first faces in that order: none before `start`, all from `start + length`, linear between; `reverse` unbuilds. Unused vertices drop, tags and corner attributes follow their faces, and while no face shows the mesh is one zero-area triangle. Same fields and frame give the same bytes on every seek. Works on imported meshes. |
| `ocean` | `axis` (y, the up axis), `windSpeed` (10 m/s, above 0 to 60), `direction` (0 degrees from +x toward +z), `choppiness` (1, 0 to 4), `size` (100 m, 1 to 10000), `seed` (0), `time` (0 s), `resolution` (8, 1 to 16) | A seeded sea like Blender's Ocean modifier, without the FFT: a sum of travelling waves on a lattice of wave vectors with a Phillips spectrum for the wind, so the surface repeats every `size` metres and the same seed and time give identical vertices. Waves lift the up axis; choppiness pulls vertices toward the crests along the other two. The squeeze of that move is written as the vertex group `foam` (0 flat, 1 folded). Waves cost (2 x resolution + 1)^2 - 1 per vertex, capped at 50 million evaluations. A box base has few vertices across a flat face (bevel 0 has none inside it), so run `subdivide_edges` with `cuts` first, or the waves have nothing to move. For an open sea: delete every face but the top, `subdivide_edges` with 16 cuts, `subdivide` 4 levels (about 74,000 vertices), scale the sheet to hundreds of metres, then `ocean` with a `size` of 50 (smaller than the wind's longest wave, so the sea has short chop), and a `vertex_color` field that mixes deep blue to white by `{ "attr": "group", "name": "foam" }`. A part with the `water` tag needs none of that: its shader reads the `foam` group itself and draws white rough foam on the folded crests, with a fresnel sky reflection, a sun glint and a deeper body colour at grazing angles. The mesh smooths over 180 degrees unless `smoothAngle` is set, so choppiness does not split the normals. |

`triangulate` and `edge_split` check their output size before building it, against the same vertex and face limits as the other edits. Each op has cases in `tests/fixtures/blender/cases.json` and matches Blender 5.2 with no listed difference. `screw` and `wireframe` have cases in the same fixtures (the volume of the open screw strips differs by winding, listed in `differences.json`); `wave` matches Blender on two cases; `skin`, `lattice`, `curve` and `hook` are not compared with Blender, because each needs a second object there. The two normal modifiers are tested by their own properties, because the Blender comparison does not measure normals. Not yet: `shrinkwrap` and `scatter_on_surface` as stack nodes (`instances` already scatters), and cast shapes other than the sphere.

### Field expressions

A field expression is plain JSON that computes one number, or one vector, for each point or face of a mesh. It is
data and never code: `src/mesh-fields.js` reads it against a fixed table of operators, compiles it once into
closures over typed arrays, and checks the limits before it evaluates anything. This is the one expression language of the
engine, in `src/expression.js`; motion drivers use it with `time` and node reads in place of attributes (see
[agent motion](agent-motion.md)). No string is executed, and no input
string is used as a property name, so a recipe written by an agent that follows injected instructions cannot run code
or reach `__proto__` or `constructor`. The same expression gives the same bytes on every run.

```json
{ "mul": [{ "attr": "position", "component": "y" }, 0.5] }
{ "noise": { "scale": 3, "seed": 7, "octaves": 2 } }
{ "gt": [{ "dot": [{ "attr": "normal" }, [0, 1, 0]] }, 0.9] }
```

A number is a constant, `true` and `false` are 1 and 0, and an array of three numbers is a constant vector. An operator takes
its operands as an array; one with a single operand may write it bare, `{ "neg": x }`.
Operators that take numbers also take vectors and work on each component; a number spreads to all three.

| Group | Operators |
| --- | --- |
| Math | `add` `mul` `min` `max` (2 to 8 operands), `sub` `div` `mod` `pow` `atan2`, `clamp` `mix` `smoothstep` (3), `neg` `abs` `sqrt` `sin` `cos` `floor` `ceil` `round` `fract` `sign` `saturate` (1). `div` and `mod` by 0, a negative `sqrt` and an overflowing `pow` give 0; `smoothstep` with equal edges is a step. |
| Comparison and logic | `lt` `lte` `gt` `gte` `eq` give 1 or 0; `and` `or` `not`; `if: [condition, a, b]` |
| Motion only | `"time"` and `{ "node", "property", "component", "space" }` read time and node values in a driver; a field rejects them, and a driver rejects the field inputs below. |
| Vectors | `vec: [x, y, z]`, `dot` `cross` `distance`, `length` `normalize`, `x` `y` `z` read a component |
| Rotation | `rotate: [vector, axis, angle]` turns a vector about an axis (radians; a zero axis does nothing); `align: [direction]` gives the Euler angles (X then Y then Z, radians) that turn +Y onto the direction; `transform: [point, move, euler, size]` scales, rotates, then moves a point (only the point is required) |
| Attributes | `{ "attr": "position" \| "normal" }` with optional `component`, `{ "attr": "index" }`, `{ "attr": "tag", "name": "top" }` |
| Mesh shape | `{ "faceArea": {} }` area of the face (over points, the mean of the faces around); `{ "edgeAngle": {} }` the sharpest angle between two faces over the element's edges, in radians, 0 on a border; `{ "island": {} }` the index of the connected piece, counted by its first vertex; `{ "neighbors": { "read": "edges" \| "faces" } }` how many edges (default) or faces touch the element. They need a mesh, so a point set rejects them. |
| Whole domain | Each takes one object and reads every element before it answers. `{ "accumulate": { "value", "group" } }` running total in index order, restarted for each whole-number `group`; `{ "statistic": { "value", "mode": "min" \| "max" \| "mean" \| "sum" \| "range", "group" } }` that statistic over all elements or the group; `{ "blur": { "value", "iterations": 1 to 32, "weight": 0 to 1 } }` mixes the value with the mean of its neighbours (edges over points, shared edges over faces) once per iteration; `{ "sampleIndex": { "value", "index" } }` the value at the element `index` names, clamped to the range; `{ "rank": { "value", "descending" } }` the position of the element when sorted by the value, ties in index order (Blender's Sort Elements index). `value` and `group` are number expressions. |
| Random | `{ "noise": { "scale", "seed", "octaves", "at" } }` smooth value noise in 0 to 1 at a position (default the element's), `{ "random": { "seed" } }` a number in 0 to 1 per element |

Limits, checked before evaluation: 64 nodes, depth 12, 250,000 elements, and 8,000,000 node-evaluations (nodes times
elements). Numbers stay within 1e6, noise scale within 1000 and octaves within 4. An expression over faces reads a
point attribute as the face centre or the face normal, and over points reads a tag as the mean of the faces around
the point.

Uses:

- `{ "field": expression }` is a selection rule for any face edit: the faces where the expression is not 0.
- `set_position` (`select`, `position`, `offset`) is Blender's Set Position. `position` and `offset` are vector
  expressions evaluated on the input positions, so vertex order never matters. It moves the vertices of the selected faces.
- `displace` (`select`, `field`, `strength`, `midlevel`, `direction`) is Blender's Displace modifier with a field as
  the texture: each vertex moves by `(field - midlevel) * strength` along `normal` (default), `x`, `y` or `z`.
  `displace` also takes `group`, the name of a vertex group: each move is scaled by the vertex's weight.
- Both are also stack nodes, so a late change reuses the cached earlier nodes.
- `vertex_group` (`name`, `select`, and one of `weight`, `field`, `gradient` or `measure`) writes the weights, 0 to 1, of a named group for the
  vertices of the selected faces; the others keep theirs (0 in a new group). `gradient` is `{ "axis": "y", "range": [0, 1], "weights": [0, 1] }`,
  a straight blend between the weights at the two ends of the range along the axis. Up to 32 groups. `displace` reads one with
  `group`, and a cloth sheet holds the vertices of weight 0.5 or more with `pinGroup` (see [physics.md](physics.md)). Groups are
  point attributes: run `vertex_group` after the shape edits, because a stack node that rebuilds the mesh (`mirror`, `array`) drops them.
  `measure` fills the group from the mesh itself, so a mesh with no UVs can tell an edge from a cavity: `curvature` (`gain` 2, 0.1 to 16) is 0.5 on a flat
  surface, above it on a convex bulge and below it in a concave dent; `edge` (`angle` 30 degrees, 1 to 179) is 1 on a convex fold at or past the angle and 0
  elsewhere, and a concave fold gives 0; `occlusion` (`rays` 32, 1 to 128; `distance` in metres, default a quarter of the bounding box diagonal; `seed` 0) is the
  share of cosine-weighted rays from the vertex that hit the mesh within `distance`, 1 deep in a cavity. All three are deterministic: the same mesh and seed give
  the same bytes. Occlusion casts at most 2 million rays in all and names the fix when a `select` holds too many vertices; it needs vertices where the detail is, so
  cut the mesh first (`subdivide_edges`). Edge wear needs the geometry to carry the fold: bevel the edge and cut the faces so a vertex sits on it.
- `vertex_color` (`select`, and one of `color`, `field` or `gradient`) sets the corner colors of the selected faces. `color` is
  `[r, g, b]` from 0 to 1, `field` a vector expression of the vertex, and `gradient` is `{ "axis": "y", "range": [0, 1], "colors": [[0, 0, 1], [1, 0, 0]] }`.
  `gradient` can also follow a vertex group instead of an axis: `{ "group": "wear", "colors": [dirt, paint, metal] }` blends two colors from weight 0 to 1, or three at
  weights 0, 0.5 and 1, so `curvature` gives dirt in the dents, paint on flat faces and bare metal on the convex edges.
  The renderer multiplies the material color by it and a GLB export writes it as `COLOR_0`. Faces not selected stay white until painted.
- Material `wear` makes a group drive the material per pixel instead of tinting it: `"wear": { "mask": "edge", "metal": { "color": [0.56, 0.57, 0.58], "metallic": 1, "roughness": 0.3 }, "dirt": { "mask": "cavity", "color": [0.05, 0.04, 0.03], "roughness": 0.9 } }`.
  The material's own `color`, `metallic` and `roughness` are the paint. Where the `mask` group is high the pixel turns to the metal layer; where the `dirt.mask` group is high it turns to dirt, which
  removes metal and raises roughness. `threshold` (0.5) and `softness` (0.25, 0.001 to 0.5) set where and how sharply each mask switches (`dirt` has its own). Both masks must be vertex groups of the node's mesh;
  a name that is not one is an error that lists the groups. The two weights travel in the fourth vertex colour component with 11 bits each, so no attribute is added and a material without `wear` renders as before.
  It needs a mesh without baked floor sky visibility, and the rasterizer only: the path tracer and a GLB export keep the paint.
- `instances` on a recipe node repeats its geometry at points; see [agent-scene.md](agent-scene.md#instances-on-points).

Blender comparison: `tests/blender-golden.test.js` runs `set_position` against a Geometry Nodes Set Position node
and `displace` against the Displace modifier, with a constant and with a Blend texture, and the vertex positions
match within 1e-3. `noise` has no direct match, because Blender's noise texture is a different function; the fields
in those cases use only arithmetic and position.

### Bevel

`bevel` rounds or chamfers edges, as an edit or as a stack node:

| Field | Meaning |
| --- | --- |
| `edges` | `{ "between": [faceRule, faceRule] }` (the rim between two regions, for example top and side), `{ "angle": 30 }` (edges bending at least this many degrees; the default), `{ "boundaryOf": faceRule }`, or `{ "all": true }` |
| `width` | Distance from the edge into each neighbouring face |
| `segments` | 1 to 16; 1 is a flat chamfer, 3 or more reads as round |
| `profile` | As in Blender: 0.5 is a circular arc (default), 0.25 is flat, 1 is square, and below 0.25 is concave |
| `clampOverlap` | Default true: shrink `width` so neighbouring bevels cannot cross; the result reports `clamped` and the `width` used |

Only edges with two consistently wound faces bevel. A face corner next to one beveled edge slides along its other
edge, shared with the face across that edge, so no T-junctions appear. Each beveled edge becomes a strip of
`segments` quads following a superellipse around the original edge (tag `<name>.strip`). At a vertex with one beveled
edge and three faces, the third face takes the profile's points and no fill is needed. Where beveled edges meet at a
vertex, the gap is filled (tag `<name>.corner`): a corner where three rounded edges meet gets a quadratic
triangular patch that shares the three profiles on its border; other corners get a flat polygon (chamfers) or a fan to
a raised centre. `tests/fixtures/blender/differences.json` lists where the result differs from Blender, including
these corners. Edges between strip segments render smooth when the bend per segment is under the mesh's
`smoothAngle`; with 2 segments on a right angle (45 degrees each), raise `smoothAngle` or use 3 or more segments.

### Loop cut

`loop_cut` adds loops across rings of quads, as Blender's Loop Cut:

| Field | Meaning |
| --- | --- |
| `edges` | Edge rule picking the ring to cut across: `{ "along": [x, y, z], "maxAngle": 10 }` picks edges parallel to a direction (`along: [0, 1, 0]` cuts around a box horizontally), or `between`, `angle`, `boundaryOf`, `all` as for bevel |
| `cuts` | 1 to 16 loops per ring, evenly spaced |
| `factor` | With one cut, its position from each ring's low side, strictly between 0 and 1 (default 0.5) |

From each selected edge the ring is walked across quads to the opposite edge, until it closes or meets a face that is
not a quad. Every ring edge is split at the same fractions from the ring's low side (the end of the first seed edge
with the lower coordinate along it), and every quad in the ring is split into bands tagged `<name>.band-0` (low side)
to `<name>.band-<cuts>`; bands keep the quad's other tags. Faces beside an open ring get the new points on their
shared edges, so no T-junctions appear. Corner UVs and colours are interpolated at the new points. Rings that cross
each other in one edit are refused; cut them in separate edits. The result reports `rings`, `closedRings` and
`splitEdges`.

A typical sequence: `loop_cut` with `cuts: 2`, then `extrude_individual` or `extrude_face_region` with
`alongNormals` on `<name>.band-1` to raise a belt around the middle.

### Cutting tools

These edits cut, join, fill and merge faces. Each tags the faces it makes with `<name>.<tag>`, and each result passes
`validateTopology`. Edge rules (the `edges` field) are those of bevel and loop cut, plus `{ "open": true }` for
boundary edges (those with one face) and `{ "open": { "inside": { "min": [x, y, z], "max": [x, y, z] } } }` for the
boundary edges whose midpoint is in a box, which picks one hole among several.

| Edit | Fields | Tags | What it does |
| --- | --- | --- | --- |
| `fill_holes` | `sides` | `fill` | Caps each closed boundary loop with one polygon; `sides` skips loops with more edges. |
| `dissolve_faces` | `select` | `merged` | Merges connected selected faces into one polygon each. |
| `dissolve_edges` | `edges` | `merged` | Merges the two faces beside each selected edge. Boundary edges are ignored. |
| `dissolve_verts` | `verts` | `merged` | Removes vertices: a vertex with two edges just leaves its faces, one with more merges the faces around it. |
| `dissolve_limited` | `edges` (default all), `angle` (default 5) | `merged` | Dissolves edges whose faces bend by at most `angle` degrees, then the straight vertices left behind. |
| `bisect_plane` | `point`, `normal`, `distance`, `clearInner`, `clearOuter`, `fill` | `inner`, `outer`, `cap` | Cuts at a plane. `clearInner` removes the side behind the normal, `clearOuter` the side in front. `fill` caps the cut; with both sides kept the halves separate into two closed shells. |
| `bridge_edge_loops` | `edges`, `segments`, `twistOffset` | `bridge` | Joins exactly two boundary loops with the same edge count by a strip of quads, `segments` deep. |
| `subdivide_edges` | `edges`, `cuts` | `split` | Splits each selected edge into `cuts` + 1 pieces. Quads with two opposite edges split become bands, with four split a grid, and any other face keeps one n-gon with the new points inserted. |
| `grid_fill` | `edges` | `fill` | Fills each closed boundary loop of an even number of edges (4 or more) with a grid of quads. |
| `knife_project` | `path`, `direction` | `cut` | Cuts along a polyline of object-space points projected along `direction`, through front and back faces. |

`dissolve_verts` rules: `{ "all": true }`, `{ "vertices": [indices] }`, `{ "valence": 2 }` (vertices with exactly that many
neighbours) or `{ "inside": { "min", "max" } }`. `dissolve_edges`, `dissolve_verts` and `dissolve_faces` refuse a merge
that would leave a face with a hole or pinch it. `bisect_plane` throws when the plane misses every face, and when a face
is crossed more than twice (a concave face); split it first. `bridge_edge_loops` aligns closed loops at the rotation with
the shortest total distance, then turns them by `twistOffset` vertices. A knife stretch that starts or ends inside a face
makes no cut, and a face that runs along `direction` is not split (its edge points are still inserted). The sizes of
`subdivide_edges` are checked before it allocates.

Open boundaries reported by lint (`boundary-edge`) are fixed with `fill_holes`. Names follow `bmesh.ops`
(`holes_fill`, `dissolve_*`, `bisect_plane`, `bridge_loops`, `grid_fill`, `subdivide_edges`) where the meaning matches, and
`point` and `normal` are Blender's `plane_co` and `plane_no`.

### Reshaping tools

These edits change how a surface is divided or shaped. Elements are visited in index order and ties break toward the
lower index, so the same input always gives the same bytes. Faces they keep carry their tags and attributes.

| Edit | Fields | Tags | What it does |
| --- | --- | --- | --- |
| `poke` | `select`, `offset` (default 0), `relative` | `poke` | Replaces each selected face with a triangle fan around a centre vertex at the face's average point, moved `offset` along the face normal (times the face's average corner distance when `relative`). |
| `dual` | none | `dual` | One vertex at each face centre and one face around each vertex, wound the same way as the original. Needs a closed mesh with consistent winding; the new faces carry no attributes. |
| `tris_to_quads` | `select`, `angle` (default 40) | `merged` | Joins adjacent selected triangles whose normals differ by at most `angle` degrees into convex quads, the most rectangular pairs first; each triangle joins once. |
| `symmetrize` | `axis` (default x), `keep` (`positive` or `negative`), `distance` | `mirrored` | Cuts faces that cross the plane through the origin, drops the other half and mirrors the kept half. Left and right (top and bottom, front and back) tags swap on the mirrored half. |
| `scale_elements` | `select`, `scale` (above 0) | none | Scales each group of selected faces that share a vertex about the group's average vertex position. Unselected neighbours follow along shared vertices. |
| `extrude_edges` | `edges`, `offset` | `side` | Copies the vertices of the selected edges, moves the copies by `offset` and joins each edge to its copy with a quad. Select a surface boundary with `{ "open": true }`. |
| `split_edges` | `edges` | none | Opens the surface along the selected edges: the faces on each side stop sharing the edge's vertices, which are copied once per group of faces that still meet around them. Faces keep their tags and attributes; the result has boundary edges. |
| `delete_loose` | none | none | Removes every vertex that no face uses (the lint problem `loose-vertex`). Fails when there is none. |
| `flatten` | `verts`, `normal`, `factor` (0 to 1, default 1) | none | Moves the selected vertices toward the plane through their average point. `normal` is the plane direction; without it the area-weighted normal of the faces whose vertices are all selected is used. |

| `unsubdivide` | none | none | Reverses one Catmull-Clark level: the original vertices and the coarse faces they make (n-gons too) are kept, every face point and edge point is dropped. The survivors stay where they are, so the smoothing is not undone. Fails, naming the quad that breaks the pattern, when the mesh has a non-quad face or is not one level of subdivision. |
| `circularize` | `verts`, `factor` (0 to 1, default 1), `regular` (default true) | none | LoopTools Circle: each closed loop of selected vertices (every vertex with exactly two selected neighbours) lands on a circle in the loop's best plane, centred on its average point, with the average distance as radius. `regular` spaces the vertices evenly from the first; otherwise each keeps its own angle. Topology is unchanged. |

`dual` and `symmetrize` leave a closed surface closed. `extrude_edges` on interior edges adds a fin, so a closed
mesh is no longer closed afterwards. `extrude_vertices` is not offered: a mesh derives its edges from faces and cannot
hold a loose edge. The size of `poke`, `split_edges` and `extrude_edges` is checked before they allocate. The `meshEdit.<op>`
capabilities topic lists the exact fields.

### Subdivide

`subdivide` is Catmull-Clark subdivision with semi-sharp creases, as an edit or as a stack node, on the rules Pixar
published and OpenSubdiv implements. Every n-gon becomes n quads, so faces multiply by about 4 per level.

| Field | Meaning |
| --- | --- |
| `levels` | 1 to 4 (default 1) |
| `crease` | Edge rule for creased edges, the same rules as bevel, for example `{ "angle": 60 }` for the rims of a cylinder |
| `sharpness` | 0 to 10 (default 10), only with `crease`. A crease stays fully sharp for that many levels; a fraction blends the smooth and sharp rules |

Open boundary edges are always sharp, and a boundary vertex with a single face stays a corner (Blender's Keep Corners).
Faces keep their tags, and corner attributes such as `uv` blend linearly. Edge attributes follow each half of a split
edge; point attributes are not carried. The size is checked before anything is built, so `levels: 4` on a mesh that
would pass the face limit fails with the counts instead of running. Put `subdivide` before `uv_unwrap`.

Blender comparison (`tests/fixtures/blender`): vertex, edge and face counts, face sizes, area and every vertex match a
Subdivision Surface modifier (limit surface off, Keep Corners) at levels 1 to 3 on a cube, an open grid and a cylinder
with n-gon caps, with creases of sharpness 10, 2 and 0.5. A crease of sharpness s is Blender's crease sqrt(s / 10).
Volume differs by under 1% on four cases, because it is measured on bent quads from each quad's first corner.

Timing, measured on this machine: one level on a 100,489-quad grid takes about 225 ms (402k faces out), and about 390 ms
with a crease on every edge. That is fast enough that 67js does not keep a stencil table; a stack node reuses its cached
result until an earlier node changes.

### Decimate, remesh and levels of detail

`decimate` (`ratio`, above 0 and at most 1) reduces the triangulated mesh by quadric edge collapse. The ratio is of
triangles, never below four. Open boundaries and the borders between faces with different tags are constraints: their
vertices only collapse along the constraint and extra planes hold them in place. Tags carry over; corner and edge
attributes (`uv`, colour, `sharp`) are dropped, so unwrap after it. The result reports `triangles` before and after, and
`stoppedEarly` when constraints stopped it above the ratio. `decimateMesh(mesh, { ratio })` is the same in code.

`remesh` (`voxelSize`, or `resolution` cells along the longest side up to 192) samples the signed distance to the
surface on a grid and builds a closed quad surface with surface nets. Only cells near the surface are queried through the
triangle BVH; the rest take their sign from a flood fill. The grid is checked before it is allocated (192 per side, 4,194,304
cells). The mesh must be closed, and the result carries no tags or attributes.

`generateMeshLods(mesh, { ratios })` (also `generateGeometryLods` for renderer geometry such as a recipe part, and
`generateAssetLods` for a static imported asset) returns level 0, the input, and one level for each ratio, from strictly
decreasing ratios in (0, 1), up to 8. Each level has `triangles`, `error` (the farthest its vertices lie from the input surface, in
the input's units) and `relativeError` (over the bounds diagonal); the asset form returns a whole asset per level.
Skinned and morphed parts are refused. `surfaceDeviation(a, b)` gives the vertex Hausdorff distance both ways. Hand the levels to a
part as `lods` and `Renderer67` picks one per instance by its size on screen: see `docs/culling-lod.md`.

Why our own collapse and not meshoptimizer 1.3.0 (npm, MIT, 2026-09-25): on the same sphere, torus and open bowl at
ratios 0.5, 0.2 and 0.05 our Hausdorff error was 0.25 to 0.85 of its error (0.0088 against 0.0153 at 0.5 and 0.0647 against 0.0773
at 0.05 on the sphere, 0.0403 against 0.1603 at 0.05 on the open bowl with its borders locked), and the volume stayed closer
in all nine runs. It has no tag support, and its simplifier adds about 15 KB gzip of WebAssembly (the build three.js ships), where
this code, with remesh and the levels, adds about 7 KB gzip to the lazy mesh code and nothing to the initial load (+32 bytes). It is about 28 times faster, so the cost is time: about 2.5 seconds for a 100k-triangle sphere down to a
tenth, against about 0.09 seconds.

Blender comparison (`tests/fixtures/blender`): 4 decimate and 2 remesh cases on a bumpy sphere, a torus and an open bowl,
compared with the Decimate (collapse) and Remesh (voxel) modifiers by face count, volume, area and the Hausdorff distance to
the input, because face counts differ. `differences.json` lists the remesh face counts, which differ by 2% and 7%.

### Sculpt and shrinkwrap

Two edits shape a mesh organically. Both take `select` (default every face) and move only the vertices of the selected
faces, so a tag confines them. Neither adds or removes faces, and the topology stays valid.

- `sculpt` (`strokes`, 1 to 32) applies brush strokes in order. A stroke has a `type` (`inflate` along the vertex
  normal, `displace` along its `direction`, `smooth` toward the mean of the neighbours, with a `strength` from 0 to 1),
  a `center`, a `radius` and a `strength` in mesh units (negative pushes in). The falloff is quintic, zero first and
  second derivatives at the rim. A stroke that crosses the edge of the selection leaves a step there. The stroke maths is
  shared with `sculptGeometry` (`src/sculpt-strokes.js`). More than 5 million vertex visits (vertices times strokes) is
  refused before it runs.
- `shrinkwrap` (`target`, `translation`, `rotation`, `scale`, `mode`, `direction`, `offset`, `maxDistance`,
  `onMiss`) moves each selected vertex onto the surface of a primitive, placed like a boolean cutter. `nearest` (the
  default) takes the closest point; `project` casts a ray along `direction` and takes the first hit. `offset` stands the
  vertex off along the face normal, on the side a projected vertex came from, as Blender does. A vertex with no hit
  is an error (`onMiss` "error") or stays put (`keep`). The queries use the BVH of `src/mesh-query.js`, at most 20
  million triangle tests per edit.

A decal is a grid base shrunk onto a curved target and then solidified:

```json
{ "id": "badge", "type": "mesh", "base": { "type": "grid", "segments": 16 }, "edits": [
  { "op": "set_position", "position": { "vec": [{ "mul": [{ "attr": "position", "component": "x" }, 0.8] }, { "mul": [{ "attr": "position", "component": "y" }, 0.8] }, 1.6] } },
  { "op": "shrinkwrap", "target": { "type": "sphere" }, "mode": "project", "direction": [0, 0, -1], "offset": 0.02 },
  { "op": "solidify", "thickness": 0.02, "offset": -1 }
] }
```

The Blender comparison (`tests/blender-golden.test.js`) has two shrinkwrap cases against the Shrinkwrap modifier, one
nearest and one projected with an offset, and two sculpt cases. Blender has no modifier for brush strokes that runs
without a viewport, so the sculpt reference applies the same brush formula to Blender's mesh and vertex normals.
The vertex positions agree within 0.001 in all four, with no accepted difference.

### UV unwrap

`uv_unwrap` writes the corner attribute `uv` (and the edge attribute `seam`), as an edit or as a stack node. It
changes no geometry, so put it last: later edits do not keep UVs exact.

| Field | Meaning |
| --- | --- |
| `seams` | Edge rule for seams, the same rules as bevel; default `{ "angle": 60 }` |
| `margin` | Gap between islands and around the square, as a fraction of it, 0 to 0.2 (default 0.01) |
| `maxDistortion` | Islands stretching more than this get split into charts (default 0.25) |

Faces joined across edges that are not seams form islands. An island with several boundary loops is cut along the
shortest edge path between them until it is a disk. Each island is then flattened with a least-squares conformal
map (LSCM, the method behind Blender's Conformal unwrap), with two far-apart boundary points pinned. A closed island
(a sphere, a rounded box with no sharp edges), or one that is still not a disk, folds over or stretches more than
`maxDistortion` (the area-weighted mean of `|uv area / surface area - 1|`), is split into charts by the axis its faces
face, cut again and flattened again. Islands are scaled to their surface area, so texel density is even, rotated to
their smallest box, laid landscape and shelf-packed into the unit square, trying several row widths.

The result reports `islands`, `seamEdges` (from the rule), `cutEdges` (added to make disks), `chartEdges` (added by
the chart split), `flipped` triangles, `areaDistortion` after one global scale, and `utilization`, the share of the
square the islands cover. Measured on this machine: a cube gives six equal squares with no distortion, a 24-sided
cylinder three islands with no distortion, a 48 x 24 sphere six charts with 0.09, and a 96 x 48 sphere (4,608 faces)
unwraps in about 0.3 s. There is no angle-based (ABF) or SLIM solver and no packing into an existing layout.

Knife and bisect are planned next.

## MCP

A recipe geometry of type `mesh` starts from a primitive or profile and replays an edit log:

```json
{ "id": "crate", "type": "mesh", "base": { "type": "box", "bevel": 0 }, "smoothAngle": 30,
  "edits": [
    { "op": "inset_individual", "select": { "tag": "side" }, "thickness": 0.07, "name": "panel" },
    { "op": "extrude_individual", "select": { "tag": "panel.cap" }, "offset": -0.04 }
  ] }
```

Edges bending more than `smoothAngle` degrees (default 30, or 180 for a mesh with an `ocean` edit or stack node, so a choppy sea keeps its smooth normals) render hard. `mesh_edit` appends edits to such a
geometry (or replaces its log with `replace: true`) as one atomic revision, so checkpoints and `expectedRevision`
work as for `scene_apply`. It returns the render status and the mesh report below, including one result per edit.

`mesh_inspect` runs the same conversion and lint on the geometries of a procedural recipe scene and returns one
compact record per geometry:

```json
{ "geometry": "cube", "ok": true,
  "counts": { "vertices": 8, "edges": 12, "faces": 6, "corners": 24, "triangles": 12, "renderVertices": 24 },
  "faces": { "triangles": 0, "quads": 6, "ngons": 0 },
  "parts": { "count": 1, "closed": 1 },
  "tags": { "right": 1, "left": 1, "top": 1, "bottom": 1, "front": 1, "back": 1, "side": 4 },
  "bounds": { "min": [-0.5, -0.5, -0.5], "max": [0.5, 0.5, 0.5] },
  "problems": [] }
```

Reports are cached per generated geometry, so asking again without edits is free. For `mesh` geometries the report
describes the edited polygon mesh and adds `edits`, the per-edit results. Imported asset scenes are not supported
yet.

## Measured speed

`node scripts/benchmark-mesh-core.mjs 1000` on a 1000 x 1000 quad grid (one million faces), Node 24, Ryzen 5 5600X,
one thread at below-normal priority on a shared machine, medians of five runs. Runs varied by about 25%.

| Step | Median |
| --- | --- |
| `createMeshData` (derive edges) | 61–63 ms |
| `editMesh` + `meshData` round trip | 234–296 ms |
| `validateTopology` | 188–192 ms |
| `cornerNormals` | 318 ms |
| `extractRender` | 380 ms |
| `lintMesh` | 191–210 ms |
| `meshFromGeometry`, sphere with 1M triangles | 1.3–1.5 s |

The `EditMesh` arrays take about 200 bytes per quad face without attributes. These numbers are this machine only
and say nothing about Blender's speed.

### UV projection and packing

`uv_project` writes the corner attribute `uv` by a simple projection, and `uv_pack` repacks the islands a mesh already
has. Both work as an edit or as a stack node and change no geometry.

| Field | Meaning |
| --- | --- |
| `mode` | `cube` (each face by its dominant axis), `cylinder` (sides wrap around `axis`, caps project flat) or `sphere` (longitude and latitude); `uv_project` only, required |
| `axis` | `x`, `y` (default) or `z`, the cylinder or sphere axis |
| `pack` | `true` (default) packs the result into the unit square; `false` leaves uv in mesh units for a later `uv_pack` |
| `margin` | Gap between islands and around the square, 0 to 0.2 (default 0.01) |
| `rotate` | `true` (default) lays tall islands on their side; `false` keeps them upright |

Cylinder and sphere uv are measured from the centre of the bounds. `u` is arc length at the mean radius of the mesh
and `v` is the height (cylinder) or the latitude times that radius (sphere), so one unit of uv covers about one unit
of surface at the mean radius. Faces that wrap are cut on the side opposite the first radial axis. Islands are the
faces joined across edges whose two ends share the same uv; `uv_pack` finds them from the uv itself, so it also packs
an `uv_unwrap` result again (for example after `pack: false` merges) or a hand-set layout. Every island takes one common
scale, shelf-packed with a gap, so texel density keeps its ratio between islands and no two islands overlap.

The light bake does not read these uv. It unwraps every part into its own light uv, so islands that overlap in a
projected layout cannot share a lightmap texel (`tests/light-bake-projected-uv.test.js`).

Texel density measured in the tests: a cube projection gives a crate six islands with the same density to 0.1 percent,
a 24-sided cylinder projection keeps a barrel within 15 percent of the median, and a sphere stretches toward the poles
as any equirectangular map does. The result reports `islands`. Not done yet: view and angle-based smart projection,
and `uv_warp` (offset, scale and rotate by a field); `uv_unwrap` still covers general meshes.
