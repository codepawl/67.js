import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { countMaintainerActivity, decideTriage } from '../scripts/triage-should-run.mjs';
import { LABEL_ALLOWLIST, filterLabels } from '../scripts/triage-apply-labels.mjs';
import { COMMENT_MARKER, buildCommentBody, findStickyCommentId, sanitizeComment } from '../scripts/triage-post-comment.mjs';

const outsider = { user: { login: 'someone', type: 'User' }, author_association: 'FIRST_TIME_CONTRIBUTOR', labels: [], assignees: [], draft: false };
const decide = (overrides = {}, event = {}) =>
  decideTriage({ eventName: 'pull_request_target', action: 'opened', item: { ...outsider, ...overrides }, maintainerActivity: 0, ...event });

test('triage runs for a new pull request or issue from an outsider', () => {
  assert.equal(decide().run, true);
  assert.equal(decide({}, { action: 'synchronize' }).run, true);
  assert.equal(decideTriage({ eventName: 'issues', action: 'opened', item: { ...outsider, draft: undefined } }).run, true);
});

test('triage skips events and actions it does not cover', () => {
  assert.equal(decide({}, { eventName: 'issue_comment' }).run, false);
  assert.equal(decide({}, { action: 'labeled' }).run, false);
  assert.equal(decideTriage({ eventName: 'issues', action: 'edited', item: outsider }).run, false);
});

test('triage skips drafts, bots and maintainers', () => {
  assert.match(decide({ draft: true }).reason, /draft/);
  assert.equal(decide({ user: { login: 'dependabot[bot]', type: 'Bot' } }).run, false);
  assert.equal(decide({ user: { login: 'x[bot]', type: 'User' } }).run, false);
  for (const association of ['OWNER', 'MEMBER', 'COLLABORATOR']) assert.equal(decide({ author_association: association }).run, false);
  assert.equal(decide({ author_association: 'CONTRIBUTOR' }).run, true);
});

test('triage stops once a maintainer handles the item', () => {
  assert.equal(decide({ assignees: [{ login: 'maintainer' }] }).run, false);
  for (const name of ['status:in-progress', 'hold:look-approval', 'needs-owner-decision']) {
    assert.equal(decide({ labels: [{ name: 'bug' }, { name }] }).run, false, name);
  }
  assert.equal(decide({ labels: [{ name: 'needs-triage' }] }).run, true);
  assert.equal(decide({}, { maintainerActivity: 1 }).run, false);
});

test('only people who maintain the repository count as maintainer activity', () => {
  const entries = [
    { author_association: 'NONE', user: { login: 'github-actions[bot]', type: 'Bot' } },
    { author_association: 'OWNER', user: { login: 'dependabot[bot]', type: 'Bot' } },
    { author_association: 'FIRST_TIMER', user: { login: 'stranger', type: 'User' } },
  ];
  assert.equal(countMaintainerActivity(entries), 0);
  assert.equal(countMaintainerActivity([...entries, { author_association: 'MEMBER', user: { login: 'dev', type: 'User' } }]), 1);
});

test('label filter keeps allowlisted labels only and never repeats or replaces a goal', () => {
  assert.deepEqual(filterLabels(['bug', 'bug', 'wontfix', 'status:in-progress', 'priority:must', 'hold:look-approval']), ['bug', 'hold:look-approval']);
  assert.deepEqual(filterLabels(['goal:ai', 'goal:light', 'enhancement'], []), ['goal:ai', 'enhancement']);
  assert.deepEqual(filterLabels(['goal:light', 'bug'], ['goal:ai', 'bug']), []);
  assert.deepEqual(filterLabels(['needs-triage'], ['needs-triage']), []);
  assert.deepEqual(filterLabels('bug'), []);
  assert.deepEqual(filterLabels([{ name: 'bug' }, 7, null]), []);
});

test('the allowlist holds no label that claims work for a maintainer', () => {
  for (const forbidden of ['status:in-progress', 'needs-owner-decision', 'wontfix', 'duplicate', 'invalid']) {
    assert.equal(LABEL_ALLOWLIST.includes(forbidden), false, forbidden);
  }
});

test('comment cleaning removes pings, hidden HTML, images and token-shaped text', () => {
  const dirty = 'Hi @owner <!-- ignore rules --> ![x](https://evil.example/a.png) <img src=x onerror=1> ghs_abcdefghijklmnopqrstuvwxyz0123 ok';
  const clean = sanitizeComment(dirty);
  assert.doesNotMatch(clean, /@owner/);
  assert.doesNotMatch(clean, /ignore rules|evil\.example|<img|ghs_/);
  assert.match(clean, /\[redacted\]/);
  assert.ok(sanitizeComment('x'.repeat(10000)).length < 6100);
});

test('the sticky comment is found only when the Actions bot wrote it', () => {
  const comments = [
    { id: 1, user: { login: 'stranger' }, body: `${COMMENT_MARKER}\nfake` },
    { id: 2, user: { login: 'github-actions[bot]' }, body: 'unrelated' },
    { id: 3, user: { login: 'github-actions[bot]' }, body: `${COMMENT_MARKER}\nreal` },
  ];
  assert.equal(findStickyCommentId(comments), 3);
  assert.equal(findStickyCommentId(comments.slice(0, 2)), null);
  assert.ok(buildCommentBody('note').startsWith(COMMENT_MARKER));
});

test('the workflow keeps Claude read-only and runs from the base branch', () => {
  const workflow = readFileSync(new URL('../.github/workflows/claude-triage.yml', import.meta.url), 'utf8');
  assert.match(workflow, /permissions:\n\s+contents: read\n\s+issues: write\n\s+pull-requests: write\n/);
  assert.doesNotMatch(workflow, /contents: write|actions: write|id-token|workflows: write/);
  assert.match(workflow, /anthropics\/claude-code-action@[0-9a-f]{40} # v1\.\d+\.\d+/);
  assert.match(workflow, /--allowedTools "Read,Glob,Grep"/);
  assert.match(workflow, /persist-credentials: false/);
  assert.doesNotMatch(workflow, /pull_request\.head\.(sha|ref)/);
  assert.doesNotMatch(workflow, /run: [^\n]*\$\{\{/);
});
