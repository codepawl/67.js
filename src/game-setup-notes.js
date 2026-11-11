// What scene_capabilities topic game says. It sits beside game-setup.js, not in the agent scene capabilities, so the core agent-scene bundle does not carry it; the MCP runtime adds it to the scene capabilities. A test keeps the names in step with game-setup.js.
export const GAME_CAPABILITIES = Object.freeze({
  field: 'recipe.game, set with set-game (null clears). Plain data, never code.',
  fields: 'player {node (a node id; its children move with it), controller character|vehicle (an arcade car: W throttle, S reverse, A/D steer, Space brakes), walkSpeed 3, runSpeed 6, jumpSpeed 7 (0-100 m/s), maximumSpeed 20 (vehicle top speed, 0-100 m/s), footOffset 0 (m from the node origin down to the feet)}, camera, input, physics (bool, false), ground (height in m, 0), rules (game rules document).',
  cameras: Object.freeze(['follow', 'first-person', 'top-down', 'chase']),
  inputPresets: Object.freeze({ keyboard: 'WASD and arrows move and look, Space jumps, Shift runs', gamepad: 'keyboard plus the first gamepad (stick 0, jump on button 0)', touch: 'keyboard plus a left-half virtual stick and tap to jump' }),
  rules: 'version 1, variables, zones {id, shape sphere|box, center, radius|size}, parts {id, tags, position}, prefabs, rules [{id, once, when, if, do}]. The rules part named like the player node follows the player; a part named like a node is hidden or shown with it. Triggers enter|exit|contact|input|timer|variable (input actions: jump, run); actions set|add|show|hide|spawn|animation|sound|win|lose|restart. Full list: docs/game-rules.md.',
  animation: 'player.animation, or npcs[].animation: { clips, parameters, boneGroups, layers, rootMotion, drive }. clips {name: {duration s, loop true, tracks [{target (a CHILD node id of the character, never the character), property translation|rotation, keyframes [{time, value}]}]}}, 1 to 16 clips. parameters, boneGroups, layers (states with clip or 1D/2D blend, transitions, masks) and rootMotion {bone, facing, scale} are the animation graph definition of docs/animation-graph.md, with clip names from clips. drive maps a graph parameter to a controller value (speed|intentSpeed|airborne); default is speed from intentSpeed with rootMotion, else speed. With rootMotion the clips move the player.',
  npcs: 'npcs [{node, path [[x, z] ...] up to 256 points, cruiseSpeed 2.2 m/s, footOffset 0, yaw 0, animation}], up to 16. Each NPC node is separate from the player and from other NPCs. Its animation needs rootMotion and a number parameter "speed": the path follower sets speed to blend idle, walk and run, moves by the root motion, turns at corners and stops at the last point.',
  notes: 'Use camera chase with a vehicle. Yaw 0 faces -Z; W moves forward. Zone checks use the feet position. physics true is accepted but the web export refuses it for now. scene_export_web writes the playable folder.',
  animationExample: Object.freeze({
    type: 'set-game',
    game: Object.freeze({
      player: Object.freeze({
        node: 'walker',
        walkSpeed: 1.4,
        animation: Object.freeze({
          clips: Object.freeze({
            idle: Object.freeze({ duration: 1, tracks: Object.freeze([Object.freeze({ target: 'body', property: 'translation', keyframes: Object.freeze([Object.freeze({ time: 0, value: Object.freeze([0, 0, 0]) }), Object.freeze({ time: 1, value: Object.freeze([0, 0, 0]) })]) })]) }),
            walk: Object.freeze({ duration: 1, tracks: Object.freeze([Object.freeze({ target: 'body', property: 'translation', keyframes: Object.freeze([Object.freeze({ time: 0, value: Object.freeze([0, 0, 0]) }), Object.freeze({ time: 1, value: Object.freeze([0, 0, 1.4]) })]) })]) }),
          }),
          parameters: Object.freeze({ speed: Object.freeze({ type: 'number' }) }),
          rootMotion: Object.freeze({ bone: 'body' }),
          layers: Object.freeze([Object.freeze({ name: 'base', states: Object.freeze([Object.freeze({ name: 'move', blend: Object.freeze({ parameter: 'speed', motions: Object.freeze([Object.freeze({ clip: 'idle', threshold: 0 }), Object.freeze({ clip: 'walk', threshold: 1.4 })]) }) })]) })]),
        }),
      }),
    }),
  }),
  example: Object.freeze({
    type: 'set-game',
    game: Object.freeze({
      player: Object.freeze({ node: 'creature', footOffset: 0.5 }),
      camera: 'follow',
      input: 'keyboard',
      rules: Object.freeze({
        version: 1,
        variables: Object.freeze({ score: 0 }),
        zones: Object.freeze([Object.freeze({ id: 'goal-zone', shape: 'box', center: Object.freeze([0, 0, -6]), size: Object.freeze([2, 4, 2]) })]),
        parts: Object.freeze([Object.freeze({ id: 'creature', tags: Object.freeze(['player']) })]),
        rules: Object.freeze([Object.freeze({ when: Object.freeze({ type: 'enter', zone: 'goal-zone', tag: 'player' }), do: Object.freeze([Object.freeze({ type: 'win' })]) })]),
      }),
    }),
  }),
});
