import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { MAX_ITEMS_PER_AUTHOR_PER_DAY, MAX_RUNS_PER_DAY, decideTriage, hasStickyComment } from '../scripts/triage-should-run.mjs';
import { LABEL_ALLOWLIST } from '../scripts/triage-apply-labels.mjs';
import { APPROVAL_PHRASES, COMMENT_MARKER, buildCommentBody, claimsApproval, containsSecretValue, sanitizeComment } from '../scripts/triage-post-comment.mjs';
import { isDryRun, loadTriageItem, parseDispatchNumber } from '../scripts/triage-load-item.mjs';

const outsider = { user: { login: 'someone', type: 'User' }, author_association: 'FIRST_TIME_CONTRIBUTOR', labels: [], assignees: [], draft: false };
const decide = (overrides = {}, event = {}) =>
  decideTriage({ eventName: 'pull_request_target', action: 'opened', item: { ...outsider, ...overrides }, ...event });
// Parsed instead of matched, so the test says which hosts and paths survive and not just which substring does.
const linkedAddresses = text => (text.match(/https?:\/\/[^\s)]+/g) ?? []).map(address => new URL(address));
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
  const keptAddresses = linkedAddresses(kept);
  assert.deepEqual(keptAddresses.map(address => address.hostname), ['github.com', '67js.codepawl.com']);
  assert.equal(keptAddresses[0].pathname, '/codepawl/67.js/blob/main/CONTRIBUTING.md');
  assert.equal(keptAddresses[1].pathname, '/docs');
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
  assert.doesNotMatch(body, /Maintainer approved|safe to merge/);
  const quoted = buildCommentBody('Missing a change note.');
  assert.match(quoted, /\n> Missing a change note\.\n/);
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

test('tags nested inside tags or comments cannot rebuild a tag, comment or image after one pass', () => {
  assert.doesNotMatch(sanitizeComment('<<b>img src=x onerror=1>'), /<img/);
  const rebuiltScript = sanitizeComment('<scr<b>ipt>alert(1)</scr</b>ipt>').toLowerCase();
  assert.equal(rebuiltScript.includes('<script') || rebuiltScript.includes('</script'), false, rebuiltScript);
  const rebuiltComment = sanitizeComment('<!<!-- -->-- hidden -->visible');
  for (const fragment of ['<!--', '-->', '--!>', 'hidden']) assert.equal(rebuiltComment.includes(fragment), false, rebuiltComment);
  assert.doesNotMatch(sanitizeComment('!<<b>b>[x](https://evil.example/p.png)'), /evil\.example|!\[/);
  assert.equal(containsSecretValue('ghp_abc<<b>>defghijkl<<i>>mnopqrstu', ['ghp_abcdefghijklmnopqrstu']), true);
});

test('every approval phrase withholds the model text and posts only the fixed header and a review line', () => {
  for (const phrase of APPROVAL_PHRASES) {
    for (const variant of [phrase, phrase.toUpperCase(), phrase.replace(/ /g, '  ')]) {
      assert.equal(claimsApproval(`Overall this is ${variant}.`), true, variant);
      const body = buildCommentBody(`The format is fine and it is ${variant}. Details follow.`);
      assert.doesNotMatch(body, /Details follow|format is fine/, variant);
      assert.match(body, /Automated first pass\. This is not a review, an approval or a security clearance\./);
      assert.match(body, /A maintainer will review this item\./);
      assert.ok(body.startsWith(COMMENT_MARKER));
    }
  }
});

test('an approval phrase hidden by tags or a zero-width character is still caught', () => {
  assert.match(buildCommentBody('It is sa<b></b>fe to use'), /A maintainer will review this item\./);
  assert.match(buildCommentBody('LG\u200bTM'), /A maintainer will review this item\./);
});

test('an approval phrase that only renders as one is still caught', () => {
  const bypasses = ['sa&#102;e', 'sa&#x66;e', 'Looks&nbsp;good', 'looks&NBSP;good', 'sa**f**e', 's*a*fe', 'look`s` good', 'sa\\fe', 'Looks good', 'Looks good'];
  for (const bypass of bypasses) {
    assert.equal(claimsApproval(bypass), true, bypass);
    const body = buildCommentBody(`Notes: ${bypass} to me. Details follow.`);
    assert.match(body, /A maintainer will review this item\./, bypass);
    assert.doesNotMatch(body, /Details follow/, bypass);
  }
  assert.equal(claimsApproval('Use R&amp;D notes and &copy; marks; the snake_case name is fine.'), false);
});

test('a harmless sentence is quoted and word boundaries keep similar words out', () => {
  const body = buildCommentBody('The change touches the loader and lacks a change note. Please add changes/123.md. The unsafe-looking regex was not run.');
  assert.match(body, /> The change touches the loader/);
  assert.doesNotMatch(body, /A maintainer will review this item\./);
  assert.equal(claimsApproval('Safeguards, secured rooms and verifier scripts are mentioned.'), false);
});

test('the dry run reads the item from a number, accepts only a plain number and is chosen by the event name', () => {
  assert.equal(parseDispatchNumber(' 42 '), 42);
  for (const bad of ['', '0', '-1', '4 2', '12abc', '../1', '1e3', '9999999999', undefined]) {
    assert.throws(() => parseDispatchNumber(bad), /must be an issue or pull request number/, String(bad));
  }
  assert.equal(isDryRun('workflow_dispatch'), true);
  assert.equal(isDryRun('pull_request_target'), false);
  assert.equal(isDryRun('issues'), false);
  const calls = [];
  const fetchJson = ([path]) => {
    calls.push(path);
    return path.includes('/pulls/') ? { number: 7, draft: false } : { number: 7, pull_request: {} };
  };
  const pull = loadTriageItem({ inputs: { number: '7' } }, 'o/r', fetchJson);
  assert.deepEqual(calls, ['repos/o/r/issues/7', 'repos/o/r/pulls/7']);
  assert.equal(pull.isPullRequest, true);
  assert.equal(loadTriageItem({ inputs: { number: '7' } }, 'o/r', () => ({ number: 7 })).isPullRequest, false);
  assert.equal(loadTriageItem({ issue: { number: 3 } }, 'o/r', () => ({ number: 3 })).number, 3);
});

test('a dry run passes the gate for an item an earlier run already triaged, but still skips maintainers and held items', () => {
  const dispatch = (overrides = {}, event = {}) =>
    decideTriage({ eventName: 'workflow_dispatch', item: { ...outsider, ...overrides }, ...event });
  assert.equal(dispatch().run, true);
  assert.equal(dispatch({}, { alreadyTriaged: true }).run, true);
  assert.equal(dispatch({ author_association: 'OWNER' }).run, false);
  assert.equal(dispatch({ labels: [{ name: 'hold:look-approval' }] }).run, false);
  assert.equal(dispatch({}, { maintainerActivity: 1 }).run, false);
  assert.equal(dispatch({}, { enabled: false }).run, false);
});

test('the workflow offers a number-only manual dry run, and the post and label scripts write nothing in it', () => {
  assert.match(workflow, /workflow_dispatch:\n\s+inputs:\n\s+number:[\s\S]*?required: true/);
  assert.match(workflow, /write access/);
  for (const name of ['triage-post-comment.mjs', 'triage-apply-labels.mjs']) {
    const source = readFileSync(new URL(`../scripts/${name}`, import.meta.url), 'utf8');
    assert.ok(source.indexOf('isDryRun()') > -1 && source.indexOf('isDryRun()') < source.indexOf("'--method'"), name);
  }
});
