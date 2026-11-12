import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { resolveAddons, addonFileFor, addonImportMap, MAXIMUM_ADDON_BUNDLE_BYTES } from '../scripts/mcp-addons.mjs';
import { runMcpCli } from '../scripts/mcp-server.mjs';
import { VERSION } from '../src/version.js';

const serverEntry = new URL('../bin/67js-mcp.mjs', import.meta.url).pathname.replace(/^\/(\w:)/, '$1');
const starterFolder = new URL('../templates/addon-starter', import.meta.url).pathname.replace(/^\/(\w:)/, '$1');
const hasBuild = existsSync(new URL('../build/mcp/preview.js', import.meta.url));

// A folder with the starter installed under node_modules, after `change` edits its package.json and files.
function installStarter(change = () => {}, name = '67js-addon-starter') {
  const folder = mkdtempSync(join(tmpdir(), 'addons-test-'));
  const packageFolder = join(folder, 'node_modules', ...name.split('/'));
  mkdirSync(join(packageFolder, '..'), { recursive: true });
  cpSync(starterFolder, packageFolder, { recursive: true });
  const path = join(packageFolder, 'package.json');
  const pack = JSON.parse(readFileSync(path, 'utf8'));
  pack.name = name;
  change(pack, packageFolder);
  writeFileSync(path, JSON.stringify(pack));
  return folder;
}

function skippedReason(folder, name = '67js-addon-starter') {
  const { addons, skipped } = resolveAddons({ folder, names: [name], version: VERSION });
  assert.deepEqual(addons, []);
  assert.equal(skipped.length, 1);
  return skipped[0].reason;
}

test('the starter addon passes when it is allowlisted and installed inside the folder', () => {
  const folder = installStarter();
  const { addons, skipped } = resolveAddons({ folder, names: ['67js-addon-starter'], version: VERSION });
  assert.deepEqual(skipped, []);
  assert.equal(addons[0].name, '67js-addon-starter');
  assert.equal(addons[0].entry, 'src/index.js');
  assert.deepEqual(addons[0].extensionPoints, ['registerController']);
});

test('an addon that is installed but not listed is never loaded or served', () => {
  const folder = installStarter();
  const { addons, skipped } = resolveAddons({ folder, names: [], version: VERSION });
  assert.deepEqual(addons, []);
  assert.deepEqual(skipped, []);
  assert.equal(addonFileFor(addons, '/addons/0/src/index.js'), null);
});

test('an addon that is listed but not installed names the install command', () => {
  const folder = installStarter();
  assert.match(skippedReason(folder, 'missing-addon'), /missing-addon is listed with --allow-addon but is not installed.*npm install missing-addon/);
});

test('an addon that fails the contract is skipped with the contract errors', () => {
  const folder = installStarter(pack => { delete pack.keywords; });
  assert.match(skippedReason(folder), /fails the addon contract: .*67js-addon/);
});

test('an addon whose range excludes the running 67js version is skipped', () => {
  const folder = installStarter(pack => { pack['67js'].range = '>=0.1.0 <0.2.0'; });
  assert.match(skippedReason(folder), /does not allow 67js/);
});

test('an addon that declares more than the bundle bound is skipped', () => {
  const folder = installStarter(pack => { pack['67js'].bundleBytes = MAXIMUM_ADDON_BUNDLE_BYTES + 1; });
  assert.match(skippedReason(folder), /above the server bound/);
});

test('conditional exports resolve to the import entry', () => {
  const folder = installStarter(pack => {
    pack.exports = { '.': { import: './src/index.js', require: './missing.cjs' } };
    delete pack.main;
  });
  const { addons, skipped } = resolveAddons({ folder, names: ['67js-addon-starter'], version: VERSION });
  assert.deepEqual(skipped, []);
  assert.equal(addons[0].entry, 'src/index.js');
});

test('a broken entry skips the addon instead of stopping the server', () => {
  const missingEntry = installStarter(pack => {
    pack.exports = './dist/index.js';
    delete pack.main;
  });
  assert.match(skippedReason(missingEntry), /entry file \.\/dist\/index\.js does not exist/);
  const noEntry = installStarter(pack => {
    pack.exports = { './extra': './src/index.js' };
    delete pack.main;
  });
  assert.match(skippedReason(noEntry), /names no entry file/);
});

test('a package whose real path is outside the addons folder is refused', context => {
  const outside = installStarter();
  const folder = mkdtempSync(join(tmpdir(), 'addons-test-'));
  mkdirSync(join(folder, 'node_modules'));
  try {
    symlinkSync(join(outside, 'node_modules', '67js-addon-starter'), join(folder, 'node_modules', '67js-addon-starter'), 'junction');
  } catch (error) {
    context.skip(`cannot create a link here: ${error.message}`);
    return;
  }
  assert.match(skippedReason(folder), /outside the addons folder/);
});

test('a file inside an addon that links outside the package is not served', context => {
  const folder = installStarter();
  const outsideFile = join(folder, 'secret.js');
  writeFileSync(outsideFile, 'export default 1;');
  const { addons } = resolveAddons({ folder, names: ['67js-addon-starter'], version: VERSION });
  const linked = join(addons[0].folder, 'src', 'linked.js');
  try {
    symlinkSync(outsideFile, linked);
  } catch (error) {
    context.skip(`cannot create a link here: ${error.message}`);
    return;
  }
  assert.equal(addonFileFor(addons, '/addons/0/src/linked.js'), null);
  assert.equal(addonFileFor(addons, '/addons/0/../../secret.js'), null);
  assert.equal(addonFileFor(addons, '/addons/0/package.json'), null);
  assert.ok(addonFileFor(addons, '/addons/0/src/index.js'));
  assert.equal(addonFileFor(addons, '/addons/1/src/index.js'), null);
});

test('startup options are checked and the import map covers the addon entries', () => {
  assert.throws(() => resolveAddons({ names: ['x'], version: VERSION }), /--allow-addon needs --addons/);
  assert.throws(() => resolveAddons({ folder: 'relative', names: [], version: VERSION }), /absolute path/);
  const { imports } = addonImportMap({ '.': './build/67.module.js', './addons/player': './build/player.js', './standalone': './build/x.js' });
  assert.deepEqual(imports, { '@codepawlhq/67js': '/67.module.js', '@codepawlhq/67js/addons/player': '/player.js' });
});

test('the server parser takes --allow-addon more than once and keeps the error style', async () => {
  await assert.rejects(runMcpCli({ argumentsValue: ['--allow-addon', 'a'], version: VERSION }), /--allow-addon needs --addons/);
  await assert.rejects(runMcpCli({ argumentsValue: ['--allow-addon'], version: VERSION }), /Use --addons <absolute folder with node_modules>/);
});

function textOf(result) {
  return (result.content ?? []).map(part => part.text ?? '').join('\n');
}

function recipeWithController(controller) {
  return {
    format: '67js.scene', schemaVersion: 1,
    geometries: [{ id: 'cube', type: 'box', bevel: 0 }],
    materials: [{ id: 'blue', color: [0.1, 0.3, 0.8] }],
    nodes: [{ id: 'creature', geometry: 'cube', material: 'blue' }],
    game: { player: { node: 'creature', controller } },
  };
}

async function connect(context, folder, names) {
  const args = [serverEntry, '--backend', 'cpu', '--addons', folder, ...names.flatMap(name => ['--allow-addon', name])];
  const transport = new StdioClientTransport({ command: process.execPath, args, stderr: 'pipe' });
  const client = new Client({ name: 'addons-test', version: '1.0.0' });
  await client.connect(transport);
  context.after(async () => {
    await client.close();
    rmSync(folder, { recursive: true, force: true });
  });
  return client;
}

test('the allowlisted starter loads in the page and its hover controller works through scene_create', { skip: !hasBuild && 'run npm run build first', timeout: 120000 }, async context => {
  const client = await connect(context, installStarter(), ['67js-addon-starter']);
  const refused = await client.callTool({ name: 'scene_create', arguments: { recipe: recipeWithController('boat') } });
  assert.equal(refused.isError, true);
  assert.match(textOf(refused), /Use one of: .*character.*vehicle.*hover/);
  const created = await client.callTool({ name: 'scene_create', arguments: { recipe: recipeWithController('hover') } });
  assert.notEqual(created.isError, true, textOf(created));
  const exported = await client.callTool({ name: 'scene_export_recipe', arguments: {} });
  assert.equal(exported.structuredContent.recipe.game.player.controller, 'hover');
  const topic = await client.callTool({ name: 'scene_capabilities', arguments: { topic: 'addons' } });
  const report = topic.structuredContent?.value ?? JSON.parse(textOf(topic)).value;
  assert.equal(report.loaded[0].name, '67js-addon-starter');
  assert.deepEqual(report.loaded[0].registered.controllers, ['hover']);
  assert.deepEqual(report.skipped, []);
});

test('an addon that registers a point it did not declare is refused and its kind taken back', { skip: !hasBuild && 'run npm run build first', timeout: 120000 }, async context => {
  const folder = installStarter(pack => { pack['67js'].extensionPoints = ['userPass']; });
  const client = await connect(context, folder, ['67js-addon-starter']);
  const created = await client.callTool({ name: 'scene_create', arguments: { recipe: recipeWithController('hover') } });
  assert.equal(created.isError, true);
  const topic = await client.callTool({ name: 'scene_capabilities', arguments: { topic: 'addons' } });
  const report = topic.structuredContent?.value ?? JSON.parse(textOf(topic)).value;
  assert.deepEqual(report.loaded, []);
  assert.match(report.skipped[0].reason, /registered registerController \(hover\) but .* does not declare it/);
});

test('no tool argument can name an addon path or load one', { skip: !hasBuild && 'run npm run build first', timeout: 120000 }, async context => {
  const client = await connect(context, installStarter(), []);
  for (const [name, args] of [
    ['scene_create', { recipe: recipeWithController('hover'), addons: ['67js-addon-starter'] }],
    ['scene_capabilities', { topic: 'addons', addon: '/tmp/evil.js' }],
  ]) {
    let failed = false;
    try {
      const result = await client.callTool({ name, arguments: args });
      failed = result.isError === true;
    } catch {
      failed = true;
    }
    assert.ok(failed, `${name} must reject an addon argument`);
  }
  const created = await client.callTool({ name: 'scene_create', arguments: { recipe: recipeWithController('hover') } });
  assert.equal(created.isError, true, 'a kind from an addon that was not allowed must not exist');
  assert.match(textOf(created), /Use one of: character, vehicle/);
});
