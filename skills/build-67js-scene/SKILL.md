---
name: build-67js-scene
description: Build or refine interactive 3D scenes with 67js. Use for 67js models, nature worlds, cinematic scenes, camera controls, materials and anti-aliasing, including "làm cảnh 67js" and "model bị răng cưa".
license: MIT
---

# Dựng cảnh 3D bằng 67js

Use the actual 67js checkout. Locate it from the active workspace or Git remote before writing files.
Read its `README.md`, `src/renderer.js` and the closest existing scene module.
Use `simplify-code` and `engineering-workflows` for implementation.

## Choose the surface

- An object studio uses `src/model.js` and `src/main.js`.
- An outdoor world uses `src/nature.js` and `src/nature-viewer.js`. Real trees, bushes, grass and forest scattering use optional `src/vegetation.js` and `docs/vegetation.md` (`leaves: 'mesh'` needs no alpha support).
- A grass field, meadow, lawn or savanna over terrain uses optional `src/grass.js` and the checkout's `docs/grass.md`: clumped curved blades, tile level of detail, `mask` for paths. Darken every ground layer under the grass toward `grass.groundColor` (a bright floor between blades looks fake); prefer it over scattered `grass` clumps for anything wider than a few metres. Pebbles, rocks, twigs and fallen leaves on paths, riverbanks or forest floor use optional `src/clutter.js` and the checkout's `docs/clutter.md` (`riverbed`, `forest`, `scree`, `meadow` presets).
- Light that bounces inside a closed room (colour bleed, shadows that are not black) comes from optional `src/light-bake.js` and the checkout's `docs/light-bake.md`: `bakeLightmaps(parts, { pointLights, keyColor, lightDirection }, options)` returns new parts with a lightmap (plain parts through the emissive map, patterned, textured and emissive parts through the `lightMap` slot on a second UV set); direct light stays live. Recipes reach it through `bake`. A closed room with no `bake` renders lifted and grey; `scene_inspect` reports it as the `closed-room-without-bake` diagnostic, so add `bake` then.
- A deterministic film uses `src/film.js` and `src/film-player.js`.
- A keyframe scene uses `src/animation.js`, `src/motion.js` and `src/motion-player.js`.
- An authored camera uses `src/camera-path.js` and the checkout's `docs/camera-path.md`.
- Local lights use the renderer environment and the checkout's `docs/lighting.md`.
- Realistic reflections or HDRI lighting use `environment.map` from `createEnvironmentMap` or optional `src/hdri.js` (`loadHdri`) and the "Environment maps (IBL)" section of `docs/lighting.md`.
- Depth-clipped fog uses `{ hdr: true, depth: true }` and the checkout's `docs/volumetric.md`.
- A skeletal asset uses `src/skinning.js`, `src/gltf.js` and the checkout's `docs/skinning.md`.
- Relative facial or shape deformation uses `src/morph.js` and the checkout's `docs/morph-targets.md`. Check source versus published support first.
- Recorded contacts or articulated physics use optional `src/physics.js` and the checkout's `docs/physics.md`.
- Humanoid clips moved between rigs, or crowds of skinned characters, use optional `src/retarget.js` and the checkout's `docs/retarget.md`. Mixamo downloads need the owner's Adobe login.
- Realistic ground (rolling hills to ridges, scanned grass/forest/mud/rock layers) uses optional `src/terrain.js`, `src/texture-set.js` and the checkout's `docs/terrain.md`. Feed `terrain.heightAt` to vegetation and vehicles; never fake ground with the `terrain` tag. Splat `variation` and `edgeNoise` (on by default) keep wide ground from reading as one flat colour; leave them on unless a stylised look needs flat ground.
- Baked liquid (jets, geysers, torrents, whitewater) uses optional `src/spume.js` and the checkout's `docs/spume.md`. Bake with the Spume solver first; never fake it with displaced primitives.
- Wheeled vehicles driving a path (wheel spin, steering, body roll and pitch, ground following) use optional `src/vehicle.js` and the checkout's `docs/vehicle.md`.
- A flat scene or axis view uses `src/canvas2d.js`, `src/camera.js` and `src/view2d.js`.
- A GLB asset viewer uses the optional `src/gltf.js` addon and `src/asset-viewer.js`.
- Static brush sculpting uses optional `src/sculpt.js` and the checkout's `docs/sculpt.md`.
- A curved surface badge uses optional `src/surface.js` and the checkout's `docs/surface.md`.
- Static contact, ray hits or closed-solid containment use optional `src/mesh-query.js` and the checkout's `docs/mesh-query.md`.
- Static vertex wrapping uses optional `src/shrinkwrap.js` and the checkout's `docs/shrinkwrap.md`.
- A rigid accessory on a morphing or skinned surface uses optional `src/surface-attachment.js` and `docs/surface-attachment.md`.
- Agent scene recipes use optional `src/agent-scene.js` and `docs/agent-scene.md`. Verify source versus published availability before importing.
- Signs, labels and piping use recipe geometry `text` (bundled DejaVu Sans, printable ASCII; faces +Z, baseline on y=0, size is the em height) and `curve` (cubic Bezier points with optional absolute handles, `radius`, `taper`, `profile`). Their fields come from `scene_capabilities` `curveText.details`, not the tool schema; the MCP takes no font file or URL. Give a sign a board box a little deeper than the text `depth`, and keep text under about 40 characters at `curveSegments: 4`. See "Curve" and "Text" in the checkout's `docs/modeling.md`.
- Rolling ground with a cut-out opening (a cave mouth, a shaft) uses recipe geometry `terrain` with `holes: [{ center: [x, z], radius }]`; `scene_capabilities` `terrain` lists the fields. It is one mesh, so splat layers and a path query are not part of it (the `addons/terrain` library has `holes` too).
- Polygon modeling by an agent (extrude, inset, loop cut, bevel, booleans, mirror, array, solidify) uses the recipe `mesh` geometry and the MCP tools `mesh_inspect`, `mesh_edit` and `mesh_stack`. Read [mesh-modeling.md](references/mesh-modeling.md) before the first edit; check that the checkout's `docs/mesh.md` exists, since it is unreleased after npm 0.10.0.
- Parts that sit against each other (a handle on a body, a lid on a tank, legs under a top) use the node `relations` field: `attach`, `gap`, `flush`, `align` or `centered` against another mesh node, optionally a tagged `region` of it. They are solved again after every edit, so resize the body with one `set-node` instead of recomputing each part's translation. One relation per axis, no loops. Fields are in `scene_capabilities` `relations`; see "Relations between parts" in the checkout's `docs/agent-scene.md`.
- A surface look in a recipe (wood, planks, bricks, tiles, marble, stone, concrete, metal, rust, fabric) uses the material `pattern` field, which needs no UVs. See "Material patterns" in the checkout's `docs/agent-scene.md`. Your own look (bricks from noise and a ramp, stripes, a pattern that follows `uv_unwrap`) is `pattern: { type: "graph", graph, mapping: "uv" }`: a bounded JSON node graph baked to textures, never shader text; see "Material graphs" there.
- Glass, water, gems, car paint and cloth in a recipe use the material layer fields `transmission` (with `thickness` and `ior`), `clearcoat`, `sheenColor`, `specular`, `anisotropy` (brushed metal) and `iridescence` (soap, oil). Give glass the default `surface` tag, not `liquid`, which absorbs by thickness and reads murky; anisotropy and iridescence are ignored on a transmissive material. A transmissive material needs a nonzero `thickness` to bend the view behind it, and does not show blended surfaces. Ranges and limits are in "Material layers" in the checkout's `docs/material-maps.md`.
- Layered skeletal animation in code (a clip on some joints only, additive clips, foot planting, reaching, looking at a point) uses `createAssetPose` from `src/skeleton-pose.js` and the checkout's `docs/skeleton-pose.md`. Clip layers are not available through MCP.
- Jointed motion (an arm reaching, a lamp or head tracking a point) on a recipe or an imported character uses `motion.ik`, which needs no quaternions: on a recipe parent the joint nodes and put sizes on child mesh nodes, on an asset find `node-N` IDs with `scene_inspect` kind hierarchy and aim with `worldForward`. Read `motionIk` from `scene_inspect`: besides `reached`, it lists `warnings` (`wrong-bend` when a knee or elbow bends the unnatural way, `hyperextended`) and `limited` (poses a joint limit changed). Give a leg or arm `bendToward` (a world direction, such as `[0, 0, 1]` for a knee on a character facing +z) and `limits` per joint in degrees, and fix any warning before you finish. `motion.constraints` (copy, limit, `track_to`, `child_of`, `floor`, Blender's meanings, Euler XYZ degrees) and `motion.drivers` (a node or material property from a bounded JSON expression) run after IK and give the same pose at any time. On an imported asset, `motion.layers` plays its clips together (a walk layer plus a wave layer masked to `{ "joints": ["node-N"] }` for the arm): list clip ids with `scene_inspect` (`animations`), find joints with kind hierarchy, set `morph: false` on a layer that should not touch the face, and use `bones` to send a clip's track to another node. See "Inverse kinematics", "Clip layers on an asset", "Constraints" and "Drivers" in the checkout's `docs/agent-motion.md`.
- Where meshes meet: a rock or trunk sunk into ground gets node `blend: { "radius": 0.15 }` (soft seam, needs depth, `docs/mesh-blend.md`); flush faces get `decal` or `depthLayer`. A sun-lit closed room bounces sun light on its own; `environment.sunBounce` scales it (0 off). Water over a bed needs `opacity` below one to show the bed, and the bed's shadow fades with depth (`docs/agent-scene.md`).
- Hide or flag a node without removing it: `visible: false` (also keyable in a motion track, so films stop parking parts at y=-5000), `castShadow`, `receiveShadow`, `holdout` and `shadowCatcher` (transparent canvas, for footage composites); see "Visibility and render flags" in `docs/agent-scene.md`.
- A skeleton-only GLB (`meshes: 0` in `scene_asset_catalog`) cannot be placed, but its clips drive a character through `motion.layers[].from`.
- Agent tool calls use the installed `67js-mcp` stdio server from release `0.5.0` onward. Read `docs/mcp.md` for launch and PNG feedback.
- Agent render jobs use `docs/agent-render-jobs.md`. Check source versus published support, configure a private store and poll until terminal.
- A character or creature that must move (a walker, a quadruped) gets a recipe `armatures` entry and a `skin` on each mesh node: `{ "id": "rig", "preset": "humanoid", "fit": { "bounds": { "min": [...], "max": [...] } } }` (or `fit.node`), then `skin: { "armature": "rig" }` on every body part. Bones are nodes named `hips`, `leftUpperLeg`, `leftLowerLeg` and so on, so rotation tracks and `motion.ik` address them directly (rotation is local, about the bone head; positive X swings a hanging limb backward). Build the mesh at rest in the preset's pose (facing +Z, arms down), and read `rig` in `scene_inspect`: unweighted vertices, bones with no vertices, joint axis problems. Weights are by distance to the bone segments, so give limbs the same loops you want to bend. See "Authored rigs" in `docs/agent-motion.md`.
- Things that fall, pile up or rest on an authored mesh (dropped objects, a ball in a bowl, a trigger zone) use the recipe `physics` section: bodies on root node IDs, `shape: 'trimesh'` on a fixed body so objects follow the mesh, `sensor: true` for triggers, `layer` and `collidesWith` for masks. Seek with `motionTime` like motion, and read `physics` from `scene_inspect` (resting times, contacts, sensor events) instead of guessing from a picture. Needs the optional peer `@dimforge/rapier3d-compat`; a limp character uses `physics.ragdoll` (`{ armature }` for a recipe armature; an imported asset takes `physics: { duration, floor, ragdoll: {} }` and falls from its current pose onto a floor at world height `floor`), needs a floor body in a scene recipe, and reports `physics.ragdoll` (`lowestY`, `highestY`, `restsAtTime`); joints have no swing limits. See "Recipe physics" in the checkout's `docs/physics.md`.
- Flags, curtains, capes and cloths draped over props use the recipe `cloth` section: a `grid` geometry node (flat sheet in XY, `segments` up to 64) listed in `sheets` with `pin` edges (`top`, `left`, a corner...), `wind` in m/s, and fixed `colliders` (`ball` or `box` fitted to their node). A cape or skirt on a moving character uses moving colliders (`attach` + `shape: "capsule"` + `to`, or `armature` for one capsule per bone) and a sheet `pinTo: { node }`. Seek with `motionTime`; a flag needs wind along its length (+x for a left pin), not across it. No peer needed, no self collision, no soft bodies. Units, defaults and limits are in `scene_capabilities` under `cloth`; see "Recipe cloth" in `docs/physics.md`.
- Sparks, dust, embers, confetti and fur use the recipe `particles` section: a root node whose small low-poly geometry (a box) is the particle, in an emitter system with `seed`, `count` (at most 2000), `rate` (omit for one burst), `lifetime`, `speed`, `spread`, `drag`, `floor` and an `emitter` shape; a system with `type: "hair"` grows strands from a `surface` node. Seek with `motionTime`; the same seed and time give the same particles. The node transform does not move particles, and there is no collision beyond the floor, bounce or per-particle colour. Fields and limits are in `scene_capabilities` under `particles`; see "Recipe particles and hair" in `docs/physics.md`. Smoke, fire and browser liquid are not supported.
- A closed room, or any scene lit by point lights, is dark where the light does not reach. Add the recipe `bake` section (`{ "preset": "standard" }`, or `draft` to try fast; `fine` is the same as `standard`) or the `set-bake` operation: it writes bounced light into lightmaps when the scene builds and reruns only when parts, lights, materials or the bake change. `scene_inspect` shows `bake.seconds` and `bake.skipped` (alpha, skins, morphs, procedural tags and hair or particle hosts are left as they were; patterned, textured and emissive parts are baked and keep their pattern). It bakes the rest pose and no spot or area lights. Read `docs/light-bake.md`.
- Agent procedural animation uses `docs/agent-motion.md` from release `0.7.0`. Author recipe tracks, then seek through `sampleMotion` or MCP `motionTime`.
- Agent imported character motion uses `docs/agent-character-motion.md` from release `0.8.0`. Inspect source joints before authoring local tracks.
- To pick between variants, fork each with `scene_apply` and a `branch` name (the scene and revision stay put), compare them in one `scene_review` with a `branch` per shot, then keep the winner with `scene_restore` and its `branch`. Add `labels: true` to `scene_look` or `scene_review` to match node names and lint problems to what the image shows. Docs: `docs/agent-review.md`.
- Agent comparisons use `scene_review` from release `0.9.0`. Read `docs/agent-review.md` for isolated views and independent pose samples.
- An image or video export uses `render-67js-media`.
- A GLB for Blender or another tool uses `scene_export_glb` (needs `--jobs`): it returns a file path under the jobs folder, takes no path of its own. Plain call for the current pose with textures, skins and IK; `motionTime` to pose authored motion first; `clip` on an unposed imported asset for its source animation. See `docs/export-glb.md`.

Read [scene-contract.md](references/scene-contract.md) before creating parts or changing materials.

## Build and inspect

1. State the focal point, camera, scale and intended lighting.
2. Reuse geometry identities across repeated parts. Keep transforms and materials in instance attributes.
3. Use curved surfaces and sampled fillets for close objects. Keep coarse geometry for distant objects.
4. Enable explicit MSAA, FXAA and specular filtering through `Renderer67`.
5. Set the render memory budget before allocating a target.
6. Keep per-frame animation deterministic. Pause continuous rendering when the document is hidden.
7. Validate geometry, bounds and scene budgets with the existing Node tests.
8. Capture actual rendered wide and narrow views. Inspect edges, highlights, overlap and the focal point.
9. Exercise orbit, zoom, camera selection and the requested interaction through project dev tooling.
10. In a recipe, start from the default look: `environment.setup` is `daylight` and `effects.ambientOcclusion` is `0` (off; set 0.4 to 0.8 to add contact darkening). Pick `studio` for products, `overcast` for soft even light, `sunset` for warm low light; Do not hand-tune key, fill and ambient first. The preview draws an automatic floor with a contact shadow under the lowest geometry unless a part already forms a floor; `environment.ground: false` removes it, so do not add a floor node only for the shadow.

Do not treat an `antialias: true` context as proof that the final image looks smooth.
Report measured geometry, draw counts and render size separately from visual judgments.
Do not claim Blender parity or general Three.js speed superiority from one scene.

## Finish

Deliver the scene link, a rendered image, relevant checks and known limits.
To see what changed, including unreleased changes and breaking ones, read `https://67js.codepawl.com/changelog.json`.
Keep this skill aligned with the checked-out renderer API when changing that API.

## Bugs

If you find a 67js bug or instability, file it at once with `gh issue create -R codepawl/67.js`. Give the steps, the scene and a still.
