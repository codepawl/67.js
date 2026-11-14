# Models and AI agents

An AI agent can build a Crucible scene in two ways. With the MCP server, the agent calls tools that take JSON and return pictures, and it writes no engine code. Without MCP, the agent writes JavaScript like the code in these docs and renders it in a browser.

Three pages cover the details:

- [Connect the MCP server](#connect-mcp): the launch command and the config file for nine harnesses, from Claude Code to Zed.
- [Working with agents](#agent-workflows): example prompts, the real result of each tool, the render loop, skills and the no-MCP path.
- [Optimise agent runs](#optimize-for-agents): how to cut tool calls, tokens and waiting, with measured numbers.

## What the agent does

The server has 25 tools for authoring, previewing and exporting scenes. A normal session uses them in this order:

1. `scene_capabilities` reads the supported features and limits.
2. `scene_create` makes a scene from a [recipe](/agent-scene.md). A recipe is JSON with object IDs, geometry, materials, a hierarchy and a camera.
3. `scene_look` returns a picture of the scene.
4. `scene_apply` changes the scene in one batch. Each edit names the expected revision, so a stale edit fails without partial changes.
5. `scene_checkpoint` and `scene_restore` save and return to a state. `scene_review` shows several views or variants in one picture grid.
6. `scene_export_recipe` and the render job tools save the recipe, PNG images, image sequences and MP4 video.

The tools check every argument against a schema. The server never runs code that the agent writes.

These guides cover the parts of a recipe:

- [Look](/agent-look.md): lights, volume fog, grading and shadows.
- [Motion](/agent-motion.md): keyframes for joints, materials and the camera.
- [Character motion](/agent-character-motion.md): imported characters with editable joints.
- [Assets](/agent-asset.md): GLB files from the catalog folder, with their textures, rigs and clips.
- [Visual review](/agent-review.md): several labeled views or poses in one PNG grid.
- [Render jobs](/agent-render-jobs.md): images, sequences, video and render passes.

## Give the agent a brief

Start with a short brief: the subject, references, the camera, the output size, the interaction, the GPU or CPU backend and the memory budget. Ask for the smallest trial first. A prompt can look like this:

```text
Use Crucible to build an interactive mechanical study. Reuse meshes, use a 256 MiB
render budget, provide orbit and keyboard controls, pause hidden playback, and
capture a real wide and mobile preview. List unsupported features. Do not claim
speed superiority without a comparable benchmark.
```

An agent reads plain text best. Give it [the plain-text guide](/guide.md), which holds all of these docs in one Markdown file, or the shorter map in [`llms.txt`](/llms.txt). [Working with agents](#agent-workflows/skills) shows how to install the two skills that hold the scene and media procedures.

## Check the work of an agent

A successful build does not prove a good picture. Ask the agent to do these checks and to report the results:

1. Read the installed `VERSION` and the exports that it uses.
2. Use finite, invertible matrices, share geometry, and check the bounds.
3. Render a frame and look at the edges and the highlights.
4. Try every interaction, run the project tests and export one frame at a fixed time.
5. Report the real size and the estimated memory apart from the measured process memory.

Without MCP, the agent can still save an image from a script: [Render a PNG from a script without MCP](#render-a-png-from-a-script-without-mcp) has a tested example.
