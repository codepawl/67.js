# Rendering commands

Run these commands from the repository root.

```powershell
node scripts/render-media.mjs --kind image --scene nature --backend gpu --preset high --output artifacts/nature.png
node scripts/render-media.mjs --kind image --scene object --backend cpu --preset cpu --output artifacts/object-cpu.png
node scripts/render-media.mjs --kind stills --scene film --backend gpu --preset balanced --output artifacts/stills/frame.png
node scripts/score.mjs
node scripts/render-media.mjs --kind video --scene film --backend gpu --preset balanced --encoder gpu --output artifacts/critical.mp4
```

The available scenes are `object`, `nature`, `film`, `motion`, `view2d` and `assets`.
GPU rendering selects hardware WebGL through Chrome. CPU rendering requests ANGLE SwiftShader.
The CPU exporter verifies that the selected backend reports SwiftShader.

| Preset | Dimensions | Samples | FPS | Target budget |
| --- | --- | ---: | ---: | ---: |
| `preview` | 960 × 540 | 2 | 24 | 256 MiB |
| `balanced` | 1280 × 720 | 4 | 24 | 384 MiB |
| `high` | 1920 × 1080 | 4 | 24 | 512 MiB |
| `cpu` | 640 × 360 | 1 | 12 | 192 MiB |

The memory planner includes color/depth targets, resolve storage, staging frames, shadows and uploaded geometry.
The browser context remains an additional allocation outside that estimate.
The offline exporter uses one capture frame at a time.
It disposes the previous scene before uploading the next scene.

`--memory` controls the target budget. `--width`, `--height`, `--fps` and `--duration` override preset values.
For object images, `--assembly 1` explodes the model. The default value `0` assembles it.

Each option requires a value. Dimensions range from 64 to 4096 pixels.
Memory ranges from 32 to 1024 MiB. Duration ranges from 0.1 to 120 seconds.
MCP render jobs (`scene_render_submit`) take up to 1920x1080 (each side up to 1920, at most that many pixels) and `--memory` up to 384 MiB. A 1920x1080 frame needs about 175 MiB of targets, so use `--memory 256` for it. A job gets 60 s plus 2 s per frame (more for frames above 1024x576), at most 30 minutes; the video encoder waits 30 s to drain and to finish.

The video encoder can use `--encoder cpu` or `--encoder gpu` independently of the renderer backend.
The hardware encoder requires NVENC. A failed encoder stops the export and reports its error.
The renderer does not silently replace a failed hardware export with a lower-quality output.

Video capture cost (measured on an RTX 3060 at 1280x720 on a loaded machine, 20 s of the film, 480 frames, NVENC).
Screenshots (`--capture jpeg`) cost 28.8 ms a frame to capture and 7.4 ms to draw, 21.5 s for the clip.
Every report has `stageTimings.captureSeconds` and `renderSeconds`.
`--capture auto`, the default for video, uses WebCodecs and falls back to screenshots (never raw readback, which is slower) when the browser cannot hardware encode the size or `--encoder cpu` or `--backend cpu` is requested. `--capture webcodecs` fails instead of falling back, `--capture jpeg` and `--capture png` keep screenshots, and `--capture raw` keeps the `readPixels` and WebSocket path as opt in. The hardware encoder is the browser's, so the bitstream can differ between machines and drivers even though the frames are deterministic, which is why `--encoder cpu` keeps libx264 on screenshots.
Profile of the first readback design (10 s of the film, 240 frames, RTX 3060, 1280 by 720): 94 ms a frame in capture, of which `readPixels` was 6.6 ms and ffmpeg was nothing, because ffmpeg alone with vflip, the BT.709 conversion and NVENC took 3.7 ms a frame (3.0 ms with no filter). The cost was moving 3.7 MB of pixels from Chrome to Node over a WebSocket: 27 to 52 ms a frame depending on frames in flight and sockets, about 100 to 140 MB a second, and still 9 to 16 ms for the 1.4 MB a YUV 4:2:0 frame would need. Chrome's WebCodecs `VideoEncoder` removes the pixels from the trip. The page encodes each frame with the browser's hardware H.264 encoder (fixed quantizer 20, no B-frames), so only about 5 to 60 kB of encoded chunks a frame cross the socket, and `ffmpeg -c copy` muxes them with the audio. Measured on the full 4,488 frame film at 1280 by 720: 20.6 s in all, draw 2.0 ms and capture 2.2 ms a frame, no encoder backpressure. The same machine, same evening, screenshots took 139.6 s (capture 25.1 ms a frame) and the first raw readback took 405.1 s (capture 84.8 ms a frame). On a 10 s clip within one hour, capture was 4.2 ms with WebCodecs, 22.1 ms with screenshots and 93.9 ms with raw readback. The result matches the NVENC raw path of the same clip at 44.8 dB PSNR (quantizer 22 when measured), is tagged BT.709 limited range, and has all 4,488 frames.
Returning the pixels through Playwright instead cost 55 ms a frame, and a fetch with a Blob body failed after about 100 frames, so neither is used.
A decoded raw frame matches the PNG seek of the same time at 41.0 dB PSNR on SwiftShader (`npm run smoke:capture-parity`).

`scripts/score.mjs` generates the original film score.
The `--audio <path>` option selects an existing score.
Only `film` selects the CRITICAL score automatically.
Do not use movie dialogue, footage or music without authorization.

```powershell
ffprobe -v error -count_frames -show_entries stream=codec_name,width,height,r_frame_rate,nb_read_frames,color_space:format=duration,size -of json artifacts/critical.mp4
```

Inspect the sidecar `<output>.json` for backend, estimated allocation, process memory, frame queue and graphics errors.
The process guard stops Node above 512 MiB and sampled browser JavaScript heap above 256 MiB.
Heap samples do not establish peak browser RSS or total VRAM use.

## Animation, shorts and assets

```powershell
node scripts/render-media.mjs --kind video --scene motion --aspect portrait --backend gpu --encoder gpu --output artifacts/short.mp4
node scripts/render-media.mjs --kind image --scene view2d --aspect square --backend cpu --preset cpu --output artifacts/poster.png
node scripts/render-media.mjs --kind video --scene assets --asset model.glb --start 0 --duration 2 --output artifacts/model.mp4
```

`--aspect` accepts `landscape`, `portrait` or `square`. Explicit width and height override preset dimensions.
`--start` selects the first video sample. A scene duration limits the selected range.
`--asset` accepts a local GLB of at most 32 MiB and requires `--scene assets`.
The importer reports unsupported features before capture.

A reusable viewer exposes `window.__scene = { renderer, renderAt, duration, pause }`.
The exporter prioritizes this interface and samples absolute scene time.
The JSON report includes negotiated HDR and MSAA capabilities, alongside estimated allocation.
