# Gaussian splats

`crucible/addons/gaussian-splats` draws 3D Gaussian splats, the format that captured rooms, streets and products ship in, behind or among the parts of a scene. It is in the current source and not yet published. It is an optional package: the core renderer has no code for it, so the core bundle does not change, and a scene without splats never loads it. Recipes and the MCP server do not reach it yet: the local asset catalog reads GLB files only, and what the addon costs is recorded below first.

```js
import { CrucibleRenderer } from 'crucible';
import { attachGaussianSplats, createGaussianSplats, parseGaussianSplatPly } from 'crucible/addons/gaussian-splats';

const bytes = await (await fetch('/scene.ply')).arrayBuffer();
const data = parseGaussianSplatPly(bytes, { maximumCount: 1_000_000 });
// Many captures are y-down: this matrix turns the scene upside down and puts it 3 m behind the origin.
const splats = createGaussianSplats(data, { matrix: [1, 0, 0, 0, 0, -1, 0, 0, 0, 0, -1, 0, 0, 0, -3, 1] });

const renderer = new CrucibleRenderer(canvas, scene.parts, { ground: false });
const detach = attachGaussianSplats(renderer, splats);
renderer.render(camera); // parts first, then the splats, farthest first
detach();               // or renderer.dispose()
```

## What it reads

One format: the standard 3DGS PLY that the original training code and most tools write: binary little endian with `x y z f_dc_0..2 opacity scale_0..2 rot_0..3` per vertex. Other properties (normals, `f_rest_*`) are skipped, so a splat has one colour from every direction (spherical harmonics of degree 0). `.spz`, `.ksplat` and `.splat` files are not read; `bench/gaussian-splats/fetch-sample.mjs` shows a short `.splat` to PLY conversion.

A file over `maximumBytes` (default 512 MiB), or one whose header names more than `maximumCount` splats (default 2,000,000, never above 4,000,000), throws a `RangeError` before any splat is read. A file that is not a PLY, is ASCII, lacks a property or is truncated throws an `Error` that names the problem. `createGaussianSplats` applies the count limit again.

## Loading without freezing the page

`parseGaussianSplatPly` and `createGaussianSplats` run to the end in one go: about 280 ms of blocked main thread for 1,000,000 splats, seconds for 2,000,000 on a slow machine. For a page that must keep drawing, use the async twins. They return exactly the same bytes, working in slices and waiting one macrotask (no worker needed) between slices.

```js
import { createGaussianSplatsAsync, parseGaussianSplatPlyAsync } from 'crucible/addons/gaussian-splats';

const controller = new AbortController(); // controller.abort() from a cancel button
const options = { chunkSize: 32768, signal: controller.signal, onProgress: fraction => { bar.value = fraction; } };
const data = await parseGaussianSplatPlyAsync(bytes, { ...options, maximumCount: 1_000_000 });
const splats = await createGaussianSplatsAsync(data, options);
```

- `onProgress(fraction)` is called after each slice with a rising fraction that ends at exactly 1. Each step reports its own 0 to 1, so map them to the parts of one bar yourself.
- `chunkSize` is the number of splats per slice (default 32768, a few milliseconds). It must be a positive whole number.
- An aborted `signal` stops at the next slice and rejects with an `Error` named `AbortError`. A signal that is already aborted rejects before any work.
- The header checks, size limits and count limit run first and reject exactly as in the sync functions. `createGaussianSplatsAsync` takes `matrix` and `maximumCount` too.
- Measured with `node bench/gaussian-splats/async-block.mjs` on 1,000,000 generated splats: the longest block drops from about 275 ms to about 22 ms, and the total time is the same (about 255 ms). The sort order buffers `createGaussianSplatsAsync` allocates at the end are not sliced.

## What it draws

- Each splat is a screen-space quad shaped by its 3D covariance, projected through the camera as in the original paper. Colour is the stored colour, as 3DGS viewers show it, not converted from sRGB. The opacity falls off as a Gaussian toward the quad edge.
- The splats draw after the opaque and translucent parts of the renderer, with the depth test against them and no depth write, so a part in front hides the splats behind it and splats never hide a part. A splat is tested at its centre depth, so one that pokes through a surface is not clipped along the surface.
- Splats blend back to front. The sort is on the CPU, on the main thread: a counting sort of the view depth into 65536 steps, then one upload of the order (4 bytes per visible splat). The sort is skipped when the view depth axis is the same as in the last frame: a still camera, or one that only moves sideways or up and down. Splats behind the camera are left out.
- `matrix` may rotate, translate and scale uniformly. Perspective cameras only. Splats are not drawn in render passes, benchmark mode or the water reflection image, and are not lit, shadowed or fogged.
- `attachGaussianSplats` wraps `renderer.drawBlendBatches`, the step that runs once per frame after the parts and before the frame is resolved. The renderer has no other link to the addon. Attach several scenes and they draw farthest first by their bounds centre.

## Memory

GPU: 48 bytes per splat in one RGBA32UI texture and 4 bytes for the order buffer (52 bytes, 52 MB per million). CPU after creation: 12 bytes of positions and 8 bytes of sort scratch per splat; the parsed arrays and the packed texture data can be dropped once `createGaussianSplats` has returned and the splats are attached. The parse itself needs the file plus 44 bytes per splat.

## What it costs

See [bench/gaussian-splats/README.md](../bench/gaussian-splats/README.md) for frame times and memory at 100,000 and 1,000,000 splats on an RTX 3060 and on SwiftShader, and the comparison with the three.js `GaussianSplat`.
