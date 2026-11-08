# 67js implementation roadmap

67js develops 3D authoring and rendering tools for agents, with browser previews, deterministic animation and exported media.
This document separates shipping capabilities from work in progress. Performance claims require measurements on matching scenes and hardware.

The end goal is to be as capable as Blender, as light as three.js and as AI friendly as possible. `docs/goal.md` defines each part, and the GitHub milestones order the work. `docs/parity.md` in that repository records the coverage of each Blender feature.

## Available

- Instanced shared geometry, PBR lighting, shadows, MSAA, FXAA and ACES tone mapping.
- Object inspection, individual assembly explosion, environment controls and deterministic film sampling.
- GLB geometry export and streamed PNG/MP4 capture on hardware WebGL or CPU SwiftShader.
- Render memory estimates, capture guards, npm distribution and synchronized website release metadata.
- General keyframe animation with reusable transforms, material tracks and deterministic seeking.
- Optional HDR, bloom, color grading and reused render targets within the render budget.
- Orthographic front, right and top views, plus flat XY scenes with pan, zoom and capture.
- glTF/GLB mesh input, base-color textures, opaque vertex colors and rigid node animation.
- Landscape, portrait and square presets, time ranges and a generic capture interface for scenes and imported assets.
- Retained scene graphs, lathe and extrusion modeling, authored camera paths and deterministic clip mixing.
- Four-influence GPU skinning, relative morph targets and glTF morph weight animations.
- Material maps, local point lights and depth-clipped volumetric fog.
- Optional recorded Rapier physics with contacts, joint limits and bounded motors.
- Static sculpt brushes, clipped surface patches, shrinkwrap and bounded mesh contact and containment queries.

Version `0.5.0` includes agent scenes with stable IDs, atomic resource/node edits and checkpoints.
Version `0.6.0` adds persistent snapshot jobs with progress, cancellation and verified image/video outputs.
Version `0.7.0` adds recipe-owned procedural motion with deterministic node, material and camera sampling.
Version `0.8.0` adds source-node authoring on imported GLBs with retained rigs, morphs, textures and independent clip timing.

Version `0.9.0` adds isolated multi-angle and pose review with unchanged source revision and preview state.

Version `0.10.0` adds terrain, texture sets, vegetation, liquid playback, vehicles, retargeting, image-based lighting, alpha materials and compressed glTF input.
Version `0.11.0` adds `addons/mesh` for polygon editing, with booleans, bevel, loop cuts, UV unwrapping and a modifier stack. It adds the `mesh_edit`, `mesh_stack` and `mesh_inspect` tools, plus grass, clutter and moss.
Version `0.12.0` adds seeded procedural material patterns.
Version `0.13.0` adds `addons/skeleton-pose` with clip layers, masks and IK, and `0.13.1` and `0.14.0` make it work on real imported characters, including through MCP.
[CHANGELOG.md](https://github.com/codepawl/67.js/blob/main/CHANGELOG.md) lists every change, including work on `main` that is not released yet.

The stdio MCP server supplies twenty-two schema-backed tools and persistent CPU/GPU image previews.
Recipes retain lighting, volumetric fog, grading and directional shadow coverage with atomic edits and undo.
Imported asset sessions retain supported textures, rigs, morphs and clips from a configured local GLB catalog.

The npm package includes the prebuilt `67js-mcp` command with lazy browser startup and bundled dependency licenses.

## Next

The work is ordered in six GitHub milestones. Each milestone lists its own issues.

1. Measure: benchmarks, size budgets and reference-scene scores that make each goal checkable.
2. Lighter: remove weight so that new features fit under the package size budget.
3. Modeling: close the mesh, rigging and procedural gaps against Blender.
4. Look: close the material, lighting and rendering gaps against Blender.
5. Motion and simulation: close the animation, physics and timeline gaps against Blender.
6. Agent surface: make the tools cheaper to use and harder to misuse.

## Longer term

Evaluate WebGPU after collecting WebGL2 bottleneck measurements.
Extend deformation with surface bindings, remeshing and authored humanoid rigs.
Improve character assets and cinematic environments through measured rendering and inspected reference frames.
Blender is the visual quality reference for authored scenes. Rendering parity and universal speed advantages remain goals that need evidence.

## Package size

Large features that carry data or a heavy dependency should ship as separate optional packages (for example `@codepawlhq/67js-film`), not as more entries of the main archive. Lazy loading alone does not help here: a lazy chunk still sits in the same npm archive, so it saves page weight but not the 1 MiB archive budget. A separate package does both, and users who never import it never download it. The cost is a second version to release and a peer range to keep in step, so small code-only addons (a few tens of KB gzip) stay in the main package. The film demo left the main archive for this reason.
