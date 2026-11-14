# Gaussian splat benchmark

Frame time and memory of `crucible/addons/gaussian-splats` (issue #288), and the same splats drawn by the three.js `GaussianSplat`. The guide is [docs/gaussian-splats.md](../../docs/gaussian-splats.md); the sample's licence is in [CREDITS.md](CREDITS.md).

```
node bench/gaussian-splats/fetch-sample.mjs                                  # once: downloads the CC BY sample into data/ (git ignores it)
node bench/gaussian-splats/run.mjs gpu all   # RTX 3060; pictures go to artifacts/gaussian-splats/
node bench/gaussian-splats/run.mjs cpu all                                   # SwiftShader (software GL)
node bench/gaussian-splats/sort-time.mjs                                     # the CPU sort alone, in Node
```

`run.mjs` takes `gpu` or `cpu`, then `engine67`, `three` or `all`, then a case-name filter. Each case loads `harness.html` (Crucible) or `three.html` (three.js) in Chrome at 960 by 540, with 4x MSAA in Crucible and `antialias` in three.js.

## What is drawn

- `millipede-*`: the CC BY sample (116,374 splats), converted to a PLY and placed 2 m behind a recipe part (a plinth, a metal sphere and a ring; the picture is `*-millipede-behind-part.png`, where the ring and sphere hide the millipede). `-alone` has no part and is the case that three.js is compared with. `-sdr` is the same with `hdr: false`.
- `synthetic-100k`, `synthetic-1m`: splats on the six faces of an 8 by 4 by 8 m room, seen from inside with the part in the middle, so the view holds several layers of overlap. The same splats go to three.js as PLY bytes.
- `part-only`: the recipe part with no splats, for the base cost.

A frame is timed from `render()` until a one-pixel `readPixels` returns (`gl.finish()` does not wait in Chrome). Each number is the median of 60 frames on the GPU, 6 on SwiftShader. `orbit` moves the camera 0.04 rad every frame, so every frame sorts: both engines re-sort at that step (three.js re-sorts when the view direction turns by about 1.8 degrees, 0.04 rad is 2.3). `still` keeps the camera, so no sort runs.

## RTX 3060 (measured, one run, machine loaded by other sessions)

Chrome through ANGLE and Direct3D 11, driver 621.01.

| Case | splats | Crucible orbit ms | Crucible still ms | three.js orbit ms | three.js still ms |
| --- | --- | --- | --- | --- | --- |
| part only | 0 | 0.97 | 0.94 | n/a | n/a |
| millipede behind the part | 116,374 | 4.58 | 1.66 | n/a | n/a |
| millipede alone | 116,374 | 3.35 | 1.71 | 2.65 | 1.20 |
| synthetic room | 100,000 | 3.29 | 1.96 | 2.11 | 1.30 |
| synthetic room | 1,000,000 | 13.49 | 3.33 | 11.77 | 2.77 |

The sort and the order upload of Crucible took 1.4 ms at 116,374 splats, 2.0 ms at 100,000 and 11.2 ms at 1,000,000 inside these frames. Alone in Node (`sort-time.mjs`, 40 sorts) the sort took a median of 1.5 ms (range 1.0 to 6.5) at 100,000 and 14.8 ms (range 9.3 to 28.7) at 1,000,000.

Reading it: at 100,000 splats the addon adds about 1 ms to a still frame and 2.3 ms to a moving one. At 1,000,000 it adds 2.4 ms still and 12.5 ms moving, of which the sort is about 11. Three.js is 0.7 to 1.7 ms faster in the moving rows and 0.5 to 0.7 ms in the still rows here; why is not known (guess: a cheaper per-splat draw, since the sorts take similar time).

## SwiftShader (software, measured, one run)

The CPU draws every pixel, so these numbers show fill cost and not what a user sees.

| Case | splats | Crucible orbit ms | Crucible still ms | three.js orbit ms | three.js still ms |
| --- | --- | --- | --- | --- | --- |
| part only | 0 | 49 | 47 | n/a | n/a |
| millipede behind the part | 116,374 | 996 | 1001 | n/a | n/a |
| millipede alone | 116,374 | 884 | 901 | 839 | 832 |
| synthetic room | 100,000 | 500 | 500 | 794 | 720 |
| synthetic room | 1,000,000 | 4580 | 4471 | 5487 | 5964 |

## Memory

| Splats | Crucible GPU (texture and order buffer, counted from sizes) | Crucible CPU kept (positions and sort scratch, counted) | Crucible page JS heap growth | three.js geometry attributes (CPU arrays) | three.js page JS heap growth |
| --- | --- | --- | --- | --- | --- |
| 100,000 | 5.0 MiB | 1.9 MiB | 12 MiB | 3.8 MiB | 57 MiB |
| 116,374 (millipede) | 5.8 MiB | 2.2 MiB | 19 MiB | 4.4 MiB | 75 MiB |
| 1,000,000 | 49.6 MiB | 19.1 MiB | 97 MiB | 38.1 MiB | 229 MiB |

The Crucible GPU figure is the size of the data it uploads: 48 bytes per splat and 4 for the order. It is not read from the driver, and three.js has no such counter, so the table does not compare GPU memory; the three.js column is the size of its CPU attribute arrays and the heap growth of its page. The heap growth is `performance.memory` of Chrome around loading and the timed frames, and includes the parsed arrays that the page still holds, so it is an upper bound on what an app must keep.

## Picture against three.js

`artifacts/gaussian-splats/gpu-millipede-alone-sdr.png` (Crucible, no HDR) and `gpu-three-millipede.png` have the same outline, position and splat shapes at the same camera: both read the same PLY bytes. They differ in colour. Crucible shows the stored colour as is, as 3DGS viewers do (the DC spherical harmonic colour is already display-referred); three.js `GaussianSplat` shows the same file paler (inferred from the code: `GaussianSplatUtils.js` calls the colour `sh0ToLinear` and the renderer then encodes it to sRGB). The background also differs, since three.js has no sky here.

## Limits of this comparison

- The three.js columns of the RTX 3060 and memory tables were measured again on three.js 0.187.0 (2026-11-03, `GaussianSplat` and `GaussianSplatPLYLoader` on `WebGPURenderer` with `forceWebGL`); the Crucible columns and the SwiftShader table are from the earlier run on 0.186.1 and were not repeated. The three.js heap growth at 1,000,000 splats rose from 184 to 229 MiB (single runs, so some of that may be noise).
- Three.js draws with its own scene and no Crucible part, so the part rows have no three.js column.
- One run per cell. Frame times on this machine move with other sessions' load; treat differences under about 1 ms as noise.
- Spherical harmonics beyond degree 0 are skipped by Crucible; the sample has none.
