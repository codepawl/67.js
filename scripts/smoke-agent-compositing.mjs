import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir, constants, setPriority } from 'node:os';
import { join, resolve } from 'node:path';
import sharp from 'sharp';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { createAgentPreviewFixture } from './agent-preview-fixture.mjs';

// Proves two compositing steps on real pixels through the MCP server (#707): a grade masked to one part changes the
// pixels of that part and leaves the rest of the frame alone, and a luma key over a background replaces the dark
// backdrop with the background colour while the lit part stays as drawn.

setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL);
const WIDTH = 320;
const HEIGHT = 240;
const HERO = 'glow';
const directory = await mkdtemp(join(tmpdir(), 'crucible-mcp-compositing-'));
const cli = resolve(process.argv[2] ?? 'bin/crucible-mcp.mjs');
let diagnostics = '';

const transport = new StdioClientTransport({ command: process.execPath,
  args: [cli, '--backend', 'cpu', '--memory', '128', '--jobs', join(directory, 'jobs')], cwd: directory, stderr: 'pipe' });
transport.stderr.on('data', bytes => { diagnostics = (diagnostics + bytes).slice(-8192); });
const client = new Client({ name: 'crucible-compositing-proof', version: '1' });

async function call(name, argumentsValue = {}) {
  const result = await client.callTool({ name, arguments: argumentsValue }, { timeout: 60000 });
  assert.equal(result.isError, undefined, JSON.stringify(result.content).slice(0, 600));
  return result;
}

async function pixels(sessionId, pass) {
  const result = await call('scene_look', { sessionId, width: WIDTH, height: HEIGHT, ...(pass ? { pass } : {}) });
  const image = result.content.find(item => item.type === 'image');
  const { data, info } = await sharp(Buffer.from(image.data, 'base64')).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, channels: info.channels, text: result.content.filter(item => item.type === 'text').map(item => item.text).join('\n') };
}

function pixelAt(frame, index) {
  const offset = index * frame.channels;
  return [frame.data[offset], frame.data[offset + 1], frame.data[offset + 2]];
}

function distance(first, second) {
  return Math.abs(first[0] - second[0]) + Math.abs(first[1] - second[1]) + Math.abs(first[2] - second[2]);
}

async function setEffects(sessionId, revision, effects) {
  const result = (await call('scene_apply', { sessionId, expectedRevision: revision, operations: [{ type: 'set-effects', effects }] })).structuredContent;
  assert.equal(result.renderSucceeded, true, result.renderError);
  return result.revision;
}

try {
  await client.connect(transport);
  const { sessionId } = (await call('scene_create', { recipe: createAgentPreviewFixture() })).structuredContent;
  const plain = await pixels(sessionId);

  // Pixels of the hero part are the ones the unmasked grade changes most; the mask must confine the grade to them.
  let revision = 0;
  const gain = [0.2, 1, 3];
  revision = await setEffects(sessionId, revision, { colorBalance: { gain } });
  const everywhere = await pixels(sessionId);
  revision = await setEffects(sessionId, revision, { colorBalance: { gain, mask: { objects: [HERO] } } });
  const masked = await pixels(sessionId);

  let changedByMask = 0;
  let changedElsewhereByMask = 0;
  let sameAsGradeEverywhere = 0;
  const total = WIDTH * HEIGHT;
  for (let index = 0; index < total; index++) {
    const base = pixelAt(plain, index);
    const graded = pixelAt(everywhere, index);
    const limited = pixelAt(masked, index);
    if (distance(base, limited) > 12) changedByMask++;
    if (distance(base, graded) > 12 && distance(base, limited) <= 12) changedElsewhereByMask++;
    if (distance(graded, limited) <= 12) sameAsGradeEverywhere++;
  }
  assert.ok(changedByMask > 200, `the masked grade should change the hero pixels, changed ${changedByMask}`);
  assert.ok(changedElsewhereByMask > changedByMask, `the mask should spare more pixels than it grades: graded ${changedByMask}, spared ${changedElsewhereByMask}`);
  assert.ok(sameAsGradeEverywhere < total, 'the masked frame should differ from the frame graded everywhere');

  // A luma key over a flat background: the dark backdrop turns into the background, the bright emissive part stays.
  const background = [0.9, 0.1, 0.1];
  await setEffects(sessionId, revision, { composite: { background: { color: background }, key: { luma: { low: 0.3, high: 0.6 } } } });
  const keyed = await pixels(sessionId);
  let backgroundPixels = 0;
  let keptPixels = 0;
  for (let index = 0; index < total; index++) {
    const keyedPixel = pixelAt(keyed, index);
    if (keyedPixel[0] > keyedPixel[1] + 60 && keyedPixel[0] > keyedPixel[2] + 60) backgroundPixels++;
    if (distance(pixelAt(plain, index), keyedPixel) <= 12) keptPixels++;
  }
  assert.ok(backgroundPixels > 200, `the key should show the background colour, found ${backgroundPixels} pixels`);
  assert.ok(keptPixels > 200 && keptPixels < total, `some pixels should stay as drawn, kept ${keptPixels}`);

  console.log(JSON.stringify({ hero: HERO, changedByMask, changedElsewhereByMask, backgroundPixels, keptPixels, total }));
} finally {
  await client.close();
  if (diagnostics.trim()) console.error(diagnostics.trim().split('\n').slice(-5).join('\n'));
}
