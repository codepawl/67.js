import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import packageMetadata from '../package.json' with { type: 'json' };

function readJson(relativePath) {
  return JSON.parse(readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8'));
}

const manifest = readJson('.claude-plugin/plugin.json');
const marketplace = readJson('.claude-plugin/marketplace.json');
const syncHint = 'Run `npm run plugin:sync` to copy the version from package.json.';

test('the plugin manifest version matches package.json', () => {
  assert.equal(manifest.version, packageMetadata.version, syncHint);
});

test('every marketplace entry matches the plugin name and version', () => {
  assert.ok(marketplace.plugins.length > 0);
  for (const plugin of marketplace.plugins) {
    assert.equal(plugin.name, manifest.name);
    assert.equal(plugin.version, packageMetadata.version, syncHint);
  }
});

test('the plugin ships both skills that exist in the repository', () => {
  assert.deepEqual(manifest.skills, ['./skills/build-67js-scene', './skills/render-67js-media']);
  for (const skillPath of manifest.skills) {
    assert.ok(existsSync(new URL(`../${skillPath}/SKILL.md`, import.meta.url)), `${skillPath} has no SKILL.md`);
  }
});

test('the plugin starts the published MCP bin and the npm package ships its files', () => {
  const server = manifest.mcpServers['67js'];
  assert.equal(server.command, 'npx');
  const [binName] = Object.keys(packageMetadata.bin);
  assert.deepEqual(server.args, ['-y', '-p', packageMetadata.name, binName]);
  assert.ok(packageMetadata.files.includes('skills'));
  assert.ok(!packageMetadata.files.includes('.claude-plugin'), 'the plugin manifests are for the repository, not the npm tarball');
});
