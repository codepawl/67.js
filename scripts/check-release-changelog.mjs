// Checks that a version bump is a complete release: CHANGELOG.md has a "## <version>" section and every changes/<issue>.md note was
// folded into it. Runs on pull requests that bump the version and before `publish` in publish.yml, so npm is never published
// from a commit whose release page the later `release` job cannot build. Usage: node scripts/check-release-changelog.mjs
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseChangelogSections, readFragments } from './changelog-fragments.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

// Returns what is wrong with the release as one message, or null when it is complete. Pure, so tests can call it without files.
export function releaseProblem({ version, changelogText, fragmentNames }) {
  const problems = [];
  const hasSection = parseChangelogSections(changelogText).some(section => section.version === version);
  if (!hasSection) problems.push(`CHANGELOG.md has no "## ${version}" section.`);
  if (fragmentNames.length) problems.push(`changes/ still holds ${fragmentNames.length} unfolded note(s): ${fragmentNames.join(', ')}.`);
  return problems.length ? problems.join('\n') : null;
}

export const RELEASE_FIX = 'Run npm run changes:fold, edit the new CHANGELOG.md section, and commit it with the version bump (CONTRIBUTING.md#release).';

export async function readReleaseProblem(folder = root) {
  const metadata = JSON.parse(await readFile(resolve(folder, 'package.json'), 'utf8'));
  const changelogText = await readFile(resolve(folder, 'CHANGELOG.md'), 'utf8');
  const fragments = await readFragments(resolve(folder, 'changes'));
  return releaseProblem({ version: metadata.version, changelogText, fragmentNames: fragments.map(fragment => fragment.name) });
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? '')).href) {
  const problem = await readReleaseProblem();
  if (problem) {
    console.error(`FAIL release changelog: ${problem}\n     Fix: ${RELEASE_FIX}`);
    process.exit(1);
  }
  console.log('ok: CHANGELOG.md has a section for the package version and no changes/ notes are left.');
}
