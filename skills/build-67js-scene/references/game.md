# Game: animate a placed character

A game is the recipe `game` section (`set-game`); `scene_capabilities` topic `game` lists its fields and `scene_export_web` writes a page that plays it.

## Animate a placed asset character

Place the character as an asset node (`{ "id": "Hero", "asset": { "id": "<catalog id>" } }`), name that node in `game.player.node` (or `game.npcs[].node`) and give `game.player.animation` clips that point at asset files instead of keyed tracks:
`"clips": { "idle": { "from": { "asset": "<id>", "clip": 0 } }, "walk": { "from": { "asset": "<id>", "clip": 1 } } }`.
A clip of another humanoid file is retargeted onto the character's skeleton, so one locomotion pack serves many characters; leave out `from.asset` to use the character's own clips.
Blend them by speed with a `blend` state on the `speed` parameter, thresholds at the clip speeds (idle 0, walk `walkSpeed`, run `runSpeed`), and set `rootMotion.bone` to the character's hips so the controller, not the clip, moves the node.
Bones in `rootMotion`, `boneGroups` and masks use the character's own joint names. Do not pose the character by hand with `set-node`; the game poses it each frame.

Check it with a replay before exporting: `scene_export_web` copies the character and the clip sources to `assets/<id>.glb`, and a held forward key shows the legs moving in `?replay=name.json`.
If a clip index or bone is wrong, the error names the field and the valid choices; fix that field rather than changing the clip. A character takes its own decoded copy, and at most 16 placements animate.
