import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { constants, setPriority, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { mat4 } from 'gl-matrix';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { FACE_TARGETS, MIXAMO_LIKE, UNREAL_LIKE, humanoidGlb, humanoidJoints, walkTracks } from '../tests/fixtures/humanoid-glb.js';

// Proof through MCP for retargeting: a walk from one humanoid file plays on a second humanoid with another rest pose and
// proportions, the feet are pinned during contact, the sole follows a slope, and a face blinks and opens its jaw from keyed
// morph weights. Foot positions are read from GLB files the server exports at sampled motion times.

setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL);
const directory = await mkdtemp(join(tmpdir(), 'crucible-mcp-retarget-'));
const jobs = join(directory, 'jobs');
const assets = join(directory, 'assets');
await mkdir(assets);

const sourceJoints = humanoidJoints();
const targetJoints = humanoidJoints({ hipsHeight: 1.1, thigh: 0.62, shin: 0.48, armTiltDegrees: 30 });
const sourceBytes = Buffer.from(humanoidGlb({ names: MIXAMO_LIKE, joints: sourceJoints, clips: [{ name: 'Walk', duration: 1, tracks: walkTracks(sourceJoints) }] }));
const targetBytes = Buffer.from(humanoidGlb({ names: UNREAL_LIKE, joints: targetJoints, face: true }));
const idOf = bytes => createHash('sha256').update(bytes).digest('hex');
const sourceId = idOf(sourceBytes);
const targetId = idOf(targetBytes);
await writeFile(join(assets, 'source.glb'), sourceBytes);
await writeFile(join(assets, 'target.glb'), targetBytes);

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [resolve(process.argv[2] ?? 'bin/crucible-mcp.mjs'), '--backend', 'cpu', '--memory', '96', '--jobs', jobs, '--assets', assets],
  cwd: directory, stderr: 'pipe',
});
let diagnostics = '';
transport.stderr.on('data', bytes => { diagnostics = (diagnostics + bytes).slice(-8192); });
const client = new Client({ name: 'crucible-retarget-proof', version: '1' });

async function call(name, argumentsValue = {}, timeout = 60000) {
  const result = await client.callTool({ name, arguments: argumentsValue }, { timeout });
  assert.equal(result.isError, undefined, result.content?.find(item => item.type === 'text')?.text);
  return result;
}

/** World matrix of a named node in a GLB the server wrote, from the posed node transforms. */
function nodeWorldMatrix(glb, name) {
  const jsonLength = glb.readUInt32LE(12);
  const document = JSON.parse(glb.subarray(20, 20 + jsonLength).toString('utf8'));
  const parents = new Map();
  document.nodes.forEach((node, index) => (node.children ?? []).forEach(child => parents.set(child, index)));
  let index = document.nodes.findIndex(node => node.name === name);
  assert.ok(index >= 0, `the export has no node ${name}`);
  let world = mat4.create();
  while (index !== undefined) {
    const node = document.nodes[index];
    const local = node.matrix
      ? mat4.clone(node.matrix)
      : mat4.fromRotationTranslationScale(mat4.create(), node.rotation ?? [0, 0, 0, 1], node.translation ?? [0, 0, 0], node.scale ?? [1, 1, 1]);
    world = mat4.multiply(mat4.create(), local, world);
    index = parents.get(index);
  }
  return world;
}

async function exportedGlb(sessionId, motionTime) {
  const exported = (await call('scene_export_glb', { sessionId, motionTime })).structuredContent;
  return readFile(exported.path);
}

async function footAt(sessionId, node, motionTime) {
  return Array.from(nodeWorldMatrix(await exportedGlb(sessionId, motionTime), node).subarray(12, 15));
}

async function maximumDrift(sessionId, node, phases) {
  let worst = 0;
  for (const phase of phases) {
    const anchor = await footAt(sessionId, node, phase.start);
    for (let step = 1; step <= 8; step++) {
      const position = await footAt(sessionId, node, phase.start + (phase.end - phase.start) * step / 8);
      worst = Math.max(worst, Math.hypot(position[0] - anchor[0], position[1] - anchor[1], position[2] - anchor[2]));
    }
  }
  return worst;
}

const walkLayer = { from: { asset: sourceId, clip: 0 }, scale: 1.25 };
const footLock = { contactHeight: 0.06, contactSpeed: 1.2 };
const angle = 10 * Math.PI / 180;
const slope = [0, Math.cos(angle), -Math.sin(angle)];

/** Creates the target character with a motion, runs the check on its session, and disposes it: one scene at a time. */
async function withTarget(motion, check) {
  const recipe = { format: 'crucible.asset', schemaVersion: 1, assetId: targetId, motion: { duration: 1, loop: true, ...motion } };
  const sessionId = (await call('scene_create_asset', { recipe }, 180000)).structuredContent.sessionId;
  try {
    return await check(sessionId);
  } finally {
    await call('scene_dispose', { sessionId });
  }
}

const inspectHierarchy = async sessionId => (await call('scene_inspect', { sessionId, kind: 'hierarchy', limit: 64 })).structuredContent;

try {
  await client.connect(transport);

  const locked = await withTarget({ layers: [walkLayer], footLock }, async sessionId => {
    const hierarchy = await inspectHierarchy(sessionId);
    assert.deepEqual(hierarchy.retargets[0].source.missing, []);
    assert.deepEqual(hierarchy.retargets[0].target.missing, []);
    assert.equal(hierarchy.retargets[0].target.mapped, 15);
    const feet = hierarchy.footLock.feet;
    assert.ok(feet.length === 2 && feet.every(foot => foot.phases.length >= 1), JSON.stringify(feet));
    const drift = [];
    for (const foot of feet) {
      drift.push(await maximumDrift(sessionId, UNREAL_LIKE[foot.bone], foot.phases));
    }
    return { feet, drift };
  });
  locked.drift.forEach((drift, slot) => assert.ok(drift < 0.02, `with the lock ${locked.feet[slot].bone} slides ${drift} m`));

  const slide = await withTarget({ layers: [walkLayer] }, sessionId => maximumDrift(sessionId, UNREAL_LIKE[locked.feet[0].bone], locked.feet[0].phases));
  assert.ok(slide > 0.02, `without the lock the foot should slide, drift ${slide}`);

  const slopeDegrees = await withTarget({ layers: [walkLayer], footLock: { ...footLock, ground: { height: 0, normal: slope } } }, async sessionId => {
    const phase = (await inspectHierarchy(sessionId)).footLock.feet[0].phases[0];
    const sole = nodeWorldMatrix(await exportedGlb(sessionId, (phase.start + phase.end) / 2), UNREAL_LIKE.leftFoot);
    const length = Math.hypot(sole[4], sole[5], sole[6]);
    const cosine = (sole[4] * slope[0] + sole[5] * slope[1] + sole[6] * slope[2]) / length;
    return Math.acos(Math.min(1, cosine)) * 180 / Math.PI;
  });
  assert.ok(slopeDegrees < 5, `the planted sole is ${slopeDegrees} degrees off the ground normal`);

  const faceMotion = { duration: 2, loop: false, tracks: [
    { kind: 'morph', id: 'eyeBlinkLeft', property: 'weight', keyframes: [{ time: 0.5, value: 0 }, { time: 0.6, value: 1 }, { time: 0.7, value: 0 }] },
    { kind: 'morph', id: 'jawOpen', property: 'weight', keyframes: [{ time: 0, value: 0 }, { time: 1, value: 0.5 }] },
  ] };
  await withTarget(faceMotion, async sessionId => {
    assert.deepEqual((await inspectHierarchy(sessionId)).morphTargetNames, FACE_TARGETS);
    const faceLook = async motionTime => (await call('scene_look', { sessionId, motionTime, width: 160, height: 160 })).content.find(item => item.type === 'image').data;
    const faceExport = async motionTime => (await exportedGlb(sessionId, motionTime)).toString('base64');
    const blinkExport = await faceExport(0.6);
    const blinkLook = await faceLook(0.6);
    assert.notEqual(await faceExport(1.5), blinkExport, 'keyed weights change the exported face');
    assert.notEqual(await faceLook(1.5), blinkLook, 'keyed weights change the picture');
    assert.equal(await faceExport(0.6), blinkExport, 'seeking back repeats the exported bytes');
    assert.equal(await faceLook(0.6), blinkLook, 'seeking back repeats the PNG bytes');
  });

  console.log(JSON.stringify({
    unlockedSlideMetres: Number(slide.toFixed(4)),
    lockedDriftMetres: locked.drift.map(value => Number(value.toFixed(4))),
    slopeDegrees: Number(slopeDegrees.toFixed(2)),
    morphSeekExact: true,
  }));
} finally {
  await client.close();
  if (diagnostics.includes('Error')) console.error(diagnostics);
}
