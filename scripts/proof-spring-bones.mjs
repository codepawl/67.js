import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

// Visual proof for spring bones (#981): a fox turns and stops, once with its tail on springs and once without. Both clips
// are rendered through the MCP render jobs (frames are sampled in order, so the springs swing and settle), and the same
// frame of each is joined into one comparison still. Usage: node scripts/proof-spring-bones.mjs <output folder>
// Environment: PROOF_BACKEND gpu|cpu (default gpu), PROOF_CHROME_FLAGS extra Chrome flags, PROOF_INSPECT=1 to print the tail bones only.
// Model: Fox by PixelMannen (CC0), rigged and animated by tomkranis (CC BY 4.0), from the Khronos glTF sample assets.

const FOX_URL = 'https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/main/Models/Fox/glTF-Binary/Fox.glb';
const outputDirectory = resolve(process.argv[2] ?? 'artifacts/981');
const backend = process.env.PROOF_BACKEND ?? 'gpu';
const WIDTH = 640;
const HEIGHT = 360;
const FPS = 24;
const DURATION = 4;
const COMPARISON_TIME = Number(process.env.PROOF_COMPARISON_TIME ?? 1.25);

const workDirectory = await mkdtemp(join(tmpdir(), 'crucible-springs-'));
const assets = join(workDirectory, 'assets');
const jobs = join(workDirectory, 'jobs');
await mkdir(assets);
await mkdir(outputDirectory, { recursive: true });

const foxBytes = Buffer.from(await (await fetch(FOX_URL)).arrayBuffer());
assert.equal(foxBytes.subarray(0, 4).toString(), 'glTF', 'the download is not a GLB');
const assetId = createHash('sha256').update(foxBytes).digest('hex');
await writeFile(join(assets, 'fox.glb'), foxBytes);

let browserPath = process.env.CHROME_PATH;
if (browserPath && process.env.PROOF_CHROME_FLAGS) {
  const wrapper = join(workDirectory, 'chrome-with-flags.sh');
  await writeFile(wrapper, `#!/bin/sh\nexec "${browserPath}" ${process.env.PROOF_CHROME_FLAGS} "$@"\n`);
  await chmod(wrapper, 0o755);
  browserPath = wrapper;
}

const serverArguments = [
  resolve('bin/crucible-mcp.mjs'), '--backend', backend, '--memory', '192', '--jobs', jobs, '--assets', assets,
  ...(browserPath ? ['--browser', browserPath] : []),
];
const transport = new StdioClientTransport({ command: process.execPath, args: serverArguments, cwd: workDirectory, stderr: 'pipe' });
let diagnostics = '';
transport.stderr.on('data', bytes => { diagnostics = (diagnostics + bytes).slice(-8192); });
const client = new Client({ name: 'crucible-spring-proof', version: '1' });

async function call(name, argumentsValue = {}, timeout = 120000) {
  const result = await client.callTool({ name, arguments: argumentsValue }, { timeout });
  assert.equal(result.isError, undefined, result.content?.find(item => item.type === 'text')?.text);
  return result.structuredContent ?? result;
}

async function waitForJob(jobId) {
  for (let attempt = 0; attempt < 600; attempt++) {
    const record = await call('scene_render_status', { jobId });
    if (['completed', 'failed', 'cancelled'].includes(record.state)) {
      assert.equal(record.state, 'completed', JSON.stringify(record));
      return record;
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 500));
  }
  throw new Error(`render job ${jobId} did not finish`);
}

function ffmpeg(...argumentsList) {
  const run = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', ...argumentsList], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
}

try {
  await client.connect(transport);
  const probeRecipe = { format: 'crucible.asset', schemaVersion: 1, assetId, motion: { duration: DURATION, loop: false, layers: [{ clip: 0 }] } };
  const probe = await call('scene_create_asset', { recipe: probeRecipe }, 240000);
  const hierarchy = await call('scene_inspect', { sessionId: probe.sessionId, kind: 'hierarchy', limit: 128 });
  const nodes = hierarchy.nodes ?? hierarchy.hierarchy ?? [];
  const tailBones = nodes.filter(node => /tail/i.test(node.name ?? '')).map(node => ({ id: node.id, name: node.name, parent: node.parent }));
  console.log(JSON.stringify({ nodeCount: nodes.length, tailBones, firstNodes: nodes.slice(0, 6) }, null, 1));
  await call('scene_dispose', { sessionId: probe.sessionId });
  if (process.env.PROOF_INSPECT) process.exit(0);
  assert.ok(tailBones.length >= 2, 'no tail bones found');

  // The fox stands, turns sharply to one side, stops, then turns back: the tail has to lag, swing and settle twice.
  const yaw = degrees => [0, Math.sin(degrees * Math.PI / 360), 0, Math.cos(degrees * Math.PI / 360)];
  const turnTracks = [{
    kind: 'node', id: 'node-0', property: 'rotation', interpolation: 'SMOOTH',
    keyframes: [
      { time: 0, value: yaw(0) }, { time: 0.5, value: yaw(0) }, { time: 0.9, value: yaw(80) },
      { time: 2.2, value: yaw(80) }, { time: 2.6, value: yaw(-60) }, { time: 4, value: yaw(-60) },
    ],
  }];
  const springs = {
    chains: [{ bones: tailBones.map(bone => bone.id), stiffness: 0.6, dragForce: 0.12, gravityPower: 0.3, hitRadius: 0.03 }],
  };

  async function renderClip(name, withSprings) {
    const motion = { duration: DURATION, loop: false, layers: [{ clip: Number(process.env.PROOF_CLIP ?? 0), loop: true }], tracks: turnTracks, ...(withSprings ? { springs } : {}) };
    const created = await call('scene_create_asset', { recipe: { format: 'crucible.asset', schemaVersion: 1, assetId, motion } }, 240000);
    const submitted = await call('scene_render_submit', { sessionId: created.sessionId, expectedRevision: created.revision ?? 0, settings: {
      kind: 'video', width: WIDTH, height: HEIGHT, fps: FPS, duration: DURATION, motion: { start: 0 },
    } }, 240000);
    await waitForJob(submitted.jobId);
    const result = await call('scene_render_result', { jobId: submitted.jobId });
    await copyFile(result.artifacts[0].path, join(outputDirectory, `${name}.mp4`));
    await call('scene_dispose', { sessionId: created.sessionId });
  }

  await renderClip('spring-bones-off', false);
  await renderClip('spring-bones-on', true);

  const frame = name => ['-ss', String(COMPARISON_TIME), '-i', join(outputDirectory, `${name}.mp4`), '-frames:v', '1'];
  ffmpeg(...frame('spring-bones-off'), join(workDirectory, 'off.png'));
  ffmpeg(...frame('spring-bones-on'), join(workDirectory, 'on.png'));
  ffmpeg(
    '-i', join(workDirectory, 'off.png'), '-i', join(workDirectory, 'on.png'),
    '-filter_complex', 'hstack=inputs=2', '-frames:v', '1', '-q:v', '3', join(outputDirectory, 'spring-bones-comparison.jpg'),
  );
  console.log(`wrote ${outputDirectory}`);
} catch (error) {
  console.error(diagnostics);
  throw error;
} finally {
  await client.close().catch(() => {});
}
