import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir, constants, setPriority } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { chromium } from 'playwright-core';

// Proves the game path end to end: an agent builds a creature that runs and jumps to collect 3 coins and reach a goal using
// only MCP tools, exports it as a static web build, and a recorded input replay wins the game in headless Chrome on the GPU.
// A second sample drives a car through 3 gates to a finish line. Run it through your GPU lock if the machine is shared:
// node scripts/smoke-game-web.mjs [path to 67js-mcp.mjs] [creature|drive]

setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL);
const CHROME_PATH = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const directory = await mkdtemp(join(tmpdir(), '67js-game-web-'));
const cli = resolve(process.argv[2] ?? 'bin/67js-mcp.mjs');
const MIME_TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json' };

const transport = new StdioClientTransport({ command: process.execPath, args: [cli, '--backend', 'cpu', '--memory', '128', '--jobs', join(directory, 'jobs')], cwd: directory, stderr: 'pipe' });
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
      { id: 'grass', color: [0.2, 0.45, 0.2] }, { id: 'fur', color: [0.85, 0.45, 0.2] },
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
  const game = {
    player: { node: 'creature', footOffset: 0.5 },
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
  return { recipe, game, replay, title: 'Creature run', expectedScore: 3 };
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

const SAMPLES = { creature: creatureSample, drive: driveSample };
const sampleName = process.argv[3] ?? 'creature';
assert.ok(SAMPLES[sampleName], `Unknown sample "${sampleName}". Use one of: ${Object.keys(SAMPLES).join(', ')}.`);
const { recipe, game, replay, title, expectedScore } = SAMPLES[sampleName]();

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
  browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 640, height: 400 } });
  const problems = [];
  page.on('pageerror', error => problems.push(error.message));
  page.on('console', message => { if (message.type() === 'error') problems.push(message.text()); });
  await page.goto(`http://127.0.0.1:${server.address().port}/?replay=replay.json`);
  await page.waitForFunction(() => window.__game?.rules?.state.status === 'won', null, { timeout: 60000 }).catch(async error => {
    const snapshot = await page.evaluate(() => ({ rules: window.__game?.rules?.state, player: window.__game?.controller?.state?.position })).catch(() => null);
    throw new Error(`${error.message}\npage problems: ${problems.join(' | ')}\nstate: ${JSON.stringify(snapshot)}`);
  });
  const state = await page.evaluate(() => ({ ...window.__game.rules.state, y: window.__game.controller.state.position[1] }));
  assert.equal(state.status, 'won');
  assert.equal(state.variables.score, expectedScore);
  assert.deepEqual(problems, []);
  await page.screenshot({ path: join(directory, 'won.png') });
  console.log(JSON.stringify({ ok: true, bytes: exported.bytes, files: exported.files, step: state.step, screenshot: join(directory, 'won.png') }));
} catch (error) {
  console.error(diagnostics);
  throw error;
} finally {
  await browser?.close();
  server?.close();
  await client.close();
}
