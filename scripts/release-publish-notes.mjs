// Creates the v<version> tag and release page after npm publish. Skips quietly when the release already exists.
// Needs the `gh` CLI and GH_TOKEN with contents: write, and runs only in Actions (GITHUB_SHA is the pushed commit).
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { releaseNotes } from './release-notes.mjs';

const metadata = JSON.parse(await readFile('package.json', 'utf8'));
const tag = `v${metadata.version}`;
const commit = process.env.GITHUB_SHA;
if (!commit) throw new Error('Run this step from GitHub Actions: GITHUB_SHA is not set.');

function releaseExists() {
  return spawnSync('gh', ['release', 'view', tag], { encoding: 'utf8' }).status === 0;
}

if (releaseExists()) {
  console.log(`Release ${tag} already exists.`);
} else {
  const notesFile = join(await mkdtemp(join(tmpdir(), 'release-notes-')), 'notes.md');
  await writeFile(notesFile, releaseNotes(await readFile('CHANGELOG.md', 'utf8'), metadata.version, metadata.name));
  const created = spawnSync('gh', ['release', 'create', tag, '--target', commit, '--title', `Crucible ${metadata.version}`, '--notes-file', notesFile], { stdio: 'inherit' });
  // A run that lost a race to create the same release is not a failed publish.
  if (created.status !== 0 && !releaseExists()) throw new Error(`gh release create failed with exit code ${created.status}.`);
}
