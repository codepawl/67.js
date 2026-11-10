import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import packageMetadata from '../package.json' with { type: 'json' };

const marketplace = JSON.parse(readFileSync(new URL('../.claude-plugin/marketplace.json', import.meta.url), 'utf8'));
const [plugin] = marketplace.plugins;
const syncHint = 'Run `npm run plugin:sync` to copy the version from package.json.';

test('the marketplace lists one plugin whose version matches package.json', () => {
  assert.equal(marketplace.plugins.length, 1);
  assert.equal(plugin.name, '67js');
  assert.equal(plugin.version, packageMetadata.version, syncHint);
});

test('the plugin source is the skills folder, so the install cache stays small', () => {
  assert.equal(plugin.source, './skills');
  assert.equal(plugin.strict, false);
});

test('the plugin ships both skills that exist in the repository', () => {
  assert.deepEqual(plugin.skills, ['./build-67js-scene', './render-67js-media']);
  for (const skillPath of plugin.skills) {
    assert.ok(existsSync(new URL(`../skills/${skillPath}/SKILL.md`, import.meta.url)), `${skillPath} has no SKILL.md`);
  }
});

test('the plugin starts the published MCP bin and the npm package ships its files', () => {
  const server = plugin.mcpServers['67js'];
  assert.equal(server.command, 'npx');
  const [binName] = Object.keys(packageMetadata.bin);
  assert.deepEqual(server.args, ['-y', '-p', packageMetadata.name, binName]);
  assert.ok(packageMetadata.files.includes('skills'));
  assert.ok(!packageMetadata.files.includes('.claude-plugin'), 'the plugin manifests are for the repository, not the npm tarball');
});
