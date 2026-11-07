# Scene queries

`addons/scene-query` casts rays against a whole loaded scene and samples a walk map: the ground height and the headroom on a grid.
It builds on the per-geometry BVH of [mesh-query.md](mesh-query.md) and adds the part that was missing, the node transforms.

```js
import { loadGltf } from '67js/addons/gltf';
import { createSceneQuery } from '67js/addons/scene-query';

const asset = await loadGltf('scene.glb');
const query = createSceneQuery(asset.parts);

const hit = query.raycast({ origin: [0, 100, 0], direction: [0, -1, 0] });
// { point, distance, normal, id, partIndex, material, triangle } or null

query.dispose();
```

`createSceneQuery(parts)` takes objects like the `parts` of `loadGltf`: `geometry` (`positions` and `indices`), a 16 component world `matrix`, an optional `material`, and `id` or `name`.
It does not copy anything until a ray needs a part.
A ray first tests the world bounds of every part, nearest first, and builds the BVH of a part on its first candidate hit.
The index stays cached, so only the first queries pay for building.

`raycast({ origin, direction, maxDistance })` returns the nearest hit over all parts.
`normal` is the face normal in world space, turned toward the side the ray came from.
`id` is the part ID (`id`, else `name`), and `material` is the part's own `material` value.

Triangles with no usable area are left out of the index, and `info.droppedTriangles` counts them.
Parts the mesh query cannot index, such as skinned or morphed meshes, are listed in `query.skipped` and never hit.
Each index is limited to 1,000,000 triangles and 256 MiB; pass `maxTriangles`, `maxVertices` or `memoryBudgetMiB` as the second argument to change that.

## Walk map

```js
const map = query.walkMap({
  min: [-62, -88],
  max: [111, 97],
  cellSize: 1,
  topY: 60,
  lowerPass: { fromY: 2.4, groundBelow: 1, maxDistance: 4, minHeadroom: 2.4 },
});
// { cellSize, min, columns, rows, cells: [[x, z, groundY, headroom], ...] }
```

For each cell a ray goes down from `topY` and the first surface is the ground.
A ray up from `probeHeight` (default 0.3) above the ground gives the headroom, capped at `clearanceCap` (default 99).
Cells without a surface are left out.
`lowerPass` handles a roof or an arch that hides the street: when the top surface is above `groundBelow`, a second ray goes down from `fromY`, and a hit below `groundBelow` with more than `minHeadroom` of room replaces the ground.
The region may hold up to `maxCells` cells (default 65,536).

Check against a Blender sample of the Bistro scene, a 1 m grid of 12,629 cells in glTF coordinates (down ray from y = 60, second ray from y = 2.4): ground height within 5 cm on 12,619 cells, and on 8,511 of the 8,517 open cells (ground below 1 m, headroom above 2.4 m).
The cells that differ sit on rays that graze an edge.
Measured on a machine under load: about 8 s for the first 12,630 cells including building 155 BVHs of 2.8 million triangles, 3.6 s with the indexes cached.

## MCP tool

`scene_walkmap` runs the same query on the active imported asset scene (made with `scene_create_asset`; procedural recipe scenes are not supported yet) and returns text rows an agent can read.
Rows follow z, columns follow x.

```json
{ "min": [-62, -88], "max": [111, 97], "cellSize": 1, "topY": 60, "clearance": 2.4,
  "groundRange": [-1, 1], "lowerPass": { "fromY": 2.4, "groundBelow": 1 } }
```

```
{ "columns": 174, "rows": 186, "surfaceCells": 12630, "walkableCells": 8517,
  "grid": ["######...", "##....xx.", "..."] }
```

`.` is walkable (headroom of at least `clearance`, ground inside `groundRange`), `x` is ground that is blocked, `#` has no surface.
Pass `includeCells: true` for `[x, z, groundY, headroom]` per cell, up to 4,096 cells.
Plan a camera path over the `.` cells, set each eye at `groundY` plus the eye height, and check it with `scene_look`.
The server holds one query per session and rebuilds it when the revision or a pose changes.
The MCP asset catalog is limited to 1,000,000 vertices (see [gltf.md](gltf.md)); a larger scene such as Bistro loads through `loadGltf` and `createSceneQuery` in code.
