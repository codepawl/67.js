// Posts Claude's first-pass note as one sticky comment. Claude has no write tool: it returns text, and this step,
// which holds no Claude secret, cleans the text and posts or updates the single comment carrying a hidden marker.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const COMMENT_MARKER = '<!-- claude-triage -->';
export const BOT_LOGIN = 'github-actions[bot]';
export const MAX_COMMENT_LENGTH = 6000;
const FOOTER = '_Automated first pass by Claude. It can be wrong. A maintainer will pick this up, and this note stops updating then._';

const SECRET_PATTERNS = [
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /sk-ant-[A-Za-z0-9_-]{10,}/g,
  /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/g,
];

// Removes what a stranger could use through Claude's text: pings, hidden HTML, remote images and token-shaped strings.
export function sanitizeComment(text) {
  let clean = String(text ?? '');
  for (const pattern of SECRET_PATTERNS) clean = clean.replace(pattern, '[redacted]');
  clean = clean.replace(/<!--[\s\S]*?-->/g, '');
  clean = clean.replace(/!\[[^\]]*\]\([^)]*\)/g, '');
  clean = clean.replace(/<[^>\n]+>/g, '');
  clean = clean.replace(/@(?=[A-Za-z0-9])/g, '@​');
  clean = clean.trim();
  if (clean.length > MAX_COMMENT_LENGTH) clean = `${clean.slice(0, MAX_COMMENT_LENGTH)}\n\n(shortened)`;
  return clean;
}

export function buildCommentBody(text) {
  return `${COMMENT_MARKER}\n${sanitizeComment(text)}\n\n${FOOTER}`;
}

// Only a comment the Actions bot wrote counts as ours, so nobody can hijack the update by copying the marker.
export function findStickyCommentId(comments) {
  const own = comments.find(comment => comment.user?.login === BOT_LOGIN && String(comment.body).startsWith(COMMENT_MARKER));
  return own ? own.id : null;
}

function callApi(args, input) {
  return execFileSync('gh', ['api', ...args], { encoding: 'utf8', input, maxBuffer: 32 * 1024 * 1024 });
}

function main() {
  const payload = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const number = (payload.pull_request ?? payload.issue).number;
  const repository = process.env.GITHUB_REPOSITORY;
  let comment;
  try {
    comment = JSON.parse(process.env.TRIAGE_OUTPUT).comment;
  } catch {
    console.log('no readable comment in the triage output; nothing to post');
    return;
  }
  if (typeof comment !== 'string' || comment.trim() === '') {
    console.log('empty comment; nothing to post');
    return;
  }
  const body = JSON.stringify({ body: buildCommentBody(comment) });
  const existing = JSON.parse(callApi(['--paginate', '--slurp', `repos/${repository}/issues/${number}/comments?per_page=100`])).flat();
  const stickyId = findStickyCommentId(existing);
  if (stickyId) callApi(['--method', 'PATCH', `repos/${repository}/issues/comments/${stickyId}`, '--input', '-'], body);
  else callApi(['--method', 'POST', `repos/${repository}/issues/${number}/comments`, '--input', '-'], body);
  console.log(stickyId ? 'updated the sticky comment' : 'posted the sticky comment');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
