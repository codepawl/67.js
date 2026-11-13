import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir, constants, setPriority } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { chromium } from 'playwright-core';
import { MIXAMO_LIKE, UNREAL_LIKE, humanoidGlb, humanoidJoints, walkTracks } from '../tests/fixtures/humanoid-glb.js';

// Proves the game path end to end: an agent builds a creature that runs and jumps to collect 3 coins and reach a goal using
// only MCP tools, exports it as a static web build, and a recorded input replay wins the game in headless Chrome on the GPU.
// A second sample drives a car through 3 gates to a finish line, and a third walks a placed, retargeted humanoid to a goal while
// its idle and walk clips blend by speed (the page loads the exported assets/<id>.glb files). Run it through your GPU lock if the machine is shared:
// node scripts/smoke-game-web.mjs [path to 67js-mcp.mjs] [creature|drive|character]

setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL);
const CHROME_PATH = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const directory = await mkdtemp(join(tmpdir(), '67js-game-web-'));
const cli = resolve(process.argv[2] ?? 'bin/67js-mcp.mjs');
const MIME_TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.glb': 'model/gltf-binary', '.wasm': 'application/wasm' };

const assetsDirectory = join(directory, 'assets');
await mkdir(assetsDirectory);
const transport = new StdioClientTransport({ command: process.execPath, args: [cli, '--backend', 'cpu', '--memory', '128', '--jobs', join(directory, 'jobs'), '--assets', assetsDirectory], cwd: directory, stderr: 'pipe' });
let diagnostics = '';
transport.stderr.on('data', bytes => { diagnostics = (diagnostics + bytes).slice(-8192); });
const client = new Client({ name: '67js-game-web-proof', version: '1' });

async function call(name, argumentsValue = {}) {
  const result = await client.callTool({ name, arguments: argumentsValue }, { timeout: 60000 });
  assert.equal(result.isError, undefined, result.content?.find(item => item.type === 'text')?.text);
  return result.structuredContent ?? JSON.parse(result.content.find(item => item.type === 'text').text);
}

async function callExpectingError(name, argumentsValue) {
  const result = await client.callTool({ name, arguments: argumentsValue }, { timeout: 60000 });
  assert.equal(result.isError, true, `${name} should have been refused`);
  return result.content.find(item => item.type === 'text').text;
}

function creatureSample() {
  const COINS = [[0, 0.5, -3], [0, 0.5, -6], [0, 0.5, -9]];
  const GOAL = [0, 1, -12];
  const recipe = {
    format: '67js.scene', schemaVersion: 1,
    geometries: [{ id: 'block', type: 'box', bevel: 0 }, { id: 'ball', type: 'sphere' }],
    materials: [
      { id: 'grass', color: [1, 1, 1], pattern: { type: 'stone', size: 2 } }, { id: 'fur', color: [0.85, 0.45, 0.2] },
      { id: 'gold', color: [0.95, 0.75, 0.1], metallic: 0.8, roughness: 0.3 }, { id: 'flag', color: [0.2, 0.4, 0.9] },
    ],
    nodes: [
      { id: 'floor', geometry: 'block', material: 'grass', translation: [0, -0.1, -6], scale: [12, 0.2, 24] },
      { id: 'creature', translation: [0, 0.5, 0] },
      { id: 'body', parent: 'creature', geometry: 'block', material: 'fur', scale: [0.8, 0.8, 1.2] },
      { id: 'head', parent: 'creature', geometry: 'ball', material: 'fur', translation: [0, 0.35, -0.6], scale: [0.5, 0.5, 0.5] },
      ...COINS.map((translation, index) => ({ id: `coin-${index + 1}`, geometry: 'ball', material: 'gold', translation, scale: [0.4, 0.4, 0.4] })),
      { id: 'goal', geometry: 'block', material: 'flag', translation: GOAL, scale: [1.5, 2, 0.2] },
    ],
    camera: { eye: [4, 4, 6], target: [0, 0.5, -3], fov: 50 },
  };
  const coinRules = COINS.map((center, index) => ({
    id: `collect-${index + 1}`, once: true,
    when: { type: 'enter', zone: `coin-zone-${index + 1}`, tag: 'player' },
    do: [{ type: 'add', variable: 'score', value: 1 }, { type: 'hide', part: `coin-${index + 1}` }],
  }));
  // The head bobs while the creature moves: the exported page must play this graph, not only carry it.
  const HEAD_REST = [0, 0.35, -0.6];
  const HEAD_BOB_HEIGHT = 0.2;
  const animation = {
    clips: {
      idle: { duration: 1, loop: true, tracks: [{ target: 'head', property: 'translation', keyframes: [{ time: 0, value: HEAD_REST }, { time: 1, value: HEAD_REST }] }] },
      bob: {
        duration: 0.5, loop: true,
        tracks: [{ target: 'head', property: 'translation', keyframes: [{ time: 0, value: HEAD_REST }, { time: 0.25, value: [0, HEAD_REST[1] + HEAD_BOB_HEIGHT, HEAD_REST[2]] }, { time: 0.5, value: HEAD_REST }] }],
      },
    },
    parameters: { speed: { type: 'number' } },
    layers: [{ name: 'base', states: [{ name: 'move', blend: { parameter: 'speed', motions: [{ clip: 'idle', threshold: 0 }, { clip: 'bob', threshold: 1 }] } }] }],
  };
  const game = {
    player: { node: 'creature', footOffset: 0.5, animation },
    camera: 'follow',
    input: 'keyboard',
    rules: {
      version: 1,
      variables: { score: 0 },
      zones: [...COINS.map((center, index) => ({ id: `coin-zone-${index + 1}`, shape: 'sphere', center: [center[0], 0.5, center[2]], radius: 1.2 })),
        { id: 'goal-zone', shape: 'box', center: [0, 1, GOAL[2]], size: [3, 4, 2] }],
      parts: [{ id: 'creature', tags: ['player'] }, ...COINS.map((center, index) => ({ id: `coin-${index + 1}`, tags: ['coin'] }))],
      rules: [...coinRules, { id: 'reach-goal', when: { type: 'enter', zone: 'goal-zone', tag: 'player' }, if: ['>=', 'score', 3], do: [{ type: 'win' }] }],
    },
  };
  // Hold forward and run from sample 1, press jump at sample 40, and let go at sample 240.
  const replay = { version: 1, samples: 260, truncated: false, events: [[1, 'keyboard/KeyW', 1], [1, 'keyboard/ShiftLeft', 1], [40, 'keyboard/Space', 1], [42, 'keyboard/Space', 0], [240, 'keyboard/KeyW', 0], [240, 'keyboard/ShiftLeft', 0]] };
  return { recipe, game, replay, title: 'Creature run', expectedScore: 3, headRestHeight: HEAD_REST[1] };
}

function driveSample() {
  const checkpointZs = [-10, -20, -30];
  const finishZ = -40;
  const recipe = {
    format: '67js.scene', schemaVersion: 1,
    geometries: [{ id: 'block', type: 'box', bevel: 0 }],
    materials: [{ id: 'asphalt', color: [0.2, 0.2, 0.22] }, { id: 'paint', color: [0.8, 0.15, 0.1] }, { id: 'gate', color: [0.95, 0.75, 0.1] }],
    nodes: [
      { id: 'road', geometry: 'block', material: 'asphalt', translation: [0, -0.1, -22], scale: [8, 0.2, 52] },
      { id: 'car', translation: [0, 0.4, 0] },
      { id: 'car-body', parent: 'car', geometry: 'block', material: 'paint', scale: [1.2, 0.5, 2.4] },
      ...checkpointZs.map((z, index) => ({ id: `gate-${index + 1}`, geometry: 'block', material: 'gate', translation: [0, 0.6, z], scale: [5, 1.2, 0.2] })),
    ],
    camera: { eye: [5, 5, 8], target: [0, 0.5, -6], fov: 50 },
  };
  const game = {
    player: { node: 'car', controller: 'vehicle', maximumSpeed: 20, footOffset: 0.4 },
    camera: 'chase',
    input: 'keyboard',
    rules: {
      version: 1,
      variables: { score: 0 },
      zones: [...checkpointZs.map((z, index) => ({ id: `gate-zone-${index + 1}`, shape: 'box', center: [0, 1, z], size: [6, 3, 3] })),
        { id: 'finish-zone', shape: 'box', center: [0, 1, finishZ], size: [8, 3, 3] }],
      parts: [{ id: 'car', tags: ['player'] }, ...checkpointZs.map((z, index) => ({ id: `gate-${index + 1}`, tags: ['gate'] }))],
      rules: [...checkpointZs.map((z, index) => ({ id: `pass-${index + 1}`, once: true, when: { type: 'enter', zone: `gate-zone-${index + 1}`, tag: 'player' }, do: [{ type: 'add', variable: 'score', value: 1 }, { type: 'hide', part: `gate-${index + 1}` }] })),
        { id: 'finish', when: { type: 'enter', zone: 'finish-zone', tag: 'player' }, if: ['>=', 'score', 3], do: [{ type: 'win' }] }],
    },
  };
  // Hold the throttle for the whole run; the car takes about 3 s to cover 40 m.
  const replay = { version: 1, samples: 400, truncated: false, events: [[1, 'keyboard/KeyW', 1], [380, 'keyboard/KeyW', 0]] };
  return { recipe, game, replay, title: 'Drive', expectedScore: 3 };
}

function characterSample() {
  const WALK_SPEED = 1.2;
  const GOAL_Z = -4;
  const sourceJoints = humanoidJoints();
  const clip = (name, duration, speed) => ({ name, duration, tracks: walkTracks(sourceJoints, { speed, duration }) });
  const sourceBytes = Buffer.from(humanoidGlb({ names: MIXAMO_LIKE, joints: sourceJoints, clips: [clip('Idle', 1, 0), clip('Walk', 1, WALK_SPEED)] }));
  const heroBytes = Buffer.from(humanoidGlb({ names: UNREAL_LIKE, joints: humanoidJoints({ armTiltDegrees: 30 }) }));
  const idOf = bytes => createHash('sha256').update(bytes).digest('hex');
  const sourceId = idOf(sourceBytes);
  const heroId = idOf(heroBytes);
  const recipe = {
    format: '67js.scene', schemaVersion: 1,
    geometries: [{ id: 'block', type: 'box', bevel: 0 }],
    materials: [{ id: 'grass', color: [0.2, 0.45, 0.2] }],
    nodes: [
      { id: 'floor', geometry: 'block', material: 'grass', translation: [0, -0.1, -4], scale: [10, 0.2, 14] },
      { id: 'Hero', asset: { id: heroId } },
    ],
    camera: { eye: [3, 2, 3], target: [0, 1, -2], fov: 50 },
  };
  const game = {
    player: {
      node: 'Hero', walkSpeed: WALK_SPEED, runSpeed: 2.4,
      animation: {
        clips: { idle: { from: { asset: sourceId, clip: 0 } }, walk: { from: { asset: sourceId, clip: 1 } } },
        parameters: { speed: { type: 'number' } },
        rootMotion: { bone: UNREAL_LIKE.hips },
        layers: [{ name: 'base', states: [{ name: 'move', blend: { parameter: 'speed', motions: [{ clip: 'idle', threshold: 0 }, { clip: 'walk', threshold: WALK_SPEED }] } }] }],
      },
    },
    camera: 'follow',
    input: 'keyboard',
    rules: {
      version: 1,
      zones: [{ id: 'goal-zone', shape: 'box', center: [0, 1, GOAL_Z], size: [3, 4, 2] }],
      parts: [{ id: 'Hero', tags: ['player'] }],
      rules: [{ id: 'reach-goal', when: { type: 'enter', zone: 'goal-zone', tag: 'player' }, do: [{ type: 'win' }] }],
    },
  };
  // Hold forward from sample 1; at walking speed the character reaches the goal in about 3 s.
  const replay = { version: 1, samples: 400, truncated: false, events: [[1, 'keyboard/KeyW', 1], [390, 'keyboard/KeyW', 0]] };
  const assetFiles = { 'source.glb': sourceBytes, 'hero.glb': heroBytes };
  return { recipe, game, replay, title: 'Retargeted walk', expectedScore: undefined, assetFiles, expectedAssets: [sourceId, heroId] };
}

// Key events [sample, source, value] that push the crate on the left, cross over and push the crate on the right.
const PUZZLE_REPLAY_EVENTS = [
  [1, 'keyboard/KeyW', 1], [100, 'keyboard/KeyW', 0],
  [105, 'keyboard/KeyS', 1], [184, 'keyboard/KeyS', 0], [186, 'keyboard/KeyD', 1], [286, 'keyboard/KeyD', 0],
  [290, 'keyboard/KeyW', 1], [369, 'keyboard/KeyW', 0],
];

// A physics puzzle: push both crates into their pockets on the marble plates. The player is a kinematic body, the crates are
// dynamic bodies that the page steps with Jolt, and a rules zone sees a crate by its node id. Both plates pressed opens the gate.
function puzzleSample() {
  const POCKET_X = [-2.5, 2.5];
  const PLATE_Z = -6;
  const plateZoneIds = ['plate-zone-a', 'plate-zone-b'];
  const crateIds = ['crate-a', 'crate-b'];
  const recipe = {
    format: '67js.scene', schemaVersion: 1,
    geometries: [{ id: 'block', type: 'box', bevel: 0.03 }, { id: 'cylinder', type: 'cylinder', segments: 24 }, { id: 'dome', type: 'sphere' }],
    materials: [
      { id: 'flagstone', color: [1, 1, 1], roughness: 0.9, pattern: { type: 'stone', size: 2 } },
      { id: 'planks', color: [1, 1, 1], roughness: 0.75, pattern: { type: 'planks', size: 1 } },
      { id: 'bricks', color: [1, 1, 1], roughness: 0.95, pattern: { type: 'bricks', size: 1 } },
      { id: 'marble', color: [1, 1, 1], roughness: 0.3, pattern: { type: 'marble', size: 1 } },
      { id: 'iron', color: [1, 1, 1], metallic: 0.9, roughness: 0.45, pattern: { type: 'metal', size: 0.5 } },
      { id: 'cloth', color: [1, 1, 1], roughness: 0.8, pattern: { type: 'fabric', size: 0.25 } },
    ],
    nodes: [
      { id: 'floor', geometry: 'block', material: 'flagstone', translation: [0, -0.25, -4], scale: [14, 0.5, 14] },
      { id: 'hero', geometry: 'cylinder', material: 'cloth', translation: [POCKET_X[0], 0.8, 0], scale: [0.7, 1.6, 0.7] },
      ...POCKET_X.flatMap((x, index) => [
        { id: crateIds[index], geometry: 'block', material: 'planks', translation: [x, 0.5, -2.5], scale: [1, 1, 1] },
        { id: `plate-${'ab'[index]}`, geometry: 'block', material: 'marble', translation: [x, 0.02, PLATE_Z], scale: [1.4, 0.04, 1.4] },
        { id: `wall-${'ab'[index]}`, geometry: 'block', material: 'bricks', translation: [x, 0.75, -7.1], scale: [2, 1.5, 0.4] },
      ]),
      { id: 'gate', geometry: 'block', material: 'iron', translation: [0, 1, -7.1], scale: [2.4, 2, 0.3] },
      { id: 'beacon', geometry: 'dome', material: 'iron', translation: [0, 2.4, -7.1], scale: [0.5, 0.5, 0.5] },
    ],
    physics: {
      duration: 1,
      bodies: [
        { node: 'floor', type: 'fixed', shape: 'box' },
        { node: 'hero', type: 'kinematic', shape: 'capsule' },
        ...crateIds.map(node => ({ node, shape: 'box', density: 0.6, friction: 0.6 })),
        ...['wall-a', 'wall-b'].map(node => ({ node, type: 'fixed', shape: 'box' })),
      ],
    },
    camera: { eye: [0, 7, 7], target: [0, 0, -4], fov: 50 },
  };
  const game = {
    player: { node: 'hero', footOffset: 0.8 },
    camera: 'top-down',
    input: 'keyboard',
    physics: true,
    rules: {
      version: 1,
      variables: { pressed: 0 },
      zones: POCKET_X.map((x, index) => ({ id: plateZoneIds[index], shape: 'box', center: [x, 0.5, PLATE_Z], size: [1.4, 2, 1.4] })),
      parts: [{ id: 'hero', tags: ['player'] }, { id: 'gate', tags: ['gate'] }, ...crateIds.map(id => ({ id, tags: ['crate'] }))],
      rules: [
        ...plateZoneIds.map(zone => ({ id: `press-${zone}`, once: true, when: { type: 'enter', zone, tag: 'crate' }, do: [{ type: 'add', variable: 'pressed', value: 1 }] })),
        { id: 'open-gate', when: { type: 'variable', expression: ['>=', 'pressed', 2] }, do: [{ type: 'hide', part: 'gate' }, { type: 'win' }] },
      ],
    },
  };
  // Walk forward and push the first crate into its pocket; back off, cross to the second crate and push it in too.
  const replay = { version: 1, samples: 460, truncated: false, events: PUZZLE_REPLAY_EVENTS };
  return { recipe, game, replay, title: 'Crate pockets', expectedScore: undefined, puzzle: { crateIds, minimumTravel: 2 } };
}

const SAMPLES = { creature: creatureSample, drive: driveSample, character: characterSample, puzzle: puzzleSample };
const sampleName = process.argv[3] ?? 'creature';
assert.ok(SAMPLES[sampleName], `Unknown sample "${sampleName}". Use one of: ${Object.keys(SAMPLES).join(', ')}.`);
const { recipe, game, replay, title, expectedScore, headRestHeight, assetFiles = {}, expectedAssets = [], puzzle } = SAMPLES[sampleName]();
for (const [name, bytes] of Object.entries(assetFiles)) await writeFile(join(assetsDirectory, name), bytes);

function serveFolder(folder) {
  const server = createServer(async (request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname;
    try {
      const file = path === '/' ? 'index.html' : path.slice(1);
      const body = await readFile(join(folder, file));
      response.writeHead(200, { 'content-type': MIME_TYPES[extname(file)] ?? 'application/octet-stream' });
      response.end(body);
    } catch {
      response.writeHead(404).end();
    }
  });
  return new Promise(resolveListening => server.listen(0, '127.0.0.1', () => resolveListening(server)));
}

let browser;
let pageContext;
let server;
try {
  await client.connect(transport);
  await call('scene_create', { recipe });

  const badNode = await callExpectingError('scene_apply', { expectedRevision: 0, operations: [{ type: 'set-game', game: { ...game, player: { node: 'creatur' } } }] });
  assert.match(badNode, /player\.node.*creatur.*Use one of/s);
  const badRules = await callExpectingError('scene_apply', { expectedRevision: 0, operations: [{ type: 'set-game', game: { ...game, rules: { version: 1, parts: [{ id: 'coin-1', tags: ['coin'] }] } } }] });
  assert.match(badRules, new RegExp(`rules\\.parts has no part "${game.player.node}"`));
  const noGame = await callExpectingError('scene_export_web', {});
  assert.match(noGame, /no game/);

  await call('scene_apply', { expectedRevision: 0, operations: [{ type: 'set-game', game }] });
  const capabilities = await call('scene_capabilities', { topic: 'game' });
  assert.ok(capabilities.value?.fields ?? capabilities.fields, 'scene_capabilities topic game answers');
  const exported = await call('scene_export_web', { title });
  assert.ok(exported.bytes < 12 * 1024 * 1024, `bytes ${exported.bytes}`);
  const folder = dirname(exported.entry);
  await writeFile(join(folder, 'replay.json'), JSON.stringify(replay));

  server = await serveFolder(folder);
  // GAME_SMOKE_CHROME_ARGS replaces the Chrome flags (a Linux GPU box needs Vulkan ones); GAME_SMOKE_VIDEO_DIR records the page as a 640x360 clip.
  const chromeArgs = process.env.GAME_SMOKE_CHROME_ARGS ? process.env.GAME_SMOKE_CHROME_ARGS.split(' ') : ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'];
  browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true, args: chromeArgs });
  const videoDirectory = process.env.GAME_SMOKE_VIDEO_DIR;
  const viewport = videoDirectory ? { width: 640, height: 360 } : { width: 640, height: 400 };
  pageContext = await browser.newContext({ viewport, ...(videoDirectory ? { recordVideo: { dir: videoDirectory, size: viewport } } : {}) });
  const page = await pageContext.newPage();
  const problems = [];
  const origin = `http://127.0.0.1:${server.address().port}`;
  const requested = [];
  page.on('request', request => requested.push(request.url()));
  page.on('pageerror', error => problems.push(error.message));
  page.on('console', message => { if (message.type() === 'error') problems.push(message.text()); });
  await page.goto(`http://127.0.0.1:${server.address().port}/?replay=replay.json`);
  if (headRestHeight !== undefined) {
    // While the replay runs, the speed parameter rises and the bob clip lifts the head off its rest height.
    await page.waitForFunction(restHeight => {
      const head = window.__game?.scene.exportRecipe().nodes.find(node => node.id === 'head');
      return head && Math.abs(head.translation[1] - restHeight) > 0.02;
    }, headRestHeight, { timeout: 60000, polling: 'raf' });
  }
  if (expectedAssets.length > 0) {
    // The character is a skinned asset: while the replay walks it, some part must rise and fall as the walk clip plays.
    await page.waitForFunction(() => {
      const ranges = (window.__heightRanges ??= new Map());
      for (const part of window.__game?.scene.parts ?? []) {
        if (!part.name.startsWith('Hero/')) continue;
        const range = ranges.get(part.name) ?? { low: Infinity, high: -Infinity };
        range.low = Math.min(range.low, part.matrix[13]);
        range.high = Math.max(range.high, part.matrix[13]);
        ranges.set(part.name, range);
      }
      return [...ranges.values()].some(range => range.high - range.low > 0.02);
    }, null, { timeout: 60000, polling: 'raf' });
  }
  await page.waitForFunction(() => window.__game?.rules?.state.status === 'won', null, { timeout: 60000 }).catch(async error => {
    const snapshot = await page.evaluate(() => ({ rules: window.__game?.rules?.state, player: window.__game?.controller?.state?.position })).catch(() => null);
    throw new Error(`${error.message}\npage problems: ${problems.join(' | ')}\nstate: ${JSON.stringify(snapshot)}`);
  });
  const state = await page.evaluate(() => ({ ...window.__game.rules.state, y: window.__game.controller.state.position[1] }));
  assert.equal(state.status, 'won');
  if (expectedScore !== undefined) assert.equal(state.variables.score, expectedScore);
  assert.deepEqual(problems, []);
  if (game.player.animation) {
    const speed = await page.evaluate(() => window.__game.animation.get('speed'));
    assert.ok(speed >= 0, 'the exported page has a live animation graph with a speed parameter');
  }
  const hasPhysicsFiles = await readFile(join(folder, 'engine/physics/jolt-physics.wasm.wasm')).then(() => true, () => false);
  assert.equal(hasPhysicsFiles, Boolean(puzzle), 'only an export with game.physics carries the physics engine');
  if (puzzle) {
    // The page stepped the world: both crates were pushed along the floor by the kinematic player, and the gate part opened.
    const crates = await page.evaluate(ids => ({ steps: window.__game.physics.stepCount, poses: ids.map(id => window.__game.physics.getPose(id).translation) }), puzzle.crateIds);
    assert.ok(crates.steps > 100, `physics stepped ${crates.steps} times`);
    for (const translation of crates.poses) assert.ok(translation[2] < -2.5 - puzzle.minimumTravel, `a crate was pushed to z ${translation[2]}`);
    assert.equal(state.variables.pressed, 2);
    const stray = requested.filter(url => !url.startsWith(origin) && !url.startsWith('data:'));
    assert.deepEqual(stray, [], 'the page loads nothing from another origin');
    assert.ok(requested.some(url => url === `${origin}/engine/physics/jolt-physics.wasm.wasm`), 'the wasm file loads from beside the page');
    console.log(JSON.stringify({ crates: crates.poses }));
  }
  for (const id of expectedAssets) assert.ok(await readFile(join(folder, 'assets', `${id}.glb`)), `the export writes assets/${id}.glb`);
  await page.screenshot({ path: join(directory, 'won.png') });
  console.log(JSON.stringify({ ok: true, bytes: exported.bytes, files: exported.files, step: state.step, screenshot: join(directory, 'won.png') }));
} catch (error) {
  console.error(diagnostics);
  throw error;
} finally {
  await pageContext?.close();
  await browser?.close();
  server?.close();
  await client.close();
}
