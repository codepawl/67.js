## Summary across 6 scenes

| Tier | Crucible time (range over scenes) | Blender time (range over scenes) | FLIP, Crucible | FLIP, Blender |
| --- | --- | --- | --- | --- |
| draft (planned name) | 0.54 to 1.04 ms a frame with the pixel read; 0.26 to 0.33 ms queued back to back | 56 to 59 ms a render call | Glaze 0.045 to 0.188 | EEVEE 1 sample 0.041 to 0.562 |
| realtime | 0.77 to 0.98 ms a frame with the pixel read; 0.35 to 0.50 ms queued back to back | 288 to 363 ms a render call | Glaze 0.030 to 0.197 | EEVEE 64 samples 0.042 to 0.562 |
| final (Cook native, 256 samples) | 1.73 to 4.24 ms a sample; 0.71 to 1.32 s for 256 samples with setup | Cycles 6.81 to 26.41 ms a sample; 3.43 to 8.46 s for 256 samples with setup | Cook native 0.019 to 0.080 | Cycles 0.010 to 0.039 |

Final, per-sample speed: Cook native draws a sample 3.8 to 6.2 times faster than Cycles (256 samples, per-scene medians).

Final, equal error, on the 3 noise-limited scenes (lit-interior, spot-area, light-linking), where both engines' relMSE falls roughly as 1/N between 256 and 1024 samples: Cook native needs 6.6 to 19.0 times Cycles' samples (extrapolated from 1024 samples), which is 1.05 to 4.02 times Cycles' time (sampling only) and 0.87 to 2.52 times with setup included.

Bias-limited scenes (no equal-error ratio given; the 1024-sample error is above 0.4 times the 256-sample error, where 1/N gives 0.25): metal (Cycles' target: 2.74e-2 at 256, 2.07e-2 at 1024); glass (Cook native: 5.46e-3 at 256, 5.02e-3 at 1024); outdoor-hdri (Cook native: 2.87e-4 at 256, 1.29e-4 at 1024).

Cook webgpu draws a sample 3.3 to 4.1 times slower than native (256 samples only, so it gets no equal-error figure); its 256-sample image matches native's (relMSE between the two images 1.68e-9 to 2.65e-5, FLIP between them 0.0000 to 0.0003).

## Per scene

### lit-interior

| Tier | For | Runs on | Trade-off | Crucible measured | Blender equivalent measured | FLIP vs Cycles (lower is better) |
| --- | --- | --- | --- | --- | --- | --- |
| draft (planned name) | A quick look while editing | Glaze, 0.5 render scale, 1 sample, light shading, 8 bit target, coarser level of detail | Aliased edges, no environment lookup, a quarter of the pixels enlarged | 0.68 ms a frame with the pixel read (0.66 to 0.74); 0.29 ms a frame queued back to back (0.25 to 0.42); first frame 23.6 ms (22.2 to 23.8), 3 of 3 runs usable | 57 ms a render call (56 to 66); Blender's own render time 57 ms (56 to 66), 3 of 3 runs usable | Glaze 0.188 (0.188 to 0.188) enlarged, 0.193 (0.193 to 0.193) at its own 480x270; EEVEE 1 sample 0.562 (0.562 to 0.562) |
| realtime | Interactive use | Glaze, default settings | No path-traced global illumination: indirect light is approximate | 0.98 ms a frame with the pixel read (0.97 to 2.92); 0.50 ms a frame queued back to back (0.48 to 0.72); first frame 21.1 ms (21.0 to 41.6), 3 of 3 runs usable | 363 ms a render call (356 to 366); Blender's own render time 363 ms (356 to 365), 3 of 3 runs usable | Glaze 0.197 (0.197 to 0.197); EEVEE 64 samples 0.562 (0.562 to 0.562) |
| realtime-high | Interactive, higher quality | Planned (#902), not measurable yet | none | none | none | none |
| final | Offline images | Cook native (Vulkan ray queries) | Error against samples is in the equal-error note below | 4.24 ms a sample (4.21 to 4.32); 256 samples take 1.32 s (1.31 to 1.35) with setup, 3 of 3 runs usable | Cycles: 26.41 ms a sample (26.37 to 26.97); 256 samples take 8.46 s (8.24 to 8.68) with setup, 3 of 3 runs usable | Cook native 0.080 (0.080 to 0.080); Cycles 0.039 (0.039 to 0.039) |
| final | Offline images | Cook webgpu (WGSL compute, software BVH) | Slower per sample than native | 17.33 ms a sample (17.26 to 18.02); 256 samples take 4.86 s (4.84 to 5.05) with setup, 3 of 3 runs usable | same Cycles | Cook webgpu 0.080 (0.080 to 0.080) |

Equal error: Cook native needs about 6.6 times the samples of Cycles (1,685 against 256, to reach relMSE 3.12e-3; extrapolated from 1024 samples as 1 over N, which both engines' measured errors support: relMSE 1.98e-2 at 256 samples and 5.13e-3 at 1024, against Cycles' 3.12e-3 at 256 and 7.70e-4 at 1024). It draws a sample 6.27 times faster, so the time to equal error is 1.05 times Cycles' (sampling only) and 0.87 times with setup included (7.1 s against 6.8 s sampling).

Cook webgpu (measured at 256 samples only) draws a sample 4.1 times slower than native. Its 256-sample image matches native's at equal samples (relMSE between the two images 2.29e-7, FLIP 0.0003). It runs the same kernel, so no separate equal-error figure is given.

### spot-area

| Tier | For | Runs on | Trade-off | Crucible measured | Blender equivalent measured | FLIP vs Cycles (lower is better) |
| --- | --- | --- | --- | --- | --- | --- |
| draft (planned name) | A quick look while editing | Glaze, 0.5 render scale, 1 sample, light shading, 8 bit target, coarser level of detail | Aliased edges, no environment lookup, a quarter of the pixels enlarged | 0.69 ms a frame with the pixel read (0.69 to 0.69); 0.26 ms a frame queued back to back (0.21 to 0.29); first frame 21.9 ms (20.2 to 22.9), 3 of 3 runs usable | 56 ms a render call (54 to 56); Blender's own render time 55 ms (54 to 56), 3 of 3 runs usable | Glaze 0.122 (0.122 to 0.122) enlarged, 0.123 (0.123 to 0.123) at its own 480x270; EEVEE 1 sample 0.203 (0.203 to 0.203) |
| realtime | Interactive use | Glaze, default settings | No path-traced global illumination: indirect light is approximate | 0.94 ms a frame with the pixel read (0.93 to 1.18); 0.41 ms a frame queued back to back (0.39 to 0.44); first frame 23.9 ms (23.3 to 24.8), 3 of 3 runs usable | 307 ms a render call (297 to 310); Blender's own render time 306 ms (297 to 309), 3 of 3 runs usable | Glaze 0.122 (0.122 to 0.122); EEVEE 64 samples 0.203 (0.203 to 0.203) |
| realtime-high | Interactive, higher quality | Planned (#902), not measurable yet | none | none | none | none |
| final | Offline images | Cook native (Vulkan ray queries) | Error against samples is in the equal-error note below | 1.91 ms a sample (1.89 to 2.01); 256 samples take 0.71 s (0.71 to 0.80) with setup, 3 of 3 runs usable | Cycles: 8.85 ms a sample (8.07 to 9.45); 256 samples take 3.74 s (3.54 to 4.11) with setup, 3 of 3 runs usable | Cook native 0.024 (0.024 to 0.024); Cycles 0.011 (0.011 to 0.011) |
| final | Offline images | Cook webgpu (WGSL compute, software BVH) | Slower per sample than native | 6.35 ms a sample (6.34 to 6.47); 256 samples take 2.06 s (2.06 to 2.08) with setup, 3 of 3 runs usable | same Cycles | Cook webgpu 0.024 (0.024 to 0.024) |

Equal error: Cook native needs about 8.5 times the samples of Cycles (2,179 against 256, to reach relMSE 1.21e-4; extrapolated from 1024 samples as 1 over N, which both engines' measured errors support: relMSE 8.63e-4 at 256 samples and 2.58e-4 at 1024, against Cycles' 1.21e-4 at 256 and 2.62e-5 at 1024). It draws a sample 4.72 times faster, so the time to equal error is 1.80 times Cycles' (sampling only) and 1.15 times with setup included (4.1 s against 2.3 s sampling).

Cook webgpu (measured at 256 samples only) draws a sample 3.3 times slower than native. Its 256-sample image matches native's at equal samples (relMSE between the two images 3.63e-8, FLIP 0.0002). It runs the same kernel, so no separate equal-error figure is given.

### light-linking

| Tier | For | Runs on | Trade-off | Crucible measured | Blender equivalent measured | FLIP vs Cycles (lower is better) |
| --- | --- | --- | --- | --- | --- | --- |
| draft (planned name) | A quick look while editing | Glaze, 0.5 render scale, 1 sample, light shading, 8 bit target, coarser level of detail | Aliased edges, no environment lookup, a quarter of the pixels enlarged | 1.04 ms a frame with the pixel read (0.55 to 2.48); 0.33 ms a frame queued back to back (0.23 to 0.52); first frame 28.1 ms (23.3 to 44.0), 3 of 3 runs usable | 56 ms a render call (52 to 56); Blender's own render time 56 ms (52 to 56), 3 of 3 runs usable | Glaze 0.102 (0.102 to 0.102) enlarged, 0.105 (0.105 to 0.105) at its own 480x270; EEVEE 1 sample 0.169 (0.169 to 0.169) |
| realtime | Interactive use | Glaze, default settings | No path-traced global illumination: indirect light is approximate | 0.89 ms a frame with the pixel read (0.83 to 0.94); 0.40 ms a frame queued back to back (0.35 to 0.40); first frame 22.8 ms (20.2 to 23.0), 3 of 3 runs usable | 325 ms a render call (313 to 327); Blender's own render time 325 ms (313 to 327), 3 of 3 runs usable | Glaze 0.098 (0.098 to 0.098); EEVEE 64 samples 0.169 (0.169 to 0.169) |
| realtime-high | Interactive, higher quality | Planned (#902), not measurable yet | none | none | none | none |
| final | Offline images | Cook native (Vulkan ray queries) | Error against samples is in the equal-error note below | 2.14 ms a sample (2.11 to 2.16); 256 samples take 0.78 s (0.78 to 0.78) with setup, 3 of 3 runs usable | Cycles: 9.91 ms a sample (9.63 to 10.14); 256 samples take 4.15 s (4.11 to 4.44) with setup, 3 of 3 runs usable | Cook native 0.025 (0.025 to 0.025); Cycles 0.010 (0.010 to 0.010) |
| final | Offline images | Cook webgpu (WGSL compute, software BVH) | Slower per sample than native | 8.22 ms a sample (7.85 to 19.79); 256 samples take 2.57 s (2.43 to 5.61) with setup, 3 of 3 runs usable | same Cycles | Cook webgpu 0.025 (0.025 to 0.025) |

Equal error: Cook native needs about 19.0 times the samples of Cycles (4,858 against 256, to reach relMSE 5.46e-5; extrapolated from 1024 samples as 1 over N, which both engines' measured errors support: relMSE 8.72e-4 at 256 samples and 2.59e-4 at 1024, against Cycles' 5.46e-5 at 256 and 1.17e-5 at 1024). It draws a sample 4.72 times faster, so the time to equal error is 4.02 times Cycles' (sampling only) and 2.52 times with setup included (10.2 s against 2.5 s sampling).

Cook webgpu (measured at 256 samples only) draws a sample 3.8 times slower than native. Its 256-sample image matches native's at equal samples (relMSE between the two images 1.24e-8, FLIP 0.0001). It runs the same kernel, so no separate equal-error figure is given.

### metal

| Tier | For | Runs on | Trade-off | Crucible measured | Blender equivalent measured | FLIP vs Cycles (lower is better) |
| --- | --- | --- | --- | --- | --- | --- |
| draft (planned name) | A quick look while editing | Glaze, 0.5 render scale, 1 sample, light shading, 8 bit target, coarser level of detail | Aliased edges, no environment lookup, a quarter of the pixels enlarged | 0.69 ms a frame with the pixel read (0.61 to 0.76); 0.28 ms a frame queued back to back (0.23 to 0.34); first frame 16.3 ms (16.0 to 17.2), 3 of 3 runs usable | 59 ms a render call (57 to 61); Blender's own render time 58 ms (57 to 60), 3 of 3 runs usable | Glaze 0.154 (0.154 to 0.154) enlarged, 0.160 (0.160 to 0.160) at its own 480x270; EEVEE 1 sample 0.120 (0.120 to 0.120) |
| realtime | Interactive use | Glaze, default settings | No path-traced global illumination: indirect light is approximate | 0.77 ms a frame with the pixel read (0.71 to 0.88); 0.37 ms a frame queued back to back (0.35 to 0.40); first frame 18.6 ms (17.9 to 20.8), 3 of 3 runs usable | 298 ms a render call (297 to 310); Blender's own render time 298 ms (296 to 310), 3 of 3 runs usable | Glaze 0.124 (0.124 to 0.124); EEVEE 64 samples 0.120 (0.120 to 0.120) |
| realtime-high | Interactive, higher quality | Planned (#902), not measurable yet | none | none | none | none |
| final | Offline images | Cook native (Vulkan ray queries) | Error against samples is in the equal-error note below | 2.60 ms a sample (2.60 to 2.69); 256 samples take 0.96 s (0.96 to 1.02) with setup, 3 of 3 runs usable | Cycles: 9.81 ms a sample (9.80 to 10.08); 256 samples take 4.20 s (4.18 to 4.27) with setup, 3 of 3 runs usable | Cook native 0.041 (0.041 to 0.041); Cycles 0.014 (0.014 to 0.014) |
| final | Offline images | Cook webgpu (WGSL compute, software BVH) | Slower per sample than native | 10.04 ms a sample (9.98 to 10.41); 256 samples take 3.04 s (2.98 to 3.09) with setup, 3 of 3 runs usable | same Cycles | Cook webgpu 0.041 (0.041 to 0.041) |

Equal error: Cook native does not reach Cycles' 256-sample error by 1024 samples, and Cycles' own error falls slower than 1/N here (a floor, not a noise level, likely a bias): relMSE 1.64e+0 at 256 samples and 2.84e-1 at 1024, against Cycles' 2.74e-2 at 256 and 2.07e-2 at 1024. No ratio is given.

Cook webgpu (measured at 256 samples only) draws a sample 3.9 times slower than native. Its 256-sample image matches native's at equal samples (relMSE between the two images 2.65e-5, FLIP 0.0002). It runs the same kernel, so no separate equal-error figure is given.

### glass

| Tier | For | Runs on | Trade-off | Crucible measured | Blender equivalent measured | FLIP vs Cycles (lower is better) |
| --- | --- | --- | --- | --- | --- | --- |
| draft (planned name) | A quick look while editing | Glaze, 0.5 render scale, 1 sample, light shading, 8 bit target, coarser level of detail | Aliased edges, no environment lookup, a quarter of the pixels enlarged | 0.61 ms a frame with the pixel read (0.61 to 0.63); 0.26 ms a frame queued back to back (0.26 to 0.46); first frame 73.0 ms (67.1 to 73.0), 3 of 3 runs usable | 57 ms a render call (57 to 58); Blender's own render time 57 ms (57 to 58), 3 of 3 runs usable | Glaze 0.112 (0.112 to 0.112) enlarged, 0.116 (0.116 to 0.116) at its own 480x270; EEVEE 1 sample 0.106 (0.106 to 0.106) |
| realtime | Interactive use | Glaze, default settings | No path-traced global illumination: indirect light is approximate | 0.83 ms a frame with the pixel read (0.79 to 0.85); 0.39 ms a frame queued back to back (0.38 to 0.39); first frame 70.5 ms (69.6 to 71.6), 3 of 3 runs usable | 309 ms a render call (304 to 311); Blender's own render time 309 ms (304 to 310), 3 of 3 runs usable | Glaze 0.093 (0.093 to 0.093); EEVEE 64 samples 0.106 (0.106 to 0.106) |
| realtime-high | Interactive, higher quality | Planned (#902), not measurable yet | none | none | none | none |
| final | Offline images | Cook native (Vulkan ray queries) | Error against samples is in the equal-error note below | 2.54 ms a sample (2.54 to 2.71); 256 samples take 0.96 s (0.93 to 1.00) with setup, 3 of 3 runs usable | Cycles: 11.61 ms a sample (11.47 to 11.81); 256 samples take 4.74 s (4.71 to 4.91) with setup, 3 of 3 runs usable | Cook native 0.034 (0.034 to 0.034); Cycles 0.014 (0.014 to 0.014) |
| final | Offline images | Cook webgpu (WGSL compute, software BVH) | Slower per sample than native | 10.54 ms a sample (10.49 to 10.88); 256 samples take 3.13 s (3.11 to 3.26) with setup, 3 of 3 runs usable | same Cycles | Cook webgpu 0.034 (0.034 to 0.034) |

Equal error: Cook native does not reach Cycles' 256-sample error by 1024 samples (error falls slower than 1/N, likely a bias): relMSE 5.46e-3 at 256 samples and 5.02e-3 at 1024, against Cycles' 5.02e-4 at 256 and 1.22e-4 at 1024. No ratio is given.

Cook webgpu (measured at 256 samples only) draws a sample 4.1 times slower than native. Its 256-sample image matches native's at equal samples (relMSE between the two images 3.15e-8, FLIP 0.0001). It runs the same kernel, so no separate equal-error figure is given.

### outdoor-hdri

| Tier | For | Runs on | Trade-off | Crucible measured | Blender equivalent measured | FLIP vs Cycles (lower is better) |
| --- | --- | --- | --- | --- | --- | --- |
| draft (planned name) | A quick look while editing | Glaze, 0.5 render scale, 1 sample, light shading, 8 bit target, coarser level of detail | Aliased edges, no environment lookup, a quarter of the pixels enlarged | 0.54 ms a frame with the pixel read (0.51 to 0.56); 0.27 ms a frame queued back to back (0.22 to 0.46); first frame 20.9 ms (20.6 to 22.9), 3 of 3 runs usable | 59 ms a render call (59 to 62); Blender's own render time 59 ms (59 to 61), 3 of 3 runs usable | Glaze 0.045 (0.045 to 0.045) enlarged, 0.049 (0.049 to 0.049) at its own 480x270; EEVEE 1 sample 0.041 (0.041 to 0.041) |
| realtime | Interactive use | Glaze, default settings | No path-traced global illumination: indirect light is approximate | 0.79 ms a frame with the pixel read (0.75 to 0.90); 0.35 ms a frame queued back to back (0.33 to 0.38); first frame 23.3 ms (23.1 to 23.5), 3 of 3 runs usable | 288 ms a render call (288 to 289); Blender's own render time 288 ms (287 to 288), 3 of 3 runs usable | Glaze 0.030 (0.030 to 0.030); EEVEE 64 samples 0.042 (0.042 to 0.042) |
| realtime-high | Interactive, higher quality | Planned (#902), not measurable yet | none | none | none | none |
| final | Offline images | Cook native (Vulkan ray queries) | Error against samples is in the equal-error note below | 1.73 ms a sample (1.68 to 1.75); 256 samples take 0.72 s (0.70 to 0.73) with setup, 3 of 3 runs usable | Cycles: 6.81 ms a sample (6.79 to 6.97); 256 samples take 3.43 s (3.39 to 3.45) with setup, 3 of 3 runs usable | Cook native 0.019 (0.019 to 0.019); Cycles 0.010 (0.010 to 0.010) |
| final | Offline images | Cook webgpu (WGSL compute, software BVH) | Slower per sample than native | 5.88 ms a sample (5.87 to 6.08); 256 samples take 1.94 s (1.93 to 1.98) with setup, 3 of 3 runs usable | same Cycles | Cook webgpu 0.019 (0.019 to 0.019) |

Equal error: Cook native does not reach Cycles' 256-sample error by 1024 samples (error falls slower than 1/N, likely a bias): relMSE 2.87e-4 at 256 samples and 1.29e-4 at 1024, against Cycles' 1.69e-4 at 256 and 2.60e-5 at 1024. No ratio is given.

Cook webgpu (measured at 256 samples only) draws a sample 3.4 times slower than native. Its 256-sample image matches native's at equal samples (relMSE between the two images 1.68e-9, FLIP 0.0000). It runs the same kernel, so no separate equal-error figure is given.

Conditions. NVIDIA GeForce RTX 3060, 621.14, 12288 MiB; Blender 5.3.0; Node v24.19.0; Chrome headless on D3D11 (ANGLE); 960 by 540; measured 2026-11-11 on scenes lit-interior, spot-area, light-linking, metal, glass, outdoor-hdri. Idle gate: wait for at most 15% utilisation on 5 polls in a row (max wait 900 s); a run whose utilisation in the 3 s before it was over 30% is contended and left out of medians. 0 of 162 runs were contended. Medians with ranges over up to 3 repetitions, engines interleaved in a rotating order. Reference: Cycles at 4096 samples. Time columns: Glaze is a frame with a pixel read (and queued back to back); EEVEE is the whole render call including scene sync, Blender's own render time beside it; Cook and Cycles are sampling time.

