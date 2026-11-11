// Runs the pull request gates of the `Test` workflow on this checkout, picked by the files the branch changed, and ends with
// one summary line per check and how to fix each failure. Made for people and coding agents alike: every check runs even
// after one fails, full logs go to artifacts/preflight/, and only the tail of a failing log is printed.
// Usage: npm run preflight                 every check that applies to the changed files
//        npm run preflight -- --skip-tests  skip the unit tests and the coverage gate (the slowest part)
//        npm run preflight -- --json        print the summary as JSON after the logs
//        npm run preflight -- --base <ref>  compare with another ref than origin/main
import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const logFolder = join(root, 'artifacts', 'preflight');
const failingLogTailLines = 30;

// Files a pull request must never edit. Each one is reset by a maintainer at release time.
export const PROTECTED_FILES = Object.freeze({
  'CHANGELOG.md': 'Add a changes/<issue>.md note instead (changes/README.md). Two pull requests that edit CHANGELOG.md conflict.',
  'bench/size/budgets.json': 'Accept a size increase with a changes/<issue>.size.md line instead (bench/size/README.md).',
  'bench/size/baseline.json': 'Accept a size increase with a changes/<issue>.size.md line instead (bench/size/README.md).',
  'bench/tool-cost-budgets.json': 'Accept a tool cost increase with a changes/<issue>.size.md line instead (bench/tool-cost/README.md).',
});

const userFacingPattern = /^(src|bin|packages|skills)\//;
const shippedCodePattern = /^(src|bin|packages)\/|^package(-lock)?\.json$|^vite\.lib\.config\.js$|^scripts\/build-mcp\.mjs$/;
const toolCodePattern = /^(src\/agent-|src\/mcp|bin\/)|^scripts\/(build-mcp|measure-tool-cost|check-tool-cost|mcp-server|mcp-input-errors|capabilities-topics|tool-examples)/;
const linkedTextPattern = /\.(md|html)$/;

// Checks a GPU or a person's eyes must run. CONTRIBUTING.md lists them; these patterns only point out the ones that may apply.
const MANUAL_CHECKS = Object.freeze([
  { pattern: /shader|light|material|environment|shadow|tone|fog|sky/, command: 'npm run reference', reason: 'shaders, lighting or materials' },
  { pattern: /skin|gltf|pose|retarget|skeleton|(^|[-/])ik[-.]/, command: 'npm run smoke:character', reason: 'skinning, glTF, poses or IK' },
  { pattern: /^src\/(agent-|mcp)|^bin\//, command: 'npm run smoke:mcp', reason: 'MCP tools or the preview' },
  { pattern: /^src\/(renderer|frame|render)/, command: 'npm run benchmark:runtime', reason: 'the frame path' },
]);

function isNewChangeNote(path) {
  return path.startsWith('changes/') && path.endsWith('.md') && path !== 'changes/README.md';
}

const RELEASE_SKIP_REASON = 'a release: the version changed, so the notes are folded and the budgets reset (CONTRIBUTING.md#release)';

// True when the package version differs between two package.json texts. A release branch is the only change that bumps it.
export function isVersionBump(basePackageText, headPackageText) {
  if (!basePackageText || !headPackageText) return false;
  return JSON.parse(basePackageText).version !== JSON.parse(headPackageText).version;
}

// Decides which checks apply to a list of changed paths. Pure, so tests can call it without git.
export function planChecks(changedPaths, { skipTests = false, release = false } = {}) {
  const paths = changedPaths.map(path => path.replace(/\\/g, '/'));
  const changesShippedCode = paths.some(path => shippedCodePattern.test(path));
  const changesToolCode = paths.some(path => toolCodePattern.test(path));
  const checks = [];

  const protectedEdits = paths.filter(path => path in PROTECTED_FILES);
  checks.push({
    name: 'protected files',
    kind: 'inline',
    skipped: release ? RELEASE_SKIP_REASON : null,
    failure: !release && protectedEdits.length ? protectedEdits.map(path => `${path}: ${PROTECTED_FILES[path]}`).join('\n') : null,
    fix: 'Revert the edits named above: git checkout origin/main -- <file>',
  });

  const needsNote = !release && paths.some(path => userFacingPattern.test(path));
  const hasNote = paths.some(path => isNewChangeNote(path) && !path.endsWith('.size.md'));
  let noteSkipReason = needsNote ? null : 'no change under src/, bin/, packages/ or skills/';
  if (release) noteSkipReason = RELEASE_SKIP_REASON;
  checks.push({
    name: 'change note',
    kind: 'inline',
    skipped: noteSkipReason,
    failure: needsNote && !hasNote ? 'The branch changes shipped code but adds no changes/<issue>.md.' : null,
    fix: 'Add changes/<issue>.md with one bullet, such as "- `bar` takes a `foo` option (#123)" (changes/README.md).',
  });

  checks.push(linkedTextCheck(paths));
  checks.push({
    name: 'tool schemas',
    command: ['npm', 'run', 'check:tool-schemas'],
    skipped: changesToolCode ? null : 'no MCP tool code changed',
    fix: 'Fix the schema the report names; every client profile must accept it (scripts/check-tool-schemas.mjs).',
  });
  checks.push({
    name: 'size',
    command: ['npm', 'run', 'size'],
    skipped: changesShippedCode ? null : 'no shipped code changed',
    fix: 'Shrink the change, or add "- entry:<name>: <why it is worth the bytes>" to changes/<issue>.size.md (bench/size/README.md).',
  });
  checks.push({
    name: 'tool cost',
    command: ['npm', 'run', 'tool-cost'],
    skipped: changesToolCode ? null : 'no MCP tool code changed',
    fix: 'Move rare detail into scene_capabilities or a shared schema, or add "- tool:<name>: <why>" to changes/<issue>.size.md (bench/tool-cost/README.md).',
  });

  const testSkip = skipTests ? 'skipped with --skip-tests' : null;
  checks.push({
    name: 'build library',
    command: ['npm', 'run', 'build:lib'],
    skipped: testSkip,
    fix: 'Fix the build error in the log; the MCP tests need build/.',
  });
  checks.push({
    name: 'unit tests and coverage',
    command: ['npm', 'run', 'test:coverage', '--', '--test-reporter=dot', '--test-reporter-destination=stdout', '--test-reporter=lcov', '--test-reporter-destination=coverage/lcov.info'],
    skipped: testSkip,
    fix: 'Run the failing file alone with node --test tests/<file>.test.js. Never weaken a test to make it pass.',
  });
  checks.push({
    name: 'coverage gate',
    command: ['npm', 'run', 'coverage:gate', '--', 'coverage'],
    skipped: testSkip,
    dependsOn: 'unit tests and coverage',
    fix: 'Add tests for the new code. coverage-baseline.json may only go up.',
  });
  return checks;
}

function linkedTextCheck(paths) {
  const changesLinkedText = paths.some(path => linkedTextPattern.test(path));
  return {
    name: 'links',
    command: ['npm', 'run', 'check:links'],
    skipped: changesLinkedText ? null : 'no Markdown or HTML changed',
    fix: 'Fix or remove each link the report names.',
  };
}

export function manualChecksFor(changedPaths) {
  const paths = changedPaths.map(path => path.replace(/\\/g, '/'));
  return MANUAL_CHECKS.filter(check => paths.some(path => check.pattern.test(path)));
}

function git(args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}

function changedPathsSince(baseRef) {
  const mergeBase = git(['merge-base', baseRef, 'HEAD']) ?? baseRef;
  const committedAndStaged = git(['diff', '--name-only', mergeBase]) ?? '';
  const untracked = git(['ls-files', '--others', '--exclude-standard']) ?? '';
  const lines = `${committedAndStaged}\n${untracked}`.split('\n').filter(Boolean);
  return [...new Set(lines)].sort();
}

function logPathFor(check) {
  return join(logFolder, `${check.name.replace(/\W+/g, '-')}.log`);
}

function runCommand(check) {
  return new Promise(resolvePromise => {
    const logPath = logPathFor(check);
    const log = createWriteStream(logPath);
    const [program, ...args] = check.command;
    const child = spawn(program, args, { cwd: root, shell: process.platform === 'win32', env: process.env });
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    child.on('close', code => {
      log.end(() => resolvePromise({ code, logPath }));
    });
  });
}

function tailOf(path, lineCount) {
  const lines = readFileSync(path, 'utf8').trimEnd().split(/\r?\n/);
  return lines.slice(-lineCount).join('\n');
}

async function runChecks(checks) {
  const results = [];
  for (const check of checks) {
    const dependency = check.dependsOn && results.find(result => result.name === check.dependsOn);
    if (check.skipped) {
      results.push({ name: check.name, status: 'skip', detail: check.skipped });
    } else if (dependency && dependency.status !== 'ok') {
      results.push({ name: check.name, status: 'skip', detail: `${check.dependsOn} did not pass` });
    } else if (check.kind === 'inline') {
      results.push(check.failure
        ? { name: check.name, status: 'fail', detail: check.failure, fix: check.fix }
        : { name: check.name, status: 'ok' });
    } else {
      process.stdout.write(`… ${check.name}: ${check.command.join(' ')}\n`);
      const startedAt = Date.now();
      const { code, logPath } = await runCommand(check);
      const seconds = Math.round((Date.now() - startedAt) / 1000);
      const log = logPath.slice(root.length).replace(/\\/g, '/');
      if (code === 0) {
        results.push({ name: check.name, status: 'ok', detail: `${seconds} s`, log });
      } else {
        process.stdout.write(`\n--- last ${failingLogTailLines} lines of ${log} ---\n${tailOf(logPath, failingLogTailLines)}\n---\n\n`);
        results.push({ name: check.name, status: 'fail', detail: `exit ${code} after ${seconds} s`, log, fix: check.fix });
      }
    }
  }
  return results;
}

function printSummary(results, manualChecks) {
  const marks = { ok: 'ok  ', fail: 'FAIL', skip: 'skip' };
  console.log('\nPreflight summary');
  for (const result of results) {
    const detail = result.detail ? ` (${result.detail.split('\n')[0]})` : '';
    console.log(`${marks[result.status]} ${result.name}${detail}`);
    if (result.status === 'fail') {
      for (const line of result.detail.split('\n').slice(1)) console.log(`     ${line}`);
      if (result.log) console.log(`     log: ${result.log}`);
      console.log(`     fix: ${result.fix}`);
    }
  }
  if (manualChecks.length) {
    console.log('\nNot run here, may apply (they need a GPU or a person, see CONTRIBUTING.md):');
    for (const check of manualChecks) console.log(`     ${check.command}  for ${check.reason}`);
  }
}

function valueAfter(args, flag) {
  const index = args.indexOf(flag);
  return index < 0 ? null : args[index + 1];
}

async function main(args) {
  const baseRef = valueAfter(args, '--base') ?? 'origin/main';
  if (baseRef === 'origin/main' && git(['fetch', '--quiet', 'origin', 'main']) === null) {
    console.warn('Could not fetch origin/main; comparing with the local copy, which may be stale.');
  }
  if (git(['rev-parse', '--verify', '--quiet', `${baseRef}^{commit}`]) === null) {
    console.error(`The base ref ${baseRef} does not exist. Fetch it, or pass --base <ref>.`);
    process.exit(2);
  }
  mkdirSync(logFolder, { recursive: true });
  mkdirSync(join(root, 'coverage'), { recursive: true });

  const changedPaths = changedPathsSince(baseRef);
  console.log(`${changedPaths.length} files changed since ${baseRef}.`);
  const release = isVersionBump(git(['show', `${baseRef}:package.json`]), readFileSync(join(root, 'package.json'), 'utf8'));
  const checks = planChecks(changedPaths, { skipTests: args.includes('--skip-tests'), release });
  const results = await runChecks(checks);
  const manualChecks = manualChecksFor(changedPaths);
  printSummary(results, manualChecks);
  if (args.includes('--json')) {
    console.log(JSON.stringify({ base: baseRef, results, manualChecks: manualChecks.map(check => check.command) }, null, 2));
  }
  const failed = results.some(result => result.status === 'fail');
  console.log(failed ? '\nPreflight failed. The Test workflow would fail the same way.' : '\nPreflight passed.');
  process.exit(failed ? 1 : 0);
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? '')).href) {
  await main(process.argv.slice(2));
}
