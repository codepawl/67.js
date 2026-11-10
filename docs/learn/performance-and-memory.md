# Performance and memory

A frame costs CPU time to prepare and GPU time to draw. Most wins come from drawing less: fewer draw calls, fewer triangles, fewer pixels and fewer render targets. This page covers what 67js does for you, what you control, and how to measure it. Every number below comes from the repository's own benchmarks, with the date and the conditions, and your machine will differ.

## Measure first

Time a frame on your own machine before you change anything. Reading one pixel back with `readPixels` waits for the GPU, so a loop around it includes the draw work and not only the CPU. Press a button to rebuild the scene in a mode and read the averages in the console.

```js live poster=performance-batching
import { Renderer67, box, sphere } from '67js';

const canvas = document.querySelector('#scene');
const count = 400;
const material = { color: [0.4, 0.6, 0.85], metallic: 0, roughness: 0.5 };

function makeParts(sharedGeometry) {
  const shared = sharedGeometry ? box(0.05, 2) : null;
  return Array.from({ length: count }, (unused, index) => {
    const x = (index % 20 - 9.5) * 0.5;
    const z = (Math.floor(index / 20) - 9.5) * 0.5;
    return {
      name: `Box ${index}`,
      geometry: shared ?? box(0.05, 2),
      matrix: new Float32Array([0.3, 0, 0, 0, 0, 0.3, 0, 0, 0, 0, 0.3, 0, x, 0.2, z, 1]),
      material,
    };
  });
}

let renderer = null;
let timer = 0;
const pixel = new Uint8Array(4);
// Reading a pixel back waits until the GPU has finished the frame.
function forceGpu() {
  const context = renderer.context;
  context.readPixels(0, 0, 1, 1, context.RGBA, context.UNSIGNED_BYTE, pixel);
}
function setup(label, sharedGeometry, batching) {
  clearInterval(timer);
  renderer?.dispose();
  const parts = makeParts(sharedGeometry);
  renderer = new Renderer67(canvas, parts, { batching });
  const view = { eye: [0, 7, 9], target: [0, 0, 0], fov: 45 };
  renderer.render(view);
  forceGpu();
  const samples = [];
  for (let frame = 0; frame < 30; frame++) {
    const start = performance.now();
    renderer.render(view);
    forceGpu();
    samples.push(performance.now() - start);
  }
  samples.sort((first, second) => first - second);
  console.log(`${label}: median ${samples[15].toFixed(2)} ms, min ${samples[0].toFixed(2)}, max ${samples[29].toFixed(2)} (30 frames, ${count} parts)`);
  console.log(`  render targets: ${renderer.memoryReport().totalMegabytes} MB`);
  timer = setInterval(() => renderer.render(view), 1000 / 30);
}

const bar = document.createElement('div');
bar.style.cssText = 'position:fixed;left:8px;bottom:8px;display:flex;gap:8px;color:#dde;font:12px system-ui;background:#000a;padding:6px 8px;border-radius:6px';
for (const [label, shared, batching] of [['shared geometry', true, true], ['one geometry per part', false, true], ['batching off', true, false]]) {
  const button = document.createElement('button');
  button.textContent = label;
  button.addEventListener('click', () => setup(label, shared, batching));
  bar.append(button);
}
document.body.append(bar);
new ResizeObserver(() => renderer?.resize()).observe(canvas);
setup('shared geometry', true, true);
addEventListener('pagehide', () => { clearInterval(timer); renderer?.dispose(); });
```

The numbers depend on your GPU and on what else it is drawing. The goal is to see the order of magnitude and to compare modes on one machine, not to read an absolute value. Read a range, not one run.

## Draw calls, batching and instancing

Parts that share a geometry and a material go into one batch, and a batch is one instanced draw. The renderer batches by default (`batching: true`). A scene of 1,000 boxes with one geometry is one draw, and 1,000 boxes that each own a geometry is 1,000 draws. So build a geometry once with `box`, `sphere`, `cylinder` or `torus` and reuse the object for every part, and share material objects when parts look the same.

The benchmark `instanced-objects` (bench/runtime/README.md, measured twice on 2026-11-04 at 960 by 540 with 4 samples) shows the effect. On an RTX 3060, 67js took 0.83 to 1.04 ms per frame and three.js with separate meshes took 2.44 to 2.61 ms. A three.js `InstancedMesh` took 0.25 ms, so an engine-level instance buffer is still faster than batching. On SwiftShader, the CPU path an agent uses, the same scene took 104 to 119 ms in 67js and 34 to 35 ms in three.js. The GPU was shared with other jobs during the runs, so the RTX numbers are noisy.

Move existing transforms with `renderer.updateParts(parts)`. Adding or removing parts needs `replaceParts`, and an unchanged identity set is cheaper. Do not create a renderer per frame.

## Culling and levels of detail

Culling is on by default. Each frame the renderer tests every instance of a batch against the six view planes using its bounding sphere, and draws only the instances that touch the frustum. Skinned and morphed parts, parts with an `assembly`, alpha-blended and `liquid` passes are not culled, and the shadow passes draw every caster. Pass `culling: false` to compare pictures.

Levels of detail swap a mesh for a coarser one by pixel error. Give a part `lods`, the array from `generateGeometryLods(geometry, { ratios: [0.25, 0.06] })`, with level 0 equal to the part's own geometry. An instance takes the coarsest level whose error covers at most `lodPixelError` pixels (default 1).

```js
const levels = generateGeometryLods(rock, { ratios: [0.25, 0.06] });
const parts = positions.map((position, index) => ({ name: `rock-${index}`, geometry: rock, lods: levels, matrix: translate(position), material }));
const renderer = new Renderer67(canvas, parts, { lodPixelError: 1 });
```

The scene `large-outdoor` (6,000 spheres of about 1,000 triangles over 600 by 600 units, seen from the edge, 960 by 540, measured on 2026-10-31) shows what this saves:

| Mode | RTX 3060 frame (ms) | Triangles | SwiftShader frame (ms) |
| --- | --- | --- | --- |
| No culling, no levels | 8.41 | 5,760,014 | 4,428 |
| Culling only | 7.68 | 4,359,374 | 4,061 |
| Culling and levels | 1.55 | 270,474 | 517 |
| three.js, per-mesh culling | 6.00 | 4,359,372 | 944 |

Culling alone gives the same picture pixel for pixel. Levels change 1.9 percent of the pixels by more than 8 levels out of 255. The GPU was shared with other jobs (1 to 87 percent busy), so the GPU column is noisy. [Culling, levels and adaptive resolution](https://github.com/codepawl/67.js/blob/main/docs/culling-lod.md) holds the contract. Vegetation chooses its own levels by distance with `selectLevels`, and can fade between them.

## Shadow cost and render targets

Shadows and post effects are the biggest fixed memory in a frame. At 960 by 540 with 4 samples, a plain lit scene held these render targets (`renderer.memoryReport()`, measured 2026-11-04): a 2048 by 2048 `shadowMap` of 16 MB, `multisampleColor` 15.82 MB, `multisampleDepth` 3.96 MB and `frameColor` 3.96 MB, 41.36 MB in all. At 1920 by 1080 the total was 110.92 MB, and the multisampled colour alone was 63.28 MB, 57 percent of it.

What you can do about it:

- A scene with no shadow caster allocates a one texel shadow map instead of 16 MB. Bloom, ambient occlusion, cascades and the point light atlas allocate only when used.
- Fewer samples cut the largest target. `samples: 2` halves the multisampled colour.
- With `shadowCascades` on, a scene also holds the cascade array (48 MB for three 2048 slices). A scene that does not need cascades should leave them off. A scene wider than 40 m gets three cascades by default because one map would cover more than 80 m, so a texel would be 4 cm or wider; set `shadowCascades: 0` to keep the single map.
- The opt-in addon `useCompactColor(renderer)` from `67js/addons/compact-color` stores the frame and multisample colour as R11F_G11F_B10F. At 1920 by 1080, 110.92 MB became 71.37 MB, 39.55 MB less. The 26 reference pictures differ from the default by a mean FLIP of 0.002 to 0.030 (median 0.021), so it changes pixels slightly.

Rebuild a renderer with other options and read the totals yourself. This example swaps samples and shadows, disposes the old renderer, and prints the new target list.

```js live poster=performance-memory
import { Renderer67, box, sphere, estimateFrameBytes } from '67js';

const canvas = document.querySelector('#scene');
const parts = [
  { name: 'Ball', geometry: sphere(48, 32), matrix: new Float32Array([0.8, 0, 0, 0, 0, 0.8, 0, 0, 0, 0, 0.8, 0, 0, 0.8, 0, 1]), material: { color: [0.9, 0.5, 0.3], metallic: 0, roughness: 0.4 } },
  { name: 'Pillar', geometry: box(0.05, 3), matrix: new Float32Array([0.5, 0, 0, 0, 0, 1.6, 0, 0, 0, 0, 0.5, 0, 1.6, 0.8, 0, 1]), material: { color: [0.4, 0.6, 0.85], metallic: 0, roughness: 0.5 } },
];

let renderer = null;
function rebuild(samples, hdr) {
  renderer?.dispose();
  renderer = new Renderer67(canvas, parts, { samples, hdr });
  renderer.render({ eye: [0, 2.2, 6], target: [0, 0.8, 0], fov: 40 });
  const report = renderer.memoryReport();
  console.log(`samples ${samples}, hdr ${hdr}: ${report.totalMegabytes} MB in ${report.targets.length} targets`);
  for (const target of report.targets) console.log(`  ${target.name} ${target.width ?? ''}x${target.height ?? ''} ${(target.bytes / 1e6).toFixed(2)} MB`);
  const estimate = estimateFrameBytes(canvas.width, canvas.height, samples, 2048, { hdr });
  console.log(`estimateFrameBytes at ${canvas.width}x${canvas.height}: ${(estimate / 1e6).toFixed(2)} MB`);
}

const bar = document.createElement('div');
bar.style.cssText = 'position:fixed;left:8px;bottom:8px;display:flex;gap:8px;color:#dde;font:12px system-ui;background:#000a;padding:6px 8px;border-radius:6px';
for (const [samples, hdr] of [[1, false], [2, false], [4, false], [4, true]]) {
  const button = document.createElement('button');
  button.textContent = `${samples} samples${hdr ? ' + hdr' : ''}`;
  button.addEventListener('click', () => rebuild(samples, hdr));
  bar.append(button);
}
document.body.append(bar);
rebuild(4, false);
addEventListener('pagehide', () => renderer?.dispose());
```

## Textures and KTX2

Reuse decoded textures and never decode the same image twice. A texture is stored as RGBA8 with a mip chain, which is a third more than the base level, so a 2K map takes about 22 MB. A KTX2 file keeps the texture GPU-compressed. When your KTX2 loader transcodes to BC7, BC1, BC3, ASTC 4x4 or ETC2, the renderer uploads each mip with `compressedTexSubImage2D`, and a 2K map takes about a quarter of the memory of RGBA8 (change 304). `ktx2WorkerConfigFor(context)` from `67js/addons/gltf` gives the loader the formats that the context accepts, and the loader falls back to RGBA8 where the GPU takes none. Large glTF texture sets are scaled down at load when they pass `maxTexturePixels`: 40 maps of 1024 px load as 512 px with the default options. `bench/ktx2/measure.mjs` measures the upload with a Khronos sample asset; run it yourself for numbers on your GPU.

## Adaptive quality

When the frame budget is the constraint, lower the resolution before the scene. `createGpuTimer(context)` from `src/adaptive-quality.js` wraps `EXT_disjoint_timer_query_webgl2`. Pass the function as the `createGpuTimer` option and the renderer times each frame, and `renderer.gpuMilliseconds` holds the latest finished result (a few frames late, or `null` after a disjoint measurement). `createAdaptiveResolution({ targetMilliseconds, minimumScale, step, window })` returns a controller. Feed it each frame time with `update(milliseconds)` and multiply the pixel ratio by the scale it returns. It lowers the scale by one `step` when the average of `window` frames is over the target, raises it only after a whole window under 0.6 of the target, and stays at or above `minimumScale` (default 0.5). `createAdaptiveResolution({ exporting: true })` throws, because exports keep full quality.

## Release memory

`renderer.dispose()` deletes the buffers, textures, programs and render targets that the renderer owns. Call it when a scene goes away, on `pagehide`, and before you build a new renderer for the same canvas. Dispose loaders and decoders yourself (`draco.dispose()`, `ktx2.dispose()`), and call `physics.dispose()` for a recorded physics scene. A texture added through `replace-textured-parts` is deleted when no part uses it any more.

## Guidance

Reuse geometry and decoded textures. Do not create a renderer per frame. Change existing transforms through `updateParts`. Lower scene detail before you increase the budget.

Pause hidden scenes and avoid simultaneous GPU exports. For static previews, redraw on demand rather than looping.

The planner includes geometry, textures and mipmaps, shadows, MSAA, HDR, bloom and one capture staging frame, and reduces render dimensions when necessary. The exporter keeps one pending capture and respects encoder backpressure. This is an estimated allocation budget, not a hard process RAM or VRAM cap. Driver and browser allocations can still fail, and sampled browser JS heap and Node RSS do not measure total graphics memory.

## Where three.js still wins

Be honest about the comparison. On 2026-11-04 (two runs, 960 by 540) three.js had the faster full frame on SwiftShader in all seven benchmark scenes and on the RTX 3060 in five of seven, and a faster first frame in all seven. 67js drew `instanced-objects` and `moving-shadows` faster than three.js with separate meshes. Run `npm run benchmark:runtime` for your own numbers; it takes about 8 minutes and needs Chrome and a GPU.

## Common mistakes

- Creating a new geometry per part when the shape is the same. It defeats batching.
- Measuring with `performance.now()` around `render()` alone. Without a pixel read-back or the GPU timer you time only the CPU.
- Quoting a number from one noisy run. Compare modes on one machine, as a range.
- Leaving shadow cascades or bloom on for a small scene.
- Never calling `dispose()`, so WebGL contexts and GPU memory pile up across navigations.
