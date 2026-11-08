# Scene contract

<!-- skill-navigation:start -->
Read the complete [scene contract](#scene-contract) before creating parts or changing materials. It covers identities, transforms, materials, lighting, fog, animation, cameras and resources in order.
<!-- skill-navigation:end -->

Each part has these fields.

```js
{
  name: 'Birch canopy',
  geometry: {
    positions: new Float32Array(),
    normals: new Float32Array(),
    indices: new Uint32Array(),
  },
  matrix: new Float32Array(16),
  material: {
    color: [0.16, 0.30, 0.08],
    metallic: 0,
    roughness: 0.8,
    emission: 0,
    tag: 'foliage',
  },
}
```

The transform is a column-major matrix. Colors are linear RGB.
Normals are unit vectors. Triangle winding faces outward.
Each geometry and texture descriptor identity pair becomes one instanced batch.

Explodable parts also provide `assembly: { layer: 'exterior' | 'interior', section: 'front-panel', offset: [0, 0, 1.7], detailOffset: [0.1, 0.05, 0.3] }`.
Both offsets are world-space translations. The shader applies `offset * amount + detailOffset * smoothstep(0.3, 1, amount)`.
The group separates first. Small components separate during the second stage.

Keep each section's offsets consistent so fasteners follow their panel. Base matrices remain assembled.

Changing assembly amount refreshes shadows while reusing the same shadow texture and geometry buffers.
For an exploded GLB, use `assemblyOffset(part, amount)` from `67js` for matrix translation entries 12, 13 and 14.

The material tags select renderer behavior.

| Tag | Behavior |
| --- | --- |
| `armor` | Studio finish color and surface overrides. |
| `floor` | Studio floor shading. |
| `water` | Flat ponds and streams only: replaces normals with a near-horizontal ripple field. |
| `liquid` | Shaped water (jets, sheets, splashes): refracts the opaque scene, absorbs by thickness, Fresnel reflection. `color` is what one metre lets through. |
| `foam` | Soft alpha-blended whitewater droplets drawn after liquids. Set `castShadow: false`. |
| `foliage`, `grass` | Wind movement (also in the shadow pass) and backlighting. Accept a base-colour `map` with `alphaMode: 'mask'`, a `normalMap` and `doubleSided` for leaf cards; `loadLeafTextures` gives scanned cards for the `leafTextures` option of `createTree` and `scatterVegetation`. |
| `terrain` | Subtle natural surface variation. |
| Standard tag with `layers` and `splat` | Four-layer scanned ground blended by slope, height and mask; see `docs/terrain.md`. Rejects the procedural tags and single PBR maps. |
| `fire`, `smoke` | Film ignition expansion and procedural shading. |
| `unlit` | Flat linear color for vector scenes. |
| Other tags | Standard metallic/roughness shading. |

`liquid` and `foam` draw in a pass after the opaque scene and are not available in benchmark mode.
Tune them per frame with `frame.liquid` or per renderer with `environment.liquid`: `thickness` (metres), `ior`, `refraction`, `scattering`, `foamOpacity`, `foamSoftness`.
A liquid only refracts opaque parts, not other liquids.

Material tags and colors use flat varyings.
Interpolated numeric tags can change by tiny amounts and select the wrong shading branch.

An outdoor renderer receives `world: true`, `ground: false` and the scene environment.
The environment provides `fogColor`, `fogDensity`, `skyTop`, `skyBottom`, `lightDirection` and optional `daylight`.
The sky colors are display RGB. Fog colors are linear RGB.

Local `environment.pointLights` support 16 world-space sources with inverse-square falloff.
Each light provides `position` and optional `color`, `intensity`, `radius`, `range` and `castShadow`.
`environment.spotLights` (eight) take `position`, `direction`, and optional `angle` (outer half angle in radians, default 0.785), `penumbra` (0 to 1, default 0.15), `color`, `intensity`, `radius`, `range` and `castShadow`. Intensity is candela, the same unit as a point light.
`environment.areaLights` (four) are rectangles with `position`, `direction` (the side that emits), `width`, `height`, optional `up`, `color` and `intensity` (candela seen head on). With `castShadow: true` (1 of the 24 tiles) they cast a soft shadow. `environment.sunAngularRadius` (radians) softens the sun shadow; `ies` on a spot or area light takes `downlight`, `wide-flood`, `narrow-spot`, `batwing` or `{ angles, candela }`.
`environment.viewTransform` (`aces` default, `agx` for lit scenes and Blender comparisons, `neutral` for product and brand colour) and `environment.look` (`warm`, `cool`, `contrast`, `faded`) set the display curve and a grade; `scene_capabilities.viewTransform` says when to pick each, and a recipe using them needs `loadAgentSceneModules`.

`castShadow: true` on a point light uses 6 of the 24 shadow tiles, on a spot light 1. Past 24 the edit is rejected. Shadows reach `range`, or 30 units when `range` is 0. Set `castShadow` on the few lights that show a visible shadow, because each one adds a depth pass. `affects: ['node-id', ...]` on a point, spot or area light, and `environment.keyAffects` for the sun, limit a light to those nodes (a light without it lights every node; an unknown ID is rejected; the bake honours it, the path tracer ignores it and says so). `environment.shadowCascades` (1 to 4, 0 for one map) sharpens a long sun shadow near the camera; it turns on by itself at 3 when `shadow.extent` is above 40, so set it only to choose another count or 0. Details: docs/lighting.md.
`keyIntensity`, `fillIntensity` and `ambientIntensity` independently scale existing lighting.
Read `docs/lighting.md` in the npm package for defaults, numeric limits and frame overrides.
Point lights currently cast no local shadows. Radius limits attenuation without creating an area emitter.

`environment.volumeFog` receives directional scattering and shadows in one bounded volume.
It requires an opaque renderer with `{ hdr: true, depth: true }` and negotiated HDR support.
Read `docs/volumetric.md` for controls, resource cost and limitations before authoring fog.
`frame.environment.volumeFog` replaces the entire constructor fog object, with defaults for omitted fields.
Use absolute frame time for reproducible density drift. Local point lights do not scatter in fog yet.

Material alpha fields: `alphaMode` `'opaque'` (default), `'mask'` (cutout, `alphaCutoff` default 0.5, shadows follow the cutout, smooth edges with MSAA) or `'blend'` (translucent, drawn after opaque, sorted back to front, no shadow unless `castShadow: true`). `opacity` (0 to 1, default 1) multiplies the base map alpha. `doubleSided` (default false) draws both faces with a flipped back-face normal. Use `mask` plus `doubleSided` for leaf cards. All four are batch state: changing them after upload requires a new renderer.

`part.castShadow: false` omits a mesh from shadows while leaving it visible and opaque.
Changing its casting regime requires a new renderer. Shadow-casting groups use separate batches.

```js
const renderer = new Renderer67(canvas, world.parts, {
  world: true,
  ground: false,
  environment: world.environment,
  samples: 4,
  pixelRatio: 1.25,
  memoryBudgetMiB: 256,
});
renderer.render({ ...world.camera, time: 0, wind: 0.3 });
```

The renderer owns its GPU buffers and targets. Call `dispose()` before replacing it.
Call `resize()` when CSS dimensions change.
Check `memoryPlan` for the actual render size and estimated allocation.
The planner can reduce resolution to stay within its target budget.

Films sample their timeline through `sampleFilm(time)`.
Camera FOV uses degrees. Film time must be finite and independent of the wall clock.
`renderAt(time)` must produce the same frame when called in a different order.

Animation changes existing part matrices and materials. `renderer.updateParts(changedParts)` uploads them through retained instance buffers.
New part, geometry or texture descriptor identities require a new renderer.

Source morph parts add `geometry.morphTargets: [{ positions, normals }]` and `morph: createMorphPose(count)`.
Targets contain static relative Float32 XYZ deltas, not absolute vertices. At least one channel is present.
Change retained `part.morph.weights`, then call `renderer.updateParts()` to commit the pose.
Separate pose identities split batches. Repeated parts can share static target geometry.

Morphs run before skinning and use standard materials. Read `docs/morph-targets.md` for numeric limits and memory costs.

Source `exportGlb(parts)` preserves relative morph targets and current weights as a static GLB snapshot.
It preserves opaque linear RGB vertex colors, UVs and active independent HDR emission. Read `docs/export-glb.md` for limits.
It does not serialize animation clips, procedural shaders or scene environments.
Skinning and textured materials still reject at export. Check the decoder's capabilities before importing shape keys.

The optional `{ shadows: false }` update option suits flat scenes without moving shadow casters.

Static `sculptGeometry` strokes return new geometry before renderer upload. Read `docs/sculpt.md` for seam and work limits.
`createSurfacePatch` clips a curved overlay with target-local clearance. Read `docs/surface.md` and share the target's retained matrix.
It rejects skin, morph, assembly and procedural targets. It does not detect arbitrary mesh penetration or provide animated shrinkwrap.

Static `createMeshQueryIndex` copies geometry into an owned disposable BVH. Read `docs/mesh-query.md` for numerical and work limits.
Pass current affine matrices to `createMeshPairQuery(...).evaluate()`. Rebuild indices after editing geometry.
Closed-solid containment requires two `solid: true` indices. Surface contact does not prove volume penetration. Flush faces flicker: `scene_inspect` warns `coplanar-overlap` naming both parts; set `decal: true` on the smaller node (a sign, a road marking), `depthLayer` 0 to 4 for stacked decals, or `environment.resolveCoplanar: 'offset'` to bias every flagged pair at draw time. Or move one part 2 mm along its normal. Never use these to hide overlapping solids.

Use `docs/primitives.md` for exact seam closure and preallocation bounds. Preserve indeterminate and budget errors rather than reporting a miss.

Static `shrinkwrapGeometry(source, target, options)` returns new target-local geometry and query statistics.
Read `docs/shrinkwrap.md` for nearest/project modes, total query budgets and explicit miss handling.
Share the target matrix with the wrapped part. Local distances are not world distances under nonuniform target scale.
Compute once before renderer upload. Matching topology permits relative morph animation instead of rebuilding the BVH every frame.

Vertex clearance does not certify every triangle interior against a curved or nonconvex target. Use the clipping patch for conforming surface overlays.

Use `createSurfaceAttachment(target, { triangle, barycentric, clearance })` for a rigid accessory following a posed triangle.
Read `docs/surface-attachment.md`. Share its retained `matrix` with the accessory, update the target pose, then update the attachment before renderer upload.
The frame follows relative morphs before four-influence skinning. Clearance uses world units and the geometric triangle normal.

Bind immutable geometry once. This sparse point attachment does not deform the accessory or certify clearance over its footprint.


Agent authoring uses `createAgentScene(recipe, limits)` from `67js/addons/agent-scene`.

Read `docs/agent-scene.md` for schema version one, immutable resources and atomic topology commands.
Start with capabilities and bounded inspection. Edit stable IDs through one `apply` batch with the current `expectedRevision`.

Checkpoint before uncertain changes, inspect and render the result, then restore or release the checkpoint.
For rigid scenes (textured parts need `import '@codepawlhq/67js/addons/replace-textured-parts'`; skinned and morphed parts need a new renderer), compare `session.topologyRevision` with the uploaded revision after successful edits.
Call `renderer.replaceParts(session.parts)` for changed topology or `renderer.updateParts(session.parts)` for retained parts, then render the detached camera.

Use add/remove commands for nodes and shared resources, and `set-node` geometry/material fields for rebinding.
Release unused checkpoints before increasing detail. Active, checkpoint and staged geometry share a peak allocation budget.

Keep JSON commands and snapshots exposed to agents. Retained matrices and immutable geometry belong to the renderer adapter.
Do not inspect all vertex bounds in a frame loop. Memory estimates cover unique geometry arrays, not total RAM or VRAM.

The scene addon does not implement MCP transport, asset search, or render jobs.

Recipes own procedural motion. Read `docs/agent-motion.md` before authoring local node, material or camera tracks.
Use `set-motion` for revisioned edits and `sampleMotion(time)` for transient poses. Sampling preserves geometry, canonical recipes and revisions.
Use `sampleMotion(null)` for the authored base pose. Inspection bounds remain authored-base-world, independent of transient motion.

For a configured MCP client, use the packaged `67js-mcp` server documented in `docs/mcp.md`.
Call `scene_capabilities`, create one JSON scene, inspect IDs, checkpoint, apply a small batch, and assess `scene_look` PNG content.
Use the revision returned by each committed apply or restore. A response with `committed: true` and `renderSucceeded: false` still advances revision.
Inspect or export the canonical recipe after a render failure. Do not retry the edit with its old revision.

The server retains one renderer, bounds image dimensions and payloads, and closes its browser on stdio EOF.
Export the recipe before disposal. The server runs bounded snapshot PNG, still and MP4 jobs documented in `docs/agent-render-jobs.md`.
It supports procedural `motionTime` preview seeks and `settings.motion.start` in jobs. Imported tracks retain their separate clip workflow.

`scene_review` compares for up to four labeled cameras or pose samples without editing the source.
Read `docs/agent-review.md`. Each shot starts from the authored base pose and reports its camera, clocks and actual render resources.

For imported models, read `docs/agent-asset.md`, configure `--assets` with an absolute local GLB directory, then select a digest from `scene_asset_catalog`.
Use `scene_create_asset` with a `67js.asset` recipe. Supported texture maps, skinning, morphs and existing clips remain attached to decoded meshes.
Edit imported models through `set-root`, factor-only `set-material`, look commands and absolute `set-animation` sampling. Imported topology is immutable.

Imported source-node overrides and motion exist. Read `docs/agent-character-motion.md` before editing a rig.
Inspect `kind: 'hierarchy'` with offset and limit for stable `node-N` IDs, parents, joint flags and editability.
Use `set-asset-node` for local TRS and `set-motion` for authored tracks. Keep decoded skin bindings, maps and topology unchanged.

The pose layers decoded base, selected clip, static overrides, motion and outer root in that order.
Use `scene.sampleFrame({ animation, motionTime })` to stage both clocks together. Sequential edits can introduce an invalid intermediate skin pose.
Discard failed candidate poses before renderer upload. Flat models need a rig before they can deform as characters.

Use `{ type: 'set-animation', time }` to sample the current clip. `{ type: 'set-animation', clip: null }` restores the decoded pose.
Bounds describe authored base geometry, not the deformed skin/morph silhouette. Check the rendered PNG before accepting framing.

Read `docs/agent-look.md` for authored lighting, fog, effects and shadow coverage,.
Use atomic `set-environment`, `set-effects` and `set-shadow` partial records instead of editing renderer internals through MCP.
Nested `volumeFog` and `bloom` fields merge. The `pointLights`, `spotLights` and `areaLights` fields each replace the full list. Point and spot lights cast shadows only with `castShadow: true`; area lights never do.

`effects.depthOfField` (`blur` 0 to 1, `focusDistance` in metres) and `effects.motionBlur` (`shutter` seconds, camera tracks only, render jobs with `settings.motion`) are off by default and repeat per frame. A render job of kind `image` or `stills` with `settings.passes` (`albedo`, `normal`, `emission`, `depth`, `objectId`) also writes each pass as a raw PNG; `docs/agent-render-jobs.md` gives the encodings.

Volume fog requires opaque HDR/depth rendering. The preview adapter allocates depth support at creation and rejects unsupported fog before commit.
Keep key-light direction aligned with the derived shadow projector. The optional addon exports `resolveAgentShadow` for custom adapters.
Checkpoint before relighting, inspect the actual image and restore or export the complete recipe. Look changes retain topology and geometry.

`cameraView('front' | 'right' | 'top')` returns an orthographic camera with the correct up vector.
`fitOrthographicHeight(bounds, view, aspect)` frames both model width and height.
The `unlit` tag and a front orthographic camera produce flat XY geometry.

An HDR renderer sets `{ hdr: true }` at construction. `capabilities.hdr` reports the negotiated result.
`frame.effects` accepts `bloom`, `saturation`, `contrast`, `temperature`, `vignette` and `grain`.
The renderer reuses bloom targets and includes them in `memoryPlan`.

Imported GLB parts can include `geometry.uvs`, opaque linear `geometry.colors` and `material.map`.
The optional decoder preserves `material.emissiveColor` independently of its base color.
`asset.applyAnimation(time, clipIndex)` mutates existing matrices before `renderer.updateParts()`.
After closing an imported scene, dispose the renderer before the asset to release GPU textures before decoded images.
