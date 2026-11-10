// What scene_capabilities topic game says. It sits beside game-setup.js, not in the agent scene capabilities, so the core agent-scene bundle does not carry it; the MCP runtime adds it to the scene capabilities. A test keeps the names in step with game-setup.js.
export const GAME_CAPABILITIES = Object.freeze({
  field: 'recipe.game, set with set-game (null clears). Plain data, never code.',
  fields: 'player {node (a node id; its children move with it), controller character, walkSpeed 3, runSpeed 6, jumpSpeed 7 (0-100 m/s), footOffset 0 (m from the node origin down to the feet)}, camera, input, physics (bool, false), ground (height in m, 0), rules (game rules document).',
  cameras: Object.freeze(['follow', 'first-person', 'top-down']),
  inputPresets: Object.freeze({ keyboard: 'WASD and arrows move and look, Space jumps, Shift runs', gamepad: 'keyboard plus the first gamepad (stick 0, jump on button 0)', touch: 'keyboard plus a left-half virtual stick and tap to jump' }),
  rules: 'version 1, variables, zones {id, shape sphere|box, center, radius|size}, parts {id, tags, position}, prefabs, rules [{id, once, when, if, do}]. The rules part named like the player node follows the player; a part named like a node is hidden or shown with it. Triggers enter|exit|contact|input|timer|variable (input actions: jump, run); actions set|add|show|hide|spawn|animation|sound|win|lose|restart. Full list: docs/game-rules.md.',
  notes: 'Yaw 0 faces -Z; W moves forward. Zone checks use the feet position. physics true is accepted but the web export refuses it for now. scene_export_web writes the playable folder.',
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
