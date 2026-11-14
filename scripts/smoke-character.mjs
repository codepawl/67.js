// A real character through the real MCP server, along the path an agent takes: find joints in the hierarchy, add IK over
// a clip, seek, checkpoint and render. Run `npm run prepare:release` first; the preview page comes from its build.
// Stills go to artifacts/character-*.png, for looking at, since these checks prove that things move but not that they look right.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { constants, setPriority, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL);
const backend = process.argv[2] ?? 'gpu';
const directory = await mkdtemp(join(tmpdir(), 'crucible-character-'));
const assets = join(directory, 'assets');
const jobs = join(directory, 'jobs');
await mkdir(assets);
await mkdir('artifacts', { recursive: true });
await copyFile(resolve('tests/fixtures/RobotExpressive.glb'), join(assets, 'robot.glb'));

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [resolve('scripts/mcp-server.mjs'), '--backend', backend, '--memory', '192', '--assets', assets, '--jobs', jobs],
  stderr: 'pipe',
  cwd: process.cwd(),
});
let diagnostics = '';
transport.stderr.on('data', chunk => {
  diagnostics += chunk.toString();
});
const client = new Client({ name: 'crucible-character-smoke', version: '1' });

async function call(name, argumentsValue = {}) {
  const result = await client.callTool({ name, arguments: argumentsValue }, { timeout: 180000 });
  assert.ok(!result.isError, `${name}: ${JSON.stringify(result.content).slice(0, 700)}\n${diagnostics.slice(-500)}`);
  return result;
}

async function look(sessionId, label, motionTime) {
  const result = await call('scene_look', { sessionId, width: 480, height: 480, ...(motionTime === undefined ? {} : { motionTime }) });
  const { data } = result.content.find(block => block.type === 'image');
  if (label) await writeFile(`artifacts/character-${label}.png`, Buffer.from(data, 'base64'));
  return data;
}

async function allNodes(sessionId) {
  const nodes = [];
  let offset = 0;
  for (;;) {
    const page = (await call('scene_inspect', { sessionId, kind: 'hierarchy', offset, limit: 64 })).structuredContent;
    nodes.push(...page.nodes);
    if (!page.truncated) return nodes;
    offset += page.nodes.length;
  }
}

async function finished(jobId) {
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    const record = (await call('scene_render_status', { jobId })).structuredContent;
    if (['completed', 'cancelled', 'failed', 'interrupted'].includes(record.state)) return record;
    await delay(200);
  }
  throw new Error('The render job did not finish within two minutes.');
}

const report = {};
try {
  await client.connect(transport);
  const catalog = (await call('scene_asset_catalog')).structuredContent;
  const created = (await call('scene_create_asset', { recipe: {
    format: 'crucible.asset', schemaVersion: 1, assetId: catalog.assets[0].assetId,
    camera: { eye: [1.5, 3, 11], target: [0, 2.6, 0], fov: 38, near: 0.1, far: 100 },
    animation: { clip: 10, time: 0.2 },
  } })).structuredContent;
  const { sessionId } = created;
  let { revision } = created;
  const base = await look(sessionId, 'base');

  const nodes = await allNodes(sessionId);
  const idOf = label => {
    const found = nodes.find(node => node.label === label && node.joint);
    assert.ok(found, `no joint labelled ${label}`);
    return found.id;
  };
  const checkpoint = (await call('scene_checkpoint', { sessionId })).structuredContent;
  const motion = {
    duration: 2,
    tracks: [],
    ik: [
      {
        type: 'two-bone', root: idOf('UpperArm.R'), middle: idOf('LowerArm.R'), end: idOf('Palm2.R'), keepEndRotation: false,
        target: { interpolation: 'SMOOTH', keyframes: [{ time: 0, value: [-1.3, 2.6, 0.8] }, { time: 1, value: [-1, 1.7, 1.1] }, { time: 2, value: [-1.3, 2.6, 0.8] }] },
      },
      { type: 'aim', joint: idOf('Head'), worldForward: [0, 0, 1], maxAngle: 60, target: { interpolation: 'SMOOTH', keyframes: [{ time: 0, value: [-4, 3, 6] }, { time: 2, value: [4, 3, 6] }] } },
    ],
  };
  const applied = (await call('scene_apply', { sessionId, expectedRevision: revision, operations: [{ type: 'set-motion', motion }] })).structuredContent;
  assert.equal(applied.renderSucceeded, true, applied.renderError);
  revision = applied.revision;

  const inspected = (await call('scene_inspect', { sessionId, kind: 'hierarchy', limit: 1 })).structuredContent;
  assert.deepEqual(inspected.motionIk.map(result => result.type), ['two-bone', 'aim']);
  assert.ok(inspected.motionIk.every(result => result.reached), JSON.stringify(inspected.motionIk));
  report.motionIk = inspected.motionIk;

  const atStart = await look(sessionId, 'ik-start', 0);
  const atMiddle = await look(sessionId, 'ik-middle', 1);
  const atEnd = await look(sessionId, 'ik-end', 2);
  assert.notEqual(atStart, base, 'IK changes the picture');
  assert.notEqual(atMiddle, atStart, 'the target moves the arm');
  assert.notEqual(atEnd, atMiddle);
  assert.equal(await look(sessionId, null, 1), atMiddle, 'seeking back gives the same picture');

  // Leg IK with a tight knee limit, a bend direction, and a constraint and driver on the same character.
  const legTarget = { interpolation: 'SMOOTH', keyframes: [{ time: 0, value: [-0.6, 1.2, 0.9] }, { time: 2, value: [-0.6, 0.9, 1.2] }] };
  const legMotion = {
    duration: 2,
    tracks: [],
    ik: [{
      // The robot's shin ends in a helper node below LowerLeg.R; its separate Foot.R bone is not part of the leg chain.
      type: 'two-bone', root: idOf('UpperLeg.R'), middle: idOf('LowerLeg.R'), end: nodes.find(node => /^LowerLeg.?R_end$/.test(node.label)).id, target: legTarget,
      pole: [-0.6, 1.6, 3], bendToward: [0, 0, 1], limits: { middle: { x: [-20, 20] } },
    }],
    constraints: [{ type: 'limit_rotation', node: idOf('Head'), x: [-10, 10], y: [-10, 10], space: 'local' }],
    drivers: [{ target: { kind: 'node', id: idOf('Head'), property: 'rotation', component: 'z' }, expression: { mul: [{ sin: [{ mul: ['time', 3] }] }, 8] } }],
  };
  const legApplied = (await call('scene_apply', { sessionId, expectedRevision: revision, operations: [{ type: 'set-motion', motion: legMotion }] })).structuredContent;
  assert.equal(legApplied.renderSucceeded, true, legApplied.renderError);
  revision = legApplied.revision;
  const legReport = (await call('scene_inspect', { sessionId, kind: 'hierarchy', limit: 1 })).structuredContent.motionIk[0];
  assert.ok(Array.isArray(legReport.limited) && Array.isArray(legReport.warnings), JSON.stringify(legReport));
  report.legIk = legReport;
  const legStart = await look(sessionId, 'leg-start', 0);
  const legEnd = await look(sessionId, 'leg-end', 2);
  assert.notEqual(legEnd, legStart, 'the leg target and the driver move the character');
  assert.equal(await look(sessionId, null, 0), legStart, 'seeking back gives the same picture with constraints and drivers');
  const armMotionApplied = (await call('scene_apply', { sessionId, expectedRevision: revision, operations: [{ type: 'set-motion', motion }] })).structuredContent;
  revision = armMotionApplied.revision;

  // Clip layers: the legs walk while a layer masked to the right arm waves, found by clip label and joint label.
  const clips = (await call('scene_inspect', { sessionId })).structuredContent.animations;
  const clipOf = label => {
    const found = clips.find(clip => clip.label === label);
    assert.ok(found, `no clip labelled ${label}`);
    return found.id;
  };
  const walkOnlyMotion = { duration: 2, loop: true, layers: [{ clip: clipOf('Walking') }] };
  const walkAndWaveMotion = {
    duration: 2, loop: true,
    layers: [{ clip: clipOf('Walking') }, { clip: clipOf('Wave'), mask: { joints: [idOf('UpperArm.R')] }, morph: false }],
  };
  const walkOnlyApplied = (await call('scene_apply', { sessionId, expectedRevision: revision, operations: [{ type: 'set-motion', motion: walkOnlyMotion }] })).structuredContent;
  assert.equal(walkOnlyApplied.renderSucceeded, true, walkOnlyApplied.renderError);
  revision = walkOnlyApplied.revision;
  const walkOnlyPicture = await look(sessionId, 'layers-walk', 0.5);
  const layersApplied = (await call('scene_apply', { sessionId, expectedRevision: revision, operations: [{ type: 'set-motion', motion: walkAndWaveMotion }] })).structuredContent;
  assert.equal(layersApplied.renderSucceeded, true, layersApplied.renderError);
  revision = layersApplied.revision;
  assert.equal((await call('scene_inspect', { sessionId })).structuredContent.motion.layers, 2);
  const walkAndWaveStart = await look(sessionId, 'layers-walk-wave', 0.5);
  assert.notEqual(walkAndWaveStart, walkOnlyPicture, 'the masked wave layer changes the arm');
  const walkAndWaveLater = await look(sessionId, null, 1.3);
  assert.notEqual(walkAndWaveLater, walkAndWaveStart, 'the character keeps moving');
  assert.equal(await look(sessionId, null, 0.5), walkAndWaveStart, 'seeking back gives the same picture with layers');
  const refused = await client.callTool({ name: 'scene_apply', arguments: { sessionId, expectedRevision: revision, operations: [{
    type: 'set-motion', motion: { duration: 2, layers: [{ clip: clipOf('Wave'), mask: { joints: ['NoSuchBone'] } }] },
  }] } });
  assert.equal(refused.isError, true, 'a mask joint that is not in the asset is refused');
  report.layers = { clips: ['Walking', 'Wave'], mask: 'UpperArm.R' };
  const layersExport = (await call('scene_export_recipe', { sessionId })).structuredContent;
  assert.equal((layersExport.recipe ?? layersExport).motion.layers.length, 2);
  const armAgain = (await call('scene_apply', { sessionId, expectedRevision: revision, operations: [{ type: 'set-motion', motion }] })).structuredContent;
  revision = armAgain.revision;

  const restored = (await call('scene_restore', { sessionId, checkpointId: checkpoint.checkpointId, expectedRevision: revision })).structuredContent;
  revision = restored.revision;
  assert.equal(await look(sessionId), base, 'restore gives back the exact picture from before the IK');

  const again = (await call('scene_apply', { sessionId, expectedRevision: revision, operations: [{ type: 'set-motion', motion }] })).structuredContent;
  assert.equal(again.renderSucceeded, true, again.renderError);
  revision = again.revision;
  const held = await look(sessionId, null, 1);
  const submitted = (await call('scene_render_submit', { sessionId, expectedRevision: revision, settings: {
    kind: 'video', width: 320, height: 320, fps: 8, duration: 0.75, motion: { start: 0 }, animation: { clip: 10, start: 0 },
  } })).structuredContent;
  const record = await finished(submitted.jobId);
  assert.equal(record.state, 'completed', JSON.stringify(record));
  const result = (await call('scene_render_result', { jobId: submitted.jobId })).structuredContent;
  const videoPath = result.artifacts[0].path;
  const decoded = spawnSync('ffmpeg', ['-v', 'error', '-i', videoPath, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-threads', '1', 'pipe:1'], { windowsHide: true, maxBuffer: 64 * 1024 ** 2 });
  assert.equal(decoded.status, 0, decoded.stderr.toString());
  const frameBytes = 320 * 320 * 3;
  assert.equal(decoded.stdout.length, frameBytes * 6, 'the video has every frame');
  assert.notDeepEqual(decoded.stdout.subarray(0, frameBytes), decoded.stdout.subarray(frameBytes * 5, frameBytes * 6), 'the video moves');
  const still = spawnSync('ffmpeg', ['-v', 'error', '-y', '-ss', '0.4', '-i', videoPath, '-frames:v', '1', 'artifacts/character-job-middle.png'], { windowsHide: true, encoding: 'utf8' });
  assert.equal(still.status, 0, still.stderr);
  assert.equal(await look(sessionId), held, 'a job leaves the preview pose exactly as it was');
  report.video = { frames: 6, bytes: result.artifacts[0].bytes };

  const exported = (await call('scene_export_recipe', { sessionId })).structuredContent;
  assert.equal((exported.recipe ?? exported).motion.ik.length, 2);
  await call('scene_dispose', { sessionId });
  console.log(`Character passed on ${backend}: ${JSON.stringify(report)}`);
} finally {
  await client.close();
  await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }).catch(error => console.warn(`Left ${directory}: ${error.code}`));
}
