# Render job settings

<!-- skill-navigation:start -->
This is the [Render job settings](#render-job-settings) reference. Read the opening paragraph, then only the section for the job:
[One PNG](#one-png), [Eight stills](#eight-stills), [MP4 of recipe motion](#mp4-of-recipe-motion), [Shots, cuts and sound](#shots-cuts-and-sound),
[Encoder](#encoder), [Render passes](#render-passes), [Compositing output: alpha, 16-bit, EXR, region, 60 fps](#compositing-output-alpha-16-bit-exr-region-60-fps),
[Path traced still](#path-traced-still) (also traced video) and [Imported character clips](#imported-character-clips).
<!-- skill-navigation:end -->

Every recipe is the arguments of `scene_render_submit`. `sessionId` may be left out. `expectedRevision` is the
revision `scene_inspect` returned. Required in `settings`: `kind` (`image`, `stills` or `video`), `width`, `height`
(64 to 1920 each and at most 1920x1080 pixels together, so 1080x1920 fits and 1920x1920 fails; video sizes must be
even). Defaults: 24 fps and one second.
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
A recipe with `physics` or `cloth` and no authored motion plays its bake on the same clock: send `motion: { "start": 0 }`,
leave `duration` out to film the whole bake, and skip `bake-motion` (its 32 node cap does not apply). Nothing that moves
still fails with an error naming motion, physics, cloth, particles, clips and map sequences.
Motion blur (`effects.motionBlur.shutter`) needs camera tracks and this `motion` setting.

## Shots, cuts and sound

A recipe `timeline` (see `build-crucible-scene`, `film-and-animation.md`) plays its shots, so the job takes `timeline`
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

`image` and `stills` jobs take `passes`, a list of `albedo`, `normal`, `emission`, `depth`, `objectId`, `diffuse`, `glossy`, `shadow`, `ao` and `mist` (lighting terms: use `exr` for them).
More names exist (`position`, `velocity`, `uv`, `transmission`, `volume`, `environment`, `cryptomatte`, `aov`, `wireframe`); `scene_capabilities` lists them all. Each frame
also writes one raw PNG per pass at the lit image's size, with no grading, bloom, depth of field or antialiasing.

```json
{ "expectedRevision": 3, "settings": { "kind": "image", "width": 960, "height": 540, "passes": ["depth", "objectId"] } }
```

Only opaque and cutout geometry appears. `scene_render_result` metrics carry `objectNames` (read the names for the IDs;
IDs follow draw order, not node order) and `depthRangeMetres`. Depth is metres over 100 in a 16-bit value (high byte
in red, low in green); background is `255, 255, 0`. Videos hold the lit image only.

## Compositing output: alpha, 16-bit, EXR, region, 60 fps

Four optional settings, off unless set, so defaults write the same bytes as before.

```json
{ "expectedRevision": 3, "settings": { "kind": "image", "width": 1280, "height": 720, "transparent": true, "format": "exr",
  "passes": ["depth"], "region": { "x": 320, "y": 180, "width": 640, "height": 360 } } }
```

- `transparent: true` (image, stills): the lit PNG keeps alpha. Sky, environment background and the automatic ground are not
  drawn, so add your own ground or a `shadowCatcher` node; volume fog is refused; passes ignore it.
- `format` (image, stills): `png` (default), `png16` (16-bit RGB or RGBA) or `exr` (half float, premultiplied alpha). Files are
  `render.png` or `render.exr` plus `render-<pass>.<ext>`. Depth is a 16-bit gray step in `png16` and float metres in channel `Z`
  in `exr`; object IDs are a gray 16-bit PNG (up to 65535 objects) or float channel `id`.
- `region: { x, y, width, height }` (pixels from the top left, each side 16 or more; even sides for video): the frame is
  rendered whole and cropped, so the look matches the full frame.
- `multilayer: true` (with `format: "exr"` and `passes`): one EXR per frame holds the lit image and every pass.
- `fps` up to 60 for video, inside 900 frames.
- The path tracer refuses transparent, format and region; H.264 refuses transparent and format.

## Path traced still

Offline Cook path tracing: glass refraction, soft multi-bounce light, subsurface, many lights. Slow and bounded. Judge
a still first; `stills` and `video` jobs take the same `renderer`, each frame may run for `maxSeconds` and the whole job
stops at 30 minutes, so keep a traced video short and small. It writes no passes. Read `scene_capabilities`
(topic `jobs`, key `pathTracer`) for limits and what it skips.

```json
{ "expectedRevision": 3, "settings": {
  "kind": "image", "width": 960, "height": 540,
  "renderer": { "type": "pathTracer", "backend": "cpu", "samples": 64, "bounces": 8, "denoise": true, "maxSeconds": 120 }
} }
```

`backend` is `cpu` (default, reproducible), `gpu` (needs a server started with `--backend gpu`) or `native`
(hardware ray queries; it falls back to `gpu` or `cpu` and `metrics.pathTracer.backendNote` says why). Start with 16
samples to judge the light, then raise them. Ranges: `samples` 1 to 1024, `bounces` 1 to 16, `maxSeconds` 1 to 600.
`denoise` is `true` (the built-in filter), `false`, or `"oidn"` where the server has that optional package.

## Imported character clips

`animation: { "clip": 0, "start": 1 }` samples an imported asset's clip and `rendererTime` sets shader time. They
are separate clocks from `motion`. Clip ids come from `scene_inspect`.
