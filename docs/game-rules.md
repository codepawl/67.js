# Game rules: game logic as data

`crucible/addons/game-rules` plays a JSON rule document in a live game. The document holds variables, triggers and actions. It is data, not code: there is no `eval`, no `Function` and no script, so an agent can create and edit the rules through a tool without running anything it wrote. Like the [runtime](runtime.md), it loads only when imported and adds no dependency.

```js
import { createRuntime } from 'crucible/addons/runtime';
import { createGameRules } from 'crucible/addons/game-rules';

const rules = createGameRules(document, {
  input,                                          // a createInput object, only for input triggers
  getPartPosition: partId => positions.get(partId), // [x, y, z] or undefined, read once per part each fixed step
  onEvent: entry => audio.handle(entry),          // each event log entry, such as a sound marker
});
createRuntime(renderer, { systems: [input, physics, rules] }).start(); // after input and physics
```

The host tells the rules where parts are (`getPartPosition` or `rules.setPartPosition(id, [x, y, z])`) and which parts touched (`rules.reportContact(idA, idB)`, from a physics contact callback). The rules decide what that means.

## The document

```json
{
  "version": 1,
  "variables": { "score": 0, "secondsLeft": 10 },
  "zones": [
    { "id": "coin-zone-1", "shape": "sphere", "center": [2, 0, 0], "radius": 0.5 },
    { "id": "goal-zone", "shape": "box", "center": [8, 0, 0], "size": [1, 2, 2] }
  ],
  "parts": [
    { "id": "player", "tags": ["player"], "position": [0, 0, 0] },
    { "id": "coin-1", "tags": ["coin"] }
  ],
  "prefabs": [{ "id": "spark", "tags": ["effect"] }],
  "rules": [
    {
      "id": "collect-coin-1",
      "once": true,
      "when": { "type": "enter", "zone": "coin-zone-1", "tag": "player" },
      "do": [{ "type": "add", "variable": "score", "value": 1 }, { "type": "hide", "part": "coin-1" }]
    },
    {
      "when": { "type": "enter", "zone": "goal-zone", "tag": "player" },
      "if": [">=", "score", 3],
      "do": [{ "type": "win" }]
    }
  ]
}
```

Every section is optional except `version: 1`. Names (ids, tags, variables, sound and animation names) use letters, digits, `_`, `-` and `.`, up to 64 characters. A part is hidden from zones and contacts while `visible` is false, and a part without a position is outside every zone.

## Triggers (`when`)

| `type` | Fields | Fires when |
| --- | --- | --- |
| `enter` | `zone`, `tag` | a visible part with the tag moves into the zone |
| `exit` | `zone`, `tag` | a part with the tag leaves the zone, or is hidden inside it |
| `contact` | `between: [tagA, tagB]` | the host reported a contact between a part with `tagA` and one with `tagB` in this step |
| `input` | `action`, `phase` (`pressed` default, `released`, `held`) | the named action of `options.input` is in that phase |
| `timer` | `seconds`, `repeat` | game time since the start or the last restart reaches `seconds`, once, or every `seconds` with `repeat: true` |
| `variable` | `expression` | the expression turns true. It fires on the step it becomes true, not on every step it stays true. |

A rule with `once: true` fires at most once per play. `if` is an optional expression checked after the trigger; when it is 0 the rule does not fire.

## Actions (`do`)

| `type` | Fields | Effect |
| --- | --- | --- |
| `set`, `add` | `variable`, `value` | set the variable, or add to it. `value` is an expression. |
| `show`, `hide` | `part` | change the part's `visible` |
| `spawn` | `prefab`, `position` | add a part named `<prefab>#<n>` with the prefab's tags |
| `animation` | `event` | log an animation event name. A game system feeds it to its [animation graph](animation-graph.md) from `onEvent`. |
| `sound` | `name` | log a sound marker. The host plays it from `onEvent`. |
| `win`, `lose` | none | end the game. The remaining actions and rules of the step are skipped. |
| `restart` | none | reset variables, visibility, spawns, timers and `once` flags. The rest of the step is skipped. Part positions stay with the host. |

## Expressions

A number, a variable name, or `[operator, left, right]` with `+ - * /` or `< <= > >= == !=`, nested at most 4 levels. A comparison gives 1 or 0, and an expression counts as true when it is not 0. Dividing by 0 gives 0, so a variable never turns `NaN`. Booleans are 0 and 1.

## Order and determinism

Each fixed step does the same things in the same order:

1. read part positions and work out which parts entered or left each zone;
2. walk `rules` in document order. A rule whose trigger matches, and whose `if` holds, runs all its actions at once, so a later rule sees the variables an earlier rule changed;
3. clear the reported contacts.

After `win` or `lose`, `fixedUpdate` does nothing until `restart()`. Same inputs, same positions and same step give the same event log, byte for byte.

## Reading the state

`rules.state` is a copy: `status` (`playing`, `won`, `lost`), `won`, `lost`, `step`, `elapsedSeconds`, `variables` and `parts` (`id`, `tags`, `position`, `visible`, including spawned ones). `rules.eventLog` is a copy of the log. Each entry has `step`, `rule` (the index) and either `trigger` plus what matched (`part`, `parts`, `action`), or `action` plus its details (`variable` and `value`, `part`, `prefab`, `event`, `name`). `rules.restart()` restarts from game code.

## Limits and errors

| Limit | Value |
| --- | --- |
| variables, zones, parts | 32, 64, 64 |
| prefabs, rules | 16, 64 |
| actions per rule, tags per part | 8, 8 |
| spawns per play | 64. A spawn past it is logged with `refused: "spawn limit"`. |
| event log entries | 2000. Later ones are counted in `rules.droppedEvents`. |
| expression depth | 4 |

`GAME_RULES_LIMITS` exports them. `validateGameRules(document)` checks a document alone and returns a normalised copy. An error names the field and says what to pass, such as `Game rules rules[2].do[1].variable names the variable "scor", which is not declared. Use one of: score, secondsLeft.` An unknown field, an undeclared variable, zone, part, prefab or tag, and an input trigger with no `options.input` are all errors.

An agent sets this document inside a scene recipe `game` section with `set-game`, and `scene_export_web` plays it in a static web build; see [Game](game.md).
