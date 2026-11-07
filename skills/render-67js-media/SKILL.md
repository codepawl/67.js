---
name: render-67js-media
description: Export 67js scenes to PNG or MP4 on GPU or CPU. Use for render ảnh/video 3D, export presets, MSAA quality, performance measurements and bounded RAM/VRAM capture without buffering full frame sequences.
license: MIT
---

# Xuất ảnh và video 67js

Locate the 67js checkout and read its `scripts/render-media.mjs` and `src/budget.js`.
Read [rendering.md](references/rendering.md) for commands, backends and measurement limits.
Use the repository pipeline rather than constructing a parallel exporter.

For MCP snapshot jobs, read the checkout's `docs/agent-render-jobs.md` and verify source versus published support.
Configure a private job store. Poll status after cancellation before resuming preview edits.
For a video with cuts, sound or an encoder choice, use the recipe `timeline`, `settings.timeline`, `settings.audio` (a file in the server's `--audio` folder) and `settings.encoder` described in the same document; the job reports measured sync.
For procedural motion, read `docs/agent-motion.md` and select `settings.motion.start`. Preview seeks preserve revisions and authored recipes.

For imported character motion from `0.8.0`, read `docs/agent-character-motion.md`. Use independent `settings.animation` and `settings.motion` clocks.

For an offline path-traced still with **Cook** (glass refraction, soft multi-bounce indirect light, subsurface random walk, many lights), read `docs/path-tracer.md` and submit an `image` job with `settings.renderer: { type: "pathTracer" }`. It is slow, bounded and offline: read `scene_capabilities` `pathTracer` for its limits and what it skips, and keep rasterizer jobs for video and passes.

## Render a scene.json world along a camera track

To film a world the showcase page shows (GLB, sky, renderer options, exposure, effects), plan the path and render it headless:

```powershell
# keys.json: { "fps": 24, "frames": [[[x, y, z], [tx, ty, tz]], ...] }  (one eye and target per frame; createCameraPath keys also work)
bash ~/.agents/tools/gpu-lock.sh node scripts/render-media.mjs --kind video --scene file --config public/showcase/bistro/scene.json --camera keys.json --width 960 --height 540 --duration 5 --output artifacts/walk.mp4
```

`--root <folder>` names the folder that `/showcase/...` paths in the config are relative to; without it they resolve next to the config. `--duration` and `--start` pick a slice of the track (default: all of it, at the track's fps). Check one frame first with `--kind image --time 2.5`.

## Choose and render

1. Check the available GPU memory before a GPU job on a shared machine.
2. Choose GPU rendering for speed. Choose the CPU preset when hardware WebGL is unavailable.
3. Choose the smallest preset that meets the output requirement.
4. Set width, height, samples and memory before rendering.
5. Keep one browser, one live scene renderer and one pending capture frame.
6. Stream frames to FFmpeg. Await encoder backpressure before capturing the next frame.
7. Stop on browser errors, graphics errors or a memory guard failure.
8. Inspect representative stills before the full film export.
9. Verify duration, frame count, dimensions, color metadata, audio and file size with FFprobe.
10. Inspect the output report and close the browser and encoder after the job.

Use below-normal priority for heavy local exports. Do not stop another session's process.
Use deterministic scene time. Do not use a real-time screen recording for offline export.

CPU encoding and CPU rendering are separate choices.
GPU encoding uses NVENC when supported. CPU encoding uses two threads by default.

## Report the limits

The framebuffer estimate is an allocation model, not a measured total VRAM figure.
Node RSS and the sampled browser JavaScript heap do not cover every browser allocation.
Report the actual renderer backend, estimated target memory, observed process metrics and elapsed export time.
Do not promise that a budget prevents every driver or system allocation failure.
When resolution is reduced, state the actual render dimensions.

Deliver the PNG or MP4, its JSON report and the reproduction command.
For a score, record provenance and measured loudness. Say whether anyone listened to it.
