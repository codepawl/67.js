import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { constants, setPriority, tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { Client } from '@modelcontextprotocol/client';
import { PatientStdioClientTransport } from './patient-stdio-transport.mjs';
import { createAgentPreviewFixture } from './agent-preview-fixture.mjs';
import { createTexturedRigFixture } from './agent-asset-fixture.mjs';

setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL);
const metadata = JSON.parse(await readFile('package.json', 'utf8'));
const published = process.argv.includes('--published');
const protocolOnly = process.argv.includes('--protocol-only');
const consumer = await mkdtemp(join(tmpdir(), '67js-mcp-consumer-'));
await writeFile(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
const npmCli = process.env.npm_execpath ?? resolve(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
function npm(argumentsValue) {
  const result = spawnSync(process.execPath, [npmCli, ...argumentsValue], { cwd: consumer, windowsHide: true, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}
const packResult = JSON.parse(npm(['pack', published ? `${metadata.name}@${metadata.version}` : process.cwd(), '--ignore-scripts', '--json', '--pack-destination', consumer]));
const packed = Array.isArray(packResult) ? packResult[0] : packResult[metadata.name];
assert.ok(packed?.filename, 'npm pack must return the package archive.');
for (const path of ['bin/67js-mcp.mjs', 'build/mcp/server.mjs', 'build/mcp/preview.js', 'build/mcp/manifest.json', 'build/mcp/LICENSES.md']) {
  assert.ok(packed.files.some(file => file.path === path), `Packed CLI must contain ${path}.`);
}
const archive = join(consumer, packed.filename).replaceAll('\\', '/');
npm(['install', `67js@file:${archive}`, ...(published ? [] : ['--offline']), '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund']);
const installedRoot = join(consumer, 'node_modules', '67js');
const installed = JSON.parse(await readFile(join(installedRoot, 'package.json'), 'utf8'));
assert.equal(installed.version, metadata.version);
assert.equal(installed.bin['67js-mcp'], './bin/67js-mcp.mjs');
const sourceManifest = JSON.parse(await readFile('package.json', 'utf8'));
assert.deepEqual(installed.dependencies, { 'playwright-core': sourceManifest.dependencies['playwright-core'] });
for (const dependency of ['vite', 'zod', 'three', 'gl-matrix', '@modelcontextprotocol/server', '@modelcontextprotocol/client', 'playwright']) {
  assert.equal(existsSync(join(consumer, 'node_modules', dependency)), false, `Runtime must not depend on a checkout or ${dependency}.`);
}
assert.equal(existsSync(join(installedRoot, 'src')), false);
assert.equal(existsSync(join(installedRoot, 'scripts')), false);
const manifest = JSON.parse(await readFile(join(installedRoot, 'build', 'mcp', 'manifest.json'), 'utf8'));
assert.equal(manifest.packageVersion, metadata.version);
assert.deepEqual(manifest.licenseGaps, []);
if (published) {
  const revision = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true });
  assert.equal(revision.status, 0, revision.stderr);
  assert.equal(manifest.sourceCommit, revision.stdout.trim());
  assert.equal(manifest.sourceDirty, false);
}
for (const output of manifest.outputs) {
  assert.ok(['preview.js', 'server.mjs', 'LICENSES.md'].includes(output.filename));
  const bytes = await readFile(join(installedRoot, 'build', 'mcp', output.filename));
  assert.equal(bytes.length, output.bytes);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), output.sha256);
}
// The preview page imports engine chunks shared with the package entries, so each one must ship and match.
assert.ok(manifest.previewChunks.length > 0, 'The manifest must list the engine chunks the preview imports.');
for (const chunk of manifest.previewChunks) {
  assert.ok(packed.files.some(file => file.path === `build/${chunk.filename}`), `Packed CLI must contain build/${chunk.filename}.`);
  const bytes = await readFile(join(installedRoot, 'build', chunk.filename));
  assert.equal(bytes.length, chunk.bytes);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), chunk.sha256);
}
const cli = join(installedRoot, 'bin', '67js-mcp.mjs');
// MCP_SERVER_RUNTIME runs the installed server under another runtime, such as bun, while this script stays on Node.
const serverRuntime = process.env.MCP_SERVER_RUNTIME || process.execPath;
const runtimeLabel = process.env.MCP_SERVER_RUNTIME ? `-${process.env.MCP_SERVER_RUNTIME.replace(/^.*[\/]/, '').replace(/.exe$/, '')}` : '';
const version = spawnSync(serverRuntime, [cli, '--version'], { cwd: consumer, encoding: 'utf8', windowsHide: true });
assert.equal(version.status, 0, version.stderr);
assert.equal(version.stdout.trim(), metadata.version);
const help = spawnSync(serverRuntime, [cli, '--help'], { cwd: consumer, encoding: 'utf8', windowsHide: true });
assert.equal(help.status, 0, help.stderr);
assert.match(help.stdout, /--assets/);
const invalid = spawnSync(serverRuntime, [cli, '--memory', '0'], { cwd: consumer, encoding: 'utf8', windowsHide: true });
assert.equal(invalid.status, 1);
assert.equal(invalid.stdout, '');
assert.match(invalid.stderr, /32 to 384/);
const shim = join(consumer, 'node_modules', '.bin', process.platform === 'win32' ? '67js-mcp.cmd' : '67js-mcp');
const shimVersion = process.platform === 'win32'
  ? spawnSync('cmd.exe', ['/d', '/s', '/c', `""${shim}" --version"`], {
    cwd: consumer, encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: true,
  })
  : spawnSync(shim, ['--version'], { cwd: consumer, encoding: 'utf8' });
assert.equal(shimVersion.status, 0, shimVersion.stderr);
assert.equal(shimVersion.stdout.trim(), metadata.version);

const assets = join(consumer, 'assets');
await mkdir(assets);
await writeFile(join(assets, 'textured-rig.glb'), await createTexturedRigFixture());
const results = [];
for (const era of ['modern', 'legacy']) {
  const transport = new PatientStdioClientTransport({ command: serverRuntime,
    args: [cli, '--backend', 'cpu', '--memory', '96', '--assets', assets], cwd: consumer, stderr: 'pipe' });
  let diagnostics = '';
  transport.stderr.on('data', chunk => { diagnostics += chunk.toString(); });
  const client = new Client({ name: '67js-installed-cli-proof', version: '1' }, {
    versionNegotiation: { mode: era === 'modern' ? { pin: '2026-07-28' } : 'legacy', probe: { timeoutMs: 180000 } },
  });
  let processId;
  async function call(name, argumentsValue = {}) {
    const result = await client.callTool({ name, arguments: argumentsValue }, { timeout: 60000 });
    assert.equal(result.isError, undefined, result.content?.find(item => item.type === 'text')?.text);
    return result;
  }
  async function image(sessionId) {
    const result = await call('scene_look', { sessionId, width: 512, height: 512 });
    assert.match(result.structuredContent.graphics, /SwiftShader/);
    assert.ok(result.structuredContent.estimatedBytes < 96 * 1024 * 1024);
    const bytes = Buffer.from(result.content.find(item => item.type === 'image').data, 'base64');
    assert.deepEqual(bytes.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    return bytes;
  }
  try {
    const start = performance.now();
    await client.connect(transport, { timeout: 180000 });
    const connectMs = performance.now() - start;
    processId = transport.pid;
    assert.equal(client.getServerVersion().version, metadata.version);
    assert.equal((await client.listTools()).tools.length, 23);
    const capabilities = (await call('scene_capabilities')).structuredContent;
    assert.equal(capabilities.phase, 'idle');
    assert.equal(capabilities.preview.maximumActiveScenes, 1);
    assert.equal(capabilities.availableIn, metadata.version);
    if (protocolOnly) {
      results.push({ era, tools: 18, connectMs, browserStarted: false });
    } else {
      const created = (await call('scene_create', { recipe: createAgentPreviewFixture() })).structuredContent;
      const before = await image(created.sessionId);
      const checkpoint = (await call('scene_checkpoint', { sessionId: created.sessionId })).structuredContent;
      await call('scene_apply', { sessionId: created.sessionId, expectedRevision: 0,
        operations: [{ type: 'set-environment', environment: { keyIntensity: 2 } }] });
      assert.notDeepEqual(await image(created.sessionId), before);
      await call('scene_restore', { sessionId: created.sessionId, expectedRevision: 1, checkpointId: checkpoint.checkpointId });
      assert.deepEqual(await image(created.sessionId), before);
      await call('scene_dispose', { sessionId: created.sessionId });
      const catalog = (await call('scene_asset_catalog')).structuredContent;
      assert.equal(catalog.assets.length, 1);
      const rig = (await call('scene_create_asset', { recipe: { format: '67js.asset', schemaVersion: 1, assetId: catalog.assets[0].assetId,
        camera: { eye: [1, 3, 7], target: [1, 3, 0], fov: 35, near: 0.1, far: 40 } } })).structuredContent;
      assert.equal(rig.render.materialTextures, 1);
      assert.equal(rig.render.skinTextures, 1);
      const initial = await image(rig.sessionId);
      const sampled = (await call('scene_apply', { sessionId: rig.sessionId, expectedRevision: 0,
        operations: [{ type: 'set-animation', clip: 0, time: 1.1 }] })).structuredContent;
      assert.equal(sampled.renderSucceeded, true);
      assert.equal(sampled.render.gpuBuffers, rig.render.gpuBuffers);
      const bent = await image(rig.sessionId);
      assert.notDeepEqual(bent, initial);
      await call('scene_apply', { sessionId: rig.sessionId, expectedRevision: 1, operations: [{ type: 'set-animation', time: 0.4 }] });
      await call('scene_apply', { sessionId: rig.sessionId, expectedRevision: 2, operations: [{ type: 'set-animation', time: 1.1 }] });
      assert.deepEqual(await image(rig.sessionId), bent);
      const exported = (await call('scene_export_recipe', { sessionId: rig.sessionId })).structuredContent;
      assert.equal(exported.recipe.animation.time, 1.1);
      await mkdir('artifacts', { recursive: true });
      await writeFile(`artifacts/mcp-package-${era}${runtimeLabel}.png`, bent);
      results.push({ era, tools: 18, connectMs, importedTexture: true, importedSkin: true, undoPngExact: true, reverseSeekPngExact: true });
      // Keep the final rig active to prove EOF closes its renderer and owned browser.
    }
  } finally {
    await client.close();
  }
  assert.match(diagnostics, /67js preview resources closed\./);
  assert.doesNotMatch(diagnostics, /cleanup failed|shutdown failed/);
  assert.throws(() => process.kill(processId, 0), /ESRCH/);
}
const report = { packageName: metadata.name, version: metadata.version, archiveBytes: packed.size, cli,
  published, protocolOnly, serverRuntime,
  runtimeDevelopmentDependencies: false, nativeShimVersion: true, builtOutputHashesMatch: true,
  sourceCommit: manifest.sourceCommit, eofWithActiveScene: !protocolOnly, results };
await mkdir('artifacts', { recursive: true });
await writeFile(`artifacts/mcp-package-${published ? 'published' : protocolOnly ? 'protocol' : 'cpu'}${runtimeLabel}.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
