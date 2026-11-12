import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import browserConfiguration, { STANDALONE_FILE_NAME } from '../vite.browser.config.js';

const metadata = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const prepareRelease = await readFile(new URL('../scripts/prepare-release.mjs', import.meta.url), 'utf8');
const installGuide = await readFile(new URL('../docs/learn/install.md', import.meta.url), 'utf8');

test('the standalone module builds into build/ after the library build without emptying it', () => {
  assert.equal(STANDALONE_FILE_NAME, '67.standalone.js');
  assert.equal(browserConfiguration.build.outDir, 'build');
  assert.equal(browserConfiguration.build.emptyOutDir, false);
  assert.deepEqual(browserConfiguration.build.lib.formats, ['es']);
  assert.equal(browserConfiguration.build.lib.fileName(), STANDALONE_FILE_NAME);
  const libraryStep = metadata.scripts['build:lib'].indexOf('vite.lib.config.js');
  const standaloneStep = metadata.scripts['build:lib'].indexOf('vite.browser.config.js');
  assert.ok(libraryStep >= 0 && standaloneStep > libraryStep, 'build:lib must run the standalone build after the library build.');
});

test('the package ships the standalone module and exports it', () => {
  assert.ok(metadata.files.includes('build'));
  assert.ok(!metadata.files.includes('!build/67.standalone.js'));
  assert.equal(metadata.exports['./standalone'], './build/67.standalone.js');
});

test('release preparation builds the standalone module before npm pack and checks the site copy byte for byte', () => {
  const standaloneBuild = prepareRelease.indexOf('vite.browser.config.js');
  const pack = prepareRelease.indexOf("'pack'");
  assert.ok(standaloneBuild >= 0 && standaloneBuild < pack, 'The standalone build must come before npm pack.');
  assert.match(prepareRelease, /sha512\(await readFile\(siteModulePath\)\) !== sha512\(standaloneBytes\)/);
});

test('the install guide shows a pinned jsdelivr snippet with a single module script', () => {
  assert.match(installGuide, /https:\/\/cdn\.jsdelivr\.net\/npm\/@codepawlhq\/67js@\d+\.\d+\.\d+\/build\/67\.standalone\.js/);
});
