import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const serverEntry = new URL('../bin/67js-mcp.mjs', import.meta.url).pathname.replace(/^\/(\w:)/, '$1');
const hasBuild = existsSync(new URL('../build/mcp/server.mjs', import.meta.url));

// Starts the server on `jobsDirectory`, takes the job store lock with a status call on an unknown job (no browser needed),
// then closes the connection the way client.close() does and reports whether the lock file is still there.
async function startAskAndClose(jobsDirectory) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [serverEntry, '--backend', 'cpu', '--jobs', jobsDirectory], stderr: 'ignore' });
  const client = new Client({ name: 'job-lock-test', version: '1.0.0' });
  await client.connect(transport);
  const result = await client.callTool({ name: 'scene_render_status', arguments: { jobId: randomUUID() } });
  assert.equal(result.isError, true, 'an unknown job is an error, not a crash');
  assert.ok(existsSync(join(jobsDirectory, 'store.lock')), 'the server holds the lock while it runs');
  await client.close();
  return existsSync(join(jobsDirectory, 'store.lock'));
}

test('the MCP server gives back store.lock when the client closes, so the next run starts', { skip: !hasBuild && 'run npm run build:lib first', timeout: 60000 }, async context => {
  const jobsDirectory = await mkdtemp(join(tmpdir(), '67js-job-lock-'));
  context.after(() => rm(jobsDirectory, { recursive: true, force: true }));
  assert.equal(await startAskAndClose(jobsDirectory), false, 'first run leaves no lock');
  assert.equal(await startAskAndClose(jobsDirectory), false, 'second run starts and leaves no lock');
});

test('a process that exits without closing the job controller still removes its lock', { timeout: 30000 }, async context => {
  const jobsDirectory = await mkdtemp(join(tmpdir(), '67js-job-lock-'));
  context.after(() => rm(jobsDirectory, { recursive: true, force: true }));
  const controllerUrl = new URL('../scripts/agent-render-jobs.mjs', import.meta.url).href;
  const source = `import { createAgentRenderJobs } from ${JSON.stringify(controllerUrl)};
    await createAgentRenderJobs({ root: ${JSON.stringify(jobsDirectory)}, run: async () => {} });
    process.exit(0);`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(existsSync(join(jobsDirectory, 'store.lock')), false);
});
