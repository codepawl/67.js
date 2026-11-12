// Adversarial tests for data-only packs (#984): a seeded generator mutates the valid example pack and every case must be
// refused cleanly or accepted with its invariants intact. Deterministic: the same seed builds the same packs.
import './support/load-agent-scene-modules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createAgentMcpServer } from '../scripts/mcp-server.mjs';
import { createAgentRuntime } from '../scripts/agent-runtime.mjs';
import { createAgentAssetCatalog } from '../scripts/agent-asset-catalog.mjs';
import { createPackRegistry, loadPack, loadPacks } from '../scripts/agent-packs.mjs';
import {
  MAXIMUM_INSTALLED_PACKS, MAXIMUM_JSON_DEPTH, MAXIMUM_PACK_BYTES, MAXIMUM_PACK_FILES, MAXIMUM_PACK_FILE_BYTES, MAXIMUM_PACK_ITEMS_PER_KIND,
  MAXIMUM_PACK_JSON_BYTES, findRemoteUrl, isExecutableLookingName, semverSatisfies,
} from '../src/pack-manifest.js';
import packageMetadata from '../package.json' with { type: 'json' };

const packageVersion = packageMetadata.version;
const EXAMPLE = new URL('../packs/example-starter', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const SEED = 984;
const MAXIMUM_CASE_MILLISECONDS = 3000;
// Messages that show our own code failed on a value instead of checking it.
const INTERNAL_FAILURE = /Cannot read prop|Cannot convert undefined|is not a function|is not iterable|Cannot destructure|Maximum call stack|is not defined|of undefined|of null/;

function createRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function readExamplePack() {
  const files = new Map();
  const visit = (relative) => {
    for (const entry of readdirSync(join(EXAMPLE, relative), { withFileTypes: true })) {
      const entryPath = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) visit(entryPath);
      else files.set(entryPath, readFileSync(join(EXAMPLE, entryPath)));
    }
  };
  visit('');
  const manifest = JSON.parse(files.get('67js-pack.json').toString('utf8'));
  files.delete('67js-pack.json');
  return { manifest, files };
}

const example = readExamplePack();

function writeFileAt(folder, relativePath, content) {
  const target = join(folder, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

/**
 * A case builds one pack folder from the example. `change(manifest, files)` edits the manifest object and the file map
 * (path -> Buffer|string, null removes), `manifestText` replaces the manifest text, `after(folder)` does anything else on disk.
 * `expect` is 'refuse', 'accept' or 'either' (then only the invariants are checked).
 */
function makeCase(label, expect, { change, manifestText, after } = {}) {
  return { label, expect, change, manifestText, after };
}

function buildCase(folder, id, testCase) {
  const manifest = structuredClone(example.manifest);
  manifest.name = `fz-${id}`;
  const files = new Map(example.files);
  testCase.change?.(manifest, files);
  mkdirSync(folder, { recursive: true });
  for (const [path, content] of files) {
    if (content !== null) writeFileAt(folder, path, content);
  }
  writeFileSync(join(folder, '67js-pack.json'), testCase.manifestText ?? JSON.stringify(manifest));
  testCase.after?.(folder);
}

function temporaryFolder(context) {
  const folder = mkdtempSync(join(tmpdir(), '67js-pack-fuzz-'));
  context.after(() => rmSync(folder, { recursive: true, force: true }));
  return folder;
}

async function withinTime(operation, label) {
  const started = performance.now();
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`hang: ${label} took over ${MAXIMUM_CASE_MILLISECONDS * 3} ms`)), MAXIMUM_CASE_MILLISECONDS * 3); });
  try {
    return { value: await Promise.race([operation(), timeout]), elapsed: performance.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Invariants of an accepted pack: listed files exist, ids bind the bytes, JSON items read back through the registry. */
async function checkAcceptedPack(folder, pack, problems) {
  for (const [kind, items] of Object.entries(pack.items)) {
    for (const item of items) {
      if (item.assetId === undefined) continue;
      const file = pack.files.find(candidate => candidate.assetId === item.assetId);
      if (!file) { problems.push(`${kind}/${item.id}: assetId not in pack.files`); continue; }
      if (!existsSync(join(folder, file.filename))) problems.push(`${file.filename}: listed but missing`);
      else if (sha256(readFileSync(join(folder, file.filename))) !== item.assetId && !file.filename.endsWith('.glb')) problems.push(`${file.filename}: assetId does not match the bytes`);
    }
  }
}

/**
 * Runs the cases in chunks (each chunk is one --packs folder), then loads each chunk as a registry: a refused pack must be
 * listed under rejected and contribute no file, an accepted one must be installed and readable.
 */
async function runCases(context, cases, { chunkSize = 20 } = {}) {
  const root = temporaryFolder(context);
  const problems = [];
  const outcomes = [];
  for (const [index, testCase] of cases.entries()) {
    const chunk = Math.floor(index / chunkSize);
    const folderName = `c${index}`;
    const folder = join(root, `chunk-${chunk}`, folderName);
    try {
      buildCase(folder, index, testCase);
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENAMETOOLONG', 'EINVAL', 'ENOENT'].includes(error.code)) { outcomes.push(null); continue; }
      throw error;
    }
    let outcome;
    try {
      const { value, elapsed } = await withinTime(() => loadPack(folder, { packageVersion }), testCase.label);
      if (elapsed > MAXIMUM_CASE_MILLISECONDS) problems.push(`${testCase.label}: slow, ${Math.round(elapsed)} ms`);
      outcome = { accepted: true, pack: value };
      await checkAcceptedPack(folder, value, problems);
    } catch (error) {
      outcome = { accepted: false, error };
      if (!(error instanceof Error)) problems.push(`${testCase.label}: threw a non-Error`);
      else if (INTERNAL_FAILURE.test(error.message)) problems.push(`${testCase.label}: internal failure: ${error.message.slice(0, 160)}`);
      else if (!error.message.includes(`pack "${folderName}"`)) problems.push(`${testCase.label}: error does not name the pack: ${error.message.slice(0, 160)}`);
      else if (!/expected|Flatten|Remove|Rename|pass|split|copy|Restart/.test(error.message)) problems.push(`${testCase.label}: error does not say what to pass: ${error.message.slice(0, 160)}`);
    }
    if (testCase.expect === 'refuse' && outcome.accepted) problems.push(`${testCase.label}: accepted, must be refused`);
    if (testCase.expect === 'accept' && !outcome.accepted) problems.push(`${testCase.label}: refused, must be accepted: ${outcome.error.message.slice(0, 200)}`);
    outcomes.push(outcome);
  }
  for (let chunk = 0; chunk * chunkSize < cases.length; chunk++) {
    const chunkRoot = join(root, `chunk-${chunk}`);
    if (!existsSync(chunkRoot)) continue;
    const indexes = outcomes.map((_, index) => index).filter(index => Math.floor(index / chunkSize) === chunk && outcomes[index] !== null);
    const { packs, rejected } = await loadPacks(chunkRoot, { packageVersion });
    const expectedAccepted = indexes.filter(index => outcomes[index].accepted).map(index => `c${index}`).sort();
    const expectedRejected = indexes.filter(index => !outcomes[index].accepted).map(index => `c${index}`).sort();
    assert.deepEqual(packs.map(pack => pack.folder).sort(), expectedAccepted, `chunk ${chunk}: installed packs`);
    assert.deepEqual(rejected.map(entry => entry.folder).sort(), expectedRejected, `chunk ${chunk}: rejected packs`);
    const registry = await createPackRegistry(chunkRoot, { packageVersion });
    const refusedFolders = new Set(expectedRejected.map(name => join(chunkRoot, name)));
    for (const file of registry.files) {
      if ([...refusedFolders].some(folder => file.directory.startsWith(`${folder}${sep}`) || file.directory === folder)) problems.push(`chunk ${chunk}: refused pack leaked ${file.filename} into the registry`);
    }
    const catalog = await createAgentAssetCatalog(null, registry.files);
    for (const file of registry.files) {
      const bytes = await catalog.read(file.assetId);
      if (bytes.length === 0) problems.push(`${file.filename}: empty read`);
    }
    for (const listed of registry.list().packs) {
      for (const kind of ['materials', 'recipes']) {
        for (const item of listed.items[kind]) {
          const source = packs.find(pack => pack.name === listed.name).json[kind].get(item.id);
          assert.deepEqual(registry.read(kind, listed.name, item.id), source);
        }
      }
    }
  }
  assert.equal(({}).polluted, undefined, 'Object.prototype was polluted');
  assert.deepEqual(problems, []);
  return outcomes;
}

function setMaterialJson(files, content) {
  files.set('materials/rusty-metal.json', typeof content === 'string' ? content : JSON.stringify(content));
}

function nestedObjects(levels, leaf) {
  return '{"a":'.repeat(levels) + leaf + '}'.repeat(levels);
}

function nestedArrays(levels, leaf) {
  return '['.repeat(levels) + leaf + ']'.repeat(levels);
}

// ---- 1. paths --------------------------------------------------------------------------------------------------------

const BAD_PATHS = [
  '../outside.json', '../../x.json', '/etc/passwd', '/materials/rusty-metal.json', 'C:/x.json', 'C:x.json', 'c:\\x.json',
  'materials\\rusty-metal.json', '%2e%2e/outside.json', 'materials/%2e%2e/x.json', 'materials/..%2frusty-metal.json',
  'materials/rusty-metal.json\u0000.png', 'materials/rusty\u0000.json', '\uFF0E\uFF0E/x.json', '\u2024\u2024/x.json', 'materials/\u0430dmin.json',
  './materials/rusty-metal.json', 'materials//rusty-metal.json', 'materials/./rusty-metal.json', 'materials/rusty-metal.json/', '', '.json',
  ' materials/rusty-metal.json', 'materials/rusty-metal.json ', `${'x'.repeat(201)}.json`, '~/x.json', '\\\\host\\share\\x.json',
  '//host/x.json', 'file:///x.json', 'https://example.test/x.json', 'materials/rusty-metal.json?x=1', 'materials/rusty-metal.json#a',
  'materials/rusty metal.json', 'materials/rusty-metal.JSON', 'materials/../materials/rusty-metal.json', 'a/../../b.json', '..', '.', '/',
  null, 5, true, {}, [], ['materials/rusty-metal.json'], { toString: 'x' },
];

const PATH_TARGETS = [
  ['materials file', manifest => manifest.contents.materials[0], 'file'],
  ['recipe file', manifest => manifest.contents.recipes[0], 'file'],
  ['recipe preview', manifest => manifest.contents.recipes[0], 'preview'],
  ['look file', manifest => manifest.contents.looks[0], 'file'],
];

test('paths that leave the pack or are not plain relative paths are never accepted', async context => {
  const cases = [];
  for (const [targetLabel, pick, key] of PATH_TARGETS) {
    for (const badPath of BAD_PATHS) {
      cases.push(makeCase(`${targetLabel} = ${JSON.stringify(badPath)?.slice(0, 40)}`, 'refuse', {
        change: manifest => { pick(manifest)[key] = badPath; },
        after: folder => writeFileSync(join(dirname(folder), 'outside.json'), JSON.stringify({ roughness: 0.5 })),
      }));
    }
  }
  const outcomes = await runCases(context, cases);
  assert.ok(outcomes.filter(Boolean).length >= 150);
});

// ---- 2. files that must not be in a pack ----------------------------------------------------------------------------------

const CODE_NAMES = [
  'x.js', 'X.JS', 'x.Js', 'x.png.js', 'x.png.JS', 'x.mjs', 'x.cjs', 'x.jsx', 'x.ts', 'x.html', 'x.HTM', 'x.xhtml', 'x.svg', 'x.wasm',
  'x.exe', 'x.dll', 'x.msi', 'x.sh', 'x.bash', 'x.bat', 'x.cmd', 'x.ps1', 'x.vbs', 'x.py', 'x.php', 'x.jar', 'x.so', 'x.lnk', '.hidden.js',
  'x.tar.gz.js', 'x.json.js', 'x.glb.html',
];
const PLACEMENTS = ['', 'extras/', 'a/b/c/', 'materials/', 'a/b/c/d/e/f/g/h/'];

test('a code or program file anywhere in the pack refuses the whole pack', async context => {
  const cases = [];
  for (const name of CODE_NAMES) {
    for (const placement of PLACEMENTS) {
      cases.push(makeCase(`${placement}${name}`, 'refuse', { change: (_, files) => files.set(`${placement}${name}`, 'x=1') }));
    }
  }
  const outcomes = await runCases(context, cases);
  assert.ok(outcomes.filter(Boolean).length >= 150);
});

test('names with trailing dots or spaces count as the extension Windows reads them as', () => {
  for (const name of ['evil.js.', 'evil.js ', 'evil.js. .', 'evil.PS1 ', 'a.b/evil.sh.']) {
    assert.equal(isExecutableLookingName(name), true, name);
  }
  for (const name of ['crate.glb', 'LICENSE', 'notes.txt', 'js', 'a.jsx.png']) {
    assert.equal(isExecutableLookingName(name), false, name);
  }
});

test('links in a pack, listed or not, are never followed or accepted', async context => {
  const parent = temporaryFolder(context);
  const outside = join(parent, 'outside.json');
  writeFileSync(outside, JSON.stringify({ roughness: 0.5 }));
  const attempts = [
    ['file link inside the pack, unlisted', (folder) => symlinkSync(join(folder, 'materials/rusty-metal.json'), join(folder, 'materials/link.json'), 'file')],
    ['file link to a file outside', (folder) => symlinkSync(outside, join(folder, 'materials/link.json'), 'file')],
    ['listed file replaced by a link', (folder) => { rmSync(join(folder, 'materials/rusty-metal.json')); symlinkSync(outside, join(folder, 'materials/rusty-metal.json'), 'file'); }],
    ['folder link (junction) to outside', (folder) => symlinkSync(parent, join(folder, 'linked'), 'junction')],
    ['folder link to the pack itself', (folder) => symlinkSync(folder, join(folder, 'self'), 'junction')],
    ['listed folder replaced by a junction', (folder) => { rmSync(join(folder, 'materials'), { recursive: true }); symlinkSync(parent, join(folder, 'materials'), 'junction'); }],
  ];
  let created = 0;
  for (const [label, attempt] of attempts) {
    const folder = join(parent, `link-pack-${created}`);
    buildCase(folder, `link${created}`, makeCase(label, 'refuse'));
    try {
      attempt(folder);
    } catch (error) {
      if (['EPERM', 'EACCES', 'UNKNOWN', 'ENOSYS'].includes(error.code)) continue;
      throw error;
    }
    created += 1;
    await assert.rejects(() => loadPack(folder, { packageVersion }), error => error instanceof Error && error.message.includes(`pack "link-pack-${created - 1}"`) && !INTERNAL_FAILURE.test(error.message), label);
  }
  const linkedRoot = join(parent, 'linked-root');
  mkdirSync(linkedRoot);
  buildCase(join(parent, 'real-pack'), 'real', makeCase('real', 'accept'));
  try {
    symlinkSync(join(parent, 'real-pack'), join(linkedRoot, 'link-to-real'), 'junction');
  } catch {
    context.diagnostic('cannot create links here: link cases skipped');
    return;
  }
  const { packs, rejected } = await loadPacks(linkedRoot, { packageVersion });
  assert.deepEqual(packs, []);
  assert.equal(rejected.length, 1);
});

// ---- 3. remote URLs and JSON shape ------------------------------------------------------------------------------------

const REMOTE_STRINGS = [
  'https://example.test/x', 'HTTPS://example.test/x', 'Https://example.test/x', ' https://example.test/x', '\thttps://example.test/x',
  '\nhttps://example.test/x', 'http://example.test/x', 'ftp://example.test/x', 'wss://example.test/x', 'ws://example.test/x',
  '//example.test/x', '  //example.test/x', '\t//example.test/x', 'file:///etc/passwd', 'FILE:///etc/passwd', 'blob:https://example.test/id',
  'javascript:alert(1)', ' JavaScript:alert(1)', 'data:text/html;base64,PHNjcmlwdD4=', 'data:application/javascript,1', 'DATA:image/svg+xml,<svg/>',
  ' data:text/plain,hi', 'data:,x', 'url(https://example.test/x)', 'see "http://example.test/x" here', 'a=https://example.test/x', 'x (https://example.test/x)',
  'prefix-https://example.test/x',
];

function placeRemote(shape, value) {
  switch (shape) {
    case 'value': return { color: [1, 1, 1], note: value };
    case 'array': return { color: [1, 1, 1], list: [1, [2, value]] };
    case 'key': return { color: [1, 1, 1], [value]: 1 };
    case 'nested key': return { color: [1, 1, 1], a: { b: { [value]: [1] } } };
    case 'deep value': return JSON.parse(nestedObjects(30, JSON.stringify(value)));
    default: throw new Error(shape);
  }
}

test('remote URLs hidden anywhere in a material or recipe are never accepted', async context => {
  const cases = [];
  for (const value of REMOTE_STRINGS) {
    for (const shape of ['value', 'array', 'key', 'nested key', 'deep value']) {
      cases.push(makeCase(`material ${shape} ${JSON.stringify(value).slice(0, 36)}`, 'refuse', { change: (_, files) => setMaterialJson(files, placeRemote(shape, value)) }));
    }
    cases.push(makeCase(`recipe ${JSON.stringify(value).slice(0, 36)}`, 'refuse', {
      change: (_, files) => {
        const recipe = JSON.parse(files.get('recipes/crates.json').toString('utf8'));
        recipe.nodes[0].extra = { deeper: [{ value }] };
        files.set('recipes/crates.json', JSON.stringify(recipe));
      },
    }));
  }
  await runCases(context, cases);
});

test('harmless strings that mention URLs or small images are accepted', async context => {
  const cases = ['data:image/png;base64,AAAA', 'DATA:image/jpeg;base64,AAAA', 'data:image/webp;base64,AAAA', 'a-plain-name', 'example.test', 'httpsx', '#https', '/materials/x', 'C:'].map(value => makeCase(`material ${JSON.stringify(value)}`, 'accept', {
    change: (_, files) => setMaterialJson(files, { color: [1, 1, 1], note: value }),
  }));
  await runCases(context, cases);
});

test('findRemoteUrl refuses deep arrays and objects without overflowing the stack', () => {
  for (const levels of [MAXIMUM_JSON_DEPTH + 1, 1000, 20000, 200000]) {
    const arrays = JSON.parse(nestedArrays(levels, '"fine"'));
    const objects = JSON.parse(nestedObjects(levels, '"fine"'));
    for (const value of [arrays, objects]) {
      const found = findRemoteUrl(value);
      assert.ok(found && found.tooDeep === true, `${levels} levels`);
    }
  }
  assert.equal(findRemoteUrl(JSON.parse(nestedArrays(MAXIMUM_JSON_DEPTH, '"fine"'))), null);
  assert.equal(findRemoteUrl(JSON.parse(nestedObjects(MAXIMUM_JSON_DEPTH, '"fine"'))), null);
  const dotted = { [`${'k.'.repeat(100)}k`]: { inner: { value: 1 } } };
  assert.equal(findRemoteUrl(dotted), null, 'dots inside keys do not count as depth');
});

test('JSON at and over its depth and size limits', async context => {
  const padTo = (text, bytes) => text + ' '.repeat(bytes - Buffer.byteLength(text));
  const cases = [
    makeCase('depth: objects at the limit', 'accept', { change: (_, files) => setMaterialJson(files, nestedObjects(MAXIMUM_JSON_DEPTH, '1')) }),
    makeCase('depth: arrays at the limit', 'accept', { change: (_, files) => setMaterialJson(files, `{"a":${nestedArrays(MAXIMUM_JSON_DEPTH - 1, '1')}}`) }),
    makeCase('depth: objects over the limit', 'refuse', { change: (_, files) => setMaterialJson(files, nestedObjects(MAXIMUM_JSON_DEPTH + 1, '1')) }),
    makeCase('depth: arrays over the limit', 'refuse', { change: (_, files) => setMaterialJson(files, `{"a":${nestedArrays(MAXIMUM_JSON_DEPTH, '1')}}`) }),
    makeCase('depth: 1000 arrays', 'refuse', { change: (_, files) => setMaterialJson(files, `{"a":${nestedArrays(1000, '1')}}`) }),
    makeCase('depth: 100000 arrays', 'refuse', { change: (_, files) => setMaterialJson(files, `{"a":${nestedArrays(100000, '1')}}`) }),
    makeCase('depth: 400000 arrays (near 1 MiB)', 'refuse', { change: (_, files) => setMaterialJson(files, `{"a":${nestedArrays(400000, '1')}}`) }),
    makeCase('depth: 100000 objects', 'refuse', { change: (_, files) => setMaterialJson(files, nestedObjects(100000, '1')) }),
    makeCase('depth: recipe 100000 arrays', 'refuse', { change: (_, files) => files.set('recipes/crates.json', `{"format":"67js.scene","a":${nestedArrays(100000, '1')}}`) }),
    makeCase('depth: keys with dots under the limit', 'accept', { change: (_, files) => setMaterialJson(files, { [`${'k.'.repeat(100)}k`]: { inner: { value: 1 } } }) }),
    makeCase('size: JSON of exactly 1 MiB', 'accept', { change: (_, files) => setMaterialJson(files, padTo('{"roughness":0.5}', MAXIMUM_PACK_JSON_BYTES)) }),
    makeCase('size: JSON of 1 MiB + 1', 'refuse', { change: (_, files) => setMaterialJson(files, padTo('{"roughness":0.5}', MAXIMUM_PACK_JSON_BYTES + 1)) }),
    makeCase('size: JSON of 1 MiB plus a BOM (the file is over 1 MiB)', 'refuse', { change: (_, files) => setMaterialJson(files, `\uFEFF${padTo('{"roughness":0.5}', MAXIMUM_PACK_JSON_BYTES)}`) }),
    makeCase('size: manifest over 1 MiB', 'refuse', { manifestText: padTo('{}', MAXIMUM_PACK_JSON_BYTES + 1) }),
    makeCase('shape: 100000 numbers', 'accept', { change: (_, files) => setMaterialJson(files, { values: Array.from({ length: 100000 }, (_, index) => index % 7) }) }),
    makeCase('shape: 100000 short strings', 'accept', { change: (_, files) => setMaterialJson(files, { values: Array.from({ length: 100000 }, () => 'ab') }) }),
    makeCase('regex: 400000 quotes in one string', 'accept', { change: (_, files) => setMaterialJson(files, { note: '"'.repeat(400000) }) }),
    makeCase('regex: 900000 spaces then a url', 'refuse', { change: (_, files) => setMaterialJson(files, { note: `${' '.repeat(900000)}https://example.test` }) }),
    makeCase('regex: 300000 slashes', 'accept', { change: (_, files) => setMaterialJson(files, { note: '/'.repeat(300000) }) }),
    makeCase('regex: 300000 "(http" repeats', 'accept', { change: (_, files) => setMaterialJson(files, { note: '(http'.repeat(180000) }) }),
    makeCase('material is an array', 'refuse', { change: (_, files) => setMaterialJson(files, []) }),
    makeCase('material is null', 'refuse', { change: (_, files) => setMaterialJson(files, 'null') }),
    makeCase('material is a string', 'refuse', { change: (_, files) => setMaterialJson(files, '"x"') }),
    makeCase('material is empty', 'refuse', { change: (_, files) => setMaterialJson(files, '') }),
    makeCase('material is a BOM only', 'refuse', { change: (_, files) => setMaterialJson(files, '\uFEFF') }),
    makeCase('material is truncated', 'refuse', { change: (_, files) => setMaterialJson(files, '{"a":[1,2') }),
    makeCase('material has binary bytes', 'refuse', { change: (_, files) => files.set('materials/rusty-metal.json', Buffer.from([0xff, 0xfe, 0x00, 0x7b])) }),
    makeCase('recipe without format', 'refuse', { change: (_, files) => files.set('recipes/crates.json', '{"nodes":[]}') }),
    makeCase('recipe with the wrong format', 'refuse', { change: (_, files) => files.set('recipes/crates.json', '{"format":"other"}') }),
    makeCase('recipe format is an object', 'refuse', { change: (_, files) => files.set('recipes/crates.json', '{"format":{"toString":1}}') }),
    makeCase('prototype keys in a material are inert', 'either', { change: (_, files) => setMaterialJson(files, '{"__proto__":{"polluted":1},"constructor":{"prototype":{"polluted":2}},"prototype":{"polluted":3}}') }),
    makeCase('prototype keys in a recipe are inert', 'either', { change: (_, files) => files.set('recipes/crates.json', '{"format":"67js.scene","__proto__":{"polluted":1},"constructor":{"prototype":{"polluted":2}}}') }),
  ];
  await runCases(context, cases);
});

// ---- 4. manifest -----------------------------------------------------------------------------------------------------------

function setPrototypeKey(object, key, value) {
  Object.defineProperty(object, key, { value, enumerable: true, configurable: true, writable: true });
}

function manifestCases() {
  const cases = [];
  const refuse = (label, change) => cases.push(makeCase(label, 'refuse', { change }));
  const accept = (label, change) => cases.push(makeCase(label, 'accept', { change }));
  for (const key of ['__proto__', 'constructor', 'prototype', 'toString', 'hasOwnProperty']) {
    refuse(`manifest key ${key}`, manifest => setPrototypeKey(manifest, key, { polluted: 1 }));
    refuse(`engines key ${key}`, manifest => setPrototypeKey(manifest.engines, key, 'x'));
    refuse(`contents key ${key}`, manifest => setPrototypeKey(manifest.contents, key, []));
    refuse(`material item key ${key}`, manifest => setPrototypeKey(manifest.contents.materials[0], key, 'x'));
    refuse(`recipe item key ${key}`, manifest => setPrototypeKey(manifest.contents.recipes[0], key, 'x'));
  }
  refuse('contents.materials is the prototype', manifest => { manifest.contents.materials = { length: 1, 0: manifest.contents.materials[0] }; });
  refuse('manifest name __proto__', manifest => { manifest.name = '__proto__'; });
  refuse('item id __proto__', manifest => { manifest.contents.materials[0].id = '__proto__'; });
  for (const id of ['constructor', 'tostring', 'valueof', 'hasownproperty', 'prototype', 'a'.repeat(64), '0', 'a-b-c']) accept(`item id ${id.slice(0, 20)}`, manifest => { manifest.contents.materials[0].id = id; });
  for (const name of ['constructor', 'tostring', 'a'.repeat(64), '9']) accept(`pack name ${name.slice(0, 20)}`, manifest => { manifest.name = name; });
  for (const id of ['Rusty-Metal', 'RUSTY', 'rusty_metal', 'rusty metal', 'rusty-metal ', ' rusty-metal', 'rusty--metal', '-rusty', 'rusty-', '', 'a'.repeat(65), 'rüsty', 'rusty\u0000', 'rusty\n', 'ｒusty', 'ı', null, 5, {}, [], ['rusty-metal']]) {
    refuse(`item id ${JSON.stringify(id)?.slice(0, 20)}`, manifest => { manifest.contents.materials[0].id = id; });
    refuse(`pack name ${JSON.stringify(id)?.slice(0, 20)}`, manifest => { manifest.name = id; });
  }
  refuse('duplicate ids', manifest => { manifest.contents.materials[1].id = manifest.contents.materials[0].id; });
  refuse('ids differing only by case', manifest => { manifest.contents.materials[1].id = 'Rusty-Metal'; });
  accept('same id in two kinds', manifest => { manifest.contents.recipes[0].id = 'rusty-metal'; });
  refuse('duplicate id among 64', manifest => { manifest.contents.materials = Array.from({ length: 64 }, (_, index) => ({ id: index === 63 ? 'm-0' : `m-${index}`, file: 'materials/rusty-metal.json' })); });
  accept('64 materials', manifest => { manifest.contents.materials = Array.from({ length: MAXIMUM_PACK_ITEMS_PER_KIND }, (_, index) => ({ id: `m-${index}`, file: index === 63 ? 'materials/warm-plaster.json' : 'materials/rusty-metal.json' })); });
  refuse('65 materials', manifest => { manifest.contents.materials = Array.from({ length: MAXIMUM_PACK_ITEMS_PER_KIND + 1 }, (_, index) => ({ id: `m-${index}`, file: 'materials/rusty-metal.json' })); });
  accept('64 recipes with previews', manifest => { manifest.contents.recipes = Array.from({ length: MAXIMUM_PACK_ITEMS_PER_KIND }, (_, index) => ({ id: `r-${index}`, file: 'recipes/crates.json', preview: 'previews/crates.png' })); });
  refuse('65 recipes', manifest => { manifest.contents.recipes = Array.from({ length: MAXIMUM_PACK_ITEMS_PER_KIND + 1 }, (_, index) => ({ id: `r-${index}`, file: 'recipes/crates.json' })); });
  refuse('items is a huge sparse array', manifest => { manifest.contents.looks = { length: 4294967295 }; });
  const engines = [
    ['', false], [' ', false], ['>=', false], ['>= 0.19.0', false], ['>=0.19.0.1', false], ['>=0.19.0||>=1', false], ['>=0.19.0 || >=1', false], ['^', false],
    ['latest', false], ['*', false], ['x', false], ['1.x', false], ['v0.19.0', false], ['>=0.19.0-beta', false], ['>=-1', false], ['>=\u0660', false],
    ['>=0.19.0,<1', false], ['>=99.0.0', false], ['<0.0.1', false], ['>0.19.0', false], ['='.repeat(64), false], ['9'.repeat(65), false], ['9'.repeat(10000), false],
    ['>=1 '.repeat(9), false], ['>=0 '.repeat(100), false], [' '.repeat(65) + '>=0', false], ['\u0000', false], ['>=0.19.0\u0000', false],
    [null, false], [5, false], [true, false], [[], false], [['>=0'], false], [{}, false], [{ toString: '>=0' }, false],
    ['>=0.19.0', true], ['>=0', true], ['^0.19', true], ['~0.19.0', true], ['>=0.0.0 <99', true], ['0.19', true], ['=0.19.0', true], ['  >=0.19.0  ', true], ['>=0.19.0\n<1', true],
    ['>=0 '.repeat(8).trim(), true], [`${'>=0.0.0 '.repeat(7)}>=0.19.0`, true], ['>=0 <99999999999999999999999999999', true], ['<=99999999999999999999999999999', true],
  ];
  for (const [range, accepted] of engines) {
    (accepted ? accept : refuse)(`engines ${JSON.stringify(range)?.slice(0, 30)}`, manifest => { manifest.engines['67js'] = range; });
  }
  for (const value of [undefined, null, 5, 'x', [], [{ '67js': '>=0' }], { '67js': '>=0', other: 1 }, {}]) {
    refuse(`engines value ${JSON.stringify(value)}`, manifest => { if (value === undefined) delete manifest.engines; else manifest.engines = value; });
  }
  const scalars = {
    format: ['67js.pack ', '67JS.PACK', null, 1, [], ''], schemaVersion: ['1', 2, 0, 1.5, null, [1], true, -1, 1e21],
    version: ['1.0', '1.0.0.0', 'v1.0.0', '1.0.0-beta', '1.0.0\n', '1.0.x', '', null, 5, ['1.0.0'], '-1.0.0', '1.0.0 '],
    license: ['', '   ', 'x'.repeat(65), null, 5, [], {}], author: ['', ' ', 'x'.repeat(121), null, 5, {}],
    description: ['', '  ', 'x'.repeat(201), null, 5, ['x']],
  };
  for (const [field, values] of Object.entries(scalars)) {
    for (const value of values) refuse(`${field} ${JSON.stringify(value)?.slice(0, 20)}`, manifest => { manifest[field] = value; });
    refuse(`${field} missing`, manifest => { delete manifest[field]; });
  }
  accept('license 64 characters', manifest => { manifest.license = 'x'.repeat(64); });
  accept('author 120 characters', manifest => { manifest.author = 'x'.repeat(120); });
  accept('description 200 characters', manifest => { manifest.description = 'x'.repeat(200); });
  accept('version 99999.99999.99999', manifest => { manifest.version = '99999.99999.99999'; });
  refuse('contents missing', manifest => { delete manifest.contents; });
  for (const value of [null, [], 'x', 5, true]) refuse(`contents ${JSON.stringify(value)}`, manifest => { manifest.contents = value; });
  refuse('contents empty leaves every file unlisted', manifest => { manifest.contents = {}; });
  for (const value of [null, 'x', 5, {}, true]) refuse(`materials list ${JSON.stringify(value)}`, manifest => { manifest.contents.materials = value; });
  for (const value of [null, 'x', 5, [], [[]], true]) refuse(`first material ${JSON.stringify(value)}`, manifest => { manifest.contents.materials = [value]; });
  refuse('extra top-level key', manifest => { manifest.scripts = { postinstall: 'x' }; });
  refuse('extra item key', manifest => { manifest.contents.materials[0].url = 'https://example.test/x'; });
  refuse('preview on a material', manifest => { manifest.contents.materials[0].preview = 'previews/crates.png'; });
  refuse('preview that is not an image', manifest => { manifest.contents.recipes[0].preview = 'recipes/crates.json'; });
  refuse('manifest listed as a recipe', manifest => { manifest.contents.recipes[0].file = '67js-pack.json'; });
  refuse('png listed as a look', manifest => { manifest.contents.looks[0].file = 'previews/crates.png'; });
  refuse('cube listed as an image', manifest => { manifest.contents.images = [{ id: 'x', file: 'looks/warm.cube' }]; });
  refuse('json listed as a glb', manifest => { manifest.contents.assets = [{ id: 'x', file: 'materials/rusty-metal.json' }]; });
  refuse('json renamed to a glb', manifest => { manifest.contents.assets = [{ id: 'x', file: 'models/x.glb' }]; });
  return cases;
}

test('manifest fields, ids, item counts and engines ranges', async context => {
  const cases = manifestCases();
  cases.push(
    makeCase('manifest is an array', 'refuse', { manifestText: '[]' }),
    makeCase('manifest is null', 'refuse', { manifestText: 'null' }),
    makeCase('manifest is empty', 'refuse', { manifestText: '' }),
    makeCase('manifest is truncated', 'refuse', { manifestText: '{"format":"67js.pack"' }),
    makeCase('manifest is binary', 'refuse', { manifestText: '\u0000\u0001\u0002' }),
    makeCase('manifest has a __proto__ key in JSON text', 'refuse', { manifestText: '{"__proto__":{"polluted":1}}' }),
    makeCase('manifest lists a nested prototype chain', 'refuse', { manifestText: `{"contents":${nestedObjects(50000, '1')}}` }),
    makeCase('manifest is 400000 nested arrays', 'refuse', { manifestText: nestedArrays(400000, '1') }),
    makeCase('manifest is missing', 'refuse', { after: folder => rmSync(join(folder, '67js-pack.json')) }),
    makeCase('manifest is a folder', 'refuse', { after: folder => { rmSync(join(folder, '67js-pack.json')); mkdirSync(join(folder, '67js-pack.json')); } }),
    makeCase('manifest name in a different case', 'refuse', { after: folder => { rmSync(join(folder, '67js-pack.json')); writeFileSync(join(folder, '67JS-PACK.JSON'), '{}'); } }),
  );
  await runCases(context, cases);
});

test('engines ranges stay bounded in time and give a null for anything unreadable', () => {
  const started = performance.now();
  const adversarial = ['>=0 '.repeat(10000), '9'.repeat(100000), `>=${'0.'.repeat(30000)}0`, ' '.repeat(100000), `${'^'.repeat(60)}0`, '>=1'.repeat(30000)];
  for (const range of adversarial) assert.equal(semverSatisfies('0.19.0', range), null);
  for (const range of [undefined, null, 5, {}, [], Symbol.iterator, () => 0]) assert.equal(semverSatisfies('0.19.0', range), null);
  for (const version of [undefined, null, '', '1', '1.2', '1.2.3.4', 'x', 5, {}]) assert.equal(semverSatisfies(version, '>=0'), null);
  assert.ok(performance.now() - started < 500);
});

// ---- 5. exact limits -------------------------------------------------------------------------------------------------------

function fillerFiles(files, count, prefix = 'filler') {
  for (let index = 0; index < count; index++) files.set(`${prefix}/f${index}/LICENSE`, 'x');
}

test('file count, folder depth, path length and per-file size at and over their limits', async context => {
  const baseCount = example.files.size + 1;
  const longFile = (length) => `${'a'.repeat(length - '.json'.length)}.json`;
  const cases = [
    makeCase('256 files', 'accept', { change: (_, files) => fillerFiles(files, MAXIMUM_PACK_FILES - baseCount) }),
    makeCase('257 files', 'refuse', { change: (_, files) => fillerFiles(files, MAXIMUM_PACK_FILES - baseCount + 1) }),
    makeCase('1000 files', 'refuse', { change: (_, files) => fillerFiles(files, 1000) }),
    makeCase('folders nested 8 deep', 'accept', { change: (_, files) => files.set('a/b/c/d/e/f/g/h/LICENSE', 'x') }),
    makeCase('folders nested 9 deep', 'refuse', { change: (_, files) => files.set('a/b/c/d/e/f/g/h/i/LICENSE', 'x') }),
    makeCase('folders nested 40 deep', 'refuse', { change: (_, files) => files.set(`${'d/'.repeat(40)}LICENSE`, 'x') }),
    makeCase('empty folders nested 9 deep', 'refuse', { after: folder => mkdirSync(join(folder, 'a/b/c/d/e/f/g/h/i'), { recursive: true }) }),
    makeCase('listed path of 200 characters', 'accept', {
      change: (manifest, files) => { manifest.contents.materials[0].file = longFile(200); files.set(longFile(200), files.get('materials/rusty-metal.json')); files.delete('materials/rusty-metal.json'); },
    }),
    makeCase('listed path of 201 characters', 'refuse', {
      change: (manifest, files) => { manifest.contents.materials[0].file = longFile(201); files.set(longFile(201), files.get('materials/rusty-metal.json')); },
    }),
    makeCase('file of 64 MiB + 1, unlisted', 'refuse', { after: folder => { writeFileSync(join(folder, 'data.bin'), ''); truncateSync(join(folder, 'data.bin'), MAXIMUM_PACK_FILE_BYTES + 1); } }),
    makeCase('a listed GLB of 64 MiB + 1', 'refuse', {
      change: manifest => { manifest.contents.assets = [{ id: 'big', file: 'big.glb' }]; },
      after: folder => { writeFileSync(join(folder, 'big.glb'), ''); truncateSync(join(folder, 'big.glb'), MAXIMUM_PACK_FILE_BYTES + 1); },
    }),
    makeCase('a listed GLB that is empty', 'refuse', { change: manifest => { manifest.contents.assets = [{ id: 'big', file: 'big.glb' }]; }, after: folder => writeFileSync(join(folder, 'big.glb'), '') }),
    makeCase('a listed GLB that is JSON text', 'refuse', { change: manifest => { manifest.contents.assets = [{ id: 'big', file: 'big.glb' }]; }, after: folder => writeFileSync(join(folder, 'big.glb'), '{"asset":{"version":"2.0"},"padding":"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"}') }),
    makeCase('a listed PNG that is a script', 'refuse', { after: folder => writeFileSync(join(folder, 'previews/crates.png'), 'alert(1);alert(1);alert(1);alert(1);') }),
  ];
  await runCases(context, cases);
});

test('the pack total is refused one byte over 256 MiB', async context => {
  const totalOf = (folder) => {
    let total = 0;
    const visit = (directory) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entry.isDirectory()) visit(join(directory, entry.name));
        else total += statSync(join(directory, entry.name)).size;
      }
    };
    visit(folder);
    return total;
  };
  const padTo = (extra) => (folder) => {
    let remaining = MAXIMUM_PACK_BYTES - totalOf(folder) + extra;
    for (let index = 0; remaining > 0; index++) {
      const size = Math.min(remaining, MAXIMUM_PACK_FILE_BYTES);
      writeFileSync(join(folder, `pad-${index}.bin`), '');
      truncateSync(join(folder, `pad-${index}.bin`), size);
      remaining -= size;
    }
  };
  await runCases(context, [makeCase('total of 256 MiB + 1', 'refuse', { after: padTo(1) })], { chunkSize: 1 });
});

test('at most 32 packs load at once and the rest are reported, not half loaded', async context => {
  const root = temporaryFolder(context);
  for (let index = 0; index < MAXIMUM_INSTALLED_PACKS + 5; index++) buildCase(join(root, `p${String(index).padStart(2, '0')}`), index, makeCase('x', 'accept'));
  const { packs, rejected } = await loadPacks(root, { packageVersion });
  assert.equal(packs.length, MAXIMUM_INSTALLED_PACKS);
  assert.equal(rejected.length, 5);
  for (const entry of rejected) assert.match(entry.error, /at most 32 packs/);
  const registry = await createPackRegistry(root, { packageVersion });
  assert.equal(registry.list().packs.length, MAXIMUM_INSTALLED_PACKS);
});

// ---- 6. GLBs that point out of the pack ----------------------------------------------------------------------------------------

function glbWithImageUri(uri) {
  const json = Buffer.from(JSON.stringify({ asset: { version: '2.0' }, images: [{ uri }] }).padEnd(120, ' '));
  const header = Buffer.alloc(20);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(20 + json.length, 8);
  header.writeUInt32LE(json.length, 12);
  header.writeUInt32LE(0x4e4f534a, 16);
  return Buffer.concat([header, json]);
}

test('a GLB whose image points outside the pack is refused and never embeds the outside file', async context => {
  const png = example.files.get('previews/crates.png');
  const uris = ['../secret.png', '../../secret.png', '/secret.png', 'C:/secret.png', 'C:\\secret.png', '%2e%2e/secret.png', '..%2fsecret.png', 'sub/../../secret.png', 'file:///secret.png', 'https://example.test/secret.png', '..\\secret.png', 'a/\u0000/b.png', '', '.', './', 'data:text/html;base64,AAAA'];
  const cases = uris.map(uri => makeCase(`GLB image ${JSON.stringify(uri)}`, 'refuse', {
    change: manifest => { manifest.contents.assets = [{ id: 'model', file: 'models/model.glb' }]; },
    after: folder => {
      writeFileAt(folder, 'models/model.glb', glbWithImageUri(uri));
      writeFileSync(join(dirname(folder), 'secret.png'), png);
      writeFileSync(join(dirname(dirname(folder)), 'secret.png'), png);
    },
  }));
  await runCases(context, cases);
});

// ---- 7. seeded random mutation --------------------------------------------------------------------------------------------------

const JUNK_VALUES = [
  () => null, () => true, () => 0, () => -1, () => 2 ** 53, () => '', () => ' ', () => 'x'.repeat(300), () => [], () => {}, () => ({}), () => [[]], () => ['a'],
  () => ({ ['__proto__']: 1 }), () => '../../x', () => 'https://example.test/x', () => '\u0000', () => 'constructor', () => '__proto__', () => 'Ａ', () => 'a/b/../c',
  () => JSON.parse(nestedArrays(50, '1')), () => JSON.parse(nestedObjects(50, '"x"')), () => '1.0.0', () => '>=0', () => 'previews/crates.png', () => 'materials/rusty-metal.json',
  () => 'looks/warm.cube', () => 'recipes/crates.json', () => 'missing/file.json', () => 'x.glb',
];

function listPaths(value, path = [], found = []) {
  found.push(path);
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) listPaths(value[key], [...path, key], found);
  }
  return found;
}

function applyMutation(manifest, random) {
  const paths = listPaths(manifest).filter(path => path.length > 0);
  const path = paths[Math.floor(random() * paths.length)];
  const parent = path.slice(0, -1).reduce((node, key) => node[key], manifest);
  const key = path.at(-1);
  const operation = random();
  if (operation < 0.25) {
    if (Array.isArray(parent)) parent.splice(Number(key), 1);
    else delete parent[key];
  } else if (operation < 0.85) {
    parent[key] = JUNK_VALUES[Math.floor(random() * JUNK_VALUES.length)]();
  } else {
    setPrototypeKey(parent, ['__proto__', 'constructor', 'extra'][Math.floor(random() * 3)], JUNK_VALUES[Math.floor(random() * JUNK_VALUES.length)]());
  }
}

test('300 seeded random manifest mutations are refused cleanly or keep every invariant', async context => {
  const random = createRandom(SEED);
  const cases = Array.from({ length: 300 }, (_, index) => makeCase(`mutation ${index}`, 'either', {
    change: (manifest) => {
      const mutations = 1 + Math.floor(random() * 3);
      for (let count = 0; count < mutations; count++) applyMutation(manifest, random);
      // Written once so the registry pass sees the same manifest: the closure above ran at build time only.
    },
  }));
  const outcomes = await runCases(context, cases);
  const accepted = outcomes.filter(outcome => outcome?.accepted).length;
  assert.ok(accepted >= 5 && accepted <= 295, `a mix of outcomes is expected, got ${accepted} accepted of ${outcomes.length}`);
});

test('random file trees: extras next to a valid pack are accepted only when they are plain text documents', async context => {
  const random = createRandom(SEED + 1);
  const safeNames = ['LICENSE', 'license.txt', 'README.md', 'Notice', 'CHANGELOG.MD', 'AUTHORS', 'Licence.txt'];
  const riskyNames = ['x.js', 'x.PNG.js', 'x.Sh', 'x.HTML', 'x.svg', 'x.wasm', 'x.exe', 'x.py', 'notes.txt', 'data.bin', 'Thumbs.db', 'x.png', 'x.json', 'x.js.txt', 'js', 'a.b.c', 'run', '.env', 'LICENSE.json'];
  const cases = Array.from({ length: 60 }, (_, index) => {
    const risky = random() < 0.5;
    const names = risky ? riskyNames : safeNames;
    const folders = Array.from({ length: Math.floor(random() * 4) }, () => ['a', 'b', 'c', 'd'][Math.floor(random() * 4)]);
    const path = [...folders, names[Math.floor(random() * names.length)]].join('/');
    return makeCase(`${risky ? 'risky' : 'safe'} ${path}`, risky ? 'refuse' : 'accept', { change: (_, files) => files.set(path, 'x') });
  });
  await runCases(context, cases);
});

// ---- 8. the MCP read path -----------------------------------------------------------------------------------------------------------

async function connect(context, runtime) {
  const server = createAgentMcpServer(runtime);
  const client = new Client({ name: 'packs-fuzz-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  context.after(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

test('scene_asset_catalog with a pack and an unknown, traversal-shaped or prototype name answers with a clear error and reads nothing outside', async context => {
  const parent = temporaryFolder(context);
  const packsRoot = join(parent, 'packs');
  buildCase(join(packsRoot, 'example-starter'), 1, makeCase('base', 'accept', { change: manifest => { manifest.name = 'example-starter'; } }));
  buildCase(join(packsRoot, 'constructor-pack'), 2, makeCase('constructor', 'accept', { change: manifest => { manifest.name = 'constructor'; } }));
  const secretMarker = 'SECRET-OUTSIDE-THE-PACK';
  writeFileSync(join(packsRoot, 'secret.json'), JSON.stringify({ secret: secretMarker }));
  writeFileSync(join(parent, 'secret.json'), JSON.stringify({ secret: secretMarker }));
  const runtime = createAgentRuntime({ packs: packsRoot, previewUrl: new URL('file:///unused.js') });
  context.after(() => runtime.close());

  const hostile = ['__proto__', 'constructor', 'prototype', 'toString', 'hasOwnProperty', 'valueOf', '../secret', '../../secret', '..%2fsecret', '%2e%2e/secret', 'a/../secret', '/secret', 'C:/secret',
    'secret.json', '..\\secret', 'rusty-metal\u0000', 'x'.repeat(100000), '', ' ', 'Example-Starter', 'unknown-name'];
  const calls = [];
  for (const name of hostile) {
    // The pack named "constructor" is real, so it is only hostile as an item id.
    if (name !== 'constructor') calls.push({ pack: name, recipe: 'crates' }, { pack: name, material: 'rusty-metal' });
    calls.push({ pack: 'example-starter', recipe: name }, { pack: 'example-starter', material: name });
  }
  for (const odd of [null, 5, true, {}, [], ['example-starter'], { toString: 'x' }]) {
    calls.push({ pack: odd, recipe: 'crates' }, { pack: 'example-starter', recipe: odd }, { pack: 'example-starter', material: odd }, { pack: odd }, { recipe: odd });
  }
  for (const argumentsValue of calls) {
    await assert.rejects(() => runtime.assetCatalog(argumentsValue), error => {
      assert.ok(error instanceof Error, 'an Error');
      assert.ok(!INTERNAL_FAILURE.test(error.message), `${JSON.stringify(argumentsValue).slice(0, 80)}: ${error.message.slice(0, 160)}`);
      assert.ok(!error.message.includes(secretMarker));
      assert.match(error.message, /expected|Pass pack/, JSON.stringify(argumentsValue).slice(0, 80));
      return true;
    }, JSON.stringify(argumentsValue).slice(0, 80));
  }
  // A pack named like an Object.prototype member is an ordinary pack.
  const read = await runtime.assetCatalog({ pack: 'constructor', material: 'rusty-metal' });
  assert.equal(read.json.metallic, 0.85);
  // The inherited names are not items or packs.
  await assert.rejects(() => runtime.assetCatalog({ pack: 'constructor', material: 'constructor' }), /expected an id of this pack's materials: rusty-metal, warm-plaster/);

  const client = await connect(context, runtime);
  for (const argumentsValue of [{ pack: 'unknown-name', recipe: 'crates' }, { pack: 'example-starter', recipe: 'constructor' }, { pack: 'example-starter', material: 'tostring' }, { pack: '__proto__', recipe: 'crates' }, { pack: '../secret', material: 'x' }, { pack: 'example-starter', recipe: '..%2fsecret' }]) {
    const response = await client.callTool({ name: 'scene_asset_catalog', arguments: argumentsValue }).catch(error => ({ isError: true, content: [{ text: error.message }] }));
    assert.equal(response.isError, true, JSON.stringify(argumentsValue));
    const text = response.content.map(part => part.text).join(' ');
    assert.ok(text.length > 20 && !INTERNAL_FAILURE.test(text) && !text.includes(secretMarker), text.slice(0, 200));
  }
  const listing = JSON.parse((await client.callTool({ name: 'scene_asset_catalog', arguments: {} })).content[0].text);
  assert.deepEqual(listing.packs.packs.map(pack => pack.name).sort(), ['constructor', 'example-starter']);
});

test('an input that is never an object does not break the pack registry', async context => {
  const parent = temporaryFolder(context);
  buildCase(join(parent, 'one'), 1, makeCase('base', 'accept'));
  const registry = await createPackRegistry(parent, { packageVersion });
  for (const kind of ['__proto__', 'constructor', 'toString', 'nonsense', undefined, 5]) {
    assert.throws(() => registry.read(kind, 'fz-1', 'rusty-metal'), error => error instanceof Error && !INTERNAL_FAILURE.test(error.message), String(kind));
  }
  const copy = registry.read('materials', 'fz-1', 'rusty-metal');
  copy.metallic = 99;
  assert.notEqual(registry.read('materials', 'fz-1', 'rusty-metal').metallic, 99, 'reads return copies');
  assert.equal(existsSync(join(parent, 'one', '67js-pack.json')), true);
});

// ---- 9. the allow list ---------------------------------------------------------------------------------------------------------------

test('only the manifest, listed files and plain text documents may be in a pack', async context => {
  const script = '#!/bin/sh\necho owned\nexit 0\n# padding padding padding padding\n';
  const withGlb = (content) => ({
    change: manifest => { manifest.contents.assets = [{ id: 'model', file: 'models/model.glb' }]; },
    after: folder => writeFileAt(folder, 'models/model.glb', content),
  });
  const withHdr = (content) => ({
    change: manifest => { manifest.contents.environments = [{ id: 'sky', file: 'sky.hdr' }]; },
    after: folder => writeFileSync(join(folder, 'sky.hdr'), content),
  });
  const cases = [
    ...['run', 'Makefile', '.env', '.bashrc', '.hidden', 'a/b/.profile', 'LICENSES', 'LICENSE.json', 'LICENSE.exe', 'README.html', 'notes.txt', 'MIT', 'COPYING'].map(name => makeCase(`unlisted ${name}`, 'refuse', { change: (_, files) => files.set(name, script) })),
    ...['LICENSE', 'LICENCE', 'README', 'NOTICE', 'CHANGELOG', 'AUTHORS', 'license.md', 'Readme.TXT', 'a/b/NOTICE.md'].map(name => makeCase(`document ${name}`, 'accept', { change: (_, files) => files.set(name, 'Plain text, with unicode: café ☃\n') })),
    makeCase('document with a NUL byte', 'refuse', { change: (_, files) => files.set('LICENSE', Buffer.from('MIT\u0000License')) }),
    makeCase('document that is not UTF-8', 'refuse', { change: (_, files) => files.set('README.md', Buffer.from([0x68, 0x69, 0xff, 0xfe, 0x20])) }),
    makeCase('document of exactly 1 MiB', 'accept', { change: (_, files) => files.set('LICENSE', 'a'.repeat(MAXIMUM_PACK_JSON_BYTES)) }),
    makeCase('document of 1 MiB + 1', 'refuse', { change: (_, files) => files.set('LICENSE', 'a'.repeat(MAXIMUM_PACK_JSON_BYTES + 1)) }),
    makeCase('preview that is a script named .png', 'refuse', { change: (_, files) => files.set('previews/crates.png', script) }),
    makeCase('GLB that is a script', 'refuse', withGlb(script.padEnd(64, ' '))),
    makeCase('GLB that is a PNG', 'refuse', withGlb(example.files.get('previews/crates.png'))),
    makeCase('HDR that is a script', 'refuse', withHdr(script)),
    makeCase('HDR starting with #? but not Radiance', 'refuse', withHdr('#?x\nrm -rf\n')),
    makeCase('HDR #?RGBE', 'accept', withHdr('#?RGBE\nFORMAT=32-bit_rle_rgbe\n\n-Y 1 +X 1\n\u0080\u0080\u0080\u0081')),
    makeCase('look that is a script', 'refuse', { change: (_, files) => files.set('looks/warm.cube', script) }),
  ];
  for (const listed of ['67js-pack.json', '67JS-PACK.JSON', '67js-Pack.json', 'sub/67js-pack.json', 'a/b/67JS-PACK.JSON']) {
    cases.push(
      makeCase(`manifest listed as a material: ${listed}`, 'refuse', { change: manifest => { manifest.contents.materials[0].file = listed; } }),
      makeCase(`manifest listed as a recipe: ${listed}`, 'refuse', { change: manifest => { manifest.contents.recipes[0].file = listed; } }),
      makeCase(`manifest listed as a preview: ${listed}`, 'refuse', { change: manifest => { manifest.contents.recipes[0].preview = listed; } }),
    );
  }
  await runCases(context, cases);
});

test('a JSON file over 1 MiB is refused from its size, without being read', async context => {
  const started = performance.now();
  const outcomes = await runCases(context, [
    makeCase('60 MiB material', 'refuse', { after: folder => { writeFileSync(join(folder, 'materials/rusty-metal.json'), ''); truncateSync(join(folder, 'materials/rusty-metal.json'), 60 * 1024 * 1024); } }),
    makeCase('60 MiB manifest', 'refuse', { after: folder => { writeFileSync(join(folder, '67js-pack.json'), ''); truncateSync(join(folder, '67js-pack.json'), 60 * 1024 * 1024); } }),
  ], { chunkSize: 1 });
  assert.match(outcomes[0].error.message, /materials\[0\]\.file: got .*JSON file of at most 1 MiB/);
  assert.match(outcomes[1].error.message, /67js-pack\.json: got .*JSON file of at most 1 MiB/);
  assert.ok(performance.now() - started < 3000, 'a size check must not read 60 MiB');
});
