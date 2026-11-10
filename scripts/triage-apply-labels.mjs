// Applies the labels Claude suggested during the automated first pass, and only those on a fixed allowlist.
// This step has no Claude secret and can add labels only: it never removes one, closes anything or edits text.
// No label here acts as a stop signal or a gate (hold:*, status:*), so a hijacked Claude cannot park an item.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const LABEL_ALLOWLIST = Object.freeze([
  'needs-triage',
  'bug',
  'enhancement',
  'documentation',
  'goal:capable',
  'goal:light',
  'goal:ai',
]);
const GOAL_LABELS = LABEL_ALLOWLIST.filter(name => name.startsWith('goal:'));

// Returns the labels to add: allowlisted, not on the item yet, once each, and at most one goal label.
export function filterLabels(suggested, existing = []) {
  if (!Array.isArray(suggested)) return [];
  const accepted = [];
  for (const name of suggested) {
    if (typeof name !== 'string') continue;
    if (!LABEL_ALLOWLIST.includes(name)) continue;
    if (existing.includes(name) || accepted.includes(name)) continue;
    if (GOAL_LABELS.includes(name) && [...existing, ...accepted].some(other => GOAL_LABELS.includes(other))) continue;
    accepted.push(name);
  }
  return accepted;
}

function main() {
  const payload = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const item = payload.pull_request ?? payload.issue;
  let suggested = [];
  try {
    suggested = JSON.parse(process.env.TRIAGE_OUTPUT).labels;
  } catch {
    console.log('no readable labels in the triage output; nothing to add');
    return;
  }
  const toAdd = filterLabels(suggested, item.labels.map(label => label.name));
  if (toAdd.length === 0) {
    console.log('no labels to add');
    return;
  }
  const body = JSON.stringify({ labels: toAdd });
  execFileSync('gh', ['api', '--method', 'POST', `repos/${process.env.GITHUB_REPOSITORY}/issues/${item.number}/labels`, '--input', '-'], { input: body });
  console.log(`added labels: ${toAdd.join(', ')}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
