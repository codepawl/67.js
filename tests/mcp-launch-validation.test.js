import './support/load-agent-scene-modules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createAgentRuntime } from '../scripts/agent-runtime.mjs';
import { runMcpCli } from '../scripts/mcp-server.mjs';
import { createAgentScene } from '../src/agent-scene.js';

const ABSOLUTE_FOLDER = tmpdir();

function singleGeometryRecipe(geometry) {
  return {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [geometry],
    materials: [{ id: 'paint', color: [0.5, 0.5, 0.5] }],
    nodes: [{ id: `node-${geometry.id}`, geometry: geometry.id, material: 'paint' }],
  };
}

test('runMcpCli rejects a relative --packs, --assets or --ffmpeg and a missing --browser before serving', async () => {
  const cases = [
    [['--packs', 'relative/packs'], /Packs root must be an explicit absolute directory path\./],
    [['--assets', 'relative/assets'], /Asset root must be an explicit absolute directory path\./],
    [['--ffmpeg', 'relative/ffmpeg'], /FFmpeg must be on PATH or configured with an existing absolute executable path\./],
    [['--browser', '/nope/chrome'], /The configured browser executable does not exist\./],
  ];
  for (const [argumentsValue, message] of cases) {
    await assert.rejects(() => runMcpCli({ argumentsValue: ['--jobs', ABSOLUTE_FOLDER, ...argumentsValue] }), message);
  }
});

test('runMcpCli accepts only on or off for --branches, --relations and --findings', async () => {
  for (const flag of ['--branches', '--relations', '--findings']) {
    for (const value of ['false', '0', 'OFF']) {
      await assert.rejects(() => runMcpCli({ argumentsValue: [flag, value] }),
        error => error.message.includes(`${flag.slice(2)} must be on or off`) && error.message.includes(`"${value}"`));
    }
  }
});

test('scene_restore rejects more than one of checkpointId, revision and branch', async () => {
  const runtime = createAgentRuntime();
  await assert.rejects(() => runtime.restore({ expectedRevision: 2, checkpointId: 'ck0', revision: 1 }),
    /pass exactly one of checkpointId, revision or branch; got checkpointId and revision\./);
  await assert.rejects(() => runtime.restore({ expectedRevision: 2, revision: 1, branch: 'side' }),
    /got revision and branch\./);
});

test('a terrain resolution that is not a number names the real range', () => {
  const recipe = singleGeometryRecipe({ id: 'ground', type: 'terrain', size: 10, resolution: 'abc' });
  assert.throws(() => createAgentScene(recipe, {}), /terrain\.resolution: got "abc"; expected a number from 2 to 256/);
});

test('the geometry preflight error names the geometry and the numbers, and checkpoints only when held', () => {
  const recipe = singleGeometryRecipe({ id: 'ball', type: 'mesh', base: { type: 'sphere', segments: 512, rings: 512 } });
  assert.throws(() => createAgentScene(recipe, {}), error => {
    assert.match(error.message, /needs \d+ vertices \(max \d+\) and \d+ bytes \(max \d+\)/);
    assert.match(error.message, /"ball"/);
    assert.match(error.message, /Reduce detail\.$/);
    assert.doesNotMatch(error.message, /checkpoints\./);
    return true;
  });
});

test('the path tracer text points at the real scene_capabilities topic', async () => {
  const server = await readFile(new URL('../scripts/mcp-server.mjs', import.meta.url), 'utf8');
  const jobs = await readFile(new URL('../skills/render-crucible-media/references/jobs.md', import.meta.url), 'utf8');
  assert.doesNotMatch(server, /scene_capabilities pathTracer/);
  assert.doesNotMatch(jobs, /`scene_capabilities`\s*\(`pathTracer`\)/);
  assert.match(jobs, /topic `jobs`, key `pathTracer`/);
});

test('crucible-mcp --help lists every option runMcpCli accepts', async () => {
  const bin = await readFile(new URL('../bin/crucible-mcp.mjs', import.meta.url), 'utf8');
  for (const option of ['--backend', '--memory', '--browser', '--assets', '--packs', '--jobs', '--ffmpeg', '--audio', '--branches', '--relations', '--findings', '--addons', '--allow-addon']) {
    assert.ok(bin.includes(option), `${option} missing from --help`);
  }
});
