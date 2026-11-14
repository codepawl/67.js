import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { register } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkAddon, parseRange, rangeAllows } from '../bin/crucible-addon-check.mjs';
import { VERSION } from '../src/version.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const starterFolder = join(root, 'templates', 'addon-starter');
const PEER_PREFIX = '@codepawlhq/crucible/addons/';

// Resolves the peer package's addon subpaths to this checkout's source, as the built package would.
const resolveHooks = `
export async function resolve(specifier, context, next) {
  if (specifier.startsWith(${JSON.stringify(PEER_PREFIX)})) {
    const name = specifier.slice(${PEER_PREFIX.length});
    return { url: new URL('src/' + name + '.js', ${JSON.stringify(pathToFileURL(root + '/').href)}).href, shortCircuit: true };
  }
  return next(specifier, context);
}
`;
const hooksUrl = `data:text/javascript,${encodeURIComponent(resolveHooks)}`;
register(hooksUrl);

function copyStarter(change) {
  const folder = mkdtempSync(join(tmpdir(), 'addon-starter-'));
  cpSync(starterFolder, folder, { recursive: true });
  const path = join(folder, 'package.json');
  const pack = JSON.parse(readFileSync(path, 'utf8'));
  change(pack);
  writeFileSync(path, JSON.stringify(pack));
  return folder;
}

function errorsFor(change, options) {
  const folder = copyStarter(change);
  try {
    return checkAddon(folder, options).errors;
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

test('the starter template passes the contract for the current Crucible version', () => {
  const { errors, warnings } = checkAddon(starterFolder, { version: VERSION });
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});

test('the starter registers its controller kind against the local Crucible source', async () => {
  const { registerHoverController } = await import(pathToFileURL(join(starterFolder, 'src', 'index.js')).href);
  const { createController } = await import('../src/player.js');
  assert.equal(registerHoverController('starter-hover'), 'starter-hover');
  const controller = createController('starter-hover', { hoverHeight: 3 });
  assert.deepEqual(controller.state.position, [0, 3, 0]);
});

test('the starter own tests pass against the local Crucible source', () => {
  const result = spawnSync(process.execPath, ['--import', hooksUrl, '--test', join(starterFolder, 'tests', 'starter.spec.js')], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('a missing keyword is refused with the fix', () => {
  const errors = errorsFor(pack => { pack.keywords = ['three-d']; });
  assert.match(errors.join('\n'), /must include "crucible-addon".*Add it/);
});

test('a missing peer dependency is refused with the fix', () => {
  const errors = errorsFor(pack => { delete pack.peerDependencies; });
  assert.match(errors.join('\n'), /peerDependencies" must list @codepawlhq\/crucible/);
});

test('a bad range, unknown point and missing manifest are refused', () => {
  assert.match(errorsFor(pack => { pack['crucible'].range = 'latest'; }).join('\n'), /"crucible".range must be a version range/);
  assert.match(errorsFor(pack => { pack['crucible'].extensionPoints = ['hackTheGibson']; }).join('\n'), /unknown point "hackTheGibson"/);
  assert.match(errorsFor(pack => { delete pack['crucible']; }).join('\n'), /no "crucible" field/);
});

test('a range that excludes the running version and an oversized entry are refused', () => {
  assert.match(errorsFor(pack => { pack['crucible'].range = '>=9.0.0'; }, { version: VERSION }).join('\n'), /does not allow Crucible/);
  assert.match(errorsFor(pack => { pack['crucible'].bundleBytes = 10; }).join('\n'), /raise bundleBytes|Raise bundleBytes/i);
});

test('the command line exits non-zero for a folder that breaks the contract', () => {
  const folder = copyStarter(pack => { pack.keywords = []; });
  try {
    const result = spawnSync(process.execPath, [join(root, 'bin', 'crucible-addon-check.mjs'), folder], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /error: /);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('ranges parse caret and comparator forms', () => {
  assert.ok(parseRange('^0.19.0'));
  assert.equal(parseRange('wat'), null);
  assert.equal(rangeAllows('^0.19.0', '0.19.4'), true);
  assert.equal(rangeAllows('^0.19.0', '0.20.0'), false);
  assert.equal(rangeAllows('>=0.19.0 <1.0.0', '0.20.0'), true);
});
