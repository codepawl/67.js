import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { BUNDLED_CUBE_LOOK_NAMES, BUNDLED_ENVIRONMENT_NAMES } from '../src/look-catalog.js';

const serverEntry = new URL('../bin/crucible-mcp.mjs', import.meta.url).pathname.replace(/^\/(\w:)/, '$1');
const hasBuild = existsSync(new URL('../build/mcp/server.mjs', import.meta.url));
const recipe = {
  format: 'crucible.scene', schemaVersion: 1,
  geometries: [{ id: 'cube', type: 'box', bevel: 0 }],
  materials: [{ id: 'blue', color: [0.1, 0.3, 0.8] }],
  nodes: [{ id: 'mesh', geometry: 'cube', material: 'blue' }],
};

function textOf(result) {
  return (result.content ?? []).map(part => part.text ?? '').join('\n');
}

test('the built MCP server reads shipped HDRIs and .cube looks from assets/looks', { skip: !hasBuild && 'run npm run build:lib first', timeout: 120000 }, async context => {
  const transport = new StdioClientTransport({ command: process.execPath, args: [serverEntry, '--backend', 'cpu'], stderr: 'ignore' });
  const client = new Client({ name: 'packaged-looks-test', version: '1.0.0' });
  await client.connect(transport);
  context.after(() => client.close());
  const created = await client.callTool({ name: 'scene_create', arguments: { recipe } });
  if (created.isError) {
    context.skip(`no browser for the scene: ${textOf(created).slice(0, 120)}`);
    return;
  }
  const { sessionId } = created.structuredContent;
  let revision = created.structuredContent.revision;
  for (const environment of [{ hdri: BUNDLED_ENVIRONMENT_NAMES[0] }, { look: BUNDLED_CUBE_LOOK_NAMES[0] }]) {
    const applied = await client.callTool({ name: 'scene_apply', arguments: { sessionId, expectedRevision: revision, operations: [{ type: 'set-environment', environment }] } });
    assert.notEqual(applied.isError, true, textOf(applied));
    assert.doesNotMatch(textOf(applied), /scheme file/);
    revision = applied.structuredContent?.revision ?? revision + 1;
  }
});

test('the npm archive ships every bundled HDRI and .cube look', { timeout: 120000 }, () => {
  const output = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { encoding: 'utf8', shell: true });
  const report = JSON.parse(output);
  const paths = (Array.isArray(report) ? report[0] : Object.values(report)[0]).files.map(file => file.path);
  for (const name of BUNDLED_ENVIRONMENT_NAMES) assert.ok(paths.includes(`assets/looks/${name}.hdr`), name);
  for (const name of BUNDLED_CUBE_LOOK_NAMES) assert.ok(paths.includes(`assets/looks/${name}.cube`), name);
});
