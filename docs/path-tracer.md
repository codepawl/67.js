# Cook (path tracer)

**Cook** (`67js/addons/path-tracer`) is the 67js offline path tracer (a nod to both the Cook-Torrance microfacet BSDF and *"let it cook"*). Alongside `Glaze` (`Renderer67`) for real-time WebGL2, `Cook` draws one still by following light paths on the CPU or GPU. It loads only when a render job asks for it, so a normal scene pays nothing (issue #57).

```js
import { Cook, renderPathTracedImage } from '67js/addons/path-tracer';

const { rgba, linear, report } = await renderPathTracedImage(
  { parts, environment, camera },        // the same objects the rasterizer takes
  { width: 960, height: 540, samples: 64, bounces: 8, seed: 0, denoise: true, threads: 4, maxSeconds: 300, noiseThreshold: 0 },
);
```

From an agent, submit an `image` render job with `settings.renderer` (see [render jobs](agent-render-jobs.md#path-tracer)).

## What it draws

Unidirectional path tracing against the triangle BVH that the [light bake](light-bake.md) uses, with next-event estimation and the environment map drawn by importance, then a wavelet denoiser. The first hit of every path samples every light. Later hits draw one light at random and divide by its chance, so the average is the same and a scene with eleven lights costs one shadow ray per bounce instead of eleven.

- Surfaces: diffuse, GGX specular with metals, clear coat, glass (`transmission`, `ior`, rough glass), emission, image maps (`map`, with `alphaMode: "mask"` cutouts, `normalMap` with `normalScale`, and `metallicRoughnessMap`, whose green channel scales roughness and blue scales metallic as in the rasterizer; box-projected materials read all of them through the UVs of their projection, the same ones the glTF export writes) and vertex colour. Skinned parts are drawn at their current pose.
- Lights: the sun (`keyColor`, `lightDirection`, as a 1 degree disk), point lights with a radius, spot lights with a soft cone, rectangular area lights, and the environment map with its rotation. All of them cast soft shadows, whatever their `castShadow` says, as in Cycles. Light linking is honoured: a light with `affects` (or the sun with `environment.keyAffects`) adds nothing at a part it skips, as a direct light or as a bounce source, and still shadows the other lights.
- Light that bounces between surfaces, and the sky seen in mirrors and through glass.
- Emission: `emission` times `emissiveColor` (the base colour when none is given) times the `emissiveMap` texel at the hit, so a screen or a sign glows with its picture and lights what is near it. An emissive surface is found by the paths that hit it, not sampled as a light, so a small bright panel is noisy at low sample counts.
- Volume fog: `environment.volumeFog` is traced as a homogeneous medium inside its box, with its `density`, `color` (the scattering albedo), `anisotropy` (Henyey-Greenstein) and `maxDistance`. The distance to each scattering event is drawn from the exact free-flight distribution, so there is no step count and no banding. Every event is lit by next-event estimation (sun, point, spot, area lights and the sky, with shadow rays) and light reaching a surface through the fog is dimmed by it. Fog events count as bounces. `noiseAmount`, `noiseScale`, `drift`, `steps` and the `ambient` glow are rasterizer tricks and are not used.

## Subsurface

A part with a material `subsurface` weight above 0 sends that share of its diffuse light through a bounded random walk, after the Random Walk model of Blender's Principled BSDF (issue #283). The walk starts inward from the hit with a cosine-weighted direction, scatters isotropically with a per-channel mean free path of radius times scale in metres (one channel draws the distance and the other two are weighted by the mean density, so every channel stays unbiased), and leaves where it meets the part's own surface; there the path continues as white diffuse light with the walk's throughput, lit by every light. The colour is the block's `color`, or the base colour, mapped to a single scattering albedo with the fit Cycles uses, so a colour of 1 gives an albedo of 1 and gains no energy. A walk ends after 32 scattering events (`SUBSURFACE_WALK_STEPS`) or when it meets another part, and then its path ends. A point with no surface of its own behind it is a card: half of the colour is reflected on the near side and half is transmitted through it. The specular lobe and clear coat stay as they are, and a weight of 0 takes the unchanged code path (the same samples and pixels). The GPU tracer traces the block too (`src/path-tracer-gpu-subsurface.js`): the walk is compiled into its kernel only for a scene with a part above weight 0, the block sits in its own table of two texels per material, and a scene without one compiles and draws the kernel it always did (foliage and glass drawn by the kernel before and after this change are byte identical). On the `subsurface` reference scene (960 by 540, 64 samples, FLIP against the Cycles render with subsurface on) the GPU tracer scores 0.0795 with weight 1 and 0.0876 with weight 0, the CPU tracer 0.0795 and 0.0875, and GPU against CPU is 0.0029 and 0.0014 (measured 2026-11-04). The kernel with the walk compiled in cold in 42.8 s against 7.2 s for the plain one, since a second place that traces rays is inlined again.

## What it does not draw

`report.ignored` lists the ones this scene asks for; a render job returns it as `metrics.pathTracer.ignored`. It names occlusion maps, anisotropy, iridescence, sheen, moss, splat layers, baked `lightMap`s, tagged materials (foliage, liquid, water and the like, traced as plain surfaces), blended transparency, and the fog fields above.

- The procedural sky when there is no environment map (the sky is black).
- Occlusion maps. Normal and metallic-roughness maps are drawn on UV-mapped and on box-projected materials. Material graphs and patterns are drawn through the colour map they bake.
- Translucent leaves without a `subsurface` block (foliage looks darker than in the rasterizer), liquids, foam and blended transparency (traced as plain or opaque surfaces).
- Lights seen in mirrors (area lights and spot lights are lit but not visible), caustics, motion blur, depth of field, bloom and colour grade.
- Multiple-scattering GGX: rough metal is a little darker than in Blender.

## Limits

| Option | Default | Range | Meaning |
| --- | --- | --- | --- |
| `width`, `height` | 960, 540 | 16 to 4096 | Output size, at most 2,073,600 pixels. |
| `samples` | 64 | 1 to 1024 | Paths per pixel. Every pixel draws all of them unless `noiseThreshold` is above 0. |
| `bounces` | 8 | 1 to 16 | Reflections followed by each path. |
| `seed` | 0 | 0 to 2147483647 | Changes the noise. |
| `threads` | 4 | 1 to 8 | Module workers; the pixels are the same for any count. Without `Worker` it runs on one thread. |
| `noiseThreshold` | 0 | 0 to 1 (render jobs: 0 to 0.1) | 0 draws every sample. Above 0, a pixel stops once the standard error of its mean luminance, relative to that mean plus 0.05, is under this, checked from 16 samples on and after every 8 more. It costs quality on some scenes (see the table below). It reads only the pixel's own samples, so the result is the same on any thread count and band split. `report.averageSamples` says how many paths a pixel took. |
| `maxSeconds` | 300 | 1 to 1800 | Wall-clock limit. Passing it throws; there is never a partial image. |
| `denoise` | true | boolean, `"wavelet"`, `"oidn"`, `"none"` | `true` or `"wavelet"` filters the light with normal, depth and noise guides; `false` or `"none"` does not filter. `"oidn"` is [Open Image Denoise](#open-image-denoise-optional): a render job with it defaults to 16 samples. |
| `backend` | `cpu` | `cpu`, `gpu`, `webgpu` | `gpu` traces in a WebGL2 shader, `webgpu` in WGSL compute (see Choosing a backend). |
| `fireflyClamp` | 20 | 1 to 1000 | Largest radiance one bounce may add to a sample. |

Also checked before any ray is traced: samples times pixels times bounces at most 4 billion, 400,000 triangles, 1,024 parts, 32 lights, and finite numbers and in-range indices in every part. A render job limits `maxSeconds` to 600: the job runs on workers without blocking the page, and its deadline is `maxSeconds` plus 60 seconds for the page and the PNG, so a trace that reaches its limit still ends before the job does.

The same scene and options give the same bytes. Random numbers come from a hash of the pixel, the sample and the seed, never from `Math.random` or the clock, and a pixel does not depend on which thread drew it.

## Choosing a backend

`backend: 'cpu'` (the default) is the reference: it reuses `src/triangle-bvh.js` and `src/ray-query.js`, runs on workers in the job page next to the scene, needs no GPU, and gives the same bytes for the same scene and options. It measured 25 to 238 seconds for a 960 by 540 still at 32 samples on a Ryzen 5 5600X with four threads, while another session also loaded the machine (table in `bench/reference/README.md`).

`backend: 'gpu'` (issue #302) runs the same algorithm in a WebGL2 fragment shader (`src/path-tracer-gpu.js`, loaded only for this backend, so a CPU render and the core bundle do not carry it). The BVH, triangles, materials, maps, lights and the environment table are packed into float textures (`src/path-tracer-gpu-pack.js`), the random numbers are the same integer hash and PCG stream as the CPU tracer and are drawn in the same order, and each sample adds into four float targets (colour and depth, albedo, normal, luminance and its square) that feed the same denoiser. Float32 maths and a 24-bit random value make the pixels differ a little from the CPU tracer: FLIP (LDR) of GPU against CPU at the same seed was 0.0001 to 0.0018 on the 16 path tracer reference scenes at 480 by 270 and 32 samples. It needs a page with WebGL2, `EXT_color_buffer_float` and `EXT_float_blend`, and throws without them, so choose it only where those exist. It traces everything the CPU tracer does (lights with linking, all materials and maps including emissive maps, glass, volume fog, the sky); it does not use `noiseThreshold` (every pixel draws every sample) or `threads`, and a sample that produced a NaN or an infinity counts as black. The first still of a page compiles the kernel (13 to 30 s), later ones reuse it.

The 1920 by 1080 still of the demo room at 64 samples took 58.15 s on the GPU (RTX 3060, clean image, including 10.3 s of compiling with a warm shader cache, the BVH build and the denoiser; a cold compile measured 30 s on an earlier version of the kernel, which would have put it over 60 s; remeasured 2026-11-04 below) against 585.9 s on the CPU tracer (measured 2026-11-03; remeasured 2026-11-04 at 38.7 s for a first compile of a kernel text the driver had not seen, 7.0 s of it compiling, and 41.0 s for the same kernel again, 7.3 s compiling, each in a fresh headless Chrome profile, so the 60 s bound holds cold: the compile no longer differs between cold and warm on this machine, and `gpuCompileSeconds` in the job report records it; a scene with a subsurface part compiles a larger kernel, 42.8 s cold in the same setup, which adds that to its still; see [the WebGPU decision](webgpu-decision.md) for the choice of WebGL2 over WebGPU). Against Cycles (FLIP, 960 by 540, 64 samples, 16 scenes, `bench/reference/path-tracer.json` for the CPU and `path-tracer-gpu.json` for the GPU), the two backends scored within 0.0002 of each other on every scene (largest gap 0.0001 to 0.0002 on `foliage`, `glass`, `character`), so each keeps its score within the 0.005 bound (measured 2026-11-04). The GPU run took 4 to 13 s per scene after the first scene's compile. `node bench/reference/gpu-compare.mjs <directory> <scene or recipe.json> --backend both` draws a scene with both backends, and `bench/reference/flip-compare.py` scores them against each other and against Cycles. A render job selects it with `settings.renderer.backend: "gpu"` (see `docs/agent-render-jobs.md`); the job default stays `cpu`.

`backend: 'webgpu'` (issue #625) runs the same algorithm as WGSL compute (`src/path-tracer-webgpu.js` and `src/path-tracer-webgpu-kernel.js`, loaded only for this backend). It takes the same packed scene tables as storage buffers, draws the same random numbers in the same order and returns the same buffers, so the denoiser and tone mapping are unchanged. It needs `navigator.gpu` and an adapter with 10 storage buffers per shader stage; without them it throws an error that names `gpu` and `cpu` (the MCP `cpu` runtime has no WebGPU). It does not trace volume fog or subsurface scattering yet: a scene that uses either throws an error that names it, so call it with `backend: 'gpu'` instead. Measured on the RTX 3060 (2026-11-09, `docs/webgpu-decision.md`): the kernel compiles in 0.5 s cold against 29 s for the WebGL2 kernel, the demo room at 1920 by 1080 and 64 samples traces in 8.0 to 8.5 s against 15.2 s (three alternating runs), and FLIP against the WebGL2 backend is 0.0000 to 0.0019 on 15 of the 16 reference scenes (the sixteenth, `fog`, is not supported). The default kernel is a megakernel; a wavefront kernel (generate, extend, shade, shadow, with optional sorting by material) is built and was slower on this scene (17.3 to 18.1 s), so it is opt-in through `traceOnWebGpu` only. The default backend stays `cpu`.

## Speed

Where the time went on the 181,708 triangle demo room (issue #129; one thread, CPU time, 640 by 360 band, measured while another session loaded the machine):

| Step | Paths per second per thread |
| --- | --- |
| Before: generic BVH visitor, every light traced at every bounce | 8,360 (7,955 and 8,576 in two runs) |
| Typed-stack ray query, same pixels bit for bit | 9,756 (1.2 times) |
| One light drawn at random past the first hit (11 light sources) | 23,300 (2.4 times more, 2.8 in all) |

Adaptive sampling, a shadow-ray shortcut and the demo-room still (issue #129, second pass; same 181,708 triangle room, one thread, 160 by 90, seed 7, error is the RMSE of the 8-bit image against a 256 sample render of seed 0, on an idle machine):

| Step | Seconds | Average samples | Error |
| --- | --- | --- | --- |
| 64 samples, every pixel | 25.9 | 64 | 4.38 |
| Same, shadow rays skip the surface lookup unless the material is a cutout | 21.0 and 19.1 (1.23 to 1.36 times) | 64 | 4.38, pixels unchanged |
| 24 samples, every pixel | 9.5 | 24 | 5.53 |
| `noiseThreshold` 0.05 | 11.3 | 26.1 | 4.87 |
| `noiseThreshold` 0.03 | 14.1 | 34.4 | 4.77 |
| One light drawn at random at the first hit too | 12.9 | 64 | 7.26 |

Adaptive sampling beats fewer samples at the same cost on this room (4.87 at 11.3 s against 5.53 at 9.5 s), but it is off by default because it costs score against Cycles on other scenes, and quality is why the tracer exists. Score against Cycles (FLIP, lower is better), 64 samples at most, four threads, 960 by 540:

| Scene | `noiseThreshold` | Score | Seconds |
| --- | --- | --- | --- |
| `spot-area` | 0 (default) | 0.0658 | 37.1 |
| `spot-area` | 0.008 | 0.0748 | 31.3 |
| `spot-area` | 0.015 | 0.0847 | 25.1 |
| `spot-area` | 0.03 | 0.0900 | 21.3 |
| `lit-interior` | 0.03 | 0.2214 | 106.7 |

`lit-interior` scored 0.1993 at 32 samples before adaptive sampling; it was not re-run with every sample at 64. A render job passes the value as `settings.renderer.noiseThreshold`, 0 to 0.1.

Fewer samples with the denoiser lose little on some scenes: 24 samples scored within 0.005 of 64 on `brick-graph` (0.1394 against 0.1370) and `character` (0.1164 against 0.1116), at about 45 percent of the time. Two scenes are not proof for all. Drawing one light at the first hit halves the time but makes the image noisier than 24 samples cost, so it was not kept.

The 1920 by 1080 still of `tests/fixtures/demo-room.recipe.json` at `samples: 64`, through an MCP image job with 8 threads: 246.4 s in the tracer (229.4 s tracing, the rest the filter), 30.7 samples per pixel on average, 257 s for the whole job (measured, once, with `noiseThreshold` 0.03, the setting at that time). With the default of 0 every pixel draws all 64, so the same still takes 585.9 s in the tracer and 596.1 s for the job (measured 2026-11-01 on 8 threads, machine at 100 percent CPU), inside the 600 s limit with almost no room: lower `samples` or pass a `noiseThreshold` for a larger room. That is 6 seconds over the old 240 s job limit, so the limit is now 600. The hair strands were not the cost by themselves: the time was per ray, and every ray was slow.

## Open Image Denoise (optional)

`settings.renderer.denoise: "oidn"` filters the still with [Intel Open Image Denoise](https://github.com/RenderKit/oidn) 2.5.1 (Apache-2.0), the denoiser Cycles uses, fed the colour, albedo and normal images the tracer writes. It is the package `@codepawlhq/67js-denoise-oidn` (`packages/denoise-oidn`), not part of the core archive: install it beside `67js` and run its `fetch` script, which downloads the official release binary for the platform after a SHA-256 check. The job runner calls the `oidnDenoise` tool on the CPU. Without the package or the binary the job runs the wavelet filter and says why in `metrics.pathTracer.denoiserNote`; `metrics.pathTracer.denoiser` always names the filter that ran. Only the native build is shipped. The browser port (`denoiser` 0.0.11 on tensorflow.js) is a 134 MB install; its scores are not in the table because the GPU it needs was not free for this comparison (`bench/reference/denoise-browser.mjs` is the script to run it), and the job runner already has Node.

Compared on 960 by 540 captures of six reference scenes, FLIP against Cycles, lower is better (`bench/reference/denoise.json`, made by `denoise-capture.mjs`, `denoise-compare.mjs` and `denoise-score.py`). The unfiltered tracer, the wavelet filter and OIDN all land within 0.01 of each other on every scene except `metal`, because most of the score is the difference between the tracer and Cycles, not noise:

| Scene | Wavelet, 64 samples | Wavelet, 16 | OIDN, 16 | OIDN, 8 | OIDN, 32 |
| --- | --- | --- | --- | --- | --- |
| `brick-graph` | 0.0805 | 0.0812 | 0.0812 | 0.0818 | 0.0806 |
| `character` | 0.0287 | 0.0297 | 0.0308 | 0.0324 | 0.0295 |
| `glass` | 0.0385 | 0.0399 | 0.0395 | 0.0407 | 0.0385 |
| `material-spheres` | 0.0449 | 0.0465 | 0.0471 | 0.0487 | 0.0457 |
| `metal` | 0.0439 | 0.0474 | 0.0444 | 0.0457 | 0.0440 |
| `outdoor-hdri` | 0.0226 | 0.0231 | 0.0239 | 0.0250 | 0.0230 |

OIDN at 16 samples does not score at or below the wavelet filter at 64 on any of the six scenes: it is 0.0005 to 0.0022 higher. At 32 samples it equals it on `glass` and is 0.0001 to 0.0008 higher on the other five. Issue #303's goal (no worse than the wavelet filter at 64 on four scenes with 16 samples or fewer) is therefore not met by this measure. At equal samples OIDN is clearly better only on `metal` (0.0444 against 0.0474 at 16); on the other scenes the two are within 0.0013 of each other, the wavelet filter ahead on `character`, `material-spheres` and `outdoor-hdri`. So 16 samples is the default for `oidn` because it costs a quarter of the tracing time for a score about 0.001 to 0.002 higher, not because it matches 64.

Time of the denoise step alone, 1920 by 1080 demo room: 1.6 s for OIDN against about 9 s for the wavelet filter (measured once each, machine loaded by other jobs; the 960 by 540 captures took 0.45 to 0.67 s against 2.1 to 3.2 s). The whole still at 16 samples took 138 s with OIDN (113 s tracing) and 105 s with the wavelet filter (85 s tracing); the tracing times differ because of load, not of the filters. A 64 sample wavelet still of that room took 586 s (above), so 16 samples with OIDN is about four times faster at a FLIP score 0.001 to 0.002 higher on these scenes.

OIDN's output is the same bytes run to run on one machine (the CPU device, two runs on each of the 24 captures, and two identical PNGs from an MCP job); it was not compared across machines or CPU generations, where OIDN does not promise it.

## Measured

`npm run reference -- --path-tracer [--samples 32]` draws each reference scene with the tracer and scores it against the Cycles render of the same scene with FLIP (`bench/reference/path-tracer.json`). It leaves `baseline.json` and `images/` alone, and it needs the Cycles renders of an earlier `npm run reference`.

Scores and times are in the table of `bench/reference/README.md`. Cycles used 256 samples with a denoiser, and the tracer 32 samples with its own filter, so the remaining gap is partly noise and partly the differences listed above.
