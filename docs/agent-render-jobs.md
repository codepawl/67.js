# Render jobs

Release `0.6.0` includes five MCP tools for asynchronous image and video rendering.

## Agent workflow

1. Install `67js` with `npm install 67js@npm:@codepawlhq/67js@0.7.0`.
2. Launch `npx 67js-mcp --backend cpu --jobs C:/projects/my-scene/render-jobs`.
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

`image` and `stills` jobs accept `settings.passes`, a list of `albedo`, `normal`, `emission`, `depth` and `objectId`.
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

`scene_render_result` metrics carry `objectNames`, the part name for ID 1, 2 and so on (the first 1000, with `objectNamesTruncated`), and `depthRangeMetres`.
IDs follow draw order, which groups parts by shared geometry, so read the names list and not node order.
Videos hold the lit image only.

A seek to any frame gives the same pixels: a job samples each frame from its time and keeps no state between frames.
`npm run smoke:render-passes` proves it through MCP: it renders eight stills with every pass, then renders frame 3 again as an image in a different order of seeks and compares the bytes of the lit image and all five passes.

## Path tracer

An `image`, `stills` or `video` job can ask for the offline [path tracer](https://github.com/codepawl/67.js/blob/main/docs/path-tracer.md) with `settings.renderer`:

```json
{ "kind": "image", "width": 960, "height": 540,
  "renderer": { "type": "pathTracer", "backend": "gpu", "samples": 64, "bounces": 8, "denoise": true, "seed": 0, "maxSeconds": 120 } }
```

Every field after `type` is optional. `backend` is `cpu` (the default, byte-identical on SwiftShader smokes) or `gpu`, which traces in a WebGL2 shader and needs a runtime started on the GPU backend (a `--backend cpu` runtime refuses it). The report in `metrics.pathTracer` names the `backend` that ran, the `gpu`, `gpuCompileSeconds` and `gpuKernelCompiles`. A `stills` or `video` job traces every frame with the same options: the kernel compiles once per job page and each frame reuses it, so a film shows `gpuKernelCompiles: 1`. A video of traced frames goes through the ffmpeg encoder (the browser H.264 encoder has no drawn frame to read), `maxSeconds` limits each frame, and the job deadline is `maxSeconds` times the frame count plus 60 seconds, up to the job ceiling. Limits: `samples` 1 to 1024, `bounces` 1 to 16, `seed` 0 to 2147483647, `maxSeconds` 1 to 600 (the job's deadline is `maxSeconds` plus 60 seconds; a 1920 by 1080 still of a 180,000 triangle room at 64 samples took 246 s, so give a large still `maxSeconds` 600). `passes` are refused with it. The tracer loads in the job page on demand, uses eight threads at below-normal priority, stops pixels that have converged (`report.averageSamples`), and writes `render.png`; `scene_render_result` metrics carry `pathTracer` with the samples, threads, seconds and what the scene asked for that was not drawn. The same recipe and seed give the same PNG. A job that passes `maxSeconds` fails and writes no image.

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

The controller never removes a dead process's lock automatically.
After a crash, confirm that no process owns the dedicated private store before manually removing `store.lock`.
This conservative repair step prevents two recovery processes from deleting a newly acquired lock.

| Budget | Default |
| --- | --- |
| Retained records | 32 |
| Total store bytes | 512 MiB |
| Combined output bytes per job | 128 MiB |
| PNG artifact bytes | 12 MiB each (a 1920x1080 frame) |
| Snapshot JSON | 1 MiB |
| Asset bytes | 64 MiB |
| Dimensions | 64 to 1920 pixels each, at most 1920x1080 pixels in all (1080x1920 fits) |
| Video frame rate | 1 to 30 fps |
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
