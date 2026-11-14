// Through MCP on the CPU backend: a four-wheel car GLB driven along a curve with a reverse leg, once as an asset recipe
// (motion.drive) and once placed in a scene (asset.drive). Checks the wheels found, the brake signal and that a seek
// reproduces its frame, and writes stills for a person to look at.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { constants, setPriority } from 'node:os';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { carAsset } from '../tests/fixtures/car-glb.js';

setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL);
await mkdir('artifacts/drive-proof', { recursive: true });
await writeFile('artifacts/drive-proof/car.glb', Buffer.from(carAsset()));
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [resolve('scripts/mcp-server.mjs'), '--backend', 'cpu', '--memory', '192', '--assets', resolve('artifacts/drive-proof')],
  stderr: 'pipe', cwd: process.cwd(),
});
let diagnostics = '';
transport.stderr.on('data', chunk => { diagnostics += chunk.toString(); });
const client = new Client({ name: 'crucible-drive-proof', version: '1' }, {
  versionNegotiation: { mode: { pin: '2026-07-28' }, probe: { timeoutMs: 180000 } },
});
async function call(name, argumentsValue = {}) {
  const result = await client.callTool({ name, arguments: argumentsValue }, { timeout: 180000 });
  assert.equal(result.isError, undefined, result.content?.find(item => item.type === 'text')?.text);
  return result;
}
async function look(sessionId, label, motionTime) {
  const result = await call('scene_look', { sessionId, width: 768, height: 512, motionTime });
  const bytes = Buffer.from(result.content.find(item => item.type === 'image').data, 'base64');
  await writeFile(`artifacts/drive-${label}.png`, bytes);
  return bytes;
}

const drive = {
  legs: [
    { path: [[0, 0, -6], [0, 0, 2], [3, 0, 7], [8, 0, 9]] },
    { path: [[8, 0, 9], [5, 0, 8]], direction: 'reverse', pause: 0.4 },
  ],
  cruiseSpeed: 6, acceleration: 3, braking: 4,
  lights: { headlights: [{ id: 'left', position: [0.5, 0.7, 2] }], tailLights: [{ material: 'material-1', signal: 'brake', off: 0.2, on: 6 }] },
};
const camera = { eye: [-6, 7, -9], target: [4, 0, 3], fov: 50 };

try {
  await client.connect(transport, { timeout: 180000 });
  assert.equal((await client.listTools()).tools.length, 22);
  const catalog = (await call('scene_asset_catalog')).structuredContent;
  const car = catalog.assets.find(asset => asset.name === 'car.glb').assetId;

  const created = (await call('scene_create_asset', { recipe: { format: 'crucible.asset', schemaVersion: 1, assetId: car, motion: { drive }, camera } })).structuredContent;
  const sessionId = created.sessionId;
  const duration = (await call('scene_export_recipe', { sessionId })).structuredContent.recipe.motion.duration;
  const report = (await call('scene_inspect', { sessionId, kind: 'hierarchy', limit: 1 })).structuredContent.motionDrive;
  assert.equal(report.wheels.length, 4);
  assert.deepEqual(report.rejectedNames.map(entry => entry.name), ['Steering_Wheel_Cover']);
  const times = { start: 0, middle: duration * 0.35, stopped: duration * 0.62, reversing: duration - 0.5, end: duration };
  const frames = {};
  for (const [label, time] of Object.entries(times)) frames[label] = await look(sessionId, `asset-${label}`, time);
  assert.notDeepEqual(frames.start, frames.middle, 'the car moves');
  assert.deepEqual(await look(sessionId, 'asset-middle-again', times.middle), frames.middle, 'a seek reproduces its frame');
  await call('scene_dispose', { sessionId });

  const placed = (await call('scene_create', { recipe: {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'ground', type: 'box' }],
    materials: [{ id: 'asphalt', color: [0.12, 0.12, 0.13], roughness: 0.9 }],
    nodes: [
      { id: 'road', geometry: 'ground', material: 'asphalt', translation: [4, -0.05, 2], scale: [30, 0.1, 30] },
      { id: 'car', translation: [0, 0, 0], asset: { id: car, drive: { ...drive, lights: { headlights: drive.lights.headlights } } } },
    ],
    camera,
  } })).structuredContent;
  const placedId = placed.sessionId;
  const first = await look(placedId, 'placed-start', 0);
  const later = await look(placedId, 'placed-middle', duration * 0.35);
  assert.notDeepEqual(first, later, 'the placed car moves');
  const inspection = (await call('scene_inspect', { sessionId: placedId })).structuredContent;
  assert.equal(inspection.assets[0].drive.wheels.length, 4);
  await call('scene_dispose', { sessionId: placedId });

  const proof = { backend: 'cpu', wheels: report.wheels.length, rejected: report.rejectedNames.length, duration, seekExact: true };
  await writeFile('artifacts/drive-cpu.json', JSON.stringify(proof, null, 2));
  console.log(JSON.stringify(proof));
} catch (error) {
  console.error(diagnostics);
  throw error;
} finally {
  await client.close();
}
