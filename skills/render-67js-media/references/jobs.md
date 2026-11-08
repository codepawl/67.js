# Render job settings

Every recipe is the arguments of `scene_render_submit`. `sessionId` may be left out. `expectedRevision` is the
revision `scene_inspect` returned. Required in `settings`: `kind` (`image`, `stills` or `video`), `width`, `height`
(64 to 1920 each; video sizes must be even). Defaults: 24 fps and one second.
`tests/render-skill-examples.test.js` checks that these blocks stay valid JSON with known settings fields.

## One PNG

```json
{ "expectedRevision": 3, "settings": { "kind": "image", "width": 960, "height": 540 } }
```

An image samples the pose at `motion.start`, so a still of a mid-animation moment is
`"motion": { "start": 2.5 }`. Lens, depth of field, look and fog come from the recipe, so a still matches `scene_look`.

## Eight stills

`kind: "stills"` writes eight evenly spaced PNGs (a contact sheet of a motion). Use it to check a film before you
render the video.

```json
{ "expectedRevision": 3, "settings": { "kind": "stills", "width": 640, "height": 360, "duration": 4, "motion": { "start": 0 } } }
```

## MP4 of recipe motion

```json
{ "expectedRevision": 3, "settings": {
  "kind": "video", "width": 1280, "height": 720, "fps": 24, "duration": 4, "motion": { "start": 0 }
} }
```

Video is H.264 with one frame in flight. At most 60 s and 900 frames, so 60 s needs 15 fps or less. A nonlooping
motion must cover `start + duration`. The animated lights, sun, sky and effects tracks play with the same setting.
Motion blur (`effects.motionBlur.shutter`) needs camera tracks and this `motion` setting.

## Shots, cuts and sound

A recipe `timeline` (see `build-67js-scene`, `film-and-animation.md`) plays its shots, so the job takes `timeline`
and no `motion` or `animation`. `duration` defaults to the rest of the timeline.

```json
{ "expectedRevision": 4, "settings": {
  "kind": "video", "width": 1280, "height": 720, "fps": 24,
  "timeline": { "start": 0 },
  "audio": { "file": "score.wav", "offset": 0 }
} }
```

`audio.file` is a plain name of a `.wav`, `.mp3`, `.ogg` or `.flac` file (32 MiB at most) in the server's `--audio`
folder; no path or URL. It is resampled to 48 kHz and encoded as AAC. The result reports `metrics.sync`, and a
difference over 50 ms fails the job. A file shorter than the video after its `offset` fails before rendering. For a film
longer than one job (60 s) render parts with `track: "pcm"` (lossless, no encoder padding) and join them with
`ffmpeg -f concat -safe 0 -i parts.txt -c copy joined.mp4`, then lay the sound once.

## Encoder

`encoder: "cpu"` (libx264, default) or `"nvenc"` (h264_nvenc, in-page hardware encoding). A machine without NVENC
fails the job and does not fall back, so choose `cpu` unless you know the machine. The result reports
`metrics.videoEncoder`, `captureSeconds` and `renderSeconds`.

## Render passes

`image` and `stills` jobs take `passes`, a list of `albedo`, `normal`, `emission`, `depth` and `objectId`. Each frame
also writes one raw PNG per pass at the lit image's size, with no grading, bloom, depth of field or antialiasing.

```json
{ "expectedRevision": 3, "settings": { "kind": "image", "width": 960, "height": 540, "passes": ["depth", "objectId"] } }
```

Only opaque and cutout geometry appears. `scene_render_result` metrics carry `objectNames` (read the names for the IDs;
IDs follow draw order, not node order) and `depthRangeMetres`. Depth is metres over 100 in a 16-bit value (high byte
in red, low in green); background is `255, 255, 0`. Videos hold the lit image only.

## Path traced still

Offline Cook path tracing: glass refraction, soft multi-bounce light, subsurface, many lights. Slow and bounded, for
stills. Read `scene_capabilities` (`pathTracer`) for limits and what it skips.

```json
{ "expectedRevision": 3, "settings": {
  "kind": "image", "width": 960, "height": 540,
  "renderer": { "type": "pathTracer", "backend": "cpu", "samples": 64, "bounces": 8, "denoise": true, "maxSeconds": 120 }
} }
```

`backend` is `cpu` (default, reproducible), `gpu` (needs a server started with `--backend gpu`) or `native`
(hardware ray queries; it falls back to `gpu` or `cpu` and `metrics.pathTracer.backendNote` says why). Start with 16
samples to judge the light, then raise them.

## Imported character clips

`animation: { "clip": 0, "start": 1 }` samples an imported asset's clip and `rendererTime` sets shader time. They
are separate clocks from `motion`. Clip ids come from `scene_inspect`.
