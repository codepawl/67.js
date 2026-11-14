// Proves the material layers and the per-shot depth of field through the real MCP server, with stills a person can read.
//  - glass: a surface ball with transmission bends the stripes behind it, and the same ball with transmission 0 does not;
//  - anisotropy: a stretched highlight differs from the round one, and rotating the grain turns it;
//  - iridescence: a thin film changes the colour of the reflection;
//  - shot depth of field: each shot of a timeline blurs and focuses by itself, and a seek repeats the same bytes.
// Usage: node scripts/smoke-material-layers.mjs [cli] [cpu|gpu]. Stills land in the folder named by LAYER_STILLS if set.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir, constants, setPriority } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL);
const directory = await mkdtemp(join(tmpdir(), 'crucible-mcp-layers-'));
const jobs = join(directory, 'jobs');
const cli = resolve(process.argv[2] ?? 'bin/crucible-mcp.mjs');
const backend = process.argv[3] ?? 'cpu';
const stillsFolder = process.env.LAYER_STILLS;
const transport = new StdioClientTransport({ command: process.execPath,
  args: [cli, '--backend', backend, '--memory', '128', '--jobs', jobs], cwd: directory, stderr: 'pipe' });
let diagnostics = '';
transport.stderr.on('data', bytes => { diagnostics = (diagnostics + bytes).slice(-8192); });
const client = new Client({ name: 'crucible-material-layers-proof', version: '1' });
const WIDTH = 320;
const HEIGHT = 240;

async function call(name, argumentsValue = {}, timeout = 120000) {
  const result = await client.callTool({ name, arguments: argumentsValue }, { timeout });
  assert.equal(result.isError, undefined, result.content?.find(item => item.type === 'text')?.text);
  return result;
}

async function waitForJob(jobId) {
  const deadline = Date.now() + 300000;
  while (Date.now() < deadline) {
    const record = (await call('scene_render_status', { jobId })).structuredContent;
    if (['completed', 'cancelled', 'failed'].includes(record.state)) return record;
    await delay(200);
  }
  throw new Error('Job did not finish in time.');
}

async function renderStill(recipe, settings = {}, name) {
  const created = (await call('scene_create', { recipe }, 180000)).structuredContent;
  const sessionId = created.sessionId;
  try {
    const submitted = (await call('scene_render_submit', { sessionId, expectedRevision: 0, settings: { kind: 'image', width: WIDTH, height: HEIGHT, ...settings } })).structuredContent;
    const record = await waitForJob(submitted.jobId);
    assert.equal(record.state, 'completed', record.reason);
    const result = (await call('scene_render_result', { jobId: submitted.jobId })).structuredContent;
    const path = result.artifacts[0].path;
    if (stillsFolder && name) {
      await mkdir(stillsFolder, { recursive: true });
      await copyFile(path, join(stillsFolder, `${name}.png`));
    }
    return await readFile(path);
  } finally {
    await call('scene_dispose', { sessionId }).catch(() => {});
  }
}

function decodeRgb(png) {
  const result = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { input: png, maxBuffer: 64 * 1024 ** 2 });
  assert.equal(result.status, 0, String(result.stderr));
  return result.stdout;
}

function meanAbsoluteDifference(first, second, region) {
  const firstPixels = decodeRgb(first);
  const secondPixels = decodeRgb(second);
  let total = 0;
  let count = 0;
  for (let row = region.top; row < region.bottom; row++) {
    for (let column = region.left; column < region.right; column++) {
      for (let channel = 0; channel < 3; channel++) {
        const index = (row * WIDTH + column) * 3 + channel;
        total += Math.abs(firstPixels[index] - secondPixels[index]);
        count++;
      }
    }
  }
  return total / count;
}

// Spread of the red channel along the middle row of a region: stripes seen through glass raise it, a flat ball does not.
function rowSpread(png, region) {
  const pixels = decodeRgb(png);
  const row = Math.floor((region.top + region.bottom) / 2);
  const values = [];
  for (let column = region.left; column < region.right; column++) values.push(pixels[(row * WIDTH + column) * 3]);
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length);
}

const STRIPE_COLORS = [[0.9, 0.05, 0.05], [0.95, 0.95, 0.95], [0.05, 0.1, 0.9]];

// A wall of vertical colour stripes with one ball in front of it, lit by the default studio.
function stripesBehindBall(material, { ballTag, extraLook } = {}) {
  const stripeNodes = [];
  const stripeMaterials = STRIPE_COLORS.map((color, index) => ({ id: `stripe${index}`, color, roughness: 0.8 }));
  for (let index = 0; index < 9; index++) {
    stripeNodes.push({ id: `stripe-${index}`, geometry: 'box', material: `stripe${index % 3}`, translation: [(index - 4) * 0.5, 1, -1.6], scale: [0.5, 3, 0.1] });
  }
  return {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'box', type: 'box' }, { id: 'sphere', type: 'sphere', segments: 48, rings: 32 }],
    materials: [{ id: 'floor', color: [0.12, 0.12, 0.13], roughness: 0.9 }, ...stripeMaterials, { id: 'ball', ...(ballTag ? { tag: ballTag } : {}), ...material }],
    nodes: [
      { id: 'floor', geometry: 'box', material: 'floor', translation: [0, -0.1, 0], scale: [12, 0.2, 12] },
      ...stripeNodes,
      { id: 'ball', geometry: 'sphere', material: 'ball', translation: [0, 1, 0], scale: [1.6, 1.6, 1.6] },
    ],
    camera: { eye: [0, 1.1, 5], target: [0, 1, 0], fov: 35 },
    ...extraLook,
  };
}

const BALL_REGION = { left: 125, right: 195, top: 85, bottom: 155 };

try {
  await client.connect(transport);
  const capabilities = (await call('scene_capabilities', { topic: 'materialLayers' })).structuredContent;
  const layerNames = Object.keys(capabilities.value ?? {});
  for (const field of ['clearcoat', 'transmission', 'thickness', 'ior', 'anisotropy', 'iridescence']) {
    assert.ok(layerNames.includes(field), `scene_capabilities materialLayers lists ${field}`);
  }

  // Glass: a recipe material asks for transmission with the surface tag.
  const glassMaterial = { color: [1, 1, 1], roughness: 0.02, metallic: 0, transmission: 1, thickness: 0.8, ior: 1.5 };
  const glass = await renderStill(stripesBehindBall(glassMaterial), {}, 'glass');
  const solid = await renderStill(stripesBehindBall({ ...glassMaterial, transmission: 0 }), {}, 'solid');
  const glassSpread = rowSpread(glass, BALL_REGION);
  const solidSpread = rowSpread(solid, BALL_REGION);
  assert.ok(glassSpread > solidSpread * 2, `Stripes should show through the glass ball (spread ${glassSpread.toFixed(1)} against ${solidSpread.toFixed(1)} for the same ball with no transmission).`);
  assert.ok(meanAbsoluteDifference(glass, solid, BALL_REGION) > 12, 'Glass and the opaque ball should differ inside the ball.');
  console.log(`glass: stripe spread ${glassSpread.toFixed(1)} against ${solidSpread.toFixed(1)} without transmission (${backend})`);

  // Anisotropy and iridescence on a brushed metal ball.
  const metal = { color: [0.9, 0.7, 0.4], metallic: 1, roughness: 0.35 };
  const round = await renderStill(stripesBehindBall(metal), {}, 'metal-round');
  const brushed = await renderStill(stripesBehindBall({ ...metal, anisotropy: 0.9 }), {}, 'metal-anisotropic');
  const turned = await renderStill(stripesBehindBall({ ...metal, anisotropy: 0.9, anisotropyRotation: Math.PI / 2 }), {}, 'metal-anisotropic-turned');
  assert.ok(meanAbsoluteDifference(round, brushed, BALL_REGION) > 2, 'Anisotropy should change the highlight.');
  assert.ok(meanAbsoluteDifference(brushed, turned, BALL_REGION) > 2, 'Rotating the grain should turn the highlight.');
  const plain = { color: [0.05, 0.05, 0.06], metallic: 0, roughness: 0.15 };
  const filmless = await renderStill(stripesBehindBall(plain), {}, 'film-off');
  const film = await renderStill(stripesBehindBall({ ...plain, iridescence: 1, iridescenceIor: 1.8, iridescenceThickness: 450 }), {}, 'film-on');
  assert.ok(meanAbsoluteDifference(filmless, film, BALL_REGION) > 2, 'A thin film should change the reflection colour.');
  console.log('anisotropy and iridescence stills differ from their plain twins');

  // A shot sets its own depth of field; a seek repeats the same bytes.
  const shotRecipe = stripesBehindBall({ color: [0.8, 0.8, 0.8], roughness: 0.5 }, {
    extraLook: { timeline: { shots: [
      { name: 'sharp', duration: 1 },
      { name: 'near', duration: 1, focusDistance: 5, blur: 1 },
      { name: 'far', duration: 1, focusDistance: 40, blur: 1 },
    ] } },
  });
  const sharp = await renderStill(shotRecipe, { timeline: { start: 0.5 } }, 'shot-sharp');
  const near = await renderStill(shotRecipe, { timeline: { start: 1.5 } }, 'shot-near');
  const far = await renderStill(shotRecipe, { timeline: { start: 2.5 } }, 'shot-far');
  const nearAgain = await renderStill(shotRecipe, { timeline: { start: 1.5 } });
  assert.deepEqual(near, nearAgain, 'A seek into the same shot should repeat the same bytes.');
  const wholeFrame = { left: 0, right: WIDTH, top: 0, bottom: HEIGHT };
  assert.ok(meanAbsoluteDifference(sharp, near, wholeFrame) > 0.5, 'The near shot should blur what lies away from its focus.');
  assert.ok(meanAbsoluteDifference(near, far, wholeFrame) > 0.5, 'Each shot should focus on its own distance.');
  console.log('shot depth of field: three shots differ and a seek repeats the same bytes');
} catch (error) {
  console.error(diagnostics);
  throw error;
} finally {
  await client.close().catch(() => {});
}
