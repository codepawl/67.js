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
