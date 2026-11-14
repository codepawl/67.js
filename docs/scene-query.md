# Scene queries

`addons/scene-query` casts rays against a whole loaded scene and samples a walk map: the ground height and the headroom on a grid.
It builds on the per-geometry BVH of [mesh-query.md](https://crucible.codepawl.com/mesh-query.md) and adds the part that was missing, the node transforms.

```js
import { loadGltf } from 'crucible/addons/gltf';
import { createSceneQuery } from 'crucible/addons/scene-query';

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

`scene_walkmap` runs the same query on the active scene and returns text rows an agent can read.
Rows follow z, columns follow x.

```json
{ "min": [-62, -88], "max": [111, 97], "cellSize": 1, "clearance": 2.4 }
```

```
{ "columns": 174, "rows": 186, "surfaceCells": 12630, "walkableCells": 8517,
  "grid": ["######...", "##....xx.", "..."] }
```

`.` is walkable (headroom of at least `clearance`), `x` is ground that is blocked, `#` has no surface.
Pass `includeCells: true` for `[x, z, groundY, headroom]` per cell, up to 4,096 cells.
Plan a camera path over the `.` cells, set each eye at `groundY` plus the eye height, and check it with `scene_look`.
The server holds one query per session and rebuilds it when the revision or a pose changes.
Fields: `min` and `max` are `[x, z]` corners, x runs across the rows and z down them. `cellSize` defaults to 1 and `clearance` (headroom a walkable cell needs) to 2.
The down rays start at y = 100, and the region may hold up to 65,536 cells.
The tool does not take `topY`, `groundRange` or `lowerPass`: for a scene taller than 100, ground ranges or arches, call `walkMap` from code.

The tool works on the active scene, a recipe scene or an imported asset scene.

### Obstacles and keep-out

Pass `keepOut` (metres) and bollards, lamp posts, planters and tables stop being ground.
For each cell a ray goes down from 2.6 m above the street level, and when its first hit stands more than 0.3 m above the lowest surface under it, the cell is an obstacle.
A kerb is 0.15 to 0.2 m, so kerbs stay walkable.
`streetY` is the street level; it defaults to the lowest surface in a sample of the region.
A closing step fills one-cell seams (kerb faces, cracks narrower than 0.75 m), obstacles are cut back out, and a cell closer than `keepOut` to an obstacle, a wall or a gap is not walkable (`x`).
In code pass `obstacles: true` or `obstacles: { streetY, fromY, reach, minHeight }` to `walkMap`, and give the result to `walkableMask(map, { clearance, groundRange, keepOut })`, which returns one 0 or 1 per cell, `column * rows + row`.
Cells then carry a fifth value, 1 for an obstacle.
Use a small `cellSize`: a 0.25 m grid caught poles that a 1 m grid missed.

### Large worlds

Pass `assetId` (from `scene_asset_catalog`) instead of a session to query a catalog GLB without creating a scene.
The file is read and parsed in the server process, its textures are dropped before decoding, and nothing is rendered, so it can pass the 1,000,000 vertex render cap (see [gltf.md](gltf.md)).
It still has to be a file of the configured `--assets` folder, under that folder's 64 MiB file limit, and it must stay within 6,000,000 vertices, 6,000,000 triangles and 16,384 parts, with 256 MiB for each part's index.
The server keeps one such scene; asking for another `assetId` replaces it.
`assetId` and `sessionId` are mutually exclusive.

Measured on the Bistro sample (2,829,226 triangles in 224 parts, 48 MiB file) on a machine under load: parsing 1.3 s, a 0.25 m grid over x -62 to 111 and z -88 to 97 (513,513 cells; in code, since the tool caps a region at 65,536 cells) with `keepOut` 1.0 in 38 s.
Against a Blender walk map of the same grid, 99.95 percent of the 149,652 cells with a surface in both agree on obstacle or not, and all 295 pole clusters in it are excluded.
