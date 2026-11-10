# Profile, contour and path modeling

Available from version `0.4.0`.
The optional modeling entry builds its meshes itself and has no dependency on Three.js.
The core renderer does not import the modeling addon.

```js
import { lathe, extrude, tube } from '@codepawlhq/67js/addons/modeling';

const vessel = lathe([[0, 0], [0.6, 0], [0.8, 1], [0.6, 2], [0, 2]]);
const panel = extrude([[-2, -2], [2, -2], [2, 2], [-2, 2]], {
  holes: [[[-1, -1], [-1, 1], [1, 1], [1, -1]]],
  depth: 0.2,
  bevel: 0.03,
});
const cable = tube([[0, 0, 0], [1, 1, 0], [2, 0, 1]], { radius: 0.04 });
```

Each result has Float32 positions, normalized normals and UV channel zero, plus Uint32 triangle indices.
Pass it as a part's `geometry` to `Renderer67`. Inputs are copied. Repeated instances can share the returned mesh.
These generators run when constructing a scene, rather than every frame.

## Lathe

`lathe(profile, { segments = 64, startAngle = 0, sweep = 2π, maxVertices = 250000 })`
revolves radius/height pairs around Y. Radii must be nonnegative, with at least one positive radius.
Angles use radians. Large start angles normalize modulo one turn before evaluation.
Segments range from 3 to 2048. UVs preserve the longitudinal seam.

Profiles with radius-zero ends meet the axis. Partial sweeps and open profile ends remain open.
Folded profiles can intersect themselves. This tool is not a solid Boolean solver.

## Extrude

`extrude(contour, { holes = [], depth = 1, steps = 1, bevel = 0, bevelThickness = bevel, bevelSegments = 3, maxVertices = 250000 })`
extrudes a simple XY polygon along positive Z. Holes must remain strictly inside the contour and cannot overlap, touch or nest.
Both polygon winding directions are accepted. A duplicated closing point is optional.
Bevels extend the caps from `-bevelThickness` to `depth + bevelThickness`.

Steps range from 1 to 256. Bevel segments range from 1 to 32.
Large bevels can intersect on narrow or concave shapes. Inspect the result and reduce bevel size to fit the local clearance.
The base contour validation does not establish that an arbitrary bevel produces a manifold solid.

## Tube

`tube(path, { radius = 0.1, segments = 64, radialSegments = 12, closed = false, maxVertices = 250000 })`
sweeps a circular cross-section along a centripetal Catmull-Rom curve through XYZ points.
Open paths need two points. Closed paths need three. Closed paths join the final sample back to the first.
Open tube ends have no caps. Paths can intersect themselves.

Segments range from 3 to 2048. Radial segments range from 3 to 128.

## Curve

`curve(points, { closed = false, radius = 0.05, taper, profile, resolution = 12, radialSegments = 8, maxVertices })`
sweeps a cross-section along a chain of cubic Bezier spans, the way a Blender curve with a bevel does.

- A point is `[x, y, z]`, which gets smooth automatic handles, or `{ position, handleIn, handleOut }` with handles as
  absolute positions (Blender's convention). A lone handle is mirrored. Open curves need two points, closed ones three, at most 1024.
- `resolution` is samples per span (1 to 64). The rings use the minimum-twist frames of `tube`.
- `taper` is 2 to 64 radius factors, at least 0, spread evenly along the arc length: `[1, 0.2]` thins to a fifth.
- `profile` is 3 to 256 `[x, y]` points of a closed cross-section in units of `radius`, either winding. Without it the
  section is a circle of `radialSegments` sides (3 to 128). Corners sharper than 40 degrees stay flat shaded.
- Open curves get flat caps with their own vertices, so the surface is closed and works with booleans.

Volume, area and bounds match Blender 5.2 for an open and a closed Bezier curve with a round bevel to 2e-5
(`tests/blender-curve-text.test.js`). A Blender bevel resolution of `n` is `radialSegments: 4 + 2n`.

### Splines, shapes and trim

`curveSet(splines, options)` sweeps up to 64 splines (4096 points in all) into one mesh that shares `radius`, `taper`,
`profile`, `resolution` and `radialSegments`. The scene geometry `curve` takes one spline in its own fields or several
in `splines`, never both. A spline is `{ points | shape, closed, kind, weights, trim }`, and `curve(points, { kind, weights, trim })` is the one-spline form.

- `kind` is `bezier` (default), `poly` or `nurbs`. A poly spline is straight segments with sharp corners; each ring takes the
  direction of the segment that leaves it, so corners are not mitred. A NURBS spline is a uniform cubic B-spline: open ones are
  clamped (they start and end on the first and last point), closed ones are periodic. `weights` holds one number above 0 per
  point (default 1); a higher weight pulls the curve toward its point.
- `shape` replaces `points` with a primitive in the XY plane, and sets `closed` and `kind` itself:
  - `{ type: 'arc', radius = 1, startAngle = 0, sweep = 3.14159, segments = 8 }`: a Bezier arc, exact to about 1e-7 of the radius;
    a sweep of 2 pi closes it. Angles are radians; circle segments are arcs.
  - `{ type: 'spiral', rotations = 2, startRadius = 1, endRadius = 1, height = 2, pointsPerRotation = 12, reverse }`: a helix
    along +Z, smooth through its points (a spiral staircase rail is `height` over `rotations`).
  - `{ type: 'star', points = 5, innerRadius = 0.5, outerRadius = 1, innerTwist = 0 }`: a closed poly spline of `2 * points` vertices.
- `trim: { start = 0, end = 1, length = false }` keeps the arc-length range from `start` to `end` as factors of the length, or
  as lengths when `length` is true (lengths past the end are clamped to it). `end` must be greater than `start`. A trimmed
  curve is open and gets caps, also when it was closed. Trimming a range that covers an open curve changes nothing. Trim is
  computed from the same samples every time, so raising `end` frame by frame grows the curve along the same path: that is how a
  vine grows in code.
- `grow: { name, steps = 8, value = 1 }` on a recipe curve makes that growth a motion track. The geometry is the bare root and
  each of `steps` (2 to 16) morph targets holds the curve grown that far, resampled to the same rings, so a morph track
  `{ kind: "morph", id: <name>, property: "weight", keyframes }` with values 0 to 1 grows the vine, and seeking equals playing.
  The growth runs over the spline's own trim range (a trim in factors). `value` is the growth with no track. More steps follow
  a curved path more closely; between steps the tube blends the two neighbours.

Not covered: trim ranges that wrap around the start of a closed curve, NURBS of other orders or with custom knots, a spline
fill, and mesh edges to curve.

## Text

`text(content, { size = 1, depth = 0.2, font = 'default', align = 'left', curveSegments = 4, maxVertices })`
extrudes glyph outlines. The text lies in the XY plane with its first baseline on `y = 0`, reads along +X, faces +Z and is centred
through its depth. `"\n"` starts a new line 1.2 em lower. `size` is the em height. At most 256 characters and 16 lines.

- The bundled font is DejaVu Sans, printable ASCII only: 94 glyphs, 20 KB of data, about 7 KB gzipped. It loads on demand
  with the text code and is never in the core, model or mesh entries. A character outside it throws.
- `registerFont(name, table)` (or `await registerAgentSceneFont(name, table)` from the agent scene entry) adds a font table:
  `{ unitsPerEm, ascender, descender, glyphs: { "A": [advance, contour...] } }` where a contour is `x, y, onCurve` repeated, in TrueType
  quadratic points. `scripts/build-font.py` makes a table from a TrueType file with fontTools. A glyph is limited to 128 points, a font
  to 2048 glyphs and 400000 points. The MCP never takes a font file or URL.
- `curveSegments` straight pieces per outline curve (1 to 16). Rings inside an odd number of others become holes.
- One glyph and a word match Blender 5.2 with the same font in volume, area and bounds to 2e-5. Blender's text size unit is not the em,
  so the golden script calibrates it on the capital I. There is no kerning, bevel or text on a curve.

## Resource and precision limits

Each generator accepts at most 4096 input points. Extrusion applies that limit across its contour and holes.
Vertex estimates are checked before geometry allocation. `maxVertices` can range from 3 to 1000000.
This bounds geometry size, not total browser memory.

Account for maps, instance counts and render targets separately.
Polygon intersection validation uses quadratic edge comparisons, bounded by the input limit.
Nonfinite output, invalid normals and entirely collapsed Float32 meshes throw.
Center small geometry near the origin and place it with part transforms when working at large world coordinates.

## API choice

Plain point arrays keep profiles serializable and keep any other library's classes out of the API.
Accepting custom curve objects would let callers supply their own curve classes, but weakens input bounds.
Lathe, bevel construction and curve frames follow the formulas Three.js used before, so those outputs are unchanged. Extrusion caps use an ear-clipping triangulation of the addon's own, so a cap can be split along different diagonals than before, with the same area, volume and bounds.

Mesh edits select and shape points and faces with JSON field expressions, never code; see [field expressions](mesh.md#field-expressions).

The Aster lantern at `/modeling.html` combines these tools with texture channels and the shared scene graph.
It is a procedural modeling demonstration, not a mesh editor or a Blender feature parity claim.
