# MCP scene authoring

The `67js-mcp` stdio server is included in npm release `0.5.0` and later.
It uses the maintained MCP TypeScript SDK v2 server and a local browser runtime.
The [official SDK documentation](https://ts.sdk.modelcontextprotocol.io/v2/) describes its transport and protocol APIs.

Release `0.5.0` exposes twelve tools for bounded JSON scene authoring and local GLB imports.
Release `0.6.0` adds five render job tools for PNG images, still sequences and MP4 video.
Release `0.7.0` adds [procedural motion](agent-motion.md), transient preview seeks and motion sampling in snapshot jobs.
Release `0.8.0` adds [imported character motion](agent-character-motion.md) with source joints and independent clip timing.
Release `0.9.0` adds [visual review](agent-review.md) for several labeled views or poses from one isolated snapshot.

To see what changed, including changes not yet released, read `https://67js.codepawl.com/changelog.json`: `released` sections, `unreleased` entries and each entry's issue number and `breaking` flag.

It renders one active scene and returns PNG images through MCP image content.
Tool results also contain JSON text and structured metadata.
The image bytes appear only in the image content block.

## Requirements and launch

The server requires Node.js 20.19 or later and an installed Chrome or Chromium executable.
The npm package contains a prebuilt server and browser preview. A source checkout and Vite are unnecessary.
The browser driver loads when `scene_create` or `scene_create_asset` runs. It does not download a browser.

The runtime serves its bundled scene page on the loopback interface.
The MCP connection uses stdin and stdout, without an HTTP MCP listener.

1. Install the package in your project:

   ```powershell
   npm install 67js@npm:@codepawlhq/67js
   ```

   Run the installed command with `npx 67js-mcp --backend gpu --memory 192`.
   For a standalone launch, use `npx --package @codepawlhq/67js 67js-mcp --backend gpu --memory 192`. Add `@<version>` after the package name to pin one.
   `67js-mcp --help` lists options. `67js-mcp --version` reports the installed version.

2. Configure your MCP client with absolute paths to Node and the installed CLI:

   ```json
   {
     "mcpServers": {
       "67js-scene": {
         "command": "C:/Program Files/nodejs/node.exe",
         "args": [
           "C:/projects/my-scene/node_modules/67js/bin/67js-mcp.mjs",
           "--backend", "gpu",
           "--memory", "192",
           "--browser", "C:/Program Files/Google/Chrome/Application/chrome.exe"
         ]
       }
     }
   }
   ```

The browser path is optional for a standard Google Chrome installation. Pass `--browser` for another Chromium executable.
Using Node directly also avoids shell-specific npm launcher behavior in MCP clients on Windows.
`--backend` accepts `gpu` or `cpu` and defaults to `gpu`.
`--memory` accepts an integer from 32 to 384 MiB and defaults to 192. A 1920x1080 frame needs about 175 MiB of render targets (measured, 4 samples), so the default fits an empty room at that size and 256 leaves room for textures; raise it for textured scenes.

`--assets` selects an absolute directory containing self-contained GLB files.
The asset catalog reads regular files directly inside that directory, with limits of 64 files and 64 MiB per file. One call that places several assets, motion sources and sequence frames sends them to the preview page in one message, so their total is capped at 64 MiB too (`maxCombinedBytes`); a call over it fails with an error that names the limit and the total, and the agent places the rest in later calls. Decoding takes 1,000,000 vertices, 4,096 parts and 1,024 joints at most; `scene_capabilities` reports every number under `assets`. They are lower than the `loadGltf` defaults (256 MiB, 8,000,000 vertices) because the server hands the whole file to the preview page as one base64 string, which crashed the page from 80 MiB in a local Chrome test. A file over a limit fails with an error that names the limit and the value it hit; a larger scene loads through `loadGltf` in code (see [gltf.md](gltf.md)). All limits live in `src/agent-asset-limits.js`.
Asset IDs bind file contents through SHA-256. Changed files require a runtime restart before they receive refreshed IDs.
Catalog imports retain supported textures, skins, morphs and animation clips.
The catalog takes self-contained GLB only. Poly Haven and similar sites ship a glTF folder (`.gltf`, `.bin` and textures): bundle it first with one command, then put the result in the catalog directory: `npx @gltf-transform/cli copy tree_01_1k.gltf tree_01.glb`. A recipe places a catalog asset with an `asset` node field (see [the scene guide](agent-scene.md#placed-catalog-assets)).

These launch options remain outside tool arguments.
The process runs below normal priority to reduce interference with other work.

Stdout contains only MCP protocol messages, while errors go to stderr.
Closing stdin or sending `SIGINT` or `SIGTERM` closes the runtime and releases its browser resources.

## Other clients and models

Every recorded agent run used Claude Code. This table says what was tried elsewhere on 2026-10-31 and what was not.

| Client or check | Result |
|---|---|
| Official MCP SDK client over stdio (`npm run smoke:mcp-package`) | Passes. |
| MCP Inspector CLI 2.13.0 (`npm run smoke:mcp-clients`) | Passes, 2026-11-03, Windows, `--backend cpu`. Lists all 23 tools through `tools/list` in 7 s. `tools/call` of `scene_create` with the lamp recipe succeeds in 10 s. The CLI starts a new server for every command and the scene lives in the server, so it cannot follow with `scene_look`. That call fails with "No scene is active" and returns no image. The preview image is not testable through this CLI. |
| Official MCP Python SDK 2.3.0 (`npm run smoke:mcp-clients`) | Passes, 2026-11-03, Windows, `--backend cpu`. Initialize, `tools/list` (22 tools), `scene_create` and `scene_look` in one session. `scene_look` returns a 20480 byte PNG. 11 s including the first `uv` download. |
| JSON Schema 2020-12 validator with strict mode (Ajv 8), run in `npm test` | Every tool input schema compiles. |
| Tool names and descriptions | Names are 9 to 24 characters from `[a-z_]`, within the 64-character limit OpenAI, Gemini and Anthropic share. No description is over 1024 characters. |
| Cursor, Gemini CLI, Claude Desktop, VS Code, any OpenAI or Gemini model | Not run. No account or client was available. Configure them with the same `command` and `args` as above, which is unverified. |
| Install by `npm install 67js@npm:@codepawlhq/67js`, then `npx 67js-mcp`, or `npx --package @codepawlhq/67js 67js-mcp`, or the absolute path to `bin/67js-mcp.mjs` | All four start and report the version. |

Known gaps, checked by `npm run check:tool-schemas`:

- The schemas declare JSON Schema 2020-12, the MCP default. A client that compiles them with a draft-07 validator rejects them: Ajv in its default draft-07 mode throws on `$schema`, and then on `prefixItems`, which is how fixed-length vectors are written.
- OpenAI `strict: true` function tools would reject them: most properties are optional, objects do not set `additionalProperties: false`, and `oneOf`, `prefixItems` and `propertyNames` are outside the documented subset. A client that sends MCP tools as non-strict functions is unaffected.
- Gemini function declarations document a smaller keyword subset than we use (`const`, `oneOf`, `$ref`, `exclusiveMinimum`). Open-ended records (`select` rules, material graphs, relations) are schemas with no `type`. A client that converts schemas for Gemini needs to inline `$ref` and drop or rewrite those keywords.
- Whether a weaker or non-Anthropic model finds the tools is unmeasured: the agent-modeling suite ran only on Claude Sonnet and Haiku.

## Workflow

1. Call `scene_capabilities` to read supported features and runtime limits.
2. Call `scene_create` with a [scene recipe](agent-scene.md#recipe-contract).
3. Call `scene_inspect` to read node IDs, bounds, counts, and the current revision.
4. Call `scene_checkpoint` before an experiment.
5. Call `scene_apply` with a small batch and the current `expectedRevision`.
6. Call `scene_look` to assess the rendered image.
7. Call `scene_restore` with the current revision if the experiment fails.
8. Call `scene_release_checkpoint` when you no longer need the saved state.
9. To try variants, call `scene_apply` once per variant with a `branch` name (the scene stays as it is), compare them with one `scene_review` that has a `branch` per shot, then call `scene_restore` with the winning `branch` to keep it.
10. Call `scene_export_recipe` to retain the canonical recipe.
11. Call `scene_dispose` to release the scene before creating another one.

`scene_create`, `scene_apply`, and `scene_restore` return the session ID, current revision, inspection, and render status.
`scene_checkpoint` returns a checkpoint UUID scoped to its session UUID.
A restore increments revision and keeps the checkpoint available.
A stale revision or invalid command produces an error without publishing partial edits.
SDK validation rejects unknown tool fields before dispatch.
Backend errors return `isError: true` with a readable message.

Successful apply and restore responses include `committed: true`, the new revision, and `renderSucceeded`.
If rendering fails after the edit commits, the response retains that revision and includes `renderSucceeded: false` and `renderError`.
Its render metadata describes the last successful render, rather than a new frame.
Inspect or export the recipe before retrying. Context loss still permits recipe inspection, export, and disposal.

## Tools

| Tool | Arguments | Result |
| --- | --- | --- |
| `scene_capabilities` | None | Features, limits, and backend information |
| `scene_create` | `recipe` | Session ID, revision, inspection, and render status |
| `scene_asset_catalog` | None | Configured catalog and content-bound GLB IDs |
| `scene_create_asset` | `recipe` using `67js.asset` | Imported scene ID, revision, inspection and render status |
| `scene_inspect` | `sessionId`, optional `ids`, `limit`, `includeBounds` | Compact node records and revision |
| `scene_apply` | `sessionId`, `expectedRevision`, `operations` | Updated revision, inspection, and render status |
| `scene_walkmap` | `sessionId`, `min`, `max`, optional `cellSize`, `clearance`, `groundRange`, `lowerPass`, `includeCells` | Grid rows of `.` walkable, `x` blocked and `#` no surface, with counts; ground height and headroom per cell with `includeCells`. See [scene-query.md](scene-query.md) |
| `mesh_inspect` | `sessionId`, optional `geometries` (up to 16 IDs) | Per geometry: polygon counts, face sizes, parts, face tags, bounds and lint problems with fixes |
| `mesh_edit` | `sessionId`, `expectedRevision`, `geometry`, `edits`, optional `replace` | Updated revision, render status and the mesh report with per-edit results |
| `mesh_stack` | `sessionId`, `expectedRevision`, `geometry`, optional `stack`, `apply` | Updated revision, render status and the mesh report with per-node results |
| `scene_look` | `sessionId`, optional `width`, `height`, `motionTime`, `labels` | PNG image and metadata |
| `scene_review` | `sessionId`, `expectedRevision`, `shots` (each with an optional `branch`), optional `width`, `height`, `labels` | Labeled PNG grid and metadata from an isolated snapshot |
| `scene_checkpoint` | `sessionId` | Checkpoint ID, session ID, and revision |
| `scene_restore` | `sessionId`, `expectedRevision`, and a `checkpointId` or a `branch` | Updated revision, inspection, and render status |
| `scene_release_checkpoint` | `sessionId`, `checkpointId` | Release confirmation |
| `scene_export_recipe` | `sessionId` | Canonical recipe and revision |
| `scene_export_glb` | `sessionId`, optional `clip`, `motionTime`, `maxTextureSize` | A GLB file under `<jobs>/exports/` with a server-chosen name: path, bytes, SHA-256. See [GLB export](export-glb.md) |
| `scene_dispose` | `sessionId` | Disposal confirmation |
| `scene_render_submit` | `sessionId`, `expectedRevision`, `settings` | Snapshot job ID and queued record |
| `scene_render_status` | `jobId` | State and durable frame progress |
| `scene_render_cancel` | `jobId` | Cancellation acknowledgement |
| `scene_render_result` | `jobId` | Completed output paths, hashes and metrics |
| `scene_render_release` | `jobId` | Confirmation that owned job files were removed |

`sessionId` is optional on every tool that lists it: one scene exists at a time, so a call that leaves it out means the active scene. An ID that names another scene (an invented one, or one from a disposed scene) is still rejected with the active ID in the message, because acting on a scene the caller did not name could edit the wrong one.

### Tool errors

Every error an agent can reach names what failed and what to do next. `tests/tool-errors.test.js` walks the triggers and fails on a message with no next action. A JavaScript engine fault (a `TypeError` such as reading a field of `undefined`, from a bug in the server) never reaches the agent: the agent gets one advice message (check the scene with `scene_inspect`, retry once, leave out the optional field, report the tool), and the detail goes to the server's stderr. A failed `scene_create` or `scene_create_asset` ends with "No scene was created ... call scene_create again", so the agent retries instead of calling `mesh_inspect` on nothing. `scene_inspect` on an imported asset takes a source-node ID (`node-40`) when the node holds exactly one part, and names the parts when it holds several. `tests/agent-preview-modules.test.js` walks every preview path (look, labels, review, snapshot, frame, GLB export, branches, mesh reports) in a fresh process where the on-demand scene modules start unloaded. `scene_apply` also names the fix when `set-node` or `set-material` fields are wrapped in a `node` or `material` key.

### Tool cost and diagnostics

Every tool schema is read on every turn, so `node scripts/measure-tool-cost.mjs` reports the bytes and estimated tokens of each schema and of each typical result, and `npm run tool-cost` fails a pull request when one grows past its allowance against the base branch (`bench/tool-cost/README.md`). The schemas total 189,144 bytes (about 54,000 tokens, measured 2026-11-07). To save space, a mesh geometry's `edits` and `stack` in a recipe, and `motion` in `scene_apply` and asset recipes, are advertised as plain objects: the full field list is in `mesh_edit`, `mesh_stack` and `scene_create`, and the backend still validates every field and names the valid choices when one is wrong. A small mesh change is far cheaper as `mesh_edit` (187 bytes in the measured case) than as a whole recipe rewrite (1,254 bytes with the dispose).

`mesh_inspect` lint adds warnings for `intersecting-parts`, `self-intersection`, `thin-wall`, `floating-part` and `asymmetric`. They never set `ok` to false, run within face budgets, and list any check they skipped in `skippedChecks`. `scene_inspect` returns a `diagnostics` list only when there is something to say: ignored material fields, blended transmission, unused materials or geometries, and for imported assets the decoder's not-drawn features, rigs with no joints or no skin, and assets with no clips. Each item has `kind`, `severity`, `target`, `message` and `fix`.

The recipe uses `format: '67js.scene'` and `schemaVersion: 1`.
Supported geometry types are `box`, `cylinder`, `sphere`, `torus`, `lathe`, `extrude`, `tube`, `curve`, `text`, `grid`, `terrain`, and `mesh`. The fields of `curve` and `text` are listed by `scene_capabilities` (`curveText.details`) and not repeated in every tool schema. Text uses the bundled font only; the MCP accepts no font file or URL.
A `mesh` geometry starts from one of the others as `base` and replays an edit log; see [mesh.md](mesh.md).
Geometry fields remain flat inside each geometry record.
Set operations use `set-node`, `set-material`, or `set-camera`, with fields directly on each command.

`set-motion` accepts a complete motion record or `null` to clear it.
`scene_look` can seek procedural `motionTime` without changing revisions. Omission preserves the last preview pose.
An explicit `null` restores the authored base pose. Release `0.8.0` also supports imported source-node motion.
Imported clip sampling remains available through `set-animation`.

`scene_review` compares up to four cameras or motion samples without changing the source recipe, revision or preview pose.
Each shot starts from the authored base pose. The [review guide](agent-review.md) describes separate clocks, dimensions and resource limits.

`scene_apply` with a `branch` name forks instead of editing: the operations run on a scratch copy and the result is stored as that branch, so the scene, its revision and its checkpoints stay as they are. Branches are named with lowercase letters, digits, `_` and `-` (at most 24 characters); up to eight can exist, and branches that end in the same recipe share one snapshot. `scene_restore` with `branch` replays that branch's operations on the scene as one revision and drops every branch; it fails if the scene changed since the fork. Procedural scenes only. See the [review guide](agent-review.md#compare-branches-and-read-labels).

`set-node` can rebind a mesh to another geometry/material pair.

The recipe also accepts [authored lighting, fog, effects and shadow coverage](agent-look.md).
Use `set-environment`, `set-effects` and `set-shadow` with nested partial records to adjust the look.
Nested `volumeFog` and `bloom` fields merge. `pointLights` replaces the complete list.

`environment.lines` turns on outlines, toon light and polylines, and `lines: null` removes them. A material takes `toon` for its own light steps. The code loads only for a recipe that uses either. See [line art](line-art.md).

`postPasses` (set with `set-post-passes`, `null` clears) adds full-screen GLSL passes after the finished frame. See [user passes](user-passes.md) for the rules. A compile failure comes back as `renderError` with the log mapped to the snippet's lines, and the session stays usable.

The preview allocates depth support at creation so enabling fog does not recreate render targets.
Active volume fog requires HDR support. Unsupported previews reject that edit before committing.

Build from an empty recipe by adding resources and nodes in one revisioned batch:

```js
[
  { type: 'add-geometry', geometry: { id: 'cube', type: 'box', bevel: 0.04 } },
  { type: 'add-material', material: { id: 'paint', color: [0.2, 0.6, 0.8] } },
  { type: 'add-node', node: { id: 'mesh', geometry: 'cube', material: 'paint' } }
]
```

Use `remove-node`, `remove-geometry` and `remove-material` with an `id` to remove entries.
References must resolve after the complete batch. Removing a parent leaves its children unchanged unless `recursive: true` removes its subtree.
Reparent or remove those children before the parent removal command to avoid rejection.
The [scene contract](agent-scene.md) defines the geometry fields, transforms, materials, and atomic validation rules.

## Limits

| Budget | Limit |
| --- | --- |
| Active render scenes | 1 |
| Nodes | 4096 |
| Geometries and materials | 256 each |
| Operations per batch | 256 |
| Checkpoints per session | 8 |
| Geometry input points | 4096 per input, including all extrusion contours |
| Extrusion holes | 128 |
| Unique geometry vertices | 250000 |
| Unique geometry buffers | 32 MiB |
| Recipe or command JSON | 1 MiB |
| Incoming stdio buffer | 2 MiB |
| Preview dimensions | 64 to 1024 pixels per dimension (render jobs: up to 1920x1080) |
| Default preview dimensions | 768 by 512 pixels |
| PNG payload | 1 MiB |

The backend enforces combined budgets and numeric consistency beyond the advertised tool schemas.

Render targets can shrink to fit the configured memory budget.
Image metadata reports actual dimensions alongside requested dimensions and estimated render bytes.

An oversized PNG response returns an error. Request a smaller preview rather than treating the failure as an empty image.
Browser evaluations have a 30-second deadline. A timeout closes the preview browser and makes the runtime unavailable.
Camera matrices must remain finite at every supported preview aspect ratio, from 1:16 to 16:1.

Geometry resources remain immutable. Remove an unused definition and add its replacement in one batch, or add a new resource ID and rebind its nodes.
Checkpoints retain their resource handles for exact restoration. Active, checkpoint and staged geometry share a bounded allocation budget.
Release unused checkpoints to free that ownership before adding detail.

The preview reconciles rigid parts, textured ones with the `replace-textured-parts` addon, while retaining shader programs, render targets and shared geometry buffers.
A scene with material patterns gets a new renderer on each topology change instead. Skinned and morphed parts are not streamed either; `replaceParts` rejects adding or removing them.
Unchanged draw batches remain allocated. Changed instance groups receive new instance buffers. Retired buffers are released.

Staging must fit alongside the current render allocations, so a replacement can fail its GPU budget even when the final scene alone fits.
The committed revision and separate render failure remain visible in that case.
Request a smaller `scene_look` to release large frame targets before retrying reconciliation.

The [asset scene contract](agent-asset.md) defines root transforms, material overrides and absolute clip/time samples.
Imported scenes decode once, and `mesh_edit` and `mesh_inspect` take a part ID such as `mesh-10` to edit or check the topology of one imported part (see [the asset scene contract](agent-asset.md)); `mesh_stack` stays procedural.
Their bounds describe authored base vertices in the sampled world transforms, without claiming deformed skin or morph bounds.

The tools expose no arbitrary JavaScript execution, remote URLs or arbitrary caller-selected file paths. MCP accepts no host code at all. The one text that reaches a shader is a bounded GLSL fragment snippet in `postPasses`: at most 4 passes of 4 KB, with no preprocessor lines, no `while` or `do`, only counted `for` loops over integer literals (64 iterations at most), no `gl_` or `u67_` names beyond `gl_FragCoord`, and 16 declared numeric uniforms per pass. A strict validator refuses anything else, with the line, the column and a fix, before any compile. The same validator and limits cover the fragment hook of a material (`snippet`, one function of at most 4 KB, 16 uniforms, `mask` only the material's own map). See [user passes](user-passes.md).
Release `0.8.0` supports [imported source-node tracks](agent-character-motion.md) through the bounded motion recipe.
Facial morph track authoring and rig creation remain unsupported.
Render jobs use a configured private store and fixed output filenames.
`scene_export_glb` writes only to `exports/` inside that store, under a UUID name the server picks, with mode 0600; it keeps the newest eight files and caps each at 32 MiB.

See [render jobs](agent-render-jobs.md) for the snapshot workflow and storage limits.
Embedded texture decoding uses private browser blob URLs. Remote asset requests remain blocked.
The transport supplies a visual feedback loop, but visual quality still depends on the authored scene and image assessment.
MCP support does not establish Blender feature parity.

## Boundary tests

1. Run `node --test tests/mcp-tools.test.js`.

The tests use a real SDK client and linked in-memory transports.
They verify schemas, argument rejection, atomic revision errors, checkpoint behavior, and PNG content with structured metadata.
The adapter uses the real CPU recipe backend and a fixed PNG fixture.
These tests do not prove browser launch, GPU rendering, or final visual quality.

Run `node scripts/smoke-mcp.mjs gpu modern` for a native browser test through real stdio tools.
Run `node scripts/smoke-mcp.mjs cpu legacy` for the software backend and legacy protocol negotiation.
Each checks landscape and portrait PNGs, stale revision rejection, exact PNG restoration, session disposal, and process cleanup.
They build the scene from empty through tool calls, add and remove geometry, and restore the scene after all mesh resources were removed.
The scripts save images and metadata under `artifacts/`. They use one isolated browser and close it when finished.

Run `node scripts/smoke-agent-topology.mjs` to inspect native GPU allocations during a shared-geometry addition and restoration.
Its staging-budget failure must allocate no buffers and retain the previous rendered frame.
Use `node scripts/smoke-agent-topology.mjs cpu` for software rendering. Both modes also verify recovery through a smaller CPU preview under a 32 MiB budget.

Run `node scripts/smoke-agent-assets.mjs` for actual imported WALL-E and textured rig previews through CPU stdio tools.
The script checks content IDs, root edits, retained texture decoding, reverse animation sampling and exact checkpoint restoration.

Run `node scripts/smoke-agent-motion.mjs` for procedural motion through actual CPU MCP previews and jobs.
It checks shuffled PNG seeks, decoded MP4 frames, eight stills, active cancellation, source pose retention and checkpoint restoration.

Run `node scripts/smoke-agent-character.mjs` for a textured nine-joint astronaut through actual CPU previews and snapshot jobs.
