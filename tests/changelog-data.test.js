import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { changelogWithUnreleased, extractVersionSection, readChangelogData } from '../scripts/changelog-fragments.mjs';
import { releaseNotes } from '../scripts/release-notes.mjs';

const changelog = [
  '# Changelog',
  '',
  '## 0.15.0',
  '',
  '- Add a thing (issue #10).',
  '',
  '- Breaking: a renderer no longer draws X (issue #11),',
  '  and the next line continues the entry.',
  '',
  '## 0.14.0',
  '',
  '- Fix a seek that works without breaking playback (part of #9).',
  '',
].join('\n');

async function withFragments(files, check) {
  const folder = await mkdtemp(join(tmpdir(), 'changelog-data-'));
  try {
    for (const [name, text] of Object.entries(files)) await writeFile(join(folder, name), text);
    await check(folder);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

const fragmentFiles = {
  '20.md': '- Add a page for changes (issue #20).\n',
  '21-look.md': '- Breaking look change: the floor is darker.\n',
  '21-look.size.md': '- entry:core: size note that must be skipped',
  '300.md': '- Fix a thing with `code` in it.\n',
};

test('the changelog data holds released sections and pending fragments with issue and breaking flags', async () => {
  await withFragments(fragmentFiles, async (folder) => {
    const data = await readChangelogData({ changelogText: changelog, version: '0.15.0', folder });
    assert.equal(data.version, '0.15.0');
    assert.deepEqual(data.unreleased, [
      { issue: 20, text: 'Add a page for changes (issue #20).', breaking: false },
      { issue: 21, text: 'Breaking look change: the floor is darker.', breaking: true },
      { issue: 300, text: 'Fix a thing with `code` in it.', breaking: false },
    ]);
    assert.deepEqual(data.released.map((release) => release.version), ['0.15.0', '0.14.0']);
    assert.deepEqual(data.released[0].entries.map((entry) => [entry.issue, entry.breaking]), [[10, false], [11, true]]);
    assert.match(data.released[0].entries[1].text, /next line continues the entry\.$/);
    assert.equal(data.released[1].entries[0].breaking, false, 'the lowercase word "breaking" is not a marker');
  });
});

test('the site changelog gets an Unreleased section above the released ones', async () => {
  await withFragments(fragmentFiles, async (folder) => {
    const text = await changelogWithUnreleased(changelog, folder);
    assert.ok(text.indexOf('## Unreleased') < text.indexOf('## 0.15.0'));
    assert.ok(text.startsWith('# Changelog\n\n## Unreleased\n\n- Add a page for changes'));
  });
  await withFragments({}, async (folder) => {
    assert.equal(await changelogWithUnreleased(changelog, folder), changelog);
  });
});

test('release notes are one version section with its breaking marker and the install line', () => {
  const notes = releaseNotes(changelog, '0.15.0', '@codepawlhq/67js');
  assert.match(notes, /^- Add a thing \(issue #10\)\./);
  assert.match(notes, /Breaking: a renderer no longer draws X/);
  assert.doesNotMatch(notes, /0\.14\.0|playback/);
  assert.match(notes, /npm install @codepawlhq\/67js@0\.15\.0`\n$/);
  assert.equal(extractVersionSection(changelog, '0.14.0'), '- Fix a seek that works without breaking playback (part of #9).');
});

test('a ### heading groups the entries below it, and the Breaking changes group marks them breaking', async () => {
  const grouped = [
    '## 0.16.0',
    '',
    '### Highlights',
    '',
    '- A GPU path tracer (#302)',
    '',
    '### Breaking changes',
    '',
    '- Shaders moved into addons (#281)',
    '',
  ].join('\n');
  await withFragments({}, async (folder) => {
    const data = await readChangelogData({ changelogText: grouped, version: '0.16.0', folder });
    assert.deepEqual(data.released[0].entries, [
      { issue: 302, text: 'A GPU path tracer (#302)', breaking: false, group: 'Highlights' },
      { issue: 281, text: 'Shaders moved into addons (#281)', breaking: true, group: 'Breaking changes' },
    ]);
  });
});

test('release notes fail clearly when the version is not in the changelog', () => {
  assert.throws(() => releaseNotes(changelog, '9.9.9', '@codepawlhq/67js'), /CHANGELOG\.md has no section for 9\.9\.9\./);
});
