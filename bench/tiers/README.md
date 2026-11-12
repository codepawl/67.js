# Tier benchmark (issue #904)

Each row says what ran. The tier names are working names from the render roadmap (#890): `draft`, `realtime`, `realtime-high`, `final`. The `quality` setting that picks a tier is planned (#904), so none of these names is an API today. `realtime-high` is planned (#901, #902) and cannot be measured.

Depends on #921 (`bench/cycles-parity`, [`docs/cycles-parity.md`](../../docs/cycles-parity.md)): the Cycles script, the native trace script, `compare.py` and `measure-gpu-run.py` are reused. The Cook against Cycles numbers on one scene are in that document; this suite repeats them with the other Cook backends beside them.

## Result (six scenes, 960 by 540, idle card, 2026-11-11)

The full matrix: [`results/matrix-960.json`](results/matrix-960.json) (162 runs, three repetitions of every cell, Cook native and Cycles at 256 and 1,024 samples, Cook webgpu at 256), with the generated [`matrix-960.table.md`](results/matrix-960.table.md) and [`matrix-960.table.html`](results/matrix-960.table.html): the summary across scenes first, then one table per scene.

Conditions: RTX 3060 12 GB (driver 621.14), Blender 5.3.0, Node 24.19.0, Chrome headless on D3D11 (ANGLE), 960 by 540, reference Cycles at 4,096 samples. The idle gate waited for at most 15 percent utilisation on 5 polls in a row (at most 900 s) before every run; 0 of 162 runs were contended. The results file keeps the paths of the session's work directory as `<work directory>/`; the images and `.npy` files stay out of the repository.

```sh
node bench/tiers/run-all.mjs <work directory> --samples 256,1024 --max-wait 900
node bench/tiers/make-table.mjs <work directory>/matrix-960.json
```

`run-all.mjs` ends by running `score-tiers.py matrix`, which also compares each Cook webgpu image with the Cook native one of the same scene and repetition (`score.versusNative`). To rebuild the committed tables: `node bench/tiers/make-table.mjs bench/tiers/results/matrix-960.json`.

How the equal-error statements are made: an error that is limited by noise falls as 1/N, so the relMSE at 1,024 samples is about a quarter of the one at 256. When a scene's 1,024-sample error is above 0.4 times its 256-sample error, `make-table.mjs` calls it bias-limited and prints the measured values without a ratio; it does the same when the Cycles 256-sample error that serves as the target is itself bias-limited. A ratio is extrapolated only from 1,024 samples and only on the other scenes. Cook webgpu was measured at 256 samples only, so it gets its per-sample speed against native and the difference between its image and native's at equal samples, never an equal-error figure.

Firefly clamp (#936): the committed matrix ran Cook native with `fireflyClamp` 1e9 and Cook webgpu with 1000 (the cap of the JS API), so the linear relMSE of the two is not comparable on scenes with fireflies. On `metal` at 256 samples native at 1e9 measured 2.02 and at 1000 measured 0.02107, webgpu at 1000 measured 0.02106: the same kernel code and the same pixels, 10 pixels carry 97 percent of the 1e9 error. Cycles (clamps off) has the same shape: 10 pixels carry 98 percent of its 0.0298. `run-all.mjs` now passes one `--firefly-clamp` (default 1000) to every Cook backend and records it in each cell. Read linear relMSE on firefly scenes with that clamp in mind; display relMSE and FLIP are not affected. Rerun the matrix to refresh the committed figures.

The table below this section, and the equal-error section after it, are the earlier single-scene result, measured on a shared card. Where they disagree with the matrix, the matrix is right; their equal-error figures extrapolated as 1/N without the check above.

## Result (lit-interior, shared card, 2026-11-11)

One scene, as the first step. The other five scenes of `bench/reference/scenes.js` export and render, but were not run (see "Not done"). The card was shared the whole time (see "Conditions").

| Tier | For | What runs it today | 67js time | Blender equivalent and its time | Quality (FLIP vs Cycles 4096 spp, lower is better) | VRAM (card wide, shared) |
| --- | --- | --- | --- | --- | --- | --- |
| draft (planned name) | A quick look while editing | Glaze, 0.5 render scale, 1 sample, light shading (measured before the 8 bit target and level of detail change below) | 1.20 ms a frame (0.88 to 2.43), first frame 11.9 ms | EEVEE 5.3, 1 sample: 99 ms a render call (76 to 157) | Glaze 0.188, EEVEE 0.562 | Glaze +62 MiB (render targets 39 MB), EEVEE +2,218 MiB |
| realtime | Interactive use | Glaze, default settings | 1.11 ms a frame (1.05 to 1.24), first frame 9.7 ms | EEVEE 5.3 defaults, 64 samples: 1,127 ms a render call (716 to 1,891) | Glaze 0.197, EEVEE 0.562 | Glaze +119 MiB (render targets 65.7 MB), EEVEE +2,503 MiB |
| realtime-high | Interactive, higher quality | Planned (#902), not measurable yet | none | none | none | none |
| (not realtime-high) experimental real-time path tracer, WebGPU | Research | `src/path-tracer-realtime*.js`, not reachable from MCP | 5.6 ms a frame; FLIP under 0.20 after 16 frames (0.15 s), under 0.10 after 64 frames (0.41 s) | none | 0.056 after 256 frames | +243 MiB |
| (not realtime-high) same tracer, WebGL2 fallback | Research | same | 6.7 ms a frame, first frame 6.1 s (shader compile); under 0.10 after 64 frames (6.6 s with the compile) | none | 0.056 after 256 frames | +67 MiB |
| final | Offline images | Cook native (`packages/render-native`, Vulkan ray queries) | 6.05 ms a sample (4.7 to 6.4), total 1.9 s at 256 samples | Cycles 5.3 OptiX: 36.2 ms a sample (28.7 to 220); 12.6 s at 256 samples (8.9 to 58.6) | at 256 samples 0.080 (Cycles 0.039); at equal error about equal (below) | +622 MiB (Cycles +733 MiB) |
| final | Offline images | Cook webgpu (WGSL compute, software BVH) | 34.4 ms a sample (22.6 to 60.6) | same Cycles | same error at the same samples as native | +456 MiB |
| final | Offline images | Cook gpu (WebGL2) | 74.4 ms a sample (57.3 to 79.2) plus 4.8 to 7.9 s compile | same Cycles | same | +496 MiB |
| final | Offline images | Cook cpu (JS, 8 threads) | 786 ms a sample (561 to 1,022) | same Cycles | same | not a card job |

Footnote. RTX 3060 12 GB (driver 621.14), Intel i7-14700KF, Windows 11, Chrome 157.0.8103.50 headless on D3D11 (ANGLE), Node 24.19.0, Blender 5.3.0, three.js not run. 960 by 540, measured 2026-11-11. The card was shared with other sessions' jobs in every run (utilisation 17 to 100 percent before and during runs), so ranges are wide; medians of three runs, interleaved. The Cook numbers will change when the new kernel lands: [`docs/cycles-parity.md`](../../docs/cycles-parity.md) holds the Cook against Cycles comparison and its conditions.

### Cook against Cycles at equal error and at equal time

Conditions: lit-interior only, 960 by 540, 8 bounces, no denoiser on either side, Box filter of width 1.0, Cycles clamps off (Cook `fireflyClamp` is capped at 1,000 in the JS API and 1e9 for native), seed 1, RTX 3060 shared. Target: the Cycles 256 sample relMSE, 0.0031 against the 4096 sample Cycles reference. All Cook engines have the same relMSE at the same sample count (0.0198 at 256 samples), so they need about the same samples, 1,750 (1,746 on webgpu, 1,762 native, found from the measured relMSE by log interpolation). Times are samples at equal error times the per-sample time measured at 256 samples, plus setup; they are derived, and the shared card makes the range wide.

| Engine | Samples for equal error | Time at equal error | Against Cycles 256 samples (12.6 s total, 9.3 s sampling only) | relMSE at Cycles' time (12.6 s) |
| --- | --- | --- | --- | --- |
| native | 1,762 | about 11.0 s total (8.5 to 11.7) | 0.87 total; sampling only 10.7 s, which is 1.15, so Cycles wins that cell | about 0.0027 (measured at 2,048 samples: 0.00268) against 0.0031 |
| webgpu | 1,746 (measured with 8 seeds averaged: 0.00267 at 59 s) | about 60 s (40 to 106) | 4.8 times slower | about 0.0144 (extrapolated as 1 over N from 256 samples), 4.6 times Cycles |
| gpu (WebGL2) | not reached in the measured stack of 1,024 samples (0.0051, 64 s); 1,746 inferred from webgpu | about 137 s | 11 times slower | about 0.048, 15 times Cycles |
| cpu | not reached (256 samples measured, 201 s) | about 1,370 s, inferred | 109 times slower | about 0.31, 100 times Cycles |

Native against Cycles repeats #921 (0.91 to 0.95 there): the sign of the difference moves with the load on the card, so read it as about equal. Native draws a sample 6.0 times faster and needs 6.9 times the samples, so the two nearly cancel.

## Reproducible runs (idle gate, interleaving, table)

The table above was measured on a card that other sessions kept at 17 to 100 percent, and a re-run on a card at 99 to 100 percent measured Glaze realtime at 11 ms a frame against 1.1 ms, and EEVEE default at 6.7 to 7.3 s against 1.1 s. Numbers from a busy card are not comparable, so the benchmark now measures the load and refuses to mix it in.

One command runs everything (about an hour on an idle card for all six scenes at three repetitions, plus the six Cycles references). To share a card with other jobs, put your job queue in front of it as one heavy job, because the driver itself runs the engines one after the other:

```sh
node bench/tiers/run-all.mjs <work directory>
```

- Idle gate ([`idle-gate.mjs`](idle-gate.mjs)): before each run it polls `nvidia-smi` once a second until utilisation is at or under 15 percent on 5 polls in a row, giving up after `--max-wait` seconds (default 600) with a message that names the load. It then samples the card for 3 s (the background figure, because the job drives utilisation itself once it starts), runs the command with a sampler beside it, and writes `{ background: { utilMean, utilMedian, utilMax, foreignProcesses }, run: { utilMedian, utilMax }, contended }` into the cell. A run whose background utilisation (mean of the 3 s) was over 30 percent is `contended`: it stays in the results file and is left out of every median. `--report-only` records the load without waiting, to check the plumbing on a busy card. The shell runners use the same helper through `node bench/tiers/idle-gate.mjs --out <file> -- <command>`.
- Interleaving ([`run-all.mjs`](run-all.mjs)): per repetition and scene the engines run back to back in one order that rotates by one place each repetition (Glaze draft, Glaze realtime, EEVEE lowest, EEVEE default, Cook native, Cycles, Cook webgpu), all at 960 by 540, scenes from lit-interior on. `--with-cook-gpu` and `--with-cook-cpu` add the slow backends. Cook native and Cycles run at each count of `--samples` (default 256,1024) so the equal-error figure is interpolated, not extrapolated. The results file `<work directory>/matrix-960.json` is rewritten after every cell and a finished cell is skipped on the next start (`--rerun-contended` repeats the contended ones).
- Scores: `run-all.mjs` ends by running `score-tiers.py matrix`, which adds FLIP, display relMSE and relMSE to each cell. A Glaze draft cell has two FLIP figures: against the full reference after a bilinear enlargement, and against the reference reduced to the draft's own canvas.
- Table: `node bench/tiers/make-table.mjs <work directory>/matrix-960.json` writes a Markdown and an HTML table per scene (medians with ranges, the conditions footnote, and the equal-error statement for Cook native and webgpu, computed from the results).
- EEVEE has two times. The table uses the whole `bpy.ops.render.render` call, because that is what produces a picture and what the Glaze frame (draw plus pixel read) is compared with. Blender's own render time, from the render_pre to render_post handlers, is recorded beside it and printed in the same cell.

### What draft changes against realtime

Draft was 0.5 render scale, 1 sample and light shading, and it measured the same frame time as realtime because a 1 ms frame on this scene is mostly the pixel read that ends it. It now also uses an 8 bit target (`hdr: false`) and `lodPixelError: 4`, and page.js records a second figure, the time of 30 frames queued back to back with one read at the end. Lit-interior, 3 repetitions, Glaze only, 960 by 540 (measured 2026-11-11 with the card 60 to 75 percent busy from other jobs, so read the ratios, not the milliseconds; the reference here was Cycles at 256 samples, not 4096):

| Variant | Queued frame | Frame with read | FLIP, enlarged to 960 by 540 | FLIP at its own size |
| --- | --- | --- | --- | --- |
| realtime | 0.55 ms | 1.34 ms | 0.201 | none |
| draft (new) | 0.32 ms | 1.12 ms | 0.191 | 0.193 |
| draft as of #931 (hdr, default level of detail) | 0.45 ms | 1.42 ms | 0.191 | 0.193 |
| realtime at 0.5 render scale | 0.56 ms | 1.39 ms | 0.201 | 0.204 |
| draft with full shading | 0.44 ms | 1.34 ms | 0.201 | 0.204 |

So draft is 1.7 times cheaper in queued frame time, and the 8 bit target and the level of detail account for the step from 0.45 to 0.32 ms. Draft scores better than realtime because of the light shading, not the smaller canvas: with full shading the score is realtime's 0.201 at either size, and with light shading it is 0.191 at either size. On this scene the full shading's prefiltered environment lookup and wide shadow filter sit further from Cycles than the light model does; that is one scene and one reference, and the shading terms were not taken apart further. Run `node bench/tiers/run-all.mjs <work directory> --engines glaze-draft,glaze-realtime,glaze-realtime-half,glaze-draft-full,glaze-draft-hdr,glaze-draft-before` to repeat it.

## Method

- `render-references.sh`: Cycles 4096 spp references through `bench/cycles-parity/render-cycles.py`. `run-final-tier.sh`: Cook cpu, gpu and webgpu (`run-cook.mjs`), native (`trace-native.mjs`) and Cycles, interleaved, three repetitions at 256 samples, once at 64 and 1,024, native also at 2,048 and 4,096. One Cook trace is limited to about 256 samples at this size ("too much ray work"), so larger counts are seeds 1 to n averaged (`run-cook-seeds.sh`, `score-tiers.py` stacks). The gpu stack stopped at 1,024 samples, because the seeds above 7 did not finish.
- `run-glaze.mjs` and `page.js`: Glaze tiers from [`tiers.mjs`](tiers.mjs), one comment per setting. First frame is the first render after the renderer is built, until a pixel read returns; this page runs in a browser that has the shader cache from earlier pages, so the first frame is not a cold start. A frame time is the median of 10 further renders, each ending in a pixel read. The draft canvas is 480 by 270 and is enlarged with a bilinear filter to 960 by 540 before scoring. The shadow map stays 2048 by 2048, because there is no setting for a smaller one.
- `render-eevee.py`: the scene is built by the Cycles script, so both see the same objects. A frame is one `bpy.ops.render.render` call, including scene sync, so it is the time to produce a picture in a background render, not EEVEE's viewport rate. The first frame is the first call. `default` keeps 64 samples with ray tracing off; `lowest` is 1 sample, 1 shadow ray, 1 shadow step. The recorded settings are in the JSON.
- `run-settle.mjs`: the experimental tracer at rest, bounces 2, resolution divisor 2; frames 1, 2, 4 to 256 are read back, and FLIP is scored against the reference (the tracer uses 2 bounces, the reference 8, so a floor of bias remains).
- `score-tiers.py`: relMSE from `compare.py`, FLIP (LDR) with the ACES fit and 2.2 gamma of `bench/reference/score.py`, on 8-bit rounded images. Glaze PNGs are display space, so EEVEE and Glaze are compared in display space.
- Results: [`results/`](results). Raw logs and images were written to the session's scratch folder, not committed.

## Conditions and caveats

- The GPU was shared with other sessions' jobs the whole time. The 56 s and 58 s Cycles runs and the 1,891 ms EEVEE frame are contended runs, kept in the ranges.
- Peak card memory is the card's `memory.used` before against its peak, polled at 100 ms (`nvidia-smi`) or 50 ms (`measure-gpu-run.py`). It includes other jobs, so it is an upper bound. `memoryReport()` of the renderer, the exact size of Glaze's render targets, is in `results/glaze-lit-interior-960.json`.
- The FLIP of Glaze here (0.197) is far below the 0.506 in `bench/reference/README.md`, which scores Glaze against a Blender 5.2.2 Cycles render with other settings. These Cycles settings and Blender 5.3 differ from that suite, so the numbers do not line up; they were not reconciled.
- EEVEE has no global illumination with ray tracing off, so on an interior it loses on quality by a wide margin (it is darker, see FLIP). EEVEE with ray tracing on was not measured.
- Glaze at 960 by 540 on this scene takes about a millisecond, which is close to the cost of the browser's pixel read, so the draft against realtime frame time could not be told apart in the table above (1.20 against 1.11 ms; ranges overlap). The queued-frame figure and the cheaper draft settings below address that; the table rows above were not re-measured.

## Not done

- The other five scenes (`spot-area`, `light-linking`, `metal`, `glass`, `outdoor-hdri`) have no committed runs; `run-all.mjs` exports, references and measures them (the full matrix has not been run yet).
- Lit-interior at 1920 by 1080 for the real-time rows, and the settle runs at that size.
- three.js 0.187 against Glaze on `bench/runtime`'s scenes: not run here; `bench/runtime/README.md` has its own results.
