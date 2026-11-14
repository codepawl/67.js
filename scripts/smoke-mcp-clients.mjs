import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createAgentPreviewFixture } from './agent-preview-fixture.mjs';

// Pinned so a client release cannot change the result unnoticed.
const INSPECTOR_VERSION = '2.13.0';
const PYTHON_SDK_VERSION = '2.3.0';
const EXPECTED_TOOL_COUNT = 22;
const COMMAND_TIMEOUT_MS = 240000;
// Run npx's own script with node so no shell has to quote the JSON arguments.
const npxCli = resolve(dirname(process.execPath), process.platform === 'win32'
  ? 'node_modules/npm/bin/npx-cli.js'
  : '../lib/node_modules/npm/bin/npx-cli.js');

const serverScript = resolve('scripts/mcp-server.mjs');
const pythonClientScript = resolve('scripts/smoke-mcp-python-client.py');
// The clients run from an empty folder so they cannot pick up this repo's files.
const workFolder = mkdtempSync(join(tmpdir(), 'crucible-mcp-clients-'));
const recipePath = join(workFolder, 'recipe.json');
writeFileSync(recipePath, JSON.stringify(createAgentPreviewFixture()));
const results = [];

function run(command, args) {
  const started = Date.now();
  const outcome = spawnSync(command, args, {
    cwd: workFolder,
    encoding: 'utf8',
    timeout: COMMAND_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
  });
  return { ...outcome, seconds: Number(((Date.now() - started) / 1000).toFixed(1)) };
}

function inspector(...methodArguments) {
  return run(process.execPath, [
    npxCli, '-y', `@modelcontextprotocol/inspector@${INSPECTOR_VERSION}`, '--cli',
    process.execPath, serverScript, '--backend', 'cpu', '--memory', '192', ...methodArguments,
  ]);
}

function record(client, version, step, passed, seconds, note = '') {
  results.push({ client, version, step, passed, seconds, note });
}

try {
  const listed = inspector('--method', 'tools/list');
  assert.equal(listed.status, 0, listed.stderr);
  const toolCount = JSON.parse(listed.stdout).tools.length;
  assert.equal(toolCount, EXPECTED_TOOL_COUNT);
  record('MCP Inspector CLI', INSPECTOR_VERSION, 'tools/list', true, listed.seconds, `${toolCount} tools`);

  const recipeArgument = `recipe=${JSON.stringify(createAgentPreviewFixture())}`;
  const called = inspector('--method', 'tools/call', '--tool-name', 'scene_create', '--tool-arg', recipeArgument);
  assert.equal(called.status, 0, called.stderr);
  assert.notEqual(JSON.parse(called.stdout).isError, true);
  record('MCP Inspector CLI', INSPECTOR_VERSION, 'tools/call scene_create', true, called.seconds);

  // The Inspector CLI starts a new server for each command, and the scene lives in the
  // server process, so scene_look cannot see the scene made above. Record what it does.
  const looked = inspector('--method', 'tools/call', '--tool-name', 'scene_look');
  assert.ok(!(looked.stdout + looked.stderr).includes('"type": "image"'), 'scene_look unexpectedly returned an image');
  record('MCP Inspector CLI', INSPECTOR_VERSION, 'tools/call scene_look in a fresh server', false, looked.seconds, 'no scene in a new process, so no image');

  const python = run('uv', ['run', '--no-project', '--with', `mcp==${PYTHON_SDK_VERSION}`,
    'python', '-I', pythonClientScript, process.execPath, serverScript, recipePath]);
  assert.equal(python.status, 0, python.stderr);
  const summary = JSON.parse(python.stdout.trim().split('\n').pop());
  assert.equal(summary.tools, EXPECTED_TOOL_COUNT);
  record('MCP Python SDK', PYTHON_SDK_VERSION, 'initialize, tools/list, scene_create, scene_look PNG', true, python.seconds, `${summary.pngBytes} byte PNG`);
} finally {
  rmSync(workFolder, { recursive: true, force: true });
  console.table(results);
}
