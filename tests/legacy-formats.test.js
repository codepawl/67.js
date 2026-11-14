import './support/load-agent-scene-modules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseGltf } from '../src/gltf.js';
import { createAgentScene } from '../src/agent-scene.js';
import { createAgentAssetScene } from '../src/agent-asset.js';
import { loadPack } from '../scripts/agent-packs.mjs';
import { validatePackScene } from '../scripts/pack-scene-validator.mjs';
import { validatePackManifest } from '../src/pack-manifest.js';
import { skinnedStripAsset } from './fixtures/skinned-strip.js';
import packageMetadata from '../package.json' with { type: 'json' };

const EXAMPLE_PACK = new URL('../packs/example-starter', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

test('a recipe saved with the old 67js.scene format still loads and is saved with the new format', () => {
  const scene = createAgentScene({ format: '67js.scene', schemaVersion: 1, geometries: [], materials: [], nodes: [] });
  assert.equal(scene.exportRecipe().format, 'crucible.scene');
});

test('an asset recipe saved with the old 67js.asset format still loads and is saved with the new format', async () => {
  const asset = await parseGltf(skinnedStripAsset());
  const scene = createAgentAssetScene(asset, { format: '67js.asset', schemaVersion: 1, assetId: 'ab'.repeat(32) });
  assert.equal(scene.exportRecipe().format, 'crucible.asset');
});

test('a pack with 67js-pack.json, the 67js.pack format, the 67js engines key and a 67js.scene recipe still loads', async context => {
  const folder = mkdtempSync(join(tmpdir(), 'crucible-legacy-pack-'));
  context.after(() => rmSync(folder, { recursive: true, force: true }));
  const warnings = [];
  context.mock.method(console, 'warn', message => warnings.push(message));
  const packFolder = join(folder, 'old-pack');
  cpSync(EXAMPLE_PACK, packFolder, { recursive: true });
  renameSync(join(packFolder, 'crucible-pack.json'), join(packFolder, '67js-pack.json'));
  const manifest = JSON.parse(readFileSync(join(packFolder, '67js-pack.json'), 'utf8'));
  manifest.format = '67js.pack';
  manifest.engines = { '67js': manifest.engines.crucible };
  writeFileSync(join(packFolder, '67js-pack.json'), JSON.stringify(manifest));
  const recipePath = join(packFolder, 'recipes/crates.json');
  const recipe = JSON.parse(readFileSync(recipePath, 'utf8'));
  recipe.format = '67js.scene';
  writeFileSync(recipePath, JSON.stringify(recipe));

  const pack = await loadPack(packFolder, { packageVersion: packageMetadata.version, validateScene: validatePackScene });
  assert.equal(pack.name, 'example-starter');
  assert.deepEqual(pack.items.recipes.map(item => item.id), ['crates']);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /67js-pack\.json.*crucible-pack\.json/);
});

test('validating an old manifest returns the new format and engines key', () => {
  const manifest = JSON.parse(readFileSync(join(EXAMPLE_PACK, 'crucible-pack.json'), 'utf8'));
  manifest.format = '67js.pack';
  manifest.engines = { '67js': manifest.engines.crucible };
  const saved = validatePackManifest(manifest, { label: 'old', packageVersion: packageMetadata.version });
  assert.equal(saved.format, 'crucible.pack');
  assert.deepEqual(Object.keys(saved.engines), ['crucible']);
});
