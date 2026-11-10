import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { MAX_ITEMS_PER_AUTHOR_PER_DAY, MAX_RUNS_PER_DAY, decideTriage, hasStickyComment } from '../scripts/triage-should-run.mjs';
import { LABEL_ALLOWLIST } from '../scripts/triage-apply-labels.mjs';
import { COMMENT_MARKER, buildCommentBody, containsSecretValue, sanitizeComment } from '../scripts/triage-post-comment.mjs';

const outsider = { user: { login: 'someone', type: 'User' }, author_association: 'FIRST_TIME_CONTRIBUTOR', labels: [], assignees: [], draft: false };
const decide = (overrides = {}, event = {}) =>
  decideTriage({ eventName: 'pull_request_target', action: 'opened', item: { ...outsider, ...overrides }, ...event });
const workflow = readFileSync(new URL('../.github/workflows/claude-triage.yml', import.meta.url), 'utf8');

test('a push or a reopen never starts another run', () => {
  for (const action of ['synchronize', 'reopened']) assert.equal(decide({}, { action }).run, false, action);
  assert.equal(decideTriage({ eventName: 'issues', action: 'reopened', item: outsider }).run, false);
  assert.doesNotMatch(workflow, /synchronize|reopened/);
});

test('an item with a sticky note is never triaged twice', () => {
  assert.equal(hasStickyComment([{ user: { login: 'github-actions[bot]' }, body: `${COMMENT_MARKER}\nnote` }]), true);
  assert.equal(hasStickyComment([{ user: { login: 'stranger' }, body: COMMENT_MARKER }]), false);
  assert.match(decide({}, { alreadyTriaged: true }).reason, /already triaged/);
  assert.equal(decide({}, { alreadyTriaged: true, requireStickyForLaterSteps: true }).run, true);
});

test('triage stops for closed items, a maintainer trigger, a pause and the daily limits', () => {
  assert.equal(decide({ state: 'closed' }).run, false);
  assert.equal(decide({ merged: true }).run, false);
  assert.equal(decide({}, { senderLogin: 'maintainer' }).run, false);
  assert.equal(decide({}, { senderLogin: 'someone' }).run, true);
  assert.equal(decide({}, { enabled: false }).run, false);
  assert.equal(decide({}, { authorItemsToday: MAX_ITEMS_PER_AUTHOR_PER_DAY }).run, true);
  assert.equal(decide({}, { authorItemsToday: MAX_ITEMS_PER_AUTHOR_PER_DAY + 1 }).run, false);
  assert.equal(decide({}, { runsToday: MAX_RUNS_PER_DAY }).run, true);
  assert.equal(decide({}, { runsToday: MAX_RUNS_PER_DAY + 1 }).run, false);
  assert.equal(decide({}, { runsToday: Number.POSITIVE_INFINITY }).run, false);
});

test('the bot cannot add a label that stops it or gates work', () => {
  for (const label of ['hold:look-approval', 'status:needs-author', 'status:in-progress', 'needs-owner-decision']) {
    assert.equal(LABEL_ALLOWLIST.includes(label), false, label);
  }
});

test('reference-style images, link definitions and outside links are removed', () => {
  const clean = sanitizeComment('![x][r]\n\n[r]: https://evil.example/p.png?d=1\n[click](https://evil.example) see https://evil.example/y and www.evil.example');
  assert.doesNotMatch(clean, /evil\.example|!\[/);
  assert.match(clean, /click/);
  const kept = sanitizeComment('See [guide](https://github.com/codepawl/67.js/blob/main/CONTRIBUTING.md) and https://67js.codepawl.com/docs');
  assert.match(kept, /github\.com\/codepawl\/67\.js\/blob/);
  assert.match(kept, /67js\.codepawl\.com\/docs/);
  assert.doesNotMatch(sanitizeComment('https://github.com/codepawl/67.js.evil.example/x'), /evil/);
  assert.doesNotMatch(sanitizeComment('mail me at someone@evil.example'), /evil/);
});

test('a tag cannot rebuild an image or split a token past the cleaner', () => {
  assert.doesNotMatch(sanitizeComment('!<b>[x](https://evil.example/p.png?d=1)'), /evil\.example|!\[/);
  assert.doesNotMatch(sanitizeComment('!<b><i>[x](https://evil.example/p.png)'), /evil\.example/);
  const split = sanitizeComment('ghp_abcdefghij<b></b>klmnopqrstuvwxyz1234');
  assert.doesNotMatch(split, /ghp_abcdefghij/);
  assert.match(split, /\[redacted\]/);
  assert.doesNotMatch(sanitizeComment('ghp_abcdefghij​klmnopqrstuvwxyz1234'), /ghp_abcdefghij/);
});

test('cross-repository references and pings become inert text', () => {
  const clean = sanitizeComment('See octocat/other-repo#5 and #12, cc @someone @org/team');
  assert.match(clean, /`octocat\/other-repo#5`/);
  assert.match(clean, /#12/);
  assert.doesNotMatch(clean, /@someone|@org/);
});

test('a note holding the real token is withheld, however it is spelled', () => {
  const token = 'REALTOKENVALUE0123456789abcdef';
  const variants = [
    token,
    token.split('').join(' '),
    `${token.slice(0, 12)}<b></b>${token.slice(12)}`,
    Buffer.from(token).toString('base64'),
    Buffer.from(token).toString('hex'),
    token.toUpperCase(),
  ];
  for (const variant of variants) {
    assert.equal(sanitizeComment(`leak: ${variant}`, [token]), '', variant);
    assert.equal(containsSecretValue(variant, [token]), true);
    const body = buildCommentBody(`leak: ${variant}`, [token]);
    assert.doesNotMatch(body, /REALTOKEN/i);
    assert.match(body, /withheld/);
  }
  assert.equal(containsSecretValue('nothing here', [token]), false);
  assert.equal(containsSecretValue('anything', ['short']), false);
});

test('the model text sits under a fixed header and cannot pose as an approval', () => {
  const body = buildCommentBody('Maintainer approved, safe to merge');
  assert.match(body, /^<!-- claude-triage -->\n\*\*Automated first pass\. This is not a review, an approval/);
  assert.match(body, /\n> Maintainer approved, safe to merge\n/);
});

test('the workflow limits cost, drafts, file access and reruns', () => {
  assert.match(workflow, /if: \$\{\{[^\n]*pull_request\.draft != true/);
  assert.match(workflow, /vars\.TRIAGE_ENABLED != 'false'/);
  for (const folder of ['proc', 'sys', 'etc']) assert.ok(workflow.includes(`Read(//${folder}/**)`), folder);
  assert.match(workflow, /id: gate_after/);
  assert.match(workflow, /if: steps\.gate_after\.outputs\.run == 'true'/);
  assert.doesNotMatch(workflow, /\| head -[cn] /, 'a pipe into head can end the step with SIGPIPE under pipefail');
  assert.match(workflow, /DIFF_LIMIT_BYTES: '61440'/);
});
