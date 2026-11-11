// Checks the description and the files of a pull request against CONTRIBUTING.md. Pure: it reads no network and no disk,
// so tests call it with plain objects. The `PR metadata` workflow (.github/workflows/pr-metadata.yml) runs it on the base branch.
//
// Input:  { pr: { body, title, author, authorAssociation, labels, milestone, draft }, files: [{ filename, additions, deletions }] }
// Output: { contributorFixes: [{ id, message, docsAnchor }], maintainerTodos: [string], addLabels: [string], removeLabels: [string] }
//
// A contributor fix is something the author can change. Labels and the milestone are the maintainer's job, so a gap there
// becomes a maintainer todo and the `needs-triage` label, and never counts against the author.

export const LOOK_HOLD_LABEL = 'hold:look-approval';
export const NEEDS_TRIAGE_LABEL = 'needs-triage';
export const NEEDS_AUTHOR_LABEL = 'status:needs-author';
export const NEEDS_OWNER_DECISION_LABEL = 'needs-owner-decision';

const OWNER_LOGIN = 'anxuanng';
const TRUSTED_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

const shippedPathPattern = /^(src|bin|packages|skills)\//;
// Only skills and the file that defines the MCP tool schemas need a bench table. Detail text in src/agent-scene-capabilities.js
// is not a schema, and the tool cost gate already covers schema growth.
const toolOrSkillPathPattern = /^(skills\/|scripts\/mcp-server\.mjs$)/;
const lightPathPattern = /^(docs\/|\.github\/|tests\/|changes\/)|\.md$/;
// A look change touches shaders, lighting, materials, the default render or a post step. A name part must stand alone, so
// "flight" and "highlight" do not match "light".
const lookNamePattern = /(^|[-_/.])(shaders?|glsl|lights?|lighting|materials?|environment|shadows?|tone|tonemap|fog|sky|post|bloom|ssao|taa|exposure)(?=$|[-_/.])/i;
const lookRootPattern = /^(src|packages)\//;

const linkedIssuePattern = /\b(?:closes|close|closed|fixes|fix|fixed|resolves|resolve|resolved|part of)\s+(?:#\d+|https:\/\/github\.com\/codepawl\/67\.js\/issues\/\d+)/i;
const localPathPatterns = [
  /[A-Za-z]:\\+(?:Users|Documents and Settings)\\/i,
  /(?:^|[\s`"'(=])\/home\/[A-Za-z0-9._-]+/,
  /(?:^|[\s`"'(=])\/Users\/[A-Za-z0-9._-]+/,
];
const imagePattern = /!\[[^\]]*\]\([^)]+\)|<img\b|github\.com\/user-attachments\//i;
// Accepts the natural ways to say "I cannot run the bench": no login, no access, cannot run it, a maintainer runs it.
const benchOptOutPattern = /(?:\bno|\bwithout|not have|n't have|\bcannot|can't|can not|\bunable to)\b[^.\n]*\b(?:claude code|bench)\b|\bmaintainers?\b[^.\n]*\b(?:run|runs|running)\b[^.\n]*\bbench|\bbench\b[^.\n]*\bmaintainers?\b[^.\n]*\brun/i;
// A body that says the tool schemas did not change needs no bench table.
const schemasUnchangedPattern = /\bschemas?\b[^.\n]*\b(?:unchanged|not changed|did not change|do not change|don't change|are the same|stay the same)\b|\bno (?:tool )?schema changes?\b|\bunchanged\b[^.\n]*\bschemas?\b/i;
const checkedHeadings = ['How I checked it', 'Ran', 'Checks', 'Checked', 'Tests', 'Verification', 'How I tested it'];
const fencedBlockPattern = /```/;
const commandLinePattern = /^\s*(?:[$>]\s*)?(?:npm|node|npx)\s+\S/m;

// One pass can leave a new comment behind: '<!<!-- x -->-- y -->' becomes '<!-- y -->'. Repeat until nothing changes.
function stripHtmlComments(text) {
  let previous;
  let current = text;
  do {
    previous = current;
    current = previous.replace(/<!--[\s\S]*?-->/g, '');
  } while (current !== previous);
  return current;
}

// The text under "## <heading>" up to the next "## " heading, or null when the section is missing.
export function sectionOf(body, heading) {
  const lines = stripHtmlComments(body).split(/\r?\n/);
  const wanted = heading.toLowerCase();
  const start = lines.findIndex(line => /^##\s+/.test(line) && line.replace(/^##\s+/, '').trim().toLowerCase() === wanted);
  if (start === -1) return null;
  const collected = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^##\s+/.test(lines[index])) break;
    collected.push(lines[index]);
  }
  return collected.join('\n');
}

function hasContent(sectionText) {
  if (sectionText === null) return false;
  const meaningful = sectionText
    .split('\n')
    .filter(line => !/^\s*[-*]\s+\[ \]/.test(line))
    .join('\n')
    .trim();
  return meaningful.length >= 10;
}

// The checks are described when a section under an equivalent heading has content, or the body shows a fenced block or a command line.
function describesChecks(body, visibleBody) {
  if (checkedHeadings.some(heading => hasContent(sectionOf(body, heading)))) return true;
  return fencedBlockPattern.test(visibleBody) || commandLinePattern.test(visibleBody);
}

function normalizePath(path) {
  return path.replace(/\\/g, '/');
}

export function isLookPath(path) {
  const normalized = normalizePath(path);
  return lookRootPattern.test(normalized) && lookNamePattern.test(normalized);
}

// Docs, CI and test only pull requests skip every rule except the local path one.
export function isLightPullRequest(files) {
  return files.length > 0 && files.every(file => {
    const path = normalizePath(file.filename);
    return !shippedPathPattern.test(path) && lightPathPattern.test(path);
  });
}

// Dependabot and other GitHub App accounts cannot fill in a description template, so they get no contributor fixes.
export function isBotAuthor(pr) {
  return (pr.author ?? '').toLowerCase().endsWith('[bot]');
}

// Owner, maintainers, collaborators and bots are never closed by the bot.
export function isAutoCloseExempt(pr) {
  const author = (pr.author ?? '').toLowerCase();
  return author === OWNER_LOGIN
    || isBotAuthor(pr)
    || TRUSTED_ASSOCIATIONS.has(pr.authorAssociation ?? '');
}

function fix(id, message, docsAnchor) {
  return { id, message, docsAnchor };
}

function contributorFixesFor(pr, files, light) {
  const body = pr.body ?? '';
  const visibleBody = stripHtmlComments(body);
  const fixes = [];

  if (localPathPatterns.some(pattern => pattern.test(body))) {
    fixes.push(fix(
      'local-path',
      'The description has a path from your computer. Issues and pull requests are public, so swap it for a path inside the repository, or remove it.',
      'keep-private-data-out',
    ));
  }
  if (light) return fixes;

  if (!linkedIssuePattern.test(visibleBody)) {
    fixes.push(fix(
      'missing-issue-link',
      'Add `Closes #123` to the description. Use `Part of #123` instead when this pull request is one step of a larger issue.',
      'link-the-issue',
    ));
  }
  if (!describesChecks(body, visibleBody)) {
    fixes.push(fix(
      'empty-how-checked',
      'Under **How I checked it** (or **Ran**), paste the commands you ran and what they printed, such as `npm run preflight` and its last lines.',
      'describe-how-you-checked-it',
    ));
  }

  const paths = files.map(file => normalizePath(file.filename));
  const needsNote = paths.some(path => shippedPathPattern.test(path));
  const hasNote = paths.some(path => /^changes\/\d+[^/]*\.md$/.test(path) && !path.endsWith('.size.md'));
  if (needsNote && !hasNote) {
    fixes.push(fix(
      'missing-change-note',
      'Add a file named `changes/<issue>.md` with one changelog bullet, such as ``- `bar` takes a `foo` option (#123)``.',
      'change-notes',
    ));
  }

  const touchesToolOrSkill = paths.some(path => toolOrSkillPathPattern.test(path));
  const hasBenchTable = /^\s*\|\s*:?-{3,}/m.test(visibleBody) && /bench|haiku|sonnet/i.test(visibleBody);
  const benchOptOut = benchOptOutPattern.test(visibleBody) || schemasUnchangedPattern.test(visibleBody);
  if (touchesToolOrSkill && !hasBenchTable && !benchOptOut) {
    fixes.push(fix(
      'missing-bench-table',
      'This changes an MCP tool or a skill, so paste the agent bench table in the description. Without a Claude Code login, write "I have no Claude Code login; a maintainer runs the bench." and a maintainer will run it. If the tool schemas did not change, write "The tool schemas are unchanged."',
      'tool-schema-and-skill-changes',
    ));
  }

  const touchesLook = paths.some(isLookPath);
  if (touchesLook && !imagePattern.test(body)) {
    fixes.push(fix(
      'look-without-image',
      'This changes how a scene looks, so add a before and an after picture to the description.',
      'look-changes',
    ));
  }
  return fixes;
}

function maintainerTodosFor(pr, files, contributorFixes) {
  const labels = pr.labels ?? [];
  const todos = [];
  if (!labels.some(label => label.startsWith('goal:'))) todos.push('Set a goal label (goal:capable, goal:light or goal:ai).');
  if (!labels.some(label => ['bug', 'enhancement', 'documentation'].includes(label))) todos.push('Set a type label (bug, enhancement or documentation).');
  if (!pr.milestone) todos.push('Set a milestone.');
  const paths = files.map(file => normalizePath(file.filename));
  if (paths.some(isLookPath)) todos.push('Look change: only the owner removes hold:look-approval after seeing the pictures.');
  const needsToolBench = paths.some(path => toolOrSkillPathPattern.test(path));
  if (needsToolBench && contributorFixes.length === 0 && benchOptOutPattern.test(pr.body ?? '')) {
    todos.push('Run the agent bench for this pull request (bench/agent-modeling).');
  }
  return todos;
}

export function checkPullRequest({ pr, files }) {
  const labels = pr.labels ?? [];
  const light = isLightPullRequest(files);
  const contributorFixes = isBotAuthor(pr) ? [] : contributorFixesFor(pr, files, light);
  const maintainerTodos = maintainerTodosFor(pr, files, contributorFixes);
  const addLabels = [];
  const removeLabels = [];

  const classificationMissing = maintainerTodos.some(todo => /^Set a/.test(todo));
  if (classificationMissing && !labels.includes(NEEDS_TRIAGE_LABEL)) addLabels.push(NEEDS_TRIAGE_LABEL);
  if (!classificationMissing && labels.includes(NEEDS_TRIAGE_LABEL)) removeLabels.push(NEEDS_TRIAGE_LABEL);

  if (files.some(file => isLookPath(file.filename)) && !labels.includes(LOOK_HOLD_LABEL)) addLabels.push(LOOK_HOLD_LABEL);

  if (!isAutoCloseExempt(pr)) {
    if (contributorFixes.length > 0 && !labels.includes(NEEDS_AUTHOR_LABEL)) addLabels.push(NEEDS_AUTHOR_LABEL);
    if (contributorFixes.length === 0 && labels.includes(NEEDS_AUTHOR_LABEL)) removeLabels.push(NEEDS_AUTHOR_LABEL);
  }
  return { contributorFixes, maintainerTodos, addLabels, removeLabels };
}
