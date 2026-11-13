# @codepawlhq/67js-render-native

Optional. Traces a 67js scene on the GPU with hardware ray queries (wgpu, Vulkan) instead of the browser's software BVH walk. It uses the same WGSL path tracer as the browser kernel, so one seed gives the same picture. It is not a root dependency. Render jobs with `settings.renderer.backend: "native"` use it when it is installed and built, and fall back to the `gpu` backend with a note when it is not (see docs/agent-render-jobs.md).

Needs Rust (stable) and a Vulkan GPU with ray queries. On Windows build for MSVC; the default GNU toolchain crashes any wgpu 30 program. The DX12 backend does not report ray queries, so the addon uses Vulkan only.

```sh
npm run build   # cargo build --release, copies build/render-native.node
```

```js
import { buildNativeInput, traceNative } from '@codepawlhq/67js-render-native';
import * as pack from '<engine>/src/path-tracer-gpu-pack.js';

const options = { width: 1920, height: 1080, samples: 64, bounces: 8, seed: 0 };
const input = buildNativeInput(traceScene, camera, options, pack);
const { rgba, adapter, tracedSeconds } = traceNative(input, options);
```

`createNativeOidnDenoiser({ libraryPath, device = 'cpu', quality = 'high', cleanAux = false, threads = 0 })` opens a persistent Open Image Denoise device, four image buffers and a committed "RT" filter inside the addon. The OIDN shared library is loaded at run time from `libraryPath` (`findOidnLibrary()` of the denoise package), so the addon builds and loads without it. The object has `denoise({ width, height, color, albedo, normal })` (`albedo` optional, `normal` only with `albedo`; returns the colour and the seconds of the commit, buffer writes, execute and read), `close()` and `deviceSeconds`. The filter is recommitted only when the width, height or set of guides changes. The image goes to the device with `oidnWriteBuffer` and back with `oidnReadBuffer`, because GPU devices take no host pointers; the tracer's Vulkan buffers are not shared with CUDA. Most jobs use the wrapper `createOidnDenoiser` of `@codepawlhq/67js-denoise-oidn`.

`rgba` is linear float RGBA, rows from the top, averaged over the samples. `albedo` and `normal` (three floats per pixel, normalise the normal), `depth` and `variance` (one float) are the first-hit features the wavelet and OIDN denoisers read. In the `cycles` kernel `depth` is the distance along the camera ray to the first surface, averaged over the samples, also for a sample that scatters in fog before that surface (before #1122 it held the scatter distance, which pulled the depth of a pixel in light fog short); a sample whose camera ray hits no surface adds 0. `albedo` and `normal` describe the first event of the path, not the first surface: a sample that scatters in fog first adds the fog albedo and the direction back to the camera, so a foggy pixel's guides mix the fog's and the surface's. The a-trous filter divides the light by `albedo` and puts it back after filtering, which is why the fog's own albedo is the right guide for light that the fog scattered. A first surface that is fully transparent (a cutout with opacity 0, a transparent material) is not skipped for depth when fog scatters before it: that sample records the transparent surface's distance. `pack-input.mjs` holds `buildNativeInput` without Node imports, so the job page packs the scene itself. `bench/native-tracer` compares it with the browser kernel.

Fog (`scene.volume`), subsurface scattering and `options.noiseThreshold` (the CPU tracer's stop rule: converged pixels draw no more samples, `averageSamples` in the result is the mean drawn) are in the kernel. `traceNative` also takes `maxSeconds` (stopping with an error once the trace has run that long) and `kernel` (`"legacy"` by default, or `"cycles"`, with `JS67_NATIVE_KERNEL` as environment fallback; see [FORMAT-v2.md](./FORMAT-v2.md)). Alpha cutouts are traced by stepping through transparent texels in the kernel (the acceleration structure is opaque). The `cycles` kernel reads a cutout's alpha through the same texture sampler as the shading, so the visible edge and the shaded colour agree for every wrap mode and filter. All textures share one pool of at most 1 GiB (the storage binding of the device); a larger set fails at `buildNativeInputV2` with the size and the limit in the message, and the fix is smaller maps.

The light bake uses the texel entry of the same kernel:

```js
import { buildNativeTexelInput, traceNativeTexels } from '@codepawlhq/67js-render-native';

const input = buildNativeTexelInput(traceScene, { texelCount, samples: 256, bounces: 3, seed: 1, fireflyClamp: 1e6 }, pack);
const { radiance, escaped } = traceNativeTexels(input, { count: texelCount, points, normals }, { samples: 256 });
```

`radiance` is the mean light that reaches each texel (three floats per texel) and `escaped` the share of first rays that left the scene. The agent runtime uses it for recipe bakes (`bake.backend: "native"`).

A rect area light with `portal: true` is a light portal, as in Cycles: it emits nothing and marks a window, and while the scene has one and an environment map, the `cycles` kernel draws the sky through the portals instead of over the whole map (FORMAT-v2.md, section 6). A room lit only by sky through a window then converges at the usual rate. The portal's normal (`direction`) points into the room; a shading point behind it gets no portal sample and is lit by BSDF samples alone. The `portal_count` word (byte 308) is fixed for a session, like the other record counts. Details: [docs/path-tracer.md](../../docs/path-tracer.md).

Cook's `cycles` kernel samples with Cycles' Sobol-Burley blue-noise pattern (`sampler: 'sobol-burley'`, default; `'white'` keeps the earlier hash sampler, and `'pcg'` and `'sobol'` are other names for `'white'` and `'sobol-burley'`). It picks lights through the Cycles light tree over the analytic lights, a sun and the emissive triangles (`lightSampling: 'auto'`, default: tree from more than one emitter; `'tree'`; `'uniform'` for the flat pick, and `useLightTree: true|false` is another name for `'tree'|'uniform'`). Naming an option twice with different values is an error. `envCompensation: true` (a fraction from 0 to 1 also works; off by default) subtracts the mean radiance from the environment sampling table so light sampling covers only the bright part of the map, which lowers the error under a sunny HDRI. The pixel filter is `box` unless `filterType` says otherwise. Details and measurements: [docs/cycles-parity.md](../../docs/cycles-parity.md), layout: [FORMAT-v2.md](./FORMAT-v2.md).

Four more options of the `cycles` kernel; `pathRegeneration` is on by default, the other three are off:

- `pathRegeneration` (on by default; pass `false` for the earlier order) starts a pixel's next sample as soon as a path ends instead of waiting for the longest path of the dispatch. The image is bit-identical for the same dispatch sizes and sampling time was 0.63 to 0.73 times the old order on three scenes (`lit-interior`, `glass`, `many-lights-500`; `metal` 0.91 to 0.97). The legacy kernel ignores it. `bench/cycles-parity/trace-native.mjs` takes `--no-path-regeneration`.
- `textureMips: true` (a packing option of `buildNativeInputV2`, `upgradeNativeInputV1ToV2` and the job packers; off by default) stores a mip chain after level 0 of every linearly filtered texture, float and RGBA8 alike, and the kernel reads the level a ray footprint asks for, blended between two levels, instead of always level 0. Blender Cycles reads level 0, so leave it off to match Cycles: with it off every picture is byte-identical to a build without the option. A single texture can say `mips: true` or `mips: false`. The footprint is a ray cone: the camera pixel angle, widened by 1 radian at a diffuse bounce and by twice the roughness at a glossy one, times the distance, times the UV density of the triangle. Levels cost a third more texels in the pool, which the 1 GiB check counts. The format is in `FORMAT-v2.md` section 8, the numbers in `docs/cycles-parity.md` ("Texture mip levels").
- `envCompensation: true` (or a fraction from 0 to 1) is the MIS compensation of the environment sampling table, described above. It is unbiased; it cut the error under the sunny HDRI scene by 1.4 to 2.2 times and leaves scenes without an environment unchanged.
- `denoise: 'atrous'` also filters the image on the GPU with an edge-avoiding a-trous wavelet filter (about 1.5 ms of dispatches, 8 to 14 ms in all at 960 x 540) and returns it as `denoisedRgba` next to `rgba`, plus `denoiseSeconds`, `denoiseGpuSeconds` and `denoiseCompileSeconds`. `rgba` is untouched. The filter is biased (it smooths): never compare `denoisedRgba` with a converged image as if it were unbiased. `denoiseAtrous({ width, height, rgba, albedo, normal, depth, variance })` filters any traced image the same way.

Numbers, GPU and method: [docs/cycles-parity.md](../../docs/cycles-parity.md), section "Path regeneration, environment compensation and the a-trous filter together (#897)".

## Radiance clamp (`cycles` kernel)

`clampDirect` and `clampIndirect` limit how much light one sample may add, to tame fireflies. Both are in Cycles' own unit, the value of Blender's "Clamp Direct" and "Clamp Indirect" (`sample_clamp_direct`, `sample_clamp_indirect`), and `0` (also left out, negative, or `1e29` and up) means no clamp. `clampDirect` limits light that comes straight from a light to the first surface the camera ray hits (next-event samples there, and an emitter reached by the first bounce), `clampIndirect` limits everything that arrives by two or more bounces.

`pack-input-v2.mjs` multiplies the option by 3 before it goes to the kernel (`kernel_params.clamp_direct` and `clamp_indirect`, [FORMAT-v2.md](./FORMAT-v2.md)), because the kernel compares the ceiling with the sum of the three colour channels of one contribution and scales the contribution down, keeping its colour, when the sum is above it. This follows Cycles, whose default "indirect 10" clamps at 30 ([docs/cycles-parity.md](../../docs/cycles-parity.md), settings table; the Cycles source was not re-read for this note), so the number you pass means the same in both renderers. Cook added it with the Cycles integrator (#894); it is not a safety margin and the factor does not change.

To pick a value in scene radiance units (the linear values of the picture before exposure): choose the largest *per-channel* radiance one bounce may add, and pass that. A grey contribution of `v` per channel has a channel sum of `3 v`, so it is limited exactly when `v` is above the option. A coloured contribution is limited by its channel sum, so a saturated one (all in one channel) is limited when that channel is above `3 *` the option. Clamping removes light, so the image gets darker and biased: start with `10` as Cycles does, and raise it until the fireflies come back.

## Depth of field (`cycles` kernel)

A camera with an `fStop` is a thin lens in the `cycles` kernel, with Cycles' model. `createCamera(camera, width, height)` (from `src/path-tracer.js`) adds `apertureRadius`, `focalDistance`, `apertureBlades` and `apertureRotation` to the view it returns, and `buildNativeInput` and `buildNativeInputV2` pack them; a camera without an `fStop` is a pinhole and packs the same bytes as before.

- `fStop`: the aperture radius is `focalLength / 1000 / (2 * fStop)` metres. The focal length is `focalLength` (mm), or the one that gives `fov` on a sensor `sensorWidth` mm wide (default 36) across the image.
- `focusDistance` (metres, along the view axis; default: the distance from eye to target).
- `apertureBlades` (0 for a round aperture, or 3 to 64 for a regular polygon) and `apertureRotation` (degrees, Blender's sense; `createCamera` adds half a corner step, `180 / blades` degrees, because the kernel polygon sits that far from the Cycles one).
- Lower-level: pass `apertureRadius`, `focalDistance`, `apertureBlades` or `apertureRotation` (radians) on the camera or in the pack options. Values the kernel cannot use throw a `RangeError` that names the field and what to pass.
- The legacy kernel draws a pinhole. `bench/cycles-parity/trace-native.mjs` and `render-cycles.py` take `--f-stop`, `--focus-distance`, `--aperture-blades`, `--aperture-rotation` (degrees) and `--sensor-width`, so the same camera goes to both renderers. Layout: [FORMAT-v2.md](./FORMAT-v2.md). Measurements: [docs/cycles-parity.md](../../docs/cycles-parity.md), "Depth of field (#896, slice D1)".

## Diffuse transmission (`cycles` kernel)

A part's material takes `diffuseTransmission` (0 to 1) and `diffuseTransmissionColor` (three numbers from 0 to 1; the base colour when left out) for a thin sheet that lets diffuse light through: a curtain, a leaf, a lampshade. The weight splits the diffuse layer between the usual reflecting lobe and a cosine lobe on the far side of the surface, so a lamp behind the sheet lights its front and the specular layers keep their strength. Cycles 5.3 has no such weight on the Principled BSDF; `bench/cycles-parity/render-cycles.py` builds the same split from a Principled BSDF at `(1 - weight) * colour` plus a Translucent BSDF at `weight * colour`. A material without the field packs the tables it always did; a scene that uses it adds one extension record per material to the material table ([FORMAT-v2.md](./FORMAT-v2.md), "Material extension records"). The legacy kernel, the WebGPU and WebGL tracers and the raster renderer ignore the field. Numbers: [docs/cycles-parity.md](../../docs/cycles-parity.md), "Diffuse transmission (#1058)".

## Dispatches

The Cook kernel splits a render into dispatches that each aim for about 0.5 s, sized from the time of the previous one, so a heavy scene does not run past the driver timeout and lose the device. `samplesPerDispatch` fixes the batch instead. A lost device raises an error that names the dispatch and how to lower the work per dispatch. The split is tested in `tests/dispatch.rs` (`cargo test --test dispatch`).

The split does not change the image. The `cycles` kernel carries each pixel's running sums through a dispatch and adds one sample at a time in sample order, so the float32 additions into the film come in the same order whether a dispatch draws 1 sample or 64, and two renders of the same scene, seed and settings are byte-identical even when their time-sized splits differ. The `legacy` kernel draws one sample per dispatch and adds it straight to the film, so it has the same property. `tests/native-dispatch-determinism.test.js` renders with different `samplesPerDispatch` values and compares the bytes. A fixed `samplesPerDispatch` of 1 gives the same bytes as before this change; larger batches now match it instead of adding a per-dispatch partial sum.

### Dispatch time budget (`dispatchBudgetMs`)

A 0.5 s dispatch holds the GPU queue, so on a GPU that also draws the desktop the screen stutters. `dispatchBudgetMs` (a finite number from 1 to 1000, on `traceNative` and `session.render`) cuts each frame into dispatches that cover a tile of pixels and a number of samples, sized from the measured time of the earlier dispatches so that each runs for about that long. The first dispatch is one 8 x 8 workgroup and one sample; each next one may be at most four times larger. A dispatch smaller than the image draws several samples on a tile of about 131,000 pixels where the budget allows (a tile that fills the card ends close to when the average thread does, not the slowest path), and one sample on a smaller tile where it does not. The host submits one dispatch, waits for it and only then submits the next, so other GPU users get the queue in between. `samplesPerDispatch`, when also given, caps the samples of a dispatch. Without `dispatchBudgetMs` nothing changes: the dispatches stay whole-image and about half a second long, and it is not on by default (a default for display GPUs is a separate decision).

The picture is byte-identical to the one without the option, for the same seed and samples. Pixels do not depend on each other, a tile only moves the kernel's pixel origin (`tile_origin` in `KernelParamsV2`, bytes 312 to 319, written by the host for every dispatch and zero when the frame is not tiled, so a pack that carries other bytes there cannot shift the picture; the pipeline is not rebuilt), and every pixel still takes its samples in order because all tiles of a sweep draw samples `n..n+k` before any tile draws `n+k`. That holds with `noiseThreshold` on as well: a pixel's convergence test reads only its own running sums, one sample at a time, as it does when `samplesPerDispatch` splits the samples (`tests/native-dispatch-budget.test.js` renders both). The result reports what was chosen: `dispatchCount`, `longestDispatchSeconds`, `samplesPerDispatch` (the most samples one dispatch drew) and `smallestTilePixels` / `largestTilePixels`. The planner is `TileBudgetPlanner` in `src/host/dispatch.rs`, tested in `tests/dispatch.rs`.

Measured on an RTX 3090 (not the RTX 3060 of the issue), 1920 x 1080, 64 spp, 8 bounces, a 204,802 triangle terrain with one emissive quad, a native session after a warm-up frame (`scripts/benchmark-native-dispatch-budget.mjs`):

| setting | wall s | longest dispatch | dispatches |
|---|---|---|---|
| auto (no budget) | 1.02, 1.07 | 0.48 s | 5 |
| `dispatchBudgetMs: 8` | 1.30, 1.27 | 14.6 ms | 222 |
| `dispatchBudgetMs: 4` | 1.49 | 6.8 ms | 475 |

A dispatch costs about 1 to 1.3 ms of wall time beyond its work on this box (submission, the wait, and the ramp-down at the end of a dispatch), so the smaller the budget the larger the extra: +18 to +28% at 8 ms and +46% at 4 ms against auto. A budget of 8 did not keep every dispatch under 10 ms here: the longest was 14.6 ms, because the cost of a pixel changes across the image (sky against terrain) and the next tile can cost more than the last. The desktop frame time during a render was not measured.

To pass the option from the MCP render job later, add `dispatchBudgetMs` to the options the job forwards to `traceNative` (it already validates through `validatePackOptions`); no tool schema changes here.

## Instanced scenes

`buildTraceScene(parts, environment, { instancing: true, maximumTriangles })` keeps parts that share one geometry object as instances (`maximumTriangles`, up to 4,000,000, replaces the 400,000 unique triangle bound of the CPU and WebGL tracers for a scene built for this package), and `buildNativeInputV2` packs the unique triangles once with one instance record per part, for `traceNative` with `kernel: "cycles"`. The `legacy` kernel and `buildNativeInput` refuse that input and name the fix. Render jobs on the native backend send every scene to the `cycles` kernel as FORMAT-v2 tables by default, with whole materials (see "Native job materials" in [docs/cycles-parity.md](../../docs/cycles-parity.md)). The sharing rules are in [FORMAT-v2.md](./FORMAT-v2.md), the equivalence numbers against flattened in [docs/cycles-parity.md](../../docs/cycles-parity.md), section "Instancing equivalence (#896, slice I2)".

## Sessions

`traceNative` builds everything for each call: it opens the device handle, uploads the scene, builds the acceleration structures, compiles the kernel and allocates the film. A session keeps those on the card between frames of one scene (the `cycles` kernel only):

```js
import { buildNativeInputV2, createNativeSession } from '@codepawlhq/67js-render-native';

const input = buildNativeInputV2(traceScene, camera, options, pack);
const session = createNativeSession(input, { width: 960, height: 540, samples: 64 });
const first = session.render({});                                  // uploads, builds, compiles
const moved = session.render({ kernelParams: nextCamera.kernelParams, samples: 32 }); // reuses all three
session.close();                                                    // frees the card
```

`createNativeSession(input, options)` takes a FORMAT-v2 input (it throws a `TypeError` for anything else and for `kernel: "legacy"`); `options` are defaults for every frame. `render(renderOptions)` takes what `traceNative` takes (`width`, `height`, `samples`, `samplesPerDispatch`, `maxSeconds`, `denoise`, the sampling and filter options) and returns what it returns plus four fields that tell what the frame reused: `pipelineReused` (the compiled kernel was held; the specialized kernel text did not change), `accelerationReused` (no acceleration structure build; true from the second frame on), `filmReused` (same image size, so the film and its bind group were kept; the film is cleared for each frame) and `frameIndex`. A frame that reuses something spends no time on it: the first frame reports the setup, upload and acceleration build seconds of the creation, later frames report `0` for the setup and the build.

`renderOptions.kernelParams` is the `kernelParams` of another `buildNativeInputV2` call on the same scene, which is how a frame gets another camera (or seed, bounces or filter). The seven record counts must match the session scene, or the frame throws and names the count. Changing materials, lights or instance transforms is `session.update` (below); other changes to the scene need a new session.

**Camera only (a film of a static scene).** `render({ camera, seed })` sends only the camera: pass the camera object that `buildNativeInputV2` takes (built with `createCamera(view, width, height)` for the frame's size, thin lens included) and the session writes it into its own `kernelParams`, with no scene packing per frame:

```js
for (let frame = 0; frame < frameCount; frame++) {
  const camera = createCamera({ eye: path(frame), target, fov: 40, fStop: 4, focusDistance: 6 }, 480, 270);
  const picture = session.render({ width: 480, height: 270, samples: 32, camera });
}
```

The same work is exported as `packCameraParams(kernelParams, camera, options)`, which returns a new 320 byte block from `input.kernelParams` with only the camera words (bytes 112 to 191), the orthographic bit of `kernel_flags` and, when `options.seed` is given, the seed word replaced. It uses the packer's own camera code, so it follows the layout when that moves; do not copy bytes by hand. For each of `near`, `far`, `lensShift`, `orthographic` and the thin lens fields (`apertureRadius`, `focalDistance`, `apertureBlades`, `apertureRotation`), a value the caller gives (in `options`, or on the camera object, in the order `buildNativeInputV2` uses) wins; a field that is on neither keeps the value the block was packed with, whether it came from the first camera or from pack options. A bare view camera therefore keeps the block's near and far planes, sensor shift, lens and orthographic bit, and a camera with an `fStop` replaces the lens. The result equals a full `buildNativeInputV2` with that camera and the same pack options. It throws when the block is not FORMAT-v2, when the camera's width to height ratio is not the image's (a camera built for another size would stretch the picture), and for a `seed` that is not a whole number from 0 to 4294967295. `render` checks the camera against the size of the frame.

`seed` is a frame option: `render({ seed })` writes the seed into the block the frame uses, so two seeds give two noise patterns and one seed repeats its picture. Without a `seed` in the `render` call the block keeps the seed it was packed with (`0` unless `buildNativeInputV2` got one). A `seed` in the session `options` is not applied: it is normally the pack options' seed, which the input already carries, and it would override the seed of a `kernelParams` block passed to a frame. Before this option a `seed` passed to `render` or `traceNative` with a packed v2 input was ignored, because the seed is a pack-time word of the input; `traceNative` still works that way, so pack the seed with the input there. `camera` and `seed` apply on top of `renderOptions.kernelParams` when that is given too.

A frame may change these words of the 320 byte block: the camera, lens, aperture and sensor shift (bytes 112 to 191), `seed`, the bounce limits, clamps, filter, adaptive sampling, `film_exposure`, `filter_glossy`, the environment rotation and colour (204, 208), the camera environment strength (304), the fog fields (224 to 267) and `kernel_flags`. Fog and the kernel flags select kernel variants, so such a frame recompiles (`pipelineReused` is false). The other words describe data the session uploaded or compiled for, and a frame that changes one throws and names it: the seven record counts (84 to 108), `env_width`, `env_height`, `env_cdf_offset`, `env_total_weight` (192, 196, 200, 220), `emissive_total_weight`, `analytic_light_total_weight` (268, 272), `ies_table_offset` (284), `background_mis_weight` (292) and `sobol_table_offset` (296). A frame with another HDRI, or one where the session had none, needs a new session. A frame that fails leaves the creation costs for the next frame that succeeds, which then reports them.

A frame is byte-identical to the `traceNative` render of the same input and options: `traceNative` runs a session that renders once. `render` after `close()` throws, and so does a frame on a session whose device was lost; the error says to create a new session. A plain frame clears the film and starts at sample 0.

A render job of many frames (`scripts/agent-native-sequence.mjs`) keeps one session for its frames: the same tables render with the frame's `kernelParams`, changed values go through `update`, and a refused or failed update, or a render the session cannot do, falls back to a new session or a one-shot trace for that frame. The job report names the route of each frame.

### Progressive film

`render({ samples: 16, accumulate: true, targetSamples: 64 })` adds its samples to the film instead of starting an image, so one image can grow over several calls and be read at any point:

```js
const first = session.render({ samples: 16, accumulate: true, targetSamples: 64 }); // samples 0 to 15 of a 64 sample image
const second = session.render({ samples: 48, accumulate: true });                  // samples 16 to 63, onto the same film
const preview = session.resolve({ denoise: 'atrous' });                           // the film as it stands, nothing traced
session.reset();                                                                    // clears the film; the next accumulate call starts a new image
```

`targetSamples` is the total the image will hold. It is the length of each pixel's section of the sample sequence, so the calls must agree on it: the first call of an image sets it, later calls leave it out (or repeat it) and are refused if they would pass it. With it, the film after any split of the samples into calls (2, 3 or uneven) is byte-identical to one `traceNative` render of `targetSamples` samples, for both samplers, with `pathRegeneration` on or off and with any `samplesPerDispatch`: the kernel adds one sample at a time in sample order into the pixel's running sums (see the section above), so where a call or a dispatch ends changes nothing. The result carries `firstSample` (where this call began), `filmSamples` (what the film holds after it) and `targetSamples` (`null` for a plain frame). `resolve({ denoise })` returns the same fields as a render (`rgba`, `depth`, `albedo`, `normal`, `variance`, `denoisedRgba` for `denoise: "atrous"`) for what the film holds; it compiles, builds and draws nothing, and it throws when the film holds no samples.

A call must keep the image size and every render setting of the call that began the image (camera, seed, sampler, bounces and the rest of `kernelParams`); one that does not is refused with the way out (`reset()`, or a plain frame), and so is one that asks for more samples than `targetSamples` leaves. A refused call leaves the film as it was. A call that fails while drawing (a `maxSeconds` limit, a lost device) ends the image, since the film then holds an unknown number of samples: `resolve()` throws, and the next accumulating call starts a new image and needs `targetSamples` again. `maxSeconds` counts the seconds of one call.

### Updating the scene

`session.update(newInput)` takes a FORMAT-v2 input packed from the same scene after a change of values and applies it to the card without compiling a pipeline or building a BLAS:

| Changed in `newInput` | Applied as |
| --- | --- |
| camera, seed and other render settings (`kernelParams`) | the new block becomes the session default |
| `materials` (colour, roughness, emission strength and the other values) | the table's buffer is replaced |
| `lights`, `emissiveTriangles`, `lightTreeNodes`, `lightTreeEmitters`, `lightToTree` | the table's buffers are replaced, with the selection weights of `kernelParams` (bytes 268, 272, 292) |
| instance transforms and ray visibility | the instance table is replaced and the TLAS is rebuilt over the kept BLAS |
| instance material overrides, colours, light linking | the instance table is replaced, no TLAS rebuild |

The pinned wgpu has no TLAS refit (`PreferUpdate` is accepted and rebuilds), so a rebuild is the cost of moving an instance; the BLAS, which hold the triangles, are never touched. `update` returns `uploadedTables`, `accelerationRebuilt`, `changedInstances`, `kernelRespecialized` (the new tables change which features the kernel text is specialized for, for example the first transmissive material, so the next render compiles) and the seconds. It clears the film, ends a progressive image, and the next frame equals the `traceNative` render of `newInput` byte for byte. The next frame reports `accelerationReused: true`, and `pipelineReused: false` only when `kernelRespecialized` was true.

An update that changes a record count (instances, triangles, materials, emissive triangles, lights, light tree nodes, textures), the geometry, the textures, the environment map or which mesh an instance places is refused before anything changes, with an error that names what differs and says to create a new session. Moving an emissive instance means the input carries new `emissiveTriangles` and light tree tables for it, which the update applies like any other table. If the card fails part way through an applied update, the film is cleared and the session is closed (the error says so), so it never renders a half updated scene.

A frame may change these words of the 320 byte block: the camera, lens, aperture and sensor shift (bytes 112 to 191), `seed`, the bounce limits, clamps, filter, adaptive sampling, `film_exposure`, `filter_glossy`, the environment rotation and colour (204, 208), the camera environment strength (304), the fog fields (224 to 267) and `kernel_flags`. The scene-bound words stay with the session (above), until an update brings new selection weights.
