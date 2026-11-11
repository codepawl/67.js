import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkPullRequest,
  isAutoCloseExempt,
  isLightPullRequest,
  isLookPath,
  sectionOf,
} from '../scripts/pr-metadata-check.mjs';
import {
  CLOSE_AFTER_HOURS,
  HOUR_MS,
  REMINDER_AFTER_HOURS,
  buildMarker,
  decideActions,
  parseMarker,
  renderStatusComment,
} from '../scripts/pr-metadata-flow.mjs';
import { checkOnePullRequest } from '../scripts/pr-metadata-run.mjs';
import { failingGatesFor } from '../scripts/check-change-note.mjs';

const goodBody = `## What changed

Adds a thing.

Closes #12

## How I checked it

\`npm run preflight\` passed, 14 checks ok.
`;

function pullRequest(overrides = {}) {
  return {
    body: goodBody,
    title: 'Add a thing (#12)',
    author: 'someone',
    authorAssociation: 'NONE',
    labels: ['goal:ai', 'enhancement'],
    milestone: '5 Agent surface',
    draft: false,
    ...overrides,
  };
}

function file(filename) {
  return { filename, additions: 1, deletions: 0 };
}

const shippedFiles = [file('src/scene.js'), file('changes/12.md')];

function fixIds(input) {
  return checkPullRequest(input).contributorFixes.map(item => item.id);
}

test('a complete pull request has no fixes and no todos', () => {
  const result = checkPullRequest({ pr: pullRequest(), files: shippedFiles });
  assert.deepEqual(result, { contributorFixes: [], maintainerTodos: [], addLabels: [], removeLabels: [] });
});

test('a missing Closes or Part of line is a contributor fix', () => {
  const body = goodBody.replace('Closes #12', 'Closes #');
  assert.deepEqual(fixIds({ pr: pullRequest({ body }), files: shippedFiles }), ['missing-issue-link']);
  const partOf = goodBody.replace('Closes #12', 'Part of #12');
  assert.deepEqual(fixIds({ pr: pullRequest({ body: partOf }), files: shippedFiles }), []);
});

test('nested comment markers are stripped until none are left', () => {
  const body = goodBody.replace('Closes #12', '<!<!-- x -->-- Closes #12 -->');
  assert.deepEqual(fixIds({ pr: pullRequest({ body }), files: shippedFiles }), ['missing-issue-link']);
  assert.equal(sectionOf('<!<!-- x -->-- ## Ran -->\n## Ran\nnpm test', 'Ran'), 'npm test');
});

test('an issue link inside an HTML comment does not count', () => {
  const body = goodBody.replace('Closes #12', '<!-- Closes #12 -->');
  assert.deepEqual(fixIds({ pr: pullRequest({ body }), files: shippedFiles }), ['missing-issue-link']);
});

test('an empty or template-only "How I checked it" is a contributor fix', () => {
  const emptyBody = goodBody.replace(/## How I checked it[\s\S]*$/, '## How I checked it\n\n<!-- Paste the commands. -->\n- [ ] preflight\n');
  assert.deepEqual(fixIds({ pr: pullRequest({ body: emptyBody }), files: shippedFiles }), ['empty-how-checked']);
  const missingSection = goodBody.replace(/## How I checked it[\s\S]*$/, '');
  assert.deepEqual(fixIds({ pr: pullRequest({ body: missingSection }), files: shippedFiles }), ['empty-how-checked']);
});

test('shipped code without changes/<issue>.md is a contributor fix, and a size note does not count', () => {
  assert.deepEqual(fixIds({ pr: pullRequest(), files: [file('src/scene.js')] }), ['missing-change-note']);
  assert.deepEqual(fixIds({ pr: pullRequest(), files: [file('skills/a/SKILL.md'), file('changes/12.size.md')] }), ['missing-change-note', 'missing-bench-table']);
  assert.deepEqual(fixIds({ pr: pullRequest(), files: [file('packages/x/index.js'), file('changes/12-edges.md')] }), []);
});

test('a local path in the body is a contributor fix, for every kind of path', () => {
  const windowsPath = ['C:', 'Users', 'me', 'work'].join('\\');
  for (const path of [windowsPath, '/home/me/work', '/Users/me/work']) {
    const body = `${goodBody}\nSee ${path}/out.png\n`;
    assert.deepEqual(fixIds({ pr: pullRequest({ body }), files: shippedFiles }), ['local-path'], path);
  }
  const placeholder = `${goodBody}\nUse /home/<name>/ as an example.\n`;
  assert.deepEqual(fixIds({ pr: pullRequest({ body: placeholder }), files: shippedFiles }), []);
});

test('a tool schema or skill change needs a bench table, or a note that there is no Claude Code login', () => {
  const files = [file('scripts/mcp-server.mjs'), file('changes/12.md')];
  assert.deepEqual(fixIds({ pr: pullRequest(), files }), ['missing-bench-table']);
  const table = `${goodBody}\n| task | before | after |\n| --- | --- | --- |\n| haiku bench | 20/28 | 22/28 |\n`;
  assert.deepEqual(fixIds({ pr: pullRequest({ body: table }), files }), []);
  const optOut = `${goodBody}\nI have no Claude Code login, so a maintainer can run the bench.\n`;
  const result = checkPullRequest({ pr: pullRequest({ body: optOut }), files });
  assert.deepEqual(result.contributorFixes, []);
  assert.ok(result.maintainerTodos.some(todo => todo.includes('agent bench')));
  assert.deepEqual(fixIds({ pr: pullRequest(), files: [file('skills/x/SKILL.md'), file('changes/12.md')] }), ['missing-bench-table']);
});

test('natural ways to say there is no bench run are accepted', () => {
  const files = [file('scripts/mcp-server.mjs'), file('changes/12.md')];
  const sentences = [
    'I have no Claude Code login; a maintainer runs the bench.',
    'I do not have a Claude Code login, please run the bench.',
    "I don't have a Claude Code login.",
    'I cannot run the bench, a maintainer can run it.',
    "I can't run the bench.",
    'No access to Claude Code.',
    'A maintainer can run the bench for me.',
    'The tool schemas are unchanged.',
  ];
  for (const sentence of sentences) {
    const body = [goodBody, sentence, ''].join("\n");
    assert.deepEqual(fixIds({ pr: pullRequest({ body }), files }), [], sentence);
  }
});

test('detail text in src/agent-scene-capabilities.js alone needs no bench table', () => {
  const files = [file('src/agent-scene-capabilities.js'), file('changes/12.md')];
  assert.deepEqual(fixIds({ pr: pullRequest(), files }), []);
});

test('a section named Ran, or a fenced block, counts as how I checked it', () => {
  const ran = ['## What changed', '', 'Adds a thing.', '', 'Closes #12', '', '## Ran', '', 'npm run preflight passed, 14 checks ok.', ''].join('\n');
  assert.deepEqual(fixIds({ pr: pullRequest({ body: ran }), files: shippedFiles }), []);
  const checked = ran.replace('## Ran', '## Checked');
  assert.deepEqual(fixIds({ pr: pullRequest({ body: checked }), files: shippedFiles }), []);
  const fence = '`'.repeat(3);
  const fenced = ['## What changed', '', 'Closes #12', '', fence, 'node --test tests/a.test.js', '# pass 4', fence, ''].join('\n');
  assert.deepEqual(fixIds({ pr: pullRequest({ body: fenced }), files: shippedFiles }), []);
});

test('look paths are detected by whole name parts', () => {
  for (const path of ['src/shaders.js', 'src/lighting.js', 'src/material-pbr.js', 'src/environment.js', 'src/post/bloom.js', 'packages/a/fog.js', 'src/shadow-map.glsl.js']) {
    assert.ok(isLookPath(path), path);
  }
  for (const path of ['src/flight-path.js', 'src/highlight.js', 'docs/lighting.md', 'tests/lighting.test.js', 'src/mesh.js']) {
    assert.ok(!isLookPath(path), path);
  }
});

test('a look change adds hold:look-approval once and needs an image', () => {
  const files = [file('src/lighting.js'), file('changes/12.md')];
  const result = checkPullRequest({ pr: pullRequest(), files });
  assert.deepEqual(result.contributorFixes.map(item => item.id), ['look-without-image']);
  assert.ok(result.addLabels.includes('hold:look-approval'));
  const withImage = `${goodBody}\n![after](https://github.com/user-attachments/assets/abc)\n`;
  assert.deepEqual(fixIds({ pr: pullRequest({ body: withImage }), files }), []);
  const held = checkPullRequest({ pr: pullRequest({ body: withImage, labels: ['goal:ai', 'enhancement', 'hold:look-approval'] }), files });
  assert.ok(!held.addLabels.includes('hold:look-approval'));
});

test('docs-only, CI-only and test-only pull requests skip every rule except the local path', () => {
  const bare = pullRequest({ body: '' });
  for (const files of [[file('docs/guide.md')], [file('.github/workflows/test.yml')], [file('tests/a.test.js')], [file('README.md'), file('docs/a.md')]]) {
    assert.ok(isLightPullRequest(files));
    assert.deepEqual(fixIds({ pr: bare, files }), []);
  }
  assert.deepEqual(fixIds({ pr: pullRequest({ body: 'see /home/me/x' }), files: [file('docs/guide.md')] }), ['local-path']);
  assert.ok(!isLightPullRequest([file('docs/a.md'), file('skills/a/SKILL.md')]));
  assert.ok(!isLightPullRequest([]));
});

test('missing labels and milestone are maintainer todos and add needs-triage, never contributor fixes', () => {
  const result = checkPullRequest({ pr: pullRequest({ labels: [], milestone: null }), files: shippedFiles });
  assert.deepEqual(result.contributorFixes, []);
  assert.equal(result.maintainerTodos.length, 3);
  assert.deepEqual(result.addLabels, ['needs-triage']);
  const fixed = checkPullRequest({ pr: pullRequest({ labels: ['goal:ai', 'bug', 'needs-triage'] }), files: shippedFiles });
  assert.deepEqual(fixed.removeLabels, ['needs-triage']);
});

test('status:needs-author follows the contributor fixes, except for exempt authors', () => {
  const failing = checkPullRequest({ pr: pullRequest({ body: '' }), files: shippedFiles });
  assert.ok(failing.addLabels.includes('status:needs-author'));
  const passing = checkPullRequest({ pr: pullRequest({ labels: ['goal:ai', 'bug', 'status:needs-author'] }), files: shippedFiles });
  assert.deepEqual(passing.removeLabels, ['status:needs-author']);
  const owner = checkPullRequest({ pr: pullRequest({ body: '', author: 'anxuanng' }), files: shippedFiles });
  assert.ok(owner.contributorFixes.length > 0);
  assert.ok(!owner.addLabels.includes('status:needs-author'));
});

test('a bot author such as Dependabot gets no contributor fixes and no author label', () => {
  const dependabotPullRequest = pullRequest({
    author: 'dependabot[bot]',
    authorAssociation: 'NONE',
    title: 'Bump actions/checkout from 6 to 7',
    body: 'Bumps actions/checkout.',
    labels: [],
    milestone: null,
  });
  const files = [file('src/scene.js')];
  const result = checkPullRequest({ pr: dependabotPullRequest, files });
  assert.deepEqual(result.contributorFixes, []);
  assert.ok(!result.addLabels.includes('status:needs-author'));
  assert.ok(fixIds({ pr: pullRequest({ author: 'someone', body: 'Bumps.', labels: [] }), files }).length > 0);
});

test('owner, members, collaborators and bots are exempt from auto close', () => {
  assert.ok(isAutoCloseExempt({ author: 'anxuanng', authorAssociation: 'NONE' }));
  assert.ok(isAutoCloseExempt({ author: 'AnXuanNg', authorAssociation: 'NONE' }));
  assert.ok(isAutoCloseExempt({ author: 'dependabot[bot]', authorAssociation: 'NONE' }));
  for (const authorAssociation of ['OWNER', 'MEMBER', 'COLLABORATOR']) {
    assert.ok(isAutoCloseExempt({ author: 'x', authorAssociation }));
  }
  assert.ok(!isAutoCloseExempt({ author: 'x', authorAssociation: 'FIRST_TIME_CONTRIBUTOR' }));
});

test('sectionOf reads a section up to the next heading', () => {
  assert.equal(sectionOf('## A\none\n## B\ntwo', 'a').trim(), 'one');
  assert.equal(sectionOf('## A\none', 'missing'), null);
});

const someFix = [{ id: 'x', message: 'Fix x.', docsAnchor: 'link-the-issue' }];

test('the clock starts at the first failure, reminds once 24 hours before the close and closes at 72 hours', () => {
  const start = Date.parse('2026-11-01T00:00:00.000Z');
  const base = { contributorFixes: someFix, exempt: false, draft: false, labels: [] };
  const first = decideActions({ ...base, now: start, previousState: null });
  assert.equal(first.statusState.firstFailedAt, '2026-11-01T00:00:00.000Z');
  assert.ok(!first.remind && !first.close);
  const state = first.statusState;
  const early = decideActions({ ...base, now: start + (REMINDER_AFTER_HOURS - 1) * HOUR_MS, previousState: state });
  assert.ok(!early.remind);
  const reminder = decideActions({ ...base, now: start + REMINDER_AFTER_HOURS * HOUR_MS, previousState: state });
  assert.ok(reminder.remind && !reminder.close);
  assert.equal(reminder.closeDate, '2026-11-04');
  const again = decideActions({ ...base, now: start + (REMINDER_AFTER_HOURS + 2) * HOUR_MS, previousState: reminder.statusState });
  assert.ok(!again.remind);
  const closing = decideActions({ ...base, now: start + CLOSE_AFTER_HOURS * HOUR_MS, previousState: reminder.statusState });
  assert.ok(closing.close);
});

test('exempt authors, drafts and needs-owner-decision are never reminded or closed', () => {
  const previousState = { firstFailedAt: '2026-11-01T00:00:00.000Z' };
  const now = Date.parse('2026-11-10T00:00:00.000Z');
  const base = { contributorFixes: someFix, exempt: false, draft: false, labels: [], previousState, now };
  assert.ok(decideActions(base).close);
  for (const change of [{ exempt: true }, { draft: true }, { labels: ['needs-owner-decision'] }]) {
    const decision = decideActions({ ...base, ...change });
    assert.ok(!decision.close && !decision.remind, JSON.stringify(change));
  }
});

test('a pull request that passes again clears the clock, and a reopened one starts a new clock', () => {
  const previousState = { firstFailedAt: '2026-11-01T00:00:00.000Z', reminderSentAt: '2026-11-03T00:00:00.000Z' };
  const now = Date.parse('2026-11-10T00:00:00.000Z');
  const passing = decideActions({ now, contributorFixes: [], previousState, exempt: false, draft: false, labels: [] });
  assert.deepEqual(passing.statusState, {});
  const reopened = decideActions({ now, contributorFixes: someFix, previousState, exempt: false, draft: false, labels: [], reopened: true });
  assert.equal(reopened.statusState.firstFailedAt, '2026-11-10T00:00:00.000Z');
  assert.ok(!reopened.close);
  assert.equal(decideActions({ now, contributorFixes: [], previousState: null, exempt: false, draft: false, labels: [] }).statusState, null);
});

test('the marker round trips and the comment stays warm and short', () => {
  const marker = buildMarker('pr-metadata-status', { firstFailedAt: '2026-11-01T00:00:00.000Z' });
  assert.deepEqual(parseMarker(marker, 'pr-metadata-status'), { firstFailedAt: '2026-11-01T00:00:00.000Z' });
  assert.equal(parseMarker('no marker', 'pr-metadata-status'), null);
  const comment = renderStatusComment({ contributorFixes: someFix, firstFailedAt: '2026-11-01T00:00:00.000Z', exempt: false });
  assert.match(comment, /^<!-- pr-metadata-status firstFailedAt=2026-11-01T00:00:00.000Z -->/);
  assert.match(comment, /Thank you/);
  assert.match(comment, /CONTRIBUTING\.md#link-the-issue/);
  assert.match(comment, /2026-11-04/);
  assert.match(comment, /first answer within about 7 days/);
});

function fakeGitHub({ pullRequest: pr, files = [], comments = [], events = [] }) {
  const calls = [];
  const record = name => async params => {
    calls.push({ name, params });
    return { data: pr };
  };
  return {
    calls,
    paginate: async method => (method === 'files' ? files : method === 'comments' ? comments : events),
    rest: {
      pulls: { get: record('get'), listFiles: 'files', update: record('closePullRequest') },
      issues: {
        listComments: 'comments',
        listEvents: 'events',
        addLabels: record('addLabels'),
        removeLabel: record('removeLabel'),
        createComment: record('createComment'),
        updateComment: record('updateComment'),
      },
    },
  };
}

function apiPullRequest(overrides = {}) {
  return {
    state: 'open',
    body: '',
    title: 'Add a thing',
    user: { login: 'someone' },
    author_association: 'NONE',
    labels: [],
    milestone: null,
    draft: false,
    ...overrides,
  };
}

test('the runner posts one friendly comment for a new pull request and labels it', async () => {
  const github = fakeGitHub({ pullRequest: apiPullRequest(), files: [{ filename: 'src/scene.js' }] });
  const messages = [];
  const outcome = await checkOnePullRequest({ github, repo: { owner: 'o', repo: 'r' }, number: 5, now: Date.parse('2026-11-01T00:00:00Z'), reopened: false, dryRun: false, log: line => messages.push(line) });
  const names = github.calls.map(call => call.name);
  assert.deepEqual(names.filter(name => name === 'createComment'), ['createComment']);
  assert.ok(names.includes('addLabels'));
  assert.ok(outcome.result.contributorFixes.length >= 3);
  assert.ok(!names.includes('closePullRequest'));
});

test('the runner closes a pull request that stayed unfixed for 72 hours, and never an owner one', async () => {
  const marker = buildMarker('pr-metadata-status', { firstFailedAt: '2026-11-01T00:00:00.000Z' });
  const comments = [{ id: 9, user: { login: 'github-actions[bot]' }, body: `${marker}\nold` }];
  const now = Date.parse('2026-11-09T00:00:00Z');
  const contributor = fakeGitHub({ pullRequest: apiPullRequest(), files: [{ filename: 'src/scene.js' }], comments });
  await checkOnePullRequest({ github: contributor, repo: {}, number: 5, now, reopened: false, dryRun: false, log() {} });
  assert.ok(contributor.calls.some(call => call.name === 'closePullRequest'));
  const owner = fakeGitHub({ pullRequest: apiPullRequest({ user: { login: 'anxuanng' } }), files: [{ filename: 'src/scene.js' }], comments });
  const outcome = await checkOnePullRequest({ github: owner, repo: {}, number: 6, now, reopened: false, dryRun: false, log() {} });
  assert.ok(!owner.calls.some(call => ['closePullRequest', 'createComment', 'updateComment'].includes(call.name)));
  assert.ok(outcome.result.contributorFixes.length > 0);
});

test('a dry run changes nothing and a hold label that was added before is not added again', async () => {
  const dry = fakeGitHub({ pullRequest: apiPullRequest(), files: [{ filename: 'src/lighting.js' }] });
  await checkOnePullRequest({ github: dry, repo: {}, number: 5, now: 0, reopened: false, dryRun: true, log() {} });
  assert.deepEqual(dry.calls.map(call => call.name), ['get']);
  const removedByOwner = fakeGitHub({
    pullRequest: apiPullRequest(),
    files: [{ filename: 'src/lighting.js' }],
    events: [{ event: 'labeled', label: { name: 'hold:look-approval' } }],
  });
  await checkOnePullRequest({ github: removedByOwner, repo: {}, number: 5, now: 0, reopened: false, dryRun: false, log() {} });
  const added = removedByOwner.calls.filter(call => call.name === 'addLabels').flatMap(call => call.params.labels);
  assert.ok(!added.includes('hold:look-approval'));
});

test('the CI gate fails a shipped change without a note and a protected file edit', () => {
  assert.deepEqual(failingGatesFor(['src/a.js']).map(gate => gate.name), ['change note']);
  assert.deepEqual(failingGatesFor(['src/a.js', 'changes/1.md']), []);
  assert.deepEqual(failingGatesFor(['CHANGELOG.md']).map(gate => gate.name), ['protected files']);
  assert.deepEqual(failingGatesFor(['docs/a.md']), []);
});
