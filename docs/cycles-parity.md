# Cycles 5.3 Parity Baseline & M1 Suite

Milestone M0 measures today's native path tracer ([`packages/render-native`](../packages/render-native/README.md), legacy `kernel.wgsl` on `wgpu 30.0.1` Vulkan `EXPERIMENTAL_RAY_QUERY`) against **Blender 5.3.0 Cycles OptiX** under matched unbiased settings on a single reference scene before any Cycles-kernel port changes land.

All claims below are tagged `[measured]` (from benchmark artifacts produced by [`bench/cycles-parity/`](../bench/cycles-parity/run-m0-suite.py)), `[source]` (verified in 67js or Blender 5.3 source), or `[inferred]`.

## Summary Verdict

- **Per-sample speed vs equal-error speed (`T_eq`) `[measured]`**: On `lit-interior` (`960 × 540`, `8` bounces, unclamped, undenoised), 67js `render-native` traces `256` samples in **`2.101 s`** median sampling time (`2.381 s` total trace) vs **`11.371 s`** (`13.456 s` total trace) in Cycles 5.3 OptiX — **`5.41×` faster per sample (`0.185×` time)**. However, at `256` samples 67js has **`6.33×` higher `relMSE`** (`0.019762` vs `0.003121`) and still has not reached Cycles' 256-spp error at `1024` samples (`0.005135`). Extending the 67js ladder to `2048` (`0.002679`) and `4096` (`0.001453`) samples brackets Cycles' 256-spp `relMSE` at **`1,740.5` samples (`6.80×` as many samples)**, giving **`T_eq = 10.331 s` sampling (`T_eq / T_cycles = 0.909×`)** and **`12.886 s` total trace (`0.958×`)**. Nearly the entire `5.4×` raw ray-tracing speed lead on this 3,072-triangle room is consumed by higher Monte Carlo variance (no light tree on bounces, white-noise PCG instead of Sobol + blue noise).
- **Setup latency (`T_sync`), RAM, and VRAM `[measured]`**: Warm per-call setup is **`0.244 s`** median in 67js (`0.026 s` JS pack + `0.164 s` Vulkan adapter/device + `0.005 s` WGSL compile + `0.009 s` upload + `0.002 s` BLAS/TLAS) vs **`2.012 s`** in headless Blender/Cycles (`~1.80 s` Python/mesh build + `~0.21 s` Cycles OptiX sync), with the `wgpu` device, bind group layout, lookup table buffer and compiled pipelines cached for the life of the Node process (a pipeline cache of at most 32 kernels, dropped when the device is lost); the device and adapter figure above was measured before that cache, and only the scene buffers and the acceleration structures are built again on each call. Peak process-tree RSS is **`287.0 MiB`** in 67js vs **`590.2 MiB`** in Blender (`0.49×`). Cycles reports **`Mem: 351.0 MiB`** peak render memory; uncontended 67js runs at `2048–4096` spp measure **`211–433 MiB`** card VRAM delta (`769–998 MiB` total card VRAM above a `558–565 MiB` desktop baseline).
- **Radiometric bias (`[measured]`)**: At `4096` samples against Cycles `4096` spp (`Seed 1`, whose `Seed 1` vs `Seed 2` noise floor is `relMSE = 0.000285`), 67js global per-channel mean ratios are **`R = 1.0104, G = 1.0090, B = 1.0068`** (`+1.04% R, +0.90% G, +0.68% B`, scalar `1.0092`), and **all `64 / 64` tiles** in an `8 × 8` grid lie within `1 ± 0.05` (`min = 0.9849`, `median = 1.0034`, `max = 1.0280`). Fitting `relMSE(N) = B_bias + V / N` across `16..4096` spp isolates a systematic bias plateau **`B_bias = 0.000542`** (`~1.9×` the 4096-spp reference noise floor) driven by sphere point-light falloff near the ceiling (`+2.8%`) and missing multiscatter GGX + light-sphere reflections on the glossy table (`-2.1%`).

---

## Scene, Hardware, and Matched Settings

### Scene: `lit-interior`

Exported losslessly from [`bench/reference/scenes.js`](../bench/reference/scenes.js) via [`bench/cycles-parity/export-scene.mjs`](../bench/cycles-parity/export-scene.mjs), which verifies byte-for-byte identity across all seven packed `NativeTraceInput` buffers (`triangles`, `materials`, `lights`, `atlas`, `environmentColors`, `environmentTables`, `parameters`) before and after JSON serialization `[measured]`:

- **Geometry**: `9` parts (`room-floor`, `room-ceiling`, `room-back`, `room-left`, `room-right`, `table`, `table-leg`, `vase`, `block`), `8` dielectric materials (`roughness` `0.2` to `0.9`, `metallic = 0`), `3,072` triangles (`roundTripVerified = true`).
- **Lighting**: `3` spherical point lights (`radius = 0.05 m`): overhead warm key (`[0, 2.6, -0.5]`, `color = [1.0, 0.9, 0.75]`, `intensity = 8`, `100.53 W` in Cycles), left warm fill (`[-2.5, 1.5, 1.5]`, `[1.0, 0.6, 0.4]`, `intensity = 2`, `25.13 W`), right cool fill (`[2.5, 1.5, 1.5]`, `[0.5, 0.7, 1.0]`, `intensity = 2`, `25.13 W`), plus a constant `0.02` world background (`emitterCount = 4` in 67js).
- **Camera**: `eye = [0, 1.5, 3.9]`, `target = [0, 1.0, -1.0]`, vertical `fov = 50°`, `960 × 540` (`518,400` pixels).

### Hardware & Contention Disclosure

- **Machine `[measured]`**: NVIDIA GeForce RTX 3060 (`12,288 MiB` VRAM), Windows, Node.js `v24.19.0`, Blender `5.3.0` (`CYCLES` `OPTIX`), `packages/render-native` (`wgpu 30.0.1`, Vulkan `EXPERIMENTAL_RAY_QUERY`).
- **GPU scheduling & exclusivity `[measured]`**: Every GPU command ran at `BelowNormal` priority under the machine-wide `gpu-lock` wrapper and [`bench/cycles-parity/measure-gpu-run.py`](../bench/cycles-parity/measure-gpu-run.py) (`50 ms` `nvidia-smi` stream + `25 ms` process-tree RSS polling). During the `4096`-spp references and the `16..1024`-spp ladder, another session's light-slot Blender/Node workload shared the RTX 3060 (`gpuExclusive = false`, pre-run card VRAM `6,812–7,650 MiB`). To prevent drift from skewing engine comparisons, every ladder point ran **3 interleaved back-to-back pairs** (`Cycles` immediately followed by `67js` for `r1`, `r2`, `r3`). During the extended `2048` and `4096` spp 67js runs (`s2048-r1`, `s4096-r1`), the foreign render exited (`baselineCardVramMegabytes = 558–565 MiB`, `preRunGpuUtilizationPercent = 11%–14%`, only idle desktop Chrome attached), providing uncontended card VRAM delta measurements alongside Cycles' internal `Mem:` counter.

### Strictly Matched Parity Configuration

| Parameter | Cycles 5.3 OptiX ([`render-cycles.py`](../bench/cycles-parity/render-cycles.py)) | 67js `render-native` ([`trace-native.mjs`](../bench/cycles-parity/trace-native.mjs)) | Why override default |
| --- | --- | --- | --- |
| Resolution | `960 × 540` (`100%`) | `width: 960, height: 540` | Same pixel grid (`518,400` pixels) |
| Bounces | `max_bounces = 8`, `diffuse = glossy = transmission = volume = transparent_max = 8` | `bounces: 8` | Cycles defaults to `diffuse = 4, glossy = 4, max = 12`; 67js uses one shared limit |
| Caustics | `caustics_reflective = True`, `caustics_refractive = True` | Always traced | Match glossy-to-diffuse indirect transport |
| Radiance clamping | `sample_clamp_direct = 0.0`, `sample_clamp_indirect = 0.0` (`FLT_MAX`) | `fireflyClamp: 1e9` (`clampDirect: 0, clampIndirect: 0` in `cycles`) | Cycles default `indirect = 10` clamps at `30` (`×3`); 67js default clamps peak channel to `20` at `depth > 0` |
| Filter glossy | `filter_glossy = 1.0` (`bsdf_blur` on secondary glossy bounces) | `filterGlossy: 1.0` in `--kernel cycles` (none in `legacy`) | Matches Cycles secondary-bounce roughness blur (`alpha >= filter_glossy * min_ray_pdf`) on reflective/refractive caustics |
| Denoising | `use_denoising = False` | Raw `traced.rgba` (no wavelet/OIDN) | Measure raw Monte Carlo estimator |
| Adaptive sampling | `use_adaptive_sampling = False` | `noiseThreshold: 0` | Draw exact `N` samples at every pixel |
| Pixel filter | `pixel_filter_type = 'BOX'`, `filter_width = 1.0` | Uniform jitter in `[0, 1)^2` | Cycles default Blackman-Harris `1.5 px` blurs/rings across pixel boundaries |
| Color space | `OPEN_EXR` `32`-bit float RGB, `view_transform = 'Raw'`, `look = 'None'` | Linear `Float32Array` RGB `.npy` | Scene-referred linear float32 with no tone map |

### Bounce-Count Semantics Verification

- **Source semantics `[source]`**:
  - In **Cycles** (`intern/cycles/scene/integrator.cpp:227`, `kernel/integrator/path_state.h:146`, `shade_surface.h:840-867`), setting `max_bounces = B` stores `kintegrator->max_bounce = B + 1`. Camera hits start at `path.bounce = 0`. Surface direct-light NEE (`integrate_surface_direct_light`) executes at `path.bounce = 0, 1, ..., B` (`B + 1` surface vertices). After sampling the BSDF at `bounce = B`, `bounce` increments to `B + 1 == max_bounce`, which sets `PATH_RAY_TERMINATE_AFTER_TRANSPARENT`: ray `B + 1` is traced **only** to accumulate emission/background MIS if it hits a light or escapes, and terminates immediately on any opaque surface without shading.
  - In **67js** ([`packages/render-native/src/kernel.wgsl`](../packages/render-native/src/kernel.wgsl) lines `609-618`, `808-832`, `963-1048`), `tracePath` loops `for (var depth = 0; depth <= bounces; depth++)`, evaluating `addLights` (NEE) at `depth = 0, 1, ..., B` (`B + 1` surface vertices) and exiting after `depth = B` **without** tracing continuation ray `B + 1`.
  - **Subtle sky-MIS consequence `[source]` + `[measured]`**: For analytical lights (`point`, `spot`, `area`, `sun`), 67js uses pure NEE (`directWeight = 1 / selectionProbability`), so `bounces = B` matches Cycles `max_bounces = B` vertex-for-vertex (`B + 1` NEE evaluations). For the environment map (`weightMode = 1`), 67js multiplies NEE at `depth = B` by the MIS weight `p_env^2 / (p_env^2 + p_bsdf^2)` (`kernel.wgsl:609-613`) expecting `depth = B + 1` to add the complementary BSDF escape weight `p_bsdf^2 / (p_env^2 + p_bsdf^2)` in `addEscape`, which never runs on the final bounce `depth == B`.
- **Transparent bounce limit of 0 `[source]`**: with `transparent_max = 0` the Cycles kernel lets the path through the first transparent surface before it terminates, while the Cook kernel stops at the first transparent surface (`integrator.wgsl`, the `max_transparent_bounces == 0` test). The parity scenes use a limit of 8, so none reaches this case.
- **Empirical white-furnace sphere check (`color = [0.8, 0.8, 0.8]`, `roughness = 1.0`, `specular = 0.0`, constant `1.0` sky, `128 × 128`, `256` spp) `[measured]`**:
  - `B = 0`: Cycles center patch mean = **`0.79971`** (exact `0.8`, because ray `B + 1` completes background MIS) vs 67js = **`0.13334`** (`ratio = 0.16674 ≈ 1/6`, confirming analytically that $(1/4\pi)^2 / ((1/4\pi)^2 + (\cos\theta/\pi)^2)$ integrated over the cosine hemisphere equals `1/6`, so `0.8 / 6 = 0.13333` when ray `B + 1` is omitted).
  - `B = 1` and `B = 8`: Cycles = **`0.79971`** vs 67js = **`0.79923`** (**`ratio = 0.9994`**, within `0.06%`), because every ray from the convex sphere escapes at `depth = 1` and completes vertex `0`'s MIS pair.
- **Empirical `B = 0` check on `lit-interior` `[measured]`**: Because `lit-interior` is an enclosed room lit by point lights, `B = 0` (`64` spp) matches between Cycles (`max_bounces = 0`) and 67js (`bounces = 0`) to **`relMSE = 0.000106`**, `channelMeanRatio = [1.0082, 1.0079, 1.0064]`, and `64 / 64` tiles within `±5%` (`medianRatio = 0.9965`).

---

## 1. Cycles 4096-Sample Reference & Seed Noise Floor

Rendered at `4096` samples in Cycles 5.3 OptiX with `seed = 1` (Seed A) and `seed = 2` (Seed B), using error metric:

$$\text{relMSE}(x, r) = \text{mean}\!\left(\frac{(x - r)^2}{r^2 + 10^{-2}}\right)$$

| Metric (`Cycles 4096 Seed 1` vs `Seed 2`) | Value `[measured]` |
| --- | --- |
| Differing pixels | **`518,400 / 518,400` (`100.0%`)** |
| Noise floor `relMSE` | **`0.00028509`** (`2.851 × 10⁻⁴`) |
| `relMSE` clipped at `1000` / `99.99%` trimmed | `0.00028509` / `0.00028431` |
| Mean / max absolute channel difference | `0.002363` / `0.039031` |
| Channel means (`Seed 1` vs `Seed 2`) | `[0.251260, 0.178773, 0.126399]` vs `[0.251265, 0.178782, 0.126405]` |
| Per-channel mean ratio (`Seed 2 / Seed 1`) | **`[1.0000, 1.0000, 1.0000]`** (scalar `1.0000`) |
| `8 × 8` tile ratios (`mean > 0.01`, `64 / 64` eligible) | `min = 0.9993`, `median = 1.0001`, `max = 1.0011` (`64 / 64` within `±5%`) |
| Seed 1 timing & memory | `1.659 s` setup (`1.392 s` build + `0.266 s` OptiX sync), `261.269 s` sampling, `604.83 MiB` RSS, `351.0 MiB` Cycles `Mem:` |

---

## 2. Sample Ladder (`16` to `1024` spp, Extended to `4096` spp for 67js)

Every row below reports the **median** and `[min, max]` spread across **3 interleaved back-to-back runs** (`seed = 1`), evaluated against the `Cycles 4096 Seed 1` reference `[measured]`.

### Cycles 5.3 OptiX Sample Ladder

| Samples | `relMSE` vs Ref | Setup `T_sync` (s) | Sampling (s) | Total Trace (s) | Process Wall (s) | Peak RAM (MiB) | Cycles `Mem:` (MiB) | Card VRAM Δ (MiB, shared) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `16` | `0.069997` | `2.089` `[1.501, 3.731]` | `0.488` `[0.475, 0.748]` | `43.233` `[2.860, 53.581]`¹ | `50.495` `[5.497, 95.955]`¹ | `601.55` `[591.6, 615.8]` | `351.0` | `725.0` `[725, 979]` |
| `32` | `0.031804` | `3.404` `[1.769, 3.856]` | `0.938` `[0.932, 0.946]` | `4.580` `[2.842, 4.871]` | `8.580` `[6.774, 8.882]` | `589.51` `[588.7, 592.9]` | `351.0` | `943.0` `[109, 943]` |
| `64` | `0.014797` | `1.617` `[1.596, 2.280]` | `3.261` `[1.823, 3.358]` | `5.081` `[3.479, 5.809]` | `6.878` `[5.878, 7.504]` | `590.89` `[589.9, 591.2]` | `351.0` | `1667.0` `[0, 2096]` |
| `128` | `0.006862` | `1.885` `[1.800, 2.711]` | `5.889` `[5.877, 6.812]` | `9.108` `[7.821, 9.176]` | `10.721` `[9.463, 10.968]` | `590.95` `[589.4, 595.2]` | `351.0` | `2096.0` `[2096, 2138]` |
| **`256`** | **`0.003121`** | **`2.012`** `[1.728, 2.012]` | **`11.371`** `[10.277, 11.885]` | **`13.456`** `[12.406, 14.371]` | **`15.113`** `[14.269, 15.988]` | **`590.20`** `[590.0, 599.1]` | **`351.0`** | `1804.0` `[1667, 2279]` |
| `512` | `0.001519` | `2.082` `[1.771, 2.168]` | `20.489` `[18.871, 20.797]` | `22.621` `[21.154, 22.690]` | `24.644` `[23.166, 24.828]` | `592.22` `[591.7, 593.1]` | `351.0` | `1667.0` `[834, 1668]` |
| `1024` | `0.000770` | `6.173` `[3.616, 9.780]` | `83.307` `[54.446, 141.786]` | `93.176` `[58.331, 148.029]` | `100.003` `[60.800, 172.032]` | `584.98` `[579.6, 590.1]` | `351.0` | `1723.0` `[841, 8403]` |

¹ *On `s16-r2` and `s16-r3`, Blender's post-render EXR ZIP write (`Saving: 00:48.97`) stalled on concurrent disk I/O while `render_stats` cleanly isolated actual OptiX path-tracing `samplingSeconds` (`0.488 s` median).*

### 67js `packages/render-native` (Legacy Kernel) Sample Ladder

| Samples | `relMSE` vs Ref | Mean Ratio `(R, G, B)` | Setup `T_sync` (s) | Sampling (s) | Total Trace (s) | Process Wall (s) | Peak RAM (MiB) | Card VRAM Δ (MiB) | Peak Card VRAM (MiB) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `16` | `0.307783` | `[1.0103, 1.0094, 1.0072]` | `0.234` `[0.209, 0.311]` | `0.104` `[0.090, 0.406]` | `0.370` `[0.366, 0.763]` | `1.389` `[1.116, 2.054]` | `274.32` `[269.0, 290.5]` | `943.0` `[237, 1070]` | `7755.0` (shared) |
| `32` | `0.155303` | `[1.0102, 1.0090, 1.0069]` | `0.253` `[0.230, 0.258]` | `0.173` `[0.164, 0.448]` | `0.466` `[0.434, 0.761]` | `0.972` `[0.678, 7.718]` | `288.32` `[269.2, 311.0]` | `236.0` `[0, 237]` | `7410.0` (shared) |
| `64` | `0.077857` | `[1.0099, 1.0087, 1.0065]` | `0.213` `[0.204, 0.218]` | `0.516` `[0.297, 1.124]` | `0.773` `[0.566, 1.360]` | `0.999` `[0.837, 1.884]` | `271.43` `[269.4, 273.2]` | `1070.0` `[666, 1179]` | `7882.0` (shared) |
| `128` | `0.039273` | `[1.0103, 1.0090, 1.0067]` | `0.189` `[0.188, 0.219]` | `0.565` `[0.564, 0.572]` | `0.784` `[0.783, 0.820]` | `1.208` `[1.040, 1.301]` | `269.40` `[268.9, 302.9]` | `575.0` `[237, 666]` | `7049.0` (shared) |
| **`256`** | **`0.019762`** | **`[1.0104, 1.0091, 1.0069]`** | **`0.244`** `[0.206, 0.270]` | **`2.101`** `[1.160, 2.313]` | **`2.381`** `[1.465, 2.568]` | **`2.913`** `[2.120, 3.443]` | **`286.96`** `[268.4, 311.7]` | `1608.0` `[1541, 1650]` | `7992.0` (shared) |
| `512` | `0.010005` | `[1.0106, 1.0092, 1.0069]` | `0.306` `[0.232, 0.400]` | `3.428` `[2.895, 3.648]` | `4.209` `[3.275, 4.317]` | `4.637` `[3.555, 9.658]` | `371.43` `[302.5, 372.0]` | `346.0` `[261, 1179]` | `7995.0` (shared) |
| `1024` | `0.005135` | `[1.0105, 1.0091, 1.0068]` | `0.810` `[0.541, 1.016]` | `12.330` `[8.675, 12.739]` | `15.371` `[9.999, 16.628]` | `17.084` `[12.550, 19.309]` | `298.25` `[294.1, 329.8]` | **`352.0`** `[346, 377]` | **`909.0`** (uncontended r2–r3) |
| `2048` | `0.002679` | `[1.0105, 1.0091, 1.0068]` | `1.044` `[0.318, 1.051]` | `9.786` `[8.642, 16.037]` | `12.208` `[9.966, 17.575]` | `13.591` `[10.256, 20.280]` | `389.77` `[270.1, 425.7]` | **`432.0`** `[211, 5808]` | **`997.0`** (`769.0` on r1) |
| `4096` | `0.001453` | `[1.0104, 1.0090, 1.0068]` | `0.377` `[0.349, 0.415]` | `19.035` `[18.284, 24.398]` | `19.608` `[18.700, 24.878]` | `19.962` `[19.006, 25.724]` | `394.41` `[281.9, 409.8]` | **`433.0`** `[366, 7765]` | **`998.0`** (uncontended r1–r2) |

### Setup (`T_sync`) Sub-Phase Breakdown (`256` spp Representative Run `r1`)

- **67js `render-native` (`0.2056 s` total warm setup `[measured]`)**:
  - JS scene flatten & pack (`buildTraceScene` + `buildNativeInput`): `0.0261 s`
  - `wgpu` Vulkan instance/adapter/device init (`deviceSetupSeconds`): `0.1637 s` (`79.6%` of warm setup; a cold driver-cache init on first boot measured `7.83 s`)
  - WGSL `kernel.wgsl` compile & pipeline creation (`compileSeconds`): `0.0048 s`
  - Storage buffer upload (`uploadSeconds`): `0.0087 s`
  - Vulkan BLAS + TLAS build (`accelerationBuildSeconds`, `3,072` triangles): `0.0023 s`
- **Cycles 5.3 OptiX (`2.0116 s` total setup `[measured]`)**:
  - Headless Blender factory reset + Python mesh/material/light creation (`sceneBuildSeconds`): `1.7977 s`
  - Cycles scene sync + OptiX BVH build before sample 1 (`cyclesSyncSeconds`): `0.2139 s`

---

## 3. Radiometric Bias, `8 × 8` Tile Grid, and Visible Differences

Evaluated between **`67js 4096 spp` (`lit-interior-native-s4096-r1`)** and **`Cycles 4096 spp Seed 1`** (`relMSE = 0.001453`, `relMSETrimmed = 0.001441`, `meanAbsDiff = 0.006631`, `maxAbsDiff = 0.728733`) `[measured]`:

- **Per-channel mean radiance**:
  - Cycles `4096` spp: `R = 0.251260, G = 0.178773, B = 0.126399`
  - 67js `4096` spp: `R = 0.253883, G = 0.180387, B = 0.127258`
  - **Per-channel mean ratio (`67js / Cycles`)**: **`R = 1.0104 (+1.04%), G = 1.0090 (+0.90%), B = 1.0068 (+0.68%)`**, scalar ratio **`1.0092`** (already passes M1's `1 ± 0.02` global channel gate on this scene).
- **`8 × 8` tile mean ratio summary (`120 × 67.5 px` tiles, threshold `mean > 0.01`)**:
  - Eligible tiles: **`64 / 64`**
  - Tiles within `1 ± 0.05`: **`64 / 64` (`0` tiles outside `±5%`)**
  - Distribution: **`min = 0.9849`** (tile `(7, 4)`, foreground floor/table shadow), **`median = 1.0034`**, **`max = 1.0280`** (tile `(0, 4)`, ceiling directly above the overhead key light)

```text
Row 0 (ceiling): [1.0165, 1.0214, 1.0184, 1.0276, 1.0280, 1.0192, 1.0200, 1.0145]
Row 1 (upper):   [1.0047, 1.0088, 1.0084, 1.0072, 1.0071, 1.0071, 1.0071, 1.0029]
Row 2:           [1.0062, 1.0054, 1.0037, 1.0025, 1.0034, 1.0021, 1.0039, 1.0033]
Row 3:           [1.0051, 1.0054, 1.0036, 1.0041, 1.0084, 1.0035, 1.0028, 1.0040]
Row 4 (mid):     [1.0052, 1.0077, 1.0030, 0.9961, 0.9985, 1.0004, 1.0047, 1.0039]
Row 5 (table):   [1.0018, 0.9978, 0.9940, 0.9878, 0.9863, 0.9917, 0.9980, 0.9988]
Row 6:           [0.9968, 1.0004, 1.0015, 0.9986, 0.9999, 1.0000, 0.9994, 0.9960]
Row 7 (floor):   [1.0033, 1.0033, 0.9975, 0.9856, 0.9849, 0.9965, 1.0034, 1.0031]
```

### Per-Part Breakdown (`67js 4096 spp` vs `Cycles 4096 spp Seed 1`)

| Part | Pixels | Material (`roughness`) | `relMSE` `[measured]` | Scalar Ratio | Channel Ratio `[R, G, B]` |
| --- | --- | --- | --- | --- | --- |
| `block` | `3,367` | Yellow dielectric (`0.5`) | `0.001745` | `1.0217` | `[1.0236, 1.0215, 1.0134]` |
| `table` | `9,146` | Brown dielectric (`0.4`) | `0.001672` | **`0.9794`** | **`[0.9808, 0.9785, 0.9764]`** |
| `room-back` | `115,710` | Plaster wall (`0.9`) | `0.001607` | `1.0031` | `[1.0049, 1.0026, 1.0005]` |
| `vase` | `3,933` | Teal glossy sphere (`0.2`) | `0.001568` | `1.0074` | `[0.9998, 1.0104, 1.0091]` |
| `room-floor` | `193,854` | Wood floor (`0.6`) | `0.001564` | `0.9972` | `[1.0011, 0.9959, 0.9890]` |
| `room-ceiling` | `81,806` | Plaster ceiling (`0.9`) | `0.001352` | **`1.0253`** | **`[1.0262, 1.0253, 1.0236]`** |
| `room-right` | `54,104` | Blue wall (`0.9`) | `0.001211` | `1.0035` | `[1.0000, 1.0043, 1.0051]` |
| `room-left` | `54,104` | Red wall (`0.9`) | `0.001099` | `1.0058` | `[1.0093, 1.0011, 0.9978]` |
| `table-leg` | `2,376` | Dark support (`0.5`) | `0.000432` | `1.0207` | `[1.0253, 1.0194, 1.0133]` |

### Visible Differences and Causes from the Gap Table

1. **Ceiling hotspot `+2.80%` (`room-ceiling` `1.0253`, tiles `(0, 3)..(0, 4)` at `1.0276–1.0280`) `[measured]` → Sphere point-light sampling mismatch `[source]`**:
   - In [`packages/render-native/src/kernel.wgsl`](../packages/render-native/src/kernel.wgsl) (`randomOnSphere` + `pointLightFalloff`, lines `724-739`, `776-789`), 67js jitters a point uniformly over the entire `r = 0.05 m` sphere (including the back hemisphere) and evaluates `1 / max(d^2, r^2)` without solid-angle subtended-cone sampling. Cycles (`kernel/light/point.h`) samples the visible spherical cap uniformly in solid angle. At `0.40 m` vertical separation from the overhead key light (`y = 2.6` to `y = 3.0`), full-sphere jitter shifts the mean inverse-square kernel upward by `~2–3%`.
2. **Darker glossy tabletop `-2.06%` (`table` `0.9794`, tiles `(5, 3)..(5, 4)` at `0.9863–0.9878`, and `maxAbsDiff = 0.729` on specular highlights) `[measured]` → Two Principled/light gaps `[source]`**:
   - **Principled v2 multiscatter GGX & dielectric Fresnel albedo** (`kernel.wgsl:441-582` vs Cycles `bsdf_microfacet.h` / `svm/closure.h`): 67js `principled-lite` uses single-scatter GGX with a polynomial directional-albedo approximation to weight the diffuse lobe under specular, losing energy at medium roughness (`roughness = 0.4` on `table`, `0.6` on `room-floor`).
   - **Light visibility & MIS on finite-radius lights** ([`docs/path-tracer.md`](path-tracer.md) line `37`): 67js point lights (`radius = 0.05 m`) are sampled by NEE only and cannot be intersected by camera or glossy BSDF rays (no MIS), whereas Cycles intersects and MIS-weights the `5 cm` sphere lights in glossy reflections on `table` (`roughness = 0.4`) and `vase` (`roughness = 0.2`).
3. **`4.4×–6.3×` higher grain across walls and shadows at equal sample count `[measured]` → Missing native Light Tree + white-noise PCG sampler `[source]`**:
   - On bounces `depth >= 1` (`kernel.wgsl:808-821`), 67js picks **one emitter uniformly at random** out of `emitterCount = 4` (`selectionProbability = 0.25`), spending `25%` of bounce shadow rays on the nearly black `0.02` constant world (which cannot even illuminate interior points!) and giving equal `25%` probability to the `intensity = 2` side lights and the `intensity = 8` overhead key light. Cycles (`use_light_tree = True`) weights emitters by energy and geometric bound.
   - 67js draws independent stateless PCG white noise (`kernel.wgsl:54-75`), converging strictly as `1 / N`, whereas Cycles uses **Tabulated Sobol** with blue-noise scrambling (`sample/sobol_burley.h`), whose quasi-Monte Carlo stratification widens the `relMSE` gap from `4.40×` at `16` spp to `6.33×` at `256` spp and `6.67×` at `1024` spp.
4. **Warm channel tilt (`+1.04% R` vs `+0.68% B`) `[measured]` → Multi-bounce albedo compounding `[inferred]`**:
   - Because the `intensity = 8` key light (`[1.0, 0.9, 0.75]`), wood floor (`[0.45, 0.32, 0.22]`), and red wall (`[0.55, 0.25, 0.20]`) are red-dominant, the `+2.5%` ceiling excess re-radiates more strongly in `R` than `B` across `8` diffuse/glossy bounces.

---

## 4. Equal-Error Time `T_eq` and Convergence Decomposition

### Equal-Sample (`256` spp) vs Equal-Error (`relMSE = 0.003121`) Comparison

| Comparison Metric | Cycles 5.3 OptiX (`256` spp) | 67js `render-native` (`256` spp) | 67js Equal-Error (`~1,740.5` spp) | Ratio (`67js / Cycles`) |
| --- | --- | --- | --- | --- |
| Samples per pixel | `256` | `256` (`1.00×`) | **`1,740.51`** (bracket `[1024, 2048]`) | **`6.80×` samples** for equal `relMSE` |
| `relMSE` vs Cycles `4096` Seed 1 | **`0.003121`** | `0.019762` (`6.33×` higher error) | **`0.003121`** (matched) | `6.33×` at `256` spp / `1.00×` at `T_eq` |
| Warm setup `T_sync` (s) | `2.0116` | `0.2444` | `~0.9` (interpolated bracket) | **`0.122×`** at `256` spp (`8.2×` faster) |
| Sampling time (s) | `11.3708` | `2.1010` (`0.185×` / `5.41×` faster) | **`10.3311`** (`T_eq` sampling) | **`0.909×`** (`1.10×` faster at `T_eq`) |
| Total trace time (s) | `13.4559` | `2.3806` (`0.177×` / `5.65×` faster) | **`12.8859`** (`T_eq` total trace) | **`0.958×`** (`1.04×` faster at `T_eq`) |
| Process wall time (s) | `15.1132` | `2.9132` (`0.193×` / `5.19×` faster) | **`14.3404`** (`T_eq` wall) | **`0.949×`** (`1.05×` faster at `T_eq`) |

### Asymptotic Bias vs Variance Fit

Least-squares fit of $\text{relMSE}(N) = B_{\text{bias}} + \frac{V}{N}$ across the measured ladders (`[measured]`):

- **67js `render-native` (`16..4096` spp)**:
  - $B_{\text{bias}} = \mathbf{0.000542}$ (`5.42 × 10⁻⁴`), $V_{\text{native}} = \mathbf{4.9246}$, $R^2 = \mathbf{0.999982}$ (residual RMSE `0.000406`).
  - Subtracting the reference's own finite-sample noise floor (`0.000285` at `4096` spp) leaves a true expected-image bias of $\Delta B \approx 0.000542 - 0.000285 = \mathbf{0.000257}$ (`2.57 × 10⁻⁴`).
  - Because $B_{\text{bias}} = 0.000542 < 0.003121$, 67js's bias floor does **not** prevent reaching Cycles' `256`-spp `relMSE` on `lit-interior` (`1,740.5` spp reaches `0.003121` cleanly). However, $B_{\text{bias}} = 0.000542$ **does** sit near Cycles' `1024`-spp `relMSE` (`0.000770`), proving quantitatively that past `~1,000` Cycles samples 67js hits an irreducible radiometric bias ceiling until M1 closes the sphere-light and Principled-BSDF gaps.
- **Cycles 5.3 OptiX (`16..1024` spp)**:
  - $V_{\text{cycles}} = \mathbf{1.1247}$ ($R^2 = 0.9977$, slight super-`1/N` curvature from Tabulated Sobol + blue noise causing a small negative linear intercept `-0.001518` when fit against `1/N`).

---

## 5. Milestone M1 6-Scene Reference Noise Floor, Parity Gates, and Lobe Furnace Harness

Milestone M1 expands parity verification for **Cook** (`packages/render-native` `--kernel cycles`) from `lit-interior` to six reference scenes from [`bench/reference/scenes.js`](../bench/reference/scenes.js): `spot-area`, `light-linking`, `metal`, `glass`, `outdoor-hdri`, and `lit-interior`. Every scene exports losslessly (`roundTripVerified = true`) via [`bench/cycles-parity/export-scene.mjs`](../bench/cycles-parity/export-scene.mjs) with Node asset loading handled in [`bench/cycles-parity/scene-bridge.mjs`](../bench/cycles-parity/scene-bridge.mjs) `[measured]`.

### M1 Acceptance Gates

Evaluated in [`bench/cycles-parity/compare.py`](../bench/cycles-parity/compare.py) (`--reference-b <seed2.npy>`) and orchestrated across all six scenes by [`bench/cycles-parity/run-m1-parity.py`](../bench/cycles-parity/run-m1-parity.py):

1. **Global per-channel mean radiance**: `mean(Cook) / mean(Cycles_Seed1)` within **`1 ± 0.02`** (`[0.98, 1.02]`) on each of `(R, G, B)`.
2. **`8 × 8` tile grid radiance**: every tile with `mean(Cycles_Seed1) > 0.01` has `mean(Cook) / mean(Cycles_Seed1)` within **`1 ± 0.05`** (`[0.95, 1.05]`).
3. **Display-space FLIP (`LDR`)**: `FLIP_LDR(Cook, Cycles_Seed1) <= FLIP_LDR(Cycles_Seed1, Cycles_Seed2) + 0.02`, using the exact ACES-like tone map and `2.2` gamma curve from [`bench/reference/score.py`](../bench/reference/score.py) (`tone_map_like_67js`, float32 inputs to `flip_evaluator`). Scene-referred `FLIP_HDR` is recorded alongside `FLIP_LDR` as a diagnostic.
4. **Closure white-furnace & sampling distribution gates**: evaluated in [`bench/cycles-parity/test-lobes.mjs`](../bench/cycles-parity/test-lobes.mjs) and [`bench/cycles-parity/verify-lobes.py`](../bench/cycles-parity/verify-lobes.py) across `20` `probeCyclesLobe` cases (`diffuse`, dielectric & conductor multiscatter `glossy_ggx`, F82-tint conductor, `anisotropic_ggx`, frontface/backface/TIR `glass_ggx`, `coat_ggx`, and `sheen`) plus `6` end-to-end uniform-sky sphere furnace scenes (`traceNative({ kernel: 'cycles' })`):
   - Mode `0` Monte Carlo directional albedo `mean(samp.eval / samp.pdf)` within **`1 ± 0.01`** (`N = 262,144` samples per case) on white-albedo configurations (`1 ± 0.015` on the grazing limb of curved glass spheres), plus `closure_sample` vs `closure_eval` self-consistency (`<= 2 × 10⁻³`).
   - Mode `0` vs Mode `1` (`1024 × 512` spherical `(cos_theta, phi)` quadrature aggregated into `32 × 32` directional bins, pooling `E_k < 5`) **Pearson $\chi^2$ goodness-of-fit `p >= 0.001`**.

### Cycles 5.3 OptiX `4096`-spp Reference Noise Floor (`Seed 1` vs `Seed 2`)

All six scenes were rendered in Blender `5.3.0` Cycles OptiX at `960 × 540`, `4096` samples (`seed = 1` and `seed = 2`), `bounces = 8` across all bounce types (`diffuse`, `glossy`, `transmission`, `volume`, `transparent_max`), `caustics_reflective = True`, `caustics_refractive = True`, direct/indirect clamps `0.0`, `filter_glossy = 1.0`, `BOX` filter width `1.0`, undenoised, `Raw` linear float32 EXR + `.npy` `[measured]`:

| Scene | Triangles | `relMSE(A, B)` `[measured]` | `Seed 2 / Seed 1` Mean Ratio `(R, G, B)` | Eligible `8 × 8` Tiles (`mean > 0.01`) | Tile `[min, max]` | `FLIP_LDR(A, B)` | M1 `FLIP_LDR` Ceiling (`+0.02`) | `FLIP_HDR(A, B)` |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `spot-area` | `3,024` | `0.000009` | `[1.000005, 1.000009, 1.000011]` | `47 / 47` | `[0.9995, 1.0004]` | `0.003934` | **`0.023934`** | `0.008907` |
| `light-linking` | `5,988` | `0.000004` | `[1.000001, 1.000000, 0.999996]` | `64 / 64` | `[0.9998, 1.0001]` | `0.002808` | **`0.022808`** | `0.004260` |
| `metal` | `18,520` | `0.003399` | `[0.999676, 0.999708, 0.999790]` | `64 / 64` | `[0.9945, 1.0016]` | `0.003733` | **`0.023733`** | `0.004250` |
| `glass` | `12,156` | `0.000044` | `[0.999754, 0.999784, 0.999836]` | `64 / 64` | `[0.9838, 1.0004]` | `0.003390` | **`0.023390`** | `0.004339` |
| `outdoor-hdri` | `5,028` | `0.000007` | `[1.000001, 1.000002, 1.000002]` | `64 / 64` | `[1.0000, 1.0001]` | `0.001520` | **`0.021520`** | `0.001687` |
| `lit-interior` | `3,072` | `0.000285` | `[1.000022, 1.000047, 1.000045]` | `64 / 64` | `[0.9993, 1.0011]` | `0.016457` | **`0.036457`** | `0.018145` |

*Light-linking audit `[measured]`*: Direct-only (`bounces = 0`, `32` spp) Cycles 5.3 OptiX verification with `--part-ids` confirmed exact per-receiver isolation on `light-linking`: `sphere-left` (`Point-0` `[1.0, 0.35, 0.2]`) measured `meanRGB = [0.33204, 0.11935, 0.07027]`, symmetric `sphere-right` (`Point-1` `[0.2, 0.45, 1.0]`) measured `meanRGB = [0.08664, 0.15207, 0.33205]`, and `stage-floor` (`Point-2` neutral) measured `meanRGB = [0.07034, 0.07033, 0.07033]` (`maxRGB = [0.1329, 0.1329, 0.1329]`, zero red/blue leakage).

### Pre-M1 Legacy Kernel (`--kernel legacy`, `256` spp) Baseline Against M1 Gates

Scored against `Cycles 4096 Seed 1` with `--reference-b Cycles 4096 Seed 2` (`2 / 6` scenes pass, `4 / 6` fail before the Cook `cycles` kernel lands) `[measured]`:

| Scene | All Gates | Mean Ratio `(R, G, B)` (`±2%`) | `8 × 8` Tiles Within `±5%` | Tile `[min, max]` | `FLIP_LDR` | Ceiling | `relMSE` | Sampling (s) | Primary Pre-M1 Failure Cause `[source]` + `[measured]` |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `spot-area` | **Pass** | `[1.0070, 1.0056, 1.0044]` | `47 / 47` | `[0.9812, 1.0231]` | `0.0231` | `0.0239` | `0.000863` | `1.007` | Within tolerance (analytic spot cone + rect area NEE) |
| `light-linking` | **Fail** | `[1.0115, 1.0107, 1.0115]` | `64 / 64` | `[0.9992, 1.0304]` | **`0.0243`** | `0.0228` | `0.000872` | `1.136` | Full-sphere `r = 0.1 m` point-light jitter + PCG grain |
| `metal` | **Fail** | `[0.9978, 0.9994, 0.9985]` | **`57 / 64`** | **`[0.9101, 1.1569]`** | **`0.0401`** | `0.0237` | `1.637659` | `1.369` | Missing F82 metallic tint, multiscatter GGX, and glossy sun/HDRI MIS |
| `glass` | **Fail** | `[1.0095, 1.0097, 1.0114]` | **`61 / 64`** | **`[0.8423, 1.2842]`** | **`0.0319`** | `0.0234` | `0.005463` | `1.317` | Missing full microfacet glass refraction Jacobian, multiscatter, and caustics |
| `outdoor-hdri` | **Pass** | `[1.0057, 1.0037, 1.0000]` | `64 / 64` | `[0.9981, 1.0208]` | `0.0173` | `0.0215` | `0.000287` | `0.491` | Open sky + `1°` sun NEE dominates smooth dielectric transport |
| `lit-interior` | **Fail** | `[1.0104, 1.0091, 1.0069]` | `64 / 64` | `[0.9832, 1.0282]` | **`0.0801`** | `0.0365` | `0.019762` | `1.173` | `6.3×` higher Monte Carlo variance without Light Tree + Tabulated Sobol |

### Milestone M1 Cook (`--kernel cycles`, `4096` spp) 6-Scene Parity Results

Rendered on RTX 3060 (`wgpu 30.0.1` Vulkan `EXPERIMENTAL_RAY_QUERY`) at `960 × 540`, `4096` samples, `bounces = 8` across all ray types, clamps `0`, `filterGlossy = 1.0`, `BOX` filter width `1.0`, undenoised, linear float32 RGB, scored against `Cycles 4096 Seed 1` with `--reference-b Cycles 4096 Seed 2`. **All `6 / 6` scenes pass every M1 radiometric, spatial-tile, and `FLIP_LDR` gate `[measured]`**:

| Scene | All Gates | Mean Ratio `(R, G, B)` (`±2%`) | `8 × 8` Tiles Within `±5%` | Tile `[min, max]` | `FLIP_LDR` | Ceiling | `FLIP_HDR` | `relMSE` | Setup / Sampling (s, GPU contention) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `spot-area` | **Pass** | `[1.0000, 1.0000, 1.0000]` | `47 / 47` | `[0.9992, 1.0009]` | `0.0071` | `0.0239` | `0.0148` | `0.000043` | `0.385` / `205.19` (`shared`) |
| `light-linking` | **Pass** | `[1.0009, 1.0007, 1.0009]` | `64 / 64` | `[0.9993, 1.0028]` | `0.0100` | `0.0228` | `0.0136` | `0.000113` | `0.425` / `291.65` (`shared`) |
| `metal` | **Pass** | `[0.9995, 0.9995, 0.9996]` | `64 / 64` | `[0.9935, 1.0059]` | `0.0055` | `0.0237` | `0.0061` | `0.005437` | `0.528` / `278.65` (`shared`) |
| `glass` | **Pass** | `[0.9976, 0.9979, 0.9983]` | `64 / 64` | `[0.9822, 1.0000]` | `0.0073` | `0.0234` | `0.0094` | `0.000076` | `0.445` / `423.51` (`shared`) |
| `outdoor-hdri` | **Pass** | `[0.9995, 0.9996, 0.9998]` | `64 / 64` | `[0.9987, 1.0001]` | `0.0029` | `0.0215` | `0.0032` | `0.000016` | `0.898` / `130.37` (`shared`) |
| `lit-interior` | **Pass** | `[1.0032, 1.0035, 1.0034]` | `64 / 64` | `[1.0004, 1.0082]` | `0.0217` | `0.0365` | `0.0238` | `0.000543` | `0.584` / `521.67` (`shared`) |

- **GPU contention note `[measured]`**: All six `4096`-spp Cook renders ran at `BelowNormal` priority under `gpu-lock` while `3–5` concurrent light-slot GPU processes (Blender, Node, Chrome/FFmpeg) shared the RTX 3060 (`gpuExclusive = false`, pre-run card VRAM `1,240–1,955 MiB`, card utilization `100%`). Cold Vulkan SPIR-V pipeline compilation of the Cycles WGSL kernel measured **`60.9 s`** once per driver cache before the speed work below, and about **`20 s`** after it (`0.15–0.18 s` warm). The sampling times in this table were taken before that speed work, on a shared card; the per-sample times are in the next section.
- **Closed Phase A bias gaps `[source]` + `[measured]`**:
  - **Solid-angle spherical cap & analytic emitter MIS** ([`lights.wgsl`](../packages/render-native/src/cycles/lights.wgsl), [`integrator.wgsl`](../packages/render-native/src/cycles/integrator.wgsl)): eliminates the `+2.80%` ceiling hotspot and `-2.06%` tabletop deficit on `lit-interior`, tightening per-part ratios to `[1.0014, 1.0061]` and all `64 / 64` tiles to `[1.0003, 1.0082]`.
  - **Principled v2 closures** ([`closure.wgsl`](../packages/render-native/src/cycles/closure.wgsl)): dielectric & conductor multiscatter GGX (`table_ggx_E` / `E_avg`), F82 metallic tint, full microfacet glass reflection/refraction with Beer-Lambert volume absorption, clearcoat albedo scaling, and sheen bring `metal` (`relMSE` `1.638` → `0.00544`) and `glass` (`relMSE` `0.00546` → `0.000076`) into sub-percent agreement with Cycles 5.3.
  - **Final-vertex background MIS & `filter_glossy`** ([`integrator.wgsl`](../packages/render-native/src/cycles/integrator.wgsl)): tracing the `B + 1` emission/background termination ray resolves Phase A Gap 4 (`B = 0` uniform-sky sphere exact), and matching Cycles `bsdf_blur` (`filter_glossy = 1.0`) eliminates secondary reflective/refractive floor caustic spikes on `metal` and `glass`.

### Milestone M1 Closure White-Furnace & Pearson Chi-Square Results

Evaluated across `20` `probeCyclesLobe` cases (`N = 262,144` samples each, `1024 × 512` quadrature grid aggregated into `32 × 32` bins) and `6` `traceNative({ kernel: 'cycles' })` sphere-in-uniform-sky furnace scenes (`128 × 128`, `512` spp, `bounces = 64`, `filterGlossy = 0`). **All `20 / 20` lobe probes and `6 / 6` sphere furnace scenes pass `[measured]`**:

| Probe ID | Family | Furnace Mean `(R, G, B)` | Max Rel `eval` / `pdf` Mismatch | Pearson $\chi^2$ `pValue` ($\chi^2_\nu$, `dof`) | Gate |
| --- | --- | --- | --- | --- | --- |
| `diffuse-lambert-normal` | `diffuse` | `[1.0000, 1.0000, 1.0000]` | `0` / `0` | `0.2917` (`1.033`, dof `511`) | **Pass** |
| `diffuse-principled-oblique` | `diffuse` | `[1.0000, 1.0000, 1.0000]` | `0` / `0` | `0.2917` (`1.033`, dof `511`) | **Pass** |
| `dielectric-glossy-sharp-oblique` | `glossy_ggx` | `[0.9992, 0.9992, 0.9992]` | `0` / `0` | singular (`—`) | **Pass** |
| `dielectric-glossy-rough-oblique` | `glossy_ggx` | `[1.0004, 1.0004, 1.0004]` | `0` / `0` | `0.5358` (`0.993`, dof `512`) | **Pass** |
| `dielectric-glossy-grazing` | `glossy_ggx` | `[0.9979, 0.9979, 0.9979]` | `0` / `0` | `0.4251` (`1.010`, dof `512`) | **Pass** |
| `conductor-ggx-sharp` | `glossy_ggx` | `[1.0000, 1.0000, 1.0000]` | `0` / `0` | singular (`—`) | **Pass** |
| `conductor-ggx-medium` | `glossy_ggx` | `[0.9999, 0.9999, 0.9999]` | `0` / `0` | `0.2616` (`1.039`, dof `512`) | **Pass** |
| `conductor-ggx-rough-grazing` | `glossy_ggx` | `[1.0002, 1.0002, 1.0002]` | `0` / `0` | `0.0760` (`1.091`, dof `512`) | **Pass** |
| `conductor-f82-gold-oblique` | `glossy_ggx` | `[0.9973, 0.7723, 0.3310]` | `0` / `0` | `0.5270` (`0.995`, dof `512`) | **Pass** |
| `anisotropic-ggx-unrotated` | `anisotropic_ggx` | `[0.9828, 0.9828, 0.9828]` (expects `0.9831`) | `0` / `0` | `0.9291` (`0.905`, dof `466`) | **Pass** |
| `anisotropic-ggx-rotated` | `anisotropic_ggx` | `[0.9846, 0.9846, 0.9846]` (expects `0.9848`) | `0` / `0` | `0.6095` (`0.980`, dof `457`) | **Pass** |
| `glass-ggx-frontface-sharp` | `glass_ggx` | `[1.0000, 1.0000, 1.0000]` | `0` / `0` | singular (`—`) | **Pass** |
| `glass-ggx-frontface-rough` | `glass_ggx` | `[1.0005, 1.0005, 1.0005]` | `0` / `0` | `0.8493` (`0.922`, dof `353`) | **Pass** |
| `glass-ggx-backface-subcritical` | `glass_ggx` | `[1.0004, 1.0004, 1.0004]` | `0` / `0` | `0.8372` (`0.937`, dof `487`) | **Pass** |
| `glass-ggx-backface-tir` | `glass_ggx` | `[0.9992, 0.9992, 0.9992]` | `0` / `0` | `0.0541` (`1.117`, dof `396`) | **Pass** |
| `coat-ggx-over-diffuse-sharp` | `coat_ggx` | `[0.9985, 0.9985, 0.9985]` | `0` / `0` | singular (`—`) | **Pass** |
| `coat-ggx-over-diffuse-rough` | `coat_ggx` | `[0.9997, 0.9997, 0.9997]` | `0` / `0` | `0.6471` (`0.975`, dof `512`) | **Pass** |
| `coat-ggx-over-metal-rough` | `coat_ggx` | `[1.0001, 1.0001, 1.0001]` | `0` / `0` | `0.2026` (`1.052`, dof `512`) | **Pass** |
| `sheen-over-diffuse-rough` | `sheen` | `[1.0000, 1.0000, 1.0000]` | `0` / `0` | `0.5533` (`0.990`, dof `511`) | **Pass** |
| `sheen-over-diffuse-grazing` | `sheen` | `[1.0000, 1.0000, 1.0000]` | `0` / `0` | `0.5333` (`0.994`, dof `511`) | **Pass** |

The two `anisotropic-ggx-*` probes (white base color, metallic `1`, roughness `0.35`, anisotropy `0.7`, multiscatter GGX) do not expect `1.0`: Cycles 5.3 itself loses energy for anisotropic GGX (the measured albedo is below 1 at anisotropy `0.7`), so the probes carry `furnaceExpectedAlbedo` (Blender 5.3 Cycles measurement, same `0.01` tolerance). The isotropic probes keep `1.0`. Measured with [`bench/cycles-parity/furnace-albedo.py`](../bench/cycles-parity/furnace-albedo.py): Blender 5.3.0 Cycles on OptiX, an orthographic camera looking down `wo = (0.5, 0.3, 0.8124)` at an infinite plane with a Principled BSDF (base color `1`, metallic `1`, roughness `0.35`, Multiscatter GGX, tangent `+X`), uniform white world of strength `1`, Standard view transform, no denoise, no clamp, `8192` spp, `64 x 64` pixels, so each pixel is the directional albedo (standard error under `0.02 %`).

| Material | Cycles 5.3 albedo | Cook albedo |
| --- | --- | --- |
| isotropic control (anisotropy `0`) | `1.0004` | not probed at this angle; the isotropic probes pass at `1.0` within `0.0004` |
| anisotropic, rotation `0.0` | `0.9831` | `0.9828` |
| anisotropic, rotation `0.2` | `0.9848` | `0.9846` |

| Sphere Furnace Scene (`traceNative`, `512` spp, `bounces = 64`) | Full-Image Mean | Center Mean | Limb Mean | Gate |
| --- | --- | --- | --- | --- |
| `furnace-scene-diffuse` | `1.0000` | `1.0000` | `0.9999` | **Pass** |
| `furnace-scene-dielectric-glossy` | `0.9995` | `1.0004` | `0.9992` | **Pass** |
| `furnace-scene-metal` | `1.0001` | `1.0001` | `1.0001` | **Pass** |
| `furnace-scene-glass` | `0.9947` | `0.9994` | `0.9934` | **Pass** |
| `furnace-scene-coat` | `0.9994` | `1.0011` | `0.9981` | **Pass** |
| `furnace-scene-sheen` | `0.9993` | `1.0008` | `0.9986` | **Pass** |

### Selecting the kernel

The native tracer runs the legacy kernel unless you ask for the Cycles-matching kernel (Cook's `cycles` kernel). Pass `kernel: 'cycles'` to `traceNative`, or set the environment variable `JS67_NATIVE_KERNEL=cycles` for a process; an explicit `kernel` option wins over the variable. Any other name throws an error that lists the two valid names. The `cycles` kernel reads a FORMAT-v2 scene pack ([`FORMAT-v2.md`](../packages/render-native/FORMAT-v2.md)), the legacy kernel a v1 pack, and passing one to the wrong kernel throws. The default image of every existing caller does not change.

```js
import { traceNative } from '@codepawlhq/67js-render-native';

const result = traceNative(sceneInput, { width: 960, height: 540, samples: 256, kernel: 'cycles' });
```

### Speed of the `cycles` kernel

Sampling time, `960 x 540`, `256` samples, `8` bounces, RTX 3060, interleaved runs through `gpu-lock`, two runs each `[measured]`:

| Scene | Legacy kernel | `cycles` kernel | `cycles` / legacy |
| --- | --- | --- | --- |
| `lit-interior` | `0.92 s`, `0.93 s` | `2.86 s`, `2.86 s` | `3.1x` |
| `metal` | `0.57 s`, `0.58 s` | `1.34 s`, `1.34 s` | `2.3x` |

The `cycles` kernel is `2.3` to `3.1` times slower per sample than the legacy kernel and is opt-in. Its first version took `30.8 s` on `lit-interior` and `17.2 s` on `metal`; the speed work (per-scene kernel specialization, lookup tables in a storage buffer, passing closures and lobes by pointer, removing a scratch array) left the images bit-identical at the same seed and cut the compiled SPIR-V from `936 KB` to `306 KB`. A target of `2x` the legacy time was not reached.

Against Cycles 5.3 OptiX on `lit-interior`, `256` samples took `11.4 s` (measured in an earlier session on the same machine). Relative MSE against the Cycles `4096`-sample reference at `256` samples on `lit-interior`:

| Renderer | `relMSE` at `256` samples |
| --- | --- |
| Legacy kernel | `0.0198` |
| `cycles` kernel | `0.0065` |
| Cycles 5.3 OptiX | `0.0031` |

These are per-sample times on one scene. An equal-error comparison between the `cycles` kernel and Cycles has not been measured directly, so nothing here says Cook is faster than Cycles in general. The Cycles `lit-interior` reference was not re-rendered with the current script (its scene file and image are byte-identical to the earlier run).

---

## Reproducible Commands

Run from the repository root in PowerShell. Set `$env:BLENDER_BIN` if Blender 5.3 is installed outside `C:\Program Files\Blender Foundation\Blender 5.3\blender.exe`, and pass an untracked `<out-dir>` (such as `artifacts/cycles-parity`) so binary `.exr` and `.npy` files stay out of Git:

```powershell
# 1. Lower priority so child Node / Blender processes do not starve interactive work
([System.Diagnostics.Process]::GetCurrentProcess()).PriorityClass = [System.Diagnostics.ProcessPriorityClass]::BelowNormal
if (-not $env:BLENDER_BIN) {
  $env:BLENDER_BIN = "C:\Program Files\Blender Foundation\Blender 5.3\blender.exe"
}
$OutDir = "artifacts/cycles-parity"

# 2. Build packages/render-native if build/render-native.node is not present yet
node packages/render-native/build.mjs

# 3. Export all 6 M1 reference scenes and verify byte-identical round-trip packing
foreach ($Scene in @("spot-area", "light-linking", "metal", "glass", "outdoor-hdri", "lit-interior")) {
  node bench/cycles-parity/export-scene.mjs $OutDir --scene $Scene
}

# 4. Run a single matched 4096-spp pair (Cycles 5.3 OptiX vs Cook --kernel cycles) through gpu-lock
$env:GPU_LOCK_WEIGHT = "heavy"
bash $env:GPU_LOCK_SCRIPT `
  uv run --no-project --with psutil python bench/cycles-parity/measure-gpu-run.py "$OutDir/references/spot-area-cycles-4096-seed1.metrics.json" -- `
  $env:BLENDER_BIN -b --factory-startup --python bench/cycles-parity/render-cycles.py -- `
  "$OutDir/scenes/spot-area.json" "$OutDir/references/spot-area-cycles-4096-seed1" --samples 4096 --bounces 8 --seed 1 --keep-exr
Remove-Item Env:GPU_LOCK_WEIGHT -ErrorAction SilentlyContinue

bash $env:GPU_LOCK_SCRIPT `
  uv run --no-project --with psutil python bench/cycles-parity/measure-gpu-run.py "$OutDir/harness/spot-area-cycles-4096.metrics.json" -- `
  node bench/cycles-parity/trace-native.mjs `
  "$OutDir/scenes/spot-area.json" "$OutDir/harness/spot-area-cycles-4096" --kernel cycles --samples 4096 --bounces 8 --seed 1

uv run --no-project --with numpy --with flip-evaluator python bench/cycles-parity/compare.py `
  --reference-b "$OutDir/references/spot-area-cycles-4096-seed2.npy" --summary `
  "$OutDir/references/spot-area-cycles-4096-seed1.npy" "$OutDir/harness/spot-area-cycles-4096.npy"

# 5. Run the full 4096-spp 6-scene M1 parity suite and the 20-probe + 6-scene Lobe Furnace / Chi-Square suite
uv run --no-project --with numpy --with pillow --with OpenEXR --with flip-evaluator --with psutil python bench/cycles-parity/run-m1-parity.py `
  $OutDir --kernel cycles --samples 4096 --bounces 8 --seed 1 --reference-samples 4096 --json-out "$OutDir/harness/m1-cycles-s4096.json"

bash $env:GPU_LOCK_SCRIPT node bench/cycles-parity/test-lobes.mjs "$OutDir/harness/lobes"
uv run --no-project --with numpy python bench/cycles-parity/verify-lobes.py "$OutDir/harness/lobes" --json-out "$OutDir/harness/lobes/summary.json"
uv run --no-project --with numpy python bench/cycles-parity/verify-lobes.py --self-test

# 6. Run or re-score the M0 reference + 3x back-to-back ladder suite (writes <out-dir>/lit-interior-summary.json)
# Set GIT_BASH_BIN="C:\Program Files\Git\bin\bash.exe" and GPU_LOCK_SCRIPT="<path-to-gpu-lock.sh>" to wrap every GPU step automatically.
uv run --no-project --with numpy --with psutil python bench/cycles-parity/run-m0-suite.py $OutDir --scene lit-interior --repeats 3 --bounces 8 --mode all
```
