# Static mesh queries

Use mesh queries to find contacts between triangle surfaces or containment between validated closed solids.
These CPU queries accept static geometry and explicit affine matrices.
They do not measure penetration depth, correct collisions, or diagnose depth-buffer artifacts.

```js
import { createMeshQueryIndex, createMeshPairQuery } from 'crucible/addons/mesh-query';

const outer = createMeshQueryIndex(outerGeometry, { solid: true });
const inner = createMeshQueryIndex(innerGeometry, { solid: true });
const query = createMeshPairQuery(outer, inner, { mode: 'closed-solids' });
const result = query.evaluate(outerMatrix, innerMatrix);
const hit = inner.raycast(innerMatrix, {
  origin: [0, 0, 4],
  direction: [0, 0, -1],
  maxDistance: 10,
});

outer.dispose();
inner.dispose();
```

## Owned geometry and budgets

`createMeshQueryIndex(geometry, options)` copies `geometry.positions` and `geometry.indices` once.
Positions must use nonempty `Float32Array` XYZ triples.
Indices must use nonempty `Uint32Array` triangle triples.
All positions must remain finite, and every index must reference an existing vertex.
UVs, colors, normals, and materials do not affect the queries.

The constructor rejects skin attributes and morph targets.
The caller must provide geometry that matches the visible static surface.
Shader displacement and procedural materials can change that surface without changing its triangle buffers.
Build another index after any geometry edit.
Source edits after construction do not change the copied query surface.

| Option | Default | Accepted range |
| --- | --- | --- |
| `maxVertices` | 250000 | Integer from 1 through 1000000 |
| `maxTriangles` | 250000 | Integer from 1 through 1000000 |
| `memoryBudgetMiB` | 64 | Number greater than 0 through 1024 |
| `solid` | false | Boolean |
| `maxValidationPairs` | 2000000 | Integer from 1 through 100000000 |

The constructor checks counts, triangle quality, and an allocation estimate before creating the copied buffers and BVH.
The estimate reserves 24 bytes per vertex and 128 bytes per triangle for surface indices.
Solid validation reserves 152 bytes per vertex and 512 bytes per triangle.
JavaScript object overhead and temporary library allocations vary between runtimes.
`memoryBudgetMiB` limits this estimate, not the total process memory.

`index.info` contains frozen `vertexCount`, `triangleCount`, and `estimatedBytes` fields.
`index.memoryPlan` also contains `reservedBytes`, `memoryBudgetMiB`, and `validationPairs`.
Neither field exposes geometry buffers or library objects.
`dispose()` releases the owned geometry and BVH references.
Repeated disposal succeeds, but subsequent queries throw.

## Surface and solid results

`createMeshPairQuery(indexA, indexB, options)` accepts `mode` and `maxTriangleTests`.
The default mode is `surfaces`.
The triangle budget defaults to 2000000 and accepts integers from 1 through 100000000.
Each evaluation returns a fresh serializable object.

| `kind` | `solidRelation` | Meaning |
| --- | --- | --- |
| `surface-intersection` | `not-tested` | Surface mode found touching, crossing, or coplanar triangles |
| `surface-disjoint` | `not-tested` | Surface mode found no boundary contact |
| `surface-intersection` | `boundaries-intersect` | Closed-solid mode found boundary contact |
| `contained` | `a-in-b` | Solid A lies inside solid B without boundary contact |
| `contained` | `b-in-a` | Solid B lies inside solid A without boundary contact |
| `separate` | `outside` | Closed-solid mode found neither contact nor containment |

`triangles` contains the first contacting pair of original triangle indices, or `null`.
`triangleTests` counts actual triangle callbacks, including containment rays.
`rayAttempts` counts containment ray directions, including rejected grazing directions.
The traversal order determines the first pair, so the result does not identify every contact.
Exhausting a budget throws instead of returning a disjoint result.
Errors leave the index usable for another evaluation.

Surface contact alone does not establish volume penetration.
Two closed solids can touch at a face, edge, or vertex without overlapping interiors.
Two surfaces can remain disjoint while one closed solid contains another.
Depth-buffer fighting also depends on the camera, projection, and renderer precision.

## Closed-solid validation

Both indices must use `solid: true` for `closed-solids` queries.
Validation welds exactly equal position triples, including duplicates at UV seams.
It does not merge approximately equal positions.
Every welded edge must have two oppositely directed faces.
The boundary must remain connected, and each vertex link must form one cycle.
This contract accepts one boundary component, including a torus, but rejects separate shells and cavity boundaries.

A BVH self-cast checks actual candidate triangle pairs within `maxValidationPairs`.
Adjacent triangles can meet along their shared edge or vertex.
Overlapping adjacent faces and intersections beyond those shared features cause an error.
Open boundaries, duplicate faces, disconnected shells, and self-crossing surfaces also cause an error.

After excluding boundary contact, the query tests a boundary vertex from each solid against the other solid.
It tries six fixed ray directions and requires two unambiguous directions to agree.
Hits near triangle edges, vertices, or the ray origin cause a retry.
Coplanar grazing also causes a retry.
Conflicting witnesses or exhausted retries throw an indeterminate-containment error.
The query never counts raw duplicate edge hits as reliable parity evidence.

## Matrices and numerical limits

Each query matrix must contain 16 finite, Float32-representable components in column-major order.
The query rounds those components to Float32 before evaluation.
The last row must equal `[0, 0, 0, 1]`, and the matrix must remain nonsingular.
Reflections, nonuniform scales, rotations, and shear are supported.
Each evaluation uses only the supplied matrices, so arbitrary forward and backward animation seeks give the same result.

The index normalizes its copied positions into a private Double-precision frame.
Matrix inversion and relative transforms also use Double precision.
Original triangle indices remain unchanged through an indirect BVH.
This permits very small and very large finite source meshes without Float32 cross-product overflow.

Triangles must have a normalized minimum altitude greater than `1e-8`.
Pair evaluation requires each relative mesh extent to stay within `1e6` normalized units.
Its transformed minimum altitude must remain greater than `1e-8` in the other normalized frame.
World bounds must remain finite in Float32, and triangle altitudes must exceed a conservative world precision margin.
The margin uses an inverse-matrix norm and approximately four Float32 units at the largest world coordinate.
Large translations can therefore reject a small mesh even when every individual input remains finite.

Intersection and ambiguity tests use numerical tolerances rather than exact arithmetic predicates.
The ambiguity tolerance is `1e-9` in the normalized frame.
The API rejects unsupported precision domains instead of promising reliable results for arbitrarily thin or collapsed geometry.

## Rays

`index.raycast(matrix, { origin, direction, maxDistance })` accepts world-space origin and direction triples.
Their components must remain finite and representable in Float32.
The direction must remain nonzero after Float32 rounding.
`maxDistance` defaults to infinity and must remain nonnegative.
The normalized local ray origin must remain within `1e6` units.

A miss returns `null`.
A hit returns `{ point, distance, triangle, barycentric }`.
`point` and `distance` use world coordinates.
`triangle` identifies the original triangle, and `barycentric` follows its three original index entries.
Rays test both triangle sides.
Ray hits can land on edges, so a single public ray hit does not establish solid containment.

The source index also supplies counted target-local `nearest()` and `project()` helpers.
Read the [shrinkwrap query contract](shrinkwrap.md#target-local-query-helpers) before mixing their coordinates with world-space rays.

## Design choice and references

Two designs were considered: explicit owned indices with matrix arguments, and an implicit scene cache borrowing mutable geometry buffers.
The explicit design gives the caller control over rebuilds, disposal, budgets, and animation evaluation.
It avoids hidden invalidation rules and prevents source edits from changing a query midway through evaluation.
Fresh results also avoid partially updated output objects after validation fails.

The index is a typed-array BVH (`src/triangle-bvh.js`) with its own triangle tests (`src/triangle-math.js`), and imports neither Three.js nor three-mesh-bvh.
It returned the same hits, distances and pair results as three-mesh-bvh 0.9.16 on the test fixtures and on random queries.
Closed-manifold validation and the containment contract described here are part of this module.

These APIs are available in the current source build. The published npm version can lag behind it.
