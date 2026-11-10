// Decides whether the automated first pass (.github/workflows/claude-triage.yml) runs for one issue or pull request.
// It runs before the Claude step and holds no Claude secret. The decision is a pure function so tests cover every skip.
import { appendFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const TRIGGERS = Object.freeze({
  issues: ['opened', 'reopened'],
  pull_request_target: ['opened', 'reopened', 'ready_for_review', 'synchronize'],
});
export const MAINTAINER_ASSOCIATIONS = Object.freeze(['OWNER', 'MEMBER', 'COLLABORATOR']);
export const SKIP_LABELS = Object.freeze(['status:in-progress', 'hold:look-approval', 'needs-owner-decision']);

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

export function decideTriage({ eventName, action, item, maintainerActivity = 0 }) {
  const allowedActions = TRIGGERS[eventName];
  if (!allowedActions) return { run: false, reason: `event ${eventName} is not triaged` };
  if (!allowedActions.includes(action)) return { run: false, reason: `action ${action} is not triaged` };
  if (item.draft === true) return { run: false, reason: 'draft pull request' };
  if (isBot(item.user)) return { run: false, reason: 'opened by a bot' };
  if (isMaintainerAssociation(item.author_association)) return { run: false, reason: 'opened by a maintainer' };
  if ((item.assignees ?? []).length > 0) return { run: false, reason: 'assigned to someone' };
  const labelNames = (item.labels ?? []).map(label => label.name);
  const skipLabel = SKIP_LABELS.find(name => labelNames.includes(name));
  if (skipLabel) return { run: false, reason: `carries ${skipLabel}` };
  if (maintainerActivity > 0) return { run: false, reason: 'a maintainer already commented or reviewed' };
  return { run: true, reason: 'new contribution without maintainer activity' };
}

function listApi(path) {
  const output = execFileSync('gh', ['api', '--paginate', '--slurp', path], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  return JSON.parse(output).flat();
}

function main() {
  const payload = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const eventName = process.env.GITHUB_EVENT_NAME;
  const repository = process.env.GITHUB_REPOSITORY;
  const item = payload.pull_request ?? payload.issue;
  const number = item.number;
  const entries = listApi(`repos/${repository}/issues/${number}/comments?per_page=100`);
  if (payload.pull_request) {
    entries.push(...listApi(`repos/${repository}/pulls/${number}/reviews?per_page=100`));
    entries.push(...listApi(`repos/${repository}/pulls/${number}/comments?per_page=100`));
  }
  const decision = decideTriage({ eventName, action: payload.action, item, maintainerActivity: countMaintainerActivity(entries) });
  console.log(`triage ${decision.run ? 'runs' : 'skipped'}: ${decision.reason}`);
  appendFileSync(process.env.GITHUB_OUTPUT, `run=${decision.run}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
