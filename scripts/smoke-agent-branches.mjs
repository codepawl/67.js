import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir, constants, setPriority } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/client';
import { PatientStdioClientTransport } from './patient-stdio-transport.mjs';
import { createAgentPreviewFixture } from './agent-preview-fixture.mjs';

// Drives the installed MCP server on SwiftShader: branches, a branch review and labels, through real tool calls.
setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL);
const directory = await mkdtemp(join(tmpdir(), '67js-branches-proof-'));
const cli = resolve(process.argv[2] ?? 'bin/67js-mcp.mjs');
const transport = new PatientStdioClientTransport({ command: process.execPath,
  args: [cli, '--backend', 'cpu', '--memory', '96'], cwd: directory, stderr: 'pipe' });
const client = new Client({ name: '67js-branches-proof', version: '1' });

async function call(name, argumentsValue) {
  const result = await client.callTool({ name, arguments: argumentsValue }, { timeout: 60000 });
  assert.equal(result.isError, undefined, result.content?.find(item => item.type === 'text')?.text);
  return result;
}

async function rejected(name, argumentsValue) {
  const result = await client.callTool({ name, arguments: argumentsValue }, { timeout: 60000 });
  assert.equal(result.isError, true, `${name} must reject ${JSON.stringify(argumentsValue).slice(0, 80)}`);
}

function imageBytes(result) {
  return Buffer.from(result.content.find(item => item.type === 'image').data, 'base64');
}

function decodedPixels(bytes, crop) {
  const decoded = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0',
    ...(crop ? ['-vf', crop] : []), '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1'],
    { input: bytes, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  assert.equal(decoded.status, 0, decoded.stderr.toString());
  return decoded.stdout;
}

function recolor(color) {
  return [{ type: 'set-material', id: 'light', color, emissiveColor: color }];
}

try {
  await client.connect(transport);
  const created = (await call('scene_create', { recipe: createAgentPreviewFixture() })).structuredContent;
  const sessionId = created.sessionId;
  const settings = { sessionId, expectedRevision: 0 };
  const sourceBefore = decodedPixels(imageBytes(await call('scene_look', { sessionId, width: 256, height: 256 })));
  const checkpoint = (await call('scene_checkpoint', { sessionId })).structuredContent;
  const recipeBefore = (await call('scene_export_recipe', { sessionId })).structuredContent.recipe;

  const variants = { warm: [1, 0.3, 0.1], cool: [0.1, 0.4, 1], twin: [0.1, 0.4, 1] };
  const forks = {};
  for (const [name, color] of Object.entries(variants)) {
    forks[name] = (await call('scene_apply', { ...settings, branch: name, operations: recolor(color) })).structuredContent;
  }
  assert.equal(forks.twin.shared, true, 'identical recipes share one snapshot');
  assert.equal(forks.twin.snapshots, 2);
  assert.equal(forks.twin.sourceRevision, 0, 'a fork does not consume a revision');

  const review = await call('scene_review', { ...settings, width: 256, height: 256, labels: true,
    shots: [{ branch: 'warm' }, { branch: 'cool' }, { label: 'Source' }, { branch: 'twin', label: 'Twin' }] });
  const shots = review.structuredContent.shots;
  assert.deepEqual(shots.map(shot => shot.branch), ['warm', 'cool', undefined, 'twin']);
  const grid = imageBytes(review);
  if (process.env.BRANCH_SMOKE_IMAGE) await writeFile(process.env.BRANCH_SMOKE_IMAGE, grid);
  const warmShot = decodedPixels(grid, 'crop=256:256:0:24');
  const coolShot = decodedPixels(grid, 'crop=256:256:256:24');
  const sourceShot = decodedPixels(grid, 'crop=256:256:0:304');
  assert.notDeepEqual(warmShot, coolShot, 'branches render different scenes');
  assert.notDeepEqual(warmShot, sourceShot);
  for (const shot of shots) {
    assert.ok(shot.labels.length > 0 && shot.labels.length <= 24);
    for (const label of shot.labels) {
      assert.ok(label.x >= 0 && label.x <= 256 && label.y >= 0 && label.y <= 256, 'label inside the shot');
      assert.equal(typeof label.id, 'string');
    }
  }

  const afterReview = (await call('scene_inspect', { sessionId })).structuredContent;
  assert.equal(afterReview.revision, 0, 'review and branches leave the revision alone');
  assert.deepEqual((await call('scene_export_recipe', { sessionId })).structuredContent.recipe, recipeBefore);
  assert.deepEqual(decodedPixels(imageBytes(await call('scene_look', { sessionId, width: 256, height: 256 }))), sourceBefore,
    'the source image is identical after branching and review');

  const labelled = await call('scene_look', { sessionId, width: 384, height: 384, labels: true });
  assert.ok(labelled.structuredContent.labels.length > 0);
  assert.notDeepEqual(decodedPixels(imageBytes(labelled)), decodedPixels(imageBytes(await call('scene_look', { sessionId, width: 384, height: 384 }))));

  for (const hostile of ['', 'Warm', '1warm', 'a'.repeat(25), '../x', 'a b', 'a\nb', 'http://example.com/x', '__proto__ ', 'a;rm']) {
    await rejected('scene_apply', { ...settings, branch: hostile, operations: recolor([1, 1, 1]) });
    await rejected('scene_review', { ...settings, shots: [{ branch: hostile }] });
    await rejected('scene_restore', { sessionId, expectedRevision: 0, branch: hostile });
  }
  await rejected('scene_review', { ...settings, shots: [{ branch: 'missing' }] });
  await rejected('scene_review', { ...settings, labels: 'yes', shots: [{ label: 'x' }] });
  await rejected('scene_restore', { sessionId, expectedRevision: 0 });

  const kept = (await call('scene_restore', { sessionId, expectedRevision: 0, branch: 'cool' })).structuredContent;
  assert.equal(kept.revision, 1);
  assert.equal(kept.kept, 'cool');
  await rejected('scene_review', { sessionId, expectedRevision: 1, shots: [{ branch: 'warm' }] });
  const restored = (await call('scene_restore', { sessionId, expectedRevision: 1, checkpointId: checkpoint.checkpointId })).structuredContent;
  assert.equal(restored.revision, 2);

  // Undo two edits with one call and no checkpoint: the pixels and the recipe match the scene before them.
  await call('scene_apply', { sessionId, expectedRevision: 2, operations: recolor([1, 0.3, 0.1]) });
  await call('scene_apply', { sessionId, expectedRevision: 3, operations: recolor([0.1, 1, 0.1]) });
  assert.notDeepEqual(decodedPixels(imageBytes(await call('scene_look', { sessionId, width: 256, height: 256 }))), sourceBefore);
  const unknownRevision = await client.callTool({ name: 'scene_restore', arguments: { sessionId, expectedRevision: 4, revision: 99 } }, { timeout: 60000 });
  assert.equal(unknownRevision.isError, true);
  assert.match(unknownRevision.content[0].text, /kept revisions: 0, 1, 2, 3/);
  const undone = (await call('scene_restore', { sessionId, expectedRevision: 4, revision: 2 })).structuredContent;
  assert.equal(undone.revision, 5);
  assert.deepEqual((await call('scene_export_recipe', { sessionId })).structuredContent.recipe, recipeBefore);
  assert.deepEqual(decodedPixels(imageBytes(await call('scene_look', { sessionId, width: 256, height: 256 }))), sourceBefore,
    'restoring an earlier revision gives the same image as before the edits');
  await call('scene_dispose', { sessionId });
  console.log('Branch smoke passed: fork, shared snapshot, review, labels, keep, revision undo, hostile names.');
} finally {
  await client.close().catch(() => {});
}
