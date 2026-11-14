# Verification

These figures are from the 0.3.x site and export work, measured around 2026-10-09 and not repeated since. Per-release checks from 0.4.0 on are in [release-verification.md](https://github.com/codepawl/crucible/blob/main/docs/release-verification.md). Run `npm test` for the current test count.

The checks used Windows Chrome 154 through Playwright, an RTX 3060 through ANGLE D3D11 and CPU rendering through SwiftShader.

| Check | Result |
| --- | --- |
| Node tests | Tests for geometry, bounds, scene budgets, timeline sampling and GLB loading passed. |
| GLB | The independent Three.js GLTFLoader loaded all 574 WALL·E nodes. The assembled file contains 635,752 bytes. |
| Explosion | The GPU pixel checksum returned to its original value after a 0 → 50 → 100 → 0 slider round trip. |
| Allocation reuse | The shadow texture remained identical while the slider moved. |
| Layers and export | Shell, interior and combined views worked. Exploded GLB translations matched the authored offsets. |
| Studio controls | Finishes, keyboard orbit, reset, normals, auto orbit and downloads passed. |
| Recovery | WebGL context loss and restoration passed without graphics errors. |
| Nature | Daylight, wind, viewpoints, detail, water ripples, keyboard orbit and PNG download passed. |
| Film | Out-of-order seeks reproduced ignition pixels. Playback, score loading, pause and mobile controls passed. |
| Layout | Rendered studio, nature and film views were inspected at desktop and 320-pixel widths. |
| Reduced motion | Nature starts paused. Film playback waits for a click. |
| Production | Vite built all three pages. Its large-chunk warning applies to the optional Three.js benchmark. |
| Skills | Both entrypoints passed frontmatter, length and route validation. GPU and CPU export commands produced usable files. |

The studio review found panels covering the model and missing spaces around mobile line breaks.
Camera framing and HTML whitespace fixed those problems. The subsequent screenshots show the repaired views.
Material tags use flat shader varyings because interpolated tags previously produced stripes on the floor.
The current studio enables four MSAA samples, FXAA and specular filtering.

## Offline exports

| Export | Output | Elapsed time | Estimated render memory | Observed Node RSS |
| --- | --- | ---: | ---: | ---: |
| GPU WALL·E image | 1920 × 1080 PNG | 1.68 s | 119.4 MiB | 124.0 MiB |
| CPU WALL·E image | 640 × 360 PNG | 4.02 s | 22.7 MiB | 124.5 MiB |
| GPU film, NVENC | 1280 × 720, 32 s, 24 FPS | 256.68 s | 61.9 MiB | 214.8 MiB |
| CPU film trial, libx264 | 640 × 360, 2 s, 12 FPS | 7.33 s | 22.3 MiB | 157.5 MiB |

The image runs use different resolutions. Their times do not establish a direct CPU/GPU speed comparison.
Elapsed export time includes browser startup, PNG capture and encoding.
All four runs reported zero WebGL errors.
Both video runs held a maximum of one pending frame.
The full GPU film sampled a maximum JavaScript heap of 6.9 MiB.

FFprobe verified 768 H.264 frames, 32.000 seconds, 24 FPS, BT.709 metadata and 48 kHz stereo AAC.
The MP4 contains 13,759,581 bytes. Representative encoded frames were inspected in `film-contact.png`.

FFmpeg measured the encoded score at -21.0 dB mean volume and -4.5 dB peak volume.
The score uses original synthesized tones and seeded noise. No human listening check was performed.

The JSON reports contain the exact measurements.

- `wall-e-gpu.json` and `wall-e-cpu.json` record the image runs.
- `film-cpu-trial.json` records the software rendering and encoding trial.
- `../public/media/critical.mp4.json` records the full hardware export.
- `benchmark.json` records the comparison with Three.js.

The memory estimate covers authored targets, geometry and staging. It does not measure total driver VRAM or browser RSS.
The sampled JavaScript heap can miss intermediate peaks.
The guards reduce allocation risk without guaranteeing that every system allocation succeeds.

## Limits

The benchmark measures CPU draw submission with identical flat shaders. Every result agreed on more than 99.99% of image channels.
It does not measure GPU frame time or establish general Three.js superiority.

The film and nature world use stylized procedural assets. Blender-level realism remains unverified.
Screen-reader behavior, 200% browser zoom and formal contrast compliance were not verified.
The skills passed structural checks and real pipeline exercises. Automatic skill selection was not evaluated.
