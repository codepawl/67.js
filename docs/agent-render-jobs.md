# Render jobs

Release `0.6.0` includes five MCP tools for asynchronous image and video rendering.

## Agent workflow

1. Install `crucible` with `npm install crucible@npm:@codepawlhq/crucible@0.7.0`.
2. Launch `npx crucible-mcp --backend cpu --jobs C:/projects/my-scene/render-jobs`.
3. Create a scene and inspect its current revision.
4. Submit `scene_render_submit` with the session ID, current revision and render settings.
5. Poll `scene_render_status` until the job reaches a terminal state.
6. Read `scene_render_result` after completion to obtain output paths and SHA-256 hashes.
7. Release unwanted outputs with `scene_render_release`.

For MP4 jobs, FFmpeg must be on PATH or configured with `--ffmpeg` and an absolute executable path.
The job store must be private, absolute and dedicated to this runtime.
The store records UUIDs that `scene_capabilities` lists after a restart.

```json
{
  "sessionId": "<session UUID>",
  "expectedRevision": 0,
  "settings": {
    "kind": "video", "width": 640, "height": 360,
    "fps": 24, "duration": 3,
    "animation": { "clip": 0, "start": 1 },
    "rendererTime": { "start": 0, "rate": 1 }
  }
}
```

The runtime captures the source recipe and verified asset bytes before returning a job ID.
The job uses a separate browser page and temporarily leases the single renderer.
Preview rendering and edits pause during a job. Inspection and recipe export remain available.
The source revision, pose and checkpoints survive completion or cancellation.
Cancellation becomes terminal after the owned encoder and job page stop and the preview recovers.

Video uses H.264 (CPU by default, see `settings.encoder`), even dimensions and one streamed frame at a time.
With `settings.encoder` `nvenc`, MCP video frames are encoded in the page by the browser's hardware H.264 encoder in the same task as the draw, and only the encoded chunks travel to Node over one binary WebSocket on the preview server port, where `ffmpeg -c copy` muxes them with the audio (issue #301). Without NVENC, or when the browser cannot encode the size, frames are JPEG screenshots encoded by ffmpeg.
PNG stills and render passes still use a DevTools screenshot, byte for byte as before.
`metrics.captureSeconds` and `metrics.renderSeconds` report the two costs, and `metrics.videoEncoder` is `browser-h264`, `h264_nvenc` or `libx264`. On the 4,488 frame film at 1280 by 720 on an RTX 3060 (loaded machine, one evening), in-page encoding took 20.6 s in all with 2.2 ms a frame of capture and 2.0 ms of draw, screenshots took 139.6 s (25.1 ms a frame of capture) and reading raw pixels over a WebSocket took 405.1 s (84.8 ms a frame), so pixels never travel to Node.
The render backend can use GPU or CPU. Memory limits can reduce the actual output dimensions.
Results report actual dimensions and measured timings. They do not embed video bytes.

Release `0.8.0` also samples imported character tracks and can layer them over an independently sampled imported clip.

Release `0.7.0` samples recipe-owned [procedural motion](agent-motion.md) with `settings.motion: { start: 0 }`.
Job frames use `start + elapsed`. Omission holds the initial motion pose.
Nonlooping samples must fit the motion duration. Looping samples wrap and remain bounded by 3600 absolute seconds.

Creation and edits author tracks through scene recipes and `set-motion`, before job submission.
Static recipes remain static unless a shader uses renderer time.
Imported clips retain separate absolute sampling through `settings.animation`.

## Timeline, audio and encoder

A recipe `timeline` plays shots one after another over the recipe's motion clock. It is small on purpose: the video sequence
editor is a non-goal of the engine (`docs/goal.md`), so there are no layers, overlaps, trimming or crossfades. Shots cut, or dip through black.

```json
{ "timeline": { "shots": [
  { "name": "wide", "duration": 20, "camera": { "eye": [0, 3, 14], "target": [0, 0, 0] } },
  { "name": "close", "duration": 20, "motionStart": 1, "camera": { "eye": [0, 0.6, 2.4], "fov": 50 } },
  { "name": "dusk", "duration": 20, "dip": 1 }
] } }
```

| Shot field | Meaning |
| --- | --- |
| `name` | 1 to 24 letters, digits, `-` or `_`, unique. Job metrics list shots by name with their start second. |
| `duration` | 0.1 to 30 s. The timeline holds up to 64 shots and 60 s. |
| `motionStart` | Second of the motion clock the shot starts at. Omitted, the shot reads the motion at its place on the timeline, so a non-looping motion must cover it. Only for recipes with motion, physics or cloth. |
| `camera` | A partial camera (`eye`, `target`, `up`, `fov`, `near`, `far`) on top of the sampled camera. Omitted, the shot keeps the camera of the motion tracks. |
| `focusDistance`, `blur` | Depth of field for this shot: focus distance 0.01 to 100000 m and blur 0 to 1. Each is optional and replaces the recipe `effects.depthOfField` value for the shot only, so a close-up can pull focus without a global setting. A seek into a shot gives the same bytes as the frame in a sequence. |
| `dip` | 0.05 to 4 s. The previous shot fades to black over the first half and this one fades up over the second half. |

`set-timeline` edits the section and `null` removes it. A job renders it with `settings.timeline: { start }` (default 0) for kind `image`, `stills` or `video`.
`duration` defaults to the rest of the timeline. The timeline owns the motion clock, so `motion` and `animation` settings are rejected, and the renderer clock reads timeline time.
Imported assets have no timeline.

A frame depends only on its timeline time and keeps no state, so a seek to any time gives the same pixels as that frame inside a video or stills run.
Videos are capped at 60 s and 900 frames, so a 60 s video needs 15 fps or less.

**Audio.** Start the server with `--audio <absolute folder>` and pass `settings.audio: { file, offset }` on a video job.
`file` is a plain name in that folder ending in `.wav`, `.mp3`, `.ogg` or `.flac` (no path, drive or protocol syntax); the file must be a regular file of up to 32 MiB without links.
`offset` starts the sound that many seconds into the file. The sound is resampled to 48 kHz and encoded as AAC.
A job whose file is shorter than the video after its offset fails before rendering. After encoding, the job decodes both streams of the MP4 and reports `metrics.sync`
(`videoSeconds`, `audioSeconds`, `differenceSeconds`); a difference over 50 ms fails the job.
ffmpeg only receives the resolved path with `-protocol_whitelist file`; no URL, argument or output path comes from the agent.

**Joining parts.** A film longer than one job (60 s, 900 frames) is rendered as several video jobs. Do not join AAC parts: each carries encoder priming and padding, which leaves a dropout of about 5 ms at every join (issue #389).
Give every part `audio: { file, offset, track: 'pcm' }` (`offset` = the part's start in the sound), which writes lossless audio with no priming. Then copy the video of the parts and lay the sound once:

```
ffmpeg -f concat -safe 0 -i parts.txt -c copy joined.mp4
ffmpeg -i joined.mp4 -map 0:v -map 0:a -c:v copy -c:a aac -b:a 192k film.mp4
```

Or skip the sound in the parts' join and lay the source file instead: `ffmpeg -i joined.mp4 -i score.wav -map 0:v -map 1:a -c:v copy -c:a aac -shortest film.mp4`.

**Encoder.** `settings.encoder` is `cpu` (libx264, default) or `nvenc` (h264_nvenc). A machine without NVENC fails the job with the ffmpeg error and never falls back.

`npm run smoke:film-timeline` proves it through MCP on SwiftShader (`cpu` backend): 9 PNG seeks over 8 stills across three shots and a dip are identical to the byte,
and a click placed on a cut in a WAV lands on the decoded cut frame within a frame. `FILM_SECONDS=60` renders the 60 s case.

## Render passes

`image` and `stills` jobs accept `settings.passes`, a list of `albedo`, `normal`, `emission`, `depth`, `objectId`, `diffuse`, `glossy`, `shadow`, `ao`, `mist`, `position`, `velocity`, `uv`, `transmission`, `volume`, `environment`, `cryptomatte`, `aov` and `wireframe`.
Each frame writes its lit image and then one PNG per pass: `render.png` and `render-<pass>.png` for an image, `frame-N.png` and `frame-N-<pass>.png` for stills.
Passes are raw data at the lit image's size: no tone mapping, grading, bloom, depth of field or antialiasing, so values stay exact at silhouettes.
Only opaque and cutout geometry appears. Liquid, foam and blended parts, the sky and the environment background do not.

| Pass | Pixel value |
| --- | --- |
| `albedo` | Base colour after maps and vertex colour, as stored |
| `normal` | World-space normal after normal maps, `normal * 0.5 + 0.5` |
| `emission` | Emissive colour times strength, clamped to 1 |
| `depth` | Metres from the camera over 100 m as a 16-bit value, high byte in red and low byte in green. Background is `255, 255, 0` |
| `objectId` | 24-bit ID, low byte in red, then green, then blue. Zero is background |
| `diffuse` | Linear diffuse light (every light, sky and bounce) times exposure, before fog and without emission. Background 0 |
| `glossy` | Linear specular light (each light's lobe and the sky reflection) times exposure, before fog. Background 0 |
| `shadow` | Sun shadow visibility, 1 lit and 0 shadowed. Background 1 |
| `ao` | Ambient occlusion the shader applies (occlusion map, vertex sky visibility, room term). Background 1 |
| `mist` | Fog amount `1 - exp(-distance * fogDensity)`. Background 1 |
| `position` | World-space XYZ in metres (float in `exr`, mapped over `±100 m` into `0..1` in `png` and `png16`). Background 0 |
| `velocity` | Screen-space motion vector `(dx, dy)` in normalized screen coordinates from camera and object motion (signed in `exr`, `vel * 0.5 + 0.5` in `png` and `png16`). Background 0 |
| `uv` | Primary texture coordinate `(U, V)` in red and green (`U, V` channels in `exr`). Background 0 |
| `transmission` | Transmitted light for materials with `transmission > 0`, scaled by `transmissionMap`. Background 0 |
| `volume` | Volumetric / fog scattering contribution along the view ray. Background 0 |
| `environment` | Image-based / sky environment lighting contribution times exposure. Background 0 |
| `cryptomatte` | Deterministic float hash per object in red, per material in green and coverage `1` in blue (`metrics.cryptomatte` holds the `{ objects, materials }` manifest). Background 0 |
| `aov` | Custom material AOV from `material.aov` (`0..1` scalar or RGB) and/or a material graph's `aov` output. Background 0 |
| `wireframe` | The `diffuse` surface with every polygon edge drawn over it, for reviewing topology; see below. Background light grey |

### Wireframe pass

The wireframe pass shows the topology of the mesh a part really has, without changing its geometry or vertex count. It draws the polygon edges of each part (a recipe mesh's own quads and n-gons, or the welded, quad-joined view of other geometry, the same view `mesh_inspect` reads), so the diagonals that triangulation adds inside a planar quad are never drawn and a quad reads as a quad. Edges hidden behind a surface stay hidden.

| Edge colour | Meaning | `mesh_inspect` problem |
| --- | --- | --- |
| dark | Regular edge: two faces, wound the same way round it | |
| orange | Boundary edge: one face, an open rim | `boundary-edge` |
| red | Non-manifold edge: three or more faces | `non-manifold-edge` |
| cyan | Flipped edge: two faces that run the same way along it, so one normal points the wrong way | `inconsistent-winding` |
| magenta | Edge of a degenerate (zero-area) face | `degenerate-face` |

Fault edges are drawn about twice as wide as regular ones. An edge with several faults shows the most urgent one: non-manifold, then degenerate, then flipped, then boundary.
The job metrics carry `metrics.wireframe`: `edges` (the count of each kind over the drawn parts), `faultyParts` (up to 20 parts, worst first, each with its fault counts so a coloured edge maps to a node name), `faultyPartsOmitted`, `partsOmitted` and `partsSkipped`, and `truncated`.
Output is bounded: a mesh contributes at most 200,000 edges and a frame at most 1,000,000. Fault edges are kept before regular ones, a part past the frame limit is left out and counted in `partsOmitted`, and a part with no polygon view (every triangle collapses) is counted in `partsSkipped`.
The pass is 8-bit like the others, works with `png16` and `exr` and packs into a `multilayer` EXR. It shows rest geometry: skinning and morph targets are not applied to the edges.

The lighting passes hold linear values above 1, so write them as `exr` (a `png` or `png16` file clamps at 1). They add back to the lit image: `diffuse + glossy + emission * exposure` is the radiance before fog, and with an open world the lit image is that radiance mixed toward the fog colour by `mist`, then tone mapped. `tests/lighting-passes.test.js` checks the sum against the beauty frame (mean difference under 1.5 display levels, under 2% of samples off by more than 4). Not covered: unlit parts, the editor floor, parts that a probe or irradiance grid changes after the sky term, and anything the lit image adds after the shader (bloom, grading, depth of field).

`scene_render_result` metrics carry `objectNames`, the part name for ID 1, 2 and so on (the first 1000, with `objectNamesTruncated`), and `depthRangeMetres`.
IDs follow draw order, which groups parts by shared geometry, so read the names list and not node order.
Videos hold the lit image only.

A seek to any frame gives the same pixels: a job samples each frame from its time and keeps no state between frames.
`npm run smoke:render-passes` proves it through MCP: it renders eight stills with every pass, then renders frame 3 again as an image in a different order of seeks and compares the bytes of the lit image and all five passes.

## Output options: transparent, 16-bit PNG, EXR, region and 60 fps

Four optional settings, each off by default. A job without them writes the same bytes as before.

| Setting | Meaning |
| --- | --- |
| `transparent: true` | `image` and `stills`: the lit image keeps alpha (a PNG of colour type 6). The sky, the environment background and the automatic ground are not drawn, so give the scene its own ground or a `shadowCatcher` node (see `renderFlags` in `scene_capabilities`). Volume fog is refused. Passes ignore it. |
| `format` | `image` and `stills`: `png` (8-bit, default), `png16` or `exr`. The lit image is drawn into a half-float target and read back, so the file holds the same graded display colour as the 8-bit PNG (within one 8-bit step) with 16-bit steps. |
| `multilayer: true` | With `format: "exr"` and `passes`: writes one OpenEXR file per frame (`render.exr` or `frame-N.exr`) containing `Combined.R/G/B(/A)` and `<pass>.<channel>` for every requested pass (`depth.Z`, `objectId.id`, `position.X/Y/Z`, `velocity.X/Y`, `uv.U/V`, `<pass>.R/G/B`). |
| `region: { x, y, width, height }` | Pixels from the top left, each side at least 16. The frame is rendered whole and the crop is kept, so the look is the same as the full frame. Works for `image`, `stills` and `video` (a video region has even sides). Not with `renderer`. |
| `fps` | Up to 60 for video, within the 900 frame limit. |

`png16` writes `render.png` (RGB, or RGBA with `transparent`; alpha is straight) and one PNG per pass. A depth pass is a 16-bit gray PNG holding the raw step 0 to 65535 over 100 m, an `objectId` pass is a 16-bit gray PNG of the ID (a scene with more than 65535 objects fails: use `exr`), and `albedo`, `normal` and `emission` are 16-bit RGB with the same values as the 8-bit pass.
`exr` writes `render.exr` (half-float R, G, B and A when transparent; alpha stays premultiplied) and `render-<pass>.exr`. `depth` is one float32 channel `Z` in metres (the far limit, 100, is background), `objectId` one float32 channel `id` (0 is background), and `albedo`, `normal` and `emission` are half-float RGB. Files use ZIP compression and open in Blender, Nuke and OpenEXR tools.
Passes in these formats are drawn into half-float targets, so albedo, normal and emission carry half-float precision, not the 8 bits of the default passes.
The path tracer writes an 8-bit PNG of the whole frame: `transparent`, `format` and `region` are refused with `renderer`. H.264 has no alpha, so `transparent` and `format` are refused for video. 16-bit and EXR output need `EXT_color_buffer_float`; without it the job fails with a message that says to use `png`.
A `png16` or `exr` frame is up to four times the 8-bit frame limit (48 MiB). A region with the browser H.264 encoder (`encoder: "nvenc"`) uses screenshot frames instead.

## Path tracer

An `image`, `stills` or `video` job can ask for the offline [path tracer](https://github.com/codepawl/crucible/blob/main/docs/path-tracer.md) with `settings.renderer`:

```json
{ "kind": "image", "width": 960, "height": 540,
  "renderer": { "type": "pathTracer", "backend": "gpu", "samples": 64, "bounces": 8, "denoise": true, "seed": 0, "maxSeconds": 120 } }
```

Every field after `type` is optional. `backend` is `cpu` (the default, byte-identical on SwiftShader smokes), `gpu`, which traces in a WebGL2 shader and needs a runtime started on the GPU backend (a `--backend cpu` runtime refuses it), or `native`, which traces on hardware ray queries (Vulkan) through the optional `@codepawlhq/cook` package. A native job exports the scene from the job page, traces it in the job runner with the Cycles-matching kernel (`JS67_NATIVE_KERNEL=legacy` keeps the older one), then denoises (OIDN runs on a device kept alive between frames when the OIDN library is installed, so only the first frame pays for the device and the filter commit; `metrics.pathTracer.oidnMode` says `in-process` or `cli`) and writes the PNG as the other backends do: `denoise: true` means OIDN with the albedo and normal guides when `@codepawlhq/crucible-denoise-oidn` and its binary are installed, else (or when OIDN fails) the GPU a-trous filter of the native tracer with a note in `metrics.pathTracer.denoiserNote` (`denoiser: "atrous"`; it is biased, it smooths; `denoise: "wavelet"` asks for the CPU filter). The report carries `kernel` and `averageSamples`. The Cycles-matching kernel takes up to 4,000,000 unique triangles (copies of a shared mesh count once, and the scene may hold four times that with every copy counted); the job reads the scene from its page in chunks, so the size of one message does not bound it; the `cpu` and `gpu` backends and the older kernel keep 400,000. A larger scene is refused with an error that names the limit. On the Cycles-matching kernel the job sends each material whole (FORMAT-v2 tables, instanced or not): blend opacity (`alphaMode: "blend"` with `opacity` below 1), sheen, `specular` and `specularColor`, anisotropy, iridescence, attenuation, and the clearcoat, transmission, sheen, anisotropy and coat normal maps all reach the kernel, and `metrics.pathTracer.ignored` lists only what it does not shade (the legacy kernel keeps the v1 tables and the old notes). A scene whose materials cannot be exported whole is traced from the v1 tables for that frame with the reason in `materialsReason`; the native tracer stays usable. It never fails for lack of the package: without it, without its built binary or without a Vulkan ray query adapter the job runs on `gpu` (`cpu` on a cpu runtime) and `metrics.pathTracer.backendNote` says why; `metrics.pathTracer.backend` always names what ran. The look up costs one import and is cached per process. Native traces volume fog and subsurface scattering with the same walk as the WebGPU megakernel, honours `maxSeconds`, and honours `noiseThreshold` on the GPU (after 16 samples, and then every 8, a converged pixel draws no more; `report.averageSamples` is the mean a pixel drew). The `gpu` fallback ignores `noiseThreshold`. The report in `metrics.pathTracer` names the `backend` that ran, the `gpu`, `gpuCompileSeconds` and `gpuKernelCompiles`. A `stills` or `video` job traces every frame with the same options: the kernel compiles once per job page and each frame reuses it, so a film shows `gpuKernelCompiles: 1`. A native `stills` or `video` job (the Cycles-matching kernel) also keeps one native session for the whole job: a frame that only moves the camera reuses the uploaded scene, the compiled kernel and the acceleration structures; changed materials, lights or instance transforms are sent to the session; a frame whose counts, geometry, textures or environment changed gets a new session, and a failed session update or render falls back to a new session or a one-shot trace for that frame. `metrics.pathTracer.nativeSession` says which one each frame took (`path` is `new-session`, `reused`, `updated` or `one-shot`, with `reason`, `changedTables`, `pipelineReused` and `accelerationReused`); `metrics.nativeSessionRoutes` lists the `path` of every frame. A job reuses the session only when the tables the page exports are equal to the previous frame's apart from the camera (`reused`), or differ in material values, lights or instance transforms only (`updated`). Anything that rebuilds geometry from the time, such as particle systems (sparks, swaying hair), a moved node in a scene exported as flattened triangles, or a changed emissive triangle count, gives every frame a new session, which costs what a one-shot trace costs and is byte-identical to it; `reason` names the first table that differed. A single-frame job and `JS67_NATIVE_KERNEL=legacy` trace one-shot and carry no `nativeSession`; `JS67_NATIVE_SESSIONS=off` in the server's environment traces every frame one-shot (default on). The session is closed when the job ends or fails, and every frame of a stills job equals the one-shot render byte for byte. A native video also blends its frames over time, so the noise the denoiser leaves does not shimmer from frame to frame: each pixel finds where its surface point was in the frame before (from the first-hit distance and the two cameras) and the filtered light is averaged with what was gathered there. A pixel whose surface was hidden, off screen, another surface or seen from a direction more than about 6 degrees away in the frame before starts again, so a cut to another view starts again too, and the whole image starts again at a new shot of a `timeline` and on any frame whose scene, light or render settings changed (its route is not `reused`), so a video with moving parts or lights, or a dip through black, gets no blending on those frames. Each frame of such a video traces with its own seed (`seed` plus the frame number), and `metrics.pathTracer.temporal` reports `historyShare` (the share of pixels that found their history, from the last frame) with `restarted` saying why an image started again. The blend assumes a still scene under a moving camera: light that depends on the view (a sharp reflection, a highlight, the view through glass) trails the camera by a few frames, and an orthographic camera is not blended. `JS67_NATIVE_TEMPORAL=off` in the server's environment turns the blending off, which makes every video frame equal its one-shot render again. A video of traced frames goes through the ffmpeg encoder (the browser H.264 encoder has no drawn frame to read), `maxSeconds` limits each frame, and the job deadline is `maxSeconds` times the frame count plus 60 seconds, up to the job ceiling. Limits: `samples` 1 to 1024, `bounces` 1 to 16, `seed` 0 to 2147483647, `maxSeconds` 1 to 600 (the job's deadline is `maxSeconds` plus 60 seconds; a 1920 by 1080 still of a 180,000 triangle room at 64 samples took 246 s, so give a large still `maxSeconds` 600). `passes` are refused with it, because the tracer has no object ID, depth or normal pass; part findings (framing, floating, intersecting, textures, z-fighting) still reach `metrics.diagnostics` from the first frame, with a `findings-unavailable` entry saying that exposure findings are not available on a traced job (see [mcp.md](mcp.md)). The tracer loads in the job page on demand, uses eight threads at below-normal priority, stops pixels that have converged (`report.averageSamples`), and writes `render.png`; `scene_render_result` metrics carry `pathTracer` with the samples, threads, seconds and what the scene asked for that was not drawn. The same recipe and seed give the same PNG on the cpu and gpu backends; the native Cycles-matching kernel is not always byte-identical between runs (on the demo room at 960 by 540 and 256 samples two jobs differed in a few bytes; a 480 by 270 job with OIDN did not). A job that passes `maxSeconds` fails and writes no image.

## Controller API

This module provides persistent job records around a trusted render callback.
It does not launch a browser, sample animation, encode video, or register MCP tools.
The runtime integration owns those operations.

The controller accepts one active job and rejects additional submissions until that job settles.
It copies the recipe, clip metadata, settings, and asset Buffer before asynchronous admission begins.
Asset recipes must bind their copied bytes through the recipe's SHA-256 `assetId`.
The controller never modifies the source scene or its revision.

## API

```js
import { createAgentRenderJobs } from '../scripts/agent-render-jobs.mjs';

const jobs = await createAgentRenderJobs({
  root: absoluteJobDirectory,
  run: async ({ jobId, directory, snapshot, settings, signal, progress }) => {
    // The runner writes render.mp4.partial inside directory.
    // It checks signal and stops its owned browser and encoder on abort.
    await progress({ frames: settings.frameCount, maximumPendingFrames: 1 });
    return {
      artifacts: [{
        temporary: 'render.mp4.partial',
        filename: 'render.mp4',
        mimeType: 'video/mp4',
      }],
      metrics: { maximumPendingFrames: 1 },
    };
  },
});

const submitted = await jobs.submit({
  sourceRevision: 7,
  snapshot: {
    recipe: canonicalRecipe,
    assetBytes: immutableAssetBuffer,
    clips: [{ duration: 5 }],
  },
  settings: {
    kind: 'video', width: 640, height: 360,
    fps: 24, duration: 3,
    animation: { clip: 0, start: 1 },
    rendererTime: { start: 0, rate: 1 },
  },
});

const status = jobs.status(submitted.jobId);
const acknowledgement = jobs.cancel(submitted.jobId);
await jobs.close();
```

| Method | Result |
| --- | --- |
| `submit(input)` | Promise of a queued job record after snapshot persistence |
| `status(jobId)` | Detached current record |
| `list()` | Detached retained records, including recovered jobs |
| `cancel(jobId)` | Immediate record with `cancelling`, or an existing terminal state |
| `result(jobId)` | Completed artifact metadata and metrics without arbitrary paths |
| `release(jobId)` | Promise of release confirmation for a settled terminal job |
| `close()` | Promise that aborts work, waits for settlement, and releases store ownership |

`settings.frameCount` contains 1 for images, 8 for stills, or `ceil(duration * fps)` for video.
The defaults are 24 fps and one second.
Images sample `animation.start` without requiring the default duration to fit the clip.
Stills and videos require the entire requested animation range to fit the selected clip.
Renderer time defaults to `{ start: 0, rate: 1 }` and remains separate from animation sampling.

`progress(update)` accepts monotonic `frames` and a `maximumPendingFrames` value of zero or one.
It returns a Promise for the corresponding status write.
Runner metrics must contain finite JSON within 64 KiB.

## Runner ownership

| Kind | Required output names | MIME type |
| --- | --- | --- |
| `image` | `render.png.partial` | `image/png` |
| `stills` | `frame-0.png.partial` through `frame-7.png.partial` | `image/png` |
| `video` | `render.mp4.partial` | `video/mp4` |

The runner returns every required artifact with its temporary filename, final filename, and MIME type.
Final filenames omit `.partial`.
The controller checks names, regular-file ownership, byte limits, and SHA-256 hashes before publication.
It hashes through a stream rather than loading the complete video into memory.
It renames outputs only after callback success and cancellation checks.
The completed result becomes visible after its status record persists.

The runner must enforce capture memory limits, frame byte limits, and encoder backpressure during execution.
The controller checks PNG artifact sizes and completed MP4 sizes.
It cannot measure transient video frame buffers or prevent an arbitrary callback from writing excess bytes before returning.
The runner must write only the documented partial files inside its assigned directory.

## States and cancellation

Normal execution follows `queued`, `running`, `finalizing`, and `completed`.
Cancellation follows `cancelling` and `cancelled` after the callback settles.
Deadline expiration aborts the callback and ends with `failed` after settlement.
Callback errors and output validation failures also produce `failed`.
Unfinished records from an earlier process become `interrupted` during recovery.
Recovery does not restart rendering.

`cancel()` aborts the signal immediately and does not wait behind rendering or disk persistence.
The runner must interrupt capture, encoder drain, and encoder finalization waits when aborted.
`close()` waits at most five seconds for a cancelled callback to settle.
If the callback remains active, `close()` rejects and keeps the store locked.
A later `close()` can release the lock after the callback settles.
An in-process controller cannot force an arbitrary callback to stop.

## Persistence and limits

The root must be an explicit absolute directory.
A store marker and exclusive process lock distinguish owned job storage from foreign files.
Each UUID directory contains an ownership marker, JSON snapshot, status record, and optional `asset.glb`.

Admission writes those files in a reserved `.pending-<storeId>-<jobId>` directory before renaming it to the published UUID.
No active job exists until that rename succeeds.
Interrupted or failed admissions remain quarantined, count toward the byte budget, and do not become jobs.
Reopening preserves their files, including malformed JSON and foreign regular files, so older completed results remain accessible.
Only verified empty pending directories are removed automatically.

The controller rejects links, file aliases, unknown filenames, foreign directories, and persisted path traversal.
It verifies completed artifact hashes when reopening a store.
It removes files individually during release, without recursive deletion.

The lock protects cooperating controller processes.
The filesystem must remain private to the owner while jobs run.
It does not isolate an arbitrary callback or hostile concurrent filesystem writer.

Malformed published job records require repair before the controller can reopen the store.
Quarantined admissions need explicit inspection and cleanup to reclaim their space.
Their directories must contain regular files without links or aliases. Other entry types require repair.

A client that closes the connection waits about two seconds before it kills the server, and a killed server leaves `store.lock` behind.
The next controller takes over a lock when the file is well formed and its process ID belongs to no running process. Only one process can take over a given dead lock: it first creates a claim file `store.lock.claim-<token>`, re-reads the lock under that claim, and removes the lock only if it still holds the dead token, then creates its own. Locks and claims are written to a temporary file and linked into place, so they never exist empty or half written; a lock that still does not parse is treated as owned by a live starter. If the lock changed under the claim, the start begins again once. A process killed while it holds a claim leaves the claim behind, which blocks the takeover of that one lock; the next start names the exact `store.lock.claim-<token>` file to delete, and does the same for a claim it cannot read.
A lock whose process is alive, or a file that is not a recognized lock, is still refused. The operating system can hand a dead owner's process ID to an unrelated process; that lock looks alive and stays until a person confirms nothing owns the dedicated private store and removes `store.lock`.

A render or review job fails when its Node RSS passes 512 MiB or its browser heap passes 256 MiB. After each frame the browser heap is read, and when it is over the limit it is garbage collected and read again, so only memory the page still holds counts. A physics bake leaves tens of MiB of garbage after its first frame; a real leak survives the collection and still stops the job.

| Budget | Default |
| --- | --- |
| Retained records | 32 |
| Total store bytes | 512 MiB |
| Combined output bytes per job | 128 MiB |
| PNG artifact bytes | 12 MiB each (a 1920x1080 frame); 48 MiB each for `png16` and `exr` |
| Snapshot JSON | 1 MiB |
| Asset bytes | 64 MiB |
| Dimensions | 64 to 1920 pixels each, at most 1920x1080 pixels in all (1080x1920 fits) |
| Video frame rate | 1 to 60 fps |
| Duration | 0.1 to 60 seconds |
| Maximum video frames | 900 |
| Still frames | 8 |
| Job elapsed deadline | 60 seconds plus 2 seconds per frame, multiplied for frames larger than 1024x576 (360 frames at 1024x576 get 13 minutes), never more than 30 minutes |
| Video encoder drain and finalization | 30 seconds each |
| Close settlement deadline | Five seconds |

The controller rejects odd MP4 dimensions.
Admission reserves the maximum output budget plus snapshot and metadata space.
The optional `limits` object can reduce controller budgets for bounded tests.
It cannot increase production limits.
Partial files count toward the store budget and remain until explicit release.

## CPU checks

1. Run `node --test tests/agent-render-jobs.test.js`.

The tests use actual temporary files and controlled callbacks.
They cover snapshots, persistence, hashes, cancellation, deadlines, restart recovery, quotas, path rejection, and file aliases.
The tests do not run browsers, ffmpeg, or GPU rendering.

A recipe whose only moving content is `physics`, `cloth` or `particles` takes the same `motion` setting: the job plays the bake on the motion clock, with no authored motion and no `bake-motion` step (so the 32 node cap does not apply). A video without `duration` runs as long as the bake, counted from `motion.start`, and a longer one is rejected. A recipe with nothing that moves fails with an error that lists authored motion, physics, cloth, particles, placed clips and map sequences as the accepted sources.

The camera does not move with the bake. A recipe `camera` (`eye`, `target`, lens) is the same on every frame of a physics, cloth or particle film, so shards flying out of frame do not pull the view. Nothing frames the scene by its bounds: only an authored `camera` motion track or a timeline shot changes the camera. Set `camera.eye` and `camera.target` for a locked shot; left out, the default camera is used, also locked. `tests/physics-film.test.js` checks that a static marker stays on the same pixels from the first frame to the last.
