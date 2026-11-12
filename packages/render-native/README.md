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

`rgba` is linear float RGBA, rows from the top, averaged over the samples. `albedo` and `normal` (three floats per pixel, normalise the normal), `depth` and `variance` (one float) are the first-hit features the wavelet and OIDN denoisers read. `pack-input.mjs` holds `buildNativeInput` without Node imports, so the job page packs the scene itself. `bench/native-tracer` compares it with the browser kernel.

Fog (`scene.volume`), subsurface scattering and `options.noiseThreshold` (the CPU tracer's stop rule: converged pixels draw no more samples, `averageSamples` in the result is the mean drawn) are in the kernel. `traceNative` also takes `maxSeconds` (stopping with an error once the trace has run that long) and `kernel` (`"legacy"` by default, or `"cycles"`, with `JS67_NATIVE_KERNEL` as environment fallback; see [FORMAT-v2.md](./FORMAT-v2.md)). Alpha cutouts are traced by stepping through transparent texels in the kernel (the acceleration structure is opaque). The `cycles` kernel reads a cutout's alpha through the same texture sampler as the shading, so the visible edge and the shaded colour agree for every wrap mode and filter. All textures share one pool of at most 1 GiB (the storage binding of the device); a larger set fails at `buildNativeInputV2` with the size and the limit in the message, and the fix is smaller maps.

The light bake uses the texel entry of the same kernel:

```js
import { buildNativeTexelInput, traceNativeTexels } from '@codepawlhq/67js-render-native';

const input = buildNativeTexelInput(traceScene, { texelCount, samples: 256, bounces: 3, seed: 1, fireflyClamp: 1e6 }, pack);
const { radiance, escaped } = traceNativeTexels(input, { count: texelCount, points, normals }, { samples: 256 });
```

`radiance` is the mean light that reaches each texel (three floats per texel) and `escaped` the share of first rays that left the scene. The agent runtime uses it for recipe bakes (`bake.backend: "native"`).

Cook's `cycles` kernel samples with Cycles' Sobol-Burley blue-noise pattern (`sampler: 'sobol-burley'`, default; `'white'` keeps the earlier hash sampler, and `'pcg'` and `'sobol'` are other names for `'white'` and `'sobol-burley'`). It picks lights through the Cycles light tree over the analytic lights, a sun and the emissive triangles (`lightSampling: 'auto'`, default: tree from more than one emitter; `'tree'`; `'uniform'` for the flat pick, and `useLightTree: true|false` is another name for `'tree'|'uniform'`). Naming an option twice with different values is an error. `envCompensation: true` (a fraction from 0 to 1 also works; off by default) subtracts the mean radiance from the environment sampling table so light sampling covers only the bright part of the map, which lowers the error under a sunny HDRI. The pixel filter is `box` unless `filterType` says otherwise. Details and measurements: [docs/cycles-parity.md](../../docs/cycles-parity.md), layout: [FORMAT-v2.md](./FORMAT-v2.md).

Three more options of the `cycles` kernel; `pathRegeneration` is on by default, the other two are off:

- `pathRegeneration` (on by default; pass `false` for the earlier order) starts a pixel's next sample as soon as a path ends instead of waiting for the longest path of the dispatch. The image is bit-identical for the same dispatch sizes and sampling time was 0.63 to 0.73 times the old order on three scenes (`lit-interior`, `glass`, `many-lights-500`; `metal` 0.91 to 0.97). The legacy kernel ignores it. `bench/cycles-parity/trace-native.mjs` takes `--no-path-regeneration`.
- `envCompensation: true` (or a fraction from 0 to 1) is the MIS compensation of the environment sampling table, described above. It is unbiased; it cut the error under the sunny HDRI scene by 1.4 to 2.2 times and leaves scenes without an environment unchanged.
- `denoise: 'atrous'` also filters the image on the GPU with an edge-avoiding a-trous wavelet filter (about 1.5 ms of dispatches, 8 to 14 ms in all at 960 x 540) and returns it as `denoisedRgba` next to `rgba`, plus `denoiseSeconds`, `denoiseGpuSeconds` and `denoiseCompileSeconds`. `rgba` is untouched. The filter is biased (it smooths): never compare `denoisedRgba` with a converged image as if it were unbiased. `denoiseAtrous({ width, height, rgba, albedo, normal, depth, variance })` filters any traced image the same way.

Numbers, GPU and method: [docs/cycles-parity.md](../../docs/cycles-parity.md), section "Path regeneration, environment compensation and the a-trous filter together (#897)".

## Dispatches

The Cook kernel splits a render into dispatches that each aim for about 0.5 s, sized from the time of the previous one, so a heavy scene does not run past the driver timeout and lose the device. `samplesPerDispatch` fixes the batch instead. A lost device raises an error that names the dispatch and how to lower the work per dispatch. The split is tested in `tests/dispatch.rs` (`cargo test --test dispatch`).

The split does not change the image. The `cycles` kernel carries each pixel's running sums through a dispatch and adds one sample at a time in sample order, so the float32 additions into the film come in the same order whether a dispatch draws 1 sample or 64, and two renders of the same scene, seed and settings are byte-identical even when their time-sized splits differ. The `legacy` kernel draws one sample per dispatch and adds it straight to the film, so it has the same property. `tests/native-dispatch-determinism.test.js` renders with different `samplesPerDispatch` values and compares the bytes. A fixed `samplesPerDispatch` of 1 gives the same bytes as before this change; larger batches now match it instead of adding a per-dispatch partial sum.

## Instanced scenes

`buildTraceScene(parts, environment, { instancing: true })` keeps parts that share one geometry object as instances, and `buildNativeInputV2` packs the unique triangles once with one instance record per part, for `traceNative` with `kernel: "cycles"`. The `legacy` kernel and `buildNativeInput` refuse that input and name the fix. Render jobs on the native backend send every scene to the `cycles` kernel as FORMAT-v2 tables by default, with whole materials (see "Native job materials" in [docs/cycles-parity.md](../../docs/cycles-parity.md)). The sharing rules are in [FORMAT-v2.md](./FORMAT-v2.md), the equivalence numbers against flattened in [docs/cycles-parity.md](../../docs/cycles-parity.md), section "Instancing equivalence (#896, slice I2)".

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

A frame may change these words of the 320 byte block: the camera, lens, aperture and sensor shift (bytes 112 to 191), `seed`, the bounce limits, clamps, filter, adaptive sampling, `film_exposure`, `filter_glossy`, the environment rotation and colour (204, 208), the fog fields (224 to 267) and `kernel_flags`. Fog and the kernel flags select kernel variants, so such a frame recompiles (`pipelineReused` is false). The other words describe data the session uploaded or compiled for, and a frame that changes one throws and names it: the seven record counts (84 to 108), `env_width`, `env_height`, `env_cdf_offset`, `env_total_weight` (192, 196, 200, 220), `emissive_total_weight`, `analytic_light_total_weight` (268, 272), `ies_table_offset` (284), `background_mis_weight` (292) and `sobol_table_offset` (296). A frame with another HDRI, or one where the session had none, needs a new session. A frame that fails leaves the creation costs for the next frame that succeeds, which then reports them.

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

A frame may change these words of the 320 byte block: the camera, lens, aperture and sensor shift (bytes 112 to 191), `seed`, the bounce limits, clamps, filter, adaptive sampling, `film_exposure`, `filter_glossy`, the environment rotation and colour (204, 208), the fog fields (224 to 267) and `kernel_flags`. The scene-bound words stay with the session (above), until an update brings new selection weights.
