# Where a frame and the first frame go

Issue 74. Measured on 2026-10-31 at 960 by 540, scene `instanced-objects` unless noted, Chrome headless, an empty profile for each run. The RTX 3060 was shared with other jobs (25 to 99 percent busy), so GPU frame times are noisy. SwiftShader numbers were stable between runs.

## First frame on the RTX 3060

The first frame took 3,526 ms. Each program was timed from `createShader` to the link status, so the numbers include compile and link.

| Piece | Milliseconds |
| --- | --- |
| Main fragment shader (37,179 characters) | 2,286 |
| Environment prefilter and BRDF programs, which are most of the 553 ms in `createEnvironmentResources` | 326 + 224 |
| Post-processing program | 232 |
| Liquid program | 195 |
| Depth program | 122 |
| Sky, bloom, environment background | 23 + 10 + 19 |

So about 3.4 s of 3.5 s is shader compilation, and the main fragment shader alone is 65 percent. Buffer upload and the prefilter draw calls are small. The `hdr` and `samples` options change none of this (hdr off 3,539 ms, one sample 3,300 ms).

The main program takes that long because ANGLE compiles every branch. The branches on `surface.w` (the material tag) and on map flags are runtime values, so nothing can be dropped. When the unused ones were replaced by the constant `false` in the source, the same program compiled in 244 ms.

## Frame on SwiftShader

The first draw on SwiftShader also pays a compile, so the first frame was 1.8 s there. The frame was 620 ms. Passes were left out one at a time (the picture is wrong in each case, this only splits the cost):

| Left out | Frame (ms) |
| --- | --- |
| Nothing | 620 |
| Main opaque pass | 139 |
| Post-processing draw | 631 (no change, about 45 ms measured alone) |
| Environment background | 679 (no change, about 45 ms measured alone) |
| All three | 32 |

The main fragment shader is about 480 ms of 620. Toggles:

| Change | Frame (ms) |
| --- | --- |
| `hdr` off | 524 |
| `samples` 1 | 351 |
| `hdr` off and `samples` 1 | 323 |
| Fragment shader that returns the base colour | 195 |
| Shadow lookup removed (36 texel fetches) | 586 |
| Environment lighting removed | 570 |
| Point-light loop removed | 640 (no change) |
| Unused material features removed from the source | 349 |

So the cost is the size of the one program, not one feature: each large block alone moves the frame by 5 to 10 percent, and removing the code the scene never reaches moves it by 44 percent. MSAA is the second cost (43 percent on SwiftShader), and it is part of the picture. The post-processing pass and the environment background are each under 10 percent.

## What was changed

1. The main fragment shader is built from `#define`s chosen from the parts' materials (`createFragmentShader` in `src/shaders.js`). A feature a scene does not use is the constant `false`.
2. All programs, and the environment prefilter and BRDF programs, are started before any is checked, with `KHR_parallel_shader_compile`.

## After

Same scenes, `node bench/runtime/run.mjs --scene <id> --engine <name> --frames 8`. The pictures are identical: all 16 reference images (8 scenes, GPU and SwiftShader) match before and after, 15 pixel for pixel and `metal` on the GPU in 2 pixels by one level.

| Scene | First frame, RTX 3060 (ms) | SwiftShader frame (ms) | three.js on SwiftShader (ms) | Ratio |
| --- | --- | --- | --- | --- |
| `instanced-objects` | 4,100 to 488 | 654 to 337 | 48 | 13.5 to 7.0 |
| `many-materials` | 3,704 to 826 | 2,465 to 1,058 | 235 | 10.5 to 4.5 |
| `large-mesh` | 4,384 to 975 | 2,336 to 1,189 | 231 | 10.1 to 5.1 |

## Equal feature set, and where the frame goes (2026-11-01, no engine change)

Measured on `perf/frame-cost-equal-features`, 960 by 540, Chrome headless. Four new engines in `bench/runtime` turn one feature off at a time and need `--engine <name>`: `crucible-ldr` (no HDR target), `crucible-one-sample` (no MSAA), `crucible-ldr-one-sample` (both), `three-one-sample` (three.js without MSAA). `--cpu-only` runs only SwiftShader.

**SwiftShader, frame in ms, 6 frames each, one run per row** (`base-cpu`, `base-cpu-three-one-sample`):

| Engine | `large-mesh` | `many-materials` | `instanced-objects` |
| --- | --- | --- | --- |
| three.js (4 samples) | 215 | 231 | 48 |
| Crucible (HDR, 4 samples) | 1,684 | 1,219 | 376 |
| `crucible-ldr` | 1,183 | 1,082 | 292 |
| `crucible-one-sample` | 556 | 522 | 227 |
| `crucible-ldr-one-sample` | 533 | 490 | 194 |
| three.js (one sample) | 94 | 86 | 37 |

Fair comparison: MSAA costs three.js 2.3, 2.7 and 1.3 times and costs Crucible 3.0, 2.3 and 1.7 times, so it is not what separates them. With the same feature set (no MSAA, and no HDR target for Crucible) Crucible is 5.7, 5.7 and 5.2 times three.js, against 7.8, 5.3 and 7.8 for the defaults. Crucible still draws an environment background and a post pass that three.js does not, and those are about 45 ms each on `instanced-objects` (measured above). The equal-feature gap is therefore the cost of the lit shader itself, which agrees with the profile above.

**RTX 3060, frame in ms, 60 frames, one run per row** (`gpu-matrix`, GPU 5 to 40 percent busy):

| Engine | `large-mesh` | `many-materials` | `instanced-objects` |
| --- | --- | --- | --- |
| three.js | 0.56 | 5.67 | 7.25 |
| Crucible | 3.82 | 3.48 | 2.06 |
| `crucible-ldr-one-sample` | 3.24 | 3.17 | 2.08 |
| three.js (one sample) | 0.56 | 6.89 | 9.91 |

Repeated `large-mesh` Crucible runs gave 3.41, 3.58, 3.63, 3.82 and 3.11 to 3.98 across sessions, and three.js 0.61 to 0.63. On the GPU Crucible wins `many-materials` and `instanced-objects` in this run (three.js draws 965 and 4,154 objects one by one) and loses `large-mesh` by 6.8 times. `instanced-objects` has no `three-instanced` row here, which beat Crucible in the earlier report.

**Why `large-mesh` costs 3.6 ms against 0.6 ms on the GPU.** It is one sphere with 1,046,528 triangles, and Crucible draws it in 3 passes (environment background, the mesh, post), which is also true of the RTX run above. Splitting the frame by wrapping the WebGL draw calls (script not kept in the repository):

| What | Frame (ms) |
| --- | --- |
| Whole frame | 3.1 to 3.9 |
| Mesh draw replaced by one triangle (fixed cost of the passes) | 1.3 |
| Mesh drawn with a minimal vertex and fragment shader on the same vertex array and targets | 2.1 |
| Mesh draw with `RASTERIZER_DISCARD` (vertex stage only) | 2.4 to 2.5 |
| Both full-screen passes skipped | 3.2 |
| `hdr` off, `samples` 1, or both | 3.2 to 3.3 (2.7 with HDR off alone) |
| Only 5 of the 15 vertex attributes enabled, or a non-instanced `drawElements` | 3.8 to 3.9 (no change) |
| Vertex shader cut to `gl_Position` only | 2.4 (no change) |
| Same page on ANGLE Vulkan instead of D3D11 | Crucible 1.20, three.js 0.52 |

So: the passes around the mesh cost 1.3 ms, three.js's whole frame is 0.6, and about 2 ms is the mesh itself, split between getting 1 million tiny triangles through the pipeline (about 0.8 ms even with trivial shaders) and shading them (about 1.5 ms). Neither HDR nor MSAA nor the vertex shader's contents nor the number of attributes moves it. On Vulkan the ratio falls from 5.8 to 2.3, so more than half of the gap is specific to ANGLE's D3D11 path, and the cause inside it was not found. Almost every one of the 1 million triangles covers less than a pixel, so the lit shader runs on a 2 by 2 quad per triangle; that fits the shading share but was not isolated.

**One change tried and reverted.** Skipping the two fill-light `illuminate` calls when `fillIntensity` is 0 (the benchmark's value). SwiftShader frame, one run each: `large-mesh` 1,684 to 1,338 (this scene swings by 20 percent between runs), `many-materials` 1,219 to 1,233, `instanced-objects` 376 to 383. Inside the noise on two of three scenes, so it was not kept.

## Two more changes tried, neither kept (2026-11-01, branch `perf/swiftshader-frame`)

Method: the changed file and the unchanged file were swapped in `src/` between runs, A then B, three pairs, `--cpu-only --frames 6`, median of the three. The machine was shared with other sessions (the RTX 3060 was 78 percent busy before the first run; SwiftShader runs on the CPU, whose load was not measured), so a difference under about 5 percent is noise here.

| Change (all would give identical pictures) | Scene | Before (ms, 3 runs) | After (ms, 3 runs) | Kept |
| --- | --- | --- | --- | --- |
| Draw the environment background after the opaque pass, on the far plane, with the depth test on, so covered pixels skip its shader | `instanced-objects` | 381, 379, 376 | 375, 377, 383 | No |
| Post pass: fetch the four extra FXAA taps only where an edge is found (the other pixels used `center` anyway), reuse the centre sample's alpha | `instanced-objects` | 386, 388, 402 | 552 (load spike), 375, 386 | No |

Both medians are inside the noise, so neither was committed and the reference images were not needed again (the engine is unchanged; the 16 baseline renders were taken first and no code differs from them).

**Current numbers, SwiftShader frame in ms, 3 runs each, Crucible and three.js alternated** (a loop over `--scene` and `--engine`, script not kept in the repository):

| Scene | Crucible | three.js | Ratio (medians) |
| --- | --- | --- | --- |
| `large-mesh` | 1,327, 1,336, 1,431 | 219, 221, 232 | 6.0 |
| `many-materials` | 1,216, 1,227, 1,254 | 238, 246, 256 | 5.0 |
| `instanced-objects` | 376, 386, 390 | 54, 55, 55 | 7.0 |

**Why 3 times is not reachable without changing the picture.** Three facts measured earlier in this file set the floor. A fragment shader that returns the base colour still takes 195 ms on `instanced-objects` (frame 620 ms then), which is 3.5 to 4 times three.js's 48 to 55 ms before any lighting is paid for; that floor is the 4 sample HDR target, the 49,850 triangles, the clear and the resolve. With one sample and no HDR target the whole frame is 194 ms (5.2 times three.js with one sample). The two passes that three.js does not draw, the environment background and the post pass, cost about 45 ms each when drawn alone, but the two experiments above show that trimming them does not move the frame beyond the noise. What is left in the lit shader (shadow filter, environment lookup, three lights) is 5 to 8 percent per block (profile above), so removing one block cannot close a gap of 2.3 times. The remaining routes all change the picture or the frame format: no MSAA (about 40 percent), LDR target (about 20 percent), fewer shadow taps (visible penumbra), or a quarter-resolution sky.

## Left

- A SwiftShader frame is still 4.5 to 7 times three.js, not 3. What remains is the per-pixel cost of the lit shader with 4 MSAA samples and an HDR target. Ideas that change the cost without changing the picture: a cheaper path for parts that are flat colour with no maps, and sharing one shadow comparison across the 3 by 3 filter. Both need the pictures checked again.
- The environment BRDF lookup table is the same for every map. It could be computed once per page, or on the CPU, which removes one program and one pass.

## Where the 130 ms went, and what was compiled out (2026-11-01, branch `perf/swiftshader-floor`)

Method: a wrapped WebGL context in a Playwright script (not kept in the repository) rewrote shader sources and skipped draw calls, `instanced-objects` on SwiftShader, 6 frames, medians of 2 to 3 rounds, below normal priority, other sessions on the machine (the RTX 3060 was 78 to 92 percent busy before runs; CPU load not measured).

**The split** (before any change, frame 380 ms; each row is the frame with that part removed or replaced):

| Part | Frame (ms) | So it costs |
| --- | --- | --- |
| Mesh draw skipped (clear, background, resolve, post remain) | 141 | mesh 240, rest 141 |
| Mesh drawn with `RASTERIZER_DISCARD` (vertex stage only) | 153 | vertex stage 12 |
| Mesh with a fragment shader that writes a constant | 175 | trivial shading 35, lit shading 205 |
| Post pass skipped | 317 | post 63 |
| Post fragment shader replaced by one texture copy | 322 | the shader, not the pass: 60 of the 63 |
| MSAA resolve skipped | 348 | resolve 32 |
| Environment background skipped | 363 to 373 | 10 to 20 |

So the roughly 130 ms was the fixed part around the mesh (post 63, resolve 32, background 10 to 25, rest) plus a lit shader that costs 205 ms with 4 samples against three.js's whole frame of about 50. Hypotheses: (1) no `discard` or `gl_FragDepth` executes (`USES_ALPHA_MODE` is the constant `false`); (2) the opaque pass is not sorted but `instanced-objects` is one batch, and the trivial-shader row (35 ms) shows overdraw is not the cost; (3) varyings were not changed, the vertex stage is 12 ms here; (4) blend stayed off in every opaque draw (counted) and there is one colour attachment; backbuffer `antialias:false` changed nothing (377 against 380); (5) vertex stage is small on this scene but large on the other two, below; (6) R11F_G11F_B10F, see the last paragraph; (7) nothing is re-created per frame.

**What it is.** SwiftShader pays for code that a uniform switches off, and for both sides of `cond ? a : b`. Replacing the uniform with a constant, one at a time (frame 384 ms): `materialSheen` and `materialCoat` tests 337 to 345, `environmentEnabled` 340, all frame constants together 294 to 315; the point-light count, fog, fill and world mode each moved it by under 3 percent. The post pass behaves the same way: removing the volume step saves 15, FXAA 12, explosion 5, with the rest of its code unused.

**Kept changes** (each pictures identical, 8 scenes, SwiftShader, compared pixel by pixel against renders of the merge base: max difference 0). Alternated A, B, three pairs, medians:

| Change | Scene | Before (ms) | After (ms) |
| --- | --- | --- | --- |
| Environment path, sheen and clear coat compiled out of the main fragment program unless a part or the map needs them | `instanced-objects` | 384, 385, 384 | 325, 341, 335 |
| Post program per set of steps in use (full program draws until the variant is built) | `instanced-objects` | 324, 334, 332 | 295, 301, 279 |
| Vertex program without skin, morph, wind, waves, explosion unless a part needs them, and no colour clear under an environment background | `large-mesh` | 1,119, 1,139, 1,159 | 922, 887 (one run lost) |
| same | `many-materials` | 983, 981, 1,007 | 892, 874, 880 |
| same | `instanced-objects` | 290, 289, 291 | 268, 280, 267 |

The vertex split on `large-mesh` (1,070 ms; the vertex stage alone is 360 ms there): skin and morph calls cost 100, box position 25, water and explosion branches 25, wind and the inverse-transpose normal matrix under 5 each, everything together 170.

**Ratio now** (SwiftShader frame, Crucible and three.js alternated, 3 runs; `instanced-objects` lost one run each, so 2):

| Scene | Crucible (ms) | three.js (ms) | Ratio (medians) | Was |
| --- | --- | --- | --- | --- |
| `large-mesh` | 901, 888, 909 | 225, 234, 239 | 3.85 | 6.0 |
| `many-materials` | 1,290 (load spike), 898, 899 | 231, 243, 331 | 3.69 | 5.0 |
| `instanced-objects` | 260, 263 | 90 (load spike), 51 | 5.1 | 7.0 |

**3 times is not met.** What is left, by size, on `instanced-objects` (frame about 265): the lit shader about 160 over a constant shader (shadow filter, environment lookups, three lights, runtime-uniform fill and fog), the resolve 35, the background 25, the post pass 30. Items that need a picture or format decision by An: (a) `R11F_G11F_B10F` for the 4 sample target and the frame texture, without alpha, only for an opaque canvas. Measured: `instanced-objects` 338 to 271 (20 percent), but the pictures are not identical: mean absolute difference 0.13 to 0.59 levels per scene, maximum 6 to 53 levels, and the `transparency` scene has 32,689 pixels more than 2 levels away. It was not kept; `npm run reference` was not run on it. (b) Fewer shadow taps, or no MSAA (about 40 percent), or an LDR target (about 20 percent), as before. Cheap exact ones left: `boxPosition` only when a box-mapped material exists (about 25 ms on `large-mesh`), starting the environment background program with the others.

Tests: `npm test` 1,292 tests, 1,283 pass; the 8 failures all need the optional `manifold-3d`, which this checkout does not have (mesh boolean, bracket recipe, blender-golden, other-clients, agent-asset-mesh, two suite reference tests). `npm run size` passes after `--update-baseline` and `--set-budgets`, because the program variants add about 2.4 to 2.8 KB gzip to the entries that include the renderer.

## `mountain-valley`: where the time goes (issue #171)

`node bench/reference/profile-scene.mjs mountain-valley gpu|cpu` runs the phases of one render three times and counts what the frame hands to the GPU. The scene has 7,698 parts in 418 batches and 9,721,668 triangles before culling. Measured on the RTX 3060 and on SwiftShader, 2026-11-02, while other sessions loaded the machine, so each number is a range over 3 runs.

| Phase | RTX 3060 (ms) | SwiftShader (ms) |
| --- | --- | --- |
| Scene build (terrain, scatter, level selection) | 1,690 to 2,050 | 1,680 to 1,950 |
| Renderer construction (upload, shadow commands queued) | 190 to 640 | 180 to 250 |
| First frame, before the change | 41 to 94 | 9,900 to 10,600 |
| First frame, after the change | 30 to 70 | 9,100 to 9,250 |
| Later frame (main pass only) | 19 to 20 | 6,800 to 7,300 |
| Whole `run.mjs` step for the scene | 10,000 to 15,200 | 19,900 to 22,400 |

Triangles handed to the GPU: the later frame draws 6.46 million in 184 calls after frustum culling. Before the change the first frame drew 25.90 million in 1,020 calls, which is the main pass plus two shadow passes of 9.72 million each. After it draws 16.18 million in 602 calls, one shadow pass.

What this shows:

- The 8.3 s of the issue is not the GPU frame. On the 3060 the whole frame is about 20 ms. Most of the wall time of the step is outside the frame: scene build 1.7 s, and about 7 s for the harness to move the 21 MB scene description out of the page and write it, which is Blender export work and not renderer work. The in-page describe step itself takes 0.6 s (43 ms for the parts, 580 ms for the geometry bytes).
- On SwiftShader the main pass is 7 s of the 9 s first frame, so triangles drawn matter there. The shadow pass is about 1.5 s per pass and is not culled: `drawShadowCasters` draws every caster batch whole, with no frustum test against the light and no level selection.
- Level of detail already works on the camera side: with `distanceScale: 3` the trees switch at 114 m and 285 m, and 4,469 of 13,951 instances are beyond `cullDistance`. The last level still has 2,180 triangles per conifer (a trunk of about 2,050 and a crown of 120), so about 4,500 trees at 285 m and beyond make most of the 6.46 million.

Kept: the constructor draws the shadow map, and the first `render` drew it again because `assemblyAmount` started undefined and compared as changed. It now starts at 0. Pictures are byte-identical to the renders before the change (GPU and SwiftShader PNG compared with `cmp`). Effect: first frame 41 to 94 ms became 30 to 70 ms on the 3060, and 9.9 to 10.6 s became 9.1 to 9.25 s on SwiftShader. The main pass is unchanged.

Tried and reverted: a fourth tree level of detail beyond 260 m (trunk only, crown clumps 2.6 times wider, 152 triangles for a conifer). The unculled count fell, but the score against Cycles moved from 0.3473 to 0.3427 (SwiftShader 0.3460 to 0.3413), outside the 0.002 limit, and the other 20 scenes kept their scores. Distant trees are not invisible in this picture: the forest is a wide band across the valley and its coverage changes the mean. A gentler far level (keep the branches, widen the clumps less) was not tried because one rescore takes about 50 minutes on a loaded machine.

Next ideas, by expected size: a far level that keeps the picture (try the clump width at 1.5 times and the trunk with its first branches); shadow level selection from the shadow texel size (2.2 m here, so level 3 geometry is enough for every tree in the map); a light frustum test per instance in the shadow pass; scene build at 1.7 s, of which scatter is 0.55 s and the rest is terrain and painting.

### Shadow pass: level of detail and light frustum (issue #171, 2026-11-02)

`drawShadowCasters` now selects instances per batch with `selectInstances`, as the main pass does. Two changes, measured one at a time on `mountain-valley` with `profile-scene.mjs`. The shadow pass is the first frame minus the later frame.

| Step | Shadow triangles | Shadow calls | RTX 3060 first frame (ms) | SwiftShader first frame (s) |
| --- | --- | --- | --- | --- |
| Before | 9,721,668 | 418 | 32 to 79 | 8.9 to 9.5 |
| Light frustum test only | 9,717,316 | 390 | not separated | not separated |
| Shadow level only | 2,346,178 | 418 | 28 to 67 | 8.4 to 8.8 |
| Both, as kept | 2,341,826 | 390 | 29 to 70 | 8.5 to 8.6 |

- Frustum test: nearly nothing here. The shadow box (half-width 2,300 m) holds the whole forest, so only 4,352 triangles and 28 calls fall outside it. It stays because it is exact (an instance outside the box writes no texel) and it costs one pass over the instances that the level step needs anyway; a scene with a tight shadow box gains from it.
- Shadow level: a tree trunk had 2,050 triangles at every camera level. Each bark part now carries `shadowLods`: its own geometry (error 0) and a trunk with half the sides and no branches. `error` is the width of the thickest branch it drops plus the trunk corners it cuts (0.4 to 1 m for a conifer). The level is the coarsest whose error stays within one texel, `error * scale * texelsPerUnit <= lodPixelError`, with the texel size read from the orthographic light matrix and the map size (2.2 m here). A perspective light (spot tiles) has no single texel and keeps the own geometry. Foliage sways, so it is not cullable and has no shadow level: 1.61 million of the 2.34 million shadow triangles left are foliage.
- Triangles fell 76 percent; the SwiftShader shadow share (first frame minus later frame) fell from 2.1 to 2.6 s to 1.5 to 1.9 s, less than the triangle count because the foliage, the terrain and the per-instance selection remain. The steady frame does not draw the shadow map (it is static unless a caster moves or wind advances), so the plain frame is unchanged: 3060 median 17.6 to 18.4 ms before and after, SwiftShader 7.0 to 7.3 s. The saving lands on the first frame and on every frame that redraws the map.
- Picture: `mountain-valley` GPU render against the render before the change differs in 27,167 of 518,400 pixels, 80 of them by more than 8 levels (largest 24 of 255); SwiftShader 33,356 pixels, 78 above 8 levels (largest 35). In the darkest quarter of the image, where shadows are, the mean difference is 0.075 and 0.085 levels. Score against Cycles 0.3473 to 0.3478 (SwiftShader 0.3460 to 0.3466), against EEVEE 0.2420 to 0.2426. The other 20 scenes keep their scores to four digits.
- Not done: a shadow level for foliage, which needs a bound that includes the wind sway.

### Foliage shadow levels, culled foliage and a far tree level (issue #186, 2026-11-03)

`node bench/reference/profile-scene.mjs mountain-valley gpu` now also prints the instances drawn per triangle count of the geometry, for the shadow pass and for the main pass. Triangles handed to the GPU, measured on the RTX 3060:

| Step | Main pass | Shadow pass |
| --- | --- | --- |
| Before (main at 52244d3) | 6,456,732 | 2,341,826 |
| Swaying foliage culled, foliage shadow layers | 5,368,328 | 1,759,378 |
| Plus the fourth tree level, as kept | 2,891,430 | 1,394,478 |

- Swaying batches (`foliage`, `grass`) are cullable now. The vertex shader moves a vertex by at most 0.555 (foliage) or 0.51 (grass) times the wind strength, so each bound grows by 0.56 times the strength (`SWAY_REACH_PER_STRENGTH` in `renderer.js`). That is exact, so the picture does not change; it removed 1.09 million main pass triangles of off-screen foliage.
- Foliage shadow layers: a third of the leaves 1.7 times larger (error 1 m) and an eighth 2.8 times larger (error 2 m), with the tree's own leaf material. Trunks gain a second shadow level with a third of the rings. A tree at the last camera level had 2,050 trunk triangles in the main pass and now has 750 (conifer), with its crown clumps 1.5 times wider.
- Score against Cycles for `mountain-valley`: GPU 0.2623 to 0.2629, SwiftShader 0.2600 to 0.2607 (limit 0.002). The other 22 scenes keep their scores to four digits.
- The frame time on the 3060 is a range, not a result: three runs of the main pass were 18.3 to 18.8 ms before and 11.8 to 14.7 ms after, with other sessions loading the machine.
- Not done: the shadow pass still draws 3,649 shadow trunks of 130 triangles and about 3,200 crown clumps of 96 to 108 triangles for trees that are smaller than a texel; the terrain tile of 8,192 triangles is drawn 14 times.

## Lit shader cost on SwiftShader, three tries, none kept (2026-11-03, branch `perf/lit-shader-cost`)

Issue 74. Same method as before: `--cpu-only --frames 6`, `crucible-ldr-one-sample` against `three-one-sample`, at below-normal priority, other sessions running (CPU 5 to 100 percent). Changed and unchanged file were swapped in `src/` and alternated, three rounds, no code is left changed.

**The baseline moved with the machine, not with the code.** The same unchanged `origin/main` gave two different states within 30 minutes. Frame in ms, ranges over 3 to 5 runs (measured):

| State | Scene | Crucible | three.js | Ratio |
| --- | --- | --- | --- | --- |
| First (quiet) | `large-mesh` | 116 to 122 | 39 to 40 | 2.9 to 3.1 |
| First (quiet) | `many-materials` | 120 to 122 | 44 to 46 | 2.6 to 2.7 |
| First (quiet) | `instanced-objects` | 57 to 60 | 31 to 32 | 1.8 to 1.9 |
| Second (busy) | `large-mesh` | 145 to 151 | 44 to 53 | 2.8 to 3.4 |
| Second (busy) | `many-materials` | 188 to 200 | 46 to 49 | 3.9 to 4.3 |
| Second (busy) | `instanced-objects` | 57 to 78 | 30 to 31 | 1.9 to 2.5 |

So with MSAA and the HDR target removed on both sides, the 2026-11-01 figures (5.2 to 5.7) are not reproduced: the frame is 2 to 4 times three.js, and `many-materials` is the one scene over 3 in the busy state. (The earlier 533, 490 and 194 ms for the same three rows were taken under heavier load; this is inferred from the two states above, not shown.)

**Ablations, to see where the frame goes (picture wrong in each, measured, one run each, quiet state for shadow and busy state for the rest):**

| Left out | `large-mesh` | `many-materials` | `instanced-objects` |
| --- | --- | --- | --- |
| Nothing (same state) | 117 to 145 | 120 to 190 | 57 to 58 |
| Sun shadow (`return 1.0`) | 129 | 91 to 97 | 45 to 46 |
| Environment lighting | 136 | 149 | 50 |
| `illuminate` reduced to a Lambert term | 140 | 175 | 70 |
| Whole `main` replaced by a constant colour (3 pairs, alternated) | 145 to 147 vs 145 to 150 | 188 to 189 vs 188 to 190 | 58 to 60 vs 58 to 59 |

The last row is the finding: in the busy state a constant fragment shader costs the same as the lit one, so the frame was not bound by the lit shader there. What remains then is outside it: the vertex stage (1 million triangles in `large-mesh`), and the environment background and post passes that three.js does not draw (about 45 ms each on `instanced-objects` at 4 samples, measured on 2026-10-31). The shadow filter (36 `texelFetch`) is the largest single block of the lit shader when the shader is the bottleneck, about 25 percent on `many-materials` and `instanced-objects`.

**Changes tried (all pixel identical unless stated), alternated with the unchanged file, 3 rounds, `crucible-ldr-one-sample`, busy state:**

| Change | `large-mesh` before / after (ms) | `many-materials` | `instanced-objects` | Kept |
| --- | --- | --- | --- | --- |
| Shadow taps without `clamp` when the 3 by 3 footprint is inside the map, chosen with a `bool` argument | 145 to 147 / 150 | 188 to 191 / 193 to 199 | 58 to 59 / 61 to 63 | No, 3 to 5 percent slower |
| Skip the shadow filter where the surface faces away from the sun, only in shaders without foliage, grass, floor, moss, sheen, clearcoat or add-on code (`SHADOW_ONLY_WHERE_LIT`) | 145 to 147 / 143 to 145 | 190 to 194 / 187 to 193 | 58.6 to 59.3 / 57.0 to 57.3 | No, inside noise (about 2 percent) |
| `pow(x, 5.0)` in `fresnel` and `pow(roughness + 1.0, 2.0)` as multiplications (not bit identical: float rounding) | 145 to 146 / 143 to 145 | 188 to 191 / 184 to 185 | 59 to 63 / 57 to 58 | No, 0.5 to 5 percent and the pixels are not guaranteed identical |

Inferred, not isolated: SwiftShader still pays for a branch that pixels in the same quad do not all take, so the first two behave as the earlier `fillIntensity` skip did. `textureGather` would cut 36 fetches to 9 but is not in WebGL 2 (GLSL ES 3.00).

**What to try next.** Measure the two full-screen passes against the vertex stage on `large-mesh` and `many-materials` with a profile that does not depend on the machine state (pin the cores, or count instructions), since the lit shader is no longer the proven bottleneck. Draw the environment background only where no mesh covers the pixel was already tried on 2026-11-01 and moved nothing.

## Remeasure on current main, and one exact change that did not pay (2026-11-03, branch `perf/swiftshader-ratio`, issue #74)

Method: `bench/runtime/run.mjs --cpu-only --frames 8`, one scene and one engine per process, Crucible and three.js alternated inside each round, 3 rounds, below-normal priority. CPU load was sampled for 1 s before each pair: 2 to 41 percent (the machine was quiet, other sessions mostly idle). The RTX 3060 showed 0 percent busy before the GPU runs. The driver script is not kept in the repository.

**Frame on SwiftShader, default settings (4 samples, HDR target), milliseconds, medians of 3 (measured):**

| Scene | Crucible | three.js | Ratio median | Ratio range |
| --- | --- | --- | --- | --- |
| `instanced-objects` | 174 | 32 | 5.4 | 5.2 to 5.6 |
| `many-materials` | 568 | 181 | 3.1 | 2.7 to 3.2 |
| `many-lights` | 443 | 153 | 2.9 | 2.9 |
| `moving-shadows` | 77 | 20 | 3.8 | 3.7 to 5.8 |
| `large-mesh` | 557 | 198 | 2.8 | 2.8 to 2.9 |
| `skinned-characters` | 191 | 27 | 7.5 | 6.9 to 7.7 |
| `transparency` | 431 | 52 | 8.3 | 8.2 to 8.9 |
| `large-outdoor` | 243 | 816 | 0.30 | 0.30 to 0.32 |

So `large-mesh`, `many-lights` and `large-outdoor` are at or under 3, `many-materials` is at 3.1 (range 2.7 to 3.2), and `instanced-objects`, `moving-shadows`, `skinned-characters` and `transparency` are 3.8 to 8.3. The scenes with fewer fragments per triangle fall behind most, which fits a fixed per-fragment cost plus MSAA (inferred).

**First frame on the RTX 3060** (`--gpu-only`, empty profile, 2 runs per scene, milliseconds, measured): `instanced-objects` 229, 204; `many-materials` 268, 222; `many-lights` 197, 266; `transparency` 235, 210; `moving-shadows` 265, 210; `large-mesh` 389, 365; `skinned-characters` 267, 265; `large-outdoor` 257, 248. Every scene is under 1 s (the worst is 389). The "under 1 s" target holds.

**Where `transparency` (the worst ratio) goes** (`crucible-ldr-one-sample`, 202 ms against `three-one-sample` 22 ms, so MSAA and HDR are not the cause; measured, 1 to 2 runs each):

| Variant (picture wrong in each) | Frame (ms) |
| --- | --- |
| Nothing | 202 |
| Blend batches not drawn | 42 |
| Fragment shader returns the base colour right after `surfaceAlpha` | 30 |
| `shadowVisibility` returns 1.0 | 114 to 136 |
| Shadow filter skipped where the surface faces away from the sun | 191 |

Both engines draw 288,000 triangles, and Crucible draws them in 4 draw calls against 301. The blend pass is 80 percent of the frame and nearly all of it is the lit fragment shader across 300 overlapping layers; the sun shadow filter is 40 to 45 percent of that. `skinned-characters` with the same facing test: 130 to 80 ms (`crucible-ldr-one-sample`, upper bound, picture wrong).

**One change tried, pixel identical, not kept.** Take the 36 shadow fetches only where the sun lights the surface (`dot(normal, lightDirection) > 0`), or where another term reads `visibility` directly (floor, canopy, grass, sheen, clear coat, moss, and the room occlusion, which needed `room` to be computed before the call). `illuminate` returns nothing when that dot product is not positive, so the result is the same. PNG bytes were identical to the merge base in all 8 scenes. Default settings, 3 alternated rounds, ms:

| Scene | Before | After |
| --- | --- | --- |
| `skinned-characters` | 185, 188, 193 | 181, 179, 184 |
| `transparency` | 430, 435, 429 | 430, 601 (load), 436 |
| `many-materials` | 578, 580, 593 | 572, 599, 575 |
| `instanced-objects` | 178, 175, 170 | 173, 167, 167 |
| `large-mesh` | 559, 560, 550 | 552, 546, 575 |

The best case is 3 percent on `skinned-characters` and the rest is noise, so it was reverted. The 38 percent in the table above was with MSAA and HDR off; with them on, the cost the facing test skips is a small part of the frame.

**Where this leaves the target.** Not met: four scenes are above 3 and `many-materials` is on the line. The remaining gap in `transparency` and `skinned-characters` is the lit fragment shader itself (fragment cost per covered pixel), and the measured exact changes in this file (this one, the three on 2026-11-03, the two on 2026-11-01) each move under 5 percent. The routes that remain change pixels or the frame format: no MSAA, `R11F_G11F_B10F` (20 percent on `instanced-objects`, mean 0.13 to 0.59 levels, not run through `npm run reference`), fewer shadow taps, or a shader with fewer terms for blended parts.

## Sun shadow as one comparison fetch per tap (2026-11-03)

Measured on `perf/blended-shadow-taps` at 960 by 540, SwiftShader, `--cpu-only --frames 6`, Chrome headless. Each row alternates the old build, the new build and three.js in one window for 3 rounds, so machine load cancels; the machine ran at about 12 percent CPU from other sessions between runs. Frame in ms, then the median ratio to three.js (all three medians in the same window).

The shadow depth texture now has `TEXTURE_COMPARE_MODE` and linear filtering, and the shader samples it as `sampler2DShadow`. One fetch returns the 2 by 2 percentage-closer result that four `texelFetch` calls and a `step` each used to build by hand, so the 9-tap filter is 9 fetches, not 36. Edges clamp the same way.

| Scene | Before (ms) | After (ms) | three.js (ms) | Ratio before to after |
| --- | --- | --- | --- | --- |
| `transparency` | 424 to 431 | 364 to 367 | 51 to 52 | 8.4 to 7.1 |
| `skinned-characters` | 186 to 192 | 159 to 165 | 25 to 26 | 7.6 to 6.6 |
| `instanced-objects` | 171 to 177 | 100 to 148 | 31 to 32 | 5.5 to 4.0 |
| `moving-shadows` | 70 to 72 | 65 | 19 | 3.8 to 3.5 |
| `many-materials` | 561 to 570 | 478 to 490 | 173 to 175 | 3.25 to 2.79 |
| `many-lights` | 439 to 445 | 392 to 397 | 150 to 153 | 2.89 to 2.59 |
| `large-mesh` | 550 to 554 | 475 to 481 | 196 to 205 | 2.79 to 2.44 |
| `large-outdoor` | 239 to 258 | 229 to 243 | 787 to 804 | 0.31 to 0.29 |

`instanced-objects` has the widest spread after the change (100 to 148), so its ratio is a range of about 3.2 to 4.7. The 8 scenes keep their pictures: `npm run reference -- --skip-blender` scores all 23 reference scenes within 0.0001 of the stored scores against Cycles and EEVEE (largest move -0.0001), on both the GPU and SwiftShader renders. Nine rows of `baseline.json` changed in the fourth digit and were updated.

Not kept: 4 taps in place of 9 (two by two, spaced 3.5 texels) took `transparency` from 366 to 351 ms, 4 percent, for a smaller and different filter. The remaining distance on `transparency` (7.1 times) and `skinned-characters` (6.6 times) is not the shadow filter any more; they stay above the issue 74 target of 3 times.

The fog volume shares the shadow texture and now reads it through the comparison sampler, so its single tap is filtered over 2 by 2 texels where it was nearest. The main program also sets every 2D sampler to unit 1 when it links, because an unset sampler reads unit 0 and one unit may not hold two sampler types.

## Fill lights compiled out, and where `transparency` and `skinned-characters` still go (2026-11-03, branch `perf/blended-skinned-cost`, issue #74)

Method: `--cpu-only --frames 6`, one scene and one engine per process, the old shader, the new shader and three.js alternated inside each of 3 rounds, below-normal priority. CPU load sampled for 1 s before each triple: 2 to 8 percent. Frame in ms (measured).

**Kept: `FILL_ON`.** The two fill-light `illuminate` calls scale with `fillIntensity`, which is 0 here and in four of the five lighting setups. A uniform branch `if (fillIntensity != 0.0)` did not move any scene (`transparency` 363 to 366, `skinned-characters` 160 to 163), because SwiftShader runs both sides. A macro does: `shaderFeaturesOfLighting` adds the `fill` feature while `fillIntensity > 0`, the program is rebuilt once if it rises later (as for spot lights), and the default shader keeps the code. PNG bytes are identical to the merge base in all 8 scenes, and the reference suite (`--skip-blender`) gives the same scores with and without the change (the stored arrays copied from other worktrees differ from `main` on `mountain-valley`, so `baseline.json` was left as it is).

| Scene | Before (ms) | After (ms) | three.js (ms) | Ratio before to after |
| --- | --- | --- | --- | --- |
| `transparency` | 365 to 366 | 341 to 345 | 51 to 52 | 7.1 to 6.7 |
| `skinned-characters` | 160.5 | 120 to 140 | 24 | 6.6 to 5.2 |
| `instanced-objects` | 98 to 113 | 93 to 96 | 31 to 33 | 3.2 to 3.0 |
| `moving-shadows` | 64 to 65 | 62 to 64 | 19 to 20 | 3.3 to 3.2 |
| `many-materials` | 475 to 506 | 455 to 459 | 171 to 174 | 2.8 to 2.65 |
| `many-lights` | 389 to 392 | 371 to 372 | 131 to 142 | 2.85 to 2.7 |
| `large-mesh` | 471 to 481 | 451 to 457 | 198 to 203 | 2.4 to 2.27 |
| `large-outdoor` | 235 | 216 to 227 | 768 to 828 | 0.29 to 0.28 |

First frame on the RTX 3060 (`--gpu-only`, GPU 0 percent busy before): `skinned-characters` 287 ms, `transparency` 234 ms, `large-mesh` 364 ms, all under 1 s. The three scene bundles' size budgets rose by 100 bytes each for the extra shader lines.

**Where the rest goes (ablations, picture wrong in each, 2 to 4 runs, frame in ms).** `transparency` at 365 before the change:

| Left out | Frame |
| --- | --- |
| Environment lighting, all of it | 276 to 287 (80 less) |
| Environment specular lookup (`textureLod`) | 311 to 316 |
| Environment BRDF table lookup | 347 to 350 |
| Environment diffuse (9 irradiance terms) | 345 to 348 |
| Sun shadow read (`return 1.0`) | 326 to 327 (nine comparison fetches, about 40) |
| Key `illuminate` | 354 to 366 (nothing: half of each sphere faces away) |
| `atan` and `acos` in the equirectangular lookup | no change |
| `room` term, `fog`, HDR or LDR output branch, roughness derivatives | no change (each within 3 of the 340 baseline) |

`skinned-characters` at 124: base colour only 47 (vertex skinning and the shadow pass), shadow read 38 less, environment lighting 50 less, so 77 ms of its fragment cost is these two. A compile-out of the sun shadow read when no part casts was tried first and changed nothing in `transparency`, because the bench floor is an opaque caster; it was reverted.

**Not done, needs a pixel change.** Environment specular (about 50), the sun shadow (about 40), the BRDF table and the diffuse terms (about 20 each) are the frame. Fewer shadow taps, an analytic BRDF fit or a smaller irradiance basis would change pixels, and three.js has none of them in this scene (an ambient colour and one light, no shadow map). `transparency` stays 6.7 and `skinned-characters` 5.2 times three.js, so the target of 3 is not met for them.

## Opt-in `shading: 'light'` (2026-11-03, issue #74)

Decision of the project owner: the default picture stays as it is, and `new CrucibleRenderer(canvas, parts, { shading: 'light' })` draws a cheaper one for weak machines and software rendering. The `crucible-light` engine of this suite uses it (`node bench/runtime/run.mjs --cpu-only --scene <id> --engine crucible-light`). What the preset leaves out or replaces: MSAA is capped at 2 samples (4 by default); the sun shadow is one comparison fetch, not 9; the environment BRDF comes from an analytic fit, not the table, with no second bounce gain; the sky reflection is the irradiance of the surface normal, not a prefiltered lookup; irradiance keeps the first four of nine terms; the direct specular term uses the Kelemen visibility and a logarithm free Fresnel.

Method: SwiftShader, `--cpu-only --frames 6`, 3 rounds, `crucible-light`, three.js and `crucible` alternated for each scene inside a round, machine at 5 to 15 percent CPU from other sessions. Frame in ms (measured), then the ratio of the medians to three.js:

| Scene | `crucible` default | `crucible-light` | three.js | Default ratio | Light ratio |
| --- | --- | --- | --- | --- | --- |
| `instanced-objects` | 145 to 155 | 49 to 52 | 33 to 34 | 4.6 | 1.5 |
| `many-materials` | 470 to 494 | 93 to 122 | 177 to 184 | 2.7 | 0.66 |
| `many-lights` | 375 to 394 | 93 to 95 | 154 to 163 | 2.4 | 0.58 |
| `transparency` | 349 to 364 | 79 to 83 | 58 to 61 | 6.1 | 1.4 |
| `moving-shadows` | 68 to 79 | 42 to 52 | 20 to 21 | 3.5 | 2.2 |
| `large-mesh` | 461 to 473 | 130 to 132 | 196 to 208 | 2.4 | 0.66 |
| `skinned-characters` | 152 to 154 | 54 to 58 | 27 to 28 | 5.5 | 2.0 |
| `large-outdoor` | 233 to 256 | 58 to 59 | 815 to 838 | 0.28 | 0.07 |

Every scene is at or under 2.2 times three.js with the preset on. Most of it is the MSAA cap: on `transparency`, the shader terms alone (4 samples) gave 233 ms, 2 samples with them 78 ms, and 1 sample 83 ms. The pictures differ from the default (mean absolute difference of 255 levels, and the share of pixels more than 16 levels away): `instanced-objects` 1.27 and 1.8 percent, `many-materials` 5.5 and 18.4, `many-lights` 2.0 and 0.6, `transparency` 1.0 and 0.0, `moving-shadows` 2.1 and 2.3, `large-mesh` 0.16 and 0.0, `skinned-characters` 1.7 and 1.6, `large-outdoor` 0.9 and 0.4. With the option off (the default), the PNG bytes of all 8 scenes on SwiftShader are identical to the merge base.
