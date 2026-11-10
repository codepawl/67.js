// Posts Claude's first-pass note as one sticky comment. Claude has no write tool: it returns text, and this step,
// which holds no Claude secret in its prompt path, cleans the text and posts or updates the single comment carrying a
// hidden marker.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const COMMENT_MARKER = '<!-- claude-triage -->';
export const BOT_LOGIN = 'github-actions[bot]';
export const MAX_COMMENT_LENGTH = 6000;
const HEADER = '**Automated first pass. This is not a review, an approval or a security clearance.**';
const FOOTER = '_Automated first pass by Claude. It can be wrong. A maintainer will pick this up, and this note stops updating then._';
const WITHHELD_NOTE = 'The automated note was withheld because it contained text that looked like a credential. A maintainer will look at this item.';

const SECRET_PATTERNS = [
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /sk-ant-[A-Za-z0-9_-]{10,}/g,
  /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/g,
];

// Links the note may keep: this repository on GitHub and the project site. Everything else becomes inert text.
const ALLOWED_URL = /^https:\/\/(github\.com\/codepawl\/67\.js|67js\.codepawl\.com)([/?#][^\s)]*)?$/i;
const MAX_CLEAN_PASSES = 6;

function isAllowedUrl(url) {
  return ALLOWED_URL.test(String(url).trim());
}

// One pass of cleaning. Tags go first so that splitting a token or an image with a tag cannot survive: the secret
// patterns and the image rules see the text a reader sees. sanitizeComment repeats this until the text stops changing.
function cleanOnce(text) {
  let clean = text;
  clean = clean.replace(/<!--[\s\S]*?-->/g, '');
  clean = clean.replace(/<[^>\n]*>/g, '');
  clean = clean.replace(/[​-‏⁠﻿]/g, '');
  for (const pattern of SECRET_PATTERNS) clean = clean.replace(pattern, '[redacted]');
  clean = clean.replace(/!\[[^\]]*\]\([^)]*\)/g, '');
  clean = clean.replace(/!\[[^\]]*\]\[[^\]]*\]/g, '');
  clean = clean.replace(/^[ \t]*\[[^\]]+\]:[ \t]*\S.*$/gm, '');
  clean = clean.replace(/\[([^\]]*)\]\(([^)]*)\)/g, (whole, label, url) => (isAllowedUrl(url) ? whole : label));
  clean = clean.replace(/\[([^\]]*)\]\[[^\]]*\]/g, '$1');
  clean = clean.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s)>\]]+/gi, url => (isAllowedUrl(url) ? url : '[link removed]'));
  clean = clean.replace(/\bwww\.[^\s)>\]]+/gi, '[link removed]');
  clean = clean.replace(/\b[\w.+-]+@[\w-]+(\.[\w-]+)+\b/g, '[address removed]');
  clean = clean.replace(/(^|[^\w`/])([\w.-]+\/[\w.-]+#\d+)/g, '$1`$2`');
  clean = clean.replace(/@(?=[A-Za-z0-9])/g, '@​');
  return clean;
}

function squash(text) {
  return String(text).replace(/[^A-Za-z0-9+/=_-]/g, '');
}

function secretForms(secret) {
  const value = String(secret ?? '').trim();
  if (value.length < 8) return [];
  const forms = [value, Buffer.from(value).toString('base64'), Buffer.from(value).toString('hex')];
  return forms.map(form => squash(form).toLowerCase()).filter(form => form.length >= 8);
}

// True when the text holds one of the real secret values, also split by spaces, tags or line breaks, or encoded.
export function containsSecretValue(text, secrets = []) {
  const withoutTags = String(text).replace(/<[^>\n]*>/g, '');
  const haystack = squash(withoutTags).toLowerCase();
  return secrets.some(secret => secretForms(secret).some(form => haystack.includes(form)));
}

// Removes what a stranger could use through Claude's text: pings, hidden HTML, remote images, links outside the
// project, cross-repository references and token-shaped strings. Returns '' when a real secret value shows up.
export function sanitizeComment(text, secrets = []) {
  let clean = String(text ?? '');
  for (let pass = 0; pass < MAX_CLEAN_PASSES; pass += 1) {
    const next = cleanOnce(clean);
    if (next === clean) break;
    clean = next;
  }
  clean = clean.trim();
  if (containsSecretValue(String(text ?? ''), secrets) || containsSecretValue(clean, secrets)) return '';
  if (clean.length > MAX_COMMENT_LENGTH) clean = `${clean.slice(0, MAX_COMMENT_LENGTH)}\n\n(shortened)`;
  return clean;
}

// The model's words are quoted under a fixed header the script writes, so they cannot pose as the bot's own verdict.
export function buildCommentBody(text, secrets = []) {
  const clean = sanitizeComment(text, secrets);
  const quoted = clean === '' ? WITHHELD_NOTE : clean.split('\n').map(line => `> ${line}`).join('\n');
  return `${COMMENT_MARKER}\n${HEADER}\n\n${quoted}\n\n${FOOTER}`;
}

// Only a comment the Actions bot wrote counts as ours, so nobody can hijack the update by copying the marker.
export function findStickyCommentId(comments) {
  const own = comments.find(comment => comment.user?.login === BOT_LOGIN && String(comment.body).startsWith(COMMENT_MARKER));
  return own ? own.id : null;
}

function callApi(args, input) {
  return execFileSync('gh', ['api', ...args], { encoding: 'utf8', input, maxBuffer: 32 * 1024 * 1024 });
}

function secretValues() {
  return [process.env.CLAUDE_CODE_OAUTH_TOKEN, process.env.GH_TOKEN].filter(Boolean);
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
  const body = JSON.stringify({ body: buildCommentBody(comment, secretValues()) });
  const existing = JSON.parse(callApi(['--paginate', '--slurp', `repos/${repository}/issues/${number}/comments?per_page=100`])).flat();
  const stickyId = findStickyCommentId(existing);
  if (stickyId) callApi(['--method', 'PATCH', `repos/${repository}/issues/comments/${stickyId}`, '--input', '-'], body);
  else callApi(['--method', 'POST', `repos/${repository}/issues/${number}/comments`, '--input', '-'], body);
  console.log(stickyId ? 'updated the sticky comment' : 'posted the sticky comment');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
