import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import * as core from '../src/index.js';
import * as gltf from '../src/gltf.js';

// Checks docs/learn/if-you-know-three-js.md against the code: every 67js call and field the 67js column names must exist.
const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const guide = read('docs/learn/if-you-know-three-js.md');

const rows = guide.split('\n')
  .filter(line => line.startsWith('| ') && !line.startsWith('| ---') && !line.startsWith('| three.js'))
  .map(line => line.split(' | ').map(cell => cell.replace(/^\| |\ \|$/g, '')));

const calls = new Set([
  ...Object.keys(core),
  ...Object.keys(gltf),
  ...Object.getOwnPropertyNames(core.Renderer67.prototype),
  'createModel',
  // Browser calls the table uses.
  'toBlob', 'now', 'requestAnimationFrame', 'push',
]);

const fieldSources = {
  frame: ['docs/learn/cameras-and-framing.md', 'docs/learn/effects-and-lighting.md'],
  environment: ['docs/lighting.md', 'docs/learn/effects-and-lighting.md', 'docs/learn/local-lights-and-volume-fog.md', 'docs/learn/hdr-environment-lighting.md'],
  material: ['docs/learn/materials-and-color.md', 'docs/material-maps.md'],
  part: ['docs/learn/parts-and-geometry.md', 'docs/learn/local-lights-and-volume-fog.md'],
};

function backtickTokens(cell) {
  return [...cell.matchAll(/`([^`]+)`/g)].map(match => match[1]);
}

test('the guide has a row for each idiom in the issue', () => {
  const left = rows.map(row => row[0]).join('\n');
  for (const idiom of ['Scene', 'Group', 'Mesh', 'BoxGeometry', 'SphereGeometry', 'MeshStandardMaterial', 'MeshPhysicalMaterial', 'PerspectiveCamera',
    'OrthographicCamera', 'AmbientLight', 'DirectionalLight', 'PointLight', 'SpotLight', 'RectAreaLight', 'GLTFLoader', 'setAnimationLoop', 'OrbitControls', 'WebGLRenderTarget']) {
    assert.ok(left.includes(idiom), `no row for ${idiom}`);
  }
  assert.ok(rows.length >= 45);
});

test('every call the 67js column names is a real export or method', () => {
  let checked = 0;
  for (const [idiom, replacement] of rows) {
    for (const token of backtickTokens(replacement)) {
      for (const [, name] of token.matchAll(/([A-Za-z0-9_]+)\(/g)) {
        assert.ok(calls.has(name), `"${idiom}" names ${name}(), which 67js does not export`);
        checked += 1;
      }
    }
  }
  assert.ok(checked >= 25, `only ${checked} calls were checked`);
});

test('every field the 67js column names appears in the docs of its object', () => {
  let checked = 0;
  for (const [idiom, replacement] of rows) {
    for (const token of backtickTokens(replacement)) {
      for (const [, owner, field] of token.matchAll(/\b(frame|environment|material|part)\.(\w+)/g)) {
        const text = fieldSources[owner].map(read).join('\n');
        assert.ok(new RegExp(`\\b${field}\\b`).test(text), `"${idiom}" names ${owner}.${field}, which the ${owner} docs never mention`);
        checked += 1;
      }
    }
  }
  assert.ok(checked >= 25, `only ${checked} fields were checked`);
});

test('every 67js name in the guide that is an export exists in src/index.js or an addon', () => {
  for (const [, name] of guide.matchAll(/\b(Renderer67)\b/g)) assert.ok(name in core);
  for (const [, path] of guide.matchAll(/`(67js\/addons\/[\w-]+)`/g)) {
    const exportName = `./addons/${path.split('/').at(-1)}`;
    const packageExports = JSON.parse(read('package.json')).exports;
    assert.ok(exportName in packageExports, `${path} is not an export of the package`);
  }
});

test('the guide is in the navigation, llms.txt points to it and the addon folder exists', () => {
  assert.match(read('src/documentation-topics.js'), /'if-you-know-three-js'/);
  const llms = read('public/llms.txt');
  assert.match(llms, /## If you know three\.js/);
  assert.match(llms, /67js-three-compat/);
  assert.ok(existsSync(new URL('../packages/three-compat/index.mjs', import.meta.url)));
  assert.match(read('docs/learn/introduction.md'), /\(#if-you-know-three-js\)/);
  assert.doesNotMatch(read('docs/learn/introduction.md'), /does not run in 67js without changes/);
});
