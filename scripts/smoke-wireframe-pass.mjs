// Proves the wireframe pass through the real MCP runtime and a browser: a clean box, a box with its top deleted and a box with
// one flipped face are drawn in one render job, and the picture holds the fault colours in the right amounts.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir, constants, setPriority } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { inflateSync } from 'node:zlib';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL);
const directory = await mkdtemp(join(tmpdir(), 'crucible-mcp-wireframe-'));
const cli = resolve(process.argv[2] ?? 'bin/crucible-mcp.mjs');
const backend = process.argv[3] ?? 'cpu';
const SIZE = 320;
const transport = new StdioClientTransport({ command: process.execPath,
  args: [cli, '--backend', backend, '--memory', '128', '--jobs', join(directory, 'jobs')], cwd: directory, stderr: 'pipe' });
let diagnostics = '';
transport.stderr.on('data', bytes => { diagnostics = (diagnostics + bytes).slice(-8192); });
const client = new Client({ name: 'crucible-wireframe-proof', version: '1' });

async function call(name, argumentsValue = {}, timeout = 60000) {
  const result = await client.callTool({ name, arguments: argumentsValue }, { timeout });
  assert.equal(result.isError, undefined, result.content?.find(item => item.type === 'text')?.text);
  return result;
}

async function finished(jobId) {
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    const record = (await call('scene_render_status', { jobId })).structuredContent;
    if (['completed', 'cancelled', 'failed'].includes(record.state)) return record;
    await delay(100);
  }
  throw new Error('Job did not finish within 120 seconds.');
}

function paeth(left, up, upLeft) {
  const estimate = left + up - upLeft;
  const toLeft = Math.abs(estimate - left);
  const toUp = Math.abs(estimate - up);
  const toUpLeft = Math.abs(estimate - upLeft);
  if (toLeft <= toUp && toLeft <= toUpLeft) return left;
  return toUp <= toUpLeft ? up : upLeft;
}

// Reads an 8-bit RGB or RGBA PNG, the only kind the render jobs write here.
function decodePng(bytes) {
  let offset = 8;
  let header = null;
  const chunks = [];
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('latin1', offset + 4, offset + 8);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') header = { width: data.readUInt32BE(0), height: data.readUInt32BE(4), depth: data[8], colorType: data[9] };
    if (type === 'IDAT') chunks.push(data);
    offset += 12 + length;
  }
  assert.equal(header.depth, 8);
  const channels = header.colorType === 6 ? 4 : 3;
  const stride = header.width * channels;
  const raw = inflateSync(Buffer.concat(chunks));
  const pixels = Buffer.alloc(stride * header.height);
  for (let row = 0; row < header.height; row++) {
    const filter = raw[row * (stride + 1)];
    for (let column = 0; column < stride; column++) {
      const value = raw[row * (stride + 1) + 1 + column];
      const left = column >= channels ? pixels[row * stride + column - channels] : 0;
      const up = row > 0 ? pixels[(row - 1) * stride + column] : 0;
      const upLeft = row > 0 && column >= channels ? pixels[(row - 1) * stride + column - channels] : 0;
      pixels[row * stride + column] = (value + [0, left, up, (left + up) >> 1, paeth(left, up, upLeft)][filter]) & 255;
    }
  }
  return { channels, pixels };
}

function countNear(png, color) {
  let count = 0;
  for (let offset = 0; offset < png.pixels.length; offset += png.channels) {
    if (color.every((value, channel) => Math.abs(png.pixels[offset + channel] - value) <= 24)) count++;
  }
  return count;
}

function recipe() {
  const box = edits => ({ type: 'mesh', base: { type: 'box', bevel: 0 }, ...(edits ? { edits } : {}) });
  return {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [
      { id: 'clean', ...box() },
      { id: 'open', ...box([{ op: 'delete', select: { tag: 'top' } }]) },
      { id: 'flipped', ...box([{ op: 'flip_normals', select: { tag: 'top' } }]) },
    ],
    materials: [{ id: 'grey', color: [0.7, 0.7, 0.7], roughness: 0.8 }],
    nodes: [
      { id: 'clean-box', geometry: 'clean', material: 'grey', translation: [-2.4, 0.5, 0] },
      { id: 'open-box', geometry: 'open', material: 'grey', translation: [0, 0.5, 0] },
      { id: 'flipped-box', geometry: 'flipped', material: 'grey', translation: [2.4, 0.5, 0] },
    ],
    environment: { ground: false },
    camera: { eye: [0, 3.2, 6.5], target: [0, 0.5, 0], fov: 55 },
  };
}

async function runJob(sessionId, settings) {
  const submitted = (await call('scene_render_submit', { sessionId, expectedRevision: 0, settings })).structuredContent;
  const record = await finished(submitted.jobId);
  assert.equal(record.state, 'completed', record.reason);
  const result = (await call('scene_render_result', { jobId: submitted.jobId })).structuredContent;
  const files = new Map();
  for (const artifact of result.artifacts) files.set(artifact.path.split(/[\\/]/).pop(), await readFile(artifact.path));
  await call('scene_render_release', { jobId: submitted.jobId });
  return { files, metrics: result.metrics ?? record.metrics };
}

try {
  await client.connect(transport);
  const created = (await call('scene_create', { recipe: recipe() }, 180000)).structuredContent;
  const { files, metrics } = await runJob(created.sessionId, { kind: 'image', width: SIZE, height: SIZE, passes: ['wireframe', 'diffuse'] });
  if (process.env.WIREFRAME_COPY_DIRECTORY) await writeFile(join(process.env.WIREFRAME_COPY_DIRECTORY, 'render-wireframe.png'), files.get('render-wireframe.png'));
  assert.equal(metrics.wireframe.edges.boundary, 4, 'The open box has one rim of four boundary edges.');
  assert.equal(metrics.wireframe.edges.flipped, 4, 'The flipped top shares four edges with its neighbours.');
  assert.equal(metrics.wireframe.edges.nonManifold, 0);
  assert.equal(metrics.wireframe.edges.regular, 12 + 8 + 8);
  assert.deepEqual(metrics.wireframe.faultyParts.map(part => part.part).sort(), ['flipped-box', 'open-box']);

  const picture = decodePng(files.get('render-wireframe.png'));
  assert.notDeepEqual(files.get('render-wireframe.png'), files.get('render-diffuse.png'), 'The wireframe pass must differ from the diffuse pass.');
  const orange = countNear(picture, [255, 140, 0]);
  const cyan = countNear(picture, [0, 217, 255]);
  const dark = countNear(picture, [15, 18, 23]);
  assert.ok(orange > 20, `Boundary edges should show in orange (${orange} pixels).`);
  assert.ok(cyan > 20, `Flipped edges should show in cyan (${cyan} pixels).`);
  assert.ok(dark > 100, `Regular edges should show dark (${dark} pixels).`);

  // The pass also goes through the float target of 16-bit PNG and EXR output.
  for (const format of ['png16', 'exr']) {
    const highPrecision = await runJob(created.sessionId, { kind: 'image', width: SIZE, height: SIZE, format, passes: ['wireframe'] });
    const filename = `render-wireframe.${format === 'exr' ? 'exr' : 'png'}`;
    assert.ok(highPrecision.files.get(filename)?.length > 0, `${filename} is missing.`);
    assert.deepEqual(highPrecision.metrics.wireframe.edges, metrics.wireframe.edges);
  }
  console.log(`wireframe pass smoke passed on ${backend}: orange ${orange}, cyan ${cyan}, dark ${dark} pixels, edges ${JSON.stringify(metrics.wireframe.edges)}`);
} catch (error) {
  console.error(diagnostics);
  throw error;
} finally {
  await client.close();
}
