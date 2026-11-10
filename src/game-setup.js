import { validateGameRules } from './game-rules.js';

// The `game` section of a scene recipe: which node the player controls, how, with what camera and input, and the rules
// that decide when the game is won. It is plain data. The runtime in src/game.js reads it; nothing in it is code.

export const GAME_CAMERAS = Object.freeze(['follow', 'first-person', 'top-down']);
export const GAME_INPUT_PRESETS = Object.freeze(['keyboard', 'gamepad', 'touch']);
export const GAME_CONTROLLERS = Object.freeze(['character']);

export const GAME_SETUP_LIMITS = Object.freeze({
  maxSpeed: 100,
  maxJumpSpeed: 100,
  maxFootOffset: 100,
  maxGround: 10000,
});

const SETUP_FIELDS = ['player', 'camera', 'input', 'physics', 'ground', 'rules'];
const PLAYER_FIELDS = ['node', 'controller', 'walkSpeed', 'runSpeed', 'jumpSpeed', 'footOffset'];

function fail(path, problem) {
  throw new RangeError(`Game setup ${path} ${problem}`);
}

function requireRecord(value, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(path, 'must be an object, such as { "node": "creature" }.');
}

function rejectUnknownFields(record, allowed, path) {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) fail(`${path}.${key}`, `is not a field. Use one of: ${allowed.join(', ')}.`);
  }
}

function chooseName(value, choices, fallback, path) {
  if (value === undefined) return fallback;
  if (!choices.includes(value)) fail(path, `is ${JSON.stringify(value)}. Use one of: ${choices.join(', ')}.`);
  return value;
}

function boundedNumber(value, fallback, minimum, maximum, path) {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    fail(path, `must be a number from ${minimum} to ${maximum}, got ${JSON.stringify(value)}.`);
  }
  return value;
}

function normalizePlayer(player, nodeIds) {
  requireRecord(player, 'player');
  rejectUnknownFields(player, PLAYER_FIELDS, 'player');
  if (typeof player.node !== 'string' || !nodeIds.has(player.node)) {
    const known = [...nodeIds].slice(0, 12).join(', ') || 'none yet; add the node first';
    fail('player.node', `names ${JSON.stringify(player.node)}, which is not a node of the scene. Use one of: ${known}.`);
  }
  const normalized = {
    node: player.node,
    controller: chooseName(player.controller, GAME_CONTROLLERS, 'character', 'player.controller'),
    walkSpeed: boundedNumber(player.walkSpeed, 3, 0, GAME_SETUP_LIMITS.maxSpeed, 'player.walkSpeed'),
    runSpeed: boundedNumber(player.runSpeed, 6, 0, GAME_SETUP_LIMITS.maxSpeed, 'player.runSpeed'),
    jumpSpeed: boundedNumber(player.jumpSpeed, 7, 0, GAME_SETUP_LIMITS.maxJumpSpeed, 'player.jumpSpeed'),
    footOffset: boundedNumber(player.footOffset, 0, -GAME_SETUP_LIMITS.maxFootOffset, GAME_SETUP_LIMITS.maxFootOffset, 'player.footOffset'),
  };
  return normalized;
}

function normalizeRules(rules, playerNode) {
  let checked;
  try {
    checked = validateGameRules(rules, { hasInput: true });
  } catch (error) {
    throw new RangeError(`Game setup rules: ${error.message}`);
  }
  if (!checked.parts.some(part => part.id === playerNode)) {
    fail('rules.parts', `has no part "${playerNode}", the player node. Add { "id": "${playerNode}", "tags": ["player"] } so zones can see the player.`);
  }
  // Keep the document as written: validateGameRules fills fields (such as a null position) that it does not accept back.
  return structuredClone(rules);
}

/**
 * Check a recipe `game` section against the recipe's node ids and return a normalised copy with every default filled in.
 * The rules document is checked by validateGameRules. Errors name the field and say what to pass.
 */
export function normalizeGameSetup(game, nodeIds) {
  requireRecord(game, 'game');
  rejectUnknownFields(game, SETUP_FIELDS, 'game');
  const player = normalizePlayer(game.player, nodeIds);
  if (game.physics !== undefined && typeof game.physics !== 'boolean') fail('physics', `must be true or false, got ${JSON.stringify(game.physics)}.`);
  const normalized = {
    player,
    camera: chooseName(game.camera, GAME_CAMERAS, 'follow', 'camera'),
    input: chooseName(game.input, GAME_INPUT_PRESETS, 'keyboard', 'input'),
    physics: game.physics ?? false,
    ground: boundedNumber(game.ground, 0, -GAME_SETUP_LIMITS.maxGround, GAME_SETUP_LIMITS.maxGround, 'ground'),
  };
  if (game.rules !== undefined) normalized.rules = normalizeRules(game.rules, player.node);
  return normalized;
}
