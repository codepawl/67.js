// A coding task with no MCP: the agent has `llms.txt` and the installed npm package, and must write a script that
// renders a scene to a PNG. This measures the path a coding agent takes when it reads the docs instead of calling tools.
// node bench/agent-modeling/llms-only.mjs --claude <claude executable> [--model sonnet] [--runs 2] [--budget 1.5] [--timeout 900] [--label llms-only]
// node bench/agent-modeling/llms-only.mjs --agent agy --agy <agy executable> --model gemini-3.8-flash-medium [--runs 2]
// --agent agy drives the Antigravity CLI (Google and other non-Anthropic models). It cannot switch off its web tools,
// so a run that calls one is recorded with usedWeb and fails the task.
// Each attempt gets a fresh folder with the package installed from a packed archive, a copy of public/llms.txt and
// nothing else. The check opens scene.png and requires a real image with content (png-check.mjs).
import { spawn, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { removeLocalPaths, totalsByModel } from './aggregate.mjs';
import { checkPng } from './png-check.mjs';

const repository = resolve(import.meta.dirname, '../..');
const TASK_ID = 'llms-only-png';
const BUILT_IN_TOOLS_DENIED = ['WebFetch', 'WebSearch', 'Agent', 'Task', 'NotebookEdit'];
const PROMPT = `Write a Node.js script named render.mjs in the current folder that renders a 3D scene to a PNG file named scene.png, 512 by 512 pixels, and run it.
The scene: a red sphere resting on a grey ground plane, seen from a three-quarter view above.
The 67js package is installed in node_modules. This folder also holds llms.txt, the map of its documentation. You have no internet access and no MCP tools, so use only llms.txt and the files in node_modules.
Google Chrome is installed. When scene.png exists, reply with one line saying so.`;

const { values: options } = parseArgs({
  options: {
    agent: { type: 'string', default: 'claude' },
    claude: { type: 'string', default: process.env.CLAUDE_EXECUTABLE ?? 'claude' },
    agy: { type: 'string', default: process.env.AGY_EXECUTABLE ?? 'agy' },
    model: { type: 'string', default: 'sonnet' },
    runs: { type: 'string', default: '2' },
    budget: { type: 'string', default: '1.5' },
    timeout: { type: 'string', default: '900' },
    label: { type: 'string', default: 'llms-only' },
  },
});

const runName = `${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}-${options.model}-${options.label}`;
const rawDirectory = join(repository, 'artifacts', 'agent-modeling', runName);
const resultsDirectory = join(repository, 'bench', 'agent-modeling', 'results');
const npmExecutable = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function packArchive(destination) {
  // The pack runs with --ignore-scripts, so prepack never builds: without build/ the archive has no library
  // and the agent cannot import anything (found in the first valid agy run, 2026-11-07).
  if (!existsSync(join(repository, 'build', '67.module.js'))) throw new Error('build/67.module.js is missing; run npm run build:lib first');
  const output = execFileSync(npmExecutable, ['pack', '--ignore-scripts', '--json', '--pack-destination', destination], { cwd: repository, encoding: 'utf8', shell: process.platform === 'win32' });
  const packed = JSON.parse(output);
  return join(destination, (Array.isArray(packed) ? packed[0] : Object.values(packed)[0]).filename);
}

const AGY_WEB_TOOLS = new Set(['search_web', 'read_url_content', 'open_browser_url', 'read_browser_page']);

function claudeArguments() {
  return [
    '-p', PROMPT,
    '--model', options.model,
    '--output-format', 'stream-json', '--verbose',
    '--strict-mcp-config',
    '--allowedTools', 'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep',
    '--disallowedTools', ...BUILT_IN_TOOLS_DENIED,
    '--permission-mode', 'dontAsk',
    '--setting-sources', 'project',
    '--no-session-persistence',
    '--max-budget-usd', options.budget,
  ];
}

// Headless agy auto-denies shell commands, so each run gets a session-only settings file with one allow rule.
// --settings is never saved to agy's own config, and the run's own folder is the working directory.
function agyArguments(settingsPath) {
  return [
    '-p', PROMPT,
    '--model', options.model,
    '--settings', settingsPath,
    '--output-format', 'stream-json',
    '--print-timeout', `${options.timeout}s`,
  ];
}

function runAgent(workingDirectory, settingsPath) {
  const executable = options.agent === 'agy' ? options.agy : options.claude;
  const argumentsList = options.agent === 'agy' ? agyArguments(settingsPath) : claudeArguments();
  return new Promise(resolvePromise => {
    const started = performance.now();
    const child = spawn(executable, argumentsList, { cwd: workingDirectory, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let errors = '';
    child.stdout.on('data', chunk => {
      output += chunk;
    });
    child.stderr.on('data', chunk => {
      errors += chunk;
    });
    const timer = setTimeout(() => child.kill(), Number(options.timeout) * 1000);
    child.on('close', code => {
      clearTimeout(timer);
      resolvePromise({ output, errors, code, wallMs: Math.round(performance.now() - started) });
    });
  });
}

// The Antigravity CLI writes init, step_update and result events; its tool steps carry tool_name.
function readAgyTranscript(output) {
  const summary = { model: null, toolCalls: 0, toolErrors: 0, toolsByName: {}, result: null, usedWeb: false };
  for (const line of output.split('\n')) {
    if (!line.trim().startsWith('{')) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.event === 'init') summary.model = event.init?.model ?? null;
    const step = event.step_update;
    if (step?.step_type === 'tool' && step.state === 'DONE') {
      summary.toolCalls++;
      summary.toolsByName[step.tool_name] = (summary.toolsByName[step.tool_name] ?? 0) + 1;
      if (AGY_WEB_TOOLS.has(step.tool_name)) summary.usedWeb = true;
    }
    if (step?.step_type === 'tool' && step.state === 'ERROR') summary.toolErrors++;
    if (event.event === 'result') {
      const usage = event.result?.usage ?? {};
      summary.result = {
        num_turns: event.result?.num_turns ?? null,
        total_cost_usd: null,
        subtype: event.result?.status ?? 'no result',
        usage: { input_tokens: usage.input_tokens ?? 0, output_tokens: (usage.output_tokens ?? 0) + (usage.thinking_tokens ?? 0) },
      };
    }
  }
  return summary;
}

function readTranscript(output) {
  const summary = { model: null, toolCalls: 0, toolErrors: 0, toolsByName: {}, result: null };
  for (const line of output.split('\n')) {
    if (!line.trim().startsWith('{')) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === 'system' && event.subtype === 'init') summary.model = event.model;
    if (event.type === 'assistant') {
      for (const block of event.message?.content ?? []) {
        if (block.type !== 'tool_use') continue;
        summary.toolCalls++;
        summary.toolsByName[block.name] = (summary.toolsByName[block.name] ?? 0) + 1;
      }
    }
    if (event.type === 'user') {
      for (const block of event.message?.content ?? []) {
        if (block.type === 'tool_result' && block.is_error) summary.toolErrors++;
      }
    }
    if (event.type === 'result') summary.result = event;
  }
  return summary;
}

async function removeFolder(folder) {
  try {
    await rm(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  } catch (error) {
    console.warn(`Left a temporary folder behind: ${error.code}`);
  }
}

async function runAttempt(archivePath, attempt) {
  const workingDirectory = await mkdtemp(join(tmpdir(), '67js-llms-only-'));
  try {
    await writeFile(join(workingDirectory, 'package.json'), JSON.stringify({ name: 'llms-only-task', private: true, type: 'module' }));
    execFileSync(npmExecutable, ['install', archivePath, '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: workingDirectory, stdio: 'ignore', shell: process.platform === 'win32' });
    await copyFile(join(repository, 'public', 'llms.txt'), join(workingDirectory, 'llms.txt'));
    const settingsPath = `${workingDirectory}-agy-settings.json`;
    await writeFile(settingsPath, JSON.stringify({ permissions: { allow: ['command(*)'] } }));
    const run = await runAgent(workingDirectory, settingsPath).finally(() => rm(settingsPath, { force: true }));
    const transcript = options.agent === 'agy' ? readAgyTranscript(run.output) : readTranscript(run.output);
    const pngGrade = await checkPng(join(workingDirectory, 'scene.png'));
    const grade = transcript.usedWeb ? { pass: false, detail: `used a web tool; ${pngGrade.detail}` } : pngGrade;
    await writeFile(join(rawDirectory, `${TASK_ID}-${attempt}.jsonl`), run.output);
    const filesWritten = (await readdir(workingDirectory)).filter(name => !['node_modules', 'package-lock.json'].includes(name));
    const usage = transcript.result?.usage ?? {};
    return {
      task: TASK_ID,
      attempt,
      pass: grade.pass,
      detail: removeLocalPaths(grade.detail),
      filesWritten,
      model: transcript.model,
      agent: options.agent,
      usedWeb: transcript.usedWeb ?? false,
      toolCalls: transcript.toolCalls,
      toolErrors: transcript.toolErrors,
      toolsByName: transcript.toolsByName,
      turns: transcript.result?.num_turns ?? null,
      costUsd: transcript.result?.total_cost_usd ?? null,
      inputTokens: (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
      outputTokens: usage.output_tokens ?? 0,
      wallSeconds: Math.round(run.wallMs / 1000),
      stopped: transcript.result?.subtype ?? 'no result',
    };
  } finally {
    await removeFolder(workingDirectory);
  }
}

await mkdir(rawDirectory, { recursive: true });
await mkdir(resultsDirectory, { recursive: true });
const archiveFolder = await mkdtemp(join(tmpdir(), '67js-llms-only-pack-'));
const records = [];
try {
  const archivePath = packArchive(archiveFolder);
  for (let attempt = 1; attempt <= Number(options.runs); attempt++) {
    const record = await runAttempt(archivePath, attempt);
    records.push(record);
    console.log(`${TASK_ID} #${attempt} ${record.pass ? 'PASS' : 'FAIL'} ${record.detail}  calls ${record.toolCalls} (errors ${record.toolErrors})  turns ${record.turns}  $${record.costUsd ?? '?'}  ${record.wallSeconds}s`);
  }
} finally {
  await removeFolder(archiveFolder);
}
const summary = {
  run: runName,
  model: records.find(record => record.model)?.model ?? options.model,
  date: new Date().toISOString(),
  runsPerTask: Number(options.runs),
  passed: records.filter(record => record.pass).length,
  tasks: records.length,
  toolCalls: records.reduce((total, record) => total + record.toolCalls, 0),
  costUsd: Number(records.reduce((total, record) => total + (record.costUsd ?? 0), 0).toFixed(2)),
  byModel: totalsByModel(records),
  records,
};
await writeFile(join(resultsDirectory, `${runName}.json`), `${JSON.stringify(summary, null, 2)}\n`);
console.log(`${summary.passed}/${summary.tasks} passed, ${summary.toolCalls} tool calls, $${summary.costUsd}. Summary: bench/agent-modeling/results/${runName}.json`);
