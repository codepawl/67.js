import { validateGameRules } from './game-rules.js';
import { normalizeGameAnimation } from './game-animation.js';

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
  maxNpcs: 16,
  maxPathPoints: 256,
});

const SETUP_FIELDS = ['player', 'camera', 'input', 'physics', 'ground', 'rules', 'npcs'];
const PLAYER_FIELDS = ['node', 'controller', 'walkSpeed', 'runSpeed', 'jumpSpeed', 'footOffset', 'animation'];
const NPC_FIELDS = ['node', 'path', 'cruiseSpeed', 'footOffset', 'yaw', 'animation'];

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

function normalizePlayer(player, nodeIds, nodes) {
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
  if (player.animation !== undefined) normalized.animation = normalizeGameAnimation(player.animation, nodes, player.node, { path: 'player.animation' });
  return normalized;
}

function isAncestor(nodes, ancestorId, nodeId) {
  const parentById = new Map(nodes.map(node => [node.id, node.parent]));
  for (let id = parentById.get(nodeId); id !== undefined; id = parentById.get(id)) {
    if (id === ancestorId) return true;
  }
  return false;
}

function normalizePath(path, label) {
  const valid = Array.isArray(path) && path.length >= 1 && path.length <= GAME_SETUP_LIMITS.maxPathPoints
    && path.every(point => Array.isArray(point) && (point.length === 2 || point.length === 3) && point.every(Number.isFinite));
  if (!valid) fail(`${label}.path`, `must be 1 to ${GAME_SETUP_LIMITS.maxPathPoints} waypoints, each [x, z] in metres, such as [[0, -4], [6, -4]].`);
  return path.map(point => [point[0], point[point.length - 1]]);
}

function normalizeNpc(npc, index, { nodeIds, nodes, taken }) {
  const label = `npcs[${index}]`;
  requireRecord(npc, label);
  rejectUnknownFields(npc, NPC_FIELDS, label);
  if (typeof npc.node !== 'string' || !nodeIds.has(npc.node)) {
    fail(`${label}.node`, `names ${JSON.stringify(npc.node)}, which is not a node of the scene. Use one of: ${[...nodeIds].slice(0, 12).join(', ')}.`);
  }
  for (const other of taken) {
    if (other === npc.node || isAncestor(nodes, other, npc.node) || isAncestor(nodes, npc.node, other)) {
      fail(`${label}.node`, `is "${npc.node}", which overlaps the character "${other}" (same node, or one inside the other). Give each character its own separate node.`);
    }
  }
  taken.push(npc.node);
  if (npc.animation === undefined) fail(`${label}.animation`, 'is required: an NPC walks through an animation graph with rootMotion and a number parameter "speed". See scene_capabilities topic game.');
  const animation = normalizeGameAnimation(npc.animation, nodes, npc.node, { path: `${label}.animation`, driven: false });
  if (!animation.rootMotion) fail(`${label}.animation.rootMotion`, 'is required for an NPC: the follower moves by the root motion of the clips. Add { "bone": "<child node id the walk clip translates>" }.');
  if (animation.parameters?.speed?.type !== 'number') fail(`${label}.animation.parameters.speed`, 'must be declared as { "type": "number" }: the follower sets it to blend idle, walk and run.');
  return {
    node: npc.node,
    path: normalizePath(npc.path, label),
    cruiseSpeed: boundedNumber(npc.cruiseSpeed, 2.2, 0.01, GAME_SETUP_LIMITS.maxSpeed, `${label}.cruiseSpeed`),
    footOffset: boundedNumber(npc.footOffset, 0, -GAME_SETUP_LIMITS.maxFootOffset, GAME_SETUP_LIMITS.maxFootOffset, `${label}.footOffset`),
    yaw: boundedNumber(npc.yaw, 0, -2 * Math.PI, 2 * Math.PI, `${label}.yaw`),
    animation,
  };
}

function normalizeNpcs(npcs, context) {
  if (!Array.isArray(npcs) || npcs.length > GAME_SETUP_LIMITS.maxNpcs) fail('npcs', `must be a list of at most ${GAME_SETUP_LIMITS.maxNpcs} NPCs, each { node, path, animation }.`);
  return npcs.map((npc, index) => normalizeNpc(npc, index, context));
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
 * Check a recipe `game` section against the recipe nodes (a list of nodes, or a Set of node ids when there is no animation) and return
 * a normalised copy with every default filled in. The rules document is checked by validateGameRules. Errors name the field and say what to pass.
 */
export function normalizeGameSetup(game, nodeSource) {
  const nodes = Array.isArray(nodeSource) ? nodeSource : [];
  const nodeIds = Array.isArray(nodeSource) ? new Set(nodeSource.map(node => node.id)) : nodeSource;
  requireRecord(game, 'game');
  rejectUnknownFields(game, SETUP_FIELDS, 'game');
  const player = normalizePlayer(game.player, nodeIds, nodes);
  if (game.physics !== undefined && typeof game.physics !== 'boolean') fail('physics', `must be true or false, got ${JSON.stringify(game.physics)}.`);
  const normalized = {
    player,
    camera: chooseName(game.camera, GAME_CAMERAS, 'follow', 'camera'),
    input: chooseName(game.input, GAME_INPUT_PRESETS, 'keyboard', 'input'),
    physics: game.physics ?? false,
    ground: boundedNumber(game.ground, 0, -GAME_SETUP_LIMITS.maxGround, GAME_SETUP_LIMITS.maxGround, 'ground'),
  };
  if (game.npcs !== undefined) normalized.npcs = normalizeNpcs(game.npcs, { nodeIds, nodes, taken: [player.node] });
  if (game.rules !== undefined) normalized.rules = normalizeRules(game.rules, player.node);
  return normalized;
}
