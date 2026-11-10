# Reference renders

This suite scores how close a 67js render is to Blender on 23 fixed scenes. Later work uses these scores as its starting point.

## Run it

Run `npm run reference`. It prints one row for each scene, and it rewrites `baseline.json` and `images/`.

The run needs Chrome, Blender 5.2, `uv` and an NVIDIA GPU, and it took 751 s on an RTX 3060 with other jobs on the machine (2026-11-01). Use `--scene <id>,<id>` to render some scenes, then `--score-only` to score the scenes in the work directory; that also rewrites `baseline.json` with only those scenes. Use `CHROME_PATH` and `BLENDER_PATH` to change the program paths.

`raster-only.mjs <out-directory> <gpu|cpu> <scene-id>,<scene-id>` draws scenes with the rasterizer only, without Blender or scoring, to look at a change before the Cycles queue has a turn.

The other sets: `--khronos` (download the five GLB files from [glTF-Sample-Assets](https://github.com/KhronosGroup/glTF-Sample-Assets) into the gitignored `artifacts/khronos/<name>/<name>.glb` first, see below), `--path-tracer --scene <ids>` (needs the Cycles renders of an earlier plain run, for example `--skip-cpu`, which renders without scoring), and `--bake <id>,<id> --skip-blender`, which draws and scores only those scenes baked, against the Cycles renders of an earlier plain run.

A baked run writes `artifacts/reference/bake.json` and compares it with the committed `bake.json` (`compare-scores.mjs`): it exits with an error when a score is worse by more than 0.01 FLIP. `--update-baseline` replaces `bake.json` and `images/<id>-baked.jpg`. The bake is deterministic on one machine (two runs gave the same four digits), so 0.01 is a margin for other GPUs and drivers, and well under the 0.047 that went unnoticed in #160.

CI does not run this suite. `tests/reference-baseline.test.js` checks that the committed baseline is complete, and `tests/reference-bake-regression.test.js` reads JSON only: it checks `bake.json`, tests the comparison on the numbers of #160, and compares a fresh `artifacts/reference/bake.json` with the stored one when a run left one there.

## Scores now (2026-11-03)

All of them are against the Blender 5.2.2 renders taken on 2026-11-03 with the sky capped at radiance 16 (one sun, see "One sun" below); the metric is [FLIP](https://github.com/NVlabs/flip) for LDR images, mean error, 0 means identical and a higher score means a larger visible difference. The first three columns are `baseline.json` (RTX 3060 as the 67js side, unchanged by this rerun), the baked column is `bake.json` (default bake of the scene, 3 bounces, `temple-hall` with its own `bakeOptions`), and the path tracer column is `path-tracer.json` (64 samples at most, 16 scenes; the tracer skips the six newest scenes). An empty cell was not measured.

| Scene | 67js against Cycles | EEVEE against Cycles | 67js against EEVEE | Baked 67js against Cycles | Path tracer against Cycles |
| --- | --- | --- | --- | --- | --- |
| `brick-flat` | 0.0547 | 0.1098 | 0.0961 |  | 0.1152 |
| `brick-graph` | 0.0933 | 0.1221 | 0.0994 |  | 0.1476 |
| `brick-room` | 0.5102 | 0.5020 | 0.0710 | 0.1423 | 0.2727 |
| `brushed-film` | 0.1029 | 0.0984 | 0.0855 |  | 0.1524 |
| `car-paint` | 0.1038 | 0.0844 | 0.0650 |  | 0.1343 |
| `character` | 0.0799 | 0.0622 | 0.0553 |  | 0.1289 |
| `dark-shaft` | 0.0619 | 0.2653 | 0.2808 | 0.0550 |  |
| `fog` | 0.2257 | 0.2662 | 0.1060 |  | 0.5623 |
| `fog-room` | 0.1049 | 0.3730 | 0.3917 |  |  |
| `fog-valley` | 0.1855 | 0.1952 | 0.1443 |  |  |
| `foliage` | 0.1023 | 0.0888 | 0.0853 |  | 0.1753 |
| `glass` | 0.1034 | 0.1009 | 0.0996 |  | 0.1406 |
| `light-linking` | 0.0998 | 0.1558 | 0.1122 |  | 0.0213 |
| `lit-interior` | 0.5055 | 0.5159 | 0.0923 | 0.1399 | 0.2167 |
| `long-street` | 0.1407 | 0.0976 | 0.1252 |  | 0.1818 |
| `material-spheres` | 0.1293 | 0.1053 | 0.0756 |  | 0.1383 |
| `megacity-dusk` | 0.1627 | 0.1524 | 0.1022 |  |  |
| `metal` | 0.1036 | 0.0916 | 0.0782 |  | 0.1492 |
| `metal-room` | 0.5076 | 0.5262 | 0.1082 | 0.1716 |  |
| `mountain-valley` | 0.1792 | 0.1879 | 0.2692 |  |  |
| `outdoor-hdri` | 0.0462 | 0.0403 | 0.0296 |  | 0.1242 |
| `spot-area` | 0.1242 | 0.1935 | 0.1707 |  | 0.0658 |
| `temple-hall` | 0.0659 | 0.2341 | 0.2394 | 0.0554 |  |

The mean of the 23 baseline scenes is 0.1746 for 67js and 0.1986 for EEVEE. The Khronos assets (`khronos.json`, own work directory) are scored over the pixels the asset changes, since the sky fills the frame and both sides draw it alike:

| Asset | Pixels covered | 67js against Cycles (asset only) | 67js against EEVEE (asset only) | EEVEE against Cycles (asset only) |
| --- | --- | --- | --- | --- |
| `AnisotropyBarnLamp` | 0.0732 | 0.3355 | 0.3891 | 0.3291 |
| `AnisotropyDiscTest` | 0.1074 | 0.2864 | 0.2771 | 0.1532 |
| `ClearCoatTest` | 0.1354 | 0.2097 | 0.1563 | 0.1303 |
| `SheenChair` | 0.1003 | 0.3316 | 0.3098 | 0.2299 |
| `TransmissionTest` | 0.1350 | 0.2539 | 0.2027 | 0.1590 |

## History

Dated notes below, kept where they explain a decision. Numbers in them are from the date they name, and those before 2026-11-01 use the sky with two suns.

## AgX and Khronos PBR Neutral against Blender 5.2.2 (2026-11-03, part of issue #282)

`environment.viewTransform: 'agx' | 'neutral'` (#319) against Blender's AgX and Khronos PBR Neutral view transforms.

Colour ramp (`scripts/blender-view-transform-golden.py`, rerun on 5.2.2: the output matches the committed `tests/fixtures/blender/view-transform-golden.json` byte for byte). 27 patches: 15 greys from 0 to 16 and 12 colours up to 5.0. Each is an emissive plane; the error is |67js - Blender| per channel in sRGB-encoded display units (0 to 1; 0.01 is 2.6 of 255 steps). `tests/view-transform.test.js` fails above the threshold.

| Transform | Threshold (max) | Max error | Mean error | Max per channel R, G, B | Within |
| --- | --- | --- | --- | --- | --- |
| `neutral` | 0.010 | 0.0079 | 0.0013 | 0.0079, 0.0052, 0.0079 | yes |
| `agx` | 0.026 | 0.0247 | 0.0026 | 0.0168, 0.0247, 0.0072 | yes |

`agx` was 0.0885 at most (mean 0.0252) before 2026-11-03, measured the same way. Blender 5.2's AgX is the EaryChow version, not the Troy Sobotka one the Filament/three.js polynomial copies: E-Gamut input, log2 over -12.47393 to +4.026 EV (the same range as before), a per-channel sigmoid with pivot at 0.18 grey (output 0.488, slope 2.39, toe and shoulder power about 1.5), a 2.4 power, then a matrix back to Rec.709 applied to the linear value. The differing steps were the sigmoid (the 6th-degree polynomial was too bright in the mid-tones: grey 0.18 gave 0.501 against Blender's 0.461), the matrices (Rec.2020 inset and outset against Blender's gamut-specific LUT) and the output power (2.2 against 2.4 before the matrix). `src/view-transform.js` now holds a fit of `AgX_Base_sRGB.cube`: the sigmoid is fitted to the LUT's grey diagonal (within 0.0013 in the 2.4-encoded value), the two matrices to random colours. Grey 0.18 maps to 0.460 (Blender 0.461); the grey patches are within 0.0012. The rest of the error is saturated colour (worst patch 2.0, 0.8, 0.1, green channel), which a per-channel sigmoid and two matrices cannot follow exactly, so the threshold is 0.026. `neutral` follows Blender to within 2 steps of 255 (the Khronos formula is the same).

Scenes: `npm run reference -- --view-transform agx --scene <id>,<id>` draws 67js with `viewTransform: 'agx'`, renders Cycles with the AgX view transform (same samples, denoising and scene description as the suite; 8-bit sRGB PNG, so both sides are quantised), and scores them with FLIP. Blender's sRGB picture is decoded and encoded with the 2.2 power 67js uses, so the score measures the curve and the lighting, not the transfer function. The standard column is the suite's own score (Cycles with the `Raw` transform, then the ACES fit on both sides, `baseline.json`).

| Scene | `agx` before (2026-11-03, #343) | `agx` after (2026-11-03) | Standard (ACES fit both sides) |
| --- | --- | --- | --- |
| `outdoor-hdri` | 0.0997 | 0.0425 | 0.0462 |
| `material-spheres` | 0.1467 | 0.0903 | 0.1293 |
| `character` | 0.1238 | 0.0581 | 0.0799 |

AgX now scores better than the standard row on all three (the mid-tone gap was the cause; the Cycles pictures were reused, only 67js was redrawn). The scores are in `view-transform.json`; Cycles ran on OptiX as in the suite, 67js on the RTX 3060.

## One sun (2026-11-01)

The HDRI holds its own sun: 6 of its 524,288 pixels carry 48.1 percent of the sky light, at 48 degrees of elevation. Most scenes also add a sun light. Cycles and EEVEE therefore drew two shadows of each object, and 67js drew one because its environment casts no shadow. `scenes.js` and `render-blender.py` now cap the image at radiance 16 on both sides, which removes the sun and its halo and keeps the clouds. The sky keeps 49.2 percent of its light. A scene with a sky now has only its own sun light.

`baseline.json`, `khronos.json`, `path-tracer.json`, `bake.json` and `images/` use the cap (the last three were rerun on 2026-11-03). Scores in the notes below that were measured before 2026-11-01 use the sky with two suns. Scenes with a constant world did not move when the cap went in.

## No shadow floor (2026-11-01)

A key shadow in 67js kept 18 percent of the sun (`src/shaders.js`, `src/cascaded-shadows.js`). A sealed hall was evenly lit, and every shadow was too light. A key shadow now blocks the sun fully. `fog` (+0.0031) and `megacity-dusk` (+0.0044) got worse, and all other scenes stayed level or improved.

Scores against Cycles, with each change in turn:

| Scene | Two suns, floor | One sun, floor | One sun, no floor (now) | EEVEE now |
| --- | --- | --- | --- | --- |
| `outdoor-hdri` | 0.0676 | 0.0466 | 0.0462 | 0.0403 |
| `character` | 0.0995 | 0.0823 | 0.0799 | 0.0622 |
| `glass` | 0.1326 | 0.1033 | 0.1034 | 0.1009 |
| `car-paint` | 0.1521 | 0.1084 | 0.1059 | 0.0844 |
| `brushed-film` | 0.1613 | 0.1172 | 0.1149 | 0.0984 |
| `metal` | 0.1868 | 0.1309 | 0.1294 | 0.0916 |
| `material-spheres` | 0.1598 | 0.1337 | 0.1312 | 0.1053 |
| `foliage` | 0.1594 | 0.1346 | 0.1173 | 0.0888 |
| `brick-flat` | 0.1999 | 0.1273 | 0.1272 | 0.1098 |
| `brick-graph` | 0.2269 | 0.1604 | 0.1602 | 0.1221 |
| `long-street` | 0.1555 | 0.1555 | 0.1407 | 0.0976 |

The mean over the 16 older scenes went from 0.2001 to 0.1751 to 0.1732. EEVEE is at 0.1645.

## Grand scenes (2026-11-01)

Three scenes test what people want to make, not one feature. Each one is built with engine code, and Blender gets the same geometry.

| Scene | Parts | Triangles drawn | 67js against Cycles | EEVEE against Cycles | Largest visible gap |
| --- | --- | --- | --- | --- | --- |
| `megacity-dusk` | 4,300 | 51.6 thousand | 0.1627 | 0.1524 | Window bands are sharper, and facades get no light from the windows |
| `mountain-valley` | 7,698 | 9.72 million | 0.1792 | 0.1879 | The valley floor and the trees are 1.3 to 1.7 times as bright as in Cycles, and shadowed rock is brighter (see "Sky visibility in crowns and valleys") |
| `temple-hall` | 155 | 11 thousand | 0.2126 | 0.2341 | The fog shafts are stronger in 67js, and the floor gets no bounce light |

With the shadow floor `temple-hall` scored 0.5841, `mountain-valley` 0.3658 and `megacity-dusk` 0.1583.

`temple-hall` sets its own `bakeOptions`. The defaults need 1.4 million texels, and the bake allows 1 million. With the options the bake scores 0.2239, against 0.2126 without it.

### Options for the grand scenes (2026-11-02, part of issue #168)

The three scenes measure well and look plain, so `grand-scenes.js` holds three options of each, `-a`, `-b` and `-c`, each a different composition, light and time of day. `npm run reference -- --grand` draws them on both sides into `grand.json` and `images/grand-<id>.jpg`; `baseline.json` and the other images are unchanged. `python bench/reference/grand-sheets.py <directory>` (command in its header) writes one comparison sheet per scene. An picks by letter, and a later change moves the pick into `REFERENCE_SCENES`. Blender draws the same geometry; the sky is the same equirectangular gradient on both sides (`gradient` world type), and every window, lamp and sky panel is Emission.

| Option | What it is | 67js against Cycles | Cycles seconds |
| --- | --- | --- | --- |
| `mountain-valley-a` | Golden hour at a lake, sun from the left, rocky shore in the foreground | 0.3530 | 26.3 |
| `mountain-valley-b` | Midday from a high slope, a river winding down a flat valley floor | 0.1839 | 24.5 |
| `mountain-valley-c` | Alpenglow on one tall peak, forest edge close to the camera | 0.2282 | 52.7 |
| `temple-hall-a` | Four clerestory windows throw slanted sun shafts across the nave, people in the light | 0.2530 | 21.7 |
| `temple-hall-b` | Square oculus hall: ring of columns, one beam on a gilded seated figure | 0.3642 | 25.4 |
| `temple-hall-c` | Setting sun down the nave axis through a tall opening, columns as silhouettes in glowing fog | 0.2746 | 23.4 |
| `megacity-dusk-a` | Blue hour on a river with lit bridges and quays | 0.1978 | 28.9 |
| `megacity-dusk-b` | Sunrise across a bay from a pier, skyline and its reflection | 0.1575 | 33.2 |
| `megacity-dusk-c` | Night, high view over an avenue grid of car lights and dense lit towers | 0.1149 | 35.9 |

Known gaps in the 67js side: a lake or bay shows the sky only, where Cycles also mirrors the shore, the trees and the towers; the dark halls have no bounced light.

## Dark spaces (2026-11-01, part of issue #159)

`dark-shaft` is a closed stone room, 11 m by 15 m and 6.5 m high, with one 2.2 m opening in the roof. The sun comes through it as a shaft in `volumeFog` (density 0.07) and lands on the floor and on a plinth with an urn. There is no HDRI, and the world is a constant 0.03, as in `temple-hall`.

A whole-frame score hides a mostly black frame, so a scene can declare `brightRegion: { luminance, dilation }` in `scenes.js`. `score.py` takes the pixels where the Cycles image is brighter than `luminance` in display space (0.1), grows them by `dilation` pixels (4), and also scores the FLIP error inside them: `region-pixels` (share of the frame), `region-gpu-vs-cycles`, `region-gpu-vs-eevee` and `region-eevee-vs-cycles`. Cycles picks the region, so neither renderer under test decides what is scored. `dark-shaft` and `temple-hall` declare one (9.9 and 9.6 percent of the frame); every other column is unchanged.

Gap 2 of the issue, measured: `node bench/reference/run.mjs --scene <id> --skip-blender --ambient 0` draws a scene in 67js with the world's light removed from every surface. In `dark-shaft` the region score goes from 0.2157 to 0.1676 and the whole frame from 0.2321 to 0.2310, so the world light does reach inside the closed room and the walls were lighter than in Cycles. In `temple-hall` the whole frame improves (0.2126 to 0.2028) and the region gets worse (0.2512 to 0.3012): the hall has open roof slots, and the world light is right there. So the leak is real, and removing the world is not the fix.

The fix is in the bake. It already shoots cosine rays from every texel, and a ray that leaves the scene on its first leg has seen the sky. The share of those rays is the sky visibility of the texel, and it costs no extra ray. A part that sees less than 98 percent of the sky on average gets that visibility as an `occlusionMap` (linear, one byte, read through the lightmap UVs), which the shader already multiplies into the world's diffuse light and into its reflections. A part that sees the sky (open scenes, ground) gets no map and draws exactly as before. A part with an `occlusionMap` of its own keeps it. There is no new recipe field and no shader change.

Compared on 2026-11-01 (RTX 3060, 67js side only; Cycles and EEVEE images are the earlier ones):

| Option | `dark-shaft` whole | `dark-shaft` region | `temple-hall` whole | `temple-hall` region |
| --- | --- | --- | --- | --- |
| No bake (committed baseline) | 0.2321 | 0.2157 | 0.2126 | 0.2512 |
| World light off (measurement only) | 0.2310 | 0.1676 | 0.2028 | 0.3012 |
| Screen space occlusion, radius 4 | 0.2203 | 0.2120 | 0.2117 | 0.2521 |
| Bake before this change | 0.2612 | 0.2369 | 0.2239 | 0.2374 |
| Bake with sky visibility | 0.1301 | 0.1710 | 0.1129 | 0.2528 |
| EEVEE | 0.2653 | 0.2643 | 0.2341 | 0.2455 |

Screen space occlusion only darkens creases, so it does not change a room's walls. The bake before this change added bounced light and left the leak, so `dark-shaft` got worse. With sky visibility the whole frame of both scenes roughly halves its distance to Cycles. The shaft region of `temple-hall` did not move (0.2512 to 0.2528): its error is in the fog shafts, which this change leaves alone. `npm run reference -- --bake dark-shaft,temple-hall` draws the baked rows; their sheets are `images/dark-shaft-baked.jpg` and `images/temple-hall-baked.jpg`. The baked rows are not in `baseline.json`, as with the other bake rows. `dark-shaft` bakes 109,904 texels in 12 s and `temple-hall` 440,192 texels in 46 s (`bakeOptions` of the scene, another session loading the machine). Scores in this table are 2 bounces; with the default of 3 bounces from 2026-11-02 the baked rows are 0.0609 and 0.0560 whole frame after the later fog and streak changes (see "Baked rooms and the bounce count").

The no-bake scores of the five outdoor scenes are the same to four digits after a full rescore (`outdoor-hdri` 0.0462, `character` 0.0799, `metal` 0.1294, `car-paint` 0.1059, `foliage` 0.1290), and a scene without a bake runs the same shaders as before. A baked part that sees the sky is unchanged; outdoor scenes were not re-measured with a bake.

Frame cost of a baked room (`node bench/reference/frame-time.mjs dark-shaft gpu`, 960 x 540, RTX 3060 shared with other jobs, so noisy): plain 2.34 and 2.47 ms in two runs, baked with sky visibility 2.98 and 3.86 ms, and the same bake without it 2.04 ms against 2.04 ms plain. So the occlusion map costs roughly 0.6 to 1.4 ms in a closed room on this load; treat it as a measured range, not a figure. Only a baked part that sees under 98 percent of the sky pays it.

## Fog shafts (2026-11-02, part of issue #159)

Gap 3 of the issue, measured on the 67js renders against the Cycles arrays (`volumeFog` in `src/post.js`). The phase function and the units were checked first and are correct: `volumeLightColor` is the sun irradiance, the Henyey-Greenstein term has its 1/4 pi, and the sign of `anisotropy` matches Blender's Volume Scatter, so no tuning constant sits on a bug. Step placement was tried and does not matter: spacing the steps by distance squared moved `dark-shaft` from 0.1292 to 0.1295 and `temple-hall` from 0.2381 to 0.2378, so that change was dropped.

Two errors carry the score:

- **A constant ambient term in a closed room.** The fog adds `ambient` (0.02) everywhere, as if the world lit it. In `dark-shaft` the 67js frame is 0.0125 in linear luminance away from the shaft, where Cycles has 0.002 to 0.006, because a closed room does not see the world. With the fog ambient set to zero the whole frame goes from 0.2321 to 0.1144 and the region from 0.2157 to 0.1728. The ambient now keeps 15 percent of its value where the sun's shadow map says the fog is in shadow, and all of it where the sun reaches the fog.
- **No glow around a bright source.** Cycles scatters the light of bright pixels sideways. Around the lit door of `temple-hall`, the mean linear luminance in a ring 30 to 45 pixels from the door is 0.1055 in Cycles and 0.0373 in 67js (EEVEE 0.0526). The fog now adds a blur of the frame: 24 taps over about 14 percent of the frame height, weighted by the fog's opacity along the ray (`1 - transmittance`) and tinted by the fog colour. The taps are rotated by the same per-pixel jitter as the steps. The same ring now reads 0.0974, and every ring out to 300 pixels is within 0.008 of Cycles. The blur radius and the weight (0.009) are fitted to that profile and to the two region scores; they are not a recipe field.

Scores against Cycles on 2026-11-02, whole frame (shaft region), RTX 3060, 67js side only:

| Scene | No bake before | No bake now | Baked before | Baked now | EEVEE |
| --- | --- | --- | --- | --- | --- |
| `dark-shaft` | 0.2321 (0.2157) | 0.1425 (0.1219) | 0.1301 (0.1710) | 0.0669 (0.1814) | 0.2653 (0.2643) |
| `temple-hall` | 0.2126 (0.2512) | 0.1438 (0.2341) | 0.1129 (0.2528) | 0.0716 (0.2575) | 0.2341 (0.2455) |
| `fog` | 0.2643 | 0.2238 | | | 0.2662 |

The region of `dark-shaft` improved clearly without a bake (0.2157 to 0.1219). The region of `temple-hall` moved less (0.2512 to 0.2341). What is left there is haze outside the shafts, where 67js is 0.0095 and Cycles 0.0033. A higher ambient floor lowers the region score (0.2100 at a floor of 0.4) but raises the region of `dark-shaft` (0.1676) and both whole-frame scores, so one constant cannot serve both scenes. The baked rows improved as a whole frame and got slightly worse in the region (0.1710 to 0.1814, 0.2528 to 0.2575): the bake already darkens the walls, and the fog change takes light from the same pixels. `fog` improved by 0.0405, well inside the limit. Every other scene has the same scores to four digits, and a scene without `volumeFog` runs the same post shader as before.

Cost: `frame-time.mjs dark-shaft gpu`, plain frame, two runs each on a loaded machine: 1.9 and 2.1 ms before, 2.1 and 2.3 ms after, so about 0.1 to 0.3 ms for the 24 extra taps. The core entry grows by 115 bytes gzip (83,853 to 83,968), and six size budgets rose by 50 to 100 bytes because their bundles contain the post shader. `images/dark-shaft-baked.jpg` and `images/temple-hall-baked.jpg` come from `npm run reference -- --bake dark-shaft,temple-hall`.

## Streaks and speckle in dark scenes (2026-11-02, part of issue #159)

FLIP does not punish two defects that show at a glance in the baked frames and around the door of `temple-hall`, so `bench/reference/noise.py` measures them. It takes the display-space luminance of a frame, subtracts a gaussian blur of it (sigma 6 px) and reports the standard deviation of what is left, as a percentage, over two regions chosen from the Cycles image: `dark` (Cycles under 0.1 and more than 12 px from any brighter pixel, where walls, ceiling and floor sit) and `glow` (30 to 60 px from the pixels where Cycles is over 0.5, the ring around the door). Cycles has its own path tracing noise, so its value is the floor a clean render reaches, not zero.

**Bake streaks.** Cause, measured: `planLightmaps` unwrapped each geometry once, at unit size, and gave every part that shares it the same layout. The hall's walls, floor and carpet all share the unit box, so a 2 x 32 x 180 m wall got one square of the lightmap per face, the same as a 2 m cube. The texels were 90 times longer than wide on the wall, 180 times on the floor and 2,867 times on the carpet (up to 5 m long, 0.002 m wide), which draws as streaks that fan out from the vanishing point along every long edge, and as the red lines on the carpet. The unwrap now sees the part at its world size (the length of each matrix column, normals by the inverse transpose), is cached per geometry and scale, and gives texels of equal size both ways (stretch 1.00 on all three parts). A second effect stayed once the streaks were gone: each texel has only 48 rays, so the lightmap was grain. `smoothTexels` now blurs the gathered light and the sky visibility over neighbouring texels (two passes of a gaussian, sigma 1.5 texels, a 7 x 7 window) and counts a neighbour only when it lies on the same plane (normal dot above 0.9, within one texel of this texel's plane), so a corner, a seam and the gap between two parts do not leak. Only fixing the stretch made the metric worse (`temple-hall` baked 0.448 to 0.443, `dark-shaft` baked 0.318 to 0.375) because streaks became fine grain; the smoothing is what lowers it.

**Glow speckle.** Cause, measured: the 24 taps of the fog's glow each read one pixel of the frame, rotated by the per-pixel step jitter, so the sum is a different 24 samples per pixel. Without the jitter the same taps draw ghost copies of the door. Each tap now reads the frame's mip chain at the level that covers the gap between neighbouring taps (`log2(0.7 * radius in pixels)`), with no jitter, so the 24 taps add up to a smooth blur. The renderer builds the mips only for a frame with `volumeFog`, and puts the texture back to a plain linear filter when the fog goes away. The ring profile is kept: the mean display luminance 30 to 45 px from the door is 0.0889 before and 0.0903 after, against 0.1000 in Cycles.

High frequency energy against Cycles (`dark` / `glow`; lower is smoother), 67js render on 2026-11-02:

| Scene | Cycles | Before | After |
| --- | --- | --- | --- |
| `temple-hall` baked | 0.158 / 1.053 | 0.448 / 1.826 | 0.182 / 0.990 |
| `temple-hall` no bake | 0.158 / 1.053 | 0.182 / 1.539 | 0.161 / 0.826 |
| `dark-shaft` baked | 0.140 / 0.140 | 0.318 / 0.643 | 0.150 / 0.310 |
| `dark-shaft` no bake | 0.140 / 0.140 | 0.105 / 0.505 | 0.085 / 0.256 |

Scores against Cycles, whole frame (shaft region), before this change and after:

| Scene | No bake before | No bake now | Baked before | Baked now |
| --- | --- | --- | --- | --- |
| `dark-shaft` | 0.1425 (0.1219) | 0.1430 (0.1273) | 0.0669 (0.1814) | 0.0653 (0.1847) |
| `temple-hall` | 0.1438 (0.2341) | 0.1436 (0.2305) | 0.0716 (0.2575) | 0.0578 (0.2550) |
| `fog` | 0.2238 | 0.2242 | | |

The region of baked `dark-shaft` and of plain `dark-shaft` got a little worse (0.0033 and 0.0054), the cost of a smoother glow. Every scene without `volumeFog` and every unbaked scene keeps its scores to four digits. Baked rooms on the same machine and the same scoring: `lit-interior` 0.1974 before and 0.1915 now, `brick-room` 0.2070 and 0.2048 (the 0.1444 and 0.1515 in the CHANGELOG are not explained by the sun or shadow changes; the sky visibility map exposed the 2 bounce default, see "Baked rooms and the bounce count"). `temple-hall` keeps `bakeOptions` `{ texelsPerUnit: 2, samples: 48, maxSeconds: 300 }`: the bake now has 456,000 texels (440,192 before), under the 1 million limit. Bake time did not change measurably (`temple-hall` 37 to 49 s in the runs of both versions, `dark-shaft` 9 to 13 s, on a loaded machine). `brick-room` has 98,848 texels where it had 28,576, because thin parts no longer share one small square; its bake still takes 3.5 s.

A part's `skyVisibility` in the bake report is now a mean over texels spread by area, so a floor slab reads 0.5 (its top face sees the closed room, its underside sees outside) where every face counted the same before (a slab's four sides then outweighed its top).

Cost: the core entry grows 92 bytes gzip over the fog change (83,968 to 84,060; 207 bytes over the 83,853 before it). `frame-time.mjs dark-shaft gpu`, plain frame on a shared machine: 2.75 and 2.81 ms, where the fog change measured 2.1 and 2.3, so the mip chain costs about 0.5 ms for a frame at 960 x 540 (noisy). Size baseline and budgets were rewritten.

## Baked rooms and the bounce count (2026-11-02, part of issue #159)

After the sky visibility change, `lit-interior` and `brick-room` baked scored 0.1974 and 0.2070 against Cycles, where the code before it scored 0.1444 and 0.1515. The occlusion map is correct: a closed room has no sky to see, and Cycles gives it none. It exposed a different error. The bake followed 2 bounces by default, which cuts off light that a room with walls of albedo 0.7 would still receive, and the world's diffuse light had been filling that gap by accident.

Measured on the baked `lit-interior` (display luminance, whole frame, Cycles 0.4719): 2 bounces with the occlusion map 0.4336 (8.1 percent dark), 2 bounces with the map switched off 0.4532 (4.0 percent dark), so the map removed the 4 percent that was hiding the missing bounces. Every region (floor, walls, back wall, table) was 3 to 12 percent darker than Cycles, none lighter. The map reaches only the world's diffuse light and reflections: the shader adds the light map as a separate term, and a point light is not multiplied by it. Score of `lit-interior` by option, 2026-11-02, RTX 3060:

| Option | `lit-interior` | `brick-room` |
| --- | --- | --- |
| Occlusion map off, 2 bounces | 0.1384 | |
| Occlusion map on, 2 bounces (before this change) | 0.1915 | 0.2048 |
| Occlusion map on, 3 bounces (now the default) | 0.1341 | 0.1412 |
| Occlusion map on, 4 bounces | 0.1092 | 0.1095 |

`bounces` now defaults to 3 in `bakeLightmaps`. A geometric tail for the cut-off bounces (the last bounce's ratio to the one before, summed) was tried and dropped: it overshot and scored 0.2302, 0.2492 and 0.1063 on `lit-interior`, `brick-room` and `dark-shaft`. Recipe presets name their bounces (draft 1, standard 2, fine 2) and are unchanged.

Baked scores against Cycles, whole frame (shaft region), before and after:

| Scene | 2 bounces | 3 bounces |
| --- | --- | --- |
| `lit-interior` | 0.1915 | 0.1341 |
| `brick-room` | 0.2048 | 0.1412 |
| `metal-room` | 0.2232 | 0.1656 |
| `dark-shaft` | 0.0653 (0.1847) | 0.0609 (0.1763) |
| `temple-hall` | 0.0578 (0.2550) | 0.0560 (0.2529) |

Cost: the bake takes more path steps. `temple-hall` 38.9 to 74.9 s, `dark-shaft` 9.0 to 17.5 s, `lit-interior` 4.0 to 5.8 s, `brick-room` 4.3 to 5.2 s, `metal-room` 5.6 to 7.1 s (one run each, shared machine). The frame is unchanged: no shader or bundle code moved. A bake that passes `bounces: 2` keeps the old time and the old light.

## Closed rooms without a bake (2026-11-02, issue #163)

Without a bake, `dark-shaft` scores 0.1430 against Cycles and `temple-hall` 0.1436; with the default bake 0.0609 and 0.0560. An agent that never asks for a bake gets the first pair. Three ways to close the gap were weighed.

| Option | `dark-shaft` | `temple-hall` | Cost | Verdict |
| --- | --- | --- | --- | --- |
| No bake | 0.1430 | 0.1436 | none | the gap |
| Sky visibility alone, no light written, 0.5 texels per unit, 16 samples | 0.1021 | 0.0856 | bake 0.1 s and 0.9 s (1,168 and 102,048 texels) | measured, not shipped |
| Sky visibility alone, 1.5 texels per unit, 16 samples | 0.1026 | 0.0859 | bake 0.2 s and 3.2 s (7,904 and 340,752 texels) | density does not matter |
| Default bake (3 bounces) | 0.0609 | 0.0560 | 17.5 s and 75 s | the target |
| `scene_inspect` names the bake | 0.0609 once the agent adds it | 0.0560 | no frame cost, no schema | shipped |

Sky visibility alone gets about half of the bake's gain (`dark-shaft` 0.1430 to 0.1021 of 0.0821, `temple-hall` 0.1436 to 0.0856 of 0.0876) in a second. It does not shoot light, so the room keeps no bounced light and the sun shaft region gets worse (0.3066 and 0.2660, against 0.1763 and 0.2529 with the bake). `node bench/reference/run.mjs --skip-blender --bake dark-shaft,temple-hall --sky-only 0.5,16` draws these rows; `bakeSkyVisibility` in `src/light-bake.js` is the function. A density of 3 texels per unit with 32 samples was started and stopped on a loaded machine, so it has no number.

Why it is not applied on its own. The agent scene loads its bake code on demand, picked by a text marker (`"bake":{`) in the recipe, and `createAgentScene` is synchronous. A scene that asks for nothing has no marker, so an automatic bake would make every recipe load the ray tracer or add a second detection path before the scene exists. The lifted look would also become a half-fix (0.10, not 0.06) that hides the cheaper full answer from the agent. A new recipe field was not added: an agent that does not know a closed room needs one would not set it.

What ships: a `closed-room-without-bake` diagnostic in `scene_inspect` (`src/closed-room.js`). It shoots 48 fixed rays from the middle of the scene's bounds and counts a hit only on a triangle whose front face looks at the ray, so a solid object around the centre is never a room. At 90 percent or more (the share the automatic reflection probe already uses) and with no `bake` in the recipe, the result carries a warning that names `"bake": { "preset": "standard" }` and `scene_apply set-bake`. Nothing runs per frame: the test runs in `scene_inspect`, is kept until the scene's revision changes, and skips scenes of more than 150,000 triangles. Measured worst case, with no ray hitting anything, is 30 ms at 20,000 triangles and 140 ms at 150,000. A six-slab test room is detected (the reference scenes are drawn in the harness page, so `dark-shaft` itself was not run through it); the same room with its roof removed, a lone box and a recipe with a bake are not (`tests/closed-room.test.js`).

The no-bake scores of every scene are unchanged: no shader, renderer or scene build code moved, and the full rescore after this change matches the committed `baseline.json`. Size: the agent scene entry grows by 884 bytes gzip and `light-bake` by 158; every budget still holds, so none changed. Whether a cold agent follows the existing rule in the skill without the diagnostic was not measured: the suite's tasks each need a reference recipe and checks, which cost more than the $1 the issue allowed.

## Reflections between objects (2026-11-02, issue #167)

A mirror sphere and a steel cylinder showed only the sky and a flat horizon, where Cycles and EEVEE show the floor and the other objects. Parts now take a probe of their own, and `metal` goes from 0.1294 to 0.1036 against Cycles (EEVEE 0.0916). That recovers 68 percent of the gap to EEVEE and does not reach it.

### Where the `metal` error was

FLIP error by region, before the change, on the existing 960 by 540 renders. The regions are discs projected from the object bounds, so a share of each shadow counts toward the object. The renders used here score 0.1336 against Cycles (the committed baseline said 0.1294), so read the columns against each other and not against the table above. Each cell is the region's share of the whole image mean, mean error times the share of pixels.

| Region | Pixels | 67js before | 67js with probes | EEVEE |
| --- | --- | --- | --- | --- |
| Chrome sphere | 5.6% | 0.0184 | 0.0145 | 0.0116 |
| Gold torus | 1.6% | 0.0016 | 0.0016 | 0.0016 |
| Copper box | 9.4% | 0.0307 | 0.0246 | 0.0248 |
| Steel cylinder | 2.8% | 0.0106 | 0.0078 | 0.0055 |
| Floor | 64.2% | 0.0702 | 0.0639 | 0.0565 |
| Sky | 16.5% | 0.0025 | 0.0025 | 0.0016 |
| Whole image | | 0.1336 | 0.1147 | 0.1014 |

The four reflective parts held 46 percent of the error before and 55 percent of the gap to EEVEE (0.0178 of 0.0322). The sphere's lower half showed sky below the horizon, where Cycles shows the grey floor, and the cylinder reflected no lit floor. The floor itself is not a reflector (roughness 0.8). Its remaining gap to EEVEE (0.0074 after the change, 0.0137 before) is indirect light and shadow softness, which a reflection does not change.

### Options

| Option | What it costs per frame | Score on `metal` | Status |
| --- | --- | --- | --- |
| One probe per reflective part, traced without that part | 1.51 ms plain against 1.58 ms with four probes (RTX 3060, medians of three alternating rounds of 200 frames; the spread between rounds was about 0.2 ms). A scene with no reflective part draws the same frame: no wrapper, no shader change. Once: a CPU trace of 128 by 64 texels per probe and a GPU prefilter on the first draw. | 0.1294 to 0.1036 | Built |
| Screen-space reflections | Not built. Inferred: a depth and colour pass before the reflective parts and a ray march for each reflective pixel, paid only by scenes with smooth metal. It shows only what is on screen, so the floor behind the camera and the back of an object stay missing. | not measured | Not built |
| Planar reflection for flat floors | Not built. A second scene draw for each mirror plane. The `metal` floor is rough, so it has nothing to reflect, and the `metal-room` floor is the only case here. | not measured | Not built |

A probe at the middle of the object and traced without it is the only option the code already supports, it costs no frame in a plain scene, and it gives a Cycles-like reflection of the floor and of other parts up to one bounce of direct light. A first version with one bounce had speckle on the floor (16 samples) and scored 0.1250 on the analysis renders; with no bounce and the sky's diffuse light added to each hit, it scored 0.1147. A first version without the sky light made the floor in the reflection black and scored 0.1457, worse than no probe (0.1336).

### What it does

`traceObjectProbes(parts, lighting, options)` in `src/probe-trace.js` finds the parts with `metallic` of at least 0.5 and `roughness` of at most 0.6, traces one 128 by 64 map at the middle of each one's bounds with that part left out, and returns the same shape as `traceProbes` plus the index of the part. `placeProbes` gives each such part its own probe. More than 8 reflective parts (lamp posts, spires) get none, because they read as shapes and not as mirrors. A trace shades a hit with the direct light, the part's colour (half the colour for metal) and the environment map's diffuse light. A ray that misses reads the environment map.

Object probes are now the default, as a recipe places them (`src/agent-reflections.js`, lit by the setup map); `environment.objectReflections: false` turns them off. `npm run reference` draws every scene with them, `-- --no-object-probes` without, and `-- --object-probes <id>,<id>` limits them to the named scenes. The committed `baseline.json` and `images/` are the default run (`metal` 0.1036 against 0.1294 without probes; 2026-11-03). Three tries to close the rest of the gap to EEVEE (0.0916) all scored worse and were not kept: one bounce at 64 samples (0.1246), seeing through the part itself so it still shadows what it shows (0.1117), and scaling the sky light of the shown surface by its sky visibility (0.1185).

### Scores against Cycles with `--object-probes` (GPU, full rescore, 2026-11-02)

| Scene | Before | After | EEVEE |
| --- | --- | --- | --- |
| `metal` | 0.1294 | 0.1036 | 0.0916 |
| `car-paint` | 0.1059 | 0.1038 | 0.0844 |
| `brushed-film` | 0.1149 | 0.1029 | 0.0984 |
| `material-spheres` | 0.1312 | 0.1293 | 0.1053 |
| `metal-room` | 0.5128 | 0.5076 | 0.5262 |

Every other scene scored the same to four digits, GPU and CPU. `car-paint` has one reflective part, so it gains little: the clearcoat sphere reflects the floor and nothing else. The issue's second box holds (no frame cost without a reflective part); its first box does not (`metal` is 0.012 above EEVEE).

## Reflections in still water (2026-11-02, issue #195)

A lake, a river or a bay showed only the sky, where Cycles mirrors the shore, the trees and the towers. A large flat smooth surface now draws the scene from the mirror image of the camera into a target half the canvas size in each direction, and samples that picture. `mountain-valley-a` goes from 0.3530 to 0.2562 against Cycles and `megacity-dusk-b` from 0.1575 to 0.1377. `megacity-dusk-a` (a river between quays) does not improve: 0.1978 to 0.1985.

### Options

Both options ran on the three water options and the two default scenes that hold such a surface. FLIP against Cycles, GPU, full rescore; frame time is the median of three alternating rounds of 200 frames on the RTX 3060 (`node bench/reference/frame-time.mjs <id> gpu --water --grand`), shared with other jobs.

| Option | `mountain-valley-a` | `megacity-dusk-b` | Frame, `mountain-valley-a` | Frame, `megacity-dusk-b` |
| --- | --- | --- | --- | --- |
| No reflection (before) | 0.3530 | 0.1575 | 6.37 ms | 2.78 ms |
| Screen-space reflection (`bench/reference/ssr-water.js`, 80 steps and 6 refinements, full resolution) | 0.3310 | 0.1423 | 7.25 ms | 4.09 ms |
| Planar reflection (`src/water-reflection.js`) | 0.2562 | 0.1377 | 10.70 ms | 4.82 ms |

The planar reflection wins on the score and costs more: it draws the scene a second time, at a quarter of the pixels but with all of the geometry. The screen-space version can only show what the frame holds, so it loses the shore's far side and anything behind a nearer surface; in `mountain-valley-a` the far peaks and the trees against the sky are most of what the lake shows. It stays in the harness (`--ssr-water`) as the comparison and is not shipped. The planar cost is what a scene with water pays: +4.3 ms and +2.0 ms here. A scene without water pays nothing: `temple-hall-a` measured 2.00 ms off, 1.90 ms planar and 1.80 ms screen-space, which is the spread of the machine, and its shader is the same text.

### What qualifies

No recipe field. `findWaterSurface(parts)` picks parts whose material has `roughness` of at most 0.1 and is not `liquid`, `foam`, `unlit`, `fire`, `smoke` or `floor` and has no `transmission`; whose bounds are flat (taller by at most 2 percent of the wider side); and whose footprint is at least 0.2 percent of the scene's. Metal qualifies the same way as water, so a polished floor reflects too. The largest such part sets the plane, at the top of its bounds, and parts within 5 cm of that height join it. One plane per frame: a second water level is not reflected. A camera below the plane draws no reflection. A narrow river in a wide scene qualifies at 0.2 percent and not at the 1 percent first tried; at 1 percent `megacity-dusk-a` was untouched.

### The look

A mirror looked fake: the first version, a hard reflection mixed in by the shader's own Fresnel, scored 0.2099 on `megacity-dusk-b`, worse than none. Three changes fixed it, in this order of effect:

1. The sky the lighting already adds to a smooth surface is taken out before the reflection is added, so the water does not get the sky twice (the reflection picture holds the sky).
2. Fresnel from the reflectance of water (0.02 at normal incidence): strong at grazing angles, faint when looking down into the water.
3. Small moving ripples shake the picture, more with distance, and eight taps smear it, more up and down than across, as ripples stretch a reflection.

Blur alone did not help: 12 taps over a wider area scored worse than 8 over a narrower one on both scenes (0.1944 against 0.1893 on `megacity-dusk-b`, before the sky was taken out). Water colour and depth near the shore are not done: the surface is a box and carries no depth, so the water has the body colour of its material everywhere. By eye, in the image of `mountain-valley-a` the lake reads as real still water: dark, strongly mirrored near the far shore and fading toward the camera. The bay in `megacity-dusk-b` reads as water too, and its reflection of the lit windows is brighter than Cycles': there the band of water is 0.34 where Cycles has 0.10, with or without the reflection, so that part of the gap is the water's body colour or the haze, not the reflection.

### Scores against Cycles (GPU, full rescore, 2026-11-02)

| Scene | Before | After | CPU before | CPU after |
| --- | --- | --- | --- | --- |
| `mountain-valley-a` | 0.3530 | 0.2562 | 0.3539 | 0.2567 |
| `megacity-dusk-b` | 0.1575 | 0.1377 | 0.1584 | 0.1371 |
| `megacity-dusk-a` | 0.1978 | 0.1985 | 0.1972 | 0.1980 |
| `mountain-valley-b` | 0.1839 | 0.1784 | 0.1840 | 0.1785 |
| `foliage` (default suite) | 0.1290 | 0.1181 | 0.1287 | 0.1178 |
| `mountain-valley` (default suite) | 0.3478 | 0.3490 | 0.3466 | 0.3478 |

The other 19 default scenes and the other 4 grand options re-scored identically to four digits, on GPU and CPU (`--no-water` reproduces the old numbers). Those two default scenes hold a qualifying surface, so they changed. `mountain-valley` is worse by 0.0012 and `megacity-dusk-a` by 0.0007.

### Size

The core grew by 374 bytes gzip in a `lit-box` scene (limit 400): a material field that batches parts, a feature name, a slot in the shader, and the second draw's target and early return. The reflection itself is the addon `67js/addons/water-reflection` (25,403 bytes gzip as an entry, budget 26,000). The shipped archive is 709,306 bytes.

### Use

```js
import { applyWaterReflection, attachWaterReflection } from '@codepawlhq/67js/addons/water-reflection';

const water = applyWaterReflection(parts);
const renderer = new Renderer67(canvas, water.parts, options);
attachWaterReflection(renderer, water.surface);
```

`water.surface` is null when no part qualifies, and `attachWaterReflection` then does nothing. A recipe scene does not place it yet: the recipe path has no hook that loads the addon from the materials, and that is the next piece of work. `npm run reference -- --no-water` draws the harness scenes without it.

## Why the river did not move (2026-11-03, issue #195)

`megacity-dusk-a` was picked up by `findWaterSurface` and the mirror image was drawn: the river is one flat box at 0.2 percent of the scene's footprint, roughness 0.04, and the pixels it covers changed (20 percent of the frame). The score did not move because the reflection was drawn too soft. In the changed pixels FLIP against Cycles was 0.536 with no reflection and 0.462 with an unblurred reflection, but the blurred one had given back almost all of it (the whole frame went 0.2084 to 0.2072). The towers' window bands are one to three pixels tall; a picture at a quarter of the pixels, smeared 6 pixels up and down, loses them, and Cycles keeps them. `megacity-dusk-b` is the opposite: its far skyline aliases at half size, and blur hid that. Ripple strength made no difference to any score (0.1972 with and without ripples).

Whole frame FLIP against Cycles, GPU, the three water options (the Cycles arrays are those of the earlier runs; the scenes are drawn from the current main, so the first row differs from the table above):

| Reflection picture, blur (across, down in screen share) | `megacity-dusk-a` | `megacity-dusk-b` | `mountain-valley-a` |
| --- | --- | --- | --- |
| No reflection | 0.2084 | 0.1593 | 0.2949 |
| Half size, 0.004 and 0.012 (#202) | 0.2072 | 0.1459 | 0.1946 |
| Half size, none | 0.1972 | 0.1556 | 0.1925 |
| Full size, none | 0.1952 | 0.1444 | 0.1919 |
| Full size, 0.004 and 0.012 | 0.2077 | 0.1371 | 0.1943 |
| Three quarters, 0.0015 and 0.0045 (shipped) | 0.1999 | 0.1242 | 0.1924 |
| Three quarters, 0.001 and 0.003 | 0.1980 | 0.1290 | 0.1922 |
| Three quarters, 0.0015 and 0.0045, gain 0.7 | 0.1800 | 0.1835 | 0.2055 |

The shipped picture is three quarters of the canvas in each direction with a blur of 0.0015 across and 0.0045 down. Every option that helps the river hurts the bay by about as much, so the pick is the one that gives the largest total gain (0.0073, 0.0217 and 0.0022 against #202); the river is 0.0085 better than no reflection, not the 0.03 of the unblurred full-size picture. GPU `megacity-dusk-a` 0.2072 to 0.1999 and CPU 0.2066 to 0.1992. Frame time on the RTX 3060 (`frame-time.mjs <id> gpu --water --grand`, one run each, shared with other jobs; the machine's spread is about 0.2 ms) shows no cost for the larger picture: `megacity-dusk-a` 0.8 ms off, 1.32 ms with the half-size picture and 1.35 ms with three quarters; `megacity-dusk-b` 2.39, 3.84 and 3.56 ms; `mountain-valley-a` 3.96, 6.35 and 6.30 ms. `grand.json` holds the new GPU and CPU scores against Cycles for these three rows; its EEVEE columns are the old ones, because the EEVEE renders of these scenes are not in the folder.

Still open, and not fixed here: the river's water is brighter than Cycles'. Scaling the reflection by 0.7 takes `megacity-dusk-a` to 0.1800 and costs the other two, so it is not a global gain: in Cycles the stretch of water between the towers is dark where 67js shows a light patch of sky. Nothing in the mirror image explains it, so it is likely the Fresnel curve or the haze on the Cycles side (the `FRESNEL_BASE` of 0 scores 0.1947, 0.1294 and 0.1925). The water's body colour and depth near the shore are untouched. The issue stays open.

The default suite does not hold a water scene any more on this main: `foliage` and `mountain-valley` draw the same pixels with and without the reflection (identical PNGs), and a full `--skip-blender` run before and after the change scored all 23 rows the same to four digits, GPU and CPU.

## The Fresnel curve is not why the river is bright (2026-11-03, issue #195)

Tried and not kept. The Cycles water in these scenes is a plain Principled BSDF (`WATER` in `grand-scenes.js`: colour 0.02, 0.05, 0.08, roughness 0.04, nothing else). `render-blender.py` leaves IOR at the default 1.5 and the specular level at 0.5, so it reflects 4 percent head on with the exact dielectric curve (inferred from those inputs). It has no transmission, no volume absorption and no body colour beyond that diffuse colour, and 67js gives the surface the same colour, so there is no body or shore depth term to add. The reflection's weight was Schlick from 0.02. Computed numerically, the exact curve for IOR 1.5 and that Schlick weight differ by under 0.04 at every angle in frame (elevation 1, 3, 5, 12 and 30 degrees: 0.904 against 0.917, 0.742 against 0.769, 0.613 against 0.641, 0.326 against 0.326, 0.089 against 0.051), so a curve cannot explain a river that is 60 to 70 percent brighter.

Whole frame / water pixels FLIP against Cycles (water pixels are the ones the shipped reflection changes: 25, 31 and 16 percent of the frame), GPU, one change at a time:

| Fresnel weight | `megacity-dusk-a` | `megacity-dusk-b` | `mountain-valley-a` | Total, whole frame |
| --- | --- | --- | --- | --- |
| Schlick from 0.02 (shipped) | 0.1999 / 0.3429 | 0.1242 / 0.1926 | 0.1924 / 0.1442 | 0.5165 |
| Exact, IOR 1.5 (Blender's) | 0.2056 / 0.3662 | 0.1148 / 0.1670 | 0.1933 / 0.1502 | 0.5137 |
| Exact, IOR 1.33 | 0.1944 / 0.3219 | 0.1420 / 0.2317 | 0.1957 / 0.1652 | 0.5322 |

Blender's own curve helps the bay and costs the river 0.0057, over the 0.002 allowed; real water's curve does the opposite and costs the bay 0.0178. The two scenes ask for opposite weights from the same code, so the weight is not the cause, nothing was kept, and `src/water-reflection.js` is unchanged.

Where the brightness comes from: mean display luminance over the river pixels of `megacity-dusk-a` in six horizontal bands (rows 305, 344, 383, 422, 461, 500 on), Cycles against 67js. In the lower bands the reflection adds almost nothing, so they do not depend on it.

| Rows from | 305 | 344 | 383 | 422 | 461 | 500 |
| --- | --- | --- | --- | --- | --- | --- |
| Cycles | 0.216 | 0.180 | 0.129 | 0.121 | 0.103 | 0.099 |
| 67js, no reflection | 0.423 | 0.345 | 0.288 | 0.226 | 0.182 | 0.149 |
| 67js, shipped | 0.354 | 0.326 | 0.215 | 0.226 | 0.180 | 0.154 |

The bay and the valley are within 0.02 of Cycles in the same bands, so it is specific to the canyon. In the picture the sidewalks and tower faces that the river mirrors are lighter in 67js than in Cycles too. The reading (inferred, not isolated): the towers stand close together and Cycles lets only a slice of the sky reach them, while 67js lights them with the whole sky. With `--ambient 0` the river bands fall to 0.298, 0.259, 0.146, 0.169, 0.126 and 0.111, towards Cycles. Haze is not it, since the nearest band is as far off as the farthest. So the remaining gap is the light on the mirrored city (sky occlusion in narrow streets), and a reflection gain of 0.7 only trades one scene's error for another's. #195's done-when for the three water options was already met by #202 and #230 (all three scores moved towards Cycles, scenes without water unchanged), so this adds no change and closes nothing by itself.

## Fog on two more scenes, and a seam in baked rooms (2026-11-02, issues #164 and #165)

**New scenes.** `fog-valley` is open ground under the HDRI sky with a low sun ahead of the camera, 48 blocks from 25 m to 400 m away and `volumeFog` density 0.005 over the whole field. `fog-room` is a 5 m square room with a window, density 0.2, a constant 0.05 world and the sun coming through the window as a shaft; it declares a `brightRegion` (24.3 percent of the frame). Both are built from engine code, so Blender gets the same geometry. Scores against Cycles on 2026-11-02 (RTX 3060):

| Scene | 67js whole frame | EEVEE whole frame | 67js region | EEVEE region |
| --- | --- | --- | --- | --- |
| `fog-room` | 0.1953 | 0.3730 | 0.1682 | 0.3146 |
| `fog-valley` | 0.1967 | 0.1952 | | |

`fog-room` beats EEVEE by a wide margin with the constants of #161 unchanged. `fog-valley` is 0.0015 behind EEVEE, which is inside the CPU and GPU spread of that scene (`gpu-vs-cpu` 0.0122), so the constants hold on a scene they were not fitted to. Every other scene keeps its score to four digits.

**Constants derived from the scene (tried, not kept).** The ambient floor of 15 percent in shadow is the constant most likely to be wrong in an open scene, so I measured the share of the sky that the fog's air sees: a grid of 512 points in the volume, 48 rays each, and the sun's shadow of each point. The ambient is scaled by the share the sunlit points see, and the shadowed fog keeps the ratio of the two shares. Results against Cycles, region in brackets:

| Scene | Constants of #161 | Ambient times sunlit share | Same, with the shadow ratio |
| --- | --- | --- | --- |
| `temple-hall` no bake | 0.1436 (0.2305) | 0.1334 (0.2513) | 0.1329 (0.2519) |
| `temple-hall` baked | 0.0559 (0.2523) | 0.0741 (0.2702) | 0.0751 (0.2708) |
| `dark-shaft` no bake | 0.1430 (0.1273) | 0.1230 (0.1080) | 0.1226 (0.1080) |
| `dark-shaft` baked | 0.0607 (0.1769) | 0.0792 (0.2259) | 0.0798 (0.2259) |
| `fog-valley` no bake | 0.1967 | | 0.1998 |
| `fog-room` no bake | 0.1953 (0.1682) | | 0.1512 (0.1820) |

It improves the whole frame of three plain scenes and the region of `dark-shaft`, and worsens both baked rows, the region of `temple-hall`, `fog-valley` and the region of `fog-room`. The region of `temple-hall` is the pixels that Cycles shows bright, and there the fog wants more ambient, not less: a mean share per volume takes light from points that see the sky through the roof slots. A per-point share needs a 3D texture in the post shader, which is more than the 150 byte limit of the core entry, and I did not build it. The change was reverted, so `src/post.js` is as before and #164 is not fixed.

**The corner line in baked `dark-shaft` (#165).** Measured with a ridge detector on the dark pixels (a pixel brighter than the pixels 3 to 4 px away on both sides): the plain frame has none above 0.03 display luminance, and the baked frame had a 56 px diagonal ridge at the right wall and floor corner (x 767 to 797, y 316 to 337) plus thin lines along the tops of the slabs. It is a bake seam leak. The unwrap packs charts one texel apart, so the texel just outside a chart's edge is the gutter, and `dilate` filled it with the average of every covered neighbour, including the neighbouring chart. The wall's inner face sits next to the outer face, which sees the whole sky: its sky visibility texel read 128 of 255 where the interior reads 1 or 2, and the bilinear read at the wall's bottom edge took about 20 percent of it. `rasterizeTexels` now gives a texel within 0.75 texel of a chart to the nearest triangle, at the nearest point on its edge, so a chart edge is sampled at its own surface; the sky visibility mean counts only texels inside a chart, so the area weighting of `skyVisibility` is unchanged. After the change the edge texel reads 1 against 1 in the row above, and the ridges are gone. The baked rows moved as a side effect: `dark-shaft` 0.0653 (0.1847) to 0.0607 (0.1769) and `temple-hall` 0.0578 (0.2550) to 0.0559 (0.2523).

Region scores, before and after this change, against Cycles (EEVEE in brackets): `temple-hall` 0.2305 and 0.2523 baked (0.2455), `dark-shaft` 0.1273 and 0.1769 baked (0.2643). Only the baked rows moved, and they moved down.

## Baseline

Taken on 2026-10-30, under the sky with two suns, and replaced by "Scores now". The notes below explain decisions; their numbers are from the dates they name.

Rows are the baseline taken before shadows for point lights. The `lit-interior` scene now sets `castShadow` on its three point lights. With shadows, 67js scores 0.5055 against Cycles (0.4997 before, so 0.0058 worse) and 0.0923 against EEVEE (0.1204 before, better): the shadow shape now matches, but Cycles fills its shadows with indirect light and 67js leaves them dark. The committed `lit-interior` row stays at the earlier numbers. `spot-area` is new with shadows, a spot light and an area light.

Light bake (issue #55): `npm run reference -- --bake lit-interior` bakes bounced light into the room with `addons/light-bake` (defaults: 128 samples, 3 bounces since 2026-11-02, 25,648 texels, about 6 s on this machine) and leaves the scene itself unchanged; Blender still gets the plain scene. Measured 2026-10-31 on the RTX 3060: `lit-interior` against Cycles goes from 0.5055 to 0.1444 (SwiftShader 0.5051 to 0.1439), and against EEVEE from 0.0923 to 0.4739, because EEVEE has no indirect light here and the bake adds it. No other scene moved by more than 0.002 (the largest change was 0.0001, `car-paint` against EEVEE). The committed baseline rows and images are not rewritten. The remaining gap shows in the FLIP image as faint blotches on the walls, which is bake noise at 128 samples; at 48 samples the blotches were plain to see and the score was 0.1688.

`long-street` and `light-linking` (issue #52) were added on 2026-11-01. `long-street` is a 140 m street under the sun with 24 buildings, 14 lamp posts and four cars near the camera; one 2048 x 2048 sun map covers 170 m, so its texels are 8 cm wide. Against Cycles it scores 0.1555 with one map and 0.1398 with three cascades (`npm run reference -- --cascades 3`; SwiftShader 0.1554 and 0.1399; against EEVEE 0.1396 and 0.1147; EEVEE against Cycles 0.0975). Frame time on the RTX 3060 (960x540, 4 samples, 200 frames read back, median of two runs of each, `node bench/reference/frame-time.mjs long-street gpu --cascades`): 1.04 ms with one map and a still camera, 1.02 ms with a camera that moves every frame, 1.09 ms with three cascades and a still camera, 1.24 ms with three cascades and a moving camera, so the cascades cost about 0.2 ms (20 percent) in a camera move and next to nothing while the camera is still. On SwiftShader (median, `cpu`): 241 ms, 240 ms, 282 ms and 299 ms, so +17 percent still and +25 percent moving, because the cascade lookup is 36 texture fetches per pixel and the depth passes run on the CPU. The cascades earn their cost where a shadow has to be sharp near the camera and long at the same time; a scene that fits one map in a few metres gains nothing and should not use them. The remaining gap in `long-street` is Cycles' sky and bounce light, not the shadows. `light-linking` has three point lights that each light only some parts (`affects` lists); it scores 0.0998 against Cycles, with the same lists given to Blender as receiver collections. Every scene that existed before kept its score to four digits (`lit-interior` is still 0.5055 against Cycles, 0.0923 against EEVEE), and the committed images of those scenes are unchanged.

`brick-room` (issue #128) is a closed room built from a recipe (`createAgentScene`) with three brick pattern walls, two point lights and a table with a vase. Blender gets the box projection as UVs (`boxProjectedGeometry`) and the baked brick map, but not the bump or the roughness map. Measured 2026-11-01 on the RTX 3060: against Cycles 0.5102 without the bake and 0.1515 with it (`npm run reference -- --bake brick-room`; SwiftShader 0.5096 and 0.1503; EEVEE against Cycles 0.5020); the bake took 14.4 s for 28,576 texels while another session loaded the machine. `lit-interior` stayed at 0.1444 with the bake, and every scene without a bake kept its earlier score to four digits (largest change 0.0000).

`brick-graph` (issue #50) is a wall of bricks written as one material graph (triangle waves for the joints, half a brick of shift on every second course, noise through a colour ramp, height as bump) on a quad with UVs, so it uses `mapping: "uv"`. `render-blender.py` translates the same graph JSON into Blender nodes (Math, Map Range, Noise Texture, Color Ramp, Mix and Bump), so each side evaluates its own nodes. It measured 0.2269 against Cycles and 0.1440 for EEVEE on 2026-10-31. A first run scored 0.4027 and showed a black wall in 67js: the `min` and `max` nodes returned NaN. The scene found that bug. The other rows were re-measured in the same run; `glass` against Cycles moved from 0.1450 to 0.1326 and `lit-interior` to the with-shadows numbers described above, and no other score moved by more than 0.002.

`brushed-film` (issue #51) holds a brushed gold sphere (`anisotropy` 0.8), a dark sphere with a thin film (`iridescence`, IOR 1.3, 400 nm) and a silver sphere with the same film. `render-blender.py` maps the glTF anisotropy model onto Blender's aspect ratio (alpha along the tangent is `mix(alpha, 1, strength^2)`, so Blender gets Anisotropic = (1 - alpha / alpha_tangent) / 0.9 and the geometric-mean roughness) and feeds a UV-map Tangent node, because Blender's default tangent is a different field: with the default tangent the first run scored 0.1673 against Cycles and the highlight ran in rings where 67js had bands; with the UV tangent it scores 0.1613 and the highlight direction matches. Thin film goes to Principled Thin Film Thickness and IOR. EEVEE draws no thin film, so its sphere stays black. The two models are not the same: Blender's film is its own Fresnel integration, 67js uses Belcour and Barla at the view angle, so match the colours by eye in the image, not by the score alone. Measured 2026-11-01 on the RTX 3060 and SwiftShader. Before and after adding anisotropy and iridescence, every older scene scored the same against Cycles and EEVEE to four digits (largest change 0.0000, limit 0.002), because their shaders compile the two layers out.

`metal-room` (issue #55) is the `lit-interior` room with a mirror sphere, a gold sphere and a glossy floor, to show what reflection probes do: 0.5128 against Cycles without a probe and 0.4520 with one (`npm run reference -- --skip-blender --probes metal-room`; with `--bake` the score is 0.1754 without a probe and 0.1537 with one). `--probes [ids]` adds probes to the named scenes; open scenes use a hand placed probe from `PROBE_SPECIFICATIONS` in `harness.js`, and score worse (`metal` 0.1868 to 0.2246, `material-spheres` 0.1598 to 0.1740). Every scene without a probe re-scored within 0.0001 of its earlier baseline (a full rerun on 2026-11-01 matched the committed `baseline.json` exactly). With `--bake`, adding `--probes` lowers the score in the three rooms: `lit-interior` 0.1444 to 0.1213, `brick-room` 0.1515 to 0.1266, `metal-room` 0.1754 to 0.1537. `--scene` renders one scene and does not rescore. `node bench/reference/frame-time.mjs lit-interior gpu` prints medians of three rounds: 1.73 ms plain, 1.90 ms baked, 2.04 ms baked with a probe (RTX 3060, 2026-11-01), against 106.7 s for the path tracer in `path-tracer.json`.

The mean against Cycles is 0.198 for 67js and 0.160 for EEVEE. The mean difference between the RTX 3060 and SwiftShader is 0.007.

EEVEE against Cycles is a yardstick: it shows what a good rasterizer scores. In `lit-interior` and `fog`, EEVEE scores no better than 67js. Those two scenes depend on indirect light, and this suite does not use EEVEE light probes. A low score does not mean a good picture on its own, so read each score with its image in `images/`.

`baseline.json` also holds the scores for SwiftShader and each render time in Blender.

## How the two sides stay comparable

- **Geometry:** `scenes.js` builds each scene with the engine's code, and `harness.js` hands the same vertices, normals and textures to Blender. This replaces GLB, because GLB export can not write textures yet (issue #49).
- **Character:** Blender's glTF importer does not reproduce the rest pose of `RobotExpressive.glb`. three.js and 67js agree on that pose. So `harness.js` skins the vertices first, and Blender gets the result as plain geometry.
- **Lights:** a measurement on a white plane gave the units. Sun strength equals irradiance in both. A Blender point light has 4π watts for each unit of 67js intensity.
- **Environment:** the same HDRI at the same rotation. The clouds line up in the images.
- **Display:** Blender writes linear pixels, and `score.py` applies the tone curve and gamma from `src/post.js`. Both sides then use one display transform.
- **Lighting tricks:** the 67js fill lights are off. All light comes from the sun, the environment and point lights.

Khronos sample assets (issue #51): `npm run reference -- --khronos` draws files from [KhronosGroup/glTF-Sample-Assets](https://github.com/KhronosGroup/glTF-Sample-Assets) that you download by hand into `artifacts/khronos/<name>/<name>.glb` (gitignored; nothing is committed). Blender imports the same GLB with its own importer, so Cycles is the reference for the file and not for our reading of it. The run uses its own work directory and writes `khronos.json` and `images/khronos-<name>.jpg`; `baseline.json` stays as it is. The sky fills most of each frame and both sides draw it alike, so the whole-frame FLIP score is about 0.05 for every asset and says little. The `asset-` columns score only the pixels the asset changes (a second render of the empty sky decides which, threshold 0.03). Licences, checked in each model's `LICENSE.md`: ClearCoatTest and AnisotropyBarnLamp are CC BY 4.0 (Analytical Graphics, Inc. and Wayfair, LLC), TransmissionTest, AnisotropyDiscTest and SheenChair are CC0 1.0 (SheenChair's model files are CC0; only its metadata files are CC BY 4.0). The scores are in "Scores now". The `AnisotropyBarnLamp` and `AnisotropyDiscTest` rows read `anisotropyTexture` since 2026-11-01 (0.4758 to 0.3584 and 0.3481 to 0.2808 then, under the sky with two suns).

Reading `anisotropyTexture` (strength in blue, direction in red and green) fixed the shade: the factor alone spread a highlight over everything, and it scored worse than no anisotropy. The disc test is still level with anisotropy switched off, so the remaining gap there is not the texture. `TransmissionTest` is unchanged at 0.2708: its `transmissionTexture` is not read, because transmission draws in the liquid pass, which has no feature code, and the scores do not show that the other slots (iridescence, specular) matter. `SheenChair` is scored since the importer accepts a normal map with its own `KHR_texture_transform` scale and offset: the fabric tiles its base color 7 times and its normal map 2 times, so the importer bakes the base color transform into the UVs and the shader applies the normal map's remainder (`normalMapTransform`, outside core; core grew by 25 bytes gzip). The score does not say that the transform is right: the visible gap is the sheen rim, and why it is weaker was not investigated. Both Blender's engines disagree on the lamp by 0.3761, so part of that gap is Blender's own anisotropy and clear coat. Two importer bugs the assets found are fixed: `KHR_xmp` and `KHR_xmp_json_ld` (metadata) stopped the whole import, and `KHR_materials_variants` is now accepted with a warning and draws the default material.

`brick-flat` is the control for `brick-graph` (issue #50): the same wall and light in the average colour of the graph, with no maps. Measured 2026-11-01 it scores 0.1999 against Cycles (0.1119 against EEVEE, EEVEE against Cycles 0.1351), and `brick-graph` 0.2269 (0.1480), so by this baseline the graph does not score above it: the picture is more like Cycles in kind but FLIP punishes the misplaced bevel highlights and the tone differences of noise more than it rewards the brick pattern. The bump of `brick-graph` is not weaker than Blender's. In a profile across one brick edge (columns 365 to 420, rows 150 to 215 of the render) the dark side of the bevel is the same in both (about 0.25 below the wall), and the bright side is about 0.3 above the wall in 67js against 0.17 in Cycles; the luminance spread over the brick area is 0.132 against 0.109 (EEVEE 0.109), and the edges fall on the same rows. Turning the bump down only lowers the score: 0.2065 with a bump of 0.01, 0.2209 at 0.5, 0.2247 at 0.75 and 0.2269 at 1 against Cycles. So the earlier note, that bump is weaker, was wrong. The rim of 67js is brighter because it keeps the full slope of the steep joint edge; the flat wall brightness is also 0.07 lower than Cycles, which has indirect light from the floor (EEVEE matches 67js there).

Where the `brick-graph` gap comes from (issue #50, measured 2026-11-01 on the RTX 3060 with temporary scene variants that are not committed; both sides were changed the same way for each row, the flat wall of each row is the average colour of that row's graph, 512 texels). Against Cycles, FLIP, lower is better:

| Variant | 67js against Cycles | EEVEE against Cycles |
| --- | --- | --- |
| flat wall (`brick-flat`) | 0.1999 | 0.1351 |
| graph colour only | 0.2108 | 0.1432 |
| graph bump only (flat colour) | 0.2226 | 0.1401 |
| full graph (`brick-graph`) | 0.2269 | 0.1440 |
| full graph, noise node replaced by 0.5 | 0.2270 | 0.1438 |
| graph colour only, no noise | 0.2098 | 0.1427 |
| flat wall, no noise | 0.1998 | 0.1350 |

Noise contributes nothing (0.2269 against 0.2270 without it), so the different noise function is not part of the gap. Colour structure alone adds 0.010 and the bump alone adds 0.023, and the two overlap. EEVEE, which reads the same node graph and the same Bump node, is also 0.009 above its own flat wall (0.1440 against 0.1351), so the condition that a graph must score no worse than a flat wall against Cycles can not be met by an independent renderer either: FLIP counts any misplaced fine structure against a flat wall that has none. What is left over 67js is 0.083 above EEVEE's own distance to Cycles for the graph and 0.065 for the flat wall. Blender's Bump node takes a one-sided slope over a footprint of 0.1 pixel (the node's Filter Width), so the bright side of a joint is thin and faint in Cycles, while 67js reads a central difference over two texels, which gives both sides a band. Setting Filter Width to 1 pixel lowered `brick-graph` to 0.2232 and 2 pixels to 0.2208, but the second one raised the EEVEE score from 0.1480 to 0.1565, so it moved the sides apart as much as it moved them together and the harness keeps the default. A 1024 texel bake of the bump only variant scored 0.2140 against 0.2184 at 512 (Filter Width 1), but the full graph is over the 30,000,000 work limit at 1024, so the scene stays at 512. With bounced light baked into the wall and floor (`--bake`, which removes the indirect light difference) `brick-flat` scores 0.1531 and `brick-graph` 0.1892, so the gap does not come from the missing indirect light either. No engine defect was found: the slope of the bake matches Blender's Bump node on distance (0.15 is the geometric mean of 6/32 and 4/32 for the 6 by 4 wall, since a texel slope is per UV unit), the sign and the colour space are the same on both sides. The condition stays open; a fair measure to report next to the raw score is the excess over EEVEE's distance to Cycles on the same scene (0.0829 for `brick-graph`, 0.0648 for `brick-flat`), never in place of it.

Bump against Blender's formula (issue #50, measured 2026-11-03, RTX 3060, stored Blender renders, `--skip-blender`, GPU column). Read from `gpu_shader_material_bump.bsl.hh` and Cycles `svm_node_set_bump` (`displace.h`): `N' = normalize(filter_width * abs(det) * N - distance * sign(det) * surfgrad)`, then `normalize(mix(N, N', strength))`. The height difference is divided by the filter width, so the tilt is `distance` times the height's slope per world unit, with strength 1 here (the node's default). 67js's `normalMapFromHeights` builds `normalize(-slope, 1)` from the same kind of slope, so the form is the same. The scale is not: 67js's slope is `bump / 32` times the height slope per UV unit, and Blender's is `0.15 * bump` per world unit, which for the 6 by 4 wall is `0.025 * bump` along U and `0.0375 * bump` along V, so 67js is 1.25 times too strong along U and 0.83 times along V. Matching Blender's numbers exactly (a throwaway edit giving each axis the wall's world size, not committed) moved `brick-graph` against Cycles from 0.1602 to 0.1599 and against EEVEE from 0.0896 to 0.0891, and `brick-flat` is untouched at 0.1272, so the excess over EEVEE on the same scene (67js against Cycles minus EEVEE against Cycles) went from 0.0381 to 0.0378 (flat wall 0.0174). The scale is not what separates the two, and the engine is unchanged. What remains is the footprint: Blender's one-sided difference over 0.1 pixel against a central difference over two baked texels. A faithful match would also need the bump in world units, which a baked normal map cannot know without the surface's UV size, so it would be a shader change; it is not worth doing for 0.0003. The older figures above (0.2269, 0.1999, 0.0829 against 0.0648) are from the two-sun, floor state of the scene; the same scene now scores as in this paragraph.

| Scene | Cycles, before | Cycles, scale matched | EEVEE, before | EEVEE, scale matched | EEVEE against Cycles |
| --- | --- | --- | --- | --- | --- |
| `brick-graph` | 0.1602 | 0.1599 | 0.0896 | 0.0891 | 0.1221 |
| `brick-flat` | 0.1272 | 0.1272 | 0.0462 | 0.0462 | 0.1098 |

## Cloth

`npm run reference -- --cloth` draws a pinned banner in wind (1 and 2 s) and a sheet dropped on a ball (0.5, 1 and 2 s). 67js bakes the sheet with its own solver; Blender bakes the same 13 by 13 grid with its cloth modifier from rest to the same time, stepping every frame, and renders that mesh in Cycles and EEVEE. Scores go to `cloth.json` and `images/cloth-*.jpg`, as FLIP over the whole frame and over the pixels the scene covers (`asset-*`, sky left out). Both solvers get the same mass (0.2 kg/m2, so 0.2 times the sheet area over 169 particles in Blender), gravity and drag; stiffness and bend stay at each side's defaults, because position based stiffness and Blender's tension, compression, shear and bending do not map one to one.

| Scene | 67js against Cycles | EEVEE against Cycles | 67js, covered pixels | EEVEE, covered pixels |
| --- | --- | --- | --- | --- |
| banner 1 s | 0.0428 | 0.0418 | 0.0713 | 0.0729 |
| banner 2 s | 0.0440 | 0.0426 | 0.0689 | 0.0709 |
| drape 0.5 s | 0.0804 | 0.0433 | 0.1012 | 0.0570 |
| drape 1 s | 0.0932 | 0.0394 | 0.1157 | 0.0514 |
| drape 2 s | 0.0909 | 0.0428 | 0.1114 | 0.0555 |

The two solvers differ in kind, so this mostly scores how alike the motion is. The banner sits at the EEVEE yardstick, which is a weak test: a flat sheet leaning in the wind has few pixels to get wrong. By eye the banner differs in shape: Blender's sheet wrinkles and sags along the bottom edge, 67js stays smooth and flat. The drape is about twice the yardstick: Blender's sheet has landed on the ball as a bell with wrinkles and its corners still up, while 67js has pulled its corners down and hangs flat panels on both sides of the ball. Wind is matched by the steady swing of the banner (Blender field strength 2 is 1.5 m/s here), because Blender's wind is a linear drag and this solver's is quadratic. The drape numbers also moved when the drag was matched: see "Recipe cloth" in `docs/physics.md`.

## Leaf model and tree regions (issue #166)

Before this change the Blender leaf was a plain Principled BSDF, while the 67js foliage shader (`CANOPY_TAG` in `src/shaders.js`) is not. `render-blender.py` now rebuilds each term of that shader on the Blender side, with the shader's own constants, for every material tagged `foliage`:

| 67js foliage term | Blender node setup |
| --- | --- |
| Back faces keep the stored normal | Geometry normal times `1 - 2 * Backfacing` undoes Blender's flip |
| Colour times `0.78 + 0.16 * sin(13 x + sin(9 y)) * sin(11 z - 5 y)` of the world position | The same sines on Geometry position, multiplied into the base colour |
| Normal moved by `0.06 * (sin(12 z), sin(9 x), cos(11 y))`, then normalised | The same vector in Blender axes, on the Principled and Translucent normals |
| Sky reflection 0.3 of a dielectric's | Specular IOR Level 0.5 * 0.3 |
| Light from behind: `colour * max(dot(-N, L), 0) * 0.3 * keyColor / (3.7, 3.4, 2.9)` | Translucent BSDF with colour weight `0.3 * pi / (3.7, 3.4, 2.9)`, which returns the same radiance for a sun of irradiance `keyColor`, added to the Principled BSDF |
| Alpha mask at 0.5 | Mix Shader with a Transparent BSDF, so the Translucent part is cut out too |

The weights are derived from the shader, not tuned. One difference stays: the 67js term was not shadowed, and the Blender Translucent BSDF is. The 67js term now multiplies by the sun shadow `visibility` as well (a leaf can only pass sun that reaches it), which is the one engine change of this issue. It moved `foliage` from 0.1181 to 0.1173; on its own the shader change is small.

Scores before and after (FLIP against Cycles, RTX 3060, 2026-11-02), with EEVEE against Cycles beside them:

| Scene | Before | Fair leaf, old shader | After | EEVEE |
| --- | --- | --- | --- | --- |
| `foliage` | 0.1290 | 0.1181 | 0.1173 | 0.0864 before, 0.0888 after |
| `mountain-valley` | 0.3473 | 0.3485 | 0.3483 | 0.1828 before, 0.1879 after |

The fair leaf alone moved `foliage` by 0.0109 (the Cycles crown got brighter, from 0.135 to 0.176 mean display luminance) and `mountain-valley` by 0.001: the leaf model was never the main gap there. No other scene changed to four digits in the full rescore.

Regions, measured on the Cycles image (display luminance, mean of the region; FLIP is the mean error of 67js against Cycles):

| Scene and region | Cycles | EEVEE | 67js | FLIP 67js | Share of the error |
| --- | --- | --- | --- | --- | --- |
| `foliage` crown (green, upper rows) | 0.176 | 0.229 | 0.300 | 0.472 | 0.37 |
| `foliage` trunk and ground under the tree | 0.139 | 0.191 | 0.208 | 0.313 | 0.02 |
| `foliage` open ground and sky | 0.689 to 0.793 | the same | the same to 0.01 | 0.03 to 0.14 | 0.55 |
| `mountain-valley` trees (green) | 0.186 | 0.225 | 0.335 | 0.481 | 0.53 |
| `mountain-valley` valley floor, rows 440 to 530 | 0.272 | 0.306 | 0.416 | about 0.5 | |

What the experiments show, each with the flags of this runner:

- `foliage` crown with `--ambient 0` (sun and shading only): 67js 0.176, the same as the whole Cycles crown. So the sun term alone is already as bright as Cycles, and the sky term adds 0.12 on top. Cycles loses most of the sky inside a dense crown to the leaves around each card; 67js has no occlusion in the ambient term, only vertex colours that darken from the crown centre. Screen space occlusion (`--ambient-occlusion 1 --ambient-occlusion-radius 1`) takes `foliage` from 0.1181 to 0.1133 and the crown to 0.283, which is not enough to close the gap. The remaining gap is recorded, not fixed: it needs occlusion between cards, which is the light bake's job (`addons/light-bake`) and is not part of a shader.
- `mountain-valley` floor with `--ambient 0`: 67js 0.180, against 0.272 for the full Cycles frame. The valley floor sits inside a ring of 1,100 m peaks that hide much of the sky in Cycles, and 67js lights the floor with the whole sky. This is inferred from the ring geometry and from the floor matching on the open `foliage` scene (0.698 against 0.689); it was not measured by removing the mountains. It is the main reason the trees there are lighter than in Cycles too. Fixing it needs sky visibility for terrain, which no shader has.
- Ground under the `foliage` tree: the floor is within 0.01 luminance of Cycles, and FLIP is worst in a band of 0.2 to 0.5 at the canopy rows, not at the trunk base. The trunk and its contact shadow are 2% of the error.

Blender render time of the two rerun scenes, now in `baseline.json`: `foliage` 26.4 s in Cycles and 13.5 s in EEVEE, `mountain-valley` 35.9 s and 39.2 s (other jobs loaded the machine).

### Sky visibility in crowns and valleys (issue #191)

The two experiments above point at the same missing term: sky light that reaches a surface which the scene itself shades. Cycles blocks that light and 67js did not. Two bakes now give the sky term a visibility, and no recipe field changes.

Causes, each measured on its own:

- Crown. With `--ambient 0` the 67js crown is 0.176, the same as the whole Cycles crown (0.175). The 0.12 the world adds in 67js (0.298 in total) is therefore sky light that Cycles stops inside the crown.
- Valley floor, from the heightfield. A script walked 32 horizon directions from 6 floor points of the `mountain-valley` height function and computed the cosine weighted share of the sky above the horizon. The ring leaves 0.69 to 0.72 of the sky open. Without the ring the share is 0.995 to 0.999. Cycles was not rerun without the ring.
- The valley sky term is 0.416 minus 0.180 = 0.236 in 67js, and 0.272 minus 0.180 = 0.092 in Cycles, which needs a share of 0.39. The ring explains the larger part of the gap. The estimate 0.18 + 0.7 * 0.236 = 0.345 is close to the measured result below (0.360). The rest is not explained: the sky of the HDRI is brightest near the horizon, which the ring hides, and a cosine share cannot see that.

What changed:

- `createTree` gives each foliage vertex a `skyVisibility` (`src/tree-sky.js`). The leaf vertices are binned in a grid of 14 cells along the longest side. For each occupied cell, 9 rays go up (1 zenith, 4 at 40 degrees, 4 at 65 degrees) and add the leaf density they cross. The cell keeps the mean of `exp(-depth)`, with a floor of 0.04. The opacity of one leaf vertex, 0.3, is the one fitted number: it was set on the `foliage` crown and not on `mountain-valley`. A level with fewer leaves counts each vertex for more, so the three levels agree.
- `createTerrain` gives each terrain vertex a `skyVisibility` (`src/terrain-sky.js`). For 16 azimuths it marches the heightfield outward in growing steps, keeps the highest horizon, and integrates the cosine weighted sky above it for the tilted surface normal. It samples a lattice of at most 160 nodes per side and interpolates, so the cost does not grow with the grid.
- The value travels in the fourth component of the vertex colour attribute, so the attribute layout is the same. The shader multiplies it into `occlusion` (which scales the environment light) and into the two fill lights in world mode. Direct lights are not touched. A mesh without the value reads 1.
- The tree value is computed on first read, which is when the renderer uploads the geometry. The terrain value is computed per chunk when the chunk is built.

Results (FLIP against Cycles, RTX 3060, 2026-11-02), with EEVEE against Cycles beside them. Region luminance is the mean display luminance of the region, taken on the Cycles image:

| Scene and region | Cycles | EEVEE | 67js before | 67js after |
| --- | --- | --- | --- | --- |
| `foliage` score | - | 0.0888 | 0.1173 | 0.1023 |
| `foliage` crown | 0.175 | 0.227 | 0.298 | 0.200 |
| `mountain-valley` score | - | 0.1879 | 0.3483 | 0.2623 |
| `mountain-valley` floor, rows 440 to 530 | 0.272 | 0.306 | 0.417 | 0.360 |
| `mountain-valley` trees (green) | 0.151 | 0.193 | 0.312 | 0.254 |

The `foliage` crown is now within 0.03 of Cycles, but the scene still scores worse than EEVEE: with the opacity at 0.12 the score was 0.1033 and the crown 0.226, so the rest of the crown error is leaf shape and placement, not sky. The valley trees stop at 0.254 because a conifer crown is already at the visibility floor, and a tree in the valley does not see the ring. The score against EEVEE of `mountain-valley` rose from 0.2382 to 0.2971, since EEVEE does not hide the sky either. No other scene changed to four digits in the full rescore, and the plain frame time of `material-spheres` did not change beyond the noise of a loaded machine (median 1.18 ms before, 1.0 ms after over 4 alternating runs).

Build time, on this machine with other jobs running: a 5 km valley terrain adds about 0.2 to 0.35 s (1.7 to 2.2 s before). A conifer crown costs about 4 ms and a broadleaf crown 6 ms for three levels, so the 3 variants of the valley forest add about 15 ms, and a forest of 3,600 distinct trees would add about 15 to 20 s only if every tree is drawn, since the value is lazy.

## Limits

- Scores come from one camera for each scene and one machine. They do not measure motion or speed.
- This suite sets an HDRI from code and leaves occlusion off; `--ambient-occlusion <strength> [--ambient-occlusion-radius <units>]` turns it on. A recipe reaches only the named procedural setups, so these scores still describe a better environment than an agent gets (issue #53).
- Both sides use the same leaf model since issue #166 (see "Leaf model and tree regions"). Grass has its own extra term in the 67js shader (`TAG_GRASS`), and Blender does not get it; no reference scene draws grass cards.
- `render-blender.py` does not read normal maps. No scene uses one yet, so a new scene with a normal map must add that first.
- `glass` and `car-paint` use the real 67js `transmission` and `clearcoat` layers, and the Blender side sets the same values on the Principled BSDF. 67js refracts through the front surface only, so the sphere does not show the inverted sky that Cycles traces through the back face.
- `car-paint` scored 0.1521 against Cycles and `glass` 0.1326 (it was 0.1450 with the `liquid` material). The other scenes scored the same as in the table above, to four digits. The table above is the 2026-10-30 baseline and has not been rewritten.
- `fog` has no noise on either side. EEVEE and 67js approximate scattering, and Cycles follows 8 volume bounces.
- Sample counts are fixed: 256 for Cycles with denoising, 64 for EEVEE and 4 MSAA samples for 67js.

Path tracer (issue #57): `npm run reference -- --path-tracer [--samples 32]` draws each scene with `addons/path-tracer` (CPU, 960 by 540, four threads, below-normal priority) and scores it against the Cycles renders of an earlier run into `path-tracer.json`; `baseline.json` and `images/` stay as they are. The first pass (2026-10-31) drew 32 samples with the tracer's own denoiser; the second pass is below.

The tracer is worse than the rasterizer on `outdoor-hdri` and `character`: in the images the floor is darker than in Cycles (the cause is not found), and `fog` shows the missing volume. The denoiser blurs some soft shadows. Cycles used 256 samples. See `docs/path-tracer.md` for what the tracer draws and skips.

Path tracer, emissive maps and fog (issue #284, 2026-11-03, 64 samples, one run each, shared machine): `fog` goes from 0.5333 to 0.0312 against Cycles now that the tracer draws the volume (the rasterizer scores 0.2021), in 85.3 s. The new scene `emissive-sign` is a dark wall with a panel whose `emissiveMap` is a strip of colour bars with scan lines, over a pale floor under a faint sky; `render-blender.py` multiplies the panel's emissive colour by the same map (`add_emissive_map`). The path tracer scores 0.0800 (62.9 s) and the rasterizer 0.2372, since the rasterizer does not light the floor from the panel. The rasterizer figure was taken with `--scene emissive-sign --skip-cpu` and scored on the GPU render alone, so `baseline.json` has no row for the scene yet; `path-tracer.json` was merged by hand with the other 15 scenes unchanged.

Path tracer, second pass (issue #129, 2026-11-01): 64 samples at most, `noiseThreshold` 0.03, four threads, 960 by 540; seconds are wall time and include scene setup. The scores are in "Scores now".

`light-linking` scores 0.0213 against Cycles, ahead of the rasterizer (0.0998): the tracer honours light linking, so a light adds nothing at a part it skips.

Before and after on four scenes, 64 samples: every sample drawn without the box-projection and shadow-ray changes (the state of `main`), then the defaults of this change. `brick-graph` 0.1370 then 0.1373, `brick-room` 0.2794 then 0.2743 (seconds 121.2 then 126.7, the box-projected walls now read their projected UVs), `character` 0.1116 then 0.1120, `outdoor-hdri` 0.1014 then 0.1016. `brick-graph` is a UV-mapped wall, so it already drew its bump and nothing in this change touches it: against the 0.1538 of the table above (32 samples) it improved, against the same tracer at 64 samples it did not move (0.0003 worse, inside the noise). `brick-room` is the scene with box-projected materials; its normal and roughness maps used to be ignored.

Adaptive sampling is not free in quality. On `spot-area` the score is 0.0658 with every sample drawn (37.1 s), 0.0748 at `noiseThreshold` 0.008 (31.3 s), 0.0847 at 0.015 (25.1 s) and 0.0900 at 0.03 (21.3 s). `lit-interior` went from 0.1993 (32 samples, before) to 0.2214 and was not re-run with every sample drawn. `spot-area` is a hard scene for the stop rule (narrow cone, sharp penumbra); a cause was not isolated. Set `noiseThreshold: 0` to draw every sample.

Denoising a lower sample count (fixed 24 samples with the tracer's filter, threshold 0, against the 64 sample score before the change): `brick-graph` 0.1394 against 0.1370 (0.0024 worse, 17.1 s against 37.3 s) and `character` 0.1164 against 0.1116 (0.0048 worse, 17.2 s against 39.3 s). Both are within 0.005, so a 24 sample still with the filter is a good still on these two scenes at about 45 percent of the time; two scenes are not proof for all.

Darker floor in `character` and `outdoor-hdri`: not found, but narrowed. In `outdoor-hdri` the mean display value of the bottom third (the floor) is 225.5 in Cycles, 225.4 in EEVEE, 224.8 in the rasterizer and 217.1 in the tracer, so the rasterizer agrees with Cycles and the tracer alone is darker, by 8.4 of 255 (the scene is bright, so the display curve compresses it; the linear gap is larger). A white furnace test (a diffuse floor of albedo 0.4 under a sky of radiance 1) gives 0.3955 straight down (1 percent low) and 0.588 at a grazing view with the sky reflection, so sampling the environment and the diffuse lobe is not what loses the light. What is left: the sun together with the HDRI, the clamp of 20 on bounced light (`fireflyClamp`), the grazing-angle specular and light from the other parts, none of which was isolated.

## Recipe bake presets (2026-11-02, issues #170 and #189)

An agent names a preset (`bake: { preset }`). A preset shrinks to the path work budget of 5 million steps (texels x samples x bounces): samples by a fifth and texel density by a tenth, repeatedly, down to 16 samples and 1 texel per unit. A scene that still does not fit there gives up one bounce and starts again from the preset's samples and density, down to 1 bounce. A preset therefore bakes any scene the explicit limit allows, and the result says what changed: `bake.used` holds the settings that ran, `bake.reduced` is `true`, and `bake.reduction` names what the preset asked for, what ran, and that explicit samples, bounces and texelsPerUnit (up to 24 million path steps, 20 s inline) bake denser.

`npm run reference -- --skip-blender --bake <ids> --bake-preset <name> --probes <ids>` bakes the way a recipe does (`normalizeAgentBake` and `bakeAgentParts`, the scene's own `bakeOptions` ignored) and scores against the Cycles renders already in `artifacts/reference`. The preset rows carry the room probe a recipe adds with a bake; the no-bake row has none. Whole frame FLIP against Cycles, RTX 3060 shared with other jobs, one run per cell, bake seconds from the harness (not an idle machine):

| Scene | No bake | draft | standard (`fine` is the same) |
| --- | --- | --- | --- |
| `lit-interior` | 0.5055 | 0.2919, 0.5 s, 8,000 texels | 0.1270, 3.8 s, 19,360 texels (81 samples, 3 bounces, 4.86 texels per unit) |
| `brick-room` | 0.5102 | 0.3185, 1.4 s, 37,136 texels | 0.1353, 1.8 s, 42,576 texels (32 samples, 3 bounces, 3.19 texels per unit) |
| `metal-room` | 0.5128 | 0.3187, 0.8 s, 8,816 texels | 0.1594, 3.3 s, 15,936 texels (64 samples, 3 bounces, 4.37 texels per unit) |
| `dark-shaft` | 0.1430 | 0.0791, 0.9 s, 28,208 texels | 0.0610, 2.3 s, 40,336 texels |
| `temple-hall` | 0.1436 | 0.0706, 5.7 s, 285,376 texels | 0.0705, 5.7 s, 304,480 texels (16 samples, 1 bounce, 1.37 texels per unit) |

Before issue #189 `standard` and `fine` refused `temple-hall` (even 16 samples at 1 texel per unit and 3 bounces pass the budget), so a recipe got an unbaked hall at 0.1504 with a probe. Now `standard` bakes it, with one bounce, which is what `draft` does: the score matches `draft` (0.0705 against 0.0706). The scene's own tuned options score 0.0560, and reaching them takes explicit settings.

What the table shows:

- `standard` halves the error of `draft` on `lit-interior`, `brick-room` and `metal-room` (3 bounces against 1) and beats the default bake of "Baked rooms and the bounce count" (0.1341, 0.1412, 0.1656) on all three, for 2 to 4 s.
- `fine` could not be made better than `standard` inside the budget, so it is an alias with the same numbers. The old `fine` (192 samples, 7 texels per unit) was cut to the same budget, so it ended within 0.003 of `standard` and slightly worse on three of five rooms (0.1293, 0.1382, 0.1624, 0.0603). Five other mixes of samples and density were scored, each asked for through `fine` and shrunk to the budget the same way:

| Asked (samples, bounces, texels per unit) | `lit-interior` | `brick-room` | `metal-room` | `dark-shaft` | `temple-hall` |
| --- | --- | --- | --- | --- | --- |
| 128, 3, 6 (`standard`) | 0.1270 | 0.1353 | 0.1594 | 0.0610 | 0.0705 |
| 192, 3, 7 (old `fine`) | 0.1293 | 0.1382 | 0.1624 | 0.0603 | not baked |
| 256, 3, 3 | 0.1363 | 0.1655 | 0.1636 | 0.0620 | 0.0718 |
| 256, 3, 4 | 0.1401 | 0.1516 | 0.1677 | 0.0606 | 0.0699 |
| 256, 3, 5 | 0.1442 | 0.1497 | 0.1746 | 0.0637 | 0.0703 |
| 64, 3, 12 | 0.1320 | 0.1436 | 0.1667 | 0.0660 | 0.0700 |
| 48, 3, 8 | 0.1208 | 0.1533 | 0.1643 | 0.0647 | 0.0700 |
| 32, 3, 12 | 0.1274 | 0.1445 | 0.1712 | 0.0660 | 0.0700 |

  More samples on fewer texels (256 samples at 3 to 5 texels per unit) lost on every room except `dark-shaft`, and more texels on fewer samples (32 to 64 samples at 8 to 12) lost on all but `lit-interior`, where `48, 3, 8` won by 0.006 and lost 0.018 to 0.004 on the other three. The `standard` mix of about 30 to 80 samples at 3 to 5 texels per unit after shrinking is the best or within 0.005 of the best on four of five rooms (not `lit-interior`), and the differences between mixes are small next to the gap to Cycles from missing indirect specular. A smoothing radius was not tried: `SMOOTH_RADIUS_TEXELS` is a constant in `src/light-bake.js` and the recipe has no field for it. Each cell is one run, so differences under about 0.005 are not separable from noise.
- The 20 s inline limit and the budget agree on large rooms: `temple-hall`, the largest scene (167 parts, 304,480 texels), bakes in 5.7 s at the budget, and the slowest cell above is 6.0 s, so the budget leaves room under the limit on this machine.
- `draft` is a rough preset: one bounce leaves the lit rooms at 0.29 to 0.32, still well under the unbaked 0.51.

### Presets again on a quiet machine (2026-11-03, issue #170)

Same command, `npm run reference -- --skip-blender --bake <five ids> --bake-preset <name> --probes <five ids>`, one run per cell, at below-normal priority, one GPU job at a time, against the stored Cycles renders. `nvidia-smi` showed 0 percent GPU and 1,028 MiB (the desktop) before each of the three runs. Whole frame FLIP against Cycles (lower is better), bake seconds from the harness, and `bake.used` (samples, bounces, texels per unit; `reduced` is true when the preset shrank to its budget):

| Scene | `draft` | `standard` and `fine` |
| --- | --- | --- |
| `lit-interior` | 0.2975, 0.3 s, 8,000 texels (32, 1, 3) | 0.1342, 3.4 s, 19,360 texels (81, 3, 4.86, reduced) |
| `brick-room` | 0.3266, 1.2 s, 37,136 texels (32, 1, 3) | 0.1448, 1.7 s, 42,576 texels (32, 3, 3.19, reduced) |
| `dark-shaft` | 0.0638, 0.7 s, 28,208 texels (32, 1, 3) | 0.0547, 2.8 s, 40,336 texels (40, 3, 3.54, reduced) |
| `temple-hall` | 0.0656, 3.1 s, 285,376 texels (16, 1, 1.29, reduced) | 0.0655, 3.6 s, 304,480 texels (16, 1, 1.37, reduced) |
| `metal-room` | 0.3244, 0.6 s, 8,816 texels (32, 1, 3) | 0.1631, 3.0 s, 15,936 texels (64, 3, 4.37, reduced) |

`fine` came out identical to `standard` in every cell (same score, same `used`; the bake seconds differ by 0.1 s, which is noise), so it is still an alias and the table shows one column for both. Every `standard` and `fine` bake was reduced, so an agent that names the preset gets fewer samples and a lower density than the preset asks for on all five rooms, and `bake.reduction` says so. Scores moved by up to 0.008 from the table above (for example `lit-interior` 0.1270 to 0.1342, `dark-shaft` 0.0610 to 0.0547) because `main` changed since then; the order of the presets did not.

### Frame costs on a quiet machine (2026-11-03, issue #170)

`node bench/reference/frame-time.mjs <scene> gpu --bake-cost` (a bake against the plain frame) and `--glow-mips` (the fog's glow mip chain generated every frame against the same frame with `generateMipmap` skipped after warm-up, so the sampling cost is the same and the difference is the chain), both with `--repetitions=5`. Each repetition is the median of 200 frames at 960 x 540, wall clock around `readPixels` (not GPU timer queries: `harness.js` times the frame on the CPU after reading a pixel back), and the two sides alternate order each round. The script sets itself to below-normal priority, so these ran at below-normal, not normal. Idle check before each run, from `nvidia-smi` (GPU utilization, memory, any process over 1 GB) and `Win32_Processor.LoadPercentage`: no process held more than 1 GB, the GPU memory was the desktop's 1.0 GB, utilization 0 percent and CPU load as below. The numbers right after a run (10 to 67 percent GPU) include the run's own tail and are not machine load.

| Measurement | CPU load before | Plain or skipped, median (range) | Baked or generated, median (range) | Cost, paired by round |
| --- | --- | --- | --- | --- |
| Baked `lit-interior`, run 1 | 19 percent | 0.835 ms (0.55 to 0.845) | 1.010 ms (0.99 to 1.02) | +0.155 to +0.18 ms in four of five rounds, +0.47 in the first (a 0.55 ms first plain frame) |
| Baked `lit-interior`, run 2 | 3 percent | 0.855 ms (0.555 to 1.03) | 1.260 ms (0.995 to 2.00) | +0.14 to +0.97 ms, median +0.41 |
| Glow mip chain, `dark-shaft`, run 1 | 9 percent | 1.70 ms (1.415 to 1.785) | 1.56 ms (1.40 to 2.015) | -0.39 to +0.24 ms, median +0.12 |
| Glow mip chain, `dark-shaft`, run 2 | 14 percent | 1.72 ms (1.395 to 2.33) | 1.515 ms (1.385 to 2.37) | -0.34 to +0.26 ms, median -0.01 |

- A baked closed room costs about +0.2 to +0.4 ms a frame (all ten paired rounds: +0.14 to +0.97 ms, median +0.29 ms), under the +0.6 to +1.4 ms ranges from a loaded GPU. The first run, with the steadier machine, gives +0.17 ms. Measured.
- The glow mip chain is not separable from noise: 10 paired rounds went from -0.39 to +0.26 ms, median +0.05 ms, so the earlier +0.5 ms is not reproduced. It was a plain frame of the new commit against numbers from the commit before, on a shared machine; the old commit also changed the glow taps (inferred, not rerun). Within a run the frame time drifts by up to 0.9 ms (1.4 to 2.3 ms on `dark-shaft`, no other process visible), so a cost under about 0.3 ms at this size cannot be read from one run; a bound is that the chain costs less than 0.4 ms at 960 x 540. Measured, with the drift unexplained (GPU clock changes are a guess).
- The machine was idle by the stated thresholds (GPU under 10 percent, CPU under 20 percent, no process over 1 GB) before every run, apart from CPU at 19 percent in the first bake run.

## Sky visibility in crowns and under the valley rim, what is left (2026-11-03, issue #191)

Method: Cycles was rendered a second time with the world light at 0 (sun only) for `foliage` and `mountain-valley`, and 67js with `render-gpu.mjs --ambient 0`. Region luminance is the mean over a region, in linear light after the tone curve of `src/post.js` (the "display" figures are the mean of the display values). The crown is the green and dark pixels above the ground of the Cycles image; the valley floor is the bottom 100 rows of `mountain-valley`.

| Region | Cycles, sky and sun | Cycles, sun only | 67js | 67js, world 0 |
| --- | --- | --- | --- | --- |
| `foliage` crown, display | 0.163 | 0.126 | 0.209 | 0.177 |
| `foliage` crown, sun-shadowed pixels, linear | 0.0062 | 0.0013 | 0.0052 | 0.0022 |
| `foliage` crown, sun-lit pixels, linear | 0.0649 | | 0.1219 | |
| `mountain-valley` floor, linear | 0.0651 | 0.0003 | 0.1117 | 0.0251 |
| `mountain-valley` slopes (rows 100 to 250), linear | 0.0394 | 0.0014 | 0.0258 | 0.0019 |

- Crown: the sky light inside the crown already matches. Where neither renderer has sun (44 percent of the crown pixels), 67js reads 0.0052 and Cycles 0.0062. The excess is sun light: with the world at 0 the 67js crown (0.177) is already brighter than Cycles with everything on (0.163). 9,252 of the 55,137 crown pixels are sun-lit in 67js and in shadow in Cycles (0.169 linear against 0.0016), and the pixels both sides light read 0.1065 against 0.0774. So the sun shadow inside the crown leaks; a darker sky value cannot fix that without being wrong in the shadowed leaves. A depth bias of a tenth of the current one moved the sun-lit pixel count from 25,922 to 22,981 (Cycles 21,574) and left 7,837 leaking pixels, so the bias is a part of it, not the cause. It was not kept.
- Valley floor: the cause is mostly not sky visibility. In Cycles the sun does not reach the floor at all (0.0003): the sun is 13 degrees above the horizon behind a rim up to 1,100 m high. In 67js the floor takes 0.0251 from the sun, in stripes along the sun direction and with no tree shadows, which is 54 percent of the 0.0466 gap. The other 0.0215 is sky light (0.0866 against 0.0648).
- Terrain sky visibility did read a little high. A brute-force march (48 azimuths, 8 m first step, 8 percent growth) gives 0.68 to 0.69 on the floor and `terrain-sky.js` gave 0.73, because the 1.3 step growth skips narrow peaks. A step growth of 1.1 gives 0.694 at about 0.03 s more build time. It moved the floor from 0.1117 to 0.1073 (nearer Cycles), but the slopes from 0.0258 to 0.0232 (further from Cycles 0.0394), and `mountain-valley` went from 0.2623 to 0.2743 against Cycles. Reverted. The slopes are already darker than Cycles, which has bounced light off the lit walls.
- The sky radiance by elevation of the capped HDRI is nearly flat (the share of irradiance above a 40 degree horizon is 0.70 against 0.59 for a uniform sky), so a sky that is brighter near the horizon does not explain the floor.

### Where the valley floor's sun comes from (2026-11-03, part of issue #191, tracked in #206)

Display luminance of the bottom 100 rows of `mountain-valley`, GPU column, stored Cycles and EEVEE renders, `--ambient 0` (sun only in 67js). Cycles reads 0.2753 and EEVEE 0.3082 with the whole sky on; the 67js frame with the sky on reads 0.3620. Each row changes one thing against the first row:

| 67js, world light 0 | Floor | What it tells |
| --- | --- | --- |
| as drawn | 0.1822 | The sun alone lights the floor. |
| sun term off (`keyColor * 0`) | 0.0015 | All of the 0.1822 is sun, not the fill lights. |
| shadow term off (visibility 1) | 0.2287 | The shadow map takes only a fifth of the sun away. |
| terrain left out of the shadow pass | 0.2274 | The shadow comes from the terrain; the trees add almost nothing at this size. |
| depth bias `0.00002` (was up to `0.002`) | 0.1705 | Bias is not the cause. |
| shadow LOD selection off | 0.1809 | Not the cause. |
| no instance (frustum) culling in the shadow pass | 0.1809 | Not the cause. |
| terrain `levels: 1` (no LOD at all) | 0.1822 | Not the cause. |
| shadow map depth 2,000 m / 6,000 m (was 3,500 m) | 0.1720 / 0.2164 | Moves with the bias, which scales with the depth range; not the cause. |
| receivers outside the map return 0 instead of 1 | 0.1822 | The floor is inside the map. |

The geometry says the floor is dark: marching the height function toward the sun (`createNoiseHeight` with the scene's parameters, 336 floor points, 4 m steps to 5 km) finds a horizon above the sun at every point, with a margin of at least 0.295 in tangent (median 0.52) over the sun's 0.227. So the 1,100 m rim blocks the sun by a wide margin, Cycles agrees, and the single shadow map does not show it. The cause is still unknown, and none of the settings above closes it when tried alone. Sky visibility is not the cause: the crown now reads 0.2026 against 0.1762 in Cycles (green pixels above 60 percent of the frame height, EEVEE 0.2295), and the remaining gap on both scenes is the sun shadow of #206.

## The valley floor's sun: back faces in the shadow pass (2026-11-03, part of issue #206)

Probe: the sun shadow depth (2048 x 2048, 24 bit) was copied to a float target and read back, and 259 floor points were projected into it. A march over the terrain's own mesh blocks the sun at all 259; the map shadows 123 of them. For the others the texel holds the floor's own depth where the march's first hit, 1,000 to 1,500 m toward the sun and 300 m up, has a depth of 0.36 against the floor's 0.58. Nothing is drawn there. The cause is the cull state of the shadow pass: it culled back faces. A ray that enters the terrain sideways (the mesh has no wall on its outer edge, and a slope that climbs toward the sun faster than the sun's 13 degrees faces away from the light) meets only back faces, writes no depth, and the sun passes through the rock. In the readback the floor shows as an unoccluded patch under the rim. The ten single changes of #221 could not close it because each left the culling alone; a finest-level terrain (`lodDistance` large) also left the floor at 0.1727.

The shadow depth pass now draws both faces (`applyAlphaState` in `src/renderer.js`, `textured` false). A closed mesh gives the same map, because its front face is the nearest; only an open surface changes. Measured, GPU, 960 x 540:

| | before | after | Cycles |
| --- | --- | --- | --- |
| `mountain-valley` floor, world light 0, display, rows 400 to 540 | 0.1727 | 0.0000 | 0.0003 (linear) |
| `mountain-valley` against Cycles, FLIP | 0.2612 | 0.1792 | |
| every other scene, FLIP against Cycles and EEVEE | | unchanged to four digits | |
| shadow map redraw, median of 3 runs of 40 (RTX 3060) | `mountain-valley` 1.75 to 1.81 ms, `foliage` 0.25 to 0.27, `long-street` 0.15 to 0.18 | 1.81 to 1.88, 0.28 to 0.31, 0.19 | |

The map is redrawn only when a caster, the wind or the assembly changes, so a still scene pays nothing per frame. The floor is now lit by the sky alone, so a tree shadow cannot fall on it: the sun does not reach it, as in Cycles. The `foliage` crown leak is not this cause: its FLIP and picture did not move. The crown's sun-shadow rows (9,252 pixels sun-lit in 67js and shadowed in Cycles) stay open under #206; the depth bias is the remaining lead (a tenth of it removed 2,941 pixels).

## The foliage crown's sun, ruled out one by one (2026-11-03, part of issue #206)

No engine change came out of this. Method: the stored Cycles array of `foliage` is full light, so the Cycles shadow mask is approximated from it. Crown pixels are the green-or-dark pixels of the Cycles image in the top 62 percent of the frame, 52,281 of them. Cycles reads shadowed where its linear value after the tone curve is below 0.02 (28,129 pixels); 67js reads sun-lit where the `--ambient 0` render is above 0.01. The count of both is the leak. On the branch of #222 it is 9,402 (the 9,252 of #191 was taken on another mask), and the crown mean is 0.0704 against Cycles 0.0509. Each row changes one thing on the GPU render, 960 x 540, with the rest as drawn:

| Change | Leaking pixels | Crown mean (linear) | FLIP against Cycles |
| --- | --- | --- | --- |
| as drawn | 9,402 | 0.0704 | 0.1023 |
| depth bias 0.00002 and no polygon offset | 6,952 | 0.0566 | 0.1532 (acne on the ground) |
| the same, filter taps 0.5 texel apart instead of 2.5 | 6,771 | 0.0546 | |
| shadow level of detail off (levels of the colour pass) | 6,771 (same as the row above) | | |
| texture read at level 0 in the shadow pass | 9,416 | 0.0704 | |
| shadow camera on the sun direction (eye y 15 instead of 14) | 9,036 | 0.0700 | 0.0989 |
| shadow cutout at 0.2 instead of 0.5 | 8,850 | 0.0685 | 0.1022 |
| shadow pass without the cutout, cards as solid quads | 3,201 | 0.0488 | 0.1110 |

- Bias, filter width, level of detail, mip level and map resolution (0.009 m a texel over 18 m) are small or nothing: bias moves 2,450 pixels and costs the ground.
- The shadow camera of `foliage` looks along (-6, 11, 8) while the sun is (-3, 6, 4), 4 degrees apart. Aligning them changes the leak by 370 pixels but takes FLIP from 0.1023 to 0.0989 (EEVEE 0.0888). That is a scene fix, not made here, because other scenes set `shadow` by hand too and the default `shadowBounds` of a world scene is further from its `lightDirection` than this.
- Only the solid quad moves the count, and it does so by darkening: it leaves 10,479 fewer crown pixels sun-lit than Cycles does (13,673 against 24,152) and FLIP gets worse (0.1110). The ground under the tree agrees with it (0.4132 against Cycles 0.4086, 0.4352 as drawn, mean linear over rows 380 to 540, columns 250 to 700), but the picture does not. So the leak is not the cutout reading the wrong alpha, and cards that cast their transparent part are not what Cycles draws either.
- The leaking pixels come as leaf-sized patches and thin slivers along leaf edges (the slivers are silhouette differences, not shadow). The patch that stays sits on a leaf that a leaf above it shadows in Cycles.

Open: a sun-only Cycles render (world light 0, as #191 made) is needed to say whether Cycles shadows these leaves by the sun or the stored image darkens them by something else, for instance the Translucent term, which Cycles shadows differently from the 67js term. This needs Blender, which was not run. The second Done-when of #206 stays open.

## The foliage crown against a sun-only Cycles render (2026-11-03, part of issue #206)

The section above approximated the Cycles shadow mask from the full-light array. This one renders it: `blender -b --factory-startup -t 6 --python bench/reference/render-blender.py -- artifacts/reference --world-strength 0 foliage` draws Cycles only (same camera, 960 x 540, 256 samples, denoised), with the world's light at 0, so only the sun is left, into `foliage-cycles-world0.npy`. The EEVEE render and the timings stay as they were. `python bench/reference/crown-leak.py artifacts/reference <67js --ambient 0 png>` (command in its header) counts the pixels. Branch: the sun-aligned shadow and the world-unit bias (#224, #226) included.

Crown pixels are the green-or-dark pixels of the full-light Cycles image in the top 62 percent of the frame, 56,921 of them (the 52,281 of the section above came from a slightly different colour test). Cycles shadowed is a tone-mapped linear value below 0.02 in the sun-only render; 67js sun-lit is above 0.01 in the `--ambient 0` render.

| | Pixels |
| --- | --- |
| Sun-lit in Cycles / in 67js / in both | 19,883 / 30,907 / 17,836 |
| Lit in 67js, shadowed in Cycles (the leak) | 13,071 |
| of those, within 2 px of a pixel Cycles lights | 7,424 |
| of those, farther away | 5,647 |
| Lit in Cycles only | 2,047 |

The true mask gives a larger leak than the full-light approximation did (11,137 on this crown). The target of fewer than 3,000 is not met, and nothing in the 67js shader moved it.

- Shadow or silhouette: 7,424 of the 13,071 sit beside a leaf Cycles lights, as a sliver along its edge with a matching blue sliver (lit only in Cycles) on the other side. That is leaf placement and the denoiser, not shadow. The other 5,647 are patches inside the lower crown that 67js lights and Cycles shadows.
- Translucency is not the difference. The Blender leaf adds a Translucent BSDF with the weight of the 67js back-light term (`CANOPY_BACK_LIGHT`), and the 67js term is multiplied by the sun visibility, so both sides shadow it (the comment in `render-blender.py` said the opposite and is corrected). This is read from the two definitions; a Cycles render without the Translucent BSDF would settle it and was not made.
- A shadow bias grown on back-facing leaves is not the cause either. `shadowVisibility` floors the cosine at 0.05, which gives a back-lit leaf the largest bias; using `abs(dot)` changed the leak from 13,071 to 13,069, so it was not kept.
- Solid quads in the shadow pass (no cutout) leave 5,418 leaking pixels (2,804 away from a lit edge) but 67js then lights 14,991 crown pixels against 19,883 in Cycles, and 10,310 are lit only in Cycles. The truth is between the two: the cutout shadow lets too much sun through, solid cards block too much, and neither a bias nor a threshold sits between them (see the table of the section above). The cause is still open; the lead is how much of a card Cycles blocks for a shadow ray, which needs a Cycles render with the leaf alpha changed to test.

## The foliage leak is mostly not shadow (2026-11-03, part of issue #206)

No engine change came out of this. The "leak" of the section above compared two lights that are not the same thing, so it was re-measured with the sun of 67js separated from everything else. `render-gpu.mjs` has a new `--key <scale>` switch (the sun's intensity); `crown-leak.py` takes the `--ambient 0 --key 0` render as a third argument, subtracts it from the `--ambient 0` render, and applies one threshold (0.02) to both sides. All numbers are on the same 56,921 crown pixels, the GPU render at 960 x 540, with the stored sun-only Cycles array.

- With the sun off and the ambient at 0, 67js still lights 5,068 crown pixels (3,100 of the 13,071 "leaking" ones): sky reflected in the leaf, which Cycles does not have in its sun-only render. Cycles shadowed was also tested below 0.02 and 67js lit above 0.01, which counts a 67js pixel at 0.015 as a leak next to a Cycles pixel at 0.0005.
- Measured fairly, the leak is 7,661 pixels: 5,213 within 2 px of a pixel Cycles lights (silhouette and leaf placement, as before) and 2,448 farther away. The part that is shadow 67js does not cast is already under the 3,000 of the Done-when. The whole count is not, and its silhouette share is not a shadow matter.
- The mean sun on the crown agrees: 0.0304 linear in 67js, 0.0316 in Cycles. What differs is where it goes. In pixels Cycles shadows, 67js carries 463 units of sun energy (Cycles 89); in pixels Cycles lights, 1,265 (Cycles 1,710). The 25 percent of the sun that sits in the wrong place is partly dimmer lit leaves and partly the 2-px edges, not a missing shadow layer.
- Leaf alpha is not the cause, and Cycles does not treat it as a fraction. The Blender leaf is `GREATER_THAN` the cutoff into a Mix with a Transparent BSDF (`render-blender.py`), so Cycles also cuts at 0.5, on the full-size texture. The 67js leaf texture is close to binary: the cutoff of the shadow pass swept from 0.02 to 0.8 moves the leak between 9,053 and 11,429 (old measure, 10,524 at 0.5), and reading the texture at level 0 changed it by 53 pixels. Solid cards in the shadow pass leave 2,474 leaking but only 0.013 of mean sun on the crown, 42 percent of Cycles, so they are over-dark, and the card is larger than the leaf. Hashed or stochastic alpha was not built: it needs partial alpha to average, and there is none.
- A tighter shadow extent (4.5 instead of 9, so a texel of 0.0044 m) took the leak from 10,524 to 9,592 on the old measure. That is small for a scene change and was not kept.

The second Done-when of #206 (fewer than 3,000 sun-lit crown pixels that Cycles shadows) holds for pixels away from a lit leaf (2,448) and not for the whole crown (7,661). The rest of the gap is placement of leaves and their edges, and the lower brightness of lit leaves. #191 should stay open for that.

## Fog valley against EEVEE (2026-11-03, part of issue #165)

`fog-valley` scored 0.1967 against EEVEE's 0.1952. Measured by band of rows on the GPU render (FLIP against Cycles): 67js is better than EEVEE in the sky (0.1311 against 0.1608, and 0.0512 against 0.0815 within 40 pixels of the sun, so the glow is not the problem), and worse below the horizon (0.2437 against 0.2317 at rows 230 to 300, 0.2664 against 0.2576 at rows 300 to 400) and in the left third of the frame (0.2866 against 0.2556), where the shadowed face of the near tower and the ground shadow are darker than in Cycles. The fog's in-scatter inside the sun's shadow is the term that lifts them, and it keeps 15 percent of the ambient there, a constant fitted to closed rooms, where the air in shadow sees walls and not sky.

Single constants tried on the GPU render of the five fog scenes (the whole frame against Cycles, before: `fog-valley` 0.1967, `fog-room` 0.1049, `dark-shaft` 0.0619, `temple-hall` 0.0659, `fog` 0.2257):

| Change | `fog-valley` | `fog-room` | `dark-shaft` | `temple-hall` | `fog` |
| --- | --- | --- | --- | --- | --- |
| shadow floor 0.4 | 0.1915 | 0.1473 | 0.0637 | 0.0772 | 0.2252 |
| glow weight 0.02 | 0.2073 | 0.0978 | 0.0586 | 0.0655 | 0.1951 |
| glow weight 0.004 | 0.1942 | 0.1093 | 0.0644 | 0.0735 | 0.2474 |
| glow only from pixels above 1.0, weight 0.02 | 0.2002 | 0.1144 | 0.0665 | 0.0722 | 0.2672 |

Every global value trades a room against the open ground. The floor is now the fog field `shadowAmbient`. Left unset it is derived: 32 upward rays from the middle of the fog box give the share that escapes the geometry, and the floor runs from 0.15 (closed room) to 1 (open sky), so `fog-valley` sets nothing and still gets 1 (the stored-Blender rerun with the hand-set value removed: valley 0.1855, `dark-shaft` 0.0619 to 0.0607, `fog` 0.2257 to 0.2243, `temple-hall` 0.0659 to 0.0674, every other scene identical to four places). Open ground under a sky is lit by the whole sky in shadow too. On the GPU render the valley goes 0.1967, 0.1915 (floor 0.4), 0.1883 (0.6) and 0.1855 (1.0) as the floor rises; the 0.6 and 1.0 renders were measured with two runs overlapping, so only the 1.0 value is kept, and the full run below was made alone.

Full suite, `npm run reference -- --skip-blender` on the stored Cycles and EEVEE arrays (RTX 3060, GPU and CPU renders):

| Scene | Before | After |
| --- | --- | --- |
| `fog-valley` against Cycles (GPU) | 0.1967 | 0.1855 |
| `fog-valley` against Cycles (CPU) | 0.1965 | 0.1857 |
| EEVEE against Cycles | 0.1952 | 0.1952 |
| `fog-room`, `dark-shaft`, `temple-hall`, `fog` | 0.1049, 0.0619, 0.0659, 0.2257 | same to four digits |

No other score in `baseline.json` moved by more than 0.0004. `gpu-vs-cpu` of `fog-valley` is 0.0120, so the 0.0112 gain is about as large as that spread; both renderers agree on the direction, and the valley is now 0.0097 below EEVEE, which the spread does not cover.

## Sky visibility of the fog (2026-11-03, part of issue #164)

The fog's ambient in the sun's shadow was one share for the whole box (`shadowAmbient`, derived from the middle of the box). `fogSkyVisibility` (`src/fog-sky-visibility.js`, passed to `Renderer67` by the harness and the agent preview like `skyOpenness`) replaces it with a per-point value: 24 upward rays from the centre of each cell of a grid over the fog box (at most 2,048 cells), read by the post shader from a 3D texture. A point that sees any sky keeps all the ambient, a point that sees none keeps 0.1, and sunlit fog keeps all of it as before. Without the option the sampling is compiled out, and a recipe that sets `shadowAmbient` gets no grid.

Measured on the GPU render against the stored Cycles and EEVEE arrays (RTX 3060, `--skip-blender`; the whole frame, and the bright region in brackets; EEVEE against Cycles on the region is 0.2455 for `temple-hall`, 0.2643 for `dark-shaft`, 0.3146 for `fog-room`):

| Scene | Before | After |
| --- | --- | --- |
| `temple-hall`, no bake | 0.0674 (0.2723) | 0.0640 (0.2611) |
| `temple-hall`, baked | 0.0557 (0.2439) | 0.0559 (0.2335) |
| `dark-shaft`, no bake | 0.0607 (0.1802) | 0.0559 (0.1282) |
| `dark-shaft`, baked | 0.0598 (0.1716) | 0.0551 (0.1137) |
| `fog-room`, no bake | 0.1049 (0.2405) | 0.1036 (0.1625) |

Every other scene, including `fog` and `fog-valley`, has the same score to four digits. The region of `temple-hall` without a bake still does not beat EEVEE (0.2611 against 0.2455), so #164 stays open. Region and whole frame pull against each other there. Tried on the five fog scenes (floor for fog that sees no sky, steepness `k` of the ramp from the sky seen to the full ambient; `temple-hall` / `dark-shaft` / `fog-room` whole frame, then the `temple-hall` region):

| Floor, k | whole frame | `temple-hall` region |
| --- | --- | --- |
| 0.15, 30 | 0.0651 / 0.0577 / 0.1088 | 0.2570 |
| 0.10, 30 (kept) | 0.0640 / 0.0559 / 0.1036 | 0.2611 |
| 0.10, 60 | 0.0652 / 0.0613 / 0.1096 | 0.2545 |
| 0.06, 60 | 0.0638 / 0.0592 / 0.1056 | 0.2577 |
| 0.15, 100 | 0.0681 / 0.0693 / 0.1207 | 0.2470 |

A grid of the sky share alone (linear, no ramp) was worse everywhere: the share is under 0.05 for nine in ten cells of `temple-hall`, so the fog went dark (region 0.2938). The region of `temple-hall` wants more light near the far door (bounce from the sunlit floor and columns), which sky visibility does not carry; the bright haze outside the shafts is already close to Cycles in display luminance (0.0432 before, 0.0369 now, Cycles 0.0391). Next idea: a grid of the light the sunlit fog gives its neighbours, not of the sky.

Cost: the rays run on the CPU once per scene and fog box: `dark-shaft` 0.03 s (1,120 triangles), `temple-hall` 1.7 s (11,892 triangles), a 12 x 6 x 32 grid. The core entry grows 141 bytes gzip (85,119 on main at 87561fd, 85,260 now); the agent preview entries grow 86 to 143 bytes (the ray code), and the four budgets `entry:agent-scene`, `entry:agent-asset`, `scene:agent-scene` and `scene:agent-scene+lazy` were raised by 100, 100, 200 and 100 bytes. Baked and plain rows are not in `baseline.json`, and `baseline.json` and the images were not rewritten by this change.

## Light the fog gets from surfaces (2026-11-03, part of issue #164)

`fogSkyVisibility` now also builds `fogBounceGrid` (`src/fog-bounce.js`): for each cell of the sky grid, 64 fixed rays find the nearest surface, which returns its emission plus the point light it receives times albedo over pi (shadow rays through the light bake's BVH tracer). The grid shares the sky grid's texture (`RGBA16F`, bounce in green, blue and alpha) and the post shader adds 0.6 of it to the fog's scattering. Parts with an emissive map (baked parts) and the sun are left out. Measured on the GPU render against the stored Cycles arrays (RTX 3060, `--skip-blender`, the whole frame and the bright region in brackets; EEVEE against Cycles on the `temple-hall` region is 0.2455):

| Scene | Before | After |
| --- | --- | --- |
| `temple-hall`, no bake | 0.0640 (0.2611) | 0.0647 (0.2421) |
| `temple-hall`, baked (`--bake temple-hall`) | 0.0559 (0.2335) | 0.0554 (0.2236) |
| `dark-shaft`, no bake | 0.0559 (0.1282) | 0.0559 (0.1282) |
| `dark-shaft`, baked | 0.0551 (0.1137) | 0.0551 (0.1137) |
| `fog-room` | 0.1036 (0.1625) | 0.1036 (0.1624) |

Every other scene keeps its score to four digits. Tried and not kept, on `temple-hall` no bake (whole, region), all against the same Cycles arrays:

| Variant | whole | region |
| --- | --- | --- |
| Sun, emission and lamps, 24 rays, weight 1 | 0.0637 (`dark-shaft` 0.0746) | 0.2246 (`dark-shaft` 0.1764) |
| Sun, emission and lamps, 24 rays, weight 0.5 | 0.0617 (`dark-shaft` 0.0626) | 0.2379 (`dark-shaft` 0.1427) |
| Emission and lamps, 24 rays, weight 1 | 0.0636 | 0.2455 |
| Emission and lamps, 64 rays, weight 1 | 0.0665 | 0.2334 |
| Emission and lamps, 64 rays, weight 0.6 (kept) | 0.0647 | 0.2421 |
| Emission and lamps, 64 rays, weight 0.5 | 0.0644 | 0.2450 |

The sun's bounce helps `fog` (0.2240 to 0.1065) and `temple-hall` but breaks `dark-shaft`, whose ambient already stands in for it, so it stays out. The whole-frame score of `temple-hall` without a bake is 0.0007 worse (0.0640 to 0.0647): the grid is isotropic and the fog has `anisotropy` 0.6, so the light cannot follow the forward lobe toward the window, and a weight that lifts the whole frame back to 0.0640 leaves the region at 0.2450, 0.0005 under EEVEE. A baked first attempt read the lightmap in the emissive slot as a source and scored 0.50 to 0.69; baked parts are skipped now. Cost: the grid takes 0.3 s for `temple-hall` and 0.07 s for `dark-shaft` (measured in the page, 64 rays, on a loaded machine), after the sky rays (1.7 s and 0.03 s). `entry:core` grows 28 bytes gzip (85,260 to 85,288); no budget changed. `baseline.json` and the images were not rewritten.

## The sun shadow follows the sun (2026-11-03, part of issue #206)

Several scenes aimed their shadow map along a hand-set eye that sat a few degrees off the sun the shading and Blender use (`foliage`: map along (-6, 11, 8), sun (-3, 6, 4)). Every scene now builds its shadow eye with `shadowAlongSun` from its own sun direction, at the old distance, keeping extent, near and far. The renderer does the same when `shadowBounds` gives no `eye` (`src/shadow-light.js`, also used by the cascaded shadows), and redraws the map when `environment.lightDirection` changes.

Measured with `npm run reference -- --skip-blender`, before and after on the same Cycles and EEVEE arrays, GPU against Cycles (EEVEE in brackets). Scenes not listed keep their score to four digits.

| Scene | before | after |
| --- | --- | --- |
| `foliage` | 0.1023 (EEVEE 0.0888) | 0.0989 |
| `long-street` | 0.1407 (EEVEE 0.0976) | 0.1267 |
| `character` | 0.0799 (EEVEE 0.0622) | 0.0717 |
| `fog` | 0.2240 | 0.2256 |
| `brick-graph` | 0.1602 (EEVEE 0.1221) | 0.1637 |
| `brick-flat` | 0.1272 (EEVEE 0.1099) | 0.1346 |
| `outdoor-hdri` | 0.0462 | 0.0460 |

`foliage` improves by 0.0034 but still trails EEVEE. The two brick wall scenes get worse (0.0074 and 0.0035), and this was isolated. The wedge of floor the wall shades beside it now has the shape Cycles draws; the loss comes from a faint stipple the shadow map puts on the wall itself. With the sun at (-3, 6, 4) the wall faces the light at N.L 0.51, the 9 tap filter spans about 3.5 texels (about 46 mm of depth) and the bias is about 39 mm. `brick-flat` against Cycles: shadow off 0.1277, old eye 0.1272, aligned eye 0.1346, aligned eye with a constant bias of 0.004 0.1260. So the old eye was hiding a depth bias that ignores slope and the map depth range (issue #225). A slope scaled bias (0.0025 x min(tan, 4)) fixed both brick scenes and improved long-street, fog and megacity-dusk, but moved `temple-hall` from 0.0646 to 0.0752 and `foliage` from 0.0989 to 0.1007, because the bias is in units of far minus near, so it was not kept. `fog` is 0.0016 worse, inside the limit.

## The sun shadow bias in world units (2026-11-03, issue #225)

`shadowVisibility` used `max(0.0006, 0.002 * (1 - N.L))` in the shadow map's 0 to 1 depth, so it ignored the slope against the sun and grew with `far - near`. It is now `shadowBiasPerSlope * clamp(tan, 0.25, 4)`, where tan is the angle between normal and sun and `shadowBiasPerSlope` (`src/shadow-light.js`, a uniform set from the light that drew the map) is `2 * extent / mapSize * 3.5 / (far - near)`: the world distance the depth changes across the 9 tap filter (taps 2.5 texels apart plus the bilinear blend, 3.5 texels) on a 45 degree slope. The same scene gets the same bias in metres for any depth range; a texel of the 2048 map is 7.8 mm in a 16 m wide map. The cascaded shadows already used a texel size over a depth range in metres, and the local shadow atlas pushes the receiver off the surface in angle units, so both stay. There is no CPU shadow bias.

Measured with `npm run reference -- --skip-blender`, same Cycles and EEVEE arrays, GPU against Cycles (EEVEE in brackets), against the state after the sun-aligned shadow. Scenes not listed move by less than 0.002.

| Scene | aligned shadow | world units bias |
| --- | --- | --- |
| `brick-flat` | 0.1346 (EEVEE 0.0581) | 0.1267 (0.0467) |
| `brick-graph` | 0.1637 (EEVEE 0.0910) | 0.1585 (0.0868) |
| `long-street` | 0.1267 | 0.1152 |
| `dark-shaft` | 0.0619 | 0.0559 |
| `fog` | 0.2256 (EEVEE 0.1016) | 0.2208 (0.1090) |
| `megacity-dusk` | 0.1627 | 0.1594 |
| `temple-hall` | 0.0659 | 0.0640 |
| `foliage` | 0.0989 (EEVEE 0.0811) | 0.0990 (0.0809) |

Both brick scenes are back under their scores before the aligned eye (0.1272 and 0.1602). The slope scaled bias in depth-range units that was tried first made `temple-hall` and `foliage` worse; in world units neither moves. `foliage` against EEVEE was 0.0888 with the old off-sun eye, 0.0811 after the aligned eye and is 0.0809 now, so the bias leaves the crown gap of issue #191 as it was. `fog` against EEVEE is 0.0074 worse while it is 0.0048 better against Cycles; the gate is Cycles.

## Sky light in the canyon of `megacity-dusk-a` is not the cause of the bright river (2026-11-03, part of issue #232)

Issue #231 inferred that surfaces between the towers get the whole sky in 67js while Cycles lets only a slice in. This measures it with the sun off on both sides. `render-blender.py` has a new `--sun-strength <scale>` switch beside `--world-strength` (Cycles only, the sun times the scale, into `<id>-cycles-sun<scale>.npy`): `blender -b --factory-startup -t 6 --python bench/reference/render-blender.py -- artifacts/reference-grand --sun-strength 0 megacity-dusk-a`. The 67js side is `render-gpu.mjs <directory> megacity-dusk-a --key 0`, and again with `--ambient 0` to take the sky's diffuse light away. Both arrays are tone mapped with the curve of `src/post.js` and compared as mean luminance over image regions (960 x 540, GPU).

| Region | Cycles, sun off | 67js, sun off | 67js, sun and ambient off | excess | of it, ambient |
| --- | --- | --- | --- | --- | --- |
| towers (rows 100 to 340) | 0.2157 | 0.2024 | 0.1868 | -0.0132 | 0.0156 |
| quay and street (rows 340 to 400) | 0.1096 | 0.1023 | 0.0917 | -0.0073 | 0.0106 |
| river, middle (rows 420 to 540, columns 280 to 680) | 0.0063 | 0.0274 | 0.0204 | +0.0211 | 0.0070 |
| river, sides (rows 400 to 540, columns 0 to 280) | 0.0158 | 0.0528 | 0.0429 | +0.0370 | 0.0099 |

Row bands of 60 rows, 67js over Cycles with the sun off: 0.99, 0.98, 0.96, 0.94, 0.92, 0.90 down to row 360, then 1.55, 3.31 and 3.65 over the river. Full light gives the same bottom bands (1.75, 3.13, 3.37).

The towers and the quay are slightly darker in 67js than in Cycles with only the sky, not brighter, so the canyon walls and the street do not get too much sky light. The river is 3 to 4 times brighter, but taking all the sky's diffuse light away (`--ambient 0`) removes only 0.007 to 0.010 of an excess of 0.021 to 0.037, so 67js stays 2.6 to 2.8 times over Cycles with no ambient at all. Even a perfect occlusion of the sky light in the river could close about a third of the gap, and the walls give no sign that the occlusion is missing. The rest comes from what the water draws besides diffuse sky: the reflection of the lit windows and the lamps (`src/water-reflection.js`), which is the part #195 works on. No sky visibility grid was built.

## Multiple scattering in the environment specular (2026-11-03, part of issue #167)

Re-measured on current main, `metal` was still 0.1036 against Cycles (EEVEE 0.0916), `car-paint` 0.1037 and `brushed-film` 0.1029, so the object probes of #209 had held. FLIP over screen regions of `metal` (GPU against Cycles, EEVEE in brackets, mean luminance difference to Cycles in the last column, regions cut from the projected bounds of each part):

| Region | pixels | FLIP | share of the error | luminance, 67js minus Cycles (EEVEE) |
| --- | --- | --- | --- | --- |
| floor | 291684 | 0.1015 (0.0884) | 50% | -0.0060 (-0.0061) |
| chrome sphere | 56296 | 0.2138 (0.1744) | 20% | +0.0199 (+0.0083) |
| copper box | 33196 | 0.2957 (0.3007) | 17% | -0.0591 (-0.0641) |
| gold torus | 20188 | 0.2109 (0.2234) | 7% | -0.0300 (-0.0292) |
| steel cylinder | 6636 | 0.3069 (0.2039) | 3% | -0.0531 (-0.0345) |
| background | 110400 | 0.0158 (0.0101) | 3% | -0.0003 |

The rough metals (copper, gold, steel) were darker than Cycles by 0.03 to 0.06 in both 67js and EEVEE. The environment specular was the single scattering split sum: `base reflectance * scale + offset`, which loses the light a rough GGX surface bounces a second time, while Cycles' Principled BSDF defaults to multiscatter GGX. `environmentLighting` now divides by `1 - (1 - scale - offset) * averageFresnel` (the closed form of Fdez-Aguera 2019, with the average Fresnel `F0 + (1 - F0) / 21`). Nothing is added to the BRDF lookup, so the extra cost is a few multiplies.

| Scene | before | after |
| --- | --- | --- |
| `metal` | 0.1036 (EEVEE 0.0916) | 0.0974 |
| `material-spheres` | 0.1286 (EEVEE 0.1053) | 0.1234 |
| `car-paint` | 0.1037 | 0.1030 |
| `foliage` | 0.0990 | 0.0981 |
| `mountain-valley` | 0.1782 | 0.1769 |
| `brushed-film` | 0.1029 | 0.1027 |

Every other scene moves by 0.0006 or less, none worse than 0.0002. Per region after the change: copper 0.2289 (was 0.2957), gold 0.1963 (was 0.2109), steel 0.3003, chrome 0.2127, floor 0.0994. Copper and gold are now past EEVEE; the remaining gap to EEVEE (0.0058) sits in the floor (50% of the error, 0.0994 against 0.0884: light bounced from the metal parts onto it, which the earlier one bounce probe test did not fix), the chrome sphere (0.021 too bright) and the steel cylinder. The direct light specular (`illuminate`) has no multiple scattering yet; it needs the BRDF lookup in the per light path, so it is the next thing to measure. Box 1 of #167 (metal reaches EEVEE) stays open.

Correction to the table above: the sun was never on in `megacity-dusk-a` (`keyColor` is 0, 0, 0 in `grand-scenes.js`), so `--key 0` and `--sun-strength 0` change nothing there. The two Cycles arrays are the same render and the 67js `--key 0` image equals the full one pixel for pixel. The "sky only" numbers above are the plain comparison, and the sky was the only light all along.

## The Cycles river was dark, not the 67js river bright (2026-11-03, issue #232)

The cause of the bright river and street bands is measured, and it is on the reference side. In `grand-scenes.js` the `river` box (centre y -1.2, height 1.4) and the `city-ground` box (centre y -1.5, height 2) both have their top at y = -0.5. Two surfaces in one plane: Cycles picks one of them at random per ray, so part of the rays that should mirror the sky and the towers hit the dark ground instead. `megacity-dusk-b` has the same pair for its bay. 67js draws the same scene without that noise.

Mean linear luminance over the river of `megacity-dusk-a` (960 x 540, GPU, no sun, river middle rows 420 to 540 and columns 280 to 680, sides rows 400 to 540 and columns 0 to 280):

| Render | River, middle | River, sides |
| --- | --- | --- |
| Cycles, as it was (coplanar) | 0.0130 | 0.0212 |
| Cycles, river 1 cm higher | 0.0385 | 0.0584 |
| 67js, shipped (reflection and sky specular) | 0.0317 | 0.0476 |

One term at a time in 67js (river middle, linear): reflection gain 0 gives 0.0032 (the diffuse sky light on the body colour and nothing else); gain 0 and body colour 0 gives 0.0000; reflection on with body colour 0 gives 0.0285; reflection off with body colour 0 (only the sky's specular) gives 0.0224; reflection off with body colour 0.02, 0.05, 0.08 gives 0.0256; with `--ambient 0` as well the reflection alone gives 0.0248 and with the reflection off the river is 0.0000, so there is no emission, no sun and no direct term on the water. The 67js river is the reflection weighted by Fresnel and nothing else. In the middle band 67js equals the exact Fresnel for IOR 1.5 times the picture at the mirrored row to within 3 percent (row 430: 0.0363 against 0.0351; row 538: 0.0124 against 0.0128). Cycles with the river as a pure mirror (Metallic 1, white) returns 0.0488 in the middle band, and the stored Cycles river was 0.267 of it, where the exact Fresnel at these angles (12 to 27 percent) says about 0.2 plus the diffuse part. A river raised 1 cm gives the Cycles values above. So the Fresnel curve, the double counting of reflection and sky, the exposure of the reflected windows and the diffuse colour are not the cause; the earlier tables of #195 and #232 compared 67js with a Cycles river that was dim by an artefact.

Both water boxes now stand 1 cm above the ground. Cycles is re-rendered for `megacity-dusk-a` and `-b` (the other scenes are unchanged), `grand.json` and the two images hold the new rows:

| FLIP against Cycles | before | now |
| --- | --- | --- |
| `megacity-dusk-a` GPU / CPU | 0.1999 / 0.1992 | 0.1507 / 0.1502 |
| `megacity-dusk-b` GPU / CPU | 0.1242 / 0.1258 | 0.1108 / 0.1120 |

Mean linear luminance of 67js over Cycles after the change, `megacity-dusk-a`: towers 0.92, street 0.90, river middle 0.82, river sides 0.82. The river is now slightly dark in 67js instead of 2.4 times bright. The scores of `mountain-valley-a` and the default suite are not touched: no engine file changed, and neither scene uses these boxes (inferred; not re-run). The measuring switch `render-gpu.mjs --water off|ssr` is new. Done-when 1 of #232 holds (the cause is measured); the sky visibility grid of its scope is not needed, and the issue's second item is moot.

## Multiple scattering on direct light (2026-11-03, issue #167)

`environmentLighting` added back the energy a rough microfacet loses on its first bounce (PR #236), but a sun or lamp's specular did not. `illuminate` now scales each light's specular by the same gain, `1 / (1 - (1 - scale - offset) * averageFresnel)`, taken from the BRDF table once per fragment (a global `directSpecularGain` set after the normal is final), so a fragment with five lights still samples the table twice (the environment term and the gain), not once per light. It applies only where an environment map is bound, since the table exists only then. A studio or outdoor-sky scene without a map is unchanged.

Scores against Cycles, GPU, `--skip-blender` on the stored Cycles and EEVEE arrays of the #236 worker (main reproduced `baseline.json` to four digits on them first, `mountain-valley` included):

| Scene | Before | After | EEVEE |
| --- | --- | --- | --- |
| `metal` | 0.0974 | 0.0962 | 0.0916 |
| `material-spheres` | 0.1234 | 0.1185 | 0.1053 |
| `character` | 0.0715 | 0.0712 | 0.0622 |
| `brick-flat` | 0.1267 | 0.1264 | 0.1099 |
| `spot-area` | 0.1242 | 0.1244 | 0.1935 |

No scene got worse by more than 0.0002 (`spot-area`, `fog-valley` 0.1855 to 0.1859). Frame cost on the RTX 3060 (`frame-time.mjs`, median of three runs): `brick-flat` 0.375 to 0.39 ms before and 0.375 to 0.38 after, `metal` 0.44 to 0.45 before and 0.44 after, so the extra lookup is below the timer's resolution. SwiftShader `transparency` in `bench/runtime`: 345.9 ms before, 347.5 after (15 frames; that scene has no environment map, so the shader path is the same).

`metal` is still 0.0046 above EEVEE, so the first box of #167 stays open. Where the rest is, by 6 by 8 block of the FLIP map (measured): the largest error is the lower half of the chrome sphere, where 67js is 0.062 brighter in display luminance than Cycles (EEVEE 0.022). Cycles shows the floor there darkened by the sphere's own contact shadow, and the sphere's probe traces the scene without the sphere, so the floor it shows is lit all the way to its base (inferred; the "seeing through the part itself" try above, 0.1117, was the attempt at that and was not kept). The rest of the frame is 67js 0.01 to 0.03 darker than Cycles, and EEVEE is darker still, so there is little left to gain from the direct specular. The floor holds over half of the error (0.0639 of 0.1147 in the table above) and is not a reflector.

## The sphere's contact shadow in its probe, measured and not kept (2026-11-03, part of issue #167)

The inference above, that the chrome sphere is too bright because its probe shows a floor with no shadow of the sphere, is right about the direction and wrong about the cure. Main reproduced `baseline.json` to four digits on the stored arrays first (`metal` 0.0962, `car-paint` 0.1028, `brushed-film` 0.1026, `material-spheres` 0.1185, `metal-room` 0.5071). Display luminance of the sphere's lower half, 67js minus Cycles, in four bands below the centre and three columns (GPU; the first column is the plain probe):

| Band (top to bottom) | left | middle | right |
| --- | --- | --- | --- |
| 1 | -0.039 | -0.020 | -0.044 |
| 2 | -0.038 | -0.024 | +0.048 |
| 3 | +0.001 | +0.005 | +0.088 |
| 4 (bottom edge) | +0.038 | +0.142 | +0.312 |

The mean over the lower half is only +0.015 (Cycles 0.594, 67js 0.609, EEVEE 0.588); the excess sits in the bottom edge and on the right, where the sun's shadow falls in Cycles (sun from -x, +z). So the cause is the one inferred: a floor lit up to the base. Casting the sphere's shadow onto the probe's floor points fixed that edge (band 4 middle +0.142 to -0.092) and overshot everywhere else (band 3 middle +0.005 to -0.107, right +0.088 to -0.141). The probe sits at the sphere's centre, and a ray from the centre to the floor lands far from where the true reflected ray from the surface lands: for a pixel at the bottom of the sphere the true ray leaves the surface a few centimetres above the floor and meets it next to the contact point, while the centre ray meets it about a sphere radius further out. The shadow therefore moves to the wrong floor points.

Scores against Cycles (GPU, the five scenes with a reflective part; every other scene has no object probe and is unchanged):

| Variant | `metal` | `car-paint` | `brushed-film` | `material-spheres` | `metal-room` |
| --- | --- | --- | --- | --- | --- |
| Main | 0.0962 | 0.1028 | 0.1026 | 0.1185 | 0.5071 |
| Shadow of the part on the probe's floor, full sun | 0.1038 | 0.1037 | 0.1036 | 0.1186 | 0.5077 |
| Same, shadowed direct light weighted 0.35 | 0.0982 | 0.1029 | 0.1018 | 0.1184 | 0.5072 |
| Same, weighted 0.2 | 0.0971 | 0.1028 | 0.1019 | 0.1184 | 0.5071 |

Every weight is worse for `metal`, so the shadow is not kept and no engine file changed. A cure needs the lookup to account for where the ray leaves the surface (a parallax-corrected probe: the reflected ray intersected with a sphere or box proxy of the part and with the floor plane), which is a shader change with a per-pixel cost and its own issue.

The floor, checked with the existing screen-space occlusion (`--ambient-occlusion <strength> --ambient-occlusion-radius <units>`, off by default): `metal` 0.0964 (0.5, 0.5), 0.0979 (1, 0.5) and 0.1097 (1, 1.5) against 0.0962 without it, so occlusion does not explain the floor's gap to Cycles either. It helps parts that sit on a floor with little reflection (`car-paint` 0.1028 to 0.1013, 0.1000 and 0.0960; `material-spheres` 0.1185 to 0.1181, 0.1174, then 0.1206), so it stays opt-in. The floor share of the `metal` error is therefore not contact darkening; the bounce light from the metal parts remains the candidate listed in the multiple scattering section.

## Parallax-corrected object probes (2026-11-03, part of issue #167)

An object probe sits at its part's centre, so a ray reflected at a point on the surface was looked up as if it had left the centre. The probe now records the level floor under it (one ray straight down at trace time, kept only where the surface normal is within 0.99 of up), and the shader sends a reflected ray that heads down toward the point where it meets that plane, seen from the probe: `normalize(hit - probeCentre)`, the plane-projected cube map correction. A probe with no level floor, and every room probe, keeps the plain lookup. The code is compiled in only with the `probe` shader feature, so a scene with no reflective part has the same shader code as before.

Main reproduced `baseline.json` to four digits on the stored arrays first. Scores against Cycles, GPU:

| Variant | `metal` | `car-paint` | `brushed-film` | `material-spheres` | `metal-room` |
| --- | --- | --- | --- | --- | --- |
| Main | 0.0962 | 0.1028 | 0.1026 | 0.1185 | 0.5071 |
| Parallax | 0.0957 | 0.1021 | 0.1016 | 0.1180 | 0.5071 |
| Parallax, plus the part's shadow on the probe's floor (full sun) | 0.0984 | 0.1020 | 0.1000 | 0.1178 | 0.5072 |

Every other scene is unchanged (it has no object probe). The shadow on top of the parallax lookup helps the other three scenes and makes `metal` worse again (0.0957 to 0.0984), so it was not kept; the correction alone is. `metal` is still 0.0041 above EEVEE (0.0916), so the first box of #167 stays open. Parallax moved the sphere's bottom edge less than hoped, which points at the floor term and the bounce light from the other metal parts, not the lookup, as what is left (guessed, not measured).

Frame cost, RTX 3060 (`frame-time.mjs`, 200 frames): `brick-flat` plain 0.385 ms (0.375 to 0.39 before), `metal` plain 0.43 ms (0.44 to 0.45 before). SwiftShader `transparency` in `bench/runtime`: 350.3 ms (345.9 and 347.5 before; 15 frames, machine under load).

Bundle size: the floor trace and the lookup correction add about 250 bytes gzip to the three bundles that carry reflection probes (`entry:agent-scene+lazy`, `entry:agent-asset+lazy`, `scene:agent-scene+lazy`), so each budget in `bench/size/budgets.json` is raised by 280 bytes. Measured: they were over by 244, 239 and 253 bytes.

## The floor of `metal`, measured and nothing kept (2026-11-03, part of issue #167)

Main reproduced `baseline.json` first (`metal` 0.0957 against Cycles, EEVEE 0.0916, GPU, on the stored arrays). The floor holds 44% of the frame error. Replacing the floor with the Cycles pixels (the ceiling for all floor work) gives 0.0555, so the floor costs 0.040 of 0.0957. FLIP over floor regions, cut by distance on the floor plane to the footprint of the nearest part (the parts' own pixels excluded), 67js against Cycles with EEVEE beside it, and the mean luminance difference to Cycles in display space (the last column is the EEVEE gap, FLIP difference times pixels):

| Region | pixels | share of the error | FLIP 67js (EEVEE) | luminance 67js minus Cycles (EEVEE) | EEVEE gap |
| --- | --- | --- | --- | --- | --- |
| contact, under 0.15 | 15887 | 6.8% | 0.2362 (0.2265) | -0.0021 (-0.0262) | 154 |
| near, 0.15 to 0.5 | 23729 | 8.2% | 0.1916 (0.1611) | +0.0071 (-0.0054) | 688 |
| mid, 0.5 to 1.5 | 99853 | 13.7% | 0.0762 (0.0598) | -0.0022 (-0.0018) | 1638 |
| open, 1.5 to 4 | 56116 | 6.0% | 0.0592 (0.0517) | -0.0066 (-0.0038) | 420 |
| far, over 4 | 81837 | 9.0% | 0.0610 (0.0531) | -0.0064 (-0.0023) | 646 |

Oracle ceilings (Cycles pixels pasted into one region of the 67js frame, whole frame FLIP): contact and near 0.0831, everything within 1.5 units 0.0698, within 4 units 0.0638, the sun shadow alone 0.0940, its edge band alone 0.0944. Each candidate cause below was tested against the data and none gives a change worth keeping.

- Shadow shape and softness: ruled out. Blender's sun is 1 degree wide (`SUN_ANGLE` in `render-blender.py`). The 67js filter reaches 3.5 texels of the 2048 map (extent 6, 5.9 mm a texel), about 2 cm, and a 1 degree sun gives a penumbra of 1.4 cm at 0.8 m and 2.1 cm at 1.2 m, so the two agree. Floor pixels where Cycles is below 0.6 of the open floor are 67js +0.0024 (EEVEE -0.0397) and score 0.204 (EEVEE 0.265): 67js is closer than EEVEE there, and a perfect shadow would be worth 0.0017.
- Shadow darkness (ambient in the shadow): ruled out by the same row. The shadow bands are within 0.013 of Cycles in luminance and hold 3% of the error.
- Floor level, colour and sky reflection: open floor is within 0.002 to 0.008 of Cycles in `metal`, `car-paint`, `brushed-film`, `material-spheres`, `outdoor-hdri` and `character`, and where it is off (the bottom right of the `metal` family, up to 0.008) EEVEE is off by the same amount, which is Cycles-only light from the copper box. A flat gain on the far floor is worth at most 0.0013 (+0.4% display: 0.0950 to 0.0937; a gain of 1.01 on the whole floor is worse, 0.0979), and so is a +0.4% push of red and green (0.0945). That is the size of a tuning knob and the other scenes do not show the offset, so no constant is added.
- Contact and sky occlusion: the visible halo (Cycles 0.620 to 0.635 around the parts, against 0.645 on open floor) is the band where 67js is worst against EEVEE (FLIP 0.164 against 0.112, 8% of the error), but analytic occlusion is not the cause. Over the sunlit floor within 2 units of each part, the difference to Cycles correlates with a sphere's cosine form factor only for the chrome sphere (+0.31; the excess is +0.036 within 0.2 units of it, +0.009 to 0.5 and nothing beyond); steel, torus and box give -0.06, -0.25 and +0.16. A cosine form factor sphere applied to the floor of the 67js image, as an oracle, was worse or equal in every variant: the chrome sphere alone 0.0957 (strength 0.2) and 0.0969 (0.5), sphere plus steel 0.0975, four spheres 0.1004 to 0.123 by size and strength. A mirror sphere shows the floor on its lower half, so what Cycles darkens there is bounced light, which #209 tried (0.1246) and did not keep.
- Screen-space occlusion: `--ambient-occlusion 0.3 --ambient-occlusion-radius 1.5` takes the halo band from 0.164 to 0.125 and the floor from 0.0873 to 0.0865, and the frame to 0.0970 (0.2 at radius 2.5 gives 0.0971; 1 at radius 1.0 gives 0.1018). The pass multiplies the whole frame, so it darkens the metal parts too, and with the parts untouched the floor would gain about 0.0004. It stays opt-in.
- Bake: `--bake metal --bake-preset standard` scores 0.1526, worse.

Where EEVEE beats 67js on the floor is the mid band (46% of the gap) and the open and far floor (30%), where the means are within 0.002 to 0.007 and the difference is spread thin (FLIP is also reading Cycles' own noise there); the one concentrated piece, the halo at the chrome sphere, is bounced light. No engine file, scene, baseline row or budget changed, and the first box of #167 stays open: `metal` 0.0957 against EEVEE 0.0916. The floor has no single cause left that a measured change reaches; what is left sits in the parts (the chrome sphere's lower half and the steel cylinder) and in bounce light.


## Depth parallax, floor occlusion and a probe gain for object probes, measured and nothing kept (2026-11-03, part of issue #167)

Three changes to the probes of `metal` were tried one at a time on current main. These runs used SwiftShader (`--use-angle=swiftshader`, a CPU render of the same harness scene, so no GPU time), scored with `score.py`'s FLIP against the stored Cycles arrays. Main scores 0.0962 there for `metal` (EEVEE 0.0916; `baseline.json` has 0.0957 from the GPU). An empty cell was not measured. The engine is unchanged by this note, so frame cost and the bundle sizes are too.

| Variant | `metal` | `car-paint` | `brushed-film` | `material-spheres` | `metal-room` |
| --- | --- | --- | --- | --- | --- |
| Main | 0.0962 | 0.0977 | 0.1015 | 0.0951 | 0.5067 |
| Depth parallax | 0.0957 | | | | |
| Depth parallax, plus the part's shadow on the probe's floor | 0.0995 | | | | |
| Sky occlusion of the probe's floor, part included as a blocker | 0.1051 | | | | |
| Sky occlusion of the probe's floor, other parts only | 0.0982 | | | | |
| Every probe hit 1.15 times brighter | 0.0922 | 0.0977 | 0.1037 | 0.0953 | 0.5060 |

Depth parallax. The trace stored the distance to what each probe ray hit in the alpha channel of the probe map, the sharpest level of the prefiltered map passed the alpha through, and the shader looked up where the reflected ray from the shaded point meets what the probe saw (four rounds of: read the depth in the direction of the guess, move the guess to that hit point projected on the ray). It replaces the floor plane with a lookup that also finds the neighbouring parts. The gain is 0.0005, and the picture gets worse to the eye: a 128 by 64 probe holds one depth per 2.8 degrees, so the depth lookup steps at the edge of each part and the top of the steel cylinder shows a notch and the lower rim of the chrome sphere a staircase. Keeping the floor plane as a cap on the travel did not remove them. A finer probe or a filtered depth would be needed, at a cost in trace time and memory that 0.0005 does not pay for.

Floor occlusion. Eight cosine rays from each floor point decide how much of the sky it sees, with and without the probed part as a blocker. Both are worse (0.1051 and 0.0982). The mean display luminance of the probe's floor in the picture is already below Cycles, not above it: lower half of the sphere 0.593 against Cycles 0.614, steel cylinder 0.541 against 0.570 (mean of the red channel, same boxes in every variant), so any darkening moves the wrong way. This is why the contact shadow of the previous section made `metal` worse too.

Probe gain. Because the floor is too dark in the probe, the hit radiance was multiplied by 1.15. `metal` goes from 0.0962 to 0.0922 (EEVEE 0.0916), the sphere's lower half to 0.632 and the cylinder to 0.567, but every other scene is flat or worse (`brushed-film` 0.1015 to 0.1037), so the number is a fit to one scene and not a correction, and it is not kept. It does show where the rest of `metal` is: the probe's lit surfaces are about 15% darker than Cycles shows them, and that is light the probe trace does not carry (the bounce between the floor and the metal parts, and the floor's own sky reflection), not a lookup problem. A principled version is the one bounce that #209 tried at 64 samples (0.1246) and that has not been retried with the trace seeing the sky, the parallax lookup and the multiple scattering of the later changes. That is the next thing to try, and it is a trace-time cost.

## Bump edges and the sky light below the surface (2026-11-03, part of issue #50)

Main reproduced `baseline.json` first on the stored arrays (`brick-flat` 0.1264, `brick-graph` 0.1584, EEVEE against Cycles 0.1099 and 0.1221, GPU). The Cycles arrays came from a worktree whose flat wall matched to 4 digits; one other worktree's arrays gave 0.1301 for the flat wall's EEVEE gap and were not used. Regions come from projecting the wall back to UV (mortar `body` under 0.05, edge 0.05 to 0.95, brick over 0.95), FLIP per pixel against Cycles.

| `brick-graph`, GPU | all | mortar | edge | brick | edge luminance (Cycles 0.444, EEVEE 0.494) |
| --- | --- | --- | --- | --- | --- |
| Bump 0 (no normal map) | 0.1467 | 0.2855 | 0.4293 | 0.2854 | 0.593 |
| Bump 0.5 | 0.1536 | 0.3177 | 0.4029 | 0.3116 | 0.513 |
| Bump 1 (baseline) | 0.1584 | 0.3342 | 0.4286 | 0.3204 | 0.521 |
| Bump 2 | 0.1622 | 0.3471 | 0.4507 | 0.3267 | 0.533 |
| Bump 1, ambient clipped to the surface plane | 0.1518 | 0.3238 | 0.3565 | 0.3150 | 0.465 |

- The bump hurts against Cycles at every strength, and stronger is worse, so the scale (#219) and the footprint are not the lead. The 512 texel normal map puts the joint edges where Cycles puts them (the albedo transition of the bump-free render sits on the same pixels, 423 to 430 on row 168), and the signs match.
- Across a joint's right edge Cycles stays dark over the whole 6 pixel transition (0.25 to 0.36) and 67js is dark over 2 or 3 pixels (0.33 to 0.47). Cycles discards light that arrives from below the geometric surface, and a bumped normal tilted 60 to 70 degrees has a third of its lobe there. 67js lit the full lobe.
- Change: for a mapped normal the ambient and reflected sky term is scaled by `0.5 + 0.5 * dot(mapped, geometric)`, the share of an even sky lobe that stays above the surface. `brick-graph` 0.1584 to 0.1518 (EEVEE 0.0875 to 0.0844, CPU the same); all 22 other scenes reproduce their rows to 4 digits (none uses a normal map). Excess over its flat wall: 67js 0.0320 to 0.0254, EEVEE 0.0122.
- Still open: the sun is not clipped against the surface plane (the wall faces the sun, so it changes nothing here), the colour gap on the brick faces (Cycles 0.524, EEVEE 0.476, 67js 0.466 in luminance), and a bump scale per world unit instead of per UV unit (Blender's Distance 0.15 is 0.025 per UV unit across and 0.0375 up on this 6 by 4 wall, the bake gives 0.031 both ways). Whether the condition of #50 can be met is still An's decision.
Bundle size: the two shader lines add 9 to 18 bytes gzip to eight bundles that carry the main fragment shader (ntry:core, ntry:agent-scene, ntry:agent-asset, ntry:cascaded-shadows, scene:lit-box, scene:gltf-box, scene:gltf-box+lazy, scene:agent-scene); their budgets rose by 20 to 30 bytes.

## Ground bounce (2026-11-03, issue #244)

Cause of the 10.7 percent gap on `brick-flat`, measured: light the ground bounces onto the wall. Cycles of `brick-flat`, 256 samples, RTX 3060, mean display luminance over the wall (rows 110 to 430, columns 230 to 730; same tone map as 67js):

| Cycles setting | wall luminance | linear |
| --- | --- | --- |
| normal (stored) | 0.6150 | 0.2389 |
| floor painted black (`--floor-color 0`) | 0.5466 | 0.1854 |
| light bounces limited to 0 (`--max-bounces 0`, sun and sky only) | 0.5370 | 0.1791 |
| 67js before | 0.5558 | |
| 67js with the fix | 0.6091 | |

The ground adds 0.0535 linear (22 percent of the wall's light) in Cycles. With bounces off, Cycles is 0.019 below 67js (display), so the sun units and colour, the sky irradiance on a vertical wall, Lambert against Principled diffuse and the tone map are not the cause: they leave 67js slightly bright. 67js lit the wall with the lower half of the sky HDRI, where Cycles has the floor.

Fix, derived from the scene and not set per scene: `groundBounceEnvironment(parts, environment)` (`src/ground-bounce.js`, `67js/addons/ground-bounce`) finds the floor (the lowest thin part that spans the scene, the same test as the automatic floor of agent scenes; a plain coloured, non-metal, opaque, untextured material gives its albedo; water and a graph material give none; a textured floor gives its colour times the mean of its base-colour texture in linear space, found once per image) and adds an `irradianceSource` to the environment map: a copy whose lower half is `albedo * (sun * max(l.y, 0) / pi + sky irradiance on a level surface)`. The renderer reads only the diffuse spherical harmonics from that copy (`environment.js`, two lines, plus the key of the prefilter cache in `renderer.js`), so the background, the reflections and the path tracer keep the real sky. The harness applies it to every scene; the agent preview applies it to every frame, with the colour of the automatic floor when no part forms one, and keeps the answer per parts array (`scripts/agent-preview-browser.js`; the browser preview itself was not driven here, only the stubbed page script in `tests/agent-preview.test.js`). It is skipped for a scene with a baked part (the light map already holds the bounce), a closed room (`closedRoomShare`, a bake or its own walls give that light), a point, spot or area light, no map, or `environment.groundBounce: false`; `--no-ground-bounce` draws the suite without it.

What the first version got wrong, kept for the next try: putting the bounced map in the sky itself (background and reflections too) made `brushed-film` 0.0739, `car-paint` 0.0688 and `metal` 0.0701 worse against Cycles, because the 40 m floor ends before the horizon and the band between the floor edge and the horizon showed the ground colour instead of the sky. A diffuse-only copy removes that. A scene lit by point, spot or area lights still got worse (`light-linking` +0.0059, `spot-area` +0.0056 with a 0.01 world): the term counts the sun and the sky only, so on a floor those lights brighten it takes light away from the lower half; those scenes are skipped now.

GPU against Cycles, main before and after, every scene rendered again on the same arrays (the committed `baseline.json` GPU columns reproduced to 4 digits first; the CPU columns of the other scenes come from older arrays and are not compared). Scenes not listed are unchanged to 4 digits.

| Scene | before | after | change | against EEVEE before | after |
| --- | --- | --- | --- | --- | --- |
| `brick-flat` | 0.1264 | 0.0547 | -0.0717 | 0.0465 | 0.0961 |
| `brick-graph` | 0.1518 | 0.0982 | -0.0536 | 0.0844 | 0.1001 |
| `material-spheres` | 0.1180 | 0.0956 | -0.0224 | 0.0681 | 0.0741 |
| `fog` | 0.2207 | 0.2021 | -0.0186 | 0.1092 | 0.1324 |
| `character` | 0.0712 | 0.0567 | -0.0145 | 0.0438 | 0.0661 |
| `glass` | 0.1033 | 0.0913 | -0.0120 | 0.1001 | 0.1100 |
| `outdoor-hdri` | 0.0443 | 0.0333 | -0.0110 | 0.0282 | 0.0366 |
| `fog-valley` | 0.1859 | 0.1791 | -0.0068 | 0.1459 | 0.1563 |
| `car-paint` | 0.1021 | 0.0979 | -0.0042 | 0.0633 | 0.0662 |
| `long-street` | 0.1149 | 0.1121 | -0.0028 | 0.0911 | 0.1152 |
| `megacity-dusk` | 0.1584 | 0.1601 | +0.0017 | 0.1038 | 0.0947 |
| `metal` | 0.0957 | 0.0964 | +0.0007 | unchanged | unchanged |
| `brushed-film` | 0.1016 | 0.1017 | +0.0001 | 0.0835 | 0.0836 |

No scene is worse by more than 0.002 (`megacity-dusk` is the largest at 0.0017); ten are better. Scores against EEVEE rise for most scenes because EEVEE has no ground bounce; Cycles is the reference. The CPU columns were redrawn for the eleven scenes that are not `long-street` or `megacity-dusk` (SwiftShader is too slow for those two, so their CPU columns keep the older numbers). The grand and Khronos scenes were not run: their arrays are not in the work directory. Not tried: spot and area lit scenes with the lights' own bounce (a bounce that counts the lights would need the path tracer or a bake).

Bundle size: `entry:ground-bounce` is new (9318 bytes gzip, it brings the closed room test and the bounds code). The two core lines add 18 to 31 bytes to eight bundles (`entry:core` 85986, `entry:agent-asset`, `scene:lit-box`, `scene:gltf-box`, `scene:gltf-box+lazy`, `scene:agent-scene`, `scene:agent-scene+lazy`); their budgets rose by 4 to 35 bytes. `entry:core` measured 85952 on main before the change, 2 over its 85950 budget. `render-blender.py` gained `--max-bounces <n>` and `--floor-color <v>` (Cycles only, like `--world-strength`).

## Bump scale per world unit and the brick-face colour (2026-11-03, part of issue #50)

Main reproduced `baseline.json` first on the stored arrays (`brick-flat` 0.1264, `brick-graph` 0.1518, EEVEE against Cycles 0.1099 and 0.1221, GPU). Nothing is kept and no engine file, baseline row or budget changed.

- Bump scale per world unit, tried and not kept. The baked map has a slope of `bump / 32` per UV unit; Blender's Bump node with Distance 0.15 has `0.15 * bump / L` per world length `L` of the UV axis, so the wall (6 across, 4 up) needs the existing `normalScale` uniform at `[4.8 / 6, 4.8 / 4]` = `[0.8, 1.2]` (a scale of the map's x and y leaves the slope ratio exact). `brick-graph` against Cycles goes 0.1518 to 0.1525 (worse), against EEVEE 0.0844 to 0.0840, CPU the same; `brick-flat` and `brick-room` are unchanged. The mean scale is still 1, and earlier measurements here show bump strength is not what separates the render from Cycles, so matching the anisotropy does not help. No shader or material field was added for it.
- Brick-face colour, measured: the gap is light, not the colour path. Mean luminance (display space, tone-mapped like 67js) over the wall, a uniform-colour wall (`brick-flat`) against the graph wall, by region found by projecting the wall back to UV:

| Renderer | flat wall | graph, brick faces (body over 0.95) | faces / flat | graph, mortar (under 0.05) | mortar / flat |
| --- | --- | --- | --- | --- | --- |
| Cycles | 0.6149 | 0.5236 | 0.852 | 0.7062 | 1.148 |
| EEVEE | 0.5600 | 0.4755 | 0.849 | 0.6610 | 1.180 |
| 67js | 0.5557 | 0.4657 | 0.838 | 0.6295 | 1.133 |

  Cycles is 10.7% brighter than 67js and 9.8% brighter than EEVEE on the plain flat wall, with no texture at all, so most of the 0.524 against 0.466 on the brick faces (12.4%) is Cycles-only light, the same offset as in `brick-flat`'s score. Once the flat wall removes it, the face ratios are within 1.6% (0.852, 0.849, 0.838), which is the share the graph's colour path and noise statistics can own. Ramp stops and mix constants are linear on both sides (`element.color` in `render-blender.py` takes linear values and the bake writes `linearToSrgbByte`), the ramp is linear in both, and the Blender noise differs from the 67js one (stated in `render-blender.py`), so a 1.6% face offset cannot be traced further without a Blender run, which this pass did not have. Not changed.
- Excess of the graph wall over its flat wall, the number #50 asks for: 67js 0.1518 - 0.1264 = 0.0254, EEVEE 0.0122, unchanged.

## Shadow depth against Cycles, remeasured on main (2026-11-03, part of issue #197)

Main at `e4bdee9` (after #222, #224, #226, #234, #236, #238 and the ground bounce of #245), GPU, 960 x 540. The GPU FLIP columns of `baseline.json` reproduce to four digits for all 23 scenes (only `gpu-vs-cpu` of two scenes moved, 0.0001 to 0.0017). Measured with `bench/reference/shadow-depth.py` against the Cycles arrays of the earlier runs (the re-rendered `megacity-dusk-a` and `-b` arrays); luminance is in display space. Percentiles are 67js / Cycles. `floor` is the shadow-tile floor, 67js over Cycles (above 1 means the shadows are too light), `contrast` is log2 of lit over shadowed in the same 24 pixel tile, 67js / Cycles, and `edge` is the median width of the lit-to-shadow transition in pixels, far half / near half of the frame, 67js / Cycles.

| Scene | p1 | p5 | p25 | floor | contrast | edge far | edge near |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `mountain-valley-a` | 0.012 / 0.023 | 0.039 / 0.072 | 0.163 / 0.174 | 0.79 | 2.52 / 2.12 | 3.4 / 3.4 | 3.3 / 3.3 |
| `mountain-valley-b` | 0.069 / 0.047 | 0.228 / 0.200 | 0.482 / 0.580 | 1.63 | 2.39 / 3.12 | 3.7 / 3.4 | 3.2 / 3.2 |
| `mountain-valley-c` | 0.015 / 0.004 | 0.034 / 0.019 | 0.177 / 0.201 | 1.85 | 2.24 / 2.52 | 3.2 / 3.1 | 2.9 / 2.7 |
| `megacity-dusk-a` | 0.049 / 0.048 | 0.063 / 0.073 | 0.113 / 0.148 | 0.83 | 2.71 / 2.49 | 3.1 / 3.1 | 3.1 / 3.2 |
| `megacity-dusk-b` | 0.164 / 0.151 | 0.220 / 0.221 | 0.339 / 0.351 | 1.07 | 1.74 / 1.80 | 3.3 / 3.4 | 3.3 / 3.3 |
| `megacity-dusk-c` | 0.029 / 0.035 | 0.030 / 0.035 | 0.033 / 0.039 | 0.56 | 3.99 / 3.10 | 3.3 / 3.4 | 3.0 / 3.2 |
| `temple-hall-a` | 0.049 / 0.033 | 0.056 / 0.036 | 0.067 / 0.047 | 0.73 | 1.16 / 1.33 | 3.0 / 3.3 | 2.0 / 3.3 |
| `temple-hall-b` | 0.071 / 0.034 | 0.072 / 0.037 | 0.079 / 0.045 | 1.47 | 0.78 / 1.80 | 3.3 / 4.2 | 3.1 / 3.3 |
| `temple-hall-c` | 0.039 / 0.016 | 0.039 / 0.018 | 0.055 / 0.022 | 1.85 | 1.33 / 2.02 | 4.6 / 5.4 | 3.4 / 3.3 |
| `dark-shaft` | 0.044 / 0.029 | 0.044 / 0.031 | 0.047 / 0.043 | 0.85 | 2.46 / 1.96 | 3.5 / 3.4 | 3.5 / 3.4 |
| `material-spheres` | 0.481 / 0.399 | 0.579 / 0.545 | 0.789 / 0.780 | 2.01 | 0.54 / 1.36 | 3.7 / 3.8 | 3.7 / 3.1 |
| `car-paint` | 0.187 / 0.130 | 0.247 / 0.229 | 0.642 / 0.614 | 2.61 | 0.94 / 1.79 | 6.9 / 3.1 | 3.8 / 3.3 |
| `character` | 0.209 / 0.214 | 0.472 / 0.395 | 0.775 / 0.771 | 1.27 | 1.21 / 1.48 | 3.1 / 3.0 | 3.2 / 3.1 |
| `long-street` | 0.201 / 0.138 | 0.364 / 0.322 | 0.507 / 0.479 | 1.68 | 1.11 / 1.59 | 3.1 / 3.2 | 3.1 / 3.2 |
| `mountain-valley` | 0.014 / 0.011 | 0.018 / 0.021 | 0.158 / 0.202 | 1.92 | 2.41 / 2.71 | 3.2 / 3.1 | 2.8 / 2.9 |
| `megacity-dusk` | 0.071 / 0.084 | 0.095 / 0.139 | 0.220 / 0.269 | 0.75 | 2.58 / 2.16 | 3.2 / 3.3 | 3.0 / 3.1 |

`metal`, `brushed-film` and `outdoor-hdri` have a floor of 2.6, 2.4 and 2.4 but only 9, 52 and 2 shadow tiles. FLIP against Cycles now, for the grand options: `mountain-valley-a` 0.1671, `-b` 0.2096, `-c` 0.1836, `megacity-dusk-a` 0.1640, `-b` 0.1106, `-c` 0.1192, `temple-hall-a` 0.1642, `-b` 0.1566, `-c` 0.1177. The rows of `grand.json` (0.2530 to 0.3642 for the temple options, 0.3530 for `mountain-valley-a`) are from 2026-11-02 and no longer match main; they were not rewritten here because this run had no EEVEE column.

What the numbers say (measured, except where marked):

- There is no single direction. The dark end is too light in the three `temple-hall` options (p1 1.5x, 2.1x and 2.4x Cycles; the contrast of `-b` is 0.78 against 1.80 log2 steps), in `mountain-valley-c` (p1 3.9x) and `-b` (1.5x), and on open floors (`material-spheres`, `car-paint`, `long-street`: floor 1.7 to 2.6). It is too dark and too deep in `mountain-valley-a`, `megacity-dusk-a`, `-c` and `megacity-dusk` (floor 0.56 to 0.83). The issue's "too light" holds for halls, midday valleys and open floors, and is reversed for dusk and night cities.
- Shadow edges are mostly not the problem: 16 of 26 scenes with a measurable edge are within 0.5 pixel of Cycles on both halves. The outliers are the glossy scenes (`car-paint` far 6.9 against 3.1, `metal`, `metal-room`, `brushed-film`, where a reflection edge counts as a tile edge; inferred), `temple-hall-a` near (2.0 against 3.3, sharper), `temple-hall-b` and `-c` far (3.3 against 4.2, 4.6 against 5.4, narrower) and `fog-room` far (1.5 against 3.2). A filter that grows with distance from the caster would touch only the temple options.
- Lit areas are within 0.9 to 1.1 of Cycles except `mountain-valley-c` (1.26), `car-paint` (1.37), and `temple-hall-a` and `-b` (0.65 and 0.69; the cause was not isolated).

Single changes tried (GPU; 13 default scenes and the 9 grand options; FLIP against Cycles, change from main):

| Change | Dark end | FLIP, worse | FLIP, better | Kept |
| --- | --- | --- | --- | --- |
| No ground bounce (`--no-ground-bounce`) | `material-spheres` floor 2.01 to 1.51, `character` 1.27 to 1.02, `outdoor-hdri` 2.42 to 1.44; `megacity-dusk-a` floor 0.83 to 0.94 | `material-spheres` +0.0224, `character` +0.0145, `outdoor-hdri` +0.0110, `car-paint` +0.0042, `long-street` +0.0028 | `megacity-dusk-a` -0.0135, `-c` -0.0045 | No |
| Ambient occlusion 1, radius 0.5 (`--ambient-occlusion 1`) | floor 0.03 to 0.2 lower (`material-spheres` 2.01 to 1.87), `megacity-dusk` p5 0.095 to 0.082 | `megacity-dusk` +0.0273, `-c` +0.0144, `-a` +0.0131, `mountain-valley-b` +0.0111, `mountain-valley-a` +0.0081, `brick-room` +0.0048 | `car-paint` -0.0033, `long-street` -0.0031 | No |
| World light times 0.7 (`--ambient 0.7`) | `mountain-valley` floor 1.92 to 1.44, `temple-hall-b` 1.47 to 1.25 | `mountain-valley` +0.1009, `material-spheres` +0.0661, `outdoor-hdri` +0.0603, `long-street` +0.0602 | `temple-hall-b` -0.0252, `-c` -0.0167, `-a` -0.0085 | No |

Which causes matter now: the world and sky light that reaches shadowed floors is the largest lever on the dark percentiles (a 30 percent cut moves the `mountain-valley` floor from 1.92 to 1.44 and lowers the `temple-hall` options' FLIP by up to 0.025), and the same light makes the outdoor lit areas right, so it can not be cut globally (up to +0.10 FLIP). It has to be occluded where a caster or a rim blocks the sky; the screen-space occlusion at 0.5 unit does that too little in studio scenes and too much in dusk streets. The ground bounce is about a quarter of the shadow floor in studio scenes (0.5 of 2.0 in `material-spheres`) because it is not occluded under objects, but removing it costs up to 0.022 FLIP. The sun shadow itself (map, bias, filter) no longer shows: `lit-level` is near 1 and edge widths mostly match. No cause dominates across the scenes and every global knob failed the 0.002 FLIP limit, so no engine change is kept in this pass and the frame cost is unchanged (nothing to measure). Next attempts, one each: darken the ground bounce under and beside casters, and give halls a world-light visibility term from their openings.

## Ground bounce on textured floors and terrain (2026-11-03, part of issue #191)

Main reproduced the GPU columns of `baseline.json` to four digits on the stored Cycles and EEVEE arrays first (GPU render and FLIP rescore of all 23 scenes; CPU renders were not redone, so the CPU columns are unchanged).

Which scenes the bounce skips (a temporary log of the reason in the harness, not kept): `local lights` for `temple-hall`, `lit-interior`, `metal-room`, `brick-room`, `spot-area`, `light-linking`; `closed room` for `dark-shaft`, `fog-room` and `foliage` (the leaf cards of the crown count as walls for the ray test); `no plain floor` for `mountain-valley` (a grid of terrain chunks, none spans the scene). No reference scene is skipped because its floor is textured, so that part is covered by unit tests only.

- Textured floor: the albedo is the material colour times the mean of the base-colour texture in linear space, found once per image. It changes no reference scene (the others are all re-scored equal to the baseline to four digits).
- `mountain-valley`, terrain with the mean vertex colour as albedo: 0.1769 to 0.1788 (worse by 0.0019). Scaled by the mean upward share of the normals (0.85 or so, a weaker bounce for sloped ground) it is 0.1871 (worse by 0.0102): the lower half gets darker, and the valley is darker than Cycles there already. Not kept; the terrain code was removed.
- `foliage`, bounce on by ignoring the cut-out leaf cards in the room test and by accepting a floor whose top sits in the lowest tenth of the scene (the roots reach 0.32 below it): 0.0979 to 0.0981, and the crown goes from 0.2000 to 0.2023 mean display luminance against Cycles 0.1763 (the same definition as above: green pixels in the top 62 percent of rows). The crown is already within 0.03 of Cycles, but the bounce moves it away. Not kept.

Nothing moved, so `baseline.json` is unchanged. `foliage` is still 0.0979 against EEVEE 0.0888, and the issue stays open.
Bundle size: `entry:ground-bounce` is 9451 bytes gzip (9318 before the texture mean, which adds 133 bytes), so its budget rose from 9330 to 9460.

## One bounce and the sky in object probes (2026-11-03, part of issue #167)

`OBJECT_PROBE_BOUNCES` went from 0 to 1, and a probe hit on a non-metal surface now adds the sky that surface mirrors toward the probe. Measured on SwiftShader first, then the GPU (FLIP against Cycles, `baseline.json` rows of `metal`, `metal-room`, `brushed-film`, `car-paint` and `material-spheres` updated; mountain-valley moved 0.1769 to 0.1820 on this machine's run with no probe in the scene, so its baseline row and the other 17 rows were kept as they were).

The earlier bounce try (#209, 0.1246 at 64 samples) was measuring a bug: `directIrradiance` returns one shared array, the gatherer calls it again for every neighbour it hits, and `traceProbeMaps` read `direct` after that call, so each probe pixel got the direct light of the last neighbour the gatherer visited (usually in shadow). The floor's mean in the probe fell from 0.25 to 0.15 with one bounce. With a copy of the direct light first, one bounce adds a little light and no longer darkens.

| SwiftShader, `metal` | FLIP | probe trace |
| --- | --- | --- |
| Main | 0.0962 | 0.12 s |
| One bounce, bug as it was | 0.1098 | 0.24 s |
| One bounce, direct light copied | 0.0955 | 0.25 s |
| Plus dielectric sky reflection (Fresnel, F0 0.04, capped by gloss, sky blurred to a cosine lobe, one shadow ray) | 0.0942 | 0.25 s |
| Same, Fresnel not capped by gloss | 0.0938 (`brushed-film` 0.1019) | |
| Same, plus metal parts mirroring the sky too | 0.0939 | |
| Two bounces | 0.0941 | 0.28 s |

Kept: one bounce, the copy, the capped Fresnel sky reflection. The uncapped Fresnel, the metal reflection and the second bounce are worth 0.0003 or less and cost code or time. GPU result against Cycles:

| Scene | Main | Now | EEVEE |
| --- | --- | --- | --- |
| `metal` | 0.0964 | 0.0944 | 0.0916 |
| `metal-room` | 0.5071 | 0.5045 | 0.5262 |
| `material-spheres` | 0.0956 | 0.0954 | 0.1053 |
| `car-paint` | 0.0979 | 0.0978 | 0.0844 |
| `brushed-film` | 0.1017 | 0.1019 | 0.0984 |

`brushed-film` is 0.0002 worse (the sky reflection; it was 0.1015 with the bounce alone on SwiftShader). Probe trace time on this machine (SwiftShader run, JS, so the same on the GPU run): `metal` 0.12 to 0.25 s, `brushed-film` 0.09 to 0.20 s, `car-paint` 0.06 to 0.10 s, `material-spheres` 0.19 to 0.37 s, `metal-room` 0.06 to 0.41 s; the trace runs when parts, lights or materials change, and a scene without a reflective part never loads it. `metal` is still 0.0028 above EEVEE: the cylinder's floor reflection is the closest gap left (probe 0.567 against Cycles 0.578 in the region, mean display luminance), the rest is light between metal parts that a diffuse bounce does not carry. The room probe trace (`PROBE_BOUNCES` 2) had the same overwritten `direct` and now reads the right light; no baseline scene uses it.

## Ground bounce occluded by the parts above it, measured and not kept (2026-11-03, part of issue #197)

Idea, from the shadow depth remeasure (#252): the ground bounce counts the ground as lit, but under and beside a caster it is in shadow, and Cycles darkens the bounce there. Change tried: `groundOpenness(parts)` in `src/ground-bounce.js` traced 24 upward rays from an 8 by 8 grid over the ground around the non-floor parts (their footprint widened by the tallest part's height) with `skyVisibilityGrid`, took the mean share that escapes (1 is open ground), and multiplied the lower half of the diffuse copy by it. Derived from the scene, once per parts array, no cost per frame, and nothing in core. `closed-room.js` only gained an optional grid size.

Measured on the same Cycles arrays as main (GPU, 960 x 540; `brick-flat` redrawn as well, the other scenes have no part above the floor, so the term is 1 and their rows are unchanged by construction):

| Scene | floor before | floor after | FLIP before | FLIP after | change |
| --- | --- | --- | --- | --- | --- |
| `material-spheres` | 2.01 | 1.81 | 0.0956 | 0.1049 | +0.0093 |
| `car-paint` | 2.61 | 2.57 | 0.0979 | 0.0995 | +0.0016 |
| `long-street` | 1.68 | 1.66 | 0.1121 | 0.1134 | +0.0013 |
| `outdoor-hdri` | 2.42 | 2.28 | 0.0333 | 0.0350 | +0.0017 |
| `brick-flat` | | | 0.0547 | 0.0608 | +0.0061 |
| `character` | 1.27 | 1.23 | 0.0567 | 0.0567 | 0.0000 |

The shadow floors move toward Cycles (mostly by 0.02 to 0.2) but five scenes get worse and two pass the 0.002 limit (`material-spheres` +0.0093, `brick-flat` +0.0061; worst regression). Cause (inferred): the term cuts the bounce that reaches the sides of objects and walls, where Cycles still has all of it, more than it cuts the light in the shadowed floor tiles; `material-spheres` lit-level 1.09 after. The shadowed floor itself gets no bounce from the lower-half copy in the first place (a level surface sees none of a lower hemisphere), so the floor ratio gap is not mostly this term: removing the whole bounce took `material-spheres` only from 2.01 to 1.51. Not kept; `baseline.json` is unchanged.

Next idea: occlude per surface, not per scene: a sky and sun visibility lookup for the ground next to each caster, which needs a texture in the core shader and is a size cost; or darken only the floor-facing lower part of casters, which the shader would need a height above the floor for.

## A sky visibility volume read by every surface, measured and not kept (2026-11-03, part of issue #197)

Idea, from the two notes above: a scene-wide scalar can not darken shadowed floors without hurting lit ground, so scale the world light of each surface by how much sky its place sees. Change tried: `skyVisibilityGrid` (24 upward rays per cell, the grid of the fog) over the bounds of all parts at up to 16384 cells, uploaded once as an `R8` 3D texture; a registered shader feature (`surfaceSky`, off unless the renderer is given the option, so no core code for other scenes) multiplied `occlusion` by the lookup at `worldPosition + normal * half a cell`, skipping surfaces that carry baked sky visibility (`vertexSkyVisibility` below 1) or a light map, and scenes with morph targets (the volume took the morph texture's unit). Main at `763e7fe`, GPU, 960 x 540, FLIP against Cycles with the stored arrays; change from the committed `baseline.json` (all 23 scenes; `mountain-valley` and `character` do not change in any row).

| Variant | Better than -0.002 | Worse than +0.002 | Worst |
| --- | --- | --- | --- |
| Strength 1, all normals | none | 21 of 23 | `long-street` +0.0804, `metal-room` +0.0631, `lit-interior` +0.0545, `temple-hall` +0.0119 |
| Strength 0.5, all normals | `temple-hall` -0.0051, `fog-room` -0.0065, `brushed-film` -0.0039, `car-paint` -0.0025 | 12 | `metal-room` +0.0314, `lit-interior` +0.0268, `brick-room` +0.0264, `long-street` +0.0164 |
| Strength 1, weighted by the upward share of the normal | `brick-flat` -0.0079, `brick-graph` -0.0083, `car-paint` -0.0038 | 14 | `long-street` +0.0373, `dark-shaft` +0.0177, `temple-hall` +0.0113, `metal-room` +0.0209 |
| Strength 0.5, weighted by the upward share of the normal | `brick-flat` -0.0042, `brick-graph` -0.0044, `car-paint` -0.0054, `brushed-film` -0.0022, `material-spheres` -0.0026, `temple-hall` -0.0030 | 10 | `long-street` +0.0138, `metal-room` +0.0104, `brick-room` +0.0092, `lit-interior` +0.0080, `dark-shaft` +0.0073 |


- The lookup is isotropic, a cell sees a whole sphere. Beside a wall about half of the upward rays hit the wall itself (inferred), so a surface that faces the wall is darkened by its own plane as well, which its cosine term already counts: strength 1 on all normals made `brick-flat` worse by 0.0323. Weighting by the upward share of the normal removes that (measured: `brick-flat` -0.0079) and turns the brick scenes and `car-paint` better, so the term is usable for floors only.
- With floors only, the targets split. `temple-hall` improves at strength 0.5 (-0.0030) and worsens at 1 (+0.0113); `material-spheres` and `car-paint` improve at 0.5 (-0.0026, -0.0054); `long-street` worsens at every strength (+0.0138 at 0.5); `mountain-valley` does not change (its terrain carries baked sky visibility, which the term skips). Cause for the street (guessed, not isolated): the sun-lit street is under narrow sky as well, and the cells of a volume over a street that long are coarse.
- Ten scenes fail the 0.002 limit at the best variant, so nothing is kept. Guess: the gap is light that comes back from the lit surfaces the blocked rays hit, which a visibility alone does not hold.
- Not measured, because the change was reverted: the gzip bytes, the frame cost and the ray time at 16384 cells. One run with 100000 cells (to resolve the street) did not finish all 23 scenes in 10 minutes, so the ray build is the limit on a finer volume.

Engine code reverted; `baseline.json` is unchanged. Next idea, if this is taken up again: sky visibility traced from the floor texels themselves (a 2D map of the floor, one value per texel, 64 or more rays) instead of a coarse volume.

## Where the rest of `metal` sits, and a metal mirror in the probe trace, measured and not kept (2026-11-03, part of issue #167)

`bench/reference/region-errors.py <scene> [gpu|cpu]` splits the FLIP error map of a scene by what each pixel shows. It draws each part's triangles back to front with the scene's camera (the floor quad reaches behind the camera, so the floor is the uncovered pixels below the horizon), then prints share, mean error and luminance per region for 67js and EEVEE against Cycles. GPU render, same arrays as the baseline (67js 0.0944, EEVEE 0.0916); the shares of the error are of the error map's own total (its mean is 0.1053, a little above the 0.0944 of the scorer, so use the shares and not the absolute values):

| Region | Frame share | FLIP 67js | FLIP EEVEE | Share of 67js error | Display luminance 67js / Cycles / EEVEE |
| --- | --- | --- | --- | --- | --- |
| Floor, open | 0.632 | 0.0883 | 0.0745 | 53% | 0.677 / 0.679 / 0.677 |
| Chrome sphere | 0.059 | 0.2430 | 0.2056 | 13% | 0.654 / 0.627 / 0.629 |
| Gold torus | 0.053 | 0.2331 | 0.3045 | 12% | 0.633 / 0.646 / 0.601 |
| Copper cube | 0.060 | 0.2085 | 0.3082 | 12% | 0.611 / 0.638 / 0.571 |
| Steel cylinder | 0.029 | 0.2531 | 0.1894 | 7% | 0.556 / 0.573 / 0.544 |
| Sky | 0.161 | 0.0148 | 0.0098 | 2% | 0.860 / 0.860 / 0.860 |
| Floor front edge | 0.006 | 0.1200 | 0.0838 | 1% | 0.672 / 0.687 / 0.683 |

67js already beats EEVEE on the gold torus (0.0124 against 0.0162 of the frame mean) and the copper cube (0.0125 against 0.0185). EEVEE leads on the open floor (0.0087 of the frame), the chrome sphere (0.0022), the steel cylinder (0.0019) and the sky (0.0008). The floor has the largest gap and no luminance gap (0.677 against 0.679), so what is left there is structure (the shadow shapes and the halo of bounced light around the parts), as #241 found. The steel cylinder is 0.017 too dark and the chrome sphere 0.027 too bright.

Change tried: in the probe trace, a hit on a metal part returns what that part mirrors toward the probe, times the metal's colour: the environment when the mirrored ray leaves the scene, else the direct and sky light of the part it meets (no further bounce). Either added to the diffuse term or in place of its metallic share. SwiftShader, `metal`, same Cycles arrays:

| Variant | FLIP | chrome / steel luminance | probe trace |
| --- | --- | --- | --- |
| Main | 0.0942 | 0.654 / 0.556 | 0.24 s |
| Mirror added, gain 1 | 0.0942 | 0.662 / 0.590 | 0.25 s |
| Mirror added, gain 0.4 | 0.0938 | 0.658 / not read | 0.25 s |
| Mirror replacing the metallic share of the diffuse term | 0.0953 | 0.654 / 0.559 | 0.25 s |

The best of them is 0.0004 better, which is inside what the choice of gain alone moves, and 0.0022 short of EEVEE. At gain 1 it overshoots the steel cylinder (0.556 to 0.590, Cycles 0.573) and brightens the chrome sphere, which is already too bright; the sphere's error is the structure of the reflection (the cloud pattern and the floor under its base), not its level. This agrees with the earlier "metal parts mirroring the sky too" row (0.0939). Not kept; no engine file, scene or `baseline.json` row changed, and the first box of #167 stays open: `metal` 0.0944 against EEVEE 0.0916. A scene without a reflective part never loads the trace, so its frame cost is as before.

Next idea: the open floor is more than half of the error and the largest gap, and a surface-level cause there needs a new input (light the metal parts reflect onto the floor, which a diffuse bounce leaves out), for example a few traced caustic-like patches stamped into the ground bounce.

## Same quantisation for 67js and EEVEE (2026-11-03, #258)

The scorer read 67js back as an 8-bit PNG but scored EEVEE from a float array, so every 67js against EEVEE number carried the rounding of one side only. `score.py` now rounds the EEVEE array to 8 bits in display space (`load_eevee`), which is what writing the PNG does. Cycles stays float, because it is the reference both are measured against. The alternative, reading 67js back as float, would need a float readback path in the harness for a measurement of the same size, and the PNG is what the 67js columns already use. `tests/reference-quantisation.test.js` pins the loader against an 8-bit PNG round trip.

The EEVEE columns were regenerated from the stored Cycles and EEVEE arrays and the stored 67js PNGs of the baseline run, without rendering. A cell is replaced only where the old scorer on those stored files reproduces the committed number, so the 67js columns (gpu-vs-cycles, cpu-vs-cycles, gpu-vs-cpu) are untouched. Scene order against EEVEE does not flip in any scene; `metal` goes from EEVEE ahead (0.0916 against 0.0944) to a tie at 0.0944.

| scene | eevee-vs-cycles | gpu-vs-eevee |
| --- | --- | --- |
| brick-flat | 0.1099 to 0.1129 | 0.0961 to 0.0941 |
| brick-graph | 0.1221 to 0.1249 | 0.1001 to 0.0976 |
| brick-room | 0.5020 to 0.5021 | same |
| car-paint | 0.0844 to 0.0869 | same |
| character | 0.0622 to 0.0657 | 0.0661 to 0.0626 |
| dark-shaft | 0.2654 to 0.2658 | 0.2638 to 0.2640 |
| fog | 0.2662 to 0.2677 | 0.1324 to 0.1334 |
| fog-room | 0.3730 to 0.3736 | 0.3635 to 0.3638 |
| fog-valley | 0.1952 to 0.1960 | 0.1563 to 0.1571 |
| foliage | 0.0888 to 0.0924 | 0.0804 to 0.0771 |
| glass | 0.1008 to 0.1056 | 0.1100 to 0.1082 |
| light-linking | 0.1558 to 0.1574 | 0.1127 to 0.1111 |
| lit-interior | same | 0.0926 to 0.0927 |
| long-street | 0.0976 to 0.0990 | 0.1152 to 0.1146 |
| material-spheres | 0.1053 to 0.1070 | same |
| megacity-dusk | 0.1524 to 0.1532 | 0.0947 to 0.0935 |
| metal | 0.0916 to 0.0944 | same |
| mountain-valley | 0.1893 to 0.1895 | 0.2671 to 0.2668 |
| outdoor-hdri | 0.0403 to 0.0441 | 0.0366 to 0.0328 |
| spot-area | 0.1935 to 0.1957 | 0.1709 to 0.1686 |
| temple-hall | 0.2341 to 0.2345 | same |

Not regenerated, still on the old float basis: `cpu-vs-eevee` for most scenes, `gpu-vs-eevee` for `brushed-film`, `car-paint`, `material-spheres`, `metal` and `metal-room` and `eevee-vs-cycles` for `brushed-film`. The `region-*` EEVEE cells of `dark-shaft`, `fog-room` and `temple-hall` were regenerated and are not in the table. The stored images of those scenes come from a later run than the baseline, so the old scorer does not reproduce the committed number from them, and a new number would mix two changes. They need a full `npm run reference` run. `grand.json` is also not regenerated: only `megacity-dusk-a` has an EEVEE array stored, and its stored images score 0.1985 against Cycles where `grand.json` has 0.1507. The side by side images in `images/` keep their old labels until that run.

## Where `foliage` loses to EEVEE, by region (2026-11-03, part of issue #191)

Nothing in the engine changed; `baseline.json` is unchanged. The GPU was held for the whole session by a long Blender render (`gpu-lock.sh` queue), so only the stored arrays were analysed and no fix was tried on a render. Method: `bench/reference/region-errors.py foliage gpu` (67js 0.0979, EEVEE 0.0888, against Cycles), then the same FLIP error map cut finer (distance from the silhouette, Cycles luminance of the pixel). The shares are of the frame; the gap is the contribution of 67js minus the contribution of EEVEE to the frame mean:

| Region | Frame share | FLIP 67js / EEVEE | Gap to EEVEE | Display luminance 67js / Cycles / EEVEE |
| --- | --- | --- | --- | --- |
| Crown (`broadleaf foliage`) | 0.167 | 0.3037 / 0.2805 | +0.0039 | 0.395 / 0.377 / 0.427 |
| Open floor | 0.459 | 0.0988 / 0.0931 | +0.0026 | 0.735 / 0.730 / 0.736 |
| Sky | 0.364 | 0.0157 / 0.0101 | +0.0020 | 0.829 / 0.829 / 0.829 |
| Bark and the floor part | 0.010 | 0.2016 / 0.1792 | +0.0002 | |

The sky and the open floor have the same luminance as Cycles, and their gap is almost all 8-bit rounding. The 67js frame is an 8-bit PNG while the Cycles and EEVEE arrays are floats: in the flat sky 67js differs from Cycles by 0.0010 per channel (mean absolute, the value of uniform rounding) and EEVEE by 0.0002, and the sky error is 0.0157 against 0.0101. The floor lit by the sun (Cycles luminance 0.7 to 0.8) shows the same offset (0.0854 against 0.0796). Rounding the EEVEE array to 8 bits and rescoring: EEVEE 0.0888 becomes 0.0924, so 0.0036 of the 0.0091 gap is the format of the comparison, not a rendering error, and no shader can remove it. The remaining gap is 0.0055.

Inside the crown, by the Cycles luminance of the pixel (contribution to the frame mean, 67js / EEVEE): pixels under 0.15 (share 0.063) 0.0227 / 0.0261, 67js better; 0.15 to 0.5 (0.047) 0.0187 / 0.0170; over 0.5 (0.057, sunlit leaves) 0.0094 / 0.0038. The mean crown luminance is closer to Cycles in 67js (+0.019) than in EEVEE (+0.050). So the level is right and the loss is where individual bright leaves sit: in pixels Cycles draws as lit leaf, 67js has error 0.167 against 0.067, while its shaded leaves beat EEVEE. This is the leaf shape and placement cause #191 already named; the edge of the silhouette (3 px) is only 0.0007 of the frame.

Next idea: the crown needs a per-card measurement, for example the Cycles array against 67js with the same leaf card in each pixel (a card id image from the harness), to see whether the bright-leaf error is cards missing, shifted or too dark; and the scorer could report the 8-bit EEVEE figure beside the float one so "beats EEVEE" compares like with like. Neither was tried. The first box of #191 stays open.

## Every cell regenerated with the 8-bit EEVEE scorer (2026-11-03, #258)

`npm run reference -- --skip-blender` and `npm run reference -- --grand --skip-blender` drew 67js on the GPU and with SwiftShader and scored every cell of `baseline.json` and `grand.json` with the current `score.py`, against the stored Cycles and EEVEE arrays of the earlier Blender runs. Blender was not run, so the `seconds` rows are as they were. The grand EEVEE arrays come from the earlier grand run that holds all nine frames (its Cycles arrays are identical to the ones used before). The tables show old to new; "same" means the cell did not change. In the default suite 24 of 150 cells changed, in the grand suite 51 of 54.

### Default suite

| scene | gpu-vs-cycles | cpu-vs-cycles | gpu-vs-cpu | eevee-vs-cycles | gpu-vs-eevee | cpu-vs-eevee |
| --- | --- | --- | --- | --- | --- | --- |
| brick-flat | same | same | same | same | same | same |
| brick-graph | same | same | same | same | same | same |
| brick-room | same | same | same | same | same | 0.0714 to 0.0715 |
| brushed-film | same | same | same | 0.0984 to 0.1015 | 0.0835 to 0.0813 | 0.0835 to 0.0801 |
| car-paint | same | same | same | same | 0.066 to 0.0636 | 0.0661 to 0.0627 |
| character | same | same | same | same | same | same |
| dark-shaft | same | same | same | same | same | 0.2636 to 0.2638 |
| fog | same | same | same | same | same | same |
| fog-room | same | same | same | same | same | same |
| fog-valley | same | same | same | same | same | same |
| foliage | same | same | same | same | same | 0.0802 to 0.0753 |
| glass | same | same | same | same | same | same |
| light-linking | same | same | same | same | same | 0.1132 to 0.1116 |
| lit-interior | same | same | same | same | same | 0.0932 to 0.0933 |
| long-street | same | 0.115 to 0.1125 | 0.0066 to 0.0083 | same | same | 0.0919 to 0.1147 |
| material-spheres | same | same | same | same | 0.0744 to 0.0742 | 0.0743 to 0.0732 |
| megacity-dusk | same | 0.1577 to 0.1586 | 0.0276 to 0.028 | same | same | 0.1076 to 0.0967 |
| metal | same | same | same | same | 0.0826 to 0.0806 | 0.0828 to 0.0797 |
| metal-room | same | same | same | same | 0.1122 to 0.1123 | 0.1129 to 0.113 |
| mountain-valley | same | same | same | same | same | 0.2655 to 0.2651 |
| outdoor-hdri | same | same | same | same | same | same |
| spot-area | same | same | same | same | same | 0.1712 to 0.1689 |
| temple-hall | same | same | same | same | same | same |

One 67js column moved by more than 0.002: `long-street` `cpu-vs-cycles`, 0.115 to 0.1125. Its `gpu-vs-cycles` is the same, so it is the SwiftShader frame, and the committed CPU cells of that scene were already stale (`cpu-vs-eevee` 0.0919 against 0.1147 now). `megacity-dusk` `cpu-vs-cycles` moved 0.0009, below the threshold. Every GPU 67js column against Cycles is the same to four digits, so the scorer change did not touch them.

`foliage`: 67js 0.0979 against Cycles, EEVEE 0.0924 against Cycles; against EEVEE itself 0.0771 on the GPU, 0.0753 on the CPU. `metal`: 67js 0.0944 against Cycles, EEVEE 0.0944 (a tie, as in the section above); against EEVEE itself 0.0806 on the GPU, 0.0797 on the CPU.

### Grand suite

| scene | gpu-vs-cycles | cpu-vs-cycles | gpu-vs-cpu | eevee-vs-cycles | gpu-vs-eevee | cpu-vs-eevee |
| --- | --- | --- | --- | --- | --- | --- |
| megacity-dusk-a | 0.1507 to 0.1989 | 0.1502 to 0.198 | 0.0224 to 0.0223 | 0.1455 to 0.1421 | 0.1141 to 0.1573 | 0.1152 to 0.1574 |
| megacity-dusk-b | 0.1108 to 0.1107 | same | 0.0368 to 0.0369 | 0.1041 to 0.1078 | 0.1246 to 0.1206 | 0.1268 to 0.1216 |
| megacity-dusk-c | 0.1149 to 0.1192 | 0.1087 to 0.1124 | 0.0419 to 0.0424 | 0.098 to 0.0996 | same | 0.0657 to 0.0642 |
| mountain-valley-a | 0.1924 to 0.1671 | 0.1924 to 0.1671 | 0.0109 to 0.0088 | 0.1756 to 0.176 | 0.1856 to 0.2392 | 0.186 to 0.2389 |
| mountain-valley-b | 0.1784 to 0.2096 | 0.1785 to 0.2088 | 0.0157 to 0.0158 | 0.13 to 0.1306 | 0.1422 to 0.2645 | 0.1415 to 0.2638 |
| mountain-valley-c | 0.2282 to 0.1836 | 0.2273 to 0.1819 | 0.017 to 0.0156 | 0.1504 to 0.1522 | 0.163 to 0.223 | 0.1619 to 0.2215 |
| temple-hall-a | 0.253 to 0.1642 | 0.2533 to 0.1645 | same | 0.4986 to 0.4989 | 0.4215 to 0.5298 | 0.4211 to 0.5295 |
| temple-hall-b | 0.3642 to 0.1564 | 0.3644 to 0.1567 | 0.0054 to 0.0044 | 0.4743 to 0.4747 | 0.234 to 0.4573 | 0.2335 to 0.457 |
| temple-hall-c | 0.2746 to 0.1177 | 0.2749 to 0.118 | 0.0028 to 0.0025 | 0.3989 to 0.3992 | 0.2216 to 0.3682 | 0.2213 to 0.3679 |

The EEVEE-against-Cycles column barely moves (at most 0.0037), so the references are the ones the old numbers used. The 67js columns moved a lot: 17 cells by more than 0.002, up to 0.21 (`temple-hall-b` against Cycles 0.3642 to 0.1564, `megacity-dusk-a` 0.1507 to 0.1989). That is not the scorer, which changes only the EEVEE columns by a few thousandths. It is 67js drawing these scenes differently from the run that wrote the old `grand.json`, which was written before the water and river commits (#195, #232) and other work on main (inferred from the commit history; the individual cause of each scene was not isolated). These are the numbers of main as of this run.

## Sampling the base map one mip finer for alpha cutouts, measured and not kept (2026-11-03, part of issue #191)

Hypothesis from the region analysis above: 67js draws leaves where Cycles has sky along card edges and tips, because the averaged alpha of a coarse mip level can sit above the cutoff on a thin leaflet. The change: `texture(baseMap, textureUV, -1.0)` in the base-map sample, for `alphaMode` mask only (opaque and blend untouched).

Measured with the stored Cycles and EEVEE arrays, `npm run reference -- --skip-blender --scene foliage` on the GPU, then `--score-only` for the whole default suite:

| Scene | Before (gpu-vs-cycles) | After | cpu-vs-cycles before / after |
| --- | --- | --- | --- |
| foliage | 0.0979 | 0.0982 | 0.0976 / 0.0977 |
| other 22 scenes | unchanged | unchanged | unchanged |

`foliage` got slightly worse (+0.0003, on both GPU and CPU renders) and no other scene has a mask material, so the change was reverted before the grand suite, the size budget and the frame cost were measured. A finer mip makes cutout edges sharper, which is not what Cycles shows: its leaves are softly filtered, so the coverage error is not mip averaging. The leaf-mask mismatch count (6,073 against 2,864) was not re-counted because the score already moved the wrong way.

Not tried: preserving alpha coverage across mips at load, and alpha to coverage on the leaf material. The per-card measurement named in the section above is still the next step, and the first box of #191 stays open.

## The foliage crown's lit leaves: coverage, not shading (2026-11-03, part of issue #191)

No engine change was kept and `baseline.json` is unchanged. Method: the crown is the card pixels of `broadleaf foliage` (label image of `region-errors.py`, 86,646 pixels); a pixel is leaf when it is green-dominant (green at least red, green at least blue + 0.02) or darker than 0.25, in Cycles and in each renderer separately. Sun-lit Cycles leaf is a Cycles display luminance above 0.35 (12,456 pixels). The stored 67js GPU render and a `render-gpu.mjs --key 0` render (sun off) were used. Each lit Cycles pixel is classed by what the renderer shows there: (a) no leaf, (b) leaf more than 0.10 darker, (c) more than 0.10 brighter, (d) within 0.10. Contribution is the FLIP sum over the frame.

An earlier cut of this analysis, which called "lit" a Cycles luminance above 0.5, was mostly sky seen through gaps in the cards (Cycles luminance 0.83) and is wrong; the 0.167 against 0.067 of the section above carries the same contamination.

| Class (lit Cycles leaf) | 67js pixels (share) | 67js contribution | EEVEE pixels (share) | EEVEE contribution |
| --- | --- | --- | --- | --- |
| (a) no leaf | 929 (0.075) | 0.0010 | 114 (0.009) | 0.0001 |
| (b) too dark | 2,359 (0.189) | 0.0024 | 2,071 (0.166) | 0.0024 |
| (c) too bright | 221 (0.018) | 0.0002 | 95 (0.008) | 0.0001 |
| (d) within 0.10 | 8,947 (0.718) | 0.0039 | 10,176 (0.817) | 0.0035 |
| leaf here, sky in Cycles (whole crown) | 1,862 | 0.0022 | 118 | 0.0001 |

- Lit leaves lose to EEVEE by 0.0014 (0.0075 against 0.0061). Of that, missing leaf (a) is 0.0009, brightness (c) 0.0001, the rest of the leaves 0.0004, and too-dark leaves (b) nothing: EEVEE has the same count and the same error. Counting the leaf 67js draws on sky pixels of Cycles (0.0022 against 0.0001), the card coverage accounts for more than the whole gap; 67js wins on the darkest crown pixels (0.0197 against 0.0236).
- So the dominant class is coverage: leaf mask mismatch against Cycles is 6,073 pixels in 67js and 2,864 in EEVEE, in a window of the crown (75,890 Cycles leaf pixels; 67js 73,567, EEVEE 73,288). 67js misses 4,198 Cycles leaf pixels (EEVEE 2,733) and draws 1,875 that Cycles does not (EEVEE 131). It is not one shift: the best integer shift of the mask is 0 to 3 pixels left and differs by quadrant, and it removes at most 30 percent of the mismatch in any one of them. The mismatch is along leaf edges and tips (about 60 percent within a pixel of the other mask).
- Shading is not it. The too-dark leaves (b) get 0.163 of linear-ish luminance from the sun in 67js (the sun-off render is 0.080 against 0.244 with the sun) against 0.448 in Cycles, and EEVEE has the same count. The lit leaves that 67js gets right take 0.232 from the sun. Leaf transmission and normals are not what separates 67js from EEVEE.
- Candidate not run: the leaf texture is read with trilinear mip filtering and cut at alpha 0.5, so thin leaflets and tips fall under the cutoff at a coarse level, while Cycles reads the full-size image. Reading cutout materials one mip level finer (`texture(baseMap, uv, -1.0)` for `alphaMode` mask) is a one-line change, written but not measured because the GPU lock was held by another job for 35 minutes of waiting (the queued render was cancelled). It also touches grass and every other cutout, so it needs the full default and `--grand` suites before it is kept.

## Soft leaf edges: alpha to coverage is already on, coverage-preserving mips did not help (2026-11-03, part of issue #191)

No engine change was kept and `baseline.json` is unchanged. Alpha to coverage for alpha-mask materials is already in the renderer (`SAMPLE_ALPHA_TO_COVERAGE` plus the `fwidth` softened alpha in `surfaceAlpha`) and the harness renders with 4 samples, so the first option was in place before this attempt and measured nothing new.

The second option was tried: for alpha-mask materials only, the base map got its own texture whose mip levels 1 and up are box filtered on the CPU (colour in linear light) and then have their alpha scaled so that the share of texels at or above the cutoff is as close as the alpha values allow to the share at level 0. Opaque and blend materials, and the shader, were untouched. Result for `foliage` (full `--score-only` after one GPU render of the scene, GPU 401 ms per frame, as before within noise):

| `foliage` | before | coverage-preserving mips |
| --- | --- | --- |
| 67js against Cycles (GPU) | 0.0979 | 0.0981 |
| 67js against Cycles (CPU) | 0.0976 | 0.0977 |
| 67js against EEVEE (GPU) | 0.0771 | 0.0769 |
| EEVEE against Cycles | 0.0924 | 0.0924 |

Worse by 0.0002 against Cycles, so the default suite and `--grand` were not run and the code was reverted. Reading (inferred): the lost coverage is at full-size edges, not at coarse mips, since the crown is seen at about one texel per pixel; keeping more coverage in the coarse levels cannot reach it. Same direction as the one mip finer attempt (0.0979 to 0.0982). Next idea: match Cycles' edge softness at level 0 (a slightly blurred alpha, or the leaf alpha edge drawn with a ramp wider than a texel) instead of changing the mips.

## Graph bump slope read at a point, and where the graph excess comes from (2026-11-03, part of issue #50)

Main (merged with `origin/main` of the day) on the stored Cycles and EEVEE arrays, GPU, 960 x 540. Before: `brick-graph` 0.0967 against Cycles in a fresh render (0.0982 in the committed row), `brick-flat` 0.0547, so the excess of the graph wall over the flat wall was 0.0420 (0.0435 by the committed rows) against EEVEE's 0.0120 (0.1249 against 0.1129).

The split, with Blender renders of each variant too (temporary scene variants, not committed; each row is 67js against Cycles of the same variant, FLIP, lower is better; the flat wall is the average colour of the graph):

| Variant | 67js | EEVEE | 67js over flat | EEVEE over flat |
| --- | --- | --- | --- | --- |
| flat wall | 0.0547 | 0.1129 | | |
| colour only (bump off) | 0.0735 | 0.1194 | +0.0188 | +0.0065 |
| bump only (flat albedo) | 0.0827 | 0.1214 | +0.0280 | +0.0085 |
| both (`brick-graph`) | 0.0967 | 0.1249 | +0.0420 | +0.0120 |

Colour is about +0.019 and bump about +0.028; the earlier split (+0.010 and +0.023) was taken when the flat wall scored 0.1999. The flat wall has since improved by more than 0.07 (ground bounce and sky terms), so a flat wall that matches Cycles almost exactly leaves the graph's detail error fully visible, while EEVEE's flat wall is already 0.113 away from Cycles (luminance 0.559 against 0.616 on the plain wall) and FLIP does not add detail error on top of a brightness offset one for one. Part of the gap is the metric: the excess moved from 0.0254 to 0.042 because the flat wall got better, not because the graph got worse.

Parity of the Blender material with the graph, checked line by line: Bump node Distance 0.15 times `graphBump`, strength 1, not inverted, height into Bump (not Displacement), normal into the Principled Normal; Colour Ramp linear with linear stop colours; the bake writes `linearToSrgbByte` and the map is sampled as sRGB, so mix and ramp are evaluated linearly on both sides; the UVs agree (v flipped in the mesh, undone in the translator). The slope is bump / 32 per UV unit in the bake and `0.15 * bump` per world unit in Blender, which is 0.8 and 1.2 of it along U and V on the 6 by 4 wall and was measured to be worth about 0.0003 earlier. No mismatch in the export, so the Blender side and its renders are unchanged.

The mismatch that is in the compiler: the bake read the slope by a central difference over two baked texels, so a joint edge a texel thin became three texels wide, and the bands of a bevel were wider than Blender's, whose Bump node reads a footprint of 0.1 pixel. `bakeMaterialGraph` now evaluates the height function half a texel either side of each texel centre (`normalMapFromHeightFunction`), with the same slope scale per UV unit. Step in texels against 67js GPU, FLIP of `brick-graph` against Cycles (against EEVEE): 2 texels 0.1060 (0.0978), 1 texel (the old bake) 0.0967 (0.0973), 0.5 texel 0.0933 (0.0994), 0.25 texel 0.0931 (0.1010). The half texel is kept: the quarter texel gains 0.0002 and moves the render further from EEVEE.

After the change: `brick-graph` 0.0933 (GPU) and 0.0930 (CPU) against Cycles, 0.0994 against EEVEE; `brick-flat` 0.0547. Excess over the flat wall 0.0386, was 0.0420 on the same renders, against EEVEE's 0.0120, so the first Done-when box of #50 stays open (gap 0.0266). Only `brick-graph` reads a graph. The full default run and the `--grand` run scored every other scene within 0.002 of main or better (`mountain-valley` 0.1769 to 0.1693 and the grand mountain-valley rows improved from other work on main; none is worse). The bundle budgets of the three `agent-scene` and `agent-asset` lazy entries were raised to the measured size plus 20 bytes (3 lines of `bench/size/budgets.json`). `emissive-sign` (new on main) had no Cycles render in the stored arrays and was rendered here to complete the run (0.2372 against Cycles); its row is not committed in this change.

What is left is not in the bake. On the bump-only wall across the dark side of a joint, luminance (display space) is 0.25 at the darkest pixel in Cycles, 0.34 in EEVEE and 0.37 in 67js, against 0.62 on the flat wall: EEVEE and 67js agree with each other and Cycles is darker. That is a shading difference on a normal tilted about 70 degrees from the surface, in the lighting of `src/shaders.js`, which this change does not touch; it needs the engine session.

## The graph noise node is Blender's Noise Texture (2026-11-04, part of issue #50, RTX 3060 960 x 540)

The brick-tone error of `brick-graph` was a pattern error: the `noise` node was a periodic gradient noise with its own hash, so its blotches sat in other places than Cycles' and EEVEE's. Blender 5.2.2 headless baked its Noise Texture (2D, Fac) over the unit square to float arrays (Cycles on the CPU, 1 sample, filter 0.01, `Geometry > Position` as the vector), and the 67js node (`tile: false`) was evaluated at the same pixel centres, 256 x 256.

| Property | Before | Blender 5.2 | Now |
| --- | --- | --- | --- |
| Lattice hash | `hashCell` (xxHash-style mix of the cell and the seed) | Jenkins lookup3 `hash_uint2` of the corner | the same as Blender |
| Corner gradient | one angle per corner, unit vector | 8 gradients picked by the low 3 hash bits, `(x, y)` mixed with `2 * (y, x)` | the same |
| Output scale | `1.5 * gradient`, range about -1 to 1 | `0.6616 * perlin` | the same |
| Octaves | cells doubled per octave inside a wrapped period, gain 0.5, own seed per octave | Detail `n - 1`: `n` octaves, Roughness 0.5, Lacunarity 2, same lattice shifted by the frequency | the same |
| Normalize and offset | `value * 0.5 + 0.5` of the amplitude-normalised sum | `0.5 * sum / amplitude sum + 0.5` | the same |
| Tiling | wrapped over the unit square | none | wrapped by default; `"tile": false` is Blender's endless lattice (exact, does not repeat) |
| Seed | per-octave seed in the hash | none | moves the lattice by whole cells; Blender's side adds the same shift |

Node output against the Cycles bake: scale 10, detail 2: max 0.000048, mean 0.000011 over 65,536 pixels (both ranges 0.120 to 0.831); scale 7, detail 5 (6 octaves): max 0.000052, mean 0.000010. That is float precision, so the match is per pixel; `tests/material-graph.test.js` keeps six Cycles values. The colour ramp (LINEAR in RGB, stops in linear colour) and the Map Range smoothstep were read and need no change. Not touched: `voronoi`, which no reference scene uses and which Blender computes with its own jittered-point hash; it still differs from Blender's Voronoi Texture.

Suite on the GPU through `raster-only.mjs` (26 scenes, before on main, after on this branch), scored by FLIP against the stored Cycles arrays: 24 scenes are byte-identical PNGs (no other scene reads a graph), so the worst delta there is 0.0000. The two that changed:

| Scene | Before | After |
| --- | --- | --- |
| `brick-graph` | 0.0871 | 0.0734 |
| `brick-flat` (its colour is the average of the graph map, which moved) | 0.0547 | 0.0556 |

The excess of the graph wall over the flat wall is 0.0178 (was 0.0324), against EEVEE's 0.0120, so the first Done-when box of #50 stays open, by 0.0058. The wall luminance mean is 0.5455 (Cycles 0.5495) and the darkest pixel 0.210 (Cycles 0.218). In the error map of the wall the brick tones now agree; what is left is a thin line along the lit and dark edges of every brick (the bump at the joint), not the tone. The scene's noise seed of 2 became the default 0 because Cycles never had it (the stored Cycles and EEVEE arrays stay valid).

## The sky share of a tilted normal, squared (2026-11-04, part of issue #50, SwiftShader 960 x 540)

Rendered on SwiftShader (`run.mjs --no-gpu --skip-blender --skip-cpu --scene brick-graph,brick-flat`, no GPU) and scored by FLIP against the stored Cycles and EEVEE arrays (`brick-graph` and `brick-flat` rows reproduce the committed 0.0933 and 0.0547 to within 0.0004). Only `brick-graph` has a normal map in the suite, so the change cannot move any other scene (the line is behind `USES_NORMAL_MAP`); `brick-flat` was rendered again and stayed 0.0543. Wall pixels are rows 110 to 430, columns 230 to 730, display luminance.

| Variant of the horizon share `h = 0.5 + 0.5 * dot(mapped, geometric)` | `brick-graph` against Cycles | darkest pixel | 1st percentile | mean |
| --- | --- | --- | --- | --- |
| Cycles | | 0.218 | 0.253 | 0.5495 |
| EEVEE (0.1249 against Cycles) | | 0.218 | 0.266 | 0.5199 |
| `h` (before) | 0.0930 | 0.289 | 0.326 | 0.5591 |
| `h^1.5` | 0.0893 | 0.252 | 0.283 | 0.5521 |
| `h^2` (kept) | 0.0866 | 0.210 | 0.240 | 0.5459 |
| `h^3` | 0.0884 | 0.144 | 0.170 | 0.5355 |
| `h^2`, and the shadow lookup with the geometric normal | 0.0909 | 0.210 | 0.240 | 0.5493 |

Excess over the flat wall (0.0543): 0.0387 before, 0.0323 after, against EEVEE's 0.0120, so the first Done-when box of #50 stays open. The dark side moves from 0.289 to 0.210 where Cycles has 0.218, and the wall mean from 0.5591 to 0.5459 (Cycles 0.5495). The shadow lookup with the geometric normal made it worse and was not kept. The change is one line of `src/shaders.js`; `scene:lit-box` grows 16 bytes gzip (50127 to 50143, over the 50,000 goal already on main by 127).

## The dark side of a tilted normal, next levers measured and none kept (2026-11-04, part of issue #50, RTX 3060 960 x 540)

Scored on the GPU through `raster-only.mjs` and FLIP against the Cycles and EEVEE arrays of the 2026-11-03 run (same scorer maths as `score.py`; wall pixels rows 110 to 430, columns 230 to 730, display luminance). Main with the squared horizon share of #365: `brick-flat` 0.0547, `brick-graph` 0.0871 against Cycles (EEVEE 0.1249 and 0.1129), so the excess is 0.0324 against EEVEE's 0.0120. The darkest wall pixel is already 0.210 (Cycles 0.218, EEVEE 0.218), and the wall mean is 0.5462 (Cycles 0.5495); the SwiftShader round of #365 and the GPU agree.

| Variant, `brick-graph` only (`brick-flat` stayed 0.0547 in each) | against Cycles | excess over the flat wall | darkest pixel |
| --- | --- | --- | --- |
| main, `h^2` | 0.0871 | 0.0324 | 0.210 |
| `h^1.75` | 0.0883 | 0.0336 | 0.231 |
| `h^2.5` | 0.0869 | 0.0322 | 0.174 |
| `h^3` (the cube) | 0.0890 | 0.0343 | 0.145 |
| sun diffuse times `max(dot(geometric, L), 0)` | 0.1613 | 0.1066 | 0.210 |
| sun diffuse times `smoothstep(0, 0.25, dot(geometric, L))` | 0.0871 | 0.0324 | 0.210 |

Not scored, because the result is known without a render: the fill lights (`fillIntensity` is 0 in this scene, so the term is zero) and the sky and environment specular (`occlusion`, which already carries the horizon share, multiplies the environment diffuse and the environment specular together, so that clip is already there). The wall faces the sun, so a soft terminator clip is a no-op and the literal product only darkens the whole lit wall.

Nothing is kept: `h^2.5` is 0.0002 better, inside the spread between runs, and pushes the darkest pixel past Cycles, so the exponent is at its optimum between 2 and 2.5. The remaining 0.0324 is not shading at the joint. The FLIP error map of 67js on the wall is the blotchy low-frequency brick tone inside each brick (inferred from the error map, not isolated: the noise through the colour ramp, which the two renderers may evaluate differently), while EEVEE's error is an almost uniform offset of its darker flat wall (0.560 against 0.615), which FLIP charges less than misplaced detail. The excess over the flat wall therefore compares a pattern error with a brightness offset, and a shader change at the joint cannot close it. No source file changed, so no size or suite number moved.

## Named looks for the grand scenes (2026-11-03, part of issue #168)

`look-options.js` holds a second round of options for the three grand scenes, each a named variant: `node bench/reference/run.mjs --option mountain-valley:dawn` (several separated by commas) draws it with the GPU only into `artifacts/reference-look/<scene>-<option>-gpu.png`, with no Blender, no score and no baseline change. Sheets: `uv run --no-project --with pillow python -I bench/reference/look-sheets.py artifacts/reference-look artifacts/look-168` copies each frame to `artifacts/look-168/<scene>/<option>.png` and writes one contact sheet per scene. The default scenes and the letters of `grand-scenes.js` are unchanged. Blender would get the same geometry and materials: ground cover is vertex colour, facades are material graphs (Emission through the graph), halls use Emission panels and volume fog. An picks; no option is claimed to match anyone's taste.

| Option | What changes |
| --- | --- |
| `mountain-valley:dawn` | Cool dawn, sun behind the far massif, a river down a flat floor, a mist layer, ridges fading into haze, a snowy hero peak |
| `mountain-valley:tarn` | Midday on the shore of a turquoise lake, forest across the water, rounded snow massifs, boulders at the camera |
| `mountain-valley:sunset` | Low orange sun from the left, long tree shadows over wildflower drifts, one peak lit pink |
| `temple-hall:rose` | The nave seen down its axis toward a stained glass rose window and five lancets (all Emission), roof openings with sun shafts, candles along the carpet |
| `temple-hall:court` | Hall open to the sky over the nave, high sun and blue sky light, pale floor, two colossi and a glowing door at the far end |
| `megacity-dusk:golden-avenue` | Street level on a broad avenue at sunset, the right-hand towers lit gold, lines of car lights, street trees |
| `megacity-dusk:blue-hour` | Elevated bank over a river, a 560 m landmark tower, windows lit in drifts, lit bridges, parkland trees |
| `megacity-dusk:night-grid` | High night view of avenue grids, dense towers with most windows lit, cyan and magenta signs |

Terrain shape: the rim is rounded massifs (erosion noise) with a little ridged noise for crags, in place of the reference's needle ridges. Towers have a lit podium, one to three setbacks and a crown (plant, stepped or spire), and a facade graph gives panes in a wall with lit panes in drifts instead of full-width stripes. No downloaded textures or models are used: the terrain chunks and tower boxes carry no UV sets in the export, so a scanned texture would not reach Blender the same way.

## The three picked looks are the grand scenes (2026-11-04, issue #168)

An picked `mountain-valley:dawn`, `temple-hall:rose` and `megacity-dusk:blue-hour`. `GRAND_PICKS` in `look-options.js` adds them to the grand set (`?set=grand`), so `node bench/reference/run.mjs --grand --scene mountain-valley-dawn,temple-hall-rose,megacity-dusk-blue-hour` draws them and Blender renders them; the option names still work. Their entries sit in `grand.json` beside the letter variants, which are unchanged, and the old plain scenes are replaced by these picks (no old against new comparison is kept). `final-sheet.py` writes the contact sheet of the 67js and Cycles frames.

Facade fix: the lit windows of `facadeMaterial` came from a voronoi, whose cells cut the 6 by 10 window grid into shards. A noise read at the centre of each window cell now lights a window as a whole, in drifts, and both noises use `"tile": false` so `render-blender.py` builds the same nodes.

FLIP mean error, lower is better (measured, one run, Blender 5.2.2, 960 by 540):

| Scene | 67js GPU vs Cycles | 67js GPU vs EEVEE | EEVEE vs Cycles |
| --- | --- | --- | --- |
| `mountain-valley-dawn` | 0.2008 | 0.3720 | 0.3039 |
| `temple-hall-rose` | 0.5652 | 0.5727 | 0.8878 |
| `megacity-dusk-blue-hour` | 0.1128 | 0.1081 | 0.0688 |

Known gaps shown on purpose, not hidden by a per-scene setting: the dark band of mid-distance trees in the dawn frame is a 67js defect (the lower tree levels shade near black under sky light and a low sun, issue #394); the temple hall is lit flat in 67js while Cycles leaves it dark, the closed-room-without-bake gap (an open roof is not a bake). The hall has an opt-in for it: `--bake temple-hall-rose` bakes it on the GPU (see below), which takes `temple-hall-rose` from 0.5652 to 0.1181 against Cycles (and makes EEVEE worse, 0.5727 to 0.9019, because EEVEE has no indirect light here); the committed rows above are the plain scene.

### The hall baked on the GPU (2026-11-04, issue #302)

`node bench/reference/run.mjs --grand --scene temple-hall-rose --skip-cpu --skip-blender --bake temple-hall-rose` draws the hall with the light bake on the GPU tracer's kernel (``bakeLightmapsAsync` with `backend: gpu`, which takes up to 1,024 parts where the CPU bake stops at 256; the hall has more than 256). The scene's `bakeOptions` in `look-options.js` are `{ backend: 'gpu', texelsPerUnit: 2, samples: 128, maxSeconds: 300 }`: 2 texels per unit is the density the closed `temple-hall` scene already uses, and the default 6 would need 1,542,896 texels against a limit of 1,000,000. At 2 the bake has 493,632 texels, 3 bounces, and took 16.7 s and 30.1 s in two runs, each including the 7 s kernel compile (RTX 3060, headless Chrome, other sessions on the machine; the two runs gave the same score). Against the same Cycles frame: 0.5652 without the bake, 0.1181 with it (FLIP, 960 by 540, measured). The frame is `images/grand-temple-hall-rose-baked.jpg`. Leave `--skip-cpu` on: the SwiftShader page would run the GPU bake on the CPU. At 256 samples the bake is refused by the ray work limit (758 million of 400 million), so 128 is the most the limit allows at this density. The committed `grand.json` row stays the plain scene.

`lit-interior` with the GPU bake (`--bake lit-interior --bake-backend gpu --bake-samples 512`, the same Cycles frame, measured 2026-11-04): 0.0914 against Cycles, where the CPU bake at its defaults (128 samples) scores 0.1129. `bake-compare.mjs` bakes one scene with named option sets on either backend and prints seconds and the gap between lightmaps; the numbers are in `docs/light-bake.md`. `--bake-density <texels per unit>` and `--bake-samples <n>` set those two bake options for a run.

## The reference harness drew `foliage` in a breeze (2026-11-03, part of issue #191)

Found by comparing the leaf cards of the two sides. No engine code changed and no Blender render changed: the Cycles and EEVEE arrays are the ones of the earlier runs.

| Property | 67js (scene JSON) | Blender (`render-blender.py`) | Same |
| --- | --- | --- | --- |
| Cards | 558 in one geometry, 2,232 vertices, UVs 0 to 1 | the same arrays, `build_mesh` | yes |
| Transform | identity part matrix, Y-up to Z-up | `Y_UP_TO_Z_UP @ matrix` | yes |
| Winding / back faces | `doubleSided: true`, no culling | Principled has no culling, back face keeps the stored normal | yes |
| UV orientation | v as stored | image rows reversed and v flipped, net data row = v * height | yes |
| Alpha mode, cutoff | `mask`, 0.5 | `GREATER_THAN` 0.5 on the texture alpha, then a transparent mix | yes |
| Filtering | linear, trilinear mips | linear, no mips (Cycles) | differs by design (tried in #191, not kept) |
| Wrap | clamp | repeat, but the card texture has alpha 0 on all four edges | no effect |
| Leaf texture | 128 by 128, 22.5 percent of texels above 127 | the same pixels | yes |
| Wind | renderer default `wind: 0.3` at `time: 0` | a still scene | **no** |

The last row is the mismatch. The foliage vertex shader (`windOffset` in `src/shaders.js`) sways and flutters the cards even at time 0, up to 0.14 m of sway and 0.02 m of flutter at strength 0.3. At the camera distance of 12 m a pixel is 0.016 m, so crown cards were drawn up to about 4 px away from where Blender draws them (the shadow pass moves with them). `harness.js` built its frame without `wind`, so every vegetation scene paid for it.

Measured with a CPU rasteriser of the cards (Python, bilinear alpha above 0.5 at mip 0, 4 by 4 samples per pixel, bark as occluder), over the crown rows of the 960 by 540 frame; mismatch is pixels whose "sky or not" differs between that mask and each render:

| Render | Mismatch before | Best shift of the mask before | Mismatch with `wind: 0` |
| --- | --- | --- | --- |
| EEVEE | 1,036 | none | n/a |
| Cycles | 2,523 | none | n/a |
| 67js (GPU) | 3,228 | 1.5 px right, 0.5 px down (2,558) | 1,607 |
| 67js (CPU) | 3,178 | 1.5 px right, 0.5 px down (2,492) | 1,493 |

Fix: `harness.js` renders the reference frame with `wind: 0`. Re-run with 67js only (`--skip-blender`, GPU lock), then `--score-only`; only scenes with leaf cards moved. FLIP against Cycles (GPU), before to after:

| Scene | 67js against Cycles | 67js against EEVEE | EEVEE against Cycles |
| --- | --- | --- | --- |
| foliage | 0.0979 to 0.0838 | 0.0771 to 0.0613 | 0.0924 |
| mountain-valley | 0.1769 to 0.1691 | 0.2668 to 0.2613 | 0.1895 |
| mountain-valley-a (grand) | 0.1671 to 0.1653 | 0.2392 to 0.2373 | 0.176 |
| mountain-valley-b (grand) | 0.2096 to 0.2019 | 0.2645 to 0.2567 | 0.1306 |
| mountain-valley-c (grand) | 0.1836 to 0.1775 | 0.223 to 0.2182 | 0.1522 |

`foliage` now sits 0.0086 under EEVEE against Cycles (was 0.0055 over). Every other default and grand scene has no leaf cards and was not re-rendered; the only score that rose is a GPU against CPU difference (`gpu-vs-cpu` of `foliage` 0.0095 to 0.0097, `mountain-valley-b` 0.0158 to 0.0164). The Cycles and EEVEE columns did not move, so this is a change on the 67js side of the comparison and not a new reference. The score no longer includes the wind, which a real scene still has by default (`wind` 0.3); that is by design and is not scored here.

## Subsurface scattering (2026-11-04, part of issue #283)

`subsurface` (wax candle, skin sphere, leaf slab, weight 1) and `subsurface-off` (the same scene at weight 0 in both renderers) are scored each against its own Cycles render: the rasterizer scores 0.1180 with subsurface on and 0.0940 off, and EEVEE scores 0.1028 and 0.0764, so the scene with subsurface is the harder one for both, and the on scene does not score better than the off scene. Scored against the same Cycles render with subsurface, the weight 0 picture of 67js scores 0.1229 and the weight 1 picture 0.1180 (0.1211 with back translucency 0.5), so the block moves the picture toward Cycles by 0.005. The leaf is the part that stays dark (signed mean luminance error of -0.05, wax and skin +0.01). Frame cost with `frame-time.mjs <scene> gpu --plain`: 0.45 to 0.49 ms on, 0.455 to 0.485 ms off, the same within noise.

## Reversed-Z depth (2026-11-03, issue #310)

`installReversedDepth(renderer, mode)` (`src/reversed-depth.js`, an addon: the renderer core carries none of it, so a scene that does not install it pays nothing in size) makes the colour pass draw with reversed-Z where `EXT_clip_control` exists. `mode` is `true` (on at once), `false` (off) or `'auto'`, which switches it on, once, at the start of a frame, when that frame's far / near passes 10,000, or when `renderer.requestReversedDepth()` is called; `installDepthPrecision(renderer, { reversedDepth })` installs it together with the coplanar warning and calls that request when the coplanar check finds a flush pair more than 40 units from the eye (a 24-bit buffer with a 0.1 near plane cannot separate a 1 mm gap much beyond that). Switching on respecifies the two depth stores as float and adds one stage that turns the resolved depth back to standard depth for the passes that read it. What it does: clip depth 0 to 1 with the near plane at 1, depth cleared to 0, `GREATER`, and a `DEPTH_COMPONENT32F` multisample buffer and scene depth texture. Everything else keeps the standard path: shadow maps (the sun, cascades and the local atlas), the sky and environment backgrounds and the post passes switch clip control back before they draw, so their projections do not change. The reversed projection is the standard one with its third row replaced by `(w - z) / 2` (`src/reversed-depth.js`), used only by the draw (`renderer.rasterProjection`, `rasterViewProjection`); culling, fog, inverse matrices and the CPU rasterizer keep the standard matrices. The passes that read the depth texture (ambient occlusion, depth of field and the other camera effects, volume fog, line art outlines and lines) are unchanged: a stage right after the resolve copies the depth and writes `1 - depth` back with `gl_FragDepth`, which is exactly the standard 0 to 1 value. The water mirror, render passes (their depth pass is eye distance, not buffer depth), liquid and foam, blended parts and Gaussian splats run inside the reversed window. A decal's polygon offset flips sign with it. `installReversedDepth(renderer, false)`, benchmark mode and a browser without the extension keep the old path (`renderer.reversedDepth` and `renderer.capabilities.reversedDepth` say which one is in use).

Measured by `node bench/reference/depth-precision.mjs [gpu|cpu]` (scene in `depth-precision.js`): two 2.2-times-distance-wide planes at 1, 50 and 500 m, the near one `gap` closer (0, 0.1 and 1 mm), seen at about 30 degrees from their normal with the default near 0.1 and far 600, 8 camera positions about 1 to 10 cm apart per case. The number is the share of the red or blue pixels where the far (blue) plane wins, mean of the 8; 0 is right. Before is the renderer as it is, "reversed, float" is `installReversedDepth(renderer, true)` without the camera-relative transform below (the first version of the addon), "camera-relative" is the addon as it is now, same build. GPU is the RTX 3060 through Chrome (ANGLE), where the extension is present; the camera-relative column was run through `gpu-lock.sh`.

| Distance | Gap | Before (24-bit) | Reversed, float | Reversed, camera-relative |
| --- | --- | --- | --- | --- |
| 1 m | 0, 0.1, 1 mm | 0, 0, 0 | 0, 0, 0 | 0, 0, 0 |
| 50 m | 0 mm | 0 | 0 | 0 |
| 50 m | 0.1 mm | 0.150 | 0.009 | 0.009 |
| 50 m | 1 mm | 0.079 | 0.000 | 0.000 |
| 500 m | 0 mm | 0 | 0 | 0 |
| 500 m | 0.1 mm | 0.190 | 0.134 | 0.069 |
| 500 m | 1 mm | 0.188 | 0.015 | 0.014 |

The gap-0 pair is two identical boxes, so every pixel ties and the first one drawn keeps it; it never flickers, and a coplanar pair of different size is what `decal` and `resolveCoplanar` are for. The wrong share falls to 1 percent or less at 50 m (0.1 and 1 mm) and at 500 m with a 1 mm gap, but not to zero: at 500 m the 0.1 mm case was wrong on 13 percent of pixels with reversed-Z alone.

**Camera-relative transform (2026-11-04, issue #310).** The vertex shader multiplied `viewProjection` by the world position, a sum of terms as large as the distance to the eye, so the view translation and the position cancelled in float32. When the addon switches on, `installReversedDepth` compiles the main vertex shader again through `shaderTransforms` (`src/shader-registry.js`) with `gl_Position = viewProjection * vec4(world.xyz - cameraOffset.xyz, 1.0 - cameraOffset.w) + cameraShift`: the eye is subtracted first, only the matrix's linear part multiplies it (w = 0), and the projection's own translation (`cameraShift`, its fourth column) is added. The 4 x 4 matrix stays whole, because the impostor cards and the water refraction read the eye or a world position through it; lighting, fog and shadows keep the absolute `worldPosition`; both uniforms are zero outside the reversed window, where the line is the old product. The renderer core is unchanged, so a scene without the addon draws the same bytes. The 500 m, 0.1 mm pair falls from 0.134 to 0.069 (an earlier trial that baked the camera offset into the planes' matrices in double precision, with the stock shader, gave the same 0.069, so the transform removes what it can); every other case is unchanged. What is left is the float32 step of the planes' own vertices: the matrices are Float32Array and the vertices sit 500 to 1000 m from the box centre, so each is rounded to 0.03 to 0.06 mm, a third to a half of the 0.1 mm gap, and no vertex transform removes that without subdividing the geometry or keeping a double-precision scene. SwiftShader has the extension too (the same page ran there), but this machine's SwiftShader build draws the standard path almost exactly (before 0 to 0.001 in all nine cases), so it is not a precision measure: after is 0 except 0.157 at 50 m with a 1 mm gap, where whole frames are wrong in some jitters, the same number on the base branch before this change.

Pictures: `glass`, `brick-flat`, `outdoor-hdri` and `mountain-valley` drawn by SwiftShader with `render-gpu.mjs --cpu` (standard depth, then reversed through the installed addon), with and without `--reversed-depth`: the first three are byte for byte the same; `mountain-valley` differs on 0.055 percent of its pixels by more than 2 of 255 (largest step 31), the edges of far trees where the depth test breaks a tie differently. With `--ambient-occlusion 1` (which reads the depth texture) `brick-flat` is identical and `mountain-valley` differs on 0.13 percent, largest step 28. The GPU renders of the same four scenes are queued behind a path-tracer job and are not in these numbers.

## Sky visibility traced from the floor texels, measured and kept opt-in (2026-11-04, issue #197)

The attempt the volume section named: trace the sky from the floor itself. `applyFloorSkyVisibility(parts, options)` (`src/floor-sky-visibility.js`, `67js/addons/floor-sky-visibility`, nothing in core) finds the floor parts (thin, at least 2 percent of the scene's footprint, opaque, plain, at least 30 percent of the area facing up, no light map and no baked `skyVisibility`), cuts their upward triangles by the longest edge to about 24,000 texels in total, and from each texel shoots 64 cosine-weighted rays (a fixed set, so the same scene gives the same bytes) against every other opaque part with the bake's BVH tracer. The share that escapes goes into the geometry's `skyVisibility`, which the shader already multiplies into the world and sky light of that surface, so the shader and the core entry are unchanged. `strength` blends the share toward 1 (`1 - strength * (1 - share)`). The trace is capped at 20 s and leaves the parts as they were past it, above 200,000 triangles, or when the scene has no floor. A closed room (the ray test of the ground bounce) is left alone unless `includeClosedRooms` is set. Harness: `npm run reference -- --floor-sky [<strength>] [--floor-sky-rooms]`, `frame-time.mjs --floor-sky=<strength>`.

Main at `8153626`, GPU, 960 x 540, FLIP against the stored Cycles arrays, 24 scenes of the default suite and the nine grand options; change from a fresh render of main on the same machine (it reproduces the committed rows: `long-street` 0.1121, `material-spheres` 0.0954, `metal` 0.0944). Scoring is the `score.py` FLIP of each GPU frame; no `baseline.json` row is rewritten.

| Variant | Better than -0.002 | Worse than +0.002 | Worst |
| --- | --- | --- | --- |
| Strength 1, rooms traced too | `brick-flat` -0.0067, `brick-graph` -0.0073, `brushed-film` -0.0090, `car-paint` -0.0143, `material-spheres` -0.0103 | 13 | `lit-interior` +0.1207, `brick-room` +0.1157, `metal-room` +0.1044, `long-street` +0.0368, `dark-shaft` +0.0176 |
| Strength 0.5, closed rooms left alone | `brick-flat` -0.0041, `brick-graph` -0.0039, `brushed-film` -0.0063, `car-paint` -0.0090, `material-spheres` -0.0099 | 4 | `long-street` +0.0135, `megacity-dusk` +0.0032, `emissive-sign` +0.0027, `light-linking` +0.0023 |
| Strength 0.5, rooms traced too | the five above and `temple-hall` -0.0030 | 8 | `brick-room` +0.0561, `lit-interior` +0.0532, `metal-room` +0.0510, `long-street` +0.0135, `dark-shaft` +0.0073 |

Grand options (strength 0.5): `megacity-dusk-b` +0.0033, `-c` +0.0017, `-a` -0.0002; the three valley options are untouched (`mountain-valley-a` and `-b` pass the triangle limit, `-c` has no floor part); the three temple options are closed rooms and unchanged, and traced as rooms they improve: `temple-hall-a` 0.1642 to 0.1536, `-b` 0.1564 to 0.1355, `-c` 0.1177 to 0.1016.

Box 2 (`shadow-depth.py`, display luminance, 67js before > after / Cycles; strength 0.5, rooms traced):

| Scene | p1 | p5 | p25 | contrast (log2) |
| --- | --- | --- | --- | --- |
| `dark-shaft` | 0.0437 > 0.0322 / 0.0293 | 0.0437 > 0.0350 / 0.0313 | 0.0468 > 0.0400 / 0.0430 | 2.46 > 2.51 / 1.96 |
| `temple-hall-a` | 0.0487 > 0.0423 / 0.0334 | 0.0557 > 0.0507 / 0.0363 | 0.0669 > 0.0555 / 0.0466 | 1.16 > 1.17 / 1.33 |
| `temple-hall-b` | 0.0709 > 0.0555 / 0.0339 | 0.0717 > 0.0583 / 0.0370 | 0.0787 > 0.0661 / 0.0449 | 0.78 > 0.78 / 1.80 |
| `temple-hall-c` | 0.0386 > 0.0282 / 0.0163 | 0.0394 > 0.0319 / 0.0184 | 0.0552 > 0.0398 / 0.0222 | 1.33 > 1.34 / 2.02 |
| `megacity-dusk-a` (not a room) | 0.0494 > 0.0494 / 0.0461 | 0.0628 > 0.0600 / 0.0603 | 0.1124 > 0.1124 / 0.1082 | 2.74 > 2.76 / 2.32 |
| `long-street` (not a room) | 0.2006 > 0.2006 / 0.1378 | 0.3642 > 0.2986 / 0.3223 | 0.5072 > 0.5072 / 0.4793 | 1.11 > 1.20 / 1.59 |

The dark end moves toward Cycles in every hall (p1 down by 0.006 to 0.015, p25 down by 0.007 to 0.015) and in `dark-shaft`, but the contrast does not: it moves by at most 0.1 log2 step, and `temple-hall-b` stays at 0.78 against 1.80. Reading (inferred): the light is lowered everywhere on the floor, lit and shadowed tiles alike, because the sky light does not separate them; the contrast needs the sun's shadow to be deeper, which a sky term can not give.

Which scenes fail, and why (inferred, not isolated): `long-street` (+0.0135 at 0.5) and `megacity-dusk` (+0.0032) are lit by the sun and by light that comes back from the walls and the lit street; the term removes sky from a floor that Cycles still lights from the facades, so the street gets too dark. The rooms lit by lamps alone (`lit-interior`, `brick-room`, `metal-room`) lose their whole ambient floor light, which the lamps' bounce gave; they are why closed rooms are skipped.

Cost, measured (GPU, `frame-time.mjs --plain`, median of 3 runs in two rounds): the trace takes 0.5 to 1.7 s for the usual 33,000 to 56,000 texels (2.1 to 3.6 million rays, 64 per texel; `brick-room` 6.4 s for 253,000 texels because its floor part is large). Frame time rises because the floor goes from 2 triangles to about 66,000: `long-street` 0.40 to 0.61 ms, `material-spheres` 0.52 to 0.63 ms, `temple-hall-a` 1.50 to 1.80 ms (+0.1 to +0.3 ms; the shadow pass draws the triangles too). A 2D texture read in the shader would avoid that and needs a core hook; it was not tried.

Box 4 fails: four default scenes pass the 0.002 limit at the best variant (`long-street` +0.0135 is the worst), so the term is not on by default. It stays as an opt-in addon, off unless a scene calls `applyFloorSkyVisibility` or the harness flag is given, so the default frames, `baseline.json` and `grand.json` are unchanged. It helps `car-paint`, `brick-flat`, `brick-graph`, `brushed-film`, `material-spheres` (-0.004 to -0.010) and the three temple options (-0.011 to -0.021), and costs the street and city scenes. Next idea, if taken up: a per-texel map that also carries the light that comes back from the lit walls (the sun-lit side of the facades seen from the floor texel), so a street is darkened by the sky it loses and lit by what the facades give, instead of by sky visibility alone.

## Water shadows (2026-11-03, part of issue #349)

A post stands in a 12 m pool and the camera looks straight down (`scripts/water-shadow-scene.js`, run by `node scripts/measure-water-shadows.mjs`). Shadow contrast is the lit minus the shadowed bed, per channel, against the same pool dry, so the absorption of the column is what is left. Measured in Chrome with 8 bit output, inverted to linear:

| Preset | Depth | Red | Green | Blue | `exp(-absorption * depth)` for the clear lake (red, green, blue) |
| --- | --- | --- | --- | --- | --- |
| lake | 0.2 m | 0.928 | 0.978 | 1.010 | 0.932, 0.986, 0.992 |
| lake | 1 m | 0.699 | 0.907 | 0.948 | 0.705, 0.932, 0.961 |
| lake | 4 m | 0.227 | 0.694 | 0.785 | 0.247, 0.756, 0.852 |
| sea | 4 m | 0.139 | 0.520 | 0.619 | |
| river | 1 m | 0.204 | 0.190 | 0.087 | |
| river | 4 m | 0.005 | 0.005 | 0.000 | |

The clear lake stays within 10 percent of the formula (the largest gap, 8 percent at 4 m, is the in-scatter of turbidity 0.02). `RENDER_TESTS=1 node --test tests/water-shadows-render.test.js` checks it. On an opaque water surface the post's shadow darkened the steep view by 9.5 to 14 percent before and darkens it by 3 to 4 percent now (river 1.5 percent); the grazing view, which is nearly all reflection, shows 0 percent both times, so the shadow never reaches the mirrored sky.

The reference scenes draw their water as a smooth `surface` part with the planar reflection, not the `water` tag, and the shader code they run is unchanged, so they were not rescored. The Blender Cycles reference of the pool (volume absorption and scatter) and its FLIP score are not taken yet; they wait for a look at the preview.

### Refraction and a dark band (2026-11-04, part of issue #349)

Blended water (a `water` part with opacity below one) now draws its own background: the opaque pass leaves the depth below the water level in the alpha channel of every submerged surface, the water bends the view ray at the surface (n = 1.33, with the wave normal), reads the frame texture where the bent ray meets the bed, and blurs it with a disc of radius turbidity times depth. Where nothing submerged is seen it keeps its own colour. A submerged surface also gets a share of the daylight the water scattered toward the eye, so it fades into the water colour instead of going dark. The bed contrast numbers above hold (lake 4 m: 0.226, 0.688, 0.787 against 0.247, 0.756, 0.852).

The dark band at the foot of a shadow in the first preview was not a doubled shadow: the bed point takes its sun visibility once and the surface lift applies only to water fragments. Along the shadow the bed is even (green channel 0.178 to 0.173 at 1 m, 0.157 to 0.152 at 4 m, seen from above), and a close render shows no band. The band was the shaded side of the submerged post, which got darker with depth and had no scattered light, so it joined the shadow. The scattered light fixes it.

The new preview uses Poly Haven CC0 assets (boulder_01, rock_07, modular_wooden_pier and the gravel_ground_01 material) read from `out/assets`, which is ignored by Git.

## The bump edge of a graph wall: normal map resolution (2026-11-04, part of issue #50, RTX 3060 960 x 540)

Main reproduced the stored rows first: `brick-graph` 0.0734, `brick-flat` 0.0556 against Cycles, excess 0.0178 against EEVEE's 0.0120 (EEVEE against Cycles 0.1249 and 0.1129).

Node level, Blender 5.2.2 headless against 67js, on the unit square of the brick wall (a 6 by 4 plane, Bump Distance 0.15, strength 1):

- Height: the translated Math, Map Range and Wave nodes baked to a float array by Cycles (EMIT, 2048 x 2048) against the graph's `height` at the same pixel centres: max difference 0.00029, mean 0.000023. The brick factor and the joint profile are the same, so the Brick Texture candidates (mortar size, smoothing, offset) are ruled out; the graph does not use Blender's Brick node.
- Bump: Cycles bake of the NORMAL pass (tangent space, Diffuse BSDF; with a Principled BSDF the baked normal is the average of the closure normals and the specular one is clamped, so it is not the bump normal) at 2048 x 2048. Its slope `-n.xy / n.z`, divided by Distance over the world size of each UV axis, equals the analytic derivative of the height to float precision (peak 299.7 against 296.0 per UV unit across a course joint, the difference being the analytic gradient's own 2048 grid). Blender differentiates the height at each pixel, so a joint edge about 2.6 texels wide at 512 loses nothing.
- 67js bakes `normalMapFromHeightFunction` at the colour resolution (512), the slope read half a texel either side (the step is right). Sampled bilinearly at the 2048 grid and compared with Blender's normal (the 67js slope is `bump / 32` per UV unit, Blender's `0.15 / L`, so the scale differs by 1.25 along U and 0.83 along V and is left in both rows): mean angle 3.51 degrees, mean Lambert difference for the sun 0.0340. At 1024 texels: 2.14 degrees, 0.0186. At 2048: 1.36 degrees, 0.0097. The cause is the texel size: bilinear filtering blends the unit normals of two texels, and a joint edge is a few texels wide, so the tilt of its middle pixels reads weaker than the analytic one.

Whole frame, FLIP against the stored Cycles array, `brick-graph` only (every variant rendered in one session, `brick-flat` is 0.0556 throughout):

| Normal map | Texels | Mips | `brick-graph` | Excess over `brick-flat` |
| --- | --- | --- | --- | --- |
| Colour resolution (before) | 512 | yes | 0.0734 | 0.0178 |
| Twice (kept) | 1024 | yes | 0.0714 | 0.0158 |
| Four times | 2048 | yes | 0.0705 | 0.0149 |
| Twice, `LINEAR` only | 1024 | no | 0.0694 | 0.0138 |
| Four times, `LINEAR` only | 2048 | no | 0.0690 | 0.0134 |
| Colour resolution, `LINEAR` only | 512 | no | 0.0728 | 0.0172 |

Kept: twice the colour resolution, capped at 1024 texels, with the default trilinear filter. The map without mips scores 0.002 better, but a normal map with no mips shimmers where the wall is far away, and the shader samples it once per pixel, so it was not kept. Four times costs 16.8 MB for a 512 pattern. The bake reads the height four times per texel; the brick wall's height costs 20 work units, so the finer map is 84 million units (0.35 s in Node, 81 ms before) against a new allowance of four times the graph limit, and a graph whose height is too costly keeps the colour resolution.

Tried and not kept (all at 2048 texels with mips unless stated; against Cycles):

| Variant | `brick-graph` |
| --- | --- |
| Blender's world scale (0.8 along U, 1.2 along V) | 0.0732 (from 0.0705) |
| U only 0.8 / V only 1.2 | 0.0728 / 0.0709 |
| U 1.25 / V 0.8 (the opposite) | 0.0697 / 0.0700 |
| Map shifted by a quarter or half a texel along V or U | 0.0704 to 0.0733 (no offset: 0.0705) |
| Sky lobe moved towards the geometric normal (blend 0.5 / 1 / 2, 1024 texels) | 0.0705 / 0.0714 / 0.0725 (no blend 0.0714) |

The world scale is the exact match to Blender and scores worse, and there is no offset between the two renders (the wall's top and bottom edges sit within 0.1 pixel). So what remains is not the normal.

Where the rest is, measured from the 2048 texel render by the sign of the bump slope at each pixel centre (display luminance, 67js minus Cycles): ledges that tilt up towards the sun are +0.046 and +0.057 too bright, ledges that tilt down -0.078 (gentle) and -0.022 (steep) too dark, and the vertical joints are +0.03 too bright on both sides. EEVEE is 0.27 off Cycles on every wall pixel, flat or not, because its flat wall is darker; 67js is 0.057 on the flat wall and 0.146 to 0.196 on the pixels at or next to a bump edge (0.0705 render; 0.0576 for the same pixels of `brick-flat`), which is where its excess sits. Which side is "up-tilted" is read from the sign of the slope (inferred). Cause (inferred, not isolated): Cycles removes the part of the lobe that falls below the geometric plane, which for an up-tilted ledge is the bright upper sky and for a down-tilted one the dark lower half, while the shader scales the whole sky term by one share. Moving the sky lookup towards the geometric normal helped by 0.0009 at best (table) and moved the render away from EEVEE, so it was not kept; it would also add to `scene:lit-box`.

After the change: `brick-graph` 0.0714 on the GPU (CPU render not redone), `brick-flat` 0.0556, excess 0.0158 against EEVEE's 0.0120. The first Done-when box of #50 stays open by 0.0038. Only `brick-graph` reads a graph with a height output among the suite's scenes (no other scene has a normal map from a graph), so no other scene's pixels changed and the full suite was not run.

### Normal map resolution reverted (2026-11-04, issue #50)

The twice-resolution normal bake above is reverted as a default: 0.0020 of FLIP on `brick-graph` did not justify 4 times the normal map memory per graph pattern. A graph normal map bakes at the colour resolution again (`brick-graph` 0.0734).

## Which term carries the tilted-ledge error, and the one fix that fits no size budget (2026-11-04, part of issue #50, RTX 3060 960 x 540)

Method: `brick-graph` rendered on the GPU with one term at a time swapped from the mapped normal to the geometric one (shader switches that were not kept), scored by FLIP against the stored Cycles array and by the mean display-luminance residual (67js minus Cycles) over four wall regions, cut by the mapped normal of each pixel (flat: tilt below 0.03, 101,886 px; up ledge: normal.y above 0.03, 16,374 px; down ledge: below -0.03, 16,636 px; side joint: 25,104 px). Cycles was also rendered with only the sun (`--world-strength 0`) and with only the world (`--sun-strength 0`), 4 to 6 s each, to read each term's response to the tilt on the Cycles side. Main reproduces `brick-graph` 0.0734 and `brick-flat` 0.0556 (excess 0.0178 against EEVEE's 0.0120).

| Variant (one change on main) | `brick-graph` | flat | up ledge | down ledge | side joint |
| --- | --- | --- | --- | --- | --- |
| main | 0.0734 | -0.0066 | +0.0370 | -0.0508 | +0.0111 |
| sun diffuse and specular with the geometric normal | 0.0998 | -0.0070 | -0.0291 | +0.1309 | +0.1050 |
| sun specular off | 0.0863 | -0.0198 | +0.0264 | -0.0543 | +0.0043 |
| sun normal 0.8 / 0.6 / 0.4 of the way from geometric to mapped | 0.0747 / 0.0797 / 0.0810 | -0.0067 | +0.0385 / +0.0346 / +0.0215 | -0.0434 / -0.0292 / +0.0165 | +0.0241 / +0.0575 / +0.0871 |
| environment diffuse with the geometric normal | 0.0766 | -0.0066 | +0.0312 | -0.0806 | -0.0081 |
| environment diffuse normal halfway to geometric | 0.0734 | -0.0066 | +0.0300 | -0.0646 | -0.0032 |
| environment specular reflection about the geometric normal | 0.0722 | -0.0066 | +0.0339 | -0.0537 | +0.0049 |
| reflection sky term times `step(0, dot(reflected, geometric))` | 0.0721 | -0.0066 | +0.0339 | -0.0553 | +0.0035 |
| the same with `smoothstep(-0.1, 0.1, ...)` or a ramp 0.05 to 1.0 wide | 0.0721 to 0.0722 | -0.0066 | +0.0337 | -0.0554 | +0.0035 to 0.0040 |
| horizon exponent with the geometric environment specular: 1.5 / 2.5 / 3 | 0.0743 / 0.0737 / 0.0761 | -0.0066 | +0.0417 / +0.0272 / +0.0213 | -0.0314 / -0.0736 / -0.0910 | +0.0229 / -0.0113 / -0.0258 |

The fill lights are zero in this scene, so that term cannot carry anything. Reading the table:

- The tilt error is in the sun term and the environment diffuse term together, not in specular. With the geometric normal the sun swings the ledges by 0.066 (up) and 0.181 (down), so its response is the large one, and it is too strong on both sides: in linear light, with the albedo divided out and the floor bounce of Cycles estimated as its excess over 67js on the flat wall (inferred), the sun on an up ledge is 1.46 times its flat value in 67js and about 1.14 in Cycles, and on a down ledge 0.31 against 0.45. No blend between the geometric and the mapped normal fixes it, because the side joints get worse as fast as the down ledges improve (table, 0.8 / 0.6 / 0.4).
- The environment diffuse term is too bright on up ledges: with only the world lit, a ledge reads 1.19 times the flat wall in 67js and 0.91 in Cycles (down 0.84 against 0.81, side 0.95 against 0.86). That is 0.018 of the 0.034 linear excess on up ledges. The geometric normal brings the up ledge to 0.88, but the same switch darkens the down ledges by 0.03 in the full image (0.0766), because the lit floor under the wall is part of the environment diffuse term and the mapped normal is what sees it, as in Cycles. So the squared horizon share is already the right shape for the sky; the missing piece is a floor term that keeps the mapped normal.
- Environment specular is the only term that improved when cut like Cycles does: a reflection that points below the geometric plane should see no sky. `skyReflection *= step(0.0, dot(reflected, geometricNormal))` (guarded by `USES_NORMAL_MAP`, next to the squared share) takes `brick-graph` from 0.0734 to 0.0721 and the excess over the flat wall from 0.0178 to 0.0165, still above EEVEE's 0.0120. The gain is the steepest bump edges: at column 392 the pixels on the lit side of a joint (normal.y 0.87 to 1.0) are 0.03 to 0.05 too bright and the ones on the dark side (normal.y -0.35 to -0.72) 0.06 to 0.12 too dark, one to three pixels wide, which is a footprint difference (Cycles averages the bump over the pixel) that no lobe change reaches.
- Not kept. The line costs 16 bytes of `scene:lit-box` (49957 to 49973) and 22 of `scene:agent-scene` (102827 to 102849), against 8 allowed there; merging it with the squared share into one `if` block did not change that (+16 and +22), the `smoothstep` form costs 5 bytes more, and removing trailing zeros from the shader's literals made the gzip larger (+48 / +34). The change is ready to take when a budget allows it: one line of GLSL, no other scene has a normal map in the suite, so no other reference scene could move. The full suite was not run because nothing changed.
- Where the rest of the 0.0165 is, in order: the sun's tilt response (above), the one-to-three pixel footprint at steep joints, and the environment diffuse of up ledges. The sun's response is what a next worker should isolate with a per-pixel comparison against a Cycles Diffuse-only bake.


## The excess of the brick graph wall is a limit at the bevel edges (2026-11-04, closes issue #50)

The box of #50 asks for the excess of `brick-graph` over `brick-flat` in 67js to be no larger than EEVEE's, against Cycles. On main it is 0.0178 (0.0734 and 0.0556) against EEVEE's 0.0120 (0.1249 and 0.1129). It is documented here as a limit, not closed.

What was measured:

- The excess is shape, not brightness. Over the wall rectangle the graph wall scores 0.1177 and the flat wall 0.0592; the pixels within 2 of a Cycles edge (half of the wall) carry 0.168 against 0.059 on the flat wall, the interior 0.068 against 0.059. The mean luminance residual on the edges is -0.0015. Across a joint's dark side 67js stays 0.02 to 0.03 lighter in the tail (row 168, columns 426 to 429) and on the lit shoulder 0.03 to 0.04 lighter, so 67js leaves a bevel more softly than Cycles. Cycles reads the height function at the pixel; 67js reads a 512 texel normal map through bilinear filtering.
- Lighting terms, tried in turn (PR #414 and the rounds above): the squared horizon share (kept), exponents 1.75 to 3, the sun with the geometric normal or a blend, the environment diffuse and specular about the geometric normal, a sky reflection cut below the geometric plane (0.0734 to 0.0721, excess 0.0165, +29 bytes gzip on `scene:agent-scene` which sits over its goal, so it was not merged), the filtered normal length (0.0744), and a Gaussian blur of the 67js frame standing in for Cycles' film filter (no gain). None reaches 0.0120.
- Data only, this round (no engine byte changes): a 768 texel graph is not a valid resolution (256, 512 or 1024 only); 1024 is over the work limit of 30,000,000 (52 work units per pixel with 2 noise octaves, about 28 allowed), so a finer bake needs a smaller graph or a faster evaluator. Wider bevels in the scene graph (Blender gets the same graph and was rendered again): joint widths 0.10 to 0.36 and 0.06 to 0.26 gave `brick-graph` 0.0708 and `brick-flat` 0.0544 (excess 0.0164, EEVEE 0.0134 on the new renders), and 0.08 to 0.5 and 0.04 to 0.4 gave 0.0738 and 0.0529 (excess 0.0209, EEVEE 0.0166). The gap to EEVEE stays at 0.003 to 0.006 whichever bevel is used, and EEVEE's own excess moves with it, so changing the scene only moves the target. The scene was left as it is.

What would close it is a finer height-to-normal source than a 512 texel map (an analytic or 1024 texel bake of a graph that fits the work limit), which is engine work and costs memory or bytes; it is outside the data-only brief and the size goals. `brick-graph` is 0.0734 against Cycles, 0.1249 for EEVEE against Cycles on the same scene, so 67js is closer to Cycles than EEVEE is on this wall.

## Sky seen from the floor, on by default for sunlit closed rooms (2026-11-04, part of issue #197)

The opt-in trace above helped halls and studio floors and hurt streets, cities and rooms lit by lamps alone. The split is by what lights the scene, not by geometry: the mean traced visibility of the floor did not separate them (`temple-hall` 0.45, `dark-shaft` 0.54, but also `lit-interior` 0.55, `metal-room` 0.49 and `brick-room` 0.26, measured at strength 1). The rule that does separate them: a closed room (the ray test of the ground bounce) that a sun lights. `applyFloorSkyVisibility(parts, { onlyClosedRooms: true })` traces only closed rooms, at `FLOOR_SKY_ROOM_STRENGTH` 0.2, and returns open scenes unchanged (`report.reason` `open scene`). `applyDefaultFloorSky(parts, environment)` adds the sun test and the opt-out, and it is what `createAgentScene` calls for every recipe that names its sun (the module loads lazily, `environment.floorSkyTrace: false` opts out, see `docs/agent-look.md`). The harness calls the same function with the scene's environment and sets nothing of its own, so a recipe and the reference scene get the same frame; `--no-floor-sky` sets the opt-out on every scene, and `--floor-sky <strength>` is an experiment that traces every floor. Nothing in core; `report.meanVisibility` is new.

GPU, 960 x 540, FLIP against the stored Cycles arrays, change from a render of main on the same machine (24 scenes and the 9 grand options; a scene not listed changed by less than 0.002, and all open scenes and lamp-only rooms are identical by construction):

| Strength | `temple-hall` | `temple-hall-a` | `-b` | `-c` | `dark-shaft` | any other scene |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | +0.0113 | -0.0085 | -0.0080 | -0.0285 | +0.0176 | `foliage` +0.0068 |
| 0.5 | -0.0030 | -0.0106 | -0.0209 | -0.0161 | +0.0073 | none past 0.002 |
| 0.25 | -0.0032 | -0.0063 | -0.0116 | -0.0079 | +0.0025 | none past 0.002 |
| 0.2 (kept) | -0.0023 | -0.0051 | -0.0096 | -0.0061 | +0.0017 | none past 0.002 |

0.2 is the largest strength that keeps `dark-shaft` within the 0.002 limit; the shaft's walls and floor get sun bounce in Cycles that a sky trace does not hold, so the shaft is the scene that sets the strength (guessed, not isolated).

Box 2, dark end (`shadow-depth.py`, display luminance, 67js before > after / Cycles):

| Scene | p1 | p5 | p25 | contrast (log2) |
| --- | --- | --- | --- | --- |
| `dark-shaft` | 0.0437 > 0.0389 / 0.0293 | 0.0437 > 0.0400 / 0.0313 | 0.0468 > 0.0437 / 0.0430 | 2.46 > 2.48 / 1.96 |
| `temple-hall` | 0.0246 > 0.0207 / 0.0200 | 0.0246 > 0.0235 / 0.0221 | 0.0389 > 0.0350 / 0.0282 | 1.74 > 1.74 / 1.80 |
| `temple-hall-a` | 0.0487 > 0.0451 / 0.0334 | 0.0557 > 0.0555 / 0.0363 | 0.0669 > 0.0630 / 0.0466 | 1.16 > 1.17 / 1.33 |
| `temple-hall-b` | 0.0709 > 0.0709 / 0.0339 | 0.0717 > 0.0717 / 0.0370 | 0.0787 > 0.0751 / 0.0449 | 0.78 > 0.77 / 1.80 |
| `temple-hall-c` | 0.0386 > 0.0338 / 0.0163 | 0.0394 > 0.0347 / 0.0184 | 0.0552 > 0.0515 / 0.0222 | 1.33 > 1.33 / 2.02 |

The dark percentiles move toward Cycles in every row but by small steps (p1 by 0.000 to 0.005, p25 by 0.003 to 0.004; `temple-hall` p1 is now within 0.0007 of Cycles). The lit to shadow contrast does not move (at most 0.02 log2 step), as the opt-in section said: a sky term lowers lit and shadowed tiles together. `temple-hall-b` p1 and p5 do not move because its darkest pixels are lit by its lamps, not by the sky. The contrast gap needs a deeper sun shadow, not sky light, and is still open.

Cost, measured on a loaded machine (another heavy job ran beside, so read these as ranges; `frame-time.mjs --plain`, one run each): `temple-hall` 1.83 ms without and 2.23 ms with, `dark-shaft` 2.38 ms without and 2.11 ms with. The trace takes 1.2 s and 0.6 s when the scene is prepared. Size: `entry:floor-sky-visibility` +285 bytes gzip, `scene:agent-scene` +287 (103229 to 103516, a goal scene, over its goal of 100000), `scene:agent-scene+lazy` +3741, `scene:lit-box` 0.

Rows refreshed: `temple-hall` and `dark-shaft` in `baseline.json` (with their sheet images) and the three temple options in `grand.json`, from a Blender 5.2.2 rerun of just those scenes with the final code. The other rows, and `long-street` and `megacity-dusk-a`, which render identically, are left as they were.

## Water shadows against Cycles (2026-11-04, closes the last box of issue #349)

`node scripts/score-water-shadows.mjs` draws the pool of the section above from overhead in 67js (480 x 270, 40 degree view) and in Blender 5.2 Cycles (CPU, 6 threads, 96 samples, denoised): the water is a box with Volume Absorption (`1 - absorption / density` as colour, so the coefficient is the preset's per metre) plus Volume Scatter (density = the preset's turbidity per metre, an assumed mapping, since turbidity has no physical unit). The sky and sun in Cycles are set from the dry bed 67js measured (sky = shadowed bed / albedo, sun from the lit minus shadowed difference), so a dry pool is the same exposure in both. `bench/reference/water-shadows-cycles.py` builds it and `bench/reference/water-shadows-score.py` scores it.

Whole frame FLIP of 67js against Cycles (Cycles tone mapped like 67js), and the bed shadow contrast (lit minus shadowed against the same pool dry; red, green, blue):

| Pool | FLIP | FLIP, same pool dry | 67js | Cycles | `exp(-absorption * depth)` |
| --- | --- | --- | --- | --- | --- |
| lake 0.2 m | 0.3027 | 0.3358 | 0.939, 0.970, 0.999 | 0.858, 0.964, 0.979 | 0.932, 0.986, 0.992 |
| lake 1 m | 0.4530 | 0.3735 | 0.699, 0.918, 0.937 | 0.463, 0.842, 0.901 | 0.705, 0.932, 0.961 |
| lake 4 m | 0.5628 | 0.4834 | 0.227, 0.694, 0.788 | 0.064, 0.527, 0.679 | 0.247, 0.756, 0.852 |
| river 0.2 m | 0.4654 | 0.3358 | 0.734, 0.720, 0.631 | 0.710, 0.682, 0.513 | 0.852, 0.835, 0.726 |
| river 1 m | 0.5890 | 0.3735 | 0.206, 0.179, 0.089 | 0.294, 0.276, 0.166 | 0.449, 0.407, 0.202 |
| river 4 m | 0.5408 | 0.4834 | -0.042, -0.036, -0.035 | 0.254, 0.247, 0.159 | 0.041, 0.027, 0.002 |

Reading it: the FLIP of the dry pool is already 0.34 to 0.48, so most of the score is the dry pool (the bed, the post, the sun's penumbra and the sky are not the same picture in the two renderers), and water adds 0.0 to 0.2 on top. The shadow contrast agrees in trend. Cycles fades the clear lake faster than the formula because the sun's path to the bed is longer than the eye's (slant of 1/cos 59 degrees), which `exp(-absorption * depth)` does not count: the shadow difference is lit (two paths) against shadowed (the eye's path only). The murky river is where the two differ most: Cycles keeps 0.25 of the contrast at 4 m, where scattered light still reaches the shadow, and 67js reaches zero (slightly negative, -0.04: the lift overshoots the lit side). A river that clears to nothing at 4 m is a known simplification of the in-scatter lift; it is recorded here and not changed.

### The sun's path and the murky floor (2026-11-04, closes issue #438)

Two gaps in the table above, fixed in the world material chunk. The sun leg to the bed is now absorbed over the refracted path, `depth / cos(theta_t)` with Snell n = 1.33, so a shadowed bed keeps the eye's vertical leg and a lit bed adds the longer sun leg (the clear lake at 4 m was 0.227 red against 0.064 in Cycles). The turbidity lift that pulled the shadow toward the lit side is gone; the murky water instead adds a positive term, the scattered sunlight the post also shadows, so the contrast never goes below 0 and keeps a floor at depth (about a quarter at 4 m in a river). The sun leg also carries an extinction of `0.9 * turbidity * (1 - turbidity)` per metre, the part of the scatter that is not returned.

The contrast is now read at x = 0.9 m, not 0.65 m, for both renderers: at 4 m the post's foot puts 0.65 m on the edge of the shadow, where the wider murky penumbra and refraction blur make the number depend on the edge, in Cycles as much as in 67js. The Cycles renders are the ones of the section above, not re-rendered (their scene is unchanged). `node scripts/score-water-shadows.mjs --skip-blender` rescores against them. Contrast (red, green, blue) against Cycles, and whole frame FLIP:

| Pool | Before | After | Cycles | FLIP before | FLIP after |
| --- | --- | --- | --- | --- | --- |
| lake 0.2 m | 0.939, 0.971, 0.999 | 0.874, 0.974, 0.970 | 0.861, 0.969, 0.983 | 0.3027 | 0.3170 |
| lake 1 m | 0.698, 0.917, 0.931 | 0.493, 0.853, 0.894 | 0.465, 0.845, 0.903 | 0.4530 | 0.3634 |
| lake 4 m | 0.226, 0.696, 0.792 | 0.061, 0.520, 0.673 | 0.063, 0.523, 0.673 | 0.5628 | 0.4653 |
| river 0.2 m | 0.734, 0.723, 0.627 | 0.739, 0.706, 0.526 | 0.706, 0.679, 0.512 | 0.4654 | 0.3993 |
| river 1 m | 0.206, 0.179, 0.090 | 0.312, 0.280, 0.119 | 0.284, 0.264, 0.159 | 0.5890 | 0.4795 |
| river 4 m | -0.001, -0.002, -0.006 | 0.211, 0.210, 0.120 | 0.251, 0.242, 0.156 | 0.5408 | 0.4491 |

Every row is within 0.05 of Cycles in each channel (largest gap 0.040, river 4 m red). The dry pool scores 0.34 to 0.48 by itself, so FLIP moves less than the contrast. `tests/water-shadows-render.test.js` now expects the clear lake to follow `exp(-absorption * depth * (1 + 1 / cos(theta_t)))` and every preset's contrast to stay at or above 0; the river at 4 m, which it expected below 0.05, is expected between 0.1 and 0.35.

## Shadow contrast of the halls and `dark-shaft` after sun bounce, measured and nothing kept (2026-11-06, part of issue #197)

Main at `ce50d2e` (after #434, #462 and #465), 960 x 540. The default scenes are GPU frames against fresh Blender 5.2.2 Cycles arrays; the four temple options are GPU frames against Cycles arrays rendered on the GPU in the same run. Measured with `shadow-depth.py` (display luminance, 67js / Cycles). `top 5%` and `bottom 30%` are the mean display luminance of the pixels where Cycles is brightest and darkest.

| Scene | p1 | p5 | p25 | contrast (log2) | floor | lit-level | top 5% | bottom 30% |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `dark-shaft` | 0.044 / 0.033 | 0.044 / 0.035 | 0.048 / 0.048 | 2.23 / 1.75 | 0.85 | 1.20 | | |
| `temple-hall` | 0.024 / 0.021 | 0.024 / 0.023 | 0.036 / 0.029 | 1.69 / 1.75 | 0.92 | 0.89 | | |
| `temple-hall-a` | 0.049 / 0.036 | 0.063 / 0.038 | 0.067 / 0.050 | 1.16 / 1.29 | 0.73 | 0.66 | 0.26 / 0.36 | 0.071 / 0.045 |
| `temple-hall-b` | 0.072 / 0.037 | 0.072 / 0.040 | 0.076 / 0.049 | 0.85 / 1.80 | 1.41 | 0.70 | 0.28 / 0.38 | 0.077 / 0.044 |
| `temple-hall-c` | 0.035 / 0.017 | 0.038 / 0.019 | 0.052 / 0.024 | 1.36 / 1.97 | 1.68 | 1.06 | 0.30 / 0.35 | 0.052 / 0.021 |
| `temple-hall-rose` | 0.136 / 0.040 | 0.138 / 0.043 | 0.258 / 0.064 | 1.03 / 1.56 | 1.64 | 1.11 | 0.55 / 0.54 | 0.229 / 0.055 |

What it says (measured, causes marked):

- The sun bounce of #462 closed most of the contrast gap in the two default rooms: `temple-hall` is within 0.06 log2 of Cycles, and `dark-shaft` now overshoots (2.23 against 1.75), so it is not a target for more depth. Its p1 is still light (0.044 against 0.033), a flat floor of 8-bit values at the darkest tiles.
- The grand halls are not done. `temple-hall-b` (0.85 against 1.80) and `-c` (1.36 against 1.97) keep the gap, and it has two sides. In `-a` and `-b` the sunlit pixels are too dim (the top 5% of Cycles pixels are 0.26 and 0.28 against 0.36 and 0.38, while p99.9 matches), so the lit side is the larger part of `-a`. In `-b`, `-c` and `-rose` the shadowed side is too light (floor 1.41, 1.68, 1.64; the darkest 30% of pixels are 1.7 to 4 times Cycles).
- `temple-hall-rose` is lit by emissive glass, not by a sun, so the floor sky trace and sun bounce do not apply to it; its dark end is 4 times Cycles (0.229 against 0.055). A fix there is a different term (light from emissive parts, occluded), not a deeper sun shadow.
- Not isolated: why the lit side of `-a` and `-b` is 25 to 30 percent dim. Candidates still to test, one each: fog in the beam taking light that Cycles keeps, the sun bounce lights (about 0.3 gain) lighting walls rather than the lit floor, and the unshadowed bounce lights lifting the shadow side.

No engine change was made and no frame cost changes. The megacity and mountain options were not re-measured in this pass. Box 2 stays open for `temple-hall-b`, `-c` and `-rose`.

## Local volumes (issue #710)

`node bench/reference/local-volumes.mjs gpu` (or `cpu` for SwiftShader) renders a smoky room with a glowing puff, with and without `environment.localVolumes`, writes `images/local-volumes.png` and `images/local-volumes-plain.png`, and prints the frame time. It is not scored against Blender: Cycles has no counterpart for these fields, so it sits outside the 23 scored scenes. Frame time on the RTX 3060 shared with other jobs (2026-11-10, 960 x 540, 4x MSAA, median of 200 frames, three alternating rounds): 1.34, 1.25 and 1.07 ms without volumes, 2.13, 2.11 and 1.54 ms with the haze box and the puff, so the two volumes cost about 0.5 to 0.9 ms (noisy).
