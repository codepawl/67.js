import { Renderer67 } from './renderer.js';
import { createAgentScene, loadAgentSceneModules } from './agent-scene.js';
import { agentGroundPlacement, createAgentGround, FLOOR_COLOR } from './agent-ground.js';
import { agentEnvironmentMap } from './agent-look.js';
import { groundBounceEnvironment } from './ground-bounce.js';
import { createRuntime } from './runtime.js';
import { createInput, gamepadSource, keyboardSource } from './input.js';
import { replaySource, touchSource } from './input-sources.js';
import { createCharacterController, createChaseCamera, createController, createCameraRigOfKind, createFirstPersonCamera, createFollowCamera, createTopDownCamera, createVehicleController } from './player.js';
import { createGameRules } from './game-rules.js';

// Plays the `game` section of a scene recipe in a page: the scene, the input preset, the character controller, the camera rig
// and the game rules, all run by the live runtime. scene_export_web writes a folder whose index.html calls startGame.

const KEYBOARD_ACTIONS = { jump: ['keyboard/Space'], run: ['keyboard/ShiftLeft'] };
const KEYBOARD_AXES = {
  moveX: ['keyboard/KeyD', { control: 'keyboard/KeyA', scale: -1 }],
  moveForward: ['keyboard/KeyW', { control: 'keyboard/KeyS', scale: -1 }],
  lookX: ['keyboard/ArrowRight', { control: 'keyboard/ArrowLeft', scale: -1 }],
  lookY: ['keyboard/ArrowUp', { control: 'keyboard/ArrowDown', scale: -1 }],
};
const MOVE_STICK = { name: 'move', area: { x: 0, y: 0, width: 0.5, height: 1 }, radius: 60 };

function inputDefinition(preset) {
  const actions = { jump: [...KEYBOARD_ACTIONS.jump], run: [...KEYBOARD_ACTIONS.run] };
  const axes = Object.fromEntries(Object.entries(KEYBOARD_AXES).map(([name, bindings]) => [name, [...bindings]]));
  if (preset === 'gamepad') {
    actions.jump.push('gamepad/0.button0');
    axes.moveX.push('gamepad/0.axis0');
    axes.moveForward.push({ control: 'gamepad/0.axis1', scale: -1 });
    axes.lookX.push('gamepad/0.axis2');
    axes.lookY.push({ control: 'gamepad/0.axis3', scale: -1 });
  }
  if (preset === 'touch') {
    actions.jump.push('touch/tap');
    axes.moveX.push('touch/moveX');
    axes.moveForward.push({ control: 'touch/moveY', scale: -1 });
  }
  return { actions, axes };
}

function inputSources(preset, canvas) {
  const sources = [keyboardSource()];
  if (preset === 'gamepad') sources.push(gamepadSource());
  if (preset === 'touch') sources.push(touchSource({ target: canvas, sticks: [MOVE_STICK] }));
  return sources;
}

function cameraRigFor(kind, controller, input) {
  const rigOptions = { subject: controller.state, input };
  if (kind === 'first-person') return createFirstPersonCamera(rigOptions);
  if (kind === 'top-down') return createTopDownCamera(rigOptions);
  if (kind === 'chase') return createChaseCamera(rigOptions);
  if (kind !== 'follow') return createCameraRigOfKind(kind, rigOptions);
  return createFollowCamera(rigOptions);
}

// A node's world position, from the translations along its parents. The player starts there.
function nodeTranslation(nodes, id) {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const position = [0, 0, 0];
  for (let node = byId.get(id); node; node = byId.get(node.parent)) {
    for (let axis = 0; axis < 3; axis++) position[axis] += node.translation?.[axis] ?? 0;
  }
  return position;
}

// The node a controller or follower moves: its feet position and the heading about the vertical axis.
// A placed glTF character faces +Z, while yaw 0 faces -Z, so its node is turned half a circle.
const GLTF_FACING_YAW = Math.PI;

function characterOperation(id, position, yaw, footOffset, modelYaw = 0) {
  yaw += modelYaw;
  return { type: 'set-node', id, translation: [position[0], position[1] + footOffset, position[2]], rotation: [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)] };
}

// Copies the controller's state into the graph parameters that the animation's `drive` names.
function parameterSystem(animation, controllerState) {
  return {
    name: 'animation-parameters',
    fixedUpdate() {
      for (const [parameter, source] of Object.entries(animation.drive)) animation.graph.set(parameter, controllerState[source]);
    },
  };
}

function litEnvironment(scene, hasAutomaticGround) {
  const environment = scene.environment;
  return groundBounceEnvironment(scene.parts, { ...environment, map: agentEnvironmentMap(environment) }, { automaticAlbedo: hasAutomaticGround ? FLOOR_COLOR : null });
}

function createStatusLine(canvas) {
  const element = document.createElement('div');
  element.style.cssText = 'position:fixed;left:12px;top:12px;padding:6px 10px;border-radius:6px;background:rgba(0,0,0,.55);color:#fff;font:14px system-ui,sans-serif;pointer-events:none;user-select:none';
  canvas.parentNode.appendChild(element);
  return element;
}

function modelYawOf(animation) {
  return animation?.assetNode ? GLTF_FACING_YAW : 0;
}

function describeState(state) {
  const variables = Object.entries(state.variables).map(([name, value]) => `${name} ${value}`).join('   ');
  const verdict = state.status === 'won' ? '   YOU WIN' : state.status === 'lost' ? '   GAME OVER' : '';
  return `${variables}${verdict}`;
}

async function loadAnimationRuntime() {
  const [{ createGameAnimation }, { createPathFollower }] = await Promise.all([import('./game-animation.js'), import('./npc-follower.js')]);
  return { createGameAnimation, createPathFollower };
}

/**
 * Start the game a recipe describes on a canvas and return its parts: `scene`, `runtime`, `rules`, `input`, `controller`, `renderer`
 * and `dispose()`. Options: `replay` (a recording from recordInput; the keyboard is not attached) `showStatus` (default true) `assets` (decoded catalog assets by assetCopyKey) or `assetUrls` (asset id to GLB URL, which startGame fetches and decodes) and `createRenderer` (tests pass a stand-in for the WebGL renderer).
 */
export async function startGame(canvas, recipe, options = {}) {
  const cleanups = [];
  try {
    const game = await buildGame(canvas, recipe, options, cleanups);
    let disposed = false;
    return {
      ...game,
      dispose() {
        if (disposed) return;
        disposed = true;
        runCleanups(cleanups);
      },
    };
  } catch (error) {
    runCleanups(cleanups);
    throw error;
  }
}

// Each resource registers its cleanup as it is created; they run newest first.
function runCleanups(cleanups) {
  while (cleanups.length > 0) cleanups.pop()();
}

async function buildGame(canvas, recipe, { replay, showStatus = true, assets: providedAssets, assetUrls, createRenderer = (...rendererArguments) => new Renderer67(...rendererArguments) }, cleanups) {
  const setup = recipe.game;
  if (!setup) throw new Error('startGame needs a recipe with a game section. Add one with the set-game operation.');
  await loadAgentSceneModules(recipe);
  // The exported page gives URLs; the assets load only for a recipe that places or retargets a catalog asset.
  const assets = providedAssets ?? (assetUrls ? await (await import('./game-assets.js')).loadGameAssets(recipe, assetUrls) : undefined);
  const scene = createAgentScene(recipe, {}, { assets });
  const { game } = scene.exportRecipe();
  const placement = agentGroundPlacement(scene.parts, scene.environment);
  const environment = litEnvironment(scene, Boolean(placement));
  const renderer = createRenderer(canvas, scene.parts, {
    ground: placement ? createAgentGround(placement) : false,
    hdr: true,
    depth: true,
    world: scene.environment.world,
    environment,
    pixelRatio: Math.min(globalThis.devicePixelRatio ?? 1, 2),
  });
  cleanups.push(() => renderer.dispose());

  const { actions, axes } = inputDefinition(game.input);
  const input = createInput({ sources: replay ? [replaySource(replay)] : inputSources(game.input, canvas), actions, axes });
  const footOffset = game.player.footOffset;
  const start = nodeTranslation(recipe.nodes, game.player.node);
  const body = { position: [0, 0, 0], rotationY: 0 };
  let rig = null;
  // The animation graph runtime loads only for a recipe that declares an animation or an NPC, so other games do not carry it.
  const hasAnimation = Boolean(game.player.animation) || (game.npcs?.length ?? 0) > 0;
  const { createGameAnimation, createPathFollower } = hasAnimation ? await loadAnimationRuntime() : {};
  const playerAnimation = game.player.animation ? createGameAnimation(game.player.animation, recipe.nodes, game.player.node, { assets }) : null;
  const startPosition = [start[0], start[1] - footOffset, start[2]];
  // Any other name is a kind a host registered with registerController, such as one from an allowlisted addon.
  const customKind = !['character', 'vehicle'].includes(game.player.controller);
  const controller = customKind
    ? createController(game.player.controller, { input, position: startPosition, ground: game.ground, node: body })
    : game.player.controller === 'vehicle'
    ? createVehicleController({ input, position: startPosition, ground: game.ground, maximumSpeed: game.player.maximumSpeed, node: body })
    : createCharacterController({
      input,
      position: startPosition,
      ground: game.ground,
      walkSpeed: game.player.walkSpeed,
      runSpeed: game.player.runSpeed,
      jumpSpeed: game.player.jumpSpeed,
      faceCamera: game.camera === 'first-person',
      cameraYaw: () => rig?.yaw ?? 0,
      node: body,
      ...(playerAnimation?.hasRootMotion ? { rootMotion: () => playerAnimation.graph.rootMotion.delta } : {}),
    });
  rig = cameraRigFor(game.camera, controller, input);

  const nodeIds = new Set(recipe.nodes.map(node => node.id));
  const rules = game.rules ? createGameRules(game.rules, { input, getPartPosition: id => (id === game.player.node ? [...controller.state.position] : undefined) }) : null;
  const shownNodes = new Map();
  const animatedCharacters = [];
  const animationSystems = [];
  if (playerAnimation) {
    animatedCharacters.push(playerAnimation);
    animationSystems.push(parameterSystem(playerAnimation, controller.state), playerAnimation.graph.system());
  }
  const npcs = (game.npcs ?? []).map(npc => {
    const animation = createGameAnimation(npc.animation, recipe.nodes, npc.node, { assets });
    const start = nodeTranslation(recipe.nodes, npc.node);
    const follower = createPathFollower({ graph: animation.graph, position: [start[0], start[1] - npc.footOffset, start[2]], yaw: npc.yaw, cruiseSpeed: npc.cruiseSpeed });
    follower.follow(npc.path);
    animatedCharacters.push(animation);
    animationSystems.push(follower.system(), animation.graph.system());
    return { node: npc.node, footOffset: npc.footOffset, follower, graph: animation.graph, modelYaw: modelYawOf(animation) };
  });
  const hasPosedAssets = animatedCharacters.some(animation => animation.assetNode);
  let drawnTopology = scene.topologyRevision;
  const status = showStatus && rules ? createStatusLine(canvas) : null;
  if (status) cleanups.push(() => status.remove());

  const sceneSystem = {
    name: 'scene',
    update(deltaSeconds, context) {
      const position = controller.positionAt(context.alpha);
      const operations = [characterOperation(game.player.node, position, body.rotationY, footOffset, modelYawOf(playerAnimation))];
      for (const npc of npcs) operations.push(characterOperation(npc.node, npc.follower.state.position, npc.follower.state.yaw, npc.footOffset, npc.modelYaw));
      for (const animation of animatedCharacters) operations.push(...animation.operations());
      for (const part of rules?.state.parts ?? []) {
        if (!nodeIds.has(part.id) || part.id === game.player.node || shownNodes.get(part.id) === part.visible) continue;
        shownNodes.set(part.id, part.visible);
        operations.push({ type: 'set-node', id: part.id, visible: part.visible });
      }
      scene.apply(operations, { expectedRevision: scene.revision });
      if (hasPosedAssets) {
        for (const animation of animatedCharacters) if (animation.assetNode) scene.setAssetPose(animation.assetNode, animation.assetPose());
        scene.sampleMotion(context.elapsedSeconds % 3600);
      }
      if (scene.topologyRevision === drawnTopology) {
        renderer.updateParts(scene.parts);
      } else {
        renderer.replaceParts(scene.parts);
        drawnTopology = scene.topologyRevision;
      }
      if (status) status.textContent = describeState(rules.state);
    },
  };

  const baseCamera = scene.camera;
  const runtime = createRuntime(renderer, {
    fixedRate: 60,
    systems: [input, controller, ...animationSystems, rig, ...(rules ? [rules] : []), sceneSystem],
    frame: context => ({ ...baseCamera, ...rig.pose(context), environment, time: context.elapsedSeconds }),
  });
  cleanups.push(() => runtime.dispose());
  const resize = () => renderer.resize();
  globalThis.addEventListener?.('resize', resize);
  cleanups.push(() => globalThis.removeEventListener?.('resize', resize));
  resize();
  runtime.start();

  return { scene, runtime, rules, input, controller, renderer, animation: playerAnimation?.graph ?? null, npcs };
}
