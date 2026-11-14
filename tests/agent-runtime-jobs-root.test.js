import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentRuntime } from '../scripts/agent-runtime.mjs';
import { resolveJobRoot } from '../scripts/agent-job-root.mjs';

const createdDirectories = [];
// Removed after every test, so a runtime closed in a test hook can still reach its folder.
after(() => Promise.all(createdDirectories.map(directory => rm(directory, { recursive: true, force: true }))));

async function temporaryDirectory() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'crucible-jobs-root-')));
  createdDirectories.push(directory);
  return directory;
}

// A Windows junction needs no privilege; a POSIX symlink does the same job. Returns false when the OS refuses links.
async function tryLinkDirectory(target, linkPath) {
  try {
    await symlink(target, linkPath, 'junction');
    return true;
  } catch {
    return false;
  }
}

test('resolveJobRoot keeps a plain folder and a folder that does not exist yet', async context => {
  const directory = await temporaryDirectory();
  assert.equal(resolveJobRoot(undefined), undefined);
  assert.equal(resolveJobRoot(directory), directory);
  const notYetCreated = join(directory, 'later');
  assert.equal(resolveJobRoot(notYetCreated), notYetCreated);
  assert.throws(() => resolveJobRoot('relative/jobs'), /absolute/);
});

test('resolveJobRoot names --jobs when the path is a file', async context => {
  const directory = await temporaryDirectory();
  const filePath = join(directory, 'plain-file');
  await writeFile(filePath, 'x');
  assert.throws(() => resolveJobRoot(filePath), /--jobs .*real, existing directory/);
});

test('resolveJobRoot follows a linked jobs folder to its real target', async context => {
  const directory = await temporaryDirectory();
  const target = join(directory, 'real-target');
  await mkdir(target);
  const linkPath = join(directory, 'linked-jobs');
  if (!await tryLinkDirectory(target, linkPath)) {
    context.skip('this OS refused to create a directory link');
    return;
  }
  assert.equal(resolveJobRoot(linkPath), target);
});

test('a linked --jobs folder runs the job store on the real folder', async context => {
  const directory = await temporaryDirectory();
  const target = join(directory, 'real-target');
  await mkdir(target);
  const linkPath = join(directory, 'linked-jobs');
  if (!await tryLinkDirectory(target, linkPath)) {
    context.skip('this OS refused to create a directory link');
    return;
  }
  const runtime = createAgentRuntime({ backend: 'cpu', memory: 64, jobs: linkPath });
  context.after(() => runtime.close());
  const capabilities = await runtime.capabilities();
  assert.equal(capabilities.jobs.configured, true);
  assert.deepEqual(capabilities.jobs.records, []);
  assert.equal(capabilities.jobs.unavailable, undefined);
});

test('capabilities work when the job store cannot open, and the store opens on a later call', async context => {
  const directory = await temporaryDirectory();
  const blocker = join(directory, 'blocker');
  await writeFile(blocker, 'x');
  const runtime = createAgentRuntime({ backend: 'cpu', memory: 64, jobs: join(blocker, 'jobs') });
  context.after(() => runtime.close());
  const failed = await runtime.capabilities();
  assert.equal(failed.jobs.configured, true);
  assert.deepEqual(failed.jobs.records, []);
  assert.equal(typeof failed.jobs.unavailable, 'string');
  assert.equal(failed.scene.schemaVersion, 1);

  await rm(blocker);
  const recovered = await runtime.capabilities();
  assert.equal(recovered.jobs.unavailable, undefined, 'a failed store is not cached until restart');
  assert.deepEqual(recovered.jobs.records, []);
});
