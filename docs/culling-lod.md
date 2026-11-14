# Culling, levels of detail and adaptive resolution

`CrucibleRenderer` skips what the camera can not see and can draw far copies of a model with fewer triangles. Both are decided on the CPU from the camera and the instance matrices alone. A scene that has no off-screen parts and no levels draws as before.

## Culling

On by default, with no schema and no option to set. Each frame the renderer tests every instance of a batch (the parts that share a geometry and a material) against the six planes of the view frustum, using the geometry's bounding sphere scaled by the instance matrix. The colour pass then draws only the instances that touch the frustum. A batch with nothing visible costs no draw call, a batch that is entirely visible uses its full instance buffer as before, and a partly visible batch uploads the visible instances once.

What is not culled, because its bounding sphere would not hold or because it draws in another pass:

- Skinned and morphed parts. A crowd part (a character baked to a palette, see [Crowds](retarget.md#crowds)) is the exception: its instances are culled by a bound that covers every pose of the clip, and it takes `lods` whose levels carry the same joints.
- `water`, `fire` and `smoke` materials, whose vertex shader moves vertices.

`foliage` and `grass` sway in the wind but by a known amount, so they are culled and take levels like rigid parts: the bound of each instance grows by 0.56 times the wind strength (the farthest `windOffset` in the vertex shader moves a vertex per unit of strength).
- Parts with an `assembly`.
- Alpha-blended, `liquid` and `foam` batches.
- The shadow passes. A caster outside the view can still shadow the view, so shadow maps draw every caster.

Pass `culling: false` to the `CrucibleRenderer` options to turn it off, for example to compare a picture.

## Levels of detail

Give a part `lods`, the array that `generateGeometryLods(geometry, { ratios })` returns (`generateAssetLods` gives one asset per level, so use the geometries of its parts). Level 0 must be the part's own `geometry`. Parts with the same geometry and the same `lods` array share one batch, and each instance picks its own level.

```js
const levels = generateGeometryLods(rock, { ratios: [0.25, 0.06] });
const parts = positions.map((position, index) => ({ name: `rock-${index}`, geometry: rock, lods: levels, matrix: translate(position), material }));
const renderer = new CrucibleRenderer(canvas, parts, { lodPixelError: 1 });
```

An instance uses the coarsest level whose `error` (the farthest its vertices lie from level 0, in geometry units, times the instance's largest scale) covers at most `lodPixelError` pixels on screen at its distance. The default is 1 pixel. Level 0 is always allowed, so a close instance is never reduced.

`lods` is refused for the parts that culling skips (the list above), because their levels could not be chosen from a bounding sphere.

## Cross-fades and impostor levels

`lods` switch a mesh by its pixel error and do not fade. The vegetation addon chooses its own levels by distance (`selectLevels`) and can fade between them: `selectLevels(instances, eye, { fade: 0.06 })` draws both levels near a threshold with complementary screen-door coverage (a mask material whose `opacityBias` carries the coverage; the code registers when the vegetation addon is imported), `pixelError: { pixels, height, fov }` sets the switch distances from an error in screen pixels (4 pixels on a 1080 pixel high view with a 60 degree field of view gives the default distances), and `impostors` adds a last level that draws one baked card per tree (material tag `impostor`), which shows a stochastic blend of the four baked views around the viewing direction. Culling treats the card as a rigid part: its bounding sphere holds the quad, and the sway is a few centimetres. These choices depend on the distance and the view only, so they keep the determinism below; see [Vegetation](https://crucible.codepawl.com/vegetation.md#impostors-and-cross-fade).

## Determinism

The selection is a pure function of the geometry, the instance matrices, the camera and the canvas height. It keeps no state between frames, so a seek to any time draws the same instances at the same levels as playing up to it. `tests/render-culling.test.js` checks this on the selection, and `npm run benchmark:runtime` draws the first frame again after every measured frame and fails when the picture differs.

## GPU timing and adaptive resolution

`createGpuTimer(context)` from `src/adaptive-quality.js` wraps `EXT_disjoint_timer_query_webgl2` (it returns `null` without the extension). Pass the function itself as the `createGpuTimer` option of `CrucibleRenderer` and the renderer times each frame. A result arrives a few frames late, so `renderer.gpuMilliseconds` holds the latest finished one, or `null` after a disjoint measurement. Without the option nothing is timed and the timer code is not bundled.

`createAdaptiveResolution({ exporting: false, targetMilliseconds, minimumScale, step, window })` from `src/adaptive-quality.js` returns a controller. Feed it one frame time per frame with `update(milliseconds)` and multiply the pixel ratio by the scale it returns. It lowers the scale by one `step` when the average of `window` frames is over the target, raises it only after a whole window under 0.6 of the target, and never goes below `minimumScale` (default 0.5). `createAdaptiveResolution({ exporting: true })` throws: exports keep full quality, and the live viewer in `src/main.js` builds a controller only when its `export` parameter is not `1`.

## Measured

See `bench/runtime/README.md`, scene `large-outdoor`.
