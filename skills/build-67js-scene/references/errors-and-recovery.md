# Errors and recovery

Every tool error names what failed and what to do next, so read the message before you retry. A failed
`scene_apply`, `scene_restore` or `mesh_edit` commits nothing: the old revision and recipe stay.

## Messages you will meet

| Message or sign | Cause | Do |
|---|---|---|
| `expectedRevision must match the current revision.` | Another call changed the scene, or you used an old number. | `scene_inspect`, take its `revision`, resend the same batch. |
| `Camera fStop drives depth of field; set effects.depthOfField.blur to 0 or remove fStop.` | Both depth of field controls are on. | Keep one: `fStop` on the camera, or `effects.depthOfField.blur`. See `camera.md`. |
| `Give a camera fov or a focalLength, not both.` | Both lens fields in one command. | Send only one; `focalLength` replaces `fov`. |
| `Unrecognized keys: "scatterOctaves", "multiScatter"` on `volumeFog` | The MCP schema does not accept the opt-in scattering fields yet (#661). | Do not retry; use `density`, `anisotropy`, `noiseAmount`; see `look.md`. |
| `The URL must be of scheme file` on `hdri` or `look` | A shipped catalog name fails in the packaged server (#664). | Use a catalog ID, a `setup` or a built-in look (`warm`, `cool`, `contrast`, `faded`). |
| `bake.gridFog needs bake.irradianceGrid.` | `gridFog` alone. | Add `irradianceGrid: true`. See `light.md`. |
| `Shot <name> reads motion up to N s but the motion lasts M s.` | A timeline longer than a non-looping motion. | Lengthen the motion, set `loop: true` or a shot `motionStart`. |
| A light list error naming a cap | More than 16 point, 8 spot or 7 area lights. | Merge or remove lights; each list replaces the old one. |
| `environment.hdri must be one of ... or the 64-character ID ...` | A made-up name, path or URL. | `scene_asset_catalog`, copy a listed name or ID. |
| `No scene is active` | Nothing created yet, or disposed. | `scene_create`. |
| Result has `renderSucceeded: false` and `renderError` | The edit committed, the draw failed (bad pass, lost context). | `scene_export_recipe` to keep it, fix the cause named in `renderError`, then `scene_look`. |
| An unknown field is rejected before dispatch | A typo or a field of another recipe section. | Fix the name; `scene_capabilities` lists valid fields. |

## Diagnostics in `scene_inspect`

`diagnostics` appears only when something needs a decision. The ones that change the picture:

- `closed-room-without-bake`: add a bake (`light.md`).
- `coplanar-overlap`: flush faces will flicker; `environment.resolveCoplanar: "offset"` or a node `decal` (`light.md`).
- `motionIk` `warnings` (`wrong-bend`, `hyperextended`) and `limited`: fix `bendToward` and `limits`.
- `rig` problems: unweighted vertices, bones with no vertices.
- Mesh lint (`mesh_inspect`): `intersecting-parts`, `thin-wall`, `floating-part`; each comes with a fix.

## Recover

1. `scene_checkpoint` before an experiment, so there is a known good state.
2. After a bad result, `scene_restore` with the `checkpointId` and the current `expectedRevision`. Restoring
   increments the revision and keeps the checkpoint.
3. For variants use a `branch` on `scene_apply` instead of editing: the scene stays as it is until you choose one.
4. A frame that looks wrong is not an error. Compare with `scene_review` (several shots, `labels: true`) before
   changing the look again, and change one field at a time.
5. When the recipe is the product, `scene_export_recipe` after every accepted step.
6. Release saved states you no longer need (`scene_release_checkpoint`) and `scene_dispose` before a new scene.

## When it is the tool

If an error looks like an engine bug (a failed call that the message cannot explain, a crash, a wrong picture from a
valid recipe), stop retrying. File an issue at `codepawl/67.js` with the tool call, the recipe from
`scene_export_recipe` and a `scene_look` still. Do not include local paths.
