# Render errors and recovery

A rejected `scene_render_submit` creates no job. A job that fails keeps its record until you release it. Read the
message first: each one names the cause and the next step.

| Sign | Cause | Do |
|---|---|---|
| Submit says render jobs need a job store | The server started without `--jobs`. | Ask the user to restart with `--jobs <abs private dir>`; an agent cannot add it. |
| `expectedRevision must match the current revision.` | The scene changed since you read it. | `scene_inspect`, resubmit with the new revision. |
| Settings rejected as unknown field | A typo, or a field of another tool (for example `time`). | Use the names in `jobs.md`; `scene_render_submit` lists the schema. |
| Video is a still frame | No `motion: { "start": 0 }`. | Add it and resubmit. |
| Sampled time past the motion | A nonlooping motion is shorter than `start + duration`. | Lengthen the motion, set `loop: true` or shorten the job. |
| `motion` or `animation` rejected with `timeline` | The timeline owns the clock. | Send `timeline: { "start": 0 }` only. |
| ffmpeg not found | MP4 needs ffmpeg. | Ask for `--ffmpeg <abs path>` or ffmpeg on PATH; a PNG or stills job does not need it. |
| `nvenc` fails | No NVENC on this machine; there is no fallback. | Resubmit with `encoder: "cpu"`. |
| Audio file not found or too short | `audio.file` is not a plain name in `--audio`, or it ends before the video. | Use a name from that folder and a smaller `offset`. |
| `metrics.sync` difference over 50 ms | Encode drift. | The job fails; resubmit, and report it if it repeats. |
| Path tracer `gpu` refused | The server runs with `--backend cpu`. | Use `backend: "cpu"` or ask for a GPU server. |
| Smaller output than asked | The memory budget reduced it. | Report the actual size; ask for a larger `--memory` if size matters. |
| State `failed` with a time limit | The job passed 60 s plus 2 s per frame. | Lower the size, fps or samples, or split the film into parts. |
| State `interrupted` | The server restarted during the job. | Recovery never restarts rendering; resubmit. |

## Recover

1. `scene_render_cancel` if it is still running, then poll `scene_render_status` until `cancelled`.
2. Preview edits work again once the job is terminal.
3. Fix one setting, resubmit a small version (a still or 2 seconds) and check it before the full job.
4. `scene_render_release` every job you are done with, failed ones too, so the store stays small.
5. If a valid job fails with a graphics error or a crash, stop retrying. File an issue at `codepawl/67.js` with the
   settings, the recipe from `scene_export_recipe` and the `scene_render_result` or status message. No local paths.
