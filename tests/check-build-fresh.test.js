import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { checkBuildFresh } from '../scripts/check-build-fresh.mjs';
import { sourceDigest } from '../scripts/source-digest.mjs';

async function projectWithBuild({ version = '1.0.0', builtVersion = version } = {}) {
  const projectRoot = await mkdtemp(join(tmpdir(), '67js-fresh-build-'));
  await mkdir(join(projectRoot, 'src', 'nested'), { recursive: true });
  await mkdir(join(projectRoot, 'build', 'mcp'), { recursive: true });
  await writeFile(join(projectRoot, 'package.json'), JSON.stringify({ version }));
  await writeFile(join(projectRoot, 'src', 'game-setup.js'), "export const PLAYER_FIELDS = ['node'];\n");
  await writeFile(join(projectRoot, 'src', 'nested', 'helper.js'), 'export const helper = 1;\n');
  const manifest = { packageVersion: builtVersion, sourceDigest: await sourceDigest(projectRoot) };
  await writeFile(join(projectRoot, 'build', 'mcp', 'manifest.json'), JSON.stringify(manifest));
  return projectRoot;
}

test('a build made from the current src passes', async () => {
  const projectRoot = await projectWithBuild();
  try {
    await checkBuildFresh(projectRoot);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test('a src field added after the build fails the check, as the 0.19.0 report described', async () => {
  const projectRoot = await projectWithBuild();
  try {
    await writeFile(join(projectRoot, 'src', 'game-setup.js'), "export const PLAYER_FIELDS = ['node', 'animation'];\n");
    await assert.rejects(checkBuildFresh(projectRoot), /not made from the current src/);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test('a new or edited file in a nested src folder changes the digest', async () => {
  const projectRoot = await projectWithBuild();
  try {
    const before = await sourceDigest(projectRoot);
    await writeFile(join(projectRoot, 'src', 'nested', 'added.js'), 'export {};\n');
    assert.notEqual(await sourceDigest(projectRoot), before);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test('a build for another package version and a missing build fail with a fix', async () => {
  const staleVersion = await projectWithBuild({ version: '1.0.1', builtVersion: '1.0.0' });
  const noBuild = await mkdtemp(join(tmpdir(), '67js-no-build-'));
  try {
    await assert.rejects(checkBuildFresh(staleVersion), /made for 1\.0\.0, but package\.json says 1\.0\.1/);
    await assert.rejects(checkBuildFresh(noBuild), /Run npm run build:lib/);
  } finally {
    await rm(staleVersion, { recursive: true, force: true });
    await rm(noBuild, { recursive: true, force: true });
  }
});
