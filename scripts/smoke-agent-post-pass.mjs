import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir, constants, setPriority } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import sharp from 'sharp';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { createAgentPreviewFixture } from './agent-preview-fixture.mjs';

// Proves the user post pass through the MCP server: a scene with an ordered dither and a quarter-size downscale looks
// quantised and blocky, a broken snippet returns the mapped compile log and leaves the session usable, a snippet that
// breaks a validator rule is refused before any compile, and a render job draws the pass too.

setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL);
const WIDTH = 320;
const HEIGHT = 240;
const SCALE = 0.25;
const LEVELS = 4;
const BLOCK = 4;
const directory = await mkdtemp(join(tmpdir(), '67js-mcp-post-pass-'));
const jobs = join(directory, 'jobs');
const cli = resolve(process.argv[2] ?? 'bin/67js-mcp.mjs');
let diagnostics = '';

const transport = new StdioClientTransport({ command: process.execPath,
  args: [cli, '--backend', 'cpu', '--memory', '128', '--jobs', jobs], cwd: directory, stderr: 'pipe' });
transport.stderr.on('data', bytes => { diagnostics = (diagnostics + bytes).slice(-8192); });
const client = new Client({ name: '67js-post-pass-proof', version: '1' });

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

// Distinct colours, and the share of aligned BLOCK x BLOCK cells whose pixels are all the same colour.
async function measure(png) {
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  assert.equal(info.width, WIDTH);
  const colorAt = (x, y) => data.readUIntBE((y * info.width + x) * info.channels, 3);
  const colors = new Set();
  let uniformBlocks = 0;
  let blocks = 0;
  for (let y = 0; y + BLOCK <= info.height; y += BLOCK) {
    for (let x = 0; x + BLOCK <= info.width; x += BLOCK) {
      const first = colorAt(x, y);
      let uniform = true;
      for (let offsetY = 0; offsetY < BLOCK; offsetY++) {
        for (let offsetX = 0; offsetX < BLOCK; offsetX++) {
          const color = colorAt(x + offsetX, y + offsetY);
          colors.add(color);
          if (color !== first) uniform = false;
        }
      }
      blocks++;
      if (uniform) uniformBlocks++;
    }
  }
  return { colors: colors.size, uniformBlockShare: uniformBlocks / blocks };
}

const ditherFragment = `const float bayer[16] = float[16] (0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0);
vec4 userPass(vec2 uv) {
  vec3 color = texture(sceneColor, uv).rgb;
  ivec2 cell = ivec2(gl_FragCoord.xy) & 3;
  float threshold = (bayer[cell.y * 4 + cell.x] + 0.5) / 16.0 - 0.5;
  vec3 stepped = floor(color * (levels - 1.0) + 0.5 + threshold * spread) / (levels - 1.0);
  return vec4(clamp(stepped, 0.0, 1.0), 1.0);
}`;
const ditherPass = { name: 'pixel-dither', scale: SCALE, uniforms: { levels: LEVELS, spread: 1 }, fragment: ditherFragment };
const brokenPass = { ...ditherPass, fragment: ditherFragment.replace('return vec4(clamp(stepped, 0.0, 1.0), 1.0);', 'vec3 wrong = 1.0;\n  return vec4(clamp(stepped, 0.0, 1.0), 1.0);') };

async function look(sessionId) {
  return Buffer.from((await call('scene_look', { sessionId, width: WIDTH, height: HEIGHT })).content[0].data, 'base64');
}

async function waitForJob(jobId) {
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    const record = (await call('scene_render_status', { jobId })).structuredContent;
    if (['completed', 'cancelled', 'failed'].includes(record.state)) return record;
    await delay(100);
  }
  throw new Error('The render job did not finish within 90 seconds.');
}

try {
  await client.connect(transport);
  assert.equal((await client.listTools()).tools.length, 23);
  const capabilities = (await call('scene_capabilities', { topic: 'postPasses' })).structuredContent;
  assert.equal(capabilities.value.limits.maxPasses, 4);
  assert.ok((await call('scene_capabilities', { topic: 'operations' })).structuredContent.value.includes('set-post-passes'));

  const created = (await call('scene_create', { recipe: createAgentPreviewFixture() })).structuredContent;
  const sessionId = created.sessionId;
  const plain = await measure(await look(sessionId));
  assert.ok(plain.colors > 400, `the plain scene should have many colours, has ${plain.colors}`);
  assert.ok(plain.uniformBlockShare < 0.9, `the plain scene should not be blocky, share ${plain.uniformBlockShare}`);

  // A rule the validator enforces refuses the edit before anything compiles, and nothing changes.
  const refused = await callExpectingError('scene_apply', { sessionId, expectedRevision: 0,
    operations: [{ type: 'set-post-passes', postPasses: [{ ...ditherPass, fragment: `${ditherFragment}\n#define X 1` }] }] });
  assert.match(refused, /Preprocessor lines \(#\) are not allowed/);
  assert.match(refused, /line 9, column 1/);
  assert.match(refused, /Fix: /);

  // A snippet the validator accepts but the compiler rejects: committed, with the log mapped to snippet lines.
  const broken = (await call('scene_apply', { sessionId, expectedRevision: 0, operations: [{ type: 'set-post-passes', postPasses: [brokenPass] }] })).structuredContent;
  assert.equal(broken.committed, true);
  assert.equal(broken.renderSucceeded, false);
  assert.match(broken.renderError, /Post pass "pixel-dither" failed to compile/);
  assert.match(broken.renderError, /snippet line 7/);
  assert.match(broken.renderError, /vec3 wrong = 1\.0;/);
  const brokenRevision = broken.revision;

  // The session is still usable: the fix draws, and the result is quantised and blocky.
  const fixed = (await call('scene_apply', { sessionId, expectedRevision: brokenRevision, operations: [{ type: 'set-post-passes', postPasses: [ditherPass] }] })).structuredContent;
  assert.equal(fixed.renderSucceeded, true, fixed.renderError);
  assert.deepEqual((await call('scene_inspect', { sessionId })).structuredContent.postPasses, [{ name: 'pixel-dither', scale: SCALE, uniforms: ['levels:float', 'spread:float'], fragmentBytes: ditherFragment.length }]);
  const dithered = await measure(await look(sessionId));
  assert.ok(dithered.colors <= LEVELS ** 3, `the dithered scene should have at most ${LEVELS ** 3} colours, has ${dithered.colors}`);
  assert.ok(dithered.uniformBlockShare > 0.99, `the dithered scene should be ${BLOCK}x${BLOCK} blocks, share ${dithered.uniformBlockShare}`);

  // A render job applies the pass too.
  const submitted = (await call('scene_render_submit', { sessionId, expectedRevision: fixed.revision,
    settings: { kind: 'image', width: WIDTH, height: HEIGHT } })).structuredContent;
  assert.equal((await waitForJob(submitted.jobId)).state, 'completed');
  const artifact = (await call('scene_render_result', { jobId: submitted.jobId })).structuredContent.artifacts[0];
  const rendered = await measure(await readFile(artifact.path));
  assert.ok(rendered.colors <= LEVELS ** 3 && rendered.uniformBlockShare > 0.99, `the render job should apply the pass: ${JSON.stringify(rendered)}`);
  await call('scene_render_release', { jobId: submitted.jobId });

  // Clearing the pass restores the plain image.
  await call('scene_apply', { sessionId, expectedRevision: fixed.revision, operations: [{ type: 'set-post-passes', postPasses: null }] });
  const cleared = await measure(await look(sessionId));
  assert.ok(cleared.colors > 400 && cleared.uniformBlockShare < 0.9);

  await mkdir('artifacts', { recursive: true });
  const proof = { compileLog: broken.renderError, plain, dithered, rendered, cleared, levels: LEVELS, scale: SCALE, refusedBeforeCompile: true, mappedCompileLog: true, sessionUsableAfterError: true };
  await writeFile('artifacts/mcp-post-pass-proof.json', JSON.stringify(proof, null, 2));
  console.log(JSON.stringify(proof));
} finally {
  await client.close();
  if (diagnostics.trim()) console.error(diagnostics.trim().split('\n').slice(-5).join('\n'));
}
