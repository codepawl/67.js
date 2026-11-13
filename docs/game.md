# Game: a playable scene from a recipe

A scene recipe can carry a `game` section. It names the node the player controls, the controller, camera and input preset, and a [game rules](game-rules.md) document. `67js/addons/game` plays it in a page, and the MCP tool `scene_export_web` writes it as a static web build. The section is plain data: there is no script, so an agent can create and edit it without running anything it wrote.

## Build one through MCP

1. `scene_create` with the scene. The player is a node (a group is fine: its children move with it).
2. `scene_apply` with `{ "type": "set-game", "game": { ... } }`. `null` clears it. A wrong field is refused with its name and the values to use; `scene_capabilities` with `topic: "game"` lists every field and one small example.
3. `scene_export_web` with an optional `title`. The result has the path of `index.html`. It needs `--jobs`, like `scene_export_glb`.

```json
{
  "type": "set-game",
  "game": {
    "player": { "node": "creature", "footOffset": 0.5 },
    "camera": "follow",
    "input": "keyboard",
    "rules": {
      "version": 1,
      "variables": { "score": 0 },
      "zones": [
        { "id": "coin-zone-1", "shape": "sphere", "center": [0, 0.5, -3], "radius": 1.2 },
        { "id": "goal-zone", "shape": "box", "center": [0, 1, -12], "size": [3, 4, 2] }
      ],
      "parts": [{ "id": "creature", "tags": ["player"] }, { "id": "coin-1", "tags": ["coin"] }],
      "rules": [
        { "once": true, "when": { "type": "enter", "zone": "coin-zone-1", "tag": "player" }, "do": [{ "type": "add", "variable": "score", "value": 1 }, { "type": "hide", "part": "coin-1" }] },
        { "when": { "type": "enter", "zone": "goal-zone", "tag": "player" }, "if": [">=", "score", 1], "do": [{ "type": "win" }] }
      ]
    }
  }
}
```

## Fields

| Field | Default | Meaning |
| --- | --- | --- |
| `player.node` | required | A node of the scene. The rules part with the same id follows the player |
| `player.controller` | `character` | `character` ([character controller](player.md)) or `vehicle` ([arcade car](player.md#vehicle-and-flight-controllers): W throttle, S reverse, A/D steer, Space brakes; `walkSpeed`, `runSpeed` and `jumpSpeed` are ignored) |
| `player.walkSpeed`, `runSpeed`, `jumpSpeed` | 3, 6, 7 | Metres per second, 0 to 100 |
| `player.maximumSpeed` | 20 | Top speed of a `vehicle`, metres per second, 0 to 100 |
| `player.footOffset` | 0 | Metres from the node origin down to the feet. Zone checks use the feet |
| `camera` | `follow` | `follow`, `first-person`, `top-down` or `chase` (behind the player, swinging round to its heading: use it with a `vehicle`), the [camera rigs](player.md#camera-rigs) |
| `input` | `keyboard` | `keyboard` (WASD move, arrows look, Space jump, Shift run), `gamepad` (adds the first pad) or `touch` (adds a left-half stick and tap to jump) |
| `player.animation` | none | An [animation graph](animation-graph.md) for the player, see [Animation and NPCs](#animation-and-npcs) |
| `npcs` | none | Up to 16 characters that walk a path through their own graph, see [Animation and NPCs](#animation-and-npcs) |
| `physics` | `false` | `true` plays the recipe's `physics` section live, see [Physics](#physics) |
| `ground` | 0 | Height of the walkable ground in metres |
| `rules` | none | A [game rules](game-rules.md) document, checked when it is set |

A rules part named like a scene node is hidden and shown with it, which is how a coin disappears. Yaw 0 faces -Z, and W moves forward. Removing the player node while a game uses it fails with the field to fix.

## The web build

`scene_export_web` writes one folder: `index.html`, `game.json` (the recipe) and `engine/` (the built 67js modules, found by following the imports from `build/game.js`). It runs from any static host with no server code, and the folder is bounded: the engine stays under 12 MiB, the recipe under 1 MiB, and the newest four builds are kept. Placed catalog assets (and the assets whose clips a character retargets) are copied to `assets/<id>.glb`, up to 64 MiB together; grown vegetation is refused with the fix. The page shows the variables and the verdict in a corner label and exposes the running game as `window.__game` (`rules.state`, `controller.state`, `scene`, `runtime`).

`index.html?replay=name.json` plays a recording (`recordInput`, see [input](input.md#custom-and-scripted-input)) from the same folder instead of the keyboard. `scripts/smoke-game-web.mjs` builds a creature that collects 3 coins (each hidden by a rule) on a stone-pattern floor and reaches a goal through the MCP tools, exports it, and wins it from a replay in headless Chrome, with a head-bob animation graph that the page must play. `node scripts/smoke-game-web.mjs bin/67js-mcp.mjs puzzle` plays the [physics puzzle](#physics). `node scripts/smoke-game-web.mjs bin/67js-mcp.mjs drive` does the same for a car that passes 3 gates and reaches a finish line under a `chase` camera.  The `character` sample walks a placed, retargeted humanoid (idle and walk clips of another file) to a goal, and checks that the page loads `assets/<id>.glb` and the character's limbs move. A game with a pattern or map material makes the export ship `engine/replace-textured-parts.js` and `startGame` load it; without it the first scene update and every hide or show fail with a replaceParts error, so the creature sample keeps a textured floor to catch that.

## From code

```js
import { startGame } from '67js/addons/game';
const game = await startGame(canvas, recipe, { replay, showStatus: true });
game.dispose();
```

`startGame` loads the scene modules the recipe needs, builds the scene and renderer, and runs input, controller, camera rig and rules as [runtime](runtime.md) systems. Each frame it moves the player node with `set-node`, so a large scene pays a scene update per frame. Not yet in the web build: sound and post effects.

## Physics

`game.physics: true` plays the recipe's `physics` section (the `set-physics` bodies, with the limits of [physics](physics.md)) live. `startGame` loads `game-physics.js` and the Jolt engine only for such a recipe, so other games and exports do not grow. The engine steps in the fixed update of the runtime at 60 Hz, after the controller and before the rules, and each dynamic body's node follows it through `set-node`. The same recipe gives the same poses on every run in the same engine build; `window.__game.physics` is the [physics system](physics-runtime.md) (`getPose`, `stepCount`, `applyImpulse`, queries).

- The player node can be a `kinematic` body (shape `capsule`, `box` or `ball`): the controller drives it, so the player pushes dynamic bodies and is never pushed back.
- A rules part named like a dynamic body reports that body's position, so a zone, a tag and `enter` work on crates and balls.
- Give every fixed body `shape: "box"` (or `ball`, `capsule`, `convex`): the default `trimesh` is not built. Joints, ragdolls, trimesh and compound shapes are refused with the field to change, and `physics.duration` is only the length of the recorded film.
- The web export copies `jolt-physics.wasm.js` and its `.wasm` file to `engine/physics/` (about 3 MiB) and gives the page their URL, so Jolt fetches the wasm from beside the page. Nothing loads from another origin: a `physicsUrl` on another origin is refused. The `jolt-physics` package must be installed to export.

The `puzzle` sample of `scripts/smoke-game-web.mjs` is two plank crates, two marble plates in brick pockets and an iron gate on a stone floor (pattern materials). The player walks into the first crate and pushes it onto its plate, crosses over and pushes the second; when both plates are pressed the gate part is hidden and the game is won. The smoke checks that the page loads only its own files, that the wasm comes from `engine/physics/`, that both crates moved, and that an export without physics carries no `engine/physics/` folder.

## Animation and NPCs

`player.animation` and each `npcs[].animation` hold a clip set and an [animation graph](animation-graph.md) as plain data. The player or NPC node is the character, and its child nodes are the parts the clips move: a body, legs, arms. The web build plays them with the same graph, root motion and path follower as the code API.

```json
{
  "player": {
    "node": "walker", "walkSpeed": 1.4,
    "animation": {
      "clips": {
        "idle": { "duration": 1, "tracks": [{ "target": "body", "property": "translation", "keyframes": [{ "time": 0, "value": [0, 0, 0] }, { "time": 1, "value": [0, 0, 0] }] }] },
        "walk": { "duration": 1, "tracks": [{ "target": "body", "property": "translation", "keyframes": [{ "time": 0, "value": [0, 0, 0] }, { "time": 1, "value": [0, 0, 1.4] }] }] }
      },
      "parameters": { "speed": { "type": "number" } },
      "rootMotion": { "bone": "body" },
      "layers": [{ "name": "base", "states": [{ "name": "move", "blend": { "parameter": "speed", "motions": [{ "clip": "idle", "threshold": 0 }, { "clip": "walk", "threshold": 1.4 }] } }] }]
    }
  },
  "npcs": [{ "node": "guard", "path": [[4, -6], [8, -6]], "cruiseSpeed": 1.4, "animation": { "...": "same shape; tracks target the guard's child nodes" } }]
}
```

- `clips`: 1 to 16, each `{ duration, loop (true), tracks }` with up to 64 tracks of up to 256 keyframes. A track `target` is a child node of the character (never the character itself, which the controller or follower moves) and `property` is `translation` or `rotation` (a quaternion), in the parent's space.
- `parameters`, `boneGroups`, `layers` and `rootMotion` are the graph definition with every field and limit of [animation-graph](animation-graph.md): 1D and 2D blend spaces, transitions, layers with masks. Clip names refer to `clips`; mask joints are child node ids.
- `drive` (player only) maps a graph parameter to a controller value: `speed`, `intentSpeed` or `airborne`. The default sets `speed` from `intentSpeed` when there is `rootMotion` (the clips then move the player by the travel of the last step) and from `speed` otherwise.
- An NPC needs `rootMotion` and a number parameter `speed`. Its path follower sets `speed`, so idle, walk and run blend; it moves by the root motion, turns at corners and stops at the last of up to 256 `[x, z]` waypoints, where `speed` returns to 0. `cruiseSpeed` is 2.2 by default; `yaw` and `footOffset` work as for the player. Each NPC node is separate from the player and the other NPCs.
- Root travel along +Z works as written; for clips whose root travels -Z set `rootMotion.facing` to `"-z"`.

A wrong field is refused with its path and the values to use, for example `player.animation.clips.walk.tracks[0].target names "Ghost", which is not a child node of the character`. `window.__game.animation` and `window.__game.npcs` expose the graphs.

### A placed character

When the player or an NPC node is a placed catalog asset (`asset: { id }`), `animation.clips` names clips of asset files instead of keyed tracks: `{ "walk": { "from": { "asset": "<catalog id>", "clip": 1 }, "loop": true, "scale": 1 } }`. Leave out `from.asset` for a clip of the character's own file; a clip of another humanoid is retargeted onto the character's skeleton by the humanoid bone map, as in an asset recipe's `motion.layers`. `rootMotion.bone`, `boneGroups` and mask joints name joints of the character's skeleton, such as `Hips`. The game turns the node half a circle because a glTF model faces +Z while yaw 0 faces -Z. The bone map, clip indexes and graph are checked when the game starts, and the error names the field. Pass `assets` (a Map keyed by `assetCopyKey(id, copy)`) to `startGame`, or `assetUrls` (asset id to GLB URL), which the web export fills in. A character animates through `scene.setAssetPose`, so it takes its own decoded copy of the asset and counts toward the 16 animated placements.
