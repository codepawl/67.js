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

`rgba` is linear float RGBA, rows from the top, averaged over the samples. `albedo` and `normal` (three floats per pixel, normalise the normal), `depth` and `variance` (one float) are the first-hit features the wavelet and OIDN denoisers read. `pack-input.mjs` holds `buildNativeInput` without Node imports, so the job page packs the scene itself. `bench/native-tracer` compares it with the browser kernel.

Fog (`scene.volume`), subsurface scattering and `options.noiseThreshold` (the CPU tracer's stop rule: converged pixels draw no more samples, `averageSamples` in the result is the mean drawn) are in the kernel. `traceNative` also takes `maxSeconds` (stopping with an error once the trace has run that long) and `kernel` (`"legacy"` by default, or `"cycles"`, with `JS67_NATIVE_KERNEL` as environment fallback; see [FORMAT-v2.md](./FORMAT-v2.md)). Alpha cutouts are traced by stepping through transparent texels in the kernel (the acceleration structure is opaque).

The light bake uses the texel entry of the same kernel:

```js
import { buildNativeTexelInput, traceNativeTexels } from '@codepawlhq/67js-render-native';

const input = buildNativeTexelInput(traceScene, { texelCount, samples: 256, bounces: 3, seed: 1, fireflyClamp: 1e6 }, pack);
const { radiance, escaped } = traceNativeTexels(input, { count: texelCount, points, normals }, { samples: 256 });
```

`radiance` is the mean light that reaches each texel (three floats per texel) and `escaped` the share of first rays that left the scene. The agent runtime uses it for recipe bakes (`bake.backend: "native"`).

Cook's `cycles` kernel samples with Cycles' Sobol-Burley blue-noise pattern (`sampler: 'sobol-burley'`, default; `'white'` keeps the earlier hash sampler, and `'pcg'` and `'sobol'` are other names for `'white'` and `'sobol-burley'`). It picks lights through the Cycles light tree over the analytic lights, a sun and the emissive triangles (`lightSampling: 'auto'`, default: tree from more than one emitter; `'tree'`; `'uniform'` for the flat pick, and `useLightTree: true|false` is another name for `'tree'|'uniform'`). Naming an option twice with different values is an error. `envCompensation: true` (a fraction from 0 to 1 also works; off by default) subtracts the mean radiance from the environment sampling table so light sampling covers only the bright part of the map, which lowers the error under a sunny HDRI. The pixel filter is `box` unless `filterType` says otherwise. Details and measurements: [docs/cycles-parity.md](../../docs/cycles-parity.md), layout: [FORMAT-v2.md](./FORMAT-v2.md).

Three more options of the `cycles` kernel are off by default:

- `pathRegeneration: true` starts a pixel's next sample as soon as a path ends instead of waiting for the longest path of the dispatch. The image is bit-identical for the same dispatch sizes and sampling time was 0.63 to 0.73 times the default on three scenes (`lit-interior`, `glass`, `many-lights-500`; `metal` 0.91 to 0.97).
- `envCompensation: true` (or a fraction from 0 to 1) is the MIS compensation of the environment sampling table, described above. It is unbiased; it cut the error under the sunny HDRI scene by 1.4 to 2.2 times and leaves scenes without an environment unchanged.
- `denoise: 'atrous'` also filters the image on the GPU with an edge-avoiding a-trous wavelet filter (about 1.5 ms of dispatches, 8 to 14 ms in all at 960 x 540) and returns it as `denoisedRgba` next to `rgba`, plus `denoiseSeconds`, `denoiseGpuSeconds` and `denoiseCompileSeconds`. `rgba` is untouched. The filter is biased (it smooths): never compare `denoisedRgba` with a converged image as if it were unbiased. `denoiseAtrous({ width, height, rgba, albedo, normal, depth, variance })` filters any traced image the same way.

Numbers, GPU and method: [docs/cycles-parity.md](../../docs/cycles-parity.md), section "Path regeneration, environment compensation and the a-trous filter together (#897)".

## Dispatches

The Cook kernel splits a render into dispatches that each aim for about 0.5 s, sized from the time of the previous one, so a heavy scene does not run past the driver timeout and lose the device. `samplesPerDispatch` fixes the batch instead. A lost device raises an error that names the dispatch and how to lower the work per dispatch. The split is tested in `tests/dispatch.rs` (`cargo test --test dispatch`).

The split does not change the image. The `cycles` kernel carries each pixel's running sums through a dispatch and adds one sample at a time in sample order, so the float32 additions into the film come in the same order whether a dispatch draws 1 sample or 64, and two renders of the same scene, seed and settings are byte-identical even when their time-sized splits differ. The `legacy` kernel draws one sample per dispatch and adds it straight to the film, so it has the same property. `tests/native-dispatch-determinism.test.js` renders with different `samplesPerDispatch` values and compares the bytes. A fixed `samplesPerDispatch` of 1 gives the same bytes as before this change; larger batches now match it instead of adding a per-dispatch partial sum.

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

`renderOptions.kernelParams` is the `kernelParams` of another `buildNativeInputV2` call on the same scene, which is how a frame gets another camera (or seed, bounces or filter). The seven record counts must match the session scene, or the frame throws and names the count. Changing the scene itself (geometry, materials, lights) needs a new session.

A frame may change these words of the 320 byte block: the camera, lens, aperture and sensor shift (bytes 112 to 191), `seed`, the bounce limits, clamps, filter, adaptive sampling, `film_exposure`, `filter_glossy`, the environment rotation and colour (204, 208), the fog fields (224 to 267) and `kernel_flags`. Fog and the kernel flags select kernel variants, so such a frame recompiles (`pipelineReused` is false). The other words describe data the session uploaded or compiled for, and a frame that changes one throws and names it: the seven record counts (84 to 108), `env_width`, `env_height`, `env_cdf_offset`, `env_total_weight` (192, 196, 200, 220), `emissive_total_weight`, `analytic_light_total_weight` (268, 272), `ies_table_offset` (284), `background_mis_weight` (292) and `sobol_table_offset` (296). A frame with another HDRI, or one where the session had none, needs a new session. A frame that fails leaves the creation costs for the next frame that succeeds, which then reports them.

A frame may change these words of the 320 byte block and no others of the scene: the camera, lens, aperture and sensor shift (bytes 112 to 191), , the bounce limits, clamps, filter, adaptive sampling, , , the environment rotation and colour (204, 208), the fog fields (224 to 267) and . Fog and the kernel flags select kernel variants, so such a frame recompiles ( is false). These words describe data the session uploaded or compiled for, and a frame that changes one throws and names it: the seven record counts (84 to 108), , , ,  (192, 196, 200, 220), ,  (268, 272), ,  (284, 296) and  (292). A frame with another HDRI, or with one where the session had none, therefore needs a new session. A frame that fails leaves the creation costs for the next frame that succeeds, which then reports them.

A frame is byte-identical to the `traceNative` render of the same input and options: `traceNative` runs a session that renders once. `render` after `close()` throws, and so does a frame on a session whose device was lost; the error says to create a new session. The film does not carry samples from one frame to the next, and nothing in the scene can be updated in place yet.
