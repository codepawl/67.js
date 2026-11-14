import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { constants, setPriority, tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { Client } from '@modelcontextprotocol/client';
import { PatientStdioClientTransport } from './patient-stdio-transport.mjs';

// Proves the heavy scene kernels run on a worker in Chrome, from the installed package: the worker file ships and
// resolves, scene_create sends kernels to it, and none fell back to the main thread. A failing worker falls back
// silently, so the preview counts both (scene_inspect kernels) and this smoke reads the counts.
// Usage: node scripts/smoke-kernel-workers.mjs [--backend cpu|gpu] [recipe.json]

setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL);
const backendIndex = process.argv.indexOf('--backend');
const backend = backendIndex === -1 ? 'gpu' : process.argv[backendIndex + 1];
const recipePath = process.argv.slice(2).find((argument, index, all) => argument.endsWith('.json') && all[index - 1] !== '--backend')
  ?? 'tests/fixtures/demo-room.recipe.json';
const recipe = JSON.parse(await readFile(recipePath, 'utf8'));
const metadata = JSON.parse(await readFile('package.json', 'utf8'));
const consumer = await mkdtemp(join(tmpdir(), 'crucible-kernel-consumer-'));
await writeFile(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }));

const npmCli = process.env.npm_execpath ?? resolve(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
function npm(argumentsValue) {
  const result = spawnSync(process.execPath, [npmCli, ...argumentsValue], { cwd: consumer, windowsHide: true, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}
const packResult = JSON.parse(npm(['pack', process.cwd(), '--ignore-scripts', '--json', '--pack-destination', consumer]));
const packed = Array.isArray(packResult) ? packResult[0] : packResult[metadata.name];
assert.ok(packed.files.some(file => file.path === 'build/kernel-worker.js'), 'The package must ship build/kernel-worker.js.');
const archive = join(consumer, packed.filename).replaceAll('\\', '/');
npm(['install', `crucible@file:${archive}`, '--offline', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund']);
// The demo recipe has boolean edits, which need the optional peer manifold-3d beside the package, as a user installs it.
await cp(resolve('node_modules/manifold-3d'), join(consumer, 'node_modules', 'manifold-3d'), { recursive: true });
const cli = join(consumer, 'node_modules', 'crucible', 'bin', 'crucible-mcp.mjs');

const transport = new PatientStdioClientTransport({ command: process.execPath, args: [cli, '--backend', backend, '--memory', '192'], cwd: consumer, stderr: 'pipe' });
let diagnostics = '';
transport.stderr.on('data', chunk => { diagnostics += chunk.toString(); });
const client = new Client({ name: 'crucible-kernel-worker-proof', version: '1' }, { versionNegotiation: { mode: 'legacy', probe: { timeoutMs: 180000 } } });
try {
  await client.connect(transport, { timeout: 180000 });
  const startedAt = performance.now();
  const created = await client.callTool({ name: 'scene_create', arguments: { recipe } }, { timeout: 280000 });
  assert.equal(created.isError, undefined, created.content?.find(item => item.type === 'text')?.text);
  const createMilliseconds = Math.round(performance.now() - startedAt);
  const sessionId = created.structuredContent.sessionId;
  const inspected = await client.callTool({ name: 'scene_inspect', arguments: { sessionId } }, { timeout: 60000 });
  const { kernels } = inspected.structuredContent;
  assert.ok(kernels, 'scene_inspect must report kernels.');
  assert.ok(kernels.worker > 0, `Kernels must run on the worker; counts: ${JSON.stringify(kernels)}`);
  assert.deepEqual(kernels.fallbacks, [], `No kernel may fall back to the main thread: ${JSON.stringify(kernels.fallbacks)}`);
  assert.doesNotMatch(diagnostics, /kernel fallback/);
  await client.callTool({ name: 'scene_dispose', arguments: { sessionId } }, { timeout: 60000 });
  const { bake } = inspected.structuredContent;
  const bakeSummary = bake ? { used: bake.used, reduced: bake.reduced, seconds: bake.seconds } : undefined;
  console.log(JSON.stringify({ backend, createMilliseconds, bake: bakeSummary, kernels }));
} finally {
  await client.close();
}
