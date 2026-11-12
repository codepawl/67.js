import test from 'node:test';
import assert from 'node:assert/strict';
import { foldIntoChangelog, parseEntries } from '../scripts/changelog-fragments.mjs';
import { releaseNotes } from '../scripts/release-notes.mjs';

const changelog = '# Changelog\n\n## 0.14.0\n\n- Old note.\n';

test('a media line is folded into CHANGELOG.md as a markdown image, or a link for a clip', () => {
  const fragments = [
    { name: 'a.md', text: '- A with a picture (#1)\n  media: https://example.com/a.png The new cube' },
    { name: 'b.md', text: '- B with a clip (#2)\nmedia: /media/b.mp4 The camera orbit' },
  ];
  const folded = foldIntoChangelog(changelog, '0.15.0', fragments);
  assert.match(folded, /- A with a picture \(#1\)\n {2}!\[The new cube\]\(https:\/\/example\.com\/a\.png\)\n/);
  assert.match(folded, /- B with a clip \(#2\)\n {2}\[The camera orbit\]\(\/media\/b\.mp4\)\n/);
});

test('folding rejects a media line with an http URL, a protocol-relative URL or no alt text', () => {
  const fold = (line) => foldIntoChangelog(changelog, '0.15.0', [{ name: 'a.md', text: `- A.\n${line}` }]);
  assert.throws(() => fold('media: http://example.com/a.png Alt'), /https URL or a path/);
  assert.throws(() => fold('media: //example.com/a.png Alt'), /https URL or a path/);
  assert.throws(() => fold('media: https://example.com/a.png'), /alt text/);
});

test('a media line becomes entry.media, in a fragment and in the folded changelog', () => {
  const pending = parseEntries('- A (#1)\nmedia: /media/a.webm The orbit\n- B.', 'x.md');
  assert.deepEqual(pending[0].media, { url: '/media/a.webm', alt: 'The orbit' });
  assert.equal(pending[0].text, 'A (#1)');
  assert.equal(pending[1].media, undefined);
  const released = parseEntries('- A (#1)\n  ![The cube](https://example.com/a.png)\n- B (#2)\n  [The orbit](/media/b.mp4)\n- C.\n  [not media](https://example.com/page)');
  assert.deepEqual(released[0].media, { url: 'https://example.com/a.png', alt: 'The cube' });
  assert.deepEqual(released[1].media, { url: '/media/b.mp4', alt: 'The orbit' });
  assert.equal(released[2].media, undefined);
  assert.match(released[2].text, /not media/);
});

test('release notes keep the media of a version section', () => {
  const folded = foldIntoChangelog(changelog, '0.15.0', [{ name: 'a.md', text: '- A (#1)\nmedia: https://example.com/a.png The cube' }]);
  assert.match(releaseNotes(folded, '0.15.0', 'pkg'), /!\[The cube\]\(https:\/\/example\.com\/a\.png\)/);
});
