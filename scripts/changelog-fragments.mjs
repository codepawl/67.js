import { readdir, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const fragmentsFolder = resolve(root, 'changes');
const changelogPath = resolve(root, 'CHANGELOG.md');
const semver = /^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/;

function isFragmentName(name) {
  return name.endsWith('.md') && !name.endsWith('.size.md') && name.toLowerCase() !== 'readme.md';
}

function trimBlankLines(text) {
  return text.replace(/\r\n/g, '\n').replace(/^\n+/, '').replace(/\s+$/, '');
}

// Reads every fragment in name order, so the same files always give the same text.
export async function readFragments(folder = fragmentsFolder) {
  const names = (await readdir(folder)).filter(isFragmentName).sort();
  const fragments = [];
  for (const name of names) {
    const text = trimBlankLines(await readFile(resolve(folder, name), 'utf8'));
    if (text) fragments.push({ name, text });
  }
  return fragments;
}

// A changelog entry is a "- " bullet; a line that follows without a bullet continues it.
// An entry is breaking when its text says "Breaking" with a capital B, as in "Breaking:" or "Breaking look change:".
const breakingPattern = /\bBreaking\b/;

function issueNumberOf(text, fallbackName) {
  const inText = text.match(/#(\d+)/);
  if (inText) return Number(inText[1]);
  const inName = fallbackName?.match(/^(\d+)/);
  return inName ? Number(inName[1]) : null;
}

// A "### Group" heading names the group of the entries below it. Every entry under a group called
// "Breaking changes" is breaking.
const groupHeading = /^###\s+(.+?)\s*$/;

export function parseEntries(markdown, fallbackName) {
  const entries = [];
  let group = null;
  for (const line of markdown.replace(/\r\n/g, '\n').split('\n')) {
    const heading = line.match(groupHeading);
    if (heading) {
      group = heading[1];
    } else if (line.startsWith('- ')) {
      entries.push({ text: line.slice(2).trim(), group });
    } else if (line.trim() && entries.length > 0) {
      entries[entries.length - 1].text += ` ${line.trim()}`;
    }
  }
  return entries.map(({ text, group: entryGroup }) => {
    const breaking = breakingPattern.test(text) || breakingPattern.test(entryGroup ?? '');
    const entry = { issue: issueNumberOf(text, fallbackName), text, breaking };
    if (entryGroup) entry.group = entryGroup;
    return entry;
  });
}

// Splits CHANGELOG.md into its "## <version>" sections, newest first as written.
export function parseChangelogSections(changelogText) {
  const sections = [];
  const text = changelogText.replace(/\r\n/g, '\n');
  const headings = [...text.matchAll(/^## (\S+)[ \t]*$/gm)];
  headings.forEach((heading, index) => {
    const end = index + 1 < headings.length ? headings[index + 1].index : text.length;
    const body = text.slice(heading.index + heading[0].length, end);
    sections.push({ version: heading[1], body: trimBlankLines(body) });
  });
  return sections;
}

// The markdown of one version's section, without its heading. Throws when the version is not in the changelog.
export function extractVersionSection(changelogText, version) {
  const section = parseChangelogSections(changelogText).find((candidate) => candidate.version === version);
  if (!section) throw new Error(`CHANGELOG.md has no section for ${version}.`);
  return section.body;
}

// Everything a reader or an agent needs: released sections from the changelog, pending entries from the fragments.
export async function readChangelogData({ changelogText, version, folder = fragmentsFolder }) {
  const fragments = await readFragments(folder);
  const unreleased = fragments.flatMap((fragment) => parseEntries(fragment.text, fragment.name));
  const released = parseChangelogSections(changelogText).map((section) => ({ version: section.version, entries: parseEntries(section.body) }));
  return { version, released, unreleased };
}

// The changelog text with a "## Unreleased" section above the released ones, for the site's /changelog.md.
export async function changelogWithUnreleased(changelogText, folder = fragmentsFolder) {
  const fragments = await readFragments(folder);
  if (fragments.length === 0) return changelogText;
  const text = changelogText.replace(/\r\n/g, '\n');
  const section = `## Unreleased\n\n${fragments.map((fragment) => fragment.text).join('\n')}\n\n`;
  const firstSection = text.search(/^## /m);
  return firstSection === -1 ? `${text.replace(/\s+$/, '')}\n\n${section.trimEnd()}\n` : `${text.slice(0, firstSection)}${section}${text.slice(firstSection)}`;
}

// Puts a version section above the newest one. Fragment text is copied as it is.
export function foldIntoChangelog(changelogText, version, fragments) {
  const changelog = changelogText.replace(/\r\n/g, '\n');
  if (!semver.test(version)) throw new Error(`Not a valid version: ${version}`);
  if (fragments.length === 0) throw new Error('No change fragments to fold.');
  if (new RegExp(`^## ${version.replaceAll('.', '\\.')}$`, 'm').test(changelog)) {
    throw new Error(`CHANGELOG.md already has a section for ${version}.`);
  }
  const section = `## ${version}\n\n${fragments.map((fragment) => fragment.text).join('\n')}\n\n`;
  const firstSection = changelog.search(/^## /m);
  if (firstSection === -1) return `${changelog.replace(/\s+$/, '')}\n\n${section.trimEnd()}\n`;
  return `${changelog.slice(0, firstSection)}${section}${changelog.slice(firstSection)}`;
}

async function main() {
  const [command, versionArgument] = process.argv.slice(2);
  const fragments = await readFragments();
  if (command === 'fold') {
    const version = versionArgument ?? JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')).version;
    const changelog = await readFile(changelogPath, 'utf8');
    await writeFile(changelogPath, foldIntoChangelog(changelog, version, fragments));
    for (const fragment of fragments) await rm(resolve(fragmentsFolder, fragment.name));
    // Size notes only matter to the pull request that adds them. The release refreshes the size numbers instead.
    const sizeNotes = (await readdir(fragmentsFolder)).filter((name) => name.endsWith('.size.md'));
    for (const name of sizeNotes) await rm(resolve(fragmentsFolder, name));
    console.log(`Folded ${fragments.length} fragments into CHANGELOG.md as ${version}, and removed ${sizeNotes.length} size notes. Run npm run size:release next.`);
    return;
  }
  if (fragments.length === 0) {
    console.log('No pending change notes.');
    return;
  }
  for (const fragment of fragments) console.log(`# changes/${fragment.name}\n${fragment.text}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
