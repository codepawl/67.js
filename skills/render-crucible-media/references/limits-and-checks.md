# Limits and checks

## Server options (the user sets them, not the job)

| Option | Meaning |
|---|---|
| `--backend gpu` or `cpu` | gpu is the default and fast; cpu is SwiftShader, for machines without hardware WebGL, much slower. |
| `--memory <32..384>` | Render-target budget in MiB, default 192. A 1920x1080 frame needs about 175 MiB at 4 samples (measured), so use 256 for it and more for textured scenes. |
| `--jobs <abs dir>` | Private store for job files. Required for any job. |
| `--ffmpeg <abs path>` | Needed for MP4 when ffmpeg is not on PATH. |
| `--audio <abs dir>` | The folder `settings.audio.file` names a file from. |

`scene_capabilities` reports the backend, memory, job limits and the job UUIDs it holds after a restart. Check it
before you promise a size or a sound track.

## Job limits

- Width and height 64 to 1920 each, within the memory budget. A job that does not fit is reduced; the result reports
  the actual dimensions, so say them.
- Video: at most 60 s and 900 frames (60 s needs 15 fps or less), even dimensions, shots up to 64 and 60 s total.
- Time allowed: 60 s plus 2 s per frame (more above 1024x576), at most 30 minutes. A path traced still has its own
  `maxSeconds`.
- A job leases the single preview renderer: previews and edits pause while it runs, inspection and recipe export stay
  available. Plan one job at a time.

## Check the result

1. `scene_render_result` lists files and SHA-256 hashes. Compare `metrics` frame count and duration with what you asked.
2. Look at one frame: the PNG itself, or for video a still of the same `motion.start` (the timeline seek gives the same
   pixels as the frame inside the video).
3. For video, verify with ffprobe when it is installed:
   `ffprobe -v error -count_frames -show_entries stream=codec_name,width,height,r_frame_rate,nb_read_frames:format=duration,size -of json <file>`.
4. With audio, read `metrics.sync` (`differenceSeconds` under 0.05). It proves alignment, not that the sound is good.
5. For a path-traced film, measure flicker before anyone sees it. A still can look clean while the film shimmers: OIDN
   leaves slow blotches that change every frame. Take one second of frames and compute the mean absolute temporal
   second difference `|f[t+1] - 2 f[t] + f[t-1]|` in 8-bit grey. Smooth camera motion cancels in it; noise stays. A
   still-looking film scores about 1. Above 2, fix it before showing anyone: blend each denoised frame into the
   reprojected history of the frames before it (first-hit depth and the two cameras). More samples alone did not fix
   it in a room lit through one window: 1024 spp still scored 2 (An caught it, 2026-11-13).
6. The framebuffer figure is an allocation model, not total VRAM, and Node and browser heap samples do not cover every
   allocation. Report them as estimates.

## Speed

Capture cost dominates video. `metrics.captureSeconds` and `renderSeconds` show where the time went. Hardware
`nvenc` encoding in the page was measured about 7 times faster than screenshots on one RTX 3060 (1280x720, 4,488 frames:
20.6 s against 139.6 s); that is one machine, so measure before you promise a time. Machine load changes timings, so
report a range, not one number.
