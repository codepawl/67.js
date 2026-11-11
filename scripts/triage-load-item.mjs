// Finds the issue or pull request a triage run is about. On a normal event it is in the payload. On a maintainer's
// manual dry run (workflow_dispatch) only a number is given, so it is read from the API.
import { execFileSync } from 'node:child_process';

export function isDryRun(eventName = process.env.GITHUB_EVENT_NAME) {
  return eventName === 'workflow_dispatch';
}

export function parseDispatchNumber(value) {
  const text = String(value ?? '').trim();
  if (!/^[1-9][0-9]{0,8}$/.test(text)) {
    throw new Error(`The dispatch input "number" must be an issue or pull request number such as 123, got "${text}".`);
  }
  return Number(text);
}

function callApi(args) {
  return JSON.parse(execFileSync('gh', ['api', ...args], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }));
}

// Returns { number, item, isPullRequest }. item is the pulls API object for a pull request, else the issues object.
export function loadTriageItem(payload, repository, fetchJson = callApi) {
  if (payload.inputs && !payload.pull_request && !payload.issue) {
    const number = parseDispatchNumber(payload.inputs.number);
    const issue = fetchJson([`repos/${repository}/issues/${number}`]);
    const isPullRequest = Boolean(issue.pull_request);
    const item = isPullRequest ? fetchJson([`repos/${repository}/pulls/${number}`]) : issue;
    return { number, item, isPullRequest };
  }
  const number = (payload.pull_request ?? payload.issue).number;
  const item = payload.pull_request ? fetchJson([`repos/${repository}/pulls/${number}`]) : fetchJson([`repos/${repository}/issues/${number}`]);
  return { number, item, isPullRequest: Boolean(payload.pull_request) };
}
