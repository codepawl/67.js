import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir, constants, setPriority } from 'node:os';
import { join, resolve } from 'node:path';
import sharp from 'sharp';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

// Proves the material fragment hook through the MCP server: a valid hook changes pixels and takes new uniform values, a
// discarded caster casts no shadow, a snippet that breaks a validator rule is refused before any compile, a snippet the
// compiler rejects returns the log mapped to snippet lines and leaves the session usable, and null clears the hook.

setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL);
const WIDTH = 320;
const HEIGHT = 240;
const directory = await mkdtemp(join(tmpdir(), '67js-mcp-material-snippet-'));
const jobs = join(directory, 'jobs');
const cli = resolve(process.argv[2] ?? 'bin/67js-mcp.mjs');
let diagnostics = '';

const transport = new StdioClientTransport({ command: process.execPath,
  args: [cli, '--backend', 'cpu', '--memory', '128', '--jobs', jobs], cwd: directory, stderr: 'pipe' });
transport.stderr.on('data', bytes => { diagnostics = (diagnostics + bytes).slice(-8192); });
const client = new Client({ name: '67js-material-snippet-proof', version: '1' });

async function call(name, argumentsValue = {}) {
  const result = await client.callTool({ name, arguments: argumentsValue }, { timeout: 60000 });
  assert.equal(result.isError, undefined, result.content?.find(item => item.type === 'text')?.text);
  return result;
}

async function callExpectingError(name, argumentsValue) {
  const result = await client.callTool({ name, arguments: argumentsValue }, { timeout: 60000 });
  assert.equal(result.isError, true, `${name} should have been refused`);
  return result.content.find(item => item.type === 'text').text;
}

async function look(sessionId) {
  return Buffer.from((await call('scene_look', { sessionId, width: WIDTH, height: HEIGHT })).content[0].data, 'base64');
}

async function measure(png) {
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  let red = 0;
  let green = 0;
  const luminance = [];
  for (let index = 0; index < data.length; index += info.channels) {
    red += data[index];
    green += data[index + 1];
    luminance.push(0.299 * data[index] + 0.587 * data[index + 1] + 0.114 * data[index + 2]);
  }
  const pixels = luminance.length;
  const sorted = [...luminance].sort((first, second) => first - second);
  const lit = sorted[Math.floor(pixels * 0.9)];
  return { redShare: red / (red + green), darkPixels: luminance.filter(value => value < lit * 0.6).length, pixels, data };
}

function differenceBetween(first, second) {
  let total = 0;
  for (let index = 0; index < first.data.length; index++) total += Math.abs(first.data[index] - second.data[index]);
  return total / first.data.length;
}

// A wide floor, and a slab high above it. The camera looks straight down at the shadow, and the slab itself is outside the
// frame, so any change in the shadow comes from the shadow pass and not from the slab's own pixels.
const recipe = {
  format: '67js.scene', schemaVersion: 1,
  geometries: [{ id: 'block', type: 'box' }],
  materials: [{ id: 'floor', color: [0.7, 0.7, 0.7], roughness: 0.9 }, { id: 'slab', color: [0.4, 0.5, 0.8], roughness: 0.6 },
    { id: 'wood', pattern: { type: 'wood', size: 0.6, axis: 'z' }, roughness: 0.8 }],
  nodes: [
    { id: 'ground', geometry: 'block', material: 'floor', scale: [40, 0.2, 40], translation: [0, -0.1, 0] },
    { id: 'caster', geometry: 'block', material: 'slab', scale: [1.2, 0.3, 1.2], translation: [0, 3, 0] },
    { id: 'panel', geometry: 'block', material: 'wood', scale: [1.4, 0.05, 1.4], translation: [5.5, 0.1, 0] },
  ],
  camera: { eye: [4, 20, 0], target: [4, 0, 0], up: [0, 0, -1], fov: 15, near: 1, far: 60 },
  environment: { world: true, lightDirection: [-1, 1, 0], keyColor: [3, 2.8, 2.5], ambientIntensity: 0.25, ground: false },
  shadow: { distance: 20, extent: 8, near: 0.1, far: 40 },
};

const tint = amount => ({ fragment: 'void materialHook(inout vec3 color, inout float alpha, vec2 uv, vec3 worldPosition) {\n  color = mix(color, vec3(1.0, 0.1, 0.1), amount);\n}', uniforms: { amount } });
const discardAll = { fragment: 'void materialHook(inout vec3 color, inout float alpha, vec2 uv, vec3 worldPosition) {\n  discard;\n}' };
const broken = { fragment: 'void materialHook(inout vec3 color, inout float alpha, vec2 uv, vec3 worldPosition) {\n  color = vec3(1.0);\n  vec3 wrong = 1.0;\n}' };

try {
  await client.connect(transport);
  assert.equal((await client.listTools()).tools.length, 22);
  const capabilities = (await call('scene_capabilities', { topic: 'materialSnippet' })).structuredContent;
  assert.equal(capabilities.value.limits.maxUniforms, 16);

  const created = (await call('scene_create', { recipe })).structuredContent;
  const sessionId = created.sessionId;
  let revision = created.revision;
  const apply = async (operations) => {
    const result = (await call('scene_apply', { sessionId, expectedRevision: revision, operations })).structuredContent;
    revision = result.revision;
    return result;
  };

  const plain = await measure(await look(sessionId));
  assert.ok(plain.darkPixels > 400, `the plain scene should show the slab's shadow, dark pixels ${plain.darkPixels}`);

  // A valid hook changes pixels, and a new uniform value takes effect without breaking anything.
  const none = await apply([{ type: 'set-material', id: 'floor', snippet: tint(0) }]);
  assert.equal(none.renderSucceeded, true, none.renderError);
  const unchanged = await measure(await look(sessionId));
  assert.ok(differenceBetween(plain, unchanged) < 1, `amount 0 should leave the picture as it was, difference ${differenceBetween(plain, unchanged)}`);
  const reddened = await apply([{ type: 'set-material', id: 'floor', snippet: tint(0.9) }]);
  assert.equal(reddened.renderSucceeded, true, reddened.renderError);
  const red = await measure(await look(sessionId));
  assert.ok(red.redShare > plain.redShare + 0.1, `the hook should redden the floor: ${plain.redShare} to ${red.redShare}`);
  assert.ok(red.darkPixels > 400, 'the shadow is still cast while the floor is tinted');

  // A discard in the colour pass cuts holes in the floor: the stripes show the background and the picture changes a lot.
  const striped = await apply([{ type: 'set-material', id: 'floor', snippet: { fragment: 'void materialHook(inout vec3 color, inout float alpha, vec2 uv, vec3 worldPosition) {\n  if (fract(worldPosition.x) < 0.5) discard;\n}' } }]);
  assert.equal(striped.renderSucceeded, true, striped.renderError);
  assert.ok(differenceBetween(plain, await measure(await look(sessionId))) > 5, 'a discard in the colour pass should cut the floor');

  // The dissolve of docs/user-passes.md compiles in the colour and shadow programs.
  const dissolveFragment = `float cellNoise(vec2 cell) { return fract(sin(dot(cell, vec2(12.9898, 78.233))) * 43758.5453); }

void materialHook(inout vec3 color, inout float alpha, vec2 uv, vec3 worldPosition) {
  float value = cellNoise(floor(worldPosition.xy * 6.0));
  if (value < threshold) discard;
  float edge = 1.0 - smoothstep(0.0, 0.08, value - threshold);
  color = mix(color, glow, edge);
}`;
  const dissolved = await apply([{ type: 'set-material', id: 'floor', snippet: { uniforms: { threshold: 0.35, glow: [1.0, 0.45, 0.1] }, fragment: dissolveFragment } }]);
  assert.equal(dissolved.renderSucceeded, true, dissolved.renderError);
  await look(sessionId);

  // The mask is the material's own map: the hook reads it in the colour pass and in the shadow pass, so both programs compile.
  const mapped = await measure(await look(sessionId));
  const masked = await apply([{ type: 'set-material', id: 'wood', snippet: { mask: 'map', fragment: 'void materialHook(inout vec3 color, inout float alpha, vec2 uv, vec3 worldPosition) {\n  color = vec3(texture(snippetMask, uv).r, 0.0, 0.0);\n}' } }]);
  assert.equal(masked.renderSucceeded, true, masked.renderError);
  const maskedLook = await measure(await look(sessionId));
  assert.ok(differenceBetween(mapped, maskedLook) > 0.2, 'the mask hook should recolour the wooden panel');
  assert.ok(maskedLook.darkPixels > 400, 'the shadow is still cast with a mask hook in the shadow program');
  await apply([{ type: 'set-material', id: 'wood', snippet: null }]);

  // The slab's hook discards every fragment: it draws nothing, and the shadow pass runs the hook, so its shadow is gone too.
  await apply([{ type: 'set-material', id: 'floor', snippet: null }]);
  const removed = await apply([{ type: 'set-material', id: 'slab', snippet: discardAll }]);
  assert.equal(removed.renderSucceeded, true, removed.renderError);
  const unshadowed = await measure(await look(sessionId));
  assert.ok(unshadowed.darkPixels < plain.darkPixels * 0.1, `a discarded caster should cast no shadow: ${plain.darkPixels} dark pixels before, ${unshadowed.darkPixels} after`);

  // A rule the validator enforces refuses the edit before anything compiles, and nothing changes.
  const refused = await callExpectingError('scene_apply', { sessionId, expectedRevision: revision,
    operations: [{ type: 'set-material', id: 'slab', snippet: { ...discardAll, fragment: `#define X 1\n${discardAll.fragment}` } }] });
  assert.match(refused, /Preprocessor lines \(#\) are not allowed/);
  assert.match(refused, /line 1, column 1/);
  assert.match(refused, /Fix: /);

  // A snippet the validator accepts but the compiler rejects: committed, with the log mapped to snippet lines.
  const rejected = await apply([{ type: 'set-material', id: 'slab', snippet: broken }]);
  assert.equal(rejected.committed, true);
  assert.equal(rejected.renderSucceeded, false);
  assert.match(rejected.renderError, /Material snippet \(used by caster\) failed to compile/);
  assert.match(rejected.renderError, /snippet line 3/);
  assert.match(rejected.renderError, /vec3 wrong = 1\.0;/);

  // The session is still usable: the fix draws, and null clears the hook so the shadow is back.
  const fixed = await apply([{ type: 'set-material', id: 'slab', snippet: tint(0.5) }]);
  assert.equal(fixed.renderSucceeded, true, fixed.renderError);
  const cleared = await apply([{ type: 'set-material', id: 'slab', snippet: null }]);
  assert.equal(cleared.renderSucceeded, true, cleared.renderError);
  const restored = await measure(await look(sessionId));
  assert.ok(Math.abs(restored.darkPixels - plain.darkPixels) < plain.darkPixels * 0.05, `clearing the hook should restore the shadow: ${plain.darkPixels} against ${restored.darkPixels}`);

  await mkdir('artifacts', { recursive: true });
  const proof = {
    darkPixels: { plain: plain.darkPixels, discardedCaster: unshadowed.darkPixels, restored: restored.darkPixels },
    redShare: { plain: plain.redShare, tinted: red.redShare },
    compileLog: rejected.renderError, refusedBeforeCompile: true, sessionUsableAfterError: true,
  };
  await writeFile('artifacts/mcp-material-snippet-proof.json', JSON.stringify(proof, null, 2));
  console.log(JSON.stringify(proof));
} finally {
  await client.close();
  if (diagnostics.trim()) console.error(diagnostics.trim().split('\n').slice(-5).join('\n'));
}
