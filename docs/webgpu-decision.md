# WebGPU decision (issue #56)

Decision: wait. WebGL2 stays the only backend of the real-time renderer; the offline path tracer runs on the GPU through WebGL2 too (see the update below). Revisit when a feature needs compute and the CPU path has been measured as the bottleneck, not before.

## Update for the offline path tracer (issue #302)

The trigger named below ("a feature measured as too slow on the CPU") was met by the path tracer, so it got a GPU backend. Choice: **WebGL2 fragment shader, not WebGPU compute**, for an offline-only tracer. The real-time renderer is unchanged: WebGL2 only, no WebGPU backend.

Why WebGL2 fragment (measured on this machine, 2026-11-03, RTX 3060 shared with other sessions, Chrome with ANGLE on Direct3D 11, headless):

- It reached the target without compute. The 1920 by 1080 still of `tests/fixtures/demo-room.recipe.json` (181,708 triangles, 64 samples, 8 bounces, the 8-thread CPU tracer took 585.9 s) took 58.15 s end to end on the GPU (`seconds` 58.15, `tracedSeconds` 40.67, `compileSeconds` 10.32, warm shader cache; the rest is the BVH build and the denoiser).
- The same kernel, in the same random-number order as the CPU tracer, gives the same picture: GPU against CPU FLIP (LDR, mean) was 0.0001 to 0.0018 on all 16 path tracer reference scenes at 480 by 270 and 32 samples (measured; `bench/reference/gpu-compare.mjs` and `flip-compare.py`). Float32 against float64 and a 24-bit random value are the only differences.
- On those 16 scenes the GPU tracer took 0.5 to 1.8 s against 1.6 to 9.0 s for the CPU tracer on 8 threads, both including the denoiser (measured).
- It needs no new API surface: WebGL2 is what the job pages already use, `EXT_color_buffer_float` and `EXT_float_blend` are present on the RTX 3060 in headless Chrome, and a page without them falls back to the CPU tracer by choosing `backend: "cpu"` (the default).
- Cost: the kernel takes 13 to 30 s to compile on ANGLE's Direct3D 11 backend (the first version, with one copy of the traversal for every light type, did not finish in 4 minutes). It compiles once per page and is reused by later stills. Keeping a single copy of the shadow-ray traversal (shadow rays are recorded and traced after each light sample) is what made it compile.

Not built: a WGSL compute version. It was not needed to meet the target, and the open questions that made WebGPU attractive (storage buffers for the BVH, no texture size limits, subgroup tricks) did not block the fragment path: the scene tables fit in 2048-wide float textures (the demo room is 1.6 million triangle texels, 800 rows). This is a decision on what was measured, not a measurement of WebGPU compute: a compute path could be faster per ray, and it was not run. If the compile time or the texture-table limits become the bottleneck, the packing in `src/path-tracer-gpu-pack.js` is the part that would move to storage buffers.

Each claim carries a tag: **measured** (run on this machine on 2026-10-31), **inferred** (follows from a measurement or a source) or **guessed** (an estimate nobody ran).

Machine: Windows 11, RTX 3060 12 GB (shared with other jobs, 24 to 100 percent busy during runs), Chrome 156.0.8078.74, Playwright headless, 960 by 540, 4 MSAA samples, empty profile per run. The spike lives in gitignored `artifacts/webgpu/` and is not merged.

## What was tested

There is no WGSL port of the 67js shaders, and writing one is the work this decision avoids. The spike draws the `bench/runtime` scenes `instanced-objects`, `many-materials` and `large-mesh` (the scenes where three.js wins, `bench/runtime/PROFILE.md`) with three.js 0.186.1 on its WebGL2 renderer and on its WebGPU renderer, with the same geometry, materials and lights. This is a proxy: it tells what the API and the driver stack change for a full PBR scene, not what a 67js WGSL backend would cost. The spike draws `instanced-objects` as individual meshes (the bench's non-instanced three.js variant), so it is a heavier draw-call load than the 3-draw 67js run. The 67js rows come from `node bench/runtime/run.mjs --engine 67js --frames 20` in the same session.

## Is WebGPU available in headless Chrome here

| Chrome flags | `navigator.gpu` adapter | Source |
| --- | --- | --- |
| none (headless) | NVIDIA Ampere, 21 features, device created | measured |
| `--enable-unsafe-webgpu` | same adapter, 25 features | measured |
| `--use-angle=swiftshader --enable-unsafe-swiftshader` (what `scripts/agent-runtime.mjs` passes for the `cpu` backend) | `null` | measured |
| `--disable-gpu`, with or without `--enable-unsafe-swiftshader` | `null` | measured |
| `--enable-unsafe-webgpu --enable-unsafe-swiftshader --use-webgpu-adapter=swiftshader` | Google SwiftShader adapter, device created | measured |

The page must be a secure context: `about:blank` has no `navigator.gpu`, an `https://` or `localhost` page does (measured).

So on a machine with a GPU, headless Chrome has WebGPU with no flags. There is no automatic software fallback: the MCP `cpu` job, which forces SwiftShader for WebGL, would get no adapter and would need a different flag set to reach SwiftShader's Vulkan adapter. A CPU-only CI machine therefore needs an explicit flag, and the WebGPU software path is a different implementation from the WebGL one (inferred).

## Frame time and first frame

Three.js, same scenes, median frame after 20 warmup frames (60 frames on the GPU, 8 on SwiftShader). The frame time includes the wait for the GPU to finish (`readPixels` for WebGL, `queue.onSubmittedWorkDone()` for WebGPU), so WebGPU carries a round trip of a few milliseconds that the WebGL wait may not (inferred from `large-mesh`, where CPU submit is 0.28 ms and the frame is 3.51 ms). All numbers are measured.

RTX 3060:

| Scene | WebGL first frame | WebGPU first frame | WebGL frame | WebGPU frame |
| --- | --- | --- | --- | --- |
| `instanced-objects` | 123 ms | 797 ms | 6.81 ms | 18.52 ms |
| `many-materials` | 213 ms | 485 ms | 3.48 ms | 9.01 ms |
| `large-mesh` | 441 ms | 653 ms | 0.80 ms | 3.51 ms |

An earlier run of `instanced-objects` with the Chrome frame-rate limit left on gave 98 ms and 656 ms first frame, 4.37 ms and 16.78 ms frame, so the order did not change.

SwiftShader (WebGL through `--use-angle=swiftshader`, WebGPU through SwiftShader's Vulkan adapter):

| Scene | WebGL first frame | WebGPU first frame | WebGL frame | WebGPU frame |
| --- | --- | --- | --- | --- |
| `instanced-objects` | 288 ms | 719 ms | 48.6 ms | 146.7 ms |
| `many-materials` | 424 ms | 766 ms | 266.1 ms | 384.5 ms |
| `large-mesh` | 983 ms | 1,160 ms | 235.3 ms | 419.1 ms |

67js on its own pipeline (HDR target, MSAA, shadows, post), same session:

| Scene | RTX 3060 first frame | RTX 3060 frame | SwiftShader first frame | SwiftShader frame |
| --- | --- | --- | --- | --- |
| `instanced-objects` | 896 ms | 2.2 ms | 1,505 ms | 389 ms |
| `many-materials` | 720 ms | 3.95 ms | 2,353 ms | 1,261 ms |
| `large-mesh` | 1,013 ms | 3.79 ms | 2,737 ms | 1,332 ms |

What this says:

- Three.js on WebGPU was slower than three.js on WebGL2 in all 6 pairs: 2.6 to 4.4 times the frame time on the GPU, 1.4 to 3.0 on SwiftShader, and 1.2 to 6.5 times the first frame (measured). A new API did not remove the first-frame compile cost: WebGPU had to build its pipelines too.
- On the fallback, WebGPU on SwiftShader was 1.4 to 3.0 times the WebGL frame (measured). The 67js gap on SwiftShader is the per-pixel cost of one large lit shader with MSAA and an HDR target (`PROFILE.md`), which runs on the CPU either way; a graphics API does not change that (inferred).
- The 3.4 s first-frame cost that `PROFILE.md` found in ANGLE's compile of the 37,179 character fragment shader was already cut to 0.7 to 1.0 s on the GPU by `#define` specialization, which is a WebGL change that needs no new backend (measured, `PROFILE.md`).
- Not measured: a hand-written WGSL port of the 67js shader. A hand-written WGSL path could differ from three.js's generated shaders, and these numbers do not say by how much.
- Pictures were not compared pixel for pixel. The share of non-background pixels matched between backends in every scene (0.36, 0.87, 0.29, measured), which shows the same scene was drawn and nothing more.

## Bundle size

A scene with a box, one light and a standard material, built with Vite and esbuild minify, in a clean entry (measured). These are three.js numbers, not 67js numbers.

| Entry | Minified | Gzip |
| --- | --- | --- |
| `three` WebGLRenderer | 652,365 | 143,089 |
| `three/webgpu` WebGPURenderer (it carries its own WebGL2 fallback backend) | 1,023,136 | 236,780 |
| both imported | 1,449,769 | 329,427 |

For 67js, the lit box is 58,928 bytes gzip (`npm run size`, 2026-10-31, against a goal of 50,000 and three.js at 133,652) and `entry:core` has a budget of 82,600 (`bench/size/budgets.json`). A second backend means a second set of shaders, pipelines and resource code. Counting template-literal text in the 7 files that hold GLSL gives 1,377 non-blank lines (an upper bound, some are JS strings): `shaders.js` 847, `post.js` 244, `environment.js` 163, `camera-effects.js` 67, `ambient-occlusion.js` 45, `render-passes.js` 4, `gl-program.js` 7. The `context.` call count is 357 in `renderer.js`, 34 in `environment.js`, 25 in `render-passes.js`, 24 in `camera-effects.js` and 12 in `gl-program.js`, about 450 call sites in total (measured by grep). Guessed: carrying both backends adds 25 to 45 KB gzip to core, because WGSL is wordier than GLSL and WebGPU needs explicit pipeline and bind group code; which would move the lit box further from its 50,000 goal. This estimate was not built.

## Which shader features would need rewriting

All of them, because GLSL ES 3.00 is not WGSL. The features that carry the most risk (found by grep, so a list of where, not a cost):

- `texelFetch` in `shaders.js` and `render-passes.js`, `dFdx` in `shaders.js`, `ambient-occlusion.js` and `splat-shader.js` (WGSL has `textureLoad` and `dpdx`, with uniformity rules that reject some of the current code).
- `discard` in `shaders.js` and `gl_VertexID` in `shaders.js` and `gl-program.js`.
- `textureLod` in `environment.js` and `splat-shader.js`: the environment prefilter and BRDF programs that `PROFILE.md` timed at 326 and 224 ms.
- `blitFramebuffer` and `renderbufferStorageMultisample` in `renderer.js`: WebGPU has no renderbuffers or blit, so the MSAA resolve becomes a render pass resolve target.
- `EXT_color_buffer_*` in `environment.js` and `renderer.js`, and `KHR_parallel_shader_compile` in `gl-program.js`, which `createRenderPipelineAsync` replaces.
- Timer queries (`createGpuTimer`) become timestamp queries, which Chrome can hide behind a permission.

Estimate (guessed): about 1,400 lines of WGSL plus a rewrite of the roughly 450 call sites in `renderer.js` and its 4 neighbours, which is weeks of work and a second picture to keep equal to the first by the 16-image reference check.

## Browser support

From primary sources, read on 2026-10-31:

- MDN browser-compat-data `api/GPU.json` (main branch): Chrome 113 on ChromeOS, macOS and Windows (marked partial until 144), Chrome 144 adds Linux on Intel Gen12 and newer only; Chrome Android 121; Firefox 141 on Windows, 145 on macOS Tahoe with Apple silicon, 147 on older macOS with Apple silicon, no Intel Mac and no Linux, no service workers; Safari 26 (iOS, iPadOS and visionOS mirror it). Status: not experimental, on the standards track.
- web.dev, "WebGPU is now supported in major browsers", published 2025-11-25: Chrome and Edge 113 on Windows (Direct3D 12), macOS and ChromeOS; Android 121 for Android 12 or newer with Qualcomm or ARM GPUs; Linux in progress; Firefox 141 Windows and 145 macOS Tahoe ARM64; Safari 26 on macOS, iOS, iPadOS and visionOS.

The issue text says MDN marks WebGPU as limited availability; that is true of the MDN page as the issue cites it, and the compat data still lists Firefox as partial and Linux, Android Firefox and Intel Macs as unsupported (2026-10-31). Coverage is wide for a viewer on current Windows, macOS, iOS and Android. It is not yet something a default can rely on, and WebGL2 reaches every one of those browsers (inferred).

## What an agent gains

- Compute shaders could speed up work that is CPU now: cloth, particles, light bake, subdivision, culling. None of the recipes has been measured as too slow; their budgets are bounded on purpose (inferred from the changelog limits).
- An agent's value in this engine is that a seek gives the same bytes. The smokes compare PNG bytes through the MCP preview on SwiftShader. Compute results can differ between adapters (floating-point order, atomics), so a GPU path would weaken that check unless it were run only for offline rendering (inferred).
- The MCP runtime depends on a CPU renderer that works with no GPU. Today's WebGPU has no such path without extra flags, and was slower on SwiftShader in this spike (measured above).
- Per-tool-call success, the measure the project uses for agent features, does not depend on the backend (inferred).

## Done conditions of the issue

The decision is written with its measurements: yes, this file. The three options: adopt, adopt for offline only, wait. Chosen: wait.

When to look again:

- A feature on the roadmap measured as too slow on the CPU and needing compute (not before), or
- the MCP `cpu` backend needs a different software renderer, or
- a three.js WebGPU frame beats WebGL2 on the same scenes on the 3060 on a quiet GPU.

Not verified: a WGSL port of the 67js shaders; WebGPU timing on a quiet GPU (the RTX 3060 was shared); Firefox, Safari and Android behaviour (support facts only come from MDN and web.dev); the bundle growth of a real second backend.

## Spike for the path tracer: WGSL compute against the WebGL2 kernel (issue #625, 2026-11-08)

The question the first update left open: is a WGSL compute path tracer faster per path than the WebGL2 fragment kernel, and how long does it compile. The spike is `bench/webgpu-tracer/` (not in `src/`, no package export): `kernel.js` is `src/path-tracer-gpu-shader.js` ported to one WGSL megakernel (one invocation traces one pixel's whole path for one sample), `harness.js` and `run.mjs` time it and the shipped WebGL2 kernel on the same scene, `compare.sh` alternates them, `flip.py` scores the pictures.

What the kernel covers: BVH traversal and triangle tests in storage buffers (the same packed tables as the textures, bound as is), the atlas for colour, normal, surface and emissive maps, diffuse, GGX metal, clearcoat and glass, sun, point, spot and area lights with shadow rays, the environment map with importance sampling, 8 bounces, Russian roulette, and the same PCG and hash random numbers in the same order. Left out: fog, subsurface and the texel bake entry point (the demo room uses none of them). It is a megakernel; the wavefront variant (extend, shade, shadow) was not built (see "Not measured").

Setup (measured): `tests/fixtures/demo-room.recipe.json`, 181,708 triangles, 1920 by 1080, 64 samples, 8 bounces, seed 0, firefly clamp 20, no denoiser, headless Chrome 156 with no WebGPU flags, RTX 3060 (adapter `nvidia ampere`; WebGL2 through ANGLE on Direct3D 11), served from localhost, every trace its own `gpu-lock` job, the two backends alternated. The GPU was shared with other sessions (the card sat at 20 to 96 percent use during runs), so the spread below is mostly load. Time is the trace only: BVH build and tone mapping are outside both; WebGL2 time includes its texture upload and readback, WGSL time excludes its buffer upload (0.12 to 0.14 s, under 2 percent) and includes the readback. The WebGL2 number is a second, warm call in the same page, because the first call includes the compile.

| | WebGL2 fragment | WGSL megakernel |
| --- | --- | --- |
| Trace seconds, 4 runs | 15.4, 15.4, 15.6, 16.3 | 8.2, 12.5, 13.0, 17.6 |
| Paths per second (132.7 million paths) | 8.1 to 8.6 million | 7.5 to 16.3 million, median 10.4 million |
| Compile seconds, cold profile (first run) | 19.5 (14.0 in the 480 by 270 check) | 0.75 (1.3 in the 480 by 270 check) |
| Compile seconds, warm profile (runs 2 to 4) | 0.014 to 0.016 | 0.004 to 0.006 |
| Mean FLIP (LDR) against the WebGL2 picture | 0 (same render twice) | 0.0035 at 1080p and 64 samples, 0.0041 at 480 by 270 and 4 samples |

Every row is measured. The cold compile is one sample per backend per size, taken with a fresh Chrome profile; the warm numbers are the profile's disk cache and say nothing about a first visit. The WGSL kernel took `createComputePipelineAsync` 0.75 s cold; a second identical pipeline in the same page took 2 ms (in-process cache).

What this says:

- On the quietest run the megakernel traced 1.9 times as many paths per second as the WebGL2 kernel (8.2 s against 15.4 s), and on the most loaded run it was 1.14 times as slow (17.6 s against 15.4 s). The medians are 12.8 s and 15.5 s, about 1.2 times (measured, load-limited). Whether the quiet-card gap of 1.9 times is the real one needs a card with nothing else on it (guessed; the per-sample time of the quietest run was 0.125 s against 0.29 s of the loudest).
- The compile cost is the clear win: 0.75 s against 19.5 s cold, 26 times less (measured; one sample each, a compile of 13 to 30 s on ANGLE was already known from the first update). The WGSL kernel needed no change to compile fast: it keeps the single shadow-ray traversal, and Dawn on Direct3D 12 builds a megakernel of this size without the minutes ANGLE spends on the unrolled GLSL (inferred).
- The picture is the same scene: FLIP 0.0035 against the WebGL2 output, inside the 0.005 bar the issue sets, with no restricted feature set needed, because the demo room uses only features the kernel covers (measured). The small remainder is float arithmetic order and fast-math differences (inferred).
- Both backends are far under the 40.67 s of the first update at the same size and samples. That number was end to end with the BVH build and the machine in another state, so this run does not show a regression or a gain against it (measured now; the earlier gap is unexplained).
- The 8 storage buffers the kernel binds equal the default `maxStorageBuffersPerShaderStage`, so the scene tables fit with no limit request; the 1080p accumulation buffer is 132.7 MB, just under the 134.2 MB default `maxStorageBufferBindingSize` (measured; the spike asks for larger limits and a real backend should keep the planes in separate buffers).

Go or no-go: **go, for an offline WebGPU tracer backend behind `navigator.gpu`, with WebGL2 kept as the fallback.** Basis: it matches the picture within the issue's FLIP bar, compiles in under a second instead of 14 to 20, and traces about 1.2 times as many paths per second at the median of 4 runs (1.9 times on the quietest, 0.88 times on the most loaded; all measured). The speed gain alone is modest, so the case for a backend rests on the compile time and on the wavefront work the issue wants (shading sorted by material, reservoirs), which this megakernel cannot show and no measurement here supports yet (guessed). The issue's own bar for a go on speed, "traces in less than 40.67 s", is met by both kernels now.

Not measured: the wavefront variant (extend, shade, shadow kernels with sorted shading), which is where a larger gain would have to come from; the 16 path tracer reference scenes (only the demo room and a 480 by 270 check of it were scored); the volume and subsurface features; adapters other than the RTX 3060 and Chrome other than 156; a quiet card; WebGPU timestamp queries (the times are wall clock around `onSubmittedWorkDone`).
