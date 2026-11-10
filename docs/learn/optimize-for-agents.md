# Optimise agent runs

This page shows how to make an agent finish a 67js task with fewer tool calls, fewer tokens and less waiting. Each number says how it was obtained. Tool sizes were measured on 2026-11-07 with `node scripts/measure-tool-cost.mjs` in a source checkout of 0.15.0. Timings come from one machine under normal load, so read them as ranges.

## Where the tokens go

An agent pays for three things: the tool list, the results of its calls, and the pictures that it reads.

**The tool list.** The harness sends every tool's name, description and input schema to the model. The 24 tools total 70,401 bytes, about 20,100 tokens (measured 2026-11-10 on the game branch after the schema diet; it was 196,826 bytes before). A tool lists its common fields and one line naming the rest, and every call is still checked against the full schema. `scene_capabilities` with a `topic` gives the field list of one recipe part. Three tools make up most of it:

| Tool | Schema size | Estimated tokens |
| --- | --- | --- |
| `scene_apply` | 19,964 B | 5,704 |
| `scene_create` | 12,135 B | 3,468 |
| `scene_create_asset` | 8,597 B | 2,457 |
| `mesh_edit` | 2,558 B | 731 |
| `mesh_stack` | 1,920 B | 549 |
| The other 18 tools | 20,603 B | 5,885 |

Claude Code loads tool schemas on demand through tool search by default, so it pays this cost only for the tools that a task uses. Other harnesses can send the whole list on every turn. If your harness does that, cut the list to the tools that your task needs:

```toml
[mcp_servers.67js-scene]
command = "npx"
args = ["-y", "--package", "@codepawlhq/67js", "67js-mcp", "--backend", "gpu"]
disabled_tools = ["mesh_edit", "mesh_stack", "mesh_inspect", "scene_create_asset", "scene_asset_catalog"]
```

This is Codex syntax. Gemini CLI uses `"excludeTools": [...]` in the server entry. Dropping these five tools saves about 4,200 estimated tokens of schema, and the agent can no longer edit meshes or import GLB files. Keep them when the task needs them.

**The results.** Most results are small. These sizes are from the same measurement:

| Result | Size | Estimated tokens |
| --- | --- | --- |
| `scene_capabilities` (no topic) | 1,347 B | 385 |
| `scene_export_recipe` | 2,664 B | 762 |
| `mesh_edit` | 2,009 B | 574 |
| `scene_create` | 1,176 B | 336 |
| `scene_inspect` | 1,123 B | 321 |

Without a topic `scene_capabilities` is a short index; a topic such as `motion` or `environment` answers with the fields of that recipe part, from a few hundred bytes to about 11,000 for `motion`. Ask for a topic only when the task needs it. A scene with more nodes gives a longer node list in `scene_create` and `scene_apply`. `scene_inspect` takes `ids` and `limit` to read only some nodes.

**The pictures.** A picture is the largest single result. See the next section.

## Choose preview or final quality

Use small pictures to decide and a render job to deliver. Claude counts an image as `ceil(width / 28) × ceil(height / 28)` tokens, according to [Anthropic's vision documentation](https://platform.claude.com/docs/en/build-with-claude/vision), read on 2026-11-07. Other models count differently, and that was not measured. For `scene_look`, the formula gives these estimates:

| Size | Tokens | Use for |
| --- | --- | --- |
| 256 by 160 | 60 | Checking that a part exists and where it is. |
| 512 by 320 | 228 | Most checks. This is the size used in the examples. |
| 768 by 512 | 532 | The default. Checking proportions and light. |
| 1024 by 1024 | 1,369 | The largest preview. Checking fine detail. |

Rules that follow from this:

- Ask for a small `width` and `height` in the first prompt, for example "preview at 512 by 320".
- Ask for a larger picture only when a detail is unclear. Then use `scene_look` with a smaller camera distance, not a bigger image.
- Use one `scene_review` for several views. It returns one labeled grid of up to four shots, so the agent pays for one picture and one call. Each shot is at most 480 pixels on a side.
- Do the final render as a job. `scene_render_result` returns a file path and a hash, not the image. The picture enters the context only when the agent opens the file. A 1920 by 1080 final that the agent never opens costs no image tokens.
- A PNG over 1 MiB returns an error. Ask for a smaller preview.

## Fewer calls for the same work

Every call is a turn. These habits remove turns:

- **Batch edits.** One `scene_apply` takes up to 256 operations. Adding four legs in one call took one call and 49 ms in the local test. A call for each leg takes four.
- **Read the answer, not the scene.** `scene_apply` returns the revision, the render status, a result for each operation and a diff of the IDs it changed. Call `scene_inspect` only when you need node bounds or counts.
- **Edit, do not rewrite.** A small mesh change as a `mesh_edit` call is 187 bytes. The same change as a new `scene_create` is 1,202 bytes, plus 52 bytes to dispose the old scene. The gap grows with the size of the scene.
- **Leave out `sessionId`.** One scene exists at a time. Every tool uses the active scene when the field is missing.
- **Send the right revision.** A stale `expectedRevision` costs a failed call and a retry. Pass the `revision` from the last result.
- **Compare variants with branches.** `scene_apply` with a `branch` name tries a change without touching the scene. One `scene_review` compares up to four branches. `scene_restore` with the winning `branch` keeps it.
- **Checkpoint before a risky edit.** `scene_checkpoint` and `scene_restore` return to a good state in two calls. Rebuilding a scene takes many.

## Read results as numbers

A picture costs tokens and an agent can misread it. The text results hold facts that cost far less:

- `scene_inspect` returns the bounds, the node counts and the revision. The agent can check that a part rests on the ground or sits in the middle without a picture.
- `mesh_inspect` returns lint with a fix for each problem, such as `floating-part` and `thin-wall`.
- `scene_look` with `labels: true` returns the pixel position of each named part. The agent finds the part to fix.
- `committed` and `renderSucceeded` in an edit result say whether the edit stuck and drew.

Ask the agent to check these numbers first and to take a picture only when the numbers pass. The [agent modeling suite](https://github.com/codepawl/67.js/tree/main/bench/agent-modeling) grades the same way: it reads bounds, connected parts and holes from the exported recipe and never looks at the picture.

## Keep the state in the server

The scene lives in the server process. The agent does not resend it on each call.

- **Do not resend the recipe.** After `scene_create`, send only operations. A recipe can be up to 1 MiB of JSON.
- **Save the recipe.** `scene_export_recipe` returns the canonical recipe, 2,664 bytes in the measured case. Ask the agent to save it to a file after each good step. A server restart loses the active scene, and the recipe is how the agent rebuilds it.
- **Keep the tool list stable.** A harness that caches the start of the prompt can reuse the cache only while the tool list stays the same. Do not switch the server on and off during a session. This is an inference that was not measured.
- **Dispose before a new scene.** One scene is active at a time. `scene_dispose` frees its memory before `scene_create` starts the next.

## Speed

These timings are from one local run with the `cpu` backend, which uses a software renderer. `--backend gpu` is faster on a machine with a graphics card.

| Step | Time |
| --- | --- |
| `scene_create`, the first call, including starting Chrome | 1,241 ms |
| `scene_look`, 512 by 320 | 208 ms |
| `scene_look` with labels | 321 ms |
| `scene_apply`, four legs | 49 ms |
| Image job, 640 by 400, from submit to completed | 1.1 s |

Chrome starts only on the first scene call, so a harness that connects and never builds a scene pays nothing. The default `--memory 192` fits a 1920 by 1080 frame of an empty scene, which needs about 175 MiB. Raise it to 256 for textured scenes.

## What agents achieve

The repository has a suite that measures how an agent models through these tools. Each task runs in a fresh Claude Code session that has only the 67js tools. The numbers below are from the run of 2026-11-04. It used 5 tasks (crate, bolt, window, table, mug), 2 runs each, and the `cpu` backend.

| Model | Runs passed | Mean tool calls | Mean turns |
| --- | --- | --- | --- |
| Haiku | 10 of 10 | 7 | 9 |
| Sonnet | 9 of 10 | 3.2 | 5.3 |

The stronger model used less than half the calls. The one failure was the crate on Sonnet, 1 of 2. Per task, the mean tool calls were:

| Task | Haiku | Sonnet |
| --- | --- | --- |
| crate | 6.5 | 2 |
| bolt | 11 | 2 |
| window | 6 | 3.5 |
| table | 5.5 | 2 |
| mug | 6 | 6.5 |

The same suite has a no-MCP task. The agent has only [`llms.txt`](/llms.txt) and the installed package, and it must write a script that renders a red sphere to a 512 pixel PNG. On 2026-11-04, both models passed 2 of 2. Haiku used 14 tool calls on average and Sonnet 10.5. This task is different from the five above, so the numbers are not a direct comparison. They show that the no-MCP path works and that it needs about 10 to 14 calls for one picture.

Two features did not show a clear gain in these runs. Branches saved 2 of 17 calls for Haiku and none for Sonnet in a best-of-three task on 2026-11-01. Treat that as noise, because the suite README says a difference of one or two tasks per run is noise. Models other than Claude Haiku and Sonnet were not measured.

## A prompt that applies all of this

```text
Use 67js through MCP. Call scene_capabilities once and do not call it again.
Build the scene with one scene_create. Make every later change as one scene_apply batch.
Preview at 512 by 320 and use scene_review for several views.
Check bounds and lint with scene_inspect and mesh_inspect before you look at a picture.
Checkpoint before each risky edit. Save the recipe with scene_export_recipe after each good step.
For the final file, submit one render job and give me the path.
```
