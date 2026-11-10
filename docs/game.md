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
| `player.controller` | `character` | The [character controller](player.md) |
| `player.walkSpeed`, `runSpeed`, `jumpSpeed` | 3, 6, 7 | Metres per second, 0 to 100 |
| `player.footOffset` | 0 | Metres from the node origin down to the feet. Zone checks use the feet |
| `camera` | `follow` | `follow`, `first-person` or `top-down`, the [camera rigs](player.md#camera-rigs) |
| `input` | `keyboard` | `keyboard` (WASD move, arrows look, Space jump, Shift run), `gamepad` (adds the first pad) or `touch` (adds a left-half stick and tap to jump) |
| `physics` | `false` | Accepted. The web export refuses `true` until the physics engine can be bundled |
| `ground` | 0 | Height of the walkable ground in metres |
| `rules` | none | A [game rules](game-rules.md) document, checked when it is set |

A rules part named like a scene node is hidden and shown with it, which is how a coin disappears. Yaw 0 faces -Z, and W moves forward. Removing the player node while a game uses it fails with the field to fix.

## The web build

`scene_export_web` writes one folder: `index.html`, `game.json` (the recipe) and `engine/` (the built 67js modules, found by following the imports from `build/game.js`). It runs from any static host with no server code, and the folder is bounded: the engine stays under 12 MiB, the recipe under 1 MiB, and the newest four builds are kept. Procedural scenes only; placed catalog assets and vegetation are refused with the fix. The page shows the variables and the verdict in a corner label and exposes the running game as `window.__game` (`rules.state`, `controller.state`, `scene`, `runtime`).

`index.html?replay=name.json` plays a recording (`recordInput`, see [input](input.md#custom-and-scripted-input)) from the same folder instead of the keyboard. `scripts/smoke-game-web.mjs` builds a creature that collects 3 coins and reaches a goal through the MCP tools, exports it, and wins it from a replay in headless Chrome.

## From code

```js
import { startGame } from '67js/addons/game';
const game = await startGame(canvas, recipe, { replay, showStatus: true });
game.dispose();
```

`startGame` loads the scene modules the recipe needs, builds the scene and renderer, and runs input, controller, camera rig and rules as [runtime](runtime.md) systems. Each frame it moves the player node with `set-node`, so a large scene pays a scene update per frame. Not yet in the web build: live physics, sound, an animation graph and post effects.
