# Mesh modeling for agents

<!-- skill-navigation:start -->
This is the [mesh modeling guide](#mesh-modeling-for-agents). Read [Workflow](#workflow) and
[Choosing faces and edges](#choosing-faces-and-edges) completely before the first edit. Read the
[Recipes](#recipes) entry closest to the shape you are building, [Giving a part a surface](#giving-a-part-a-surface) for
textures, and [Errors and fixes](#errors-and-fixes) when a call fails. The full contract (every op, field and default) is `docs/mesh.md` in the npm package; `docs/mcp.md` lists
the tools.
<!-- skill-navigation:end -->

Every `json` block in this file is a complete recipe geometry. `tests/skill-mesh-recipes.test.js` builds each one and
requires a clean lint, so keep them valid when the API changes.

## Workflow

1. Name the parts and their rough sizes first. One part is one `mesh` geometry: a `base` primitive, an `edits` log and
   an optional `stack`. Separate parts (a lid, a handle) are separate geometries placed by nodes.
2. Start from the closest base. `box` is a unit cube from -0.5 to 0.5 (`bevel: 0` for crisp edits); `cylinder` has
   radius 1 and height 1 centred on the origin (`bevel: 0`); `sphere` has radius 1; `lathe` turns a
   profile; `extrude` makes outlines with holes. These shapes are plain geometry records only (not mesh bases):
   `cone` (`{ "id": "spike", "type": "cone", "radiusBottom": 1, "segments": 32 }`, point on top, height 1; a `radiusTop` makes a
   frustum), `icoSphere` (`{ "id": "ball", "type": "icoSphere", "subdivisions": 2 }`, even triangles, no poles), `circle`
   (`{ "id": "ring", "type": "circle", "innerRadius": 0.6 }`, a unit disc facing +Z, a ring when `innerRadius` is above 0),
   `line` (`{ "id": "rod", "type": "line", "from": [0, 0, 0], "to": [0, 2, 0], "radius": 0.03 }`) and `grid` (`plane` is the same
   shape). To edit one, build the mesh from a cylinder or sphere base instead. Set proportions first by translating tagged faces, so later widths and offsets
   stay in real units: a 0.5 x 0.6 x 1.0 box is `right` by -0.25, `left` by 0.25, `top` by -0.4.
   Paint and weight after the shape edits: `vertex_color` (`color`, `field` or a two-color `gradient`) colors the selected faces and
   exports as `COLOR_0`; `vertex_group` (`name` plus `weight`, `field` or `gradient`) makes weights that `displace` reads with `group`
   and a cloth sheet reads with `pinGroup`. Example: `{ "op": "vertex_group", "name": "hem", "gradient": { "axis": "y", "range": [-0.5, 0.5], "weights": [1, 0] } }`.
   Faces, blinks and squash are shape keys on the same mesh geometry: `"shapeKeys": [{ "name": "blink", "offsets": [{ "select": { "tag": "lid" }, "offset": [0, -0.1, 0] }] }]`
   (offsets or move-only `edits`, at most 16, no new vertices), animated by a motion track `{ "kind": "morph", "id": "blink", "property": "weight", "keyframes": [...] }`.
3. Add edits in small batches with `mesh_edit` (or in the recipe). Name every edit (`name: "lid"` gives `lid.cap`,
   `lid.side`); an unnamed one gets `<op>-<index>`, which is hard to predict. Select faces by tags, never by index.
4. After each batch read the `mesh_edit` result: `edits[i].selected`, `tags` and `edges` say what each edit touched;
   `problems` lists lint errors with a fix. `ok: false`, a lower count than expected, or `clamped: true` on a bevel
   means stop and correct before adding more.
5. Look at it with `scene_look` (or `scene_review` for several angles). Lint proves the mesh is valid, not that it
   looks right.
6. Put symmetry, repetition and wall thickness in the `stack` (`mirror`, `array`, `solidify`, `bevel`) so they stay
   adjustable. `mesh_stack` with `apply: n` bakes the first nodes into the edit log when later edits need them.
7. Bevel big shaping edges (an arched top, rounded corners of the body) before insets and extrusions near them:
   those edits put untagged rim and side faces next to the edge, so a later `between` rule misses it or the narrow
   rim clamps the width. Small finishing bevels go last, selected with `boundaryOf` or `angle`.

Tag rules worth knowing: caps keep the tags their faces had (an inset on `right` gives a cap tagged `right` and
`flag.cap`); rim, side, strip and corner faces start with only their own new tag.

Outside MCP, the same recipe runs in Node:

```js
import { createAgentScene } from './src/agent-scene.js'; // or '@codepawlhq/crucible/addons/agent-scene' once released
const scene = createAgentScene({
  format: 'crucible.scene', schemaVersion: 1,
  geometries: [mesh], materials: [{ id: 'paint', color: [0.6, 0.6, 0.6] }],
  nodes: [{ id: 'part', geometry: mesh.id, material: 'paint' }],
});
const [report] = scene.inspectMeshes().meshes; // { ok, counts, faces, parts, tags, bounds, problems, edits, stack }
```

Booleans first need `await loadMeshBooleans()` from the same module (and the `manifold-3d` peer installed).

Use checkpoints before risky batches. A failed `mesh_edit` changes nothing, so retrying with a corrected edit is safe.

## Imported parts

`mesh_edit` and `mesh_inspect` also take the part ID of an imported asset (`mesh-10`; `scene_inspect` lists them). Read `mesh_inspect` first: bounds are in the part's local space, which is often tiny and rotated, so use `localToWorldScale` and `localAxesInWorld` to size a cutter or pick a direction. A boolean needs a closed part (`parts.closed` equals `parts.count`); on an open one run `fill_holes` first. A cylinder cutter has radius 1 and height 1 along its Y axis before `scale`. New vertices keep skin weights, morphs and colours by copying the nearest original surface; an edit that reaches far from the surface on a skinned or morphed part is rejected, so cut or inset instead of extruding far. `mesh_stack` does not apply to imported parts.

## Choosing faces and edges

Faces carry tags. A base gets `top`, `bottom`, `side`, `left` (-X), `right` (+X), `front` (+Z), `back` (-Z).
Edits add `<name>.cap`, `<name>.side`, `<name>.rim`, `<name>.cut`, `<name>.band-<k>`, `<name>.strip`, and so on.
`mesh_inspect` lists every tag with its face count.

| Need | Face rule |
| --- | --- |
| A tagged region | `{ "tag": "top" }` |
| Faces facing a way | `{ "normal": [0, 1, 0], "maxAngle": 10 }` |
| Faces in a box | `{ "inside": { "min": [-1, 0.4, -1], "max": [1, 1, 1] } }` |
| Combinations | `{ "and": [...] }`, `{ "or": [...] }`, `{ "not": rule }` |
| A ring around a region | `{ "grow": { "tag": "top" }, "steps": 1 }` |

Edge rules (for `bevel`, `loop_cut` and the `crease` of `subdivide`):

| Need | Edge rule |
| --- | --- |
| The rim between two regions | `{ "between": [{ "tag": "top" }, { "tag": "side" }] }` |
| Only some of that rim | `{ "between": [{ "tag": "top" }, { "or": [{ "tag": "left" }, { "tag": "right" }] }] }` |
| Every sharp edge | `{ "angle": 30 }` |
| The border of a region | `{ "boundaryOf": { "tag": "lid.cap" } }` |
| Edges parallel to an axis (loop cut rings) | `{ "along": [0, 1, 0] }` |

Choosing the extrude: `extrude_face_region` moves each connected group along its average normal;
`extrude_individual` moves each face along its own; `extrude_face_region` with `alongNormals: true` keeps a ring or
curved band joined (a hoop around a cylinder). Faces facing opposite ways in one group need one of the last two.

## Recipes

A crate with recessed panels and a raised lid:

```json
{ "id": "crate", "type": "mesh", "base": { "type": "box", "bevel": 0 }, "edits": [
  { "op": "inset_individual", "select": { "tag": "side" }, "thickness": 0.07, "name": "panel" },
  { "op": "extrude_individual", "select": { "tag": "panel.cap" }, "offset": -0.04 },
  { "op": "inset_region", "select": { "tag": "top" }, "thickness": 0.08, "name": "lid" },
  { "op": "extrude_face_region", "select": { "tag": "lid.cap" }, "offset": 0.06 }
] }
```

A mailbox: proportions first, the arched top bevelled before anything touches its edges, a loop cut to carve a
vertical strip out of the side, then a door and a flag built by chaining extrusions (each edit selects faces the
previous one created):

```json
{ "id": "mailbox", "type": "mesh", "base": { "type": "box", "bevel": 0 }, "edits": [
  { "op": "translate", "select": { "tag": "right" }, "offset": [-0.25, 0, 0] },
  { "op": "translate", "select": { "tag": "left" }, "offset": [0.25, 0, 0] },
  { "op": "translate", "select": { "tag": "top" }, "offset": [0, -0.4, 0] },
  { "op": "bevel", "name": "arch", "edges": { "between": [{ "tag": "top" }, { "or": [{ "tag": "left" }, { "tag": "right" }] }] }, "width": 0.2, "segments": 5 },
  { "op": "loop_cut", "name": "slice", "edges": { "along": [0, 0, 1] }, "cuts": 5 },
  { "op": "inset_region", "select": { "tag": "front" }, "thickness": 0.07, "name": "door" },
  { "op": "extrude_face_region", "select": { "tag": "door.cap" }, "offset": -0.03, "name": "recess" },
  { "op": "inset_region", "select": { "and": [{ "tag": "right" }, { "tag": "slice.band-1" }] }, "thickness": 0.03, "name": "flagbase" },
  { "op": "extrude_face_region", "select": { "tag": "flagbase.cap" }, "offset": 0.04, "name": "arm" },
  { "op": "extrude_face_region", "select": { "and": [{ "tag": "arm.side" }, { "normal": [0, 1, 0], "maxAngle": 10 }] }, "offset": 0.35, "name": "pole" },
  { "op": "extrude_face_region", "select": { "and": [{ "tag": "pole.side" }, { "normal": [0, 0, 1], "maxAngle": 10 }] }, "offset": 0.14, "name": "flag" }
] }
```

A pillar with raised bands (loop cut, then extrude every other band):

```json
{ "id": "pillar", "type": "mesh", "base": { "type": "box", "bevel": 0 }, "edits": [
  { "op": "translate", "select": { "tag": "top" }, "offset": [0, 2, 0] },
  { "op": "loop_cut", "edges": { "along": [0, 1, 0] }, "cuts": 5, "name": "ring" },
  { "op": "extrude_face_region", "select": { "or": [{ "tag": "ring.band-1" }, { "tag": "ring.band-3" }] }, "offset": 0.05, "alongNormals": true }
] }
```

A drum with a hoop:

```json
{ "id": "drum", "type": "mesh", "base": { "type": "cylinder", "segments": 32, "bevel": 0 }, "edits": [
  { "op": "loop_cut", "edges": { "along": [0, 1, 0] }, "cuts": 2, "name": "hoop" },
  { "op": "extrude_face_region", "select": { "tag": "hoop.band-1" }, "offset": 0.04, "alongNormals": true }
] }
```

A bracket with a boss and a through bore (booleans need the optional `manifold-3d` peer):

```json
{ "id": "bracket", "type": "mesh", "base": { "type": "box", "bevel": 0 }, "edits": [
  { "op": "translate", "select": { "tag": "top" }, "offset": [0, -0.5, 0] },
  { "op": "boolean", "operation": "union", "name": "boss", "cutter": { "type": "cylinder", "segments": 48, "bevel": 0 }, "translation": [0, 0.15, 0], "scale": [0.42, 0.3, 0.42] },
  { "op": "boolean", "operation": "difference", "name": "bore", "cutter": { "type": "cylinder", "segments": 48, "bevel": 0 }, "scale": [0.28, 2, 0.28] }
] }
```

A bench row: model half a bench, mirror it, array the result:

```json
{ "id": "bench", "type": "mesh", "base": { "type": "box", "bevel": 0 }, "edits": [
  { "op": "translate", "offset": [0.5, 0, 0] },
  { "op": "translate", "select": { "tag": "top" }, "offset": [0, -0.8, 0] },
  { "op": "translate", "select": { "tag": "right" }, "offset": [0.4, 0, 0] },
  { "op": "inset_region", "select": { "tag": "bottom" }, "thickness": 0.05, "name": "underside" },
  { "op": "extrude_face_region", "select": { "and": [{ "tag": "underside.rim" }, { "inside": { "min": [1.2, -1, -1], "max": [2, 1, 1] } }] }, "offset": 0.6 }
], "stack": [{ "op": "mirror" }, { "op": "array", "count": 3, "offset": [0, 0, -1.4], "relativeOffset": [0, 0, 0] }] }
```

UVs for a textured part: finish the shape, then `uv_unwrap` as the last edit (or the last stack node, after mirror or
array). Seams default to edges sharper than 60 degrees; closed smooth shapes are split into charts on their own.
Check the result: `flipped` must be 0, and `areaDistortion` above about 0.15 means texture will visibly stretch, so
add seams with `boundaryOf` around the part that stretches.

```json
{ "id": "barrel", "type": "mesh", "base": { "type": "cylinder", "segments": 32, "bevel": 0 }, "edits": [
  { "op": "loop_cut", "edges": { "along": [0, 1, 0] }, "cuts": 2, "name": "hoop" },
  { "op": "extrude_face_region", "select": { "or": [{ "tag": "hoop.band-0" }, { "tag": "hoop.band-2" }] }, "offset": 0.03, "alongNormals": true },
  { "op": "uv_unwrap" }
] }
```

A planter (open box with walls) and a rounded soap bar:

```json
{ "id": "planter", "type": "mesh", "base": { "type": "box", "bevel": 0 }, "edits": [
  { "op": "delete", "select": { "tag": "top" } }
], "stack": [{ "op": "solidify", "thickness": 0.06 }] }
```

```json
{ "id": "soap", "type": "mesh", "base": { "type": "box", "bevel": 0 }, "edits": [
  { "op": "translate", "select": { "tag": "top" }, "offset": [0, -0.4, 0] },
  { "op": "bevel", "edges": { "all": true }, "width": 0.12, "segments": 4 }
] }
```

Smooth organic shapes: `subdivide` rounds a coarse box or cylinder (each level makes about 4 times the faces; 2 or 3
levels is enough). A `crease` edge rule keeps chosen edges sharp for `sharpness` levels (default 10, always sharp), so a
cylinder keeps crisp rims while its sides stay round. Shape the coarse mesh first, then subdivide, then `uv_unwrap`.
A subdivided cube shrinks to about 0.85 of its size at 3 levels, so check the result with `scene_look` or `mesh_inspect`
bounds and rescale the node.

```json
{ "id": "pebble", "type": "mesh", "base": { "type": "box", "bevel": 0 }, "stack": [{ "op": "subdivide", "levels": 3 }] }
```

```json
{ "id": "button", "type": "mesh", "base": { "type": "cylinder", "segments": 16, "bevel": 0 }, "stack": [
  { "op": "subdivide", "levels": 2, "crease": { "angle": 60 }, "sharpness": 3 }
] }
```

Fewer faces: `decimate` keeps a `ratio` of the triangles (counted after triangulation), holds open boundaries and the borders
between tags where they are, keeps tags, and drops `uv` (so `uv_unwrap` after it). `remesh` rebuilds a closed mesh as
an even quad surface from a `voxelSize` or a `resolution` (cells along the longest side, at most 192); it drops tags, and
an open mesh needs `fill_holes` first. Levels of detail for a part are made in code with `generateGeometryLods`.

```json
{ "id": "boulder", "type": "mesh", "base": { "type": "box", "bevel": 0 }, "stack": [
  { "op": "subdivide", "levels": 3 },
  { "op": "decimate", "ratio": 0.3 }
] }
```

Whole-mesh modifiers (no selection, no name) go in the stack or the edit log. `simple_deform` twists or bends (`angle` in degrees) or tapers or stretches (`factor`) about `axis` x, y or z over the mesh's extent along it, so give the mesh enough rings first (`subdivisions` on a box). `smooth` relaxes vertices toward their neighbours (`factor`, `iterations`), `cast` pulls them toward a sphere, `weld` merges vertices closer than `distance`, `edge_split` separates faces along edges sharper than `angle`, and `triangulate` cuts faces into triangles (last, for export). Defaults for each are in `scene_capabilities` `meshModifiers`.

```json
{ "id": "twisted-column", "type": "mesh", "base": { "type": "box", "bevel": 0, "subdivisions": 8 }, "stack": [
  { "op": "simple_deform", "mode": "twist", "axis": "y", "angle": 120 },
  { "op": "smooth", "factor": 0.3, "iterations": 2 }
] }
```

## Fields: noise, gradients and repeats

A field expression is a small JSON formula over each vertex or face. `displace` and `set_position` take one, and
`{ "field": expression }` selects faces by one. The formula is plain JSON, so write it as data and never as code.
Use `{"attr":"position","component":"y"}` for a coordinate, `{"noise":{"scale":3,"seed":7}}` for smooth noise in 0 to
1 (use `midlevel: 0.5` so it pushes both ways), and `mul`, `add`, `clamp`, `gt` and `if` to shape it. Full list in
`docs/mesh.md#field-expressions`; the limits are 64 nodes and depth 12.

A lumpy boulder from one expression (a sphere keeps its topology, so it stays closed):

```json
{ "id": "boulder", "type": "mesh", "base": { "type": "sphere", "segments": 24, "rings": 12 }, "edits": [
  { "op": "displace", "field": { "noise": { "scale": 2, "seed": 3, "octaves": 2 } }, "strength": 0.5 }
] }
```

Taper a box into a tower by scaling x and z with height, then inset the top face, picked by a field on its normal:

```json
{ "id": "tower", "type": "mesh", "base": { "type": "box", "bevel": 0 }, "edits": [
  { "op": "set_position", "position": { "vec": [
    { "mul": [{ "attr": "position", "component": "x" }, { "sub": [1, { "mul": [0.5, { "add": [{ "attr": "position", "component": "y" }, 0.5] }] }] }] },
    { "attr": "position", "component": "y" },
    { "mul": [{ "attr": "position", "component": "z" }, { "sub": [1, { "mul": [0.5, { "add": [{ "attr": "position", "component": "y" }, 0.5] }] }] }] }
  ] } },
  { "op": "inset_region", "select": { "field": { "gt": [{ "dot": [{ "attr": "normal" }, [0, 1, 0]] }, 0.9] } }, "thickness": 0.05, "name": "top" }
] }
```

Do not model fifteen pillars: repeat one. Put `instances` on the node, with a `grid`, a `scatter` or a `surface`
source, a `seed`, and an optional `where` field. A node's scale applies to the grid spacing, so scale the group to the
size of one pillar and give the spacing in pillar units:

```text
{ "id": "court", "geometry": "pillar", "material": "stone", "translation": [0, 0.25, 0], "scale": [0.1, 0.5, 0.1],
  "instances": { "grid": { "counts": [5, 1, 3], "spacing": [4, 1, 5] } } }
```

That gives 15 pillars 0.4 m by 0.5 m apart, drawn as one batch. `instances` goes in the recipe given to `scene_create`.

## Cutting and repairing

Use these when a part has a hole, needs an opening or has too many faces. Each names what it makes with `<name>.<tag>`.

```json
{
  "id": "halved-crate", "type": "mesh",
  "base": { "type": "box", "bevel": 0 },
  "edits": [
    { "op": "bisect_plane", "name": "half", "point": [0, 0.1, 0], "normal": [0, 1, 0], "clearOuter": true, "fill": true }
  ]
}
```

Other edits take the same shape, for example:

```text
{ "op": "fill_holes", "name": "lid" }
{ "op": "bridge_edge_loops", "name": "neck", "edges": { "open": true }, "segments": 3 }
{ "op": "dissolve_limited", "angle": 5 }
```

- `bisect_plane` keeps the side the normal points to when `clearInner`, the other when `clearOuter`; `fill` tags the cap `<name>.cap`.
- `fill_holes` caps every closed open boundary (`sides` limits their size); `grid_fill` fills an even loop with quads instead.
- `bridge_edge_loops` needs exactly two boundary loops of equal length. `{ "open": true }` picks all holes; add `"inside": { "min", "max" }` to pick one.
- `dissolve_edges`, `dissolve_faces`, `dissolve_verts` and `dissolve_limited` remove edges and vertices that only split a flat surface. `dissolve_limited` with a small angle undoes a loop cut.
- `subdivide_edges` splits chosen edges; with all four edges of a quad chosen it makes a grid.
- `knife_project` cuts along a polyline projected along `direction`, front and back. Start and end the line outside the mesh.

## Organic shapes and decals

`sculpt` pushes vertices with brush strokes: `inflate` along the normal, `displace` along a `direction`, `smooth` toward the
neighbours. A tag in `select` keeps the strokes to a region. It does not add faces, so subdivide first when the form needs
more detail. `shrinkwrap` moves vertices onto a primitive `target` (nearest point, or `project` along a `direction`) and
stands them `offset` off it: a flat grid base shrunk onto a ball is a label or decal that follows the curve, and
`solidify` makes it a closed plate. Place the sheet in front of the target first, in the mesh's local space, and give it
enough `segments` for the curve.

```json
{ "id": "badge", "type": "mesh", "base": { "type": "grid", "segments": 16 }, "edits": [
  { "op": "set_position", "position": { "vec": [{ "mul": [{ "attr": "position", "component": "x" }, 0.8] }, { "mul": [{ "attr": "position", "component": "y" }, 0.8] }, 1.6] } },
  { "op": "shrinkwrap", "target": { "type": "sphere" }, "mode": "project", "direction": [0, 0, -1], "offset": 0.02 },
  { "op": "solidify", "thickness": 0.02, "offset": -1 }
] }
```

## Giving a part a surface

A material `pattern` textures any part with no UVs, after any edits. `size` is metres per repeat, so it stays right on
a scaled node. Use `roughness: 1` so the pattern's own surface shows, and `metallic: 1` for `metal` and `rust`:

```text
{ "id": "crate-wood", "pattern": { "type": "planks", "size": 0.8, "count": 5 }, "roughness": 1 }
{ "id": "drum-metal", "pattern": { "type": "rust", "size": 0.6 }, "metallic": 1, "roughness": 1 }
```

Run a grain along a long part with `axis` (`"axis": "x"` for a plank lying along X), and tint with `color` instead of
adding another pattern: a scene holds at most 16 different ones. `uv_unwrap` is for exporting, not for patterns.

## Errors and fixes

| Message contains | Do |
| --- | --- |
| `Unknown tag x. Known tags: ...` | Pick a listed tag; earlier edits may have used another name |
| `selects no faces` / `selects no edges` | Loosen the rule (`maxAngle`, box) or check tags with `mesh_inspect` |
| `average normal cancels out` | Use `alongNormals: true`, an `_individual` op, or a `direction` |
| `must be closed for a boolean` | Fix the open or non-manifold edges it counts, or `merge_by_distance` first |
| `need the optional peer dependency manifold-3d` | Booleans are unavailable here; model the cut another way or ask for the peer |
| `rings cross` | Cut each direction in its own `loop_cut` edit |
| `selects N boundary loops; bridge needs exactly 2` | Narrow `edges` with `{ "open": { "inside": { "min", "max" } } }` |
| `needs the same number` (bridge) | Run `subdivide_edges` on the shorter loop first |
| lint `boundary-edge` | `fill_holes`, or `solidify` if the part must be closed |
| bevel `edges` lower than expected | An earlier inset or extrude left untagged rim faces at the edge; bevel earlier, or widen the rule |
| bevel `clamped: true` | A neighbouring face is narrower than the width; bevel before the narrow inset, or use a smaller width |
| `over the limit of N vertices` | Fewer segments, fewer array copies, fewer subdivide levels, or split the part |
| lint `inverted-part` | `flip_normals` on that part |
| lint `degenerate-face` | An offset or width of 0, or a clamp at the edge length; change the value |

Bevel with 2 segments on a right angle renders faceted at the default `smoothAngle` of 30; use 3 or more segments
or raise `smoothAngle` on the geometry.
