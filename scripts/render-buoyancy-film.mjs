// Film of crates and a boat bobbing on ocean waves through the MCP render job, for the buoyancy docs and the pull request.
// Usage: node scripts/render-buoyancy-film.mjs [--backend gpu|cpu] [--width 640] [--height 360] [--duration 4] [--out artifacts/982]
// The boat is the CC0 Kenney Watercraft Kit `boat-fishing-small.glb`; it is downloaded next to the output on first use.
// CHROME_PATH names another Chrome or Chromium executable. --vulkan wraps the Chrome it finds with the flags a Linux GPU box needs.
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const KIT_URL = 'https://raw.githubusercontent.com/leaukojo/carlito/HEAD/kit/raw/watercraft';
const BOAT_FILE = 'boat-fishing-small.glb';
const BOAT_SIZE = { width: 1.78, length: 3.87, hullHeight: 0.7 };

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

const backend = option('backend', 'gpu');
const width = Number(option('width', 640));
const height = Number(option('height', 360));
const duration = Number(option('duration', 4));
const outputFolder = resolve(option('out', 'artifacts/982'));
const assetFolder = join(outputFolder, 'assets');
const jobsFolder = join(outputFolder, 'jobs');

/** A shell wrapper that starts the installed Chrome with Vulkan GPU flags, for the server's --browser option. */
function vulkanChromeWrapper() {
  const names = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'];
  const found = names.map(name => spawnSync('which', [name], { encoding: 'utf8' }).stdout.trim()).find(Boolean);
  if (!found) throw new Error('No Chrome or Chromium on the PATH; install one or pass CHROME_PATH.');
  const wrapper = join(tmpdir(), 'chrome-vulkan.sh');
  writeFileSync(wrapper, `#!/bin/sh
exec ${found} --use-angle=vulkan --enable-features=Vulkan --ignore-gpu-blocklist --no-sandbox "$@"
`);
  chmodSync(wrapper, 0o755);
  return wrapper;
}

// Only these kit files are fetched, so a download can never write outside the asset folder.
const KIT_FILES = new Map([[BOAT_FILE, BOAT_FILE], ['Textures/colormap.png', 'Textures/colormap.png']]);

async function fetchKitFile(relativePath) {
  const knownPath = KIT_FILES.get(relativePath);
  if (!knownPath) throw new Error(`Unknown kit file ${relativePath}; add it to KIT_FILES first.`);
  const target = join(assetFolder, knownPath);
  const response = await fetch(`${KIT_URL}/${knownPath}`);
  if (!response.ok) throw new Error(`Could not download ${knownPath}: HTTP ${response.status}`);
  try {
    await writeFile(target, Buffer.from(await response.arrayBuffer()), { flag: 'wx' });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
}

function crate(id, translation, density) {
  return { node: { id, geometry: 'crate', material: 'wood', translation, scale: [0.9, 0.9, 0.9] }, body: { node: id, density, float: {} } };
}

function buildRecipe(boatAssetId) {
  const crates = [
    crate('crate-a', [-3.2, 1.1, 2.2], 350), crate('crate-b', [3.4, 1.0, -1.4], 500), crate('crate-c', [-2.6, 1.2, -3.2], 600),
    crate('crate-d', [2.8, 1.0, 3.1], 250), crate('crate-e', [0.4, 1.1, -4.4], 450),
  ];
  const seaEdits = [
    { op: 'delete', select: { not: { normal: [0, 1, 0], maxAngle: 10 } } },
    { op: 'subdivide_edges', edges: { all: true }, cuts: 16 },
    { op: 'subdivide', levels: 2 },
    { op: 'set_position', position: { mul: [{ attr: 'position' }, [40, 1, 40]] } },
  ];
  const boatLift = BOAT_SIZE.hullHeight / 2;
  return {
    format: '67js.scene', schemaVersion: 1,
    geometries: [
      { id: 'crate', type: 'box' },
      { id: 'hull', type: 'box' },
      { id: 'sea', type: 'mesh', base: { type: 'box', bevel: 0 }, edits: seaEdits, stack: [{ op: 'ocean', windSpeed: 4.5, choppiness: 0.4, size: 30, seed: 5, resolution: 5 }] },
    ],
    materials: [
      { id: 'wood', color: [0.55, 0.34, 0.16], roughness: 0.8 },
      { id: 'water', color: [0.02, 0.12, 0.2], tag: 'water' },
      { id: 'ghost', color: [1, 1, 1], opacity: 0 },
    ],
    nodes: [
      { id: 'sea', geometry: 'sea', material: 'water' },
      ...crates.map(entry => entry.node),
      { id: 'hull', geometry: 'hull', material: 'ghost', castShadow: false, translation: [0, 1.2, 0], scale: [BOAT_SIZE.width, BOAT_SIZE.hullHeight, BOAT_SIZE.length] },
      { id: 'boat', parent: 'hull', asset: { id: boatAssetId }, translation: [0, -boatLift / BOAT_SIZE.hullHeight, 0], scale: [1 / BOAT_SIZE.width, 1 / BOAT_SIZE.hullHeight, 1 / BOAT_SIZE.length] },
    ],
    camera: { eye: [6.5, 2.9, 8], target: [0, 0.8, 0], fov: 42 },
    motion: { duration, tracks: [{ kind: 'geometry', id: 'sea', property: 'oceanTime', interpolation: 'LINEAR', keyframes: [{ time: 0, value: 0 }, { time: duration, value: duration }] }] },
    physics: {
      duration,
      ocean: { geometry: 'sea' },
      bodies: [
        ...crates.map(entry => entry.body),
        { node: 'hull', density: 300, float: { drag: 1.5, angularDrag: 1.5, points: [[-0.6, 0, -1.4], [0.6, 0, -1.4], [-0.6, 0, 1.4], [0.6, 0, 1.4]] } },
      ],
    },
  };
}

await mkdir(join(assetFolder, 'Textures'), { recursive: true });
await mkdir(jobsFolder, { recursive: true });
await fetchKitFile(BOAT_FILE);
await fetchKitFile('Textures/colormap.png');

const serverArguments = [resolve('bin/67js-mcp.mjs'), '--backend', backend, '--memory', '384', '--assets', assetFolder, '--jobs', jobsFolder];
const browserPath = process.argv.includes('--vulkan') ? vulkanChromeWrapper() : process.env.CHROME_PATH;
if (browserPath) serverArguments.push('--browser', browserPath);
const transport = new StdioClientTransport({ command: process.execPath, args: serverArguments, stderr: 'inherit' });
const client = new Client({ name: '67js-buoyancy-film', version: '1' });

async function call(name, argumentsValue = {}, timeout = 120000) {
  const result = await client.callTool({ name, arguments: argumentsValue }, { timeout });
  if (result.isError) throw new Error(`${name}: ${result.content?.find(item => item.type === 'text')?.text}`);
  return result;
}

try {
  await client.connect(transport);
  const catalog = (await call('scene_asset_catalog')).structuredContent;
  const boat = catalog.assets.find(asset => JSON.stringify(asset).includes('boat-fishing-small'));
  if (!boat) throw new Error(`The catalog has no boat: ${JSON.stringify(catalog).slice(0, 400)}`);
  const created = (await call('scene_create', { recipe: buildRecipe(boat.assetId) }, 300000)).structuredContent;
  const report = (await call('scene_inspect', { sessionId: created.sessionId })).structuredContent.physics;
  console.log(JSON.stringify(report.bodies.map(body => [body.node, body.finalPosition])));
  const still = (await call('scene_look', { sessionId: created.sessionId, width: 1024, height: 576, motionTime: duration * 0.6 })).content.find(item => item.type === 'image');
  await writeFile(join(outputFolder, 'buoyancy-still.png'), Buffer.from(still.data, 'base64'));
  const job = (await call('scene_render_submit', { sessionId: created.sessionId, expectedRevision: created.revision ?? 0, settings: { kind: 'video', width, height, fps: 24, duration, motion: { start: 0 } } })).structuredContent;
  for (;;) {
    const state = (await call('scene_render_status', { jobId: job.jobId })).structuredContent;
    if (['completed', 'failed', 'cancelled'].includes(state.state)) {
      if (state.state !== 'completed') throw new Error(`Render ${state.state}: ${JSON.stringify(state).slice(0, 400)}`);
      break;
    }
    await delay(500);
  }
  const result = (await call('scene_render_result', { jobId: job.jobId })).structuredContent;
  await writeFile(join(outputFolder, 'buoyancy.mp4'), await readFile(result.artifacts[0].path));
  console.log(`wrote ${join(outputFolder, 'buoyancy.mp4')}`);
} finally {
  await client.close();
}
