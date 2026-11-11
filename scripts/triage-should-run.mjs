// Decides whether the automated first pass (.github/workflows/claude-triage.yml) runs for one issue or pull request.
// It runs before the Claude step, and again before the comment and label steps, and holds no Claude secret.
// The decision is a pure function so tests cover every skip. main() reads the live state of the item from the API,
// never the event payload alone, so a maintainer who acts while a run is in flight stops the later steps.
import { appendFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { COMMENT_MARKER, BOT_LOGIN } from './triage-post-comment.mjs';
import { loadTriageItem } from './triage-load-item.mjs';

// One run per item: the sticky comment marks an item as done, so reopening or re-marking it never runs again.
export const TRIGGERS = Object.freeze({
  issues: ['opened'],
  pull_request_target: ['opened', 'ready_for_review'],
  // A maintainer's dry run names the item itself, so there is no action to match.
  workflow_dispatch: [],
});
export const MAINTAINER_ASSOCIATIONS = Object.freeze(['OWNER', 'MEMBER', 'COLLABORATOR']);
export const SKIP_LABELS = Object.freeze(['status:in-progress', 'hold:look-approval', 'needs-owner-decision']);
export const MAX_ITEMS_PER_AUTHOR_PER_DAY = 3;
export const MAX_RUNS_PER_DAY = 40;
const WORKFLOW_FILE = 'claude-triage.yml';

export function isMaintainerAssociation(association) {
  return MAINTAINER_ASSOCIATIONS.includes(association);
}

function isBot(user) {
  return user?.type === 'Bot' || String(user?.login ?? '').endsWith('[bot]');
}

// Counts comments and reviews written by a person who maintains the repository. Bot comments, including this
// workflow's own sticky comment, never count, so the bot keeps updating its note until a person steps in.
export function countMaintainerActivity(entries) {
  return entries.filter(entry => isMaintainerAssociation(entry.author_association) && !isBot(entry.user)).length;
}

export function hasStickyComment(entries) {
  return entries.some(entry => entry.user?.login === BOT_LOGIN && String(entry.body ?? '').startsWith(COMMENT_MARKER));
}

export function decideTriage({
  eventName,
  action,
  item,
  senderLogin,
  maintainerActivity = 0,
  alreadyTriaged = false,
  authorItemsToday = 0,
  runsToday = 0,
  enabled = true,
  requireStickyForLaterSteps = false,
}) {
  const isDispatch = eventName === 'workflow_dispatch';
  // A dry run is a maintainer naming one item. It posts and labels nothing, so the pause, ownership and hand-over rules
  // do not apply. Only the daily run limit does, because a dry run still spends the subscription.
  if (isDispatch) {
    if (runsToday > MAX_RUNS_PER_DAY) return { run: false, reason: 'daily run limit reached' };
    return { run: true, reason: 'maintainer dry run' };
  }
  if (!enabled) return { run: false, reason: 'paused by TRIAGE_ENABLED' };
  const allowedActions = TRIGGERS[eventName];
  if (!allowedActions) return { run: false, reason: `event ${eventName} is not triaged` };
  if (!isDispatch && !allowedActions.includes(action)) return { run: false, reason: `action ${action} is not triaged` };
  if (item.state && item.state !== 'open') return { run: false, reason: 'closed or merged' };
  if (item.merged === true) return { run: false, reason: 'closed or merged' };
  if (item.draft === true) return { run: false, reason: 'draft pull request' };
  if (isBot(item.user)) return { run: false, reason: 'opened by a bot' };
  if (isMaintainerAssociation(item.author_association)) return { run: false, reason: 'opened by a maintainer' };
  if (!isDispatch && senderLogin && item.user?.login && senderLogin !== item.user.login) return { run: false, reason: 'someone other than the author triggered it' };
  if ((item.assignees ?? []).length > 0) return { run: false, reason: 'assigned to someone' };
  const labelNames = (item.labels ?? []).map(label => label.name);
  const skipLabel = SKIP_LABELS.find(name => labelNames.includes(name));
  if (skipLabel) return { run: false, reason: `carries ${skipLabel}` };
  if (maintainerActivity > 0) return { run: false, reason: 'a maintainer already commented or reviewed' };
  if (!isDispatch && alreadyTriaged && !requireStickyForLaterSteps) return { run: false, reason: 'already triaged once' };
  if (authorItemsToday > MAX_ITEMS_PER_AUTHOR_PER_DAY) return { run: false, reason: 'author opened too many items today' };
  if (runsToday > MAX_RUNS_PER_DAY) return { run: false, reason: 'daily run limit reached' };
  return { run: true, reason: 'new contribution without maintainer activity' };
}

function callApi(args) {
  return execFileSync('gh', ['api', ...args], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
}

function listApi(path) {
  return JSON.parse(callApi(['--paginate', '--slurp', path])).flat();
}

function sinceYesterday() {
  return new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().replace(/\.\d+Z$/, 'Z');
}

// A failed count blocks the run: the limits fail closed.
function countOrBlock(path, query) {
  try {
    return Number(callApi([path, ...query, '--jq', '.total_count']).trim());
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function main() {
  const payload = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const eventName = process.env.GITHUB_EVENT_NAME;
  const repository = process.env.GITHUB_REPOSITORY;
  const stage = process.env.TRIAGE_STAGE ?? 'before';
  const { number, item, isPullRequest } = loadTriageItem(payload, repository);
  const entries = listApi(`repos/${repository}/issues/${number}/comments?per_page=100`);
  if (isPullRequest) {
    entries.push(...listApi(`repos/${repository}/pulls/${number}/reviews?per_page=100`));
    entries.push(...listApi(`repos/${repository}/pulls/${number}/comments?per_page=100`));
  }
  const since = sinceYesterday();
  const authorItemsToday = countOrBlock('search/issues', ['-X', 'GET', '-f', `q=repo:${repository} author:${item.user?.login} created:>=${since}`]);
  const runsToday = countOrBlock(`repos/${repository}/actions/workflows/${WORKFLOW_FILE}/runs`, ['-X', 'GET', '-f', `created=>=${since}`, '-f', 'per_page=1']);
  const decision = decideTriage({
    eventName,
    action: payload.action,
    item,
    senderLogin: payload.sender?.login,
    maintainerActivity: countMaintainerActivity(entries),
    alreadyTriaged: hasStickyComment(entries),
    authorItemsToday,
    runsToday,
    enabled: process.env.TRIAGE_ENABLED !== 'false',
    requireStickyForLaterSteps: stage === 'after',
  });
  console.log(`triage ${stage}: ${decision.run ? 'runs' : 'skipped'}: ${decision.reason}`);
  appendFileSync(process.env.GITHUB_OUTPUT, `run=${decision.run}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
