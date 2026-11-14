# Runtime against three.js

This suite compares what a frame costs in Crucible and in three.js on 7 matching scenes. **three.js wins most of them today, but Crucible wins the GPU frame in 2 of 7 scenes.**

## Culling and levels of detail (issue 37)

Scene `large-outdoor` has 6,000 spheres of about 1,000 triangles over 600 by 600 units, seen from the edge, so about a quarter of them are in view and most are far. `crucible` uses the default frustum culling and the levels from `generateGeometryLods` (ratios 0.25 and 0.06, 1 pixel of error). `crucible-no-lod` has culling only, and `crucible-no-culling` has neither, which is what the renderer did before. three.js draws 6,000 individual meshes, which it culls per mesh, without levels. Measured on 2026-10-31 at 960 by 540, `--frames 30`, other jobs were using the RTX 3060 between 1 and 87 percent (`gpuBusyBefore` in a full report), so the GPU numbers are noisy.

| Engine | RTX 3060 frame (ms) | Triangles | SwiftShader frame (ms) |
| --- | --- | --- | --- |
| `crucible-no-culling` | 8.41 | 5,760,014 | 4,428 |
| `crucible-no-lod` (culling) | 7.68 | 4,359,374 | 4,061 |
| `crucible` (culling and levels) | 1.55 | 270,474 | 517 |
| three.js | 6.00 | 4,359,372 | 944 |

Culling alone gives the same picture pixel for pixel as no culling, on both backends. Levels change 1.9 percent of the pixels by more than 8 levels (mean absolute difference 0.45 of 255). The other 7 scenes draw the same pictures as before pixel for pixel on the RTX 3060 (checked on 4 of them), and their frame times moved within the noise. The run draws the first frame again after the measured frames and fails when the `large-outdoor` picture differs.

## Run it

Run `npm run benchmark:runtime`. It takes about 8 minutes, and it rewrites `report.json`. Stop other GPU work first, because `report.json` records how busy the GPU was before each run.

CI does not run this suite. It needs Chrome and a GPU, and `tests/runtime-report.test.js` checks only that the committed report is complete.

## Result

Measured twice on 2026-11-04 at 960 by 540 with 4 MSAA samples, against three.js 0.187.0, after the issue 74 and issue 287 changes. Each cell is the lowest to the highest of the two full runs, because the machine is shared. The RTX 3060 was busy with other jobs before every scene (`gpuBusyBefore` in `report.json`: 4 to 86 percent in the first run, 17 to 95 percent in the second), so treat the RTX 3060 rows as noisy and compare the SwiftShader table first. A ratio above 1 means that Crucible costs more; it divides the middle of the Crucible range by the middle of the three.js range.

**Full frame on SwiftShader, in milliseconds.** This is the path that a headless agent uses.

| Scene | Crucible | three.js | Ratio of middles |
| --- | --- | --- | --- |
| `instanced-objects` | 104 to 119 | 34 to 35 (instanced 34) | 3.2 |
| `many-materials` | 369 to 393 | 153 to 156 | 2.5 |
| `many-lights` | 308 to 318 | 113 to 115 | 2.7 |
| `transparency` | 264 to 322 | 56 to 59 | 5.1 |
| `moving-shadows` | 69 to 72 | 20 to 21 | 3.4 |
| `large-mesh` | 364 to 386 | 160 to 174 | 2.2 |
| `skinned-characters` | 106 to 109 | 25 to 28 | 4.0 |

**Full frame on an RTX 3060, in milliseconds.** Other jobs shared the GPU during parts of this run, so these numbers are noisy.

| Scene | Crucible | three.js | Ratio of middles |
| --- | --- | --- | --- |
| `instanced-objects` | 0.83 to 1.04 | 2.44 to 2.61 (instanced 0.25) | 0.4 |
| `many-materials` | 2.02 to 2.15 | 1.68 to 1.77 | 1.2 |
| `many-lights` | 1.56 to 1.75 | 0.79 to 0.92 | 1.9 |
| `transparency` | 1.09 to 1.18 | 0.72 to 0.80 | 1.5 |
| `moving-shadows` | 0.79 to 0.82 | 1.15 to 1.25 | 0.7 |
| `large-mesh` | 2.42 to 2.77 | 0.35 to 0.37 | 7.2 |
| `skinned-characters` | 3.88 to 3.94 | 1.67 to 1.73 | 2.3 |

**First frame on an RTX 3060, in milliseconds.** Each run has an empty browser profile, so no shader cache helps either engine.

| Scene | Crucible | three.js | Ratio of middles |
| --- | --- | --- | --- |
| `instanced-objects` | 226 to 278 | 91 to 111 (instanced 92 to 93) | 2.5 |
| `many-materials` | 228 to 248 | 77 to 162 | 2.0 |
| `many-lights` | 184 to 199 | 102 to 140 | 1.6 |
| `transparency` | 213 to 220 | 111 to 128 | 1.8 |
| `moving-shadows` | 221 to 230 | 106 to 111 | 2.1 |
| `large-mesh` | 376 to 446 | 242 to 255 | 1.7 |
| `skinned-characters` | 381 to 386 | 267 to 284 | 1.4 |

## GPU memory per render target

Each Crucible result in `report.json` lists its render targets (`renderTargets`: name, size, format, samples, bytes). The same list comes from `renderer.memoryReport()`. At 960 by 540 with 4 samples, for `instanced-objects` and `large-outdoor` alike: `shadowMap` 16 MB (2048 by 2048 depth), `multisampleColor` 15.82 MB (RGBA16F), `multisampleDepth` 3.96 MB (16 bits, it was 7.91 MB with 24 bits) and `frameColor` 3.96 MB. The counter totals 41.36 MB and 43.58 MB, so 1.4 to 3.6 MB is geometry and textures.

**At 1920 by 1080** (4 samples, no depth texture; measured with `renderer.memoryReport()`, the same for all seven scenes) a plain lit scene holds 110.92 MB of render targets: `multisampleColor` 63.28 MB (RGBA16F, 4 samples), `shadowMap` 16 MB, `multisampleDepth` 15.82 MB and `frameColor` 15.82 MB. The multisampled colour is 57 percent of it, so only a smaller colour format or fewer samples can halve the total, and both change pixels. The opt-in addon `useCompactColor(renderer)` (`addons/compact-color`) stores the frame and the multisample colour as R11F_G11F_B10F: 110.92 MB becomes 71.37 MB (39.55 MB less; `multisampleColor` 31.64, `frameColor` 7.91), and the 26 reference pictures differ from the default by mean FLIP 0.002 to 0.030 (median 0.021). Without it the default stays RGBA16F and draws the same pictures as before (3 scenes compared, max diff 0). With `shadowCascades` on, a scene also holds the cascade array (48 MB for three 2048 slices); the single map used to stay beside it, and now it is one texel unless volume fog or a `subsurface` material reads it. At 960 by 540 that takes 20 of the 26 reference scenes 16 MB lower (a plain scene from 93.66 MB to 77.66 MB; the 6 scenes with volume fog or subsurface keep the map), with byte-identical pictures.

Issue 287 asked for at most 23.25 MB, half of the 46.5 MB the first run showed. It is not met: 41.36 MB is the most the pictures allow today. Each step was scored by FLIP of the new Crucible picture against the old one, over the 25 reference scenes, and the limit was 0.002. The 16-bit multisampled depth scored 0.0000 everywhere and is in. Left out: an R11G11B10F colour target (saves 9.9 MB; 0.002 to 0.034, about 0.02 on most scenes, because the packed format truncates), a 1024 shadow map for small views (saves 12 MB; `subsurface` 0.006) and a 16-bit sun shadow map (saves 8 MB; `brick-flat` 0.0023 and `brick-graph` 0.0031). A renderer that needs the alpha of the colour target would also have to keep RGBA16F, so the packed format would need a flag for such an addon.

## Where each engine wins

**three.js wins:**

- Full frames on SwiftShader, in every scene.
- Full frames on the RTX 3060, in 5 of 7 scenes (`many-materials`, `many-lights`, `transparency`, `large-mesh`, `skinned-characters`). Crucible is faster than three.js with separate meshes in `instanced-objects` and `moving-shadows`, but an `InstancedMesh` beats Crucible in `instanced-objects` by 3.3 times.
- The first frame, in every scene.
- GPU memory that WebGL calls show, in every scene. Crucible allocates about 41 MB for its render targets (it was 46 MB): 16 MB shadow map, 15.8 MB multisampled colour, 4 MB multisampled depth and 4 MB resolved colour at this size. A scene with no shadow casters allocates a one texel shadow map instead of 16 MB, and bloom, ambient occlusion, cascades and the point light atlas allocate only when used. The benchmark scenes all cast shadows. three.js shows 0 to 32 MB because its targets live in the canvas, which the counter leaves out.
- Fewer triangles when objects are off camera, because it culls them. Crucible draws all of them (issue 37).
- Heap memory in `skinned-characters`, because three.js clones one parsed file.

**Crucible wins:**

- CPU time to submit a frame, in 6 of 7 scenes (all but `large-mesh`). It takes 0.27 ms against 1.88 ms for 5,000 individual meshes. It groups objects into a few draw calls by itself. An `InstancedMesh` needs the same grouping by hand in three.js.
- Heap memory in 6 of 7 scenes.

Issue 74 tracks the frame and first-frame costs. The cause is not measured yet.

## Do the pictures match?

FLIP between the two engines, where 0 means identical.

| Scene | FLIP |
| --- | --- |
| `large-mesh` | 0.027 |
| `instanced-objects` | 0.048 |
| `moving-shadows` | 0.072 |
| `skinned-characters` | 0.107 |
| `transparency` | 0.131 |
| `many-lights` | 0.133 |
| `many-materials` | 0.269 |

Both engines use the same geometry, lights and tone curve, so these are small differences. `many-materials` is the largest, because half of its spheres are metal and three.js has only an ambient light, with nothing for metal to reflect. Crucible reflects a constant environment map, so it is the one that has reflections.

The comparison is not exact. Crucible pays for an environment map and an HDR post-processing pass, and three.js does not. A scene with an environment map in three.js costs more than this.

## How it measures

- **Full frame:** from the start of the render call until `readPixels` returns one pixel, which waits for the GPU. `context.finish()` returns at once in Chrome, so it can not do this.
- **CPU submit:** the render call only.
- **First frame:** from building the scene to the first finished frame, with a new browser and profile for each run.
- **GPU memory:** watched through WebGL buffer, texture and renderbuffer calls. It leaves out the canvas's own buffers, for both engines.
- **Heap:** after a forced garbage collection, minus the heap before the scene was built.

`report.json` also holds GPU timer query results. Do not rely on them: they gave 0.15 ms for 1 million triangles in three.js, which is not plausible.

## Limits

- One machine and one resolution. Other jobs used the GPU during the RTX 3060 runs, and `report.json` records how busy it was.
- `skinned-characters` draws its robots at one spot, so that the same pixels overdraw in both engines.
- The scenes do not use textures.
- These numbers replace no claim in `docs/benchmark.json`. That file compares one scene with the same raw shader in both engines, so it measures submission cost only.
