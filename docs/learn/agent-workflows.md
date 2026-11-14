# Working with agents

This page shows what to ask an agent, which tools it calls, and what each tool returns. It assumes that you [connected the MCP server](#connect-mcp). The results below are real. They came from the `crucible-mcp` server, version 0.15.0, started with `--backend cpu`.

## Prompts and the tools they trigger

An agent picks tools from your words. You do not name tools. These prompts show the pattern:

| You say | The agent calls |
| --- | --- |
| "What can Crucible do here? What are the limits?" | `scene_capabilities` |
| "Build a wooden table with four legs." | `scene_create` |
| "Show me." | `scene_look` |
| "What parts does the scene have? How big are they?" | `scene_inspect` |
| "Make the legs thicker and add a shelf." | `scene_apply` |
| "Save this state, then try a glass top." | `scene_checkpoint`, then `scene_apply`, and `scene_restore` to go back |
| "Try the top in red, blue and green and keep the best." | `scene_apply` with a `branch` for each, one `scene_review`, then `scene_restore` with the winning `branch` |
| "Show the front, the side and the top." | `scene_review` |
| "The legs look bent. Check the mesh." | `mesh_inspect`, then `mesh_edit` |
| "Use the robot from my models folder." | `scene_asset_catalog`, then `scene_create_asset` |
| "Render a 1920 by 1080 PNG." | `scene_render_submit`, `scene_render_status`, `scene_render_result` |
| "Give me a GLB file." | `scene_export_glb` |
| "Save the recipe so I can reuse it." | `scene_export_recipe` |

`--assets` must be set for the robot prompt, and `--jobs` for the render prompt. [Connect the MCP server](#connect-mcp) has both options.

## A first session

The session below builds a table. Each block shows what the agent receives.

### 1. Start the connection

The client sends `initialize`. The server answers with its name, version and instructions for the agent. The instructions string is shortened here:

```json
{
  "protocolVersion": "2025-06-18",
  "capabilities": {
    "tools": {"listChanged":true}
  },
  "serverInfo": {"name":"crucible-scene","version":"0.15.0"},
  "instructions": "Start with scene_capabilities. ..."
}
```

### 2. Read the limits

`scene_capabilities` returns the recipe format, the geometry types, the limits and what is unsupported. The result is about 24 KB, so the agent calls it once per session. These are some of its fields:

```json
{
  "scene": {
    "format": "crucible.scene",
    "schemaVersion": 1,
    "geometryTypes": ["box","cylinder","sphere","torus","lathe","extrude","tube","curve","text","grid","terrain","mesh"],
    "...": "..."
  },
  "sceneLimits": {
    "maxNodes": 4096,
    "maxDepth": 256,
    "maxGeometries": 256,
    "maxMaterials": 256,
    "maxVertices": 250000,
    "maxGeometryBytes": 33554432,
    "maxOperations": 256,
    "maxCheckpoints": 16,
    "maxRecipeBytes": 1048576
  },
  "preview": {
    "backend": "cpu",
    "memoryBudgetMiB": 192,
    "maximumWidth": 1024,
    "maximumHeight": 1024,
    "maximumImageBytes": 1048576,
    "maximumActiveScenes": 4,
    "maximumQueuedCalls": 16,
    "evaluationTimeoutMs": 30000
  },
  "review": {
    "minimumShots": 1,
    "maximumShots": 4,
    "minimumDimension": 64,
    "maximumDimension": 480,
    "defaultWidth": 384,
    "defaultHeight": 384,
    "labelHeight": 24,
    "maximumLabelLength": 48,
    "maximumGridWidth": 960,
    "maximumGridHeight": 1008,
    "maximumImageBytes": 1048576,
    "maximumPendingFrames": 1,
    "backend": "cpu",
    "memoryBudgetMiB": 192,
    "evaluationTimeoutMs": 30000,
    "totalTimeoutMs": 30000,
    "sourcePreserved": true,
    "defaultMotionTime": null,
    "defaultRendererTime": 0,
    "branches": {"maximumBranches":8,"maximumNameLength":24,"maximumLabels":24}
  },
  "jobs": {"configured":true,"kinds":["image","stills","video"],"passes":["albedo","normal","emission","depth","objectId"],"...":"..."},
  "unsupported": ["remote asset providers","arbitrary code execution","imported morph track authoring"]
}
```

### 3. Create the scene

The agent sends a recipe: geometries, materials, nodes and a camera. `scene_create` returns the session ID, the revision and an inspection of the node tree:

```json
{
  "sessionId": "1f0ac91e-860f-4332-b6e6-44e7007a81a1",
  "revision": 0,
  "topologyRevision": 0,
  "inspection": {
    "revision": 0,
    "topologyRevision": 0,
    "motion": null,
    "physics": null,
    "boundsSpace": "authored-base-world",
    "counts": {"nodes":3,"parts":2,"geometries":2,"materials":1,"vertices":1578},
    "geometryBytes": 70272,
    "estimatedGeometryBytes": 88368,
    "residentGeometryBytes": 70272,
    "residentGeometryVertices": 1578,
    "look": {"world":false,"pointLights":0,"spotLights":0,"areaLights":0,"volumeFogDensity":0,"exposure":1},
    "nodes": [
      {"id":"table","label":"table","parent":null,"geometry":null,"material":null,"vertices":0,"triangles":0},
      {"id":"top","label":"top","parent":"table","geometry":"top","material":"wood","vertices":1176,"triangles":2028},
      {"id":"leg-a","label":"leg-a","parent":"table","geometry":"leg","material":"wood","vertices":402,"triangles":672}
    ],
    "truncated": false
  },
  "render": {
    "graphics": "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)",
    "estimatedBytes": 34304152,
    "width": 768,
    "height": 512,
    "samples": 0,
    "hdr": true,
    "depth": true,
    "geometryBuffers": 3,
    "materialTextures": 0,
    "skinTextures": 0,
    "morphTextures": 0,
    "gpuBuffers": 12,
    "drawBatches": 3
  }
}
```

The `render.graphics` field names the renderer. Here it is SwiftShader, the software renderer of the `cpu` backend. With `--backend gpu` it names your graphics card.

### 4. Look

`scene_look` returns two content blocks. The first is a PNG image. The second is this JSON text, so the agent can read facts without reading the picture:

```json
{
  "sessionId": "1f0ac91e-860f-4332-b6e6-44e7007a81a1",
  "revision": 0,
  "topologyRevision": 0,
  "motionTime": null,
  "graphics": "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)",
  "estimatedBytes": 24211608,
  "width": 512,
  "height": 320,
  "samples": 0,
  "hdr": true,
  "depth": true,
  "geometryBuffers": 3,
  "materialTextures": 0,
  "skinTextures": 0,
  "morphTextures": 0,
  "gpuBuffers": 12,
  "drawBatches": 3,
  "requestedWidth": 512,
  "requestedHeight": 320,
  "backend": "cpu"
}
```

The image has the size that the agent asked for, here 512 by 320 pixels. It looks like this for the first revision, which has one leg:

![The first look: a table top on one leg](/docs-media/agent-scene-look.webp)

### 5. Edit in one batch

`scene_apply` takes the revision that the agent last saw and a list of operations. This call adds three legs at once:

```json
{
  "sessionId": "1f0ac91e-860f-4332-b6e6-44e7007a81a1",
  "revision": 1,
  "topologyRevision": 1,
  "render": {
    "graphics": "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)",
    "estimatedBytes": 24212100,
    "width": 512,
    "height": 320,
    "samples": 0,
    "hdr": true,
    "depth": true,
    "geometryBuffers": 3,
    "materialTextures": 0,
    "skinTextures": 0,
    "morphTextures": 0,
    "gpuBuffers": 12,
    "drawBatches": 3
  },
  "committed": true,
  "renderSucceeded": true,
  "results": [
    { "i": 0, "op": "add-node", "target": "leg-b", "changed": "added node" },
    { "i": 1, "op": "add-node", "target": "leg-c", "changed": "added node" },
    { "i": 2, "op": "add-node", "target": "leg-d", "changed": "added node" }
  ],
  "diff": { "nodes": { "added": ["leg-b", "leg-c", "leg-d"] } }
}
```

`committed: true` means that the edit is in the scene. `renderSucceeded: true` means that the preview drew it. If the preview fails, the edit stays, and the result says `renderSucceeded: false` with a `renderError`.

### 6. Look with labels

`scene_look` with `labels: true` prints each part's name on the picture and returns its pixel position. The agent can match a name to what it sees:

![The table with part names printed on it](/docs-media/agent-scene-look-labels.webp)

```json
{
  "sessionId": "1f0ac91e-860f-4332-b6e6-44e7007a81a1",
  "revision": 1,
  "topologyRevision": 1,
  "motionTime": null,
  "graphics": "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)",
  "estimatedBytes": 24212100,
  "width": 512,
  "height": 320,
  "samples": 0,
  "hdr": true,
  "depth": true,
  "geometryBuffers": 3,
  "materialTextures": 0,
  "skinTextures": 0,
  "morphTextures": 0,
  "gpuBuffers": 12,
  "drawBatches": 3,
  "labels": [
    {"id":"top","name":"top","tag":"surface","faceTags":["left","side","right","bottom","top","back"],"problems":[],"x":256,"y":131},
    {"id":"leg-a","name":"leg-a","tag":"surface","faceTags":["bottom","right","side","front","left","back"],"problems":[],"x":230,"y":154},
    {"id":"leg-b","name":"leg-b","tag":"surface","faceTags":["bottom","right","side","front","left","back"],"problems":[],"x":335,"y":182},
    {"id":"leg-c","name":"leg-c","tag":"surface","faceTags":["bottom","right","side","front","left","back"],"problems":[],"x":183,"y":169},
    {"id":"leg-d","name":"leg-d","tag":"surface","faceTags":["bottom","right","side","front","left","back"],"problems":[],"x":291,"y":204}
  ],
  "requestedWidth": 512,
  "requestedHeight": 320,
  "backend": "cpu"
}
```

### 7. Errors say what to do

A call with an old revision fails without changing the scene. The result has `isError: true` and this text:

```text
scene_apply failed: expectedRevision must match the current revision.
```

A call that names a missing part fails the same way:

```text
scene_apply failed: set-node target was not found: nope. scene_inspect lists the IDs; add it first with an add operation.
```

The agent reads the message, calls `scene_inspect` to get the current state, and sends the call again.

## The render loop: render, look, fix

An agent works best in a loop. It makes a cheap picture, checks the picture, fixes what is wrong, and renders the final file only at the end.

1. **Preview.** `scene_look` at the default 768 by 512 pixels, or smaller. With the `cpu` backend, the two looks above took 208 ms and 321 ms.
2. **Look.** The agent reads the picture and the `labels` JSON. It lists what is wrong: a part that floats, a camera that cuts off the subject, a dark shadow.
3. **Fix.** One `scene_apply` batch with the current `expectedRevision`. Then back to step 1.
4. **Checkpoint.** Before a risky change, `scene_checkpoint`. If the change fails, `scene_restore` returns to the saved state.
5. **Final render.** `scene_render_submit` with the final size, then `scene_render_status` until the state is `completed`, then `scene_render_result`.

The final render is a job. The next three blocks show an image job of 640 by 400 pixels. The submit call returns a job record at once:

```json
{
  "schemaVersion": 1,
  "jobId": "5e37aa83-ebbe-42d3-956f-e4ae22d21c99",
  "sourceRevision": 0,
  "state": "queued",
  "settings": {
    "kind": "image",
    "width": 640,
    "height": 400,
    "fps": 24,
    "duration": 1,
    "frameCount": 1,
    "rendererTime": {"start":0,"rate":1}
  },
  "progress": {"frames":0,"maximumPendingFrames":0},
  "artifacts": []
}
```

The status call shows the progress and, when the job is done, the file and the timings:

```json
{
  "schemaVersion": 1,
  "jobId": "5e37aa83-ebbe-42d3-956f-e4ae22d21c99",
  "sourceRevision": 0,
  "state": "completed",
  "settings": {
    "kind": "image",
    "width": 640,
    "height": 400,
    "fps": 24,
    "duration": 1,
    "frameCount": 1,
    "rendererTime": {"start":0,"rate":1}
  },
  "progress": {"frames":1,"maximumPendingFrames":1},
  "artifacts": [
    {"filename":"render.png","mimeType":"image/png","bytes":22312,"sha256":"3b0f65321dace0c1eb7ee9c18c739356da4d4d777e3a9431a905c6027396a626"}
  ],
  "metrics": {
    "backend": "cpu",
    "requestedWidth": 640,
    "requestedHeight": 400,
    "renderSeconds": 0.18262570000000006,
    "captureSeconds": 0.051269700000000286,
    "peakNodeBytes": 180748288,
    "peakBrowserHeap": 5409100,
    "maximumPendingFrames": 1,
    "graphics": "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)",
    "width": 640,
    "height": 400,
    "estimatedBytes": 28266648,
    "elapsedSeconds": 1.1123075000000002
  }
}
```

The result call returns the path of the file in the jobs folder. The agent reads the PNG from that path with its own file tool. The path below starts with `<jobs>`, which stands for the folder that you gave to `--jobs`:

```json
{
  "jobId": "5e37aa83-ebbe-42d3-956f-e4ae22d21c99",
  "sourceRevision": 0,
  "artifacts": [
    {
      "filename": "render.png",
      "mimeType": "image/png",
      "bytes": 22312,
      "sha256": "3b0f65321dace0c1eb7ee9c18c739356da4d4d777e3a9431a905c6027396a626",
      "path": "<jobs>/5e37aa83-ebbe-42d3-956f-e4ae22d21c99/render.png"
    }
  ],
  "metrics": {
    "backend": "cpu",
    "requestedWidth": 640,
    "requestedHeight": 400,
    "renderSeconds": 0.18262570000000006,
    "captureSeconds": 0.051269700000000286,
    "peakNodeBytes": 180748288,
    "peakBrowserHeap": 5409100,
    "maximumPendingFrames": 1,
    "graphics": "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)",
    "width": 640,
    "height": 400,
    "estimatedBytes": 28266648,
    "elapsedSeconds": 1.1123075000000002
  }
}
```

For compositing, add `"transparent": true` (PNG with alpha), `"format": "png16"` or `"exr"`, or a `"region": {"x": 0, "y": 0, "width": 640, "height": 360}` crop to an image or stills job; a video can run at up to 60 fps. Each is off unless set.

While a job runs, previews and edits pause. Inspection and recipe export still work. After the job, call `scene_render_release` to delete files that you no longer need. [Render jobs](/agent-render-jobs.md) covers sequences, video, render passes and the path tracer.

## Skills

A skill is a folder with a `SKILL.md` file. It gives an agent a procedure and the names of the files to read. The npm package includes two skills:

- `build-crucible-scene` for building scenes through the MCP tools: look, light, camera, film and animation, and error recovery.
- `render-crucible-media` for PNG, pass and MP4 render jobs, with limits and error recovery.

Copy them from the installed package into the skill folder of your harness. Run this in your project folder, after `npm install crucible@npm:@codepawlhq/crucible`:

```sh
mkdir -p .agents/skills
cp -r node_modules/crucible/skills/build-crucible-scene node_modules/crucible/skills/render-crucible-media .agents/skills/
```

In PowerShell, run this instead:

```powershell
New-Item -ItemType Directory -Force .agents/skills | Out-Null
Copy-Item -Recurse node_modules/crucible/skills/build-crucible-scene, node_modules/crucible/skills/render-crucible-media .agents/skills/
```

Each harness reads its own folder:

| Harness | Project folder | User folder | Source |
| --- | --- | --- | --- |
| Claude Code | `.claude/skills/` | `~/.claude/skills/` | [Claude Code skills docs](https://code.claude.com/docs/en/skills) |
| OpenAI Codex | `.agents/skills/` | `~/.agents/skills/` | [Codex skills docs](https://developers.openai.com/codex/skills) |
| Gemini CLI | `.gemini/skills/` or `.agents/skills/` | `~/.gemini/skills/` or `~/.agents/skills/` | [Gemini CLI skills docs](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/skills.md) |
| Cursor | `.cursor/skills/` or `.agents/skills/` | `~/.cursor/skills/` or `~/.agents/skills/` | [Cursor skills docs](https://cursor.com/docs/skills) |

For Claude Code, replace `.agents/skills` in the commands above with `.claude/skills`. The other harnesses in [Connect the MCP server](#connect-mcp) have no skill folder that this page confirmed. For those, tell the agent to read the two `SKILL.md` files, or add the line `Read node_modules/crucible/skills/build-crucible-scene/SKILL.md before you build a scene` to the project's `AGENTS.md`.

The skills were written for work in a Crucible source checkout. Some steps name files such as `scripts/render-media.mjs`. With the npm package, the agent finds the scene and render guides in `node_modules/crucible/docs/`, for example `agent-scene.md` and `agent-render-jobs.md`.

## Without MCP

Some harnesses have no MCP support. An agent can still use Crucible. Give it these two things:

1. The map of the docs at [`/llms.txt`](/llms.txt) and the full text at [`/guide.md`](/guide.md).
2. A script that renders a picture. [Render a PNG from a script without MCP](#render-a-png-from-a-script-without-mcp) has one that was tested.

The agent writes JavaScript against the installed package, runs the script, and reads the PNG that the script saves. This path needs more steps for each picture than the MCP path. The agent must start a browser itself and manage its own scene state. See [Optimise agent runs](#optimize-for-agents) for the cost of each path.
