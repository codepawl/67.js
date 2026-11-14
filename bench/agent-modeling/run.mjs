// Runs the agent modeling suite: one fresh, non-interactive Claude Code session per task, with only the Crucible MCP
// server, then grades the recipe the agent exported.
//
// node bench/agent-modeling/run.mjs --claude <claude executable> [--model sonnet] [--tasks crate,bolt]
//   [--runs 3] [--run-name <name>] [--budget 3] [--timeout 1200] [--label baseline] [--skill] [--branches off] [--relations off] [--findings off] [--backend gpu|cpu] [--resume <run name>]
//
// --runs repeats every task that many times, each in a fresh session; the summary reports success rate, tool calls,
// tool errors, tokens and cost for the model and for each task.
// --resume continues a run that stopped early and skips the task attempts it already recorded. Pass the same --runs.
// --branches off starts the MCP server with --branches off: no branch field in any schema and no mention of variants in
// the instructions. Records carry branchCalls, the tool calls that passed a branch name, so a run shows whether agents used them.
// --relations off does the same for relations: no relations field in the node schemas and no relations entry in
// scene_capabilities. Records carry relationCalls, the tool calls that sent a relations list.
// --findings off hides the structured findings (`diagnostics`) from scene_look, the control for measuring what they are worth.
// Records carry imagesRead, the tool results that held a picture.
// --skill puts the build-crucible-scene entry point and its mesh reference in the system prompt. That measures what the
// skill's knowledge is worth, not whether an agent would load the skill on its own.
//
// Raw transcripts and recipes go to artifacts/agent-modeling/<run>/ (ignored by Git); the summary goes to
// bench/agent-modeling/results/<run>.json.
import { spawn } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createRunGuard } from './run-guard.mjs';
import { removeLocalPaths, totalsByModel, totalsOf } from './aggregate.mjs';
import { gradeRecipe, recipeFeatures } from './check.mjs';
import { countFixRounds, isMcpRender, isMcpWrite } from './fix-rounds.mjs';
import { scoreLookSafely } from './look.mjs';
import { classifyZeroCalls } from './zero-calls.mjs';
import { PROMPT_PREAMBLE, TASKS, taskById, taskPrompt } from './tasks.mjs';

const repository = resolve(import.meta.dirname, '../..');
const MCP_SERVER_NAME = 'crucible';
const EXPORT_TOOL = `mcp__${MCP_SERVER_NAME}__scene_export_recipe`;
const BUILT_IN_TOOLS = ['Bash', 'PowerShell', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Agent', 'Task', 'NotebookEdit'];

const { values: options } = parseArgs({
  options: {
    claude: { type: 'string', default: process.env.CLAUDE_EXECUTABLE ?? 'claude' },
    model: { type: 'string', default: 'sonnet' },
    tasks: { type: 'string' },
    runs: { type: 'string', default: '1' },
    budget: { type: 'string', default: '3' },
    timeout: { type: 'string', default: '1200' },
    label: { type: 'string', default: 'run' },
    skill: { type: 'boolean', default: false },
    branches: { type: 'string', default: 'on' },
    relations: { type: 'string', default: 'on' },
    findings: { type: 'string', default: 'on' },
    resume: { type: 'string' },
    'run-name': { type: 'string' },
    backend: { type: 'string', default: 'gpu' },
  },
});

const runName = options.resume ?? options['run-name'] ?? `${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}-${options.model}-${options.label}`;
const rawDirectory = join(repository, 'artifacts', 'agent-modeling', runName);
const resultsDirectory = join(repository, 'bench', 'agent-modeling', 'results');

async function skillPrompt() {
  const skillDirectory = join(repository, 'skills', 'build-crucible-scene');
  const entryPoint = await readFile(join(skillDirectory, 'SKILL.md'), 'utf8');
  const meshReference = await readFile(join(skillDirectory, 'references', 'mesh-modeling.md'), 'utf8');
  return `${entryPoint}\n\n${meshReference}`;
}

function mcpConfig(assetDirectory) {
  return { mcpServers: { [MCP_SERVER_NAME]: {
    command: process.execPath,
    args: [join(repository, 'scripts', 'mcp-server.mjs'), '--backend', options.backend, '--memory', '192', '--branches', options.branches, '--relations', options.relations, '--findings', options.findings, ...(assetDirectory ? ['--assets', assetDirectory] : [])],
  } } };
}

function runClaude(prompt, workingDirectory, configPath, systemPromptAddition) {
  const argumentsList = [
    '-p', prompt,
    '--model', options.model,
    '--output-format', 'stream-json', '--verbose',
    '--mcp-config', configPath, '--strict-mcp-config',
    '--allowedTools', `mcp__${MCP_SERVER_NAME}`,
    '--disallowedTools', ...BUILT_IN_TOOLS,
    '--permission-mode', 'dontAsk',
    '--setting-sources', 'project',
    '--no-session-persistence',
    ...(systemPromptAddition ? ['--append-system-prompt', systemPromptAddition] : []),
  ];
  return new Promise(resolvePromise => {
    const started = performance.now();
    const child = spawn(options.claude, argumentsList, { cwd: workingDirectory, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let errors = '';
    const guard = createRunGuard({ child, model: options.model, budgetUsd: options.budget, timeoutSeconds: options.timeout });
    child.stdout.on('data', chunk => {
      output += chunk;
      guard.feed(chunk);
    });
    child.stderr.on('data', chunk => {
      errors += chunk;
    });
    child.on('close', code => {
      guard.stop();
      resolvePromise({ output, errors, code, guardReason: guard.reason, wallMs: Math.round(performance.now() - started) });
    });
  });
}

function textOf(content) {
  if (typeof content === 'string') return content;
  return (content ?? []).filter(block => block.type === 'text').map(block => block.text).join('');
}

/** Tool calls, errors, the model, usage and the last exported recipe from a stream-json transcript. */
function readTranscript(output) {
  const summary = { model: null, toolCalls: 0, toolErrors: 0, toolsByName: {}, branchCalls: 0, relationCalls: 0, imagesRead: 0, pathQueries: 0, fixRounds: 0, recipe: null, result: null };
  const steps = [];
  const exportCalls = new Set();
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
        const name = block.name.replace(`mcp__${MCP_SERVER_NAME}__`, '');
        // ToolSearch only loads the MCP tool schemas; it is harness overhead, not modeling work.
        if (block.name !== 'ToolSearch') summary.toolCalls++;
        steps.push({ name, input: block.input });
        summary.toolsByName[name] = (summary.toolsByName[name] ?? 0) + 1;
        if (block.input?.branch !== undefined || block.input?.shots?.some(shot => shot.branch !== undefined)) summary.branchCalls++;
        // The recipe a task hands over may carry relations itself; only calls that send a non-empty list count.
        if (JSON.stringify(block.input ?? {}).includes('"relations":[{')) summary.relationCalls++;
        if (name.endsWith('scene_inspect') && block.input?.path !== undefined) summary.pathQueries++;
        if (block.name === EXPORT_TOOL) exportCalls.add(block.id);
      }
    }
    if (event.type === 'user') {
      for (const block of event.message?.content ?? []) {
        if (block.type !== 'tool_result') continue;
        if (block.is_error) summary.toolErrors++;
        if (Array.isArray(block.content) && block.content.some(part => part.type === 'image')) summary.imagesRead++;
        if (!exportCalls.has(block.tool_use_id) || block.is_error) continue;
        try {
          const exported = JSON.parse(textOf(block.content));
          summary.recipe = exported.format ? exported : exported.recipe ?? null;
        } catch {
          // Not JSON: the export failed; the task is graded as having no recipe.
        }
      }
    }
    if (event.type === 'result') summary.result = event;
  }
  summary.fixRounds = countFixRounds(steps, { isRender: isMcpRender, isWrite: isMcpWrite });
  return summary;
}

// Chrome can hold the folder for a moment after the session ends. A leftover temp folder must not end the run.
async function removeWorkingDirectory(workingDirectory) {
  try {
    await rm(workingDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  } catch (error) {
    console.warn(`Left ${workingDirectory} behind: ${error.code}`);
  }
}

async function runTask(task, attempt, systemPromptAddition) {
  const fileStem = `${task.id}-${attempt}`;
  const workingDirectory = await mkdtemp(join(tmpdir(), 'crucible-agent-task-'));
  try {
    const configPath = join(workingDirectory, 'mcp.json');
    let assetDirectory = null;
    if (task.assets) {
      assetDirectory = join(workingDirectory, 'assets');
      await mkdir(assetDirectory);
      await copyFile(join(repository, 'tests', 'fixtures', 'RobotExpressive.glb'), join(assetDirectory, 'robot.glb'));
    }
    await writeFile(configPath, JSON.stringify(mcpConfig(assetDirectory)));
    const text = taskPrompt(task);
    const prompt = task.ownPreamble ? text : `${PROMPT_PREAMBLE}\n\n${text}`;
    const run = await runClaude(prompt, workingDirectory, configPath, systemPromptAddition);
    const transcript = readTranscript(run.output);
    await writeFile(join(rawDirectory, `${fileStem}.jsonl`), run.output);
    if (run.errors) await writeFile(join(rawDirectory, `${fileStem}.stderr.txt`), run.errors);
    if (transcript.recipe) await writeFile(join(rawDirectory, `${fileStem}.recipe.json`), JSON.stringify(transcript.recipe, null, 2));
    const grade = transcript.recipe
      ? await gradeRecipe(task, transcript.recipe)
      : { pass: false, passed: 0, total: task.checks.length, results: [{ kind: 'export', pass: false, detail: 'no exported recipe' }] };
    const usage = transcript.result?.usage ?? {};
    return {
      task: task.id,
      attempt,
      pass: grade.pass,
      passed: grade.passed,
      total: grade.total,
      failed: grade.results.filter(result => !result.pass).map(result => removeLocalPaths(`${result.label ?? result.kind}: ${result.detail}`)),
      model: transcript.model,
      toolCalls: transcript.toolCalls,
      toolErrors: transcript.toolErrors,
      fixRounds: transcript.fixRounds,
      toolsByName: transcript.toolsByName,
      branchCalls: transcript.branchCalls,
      relationCalls: transcript.relationCalls,
      imagesRead: transcript.imagesRead,
      pathQueries: transcript.pathQueries,
      features: transcript.recipe ? recipeFeatures(transcript.recipe) : null,
      look: transcript.recipe ? await scoreLookSafely(task.id, transcript.recipe, { imageDirectory: join(rawDirectory, 'look', String(attempt)) }) : null,
      turns: transcript.result?.num_turns ?? null,
      costUsd: transcript.result?.total_cost_usd ?? null,
      inputTokens: (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
      outputTokens: usage.output_tokens ?? 0,
      wallSeconds: Math.round(run.wallMs / 1000),
      exitCode: run.code,
      stopped: transcript.result?.subtype ?? (run.guardReason ? `guard-${run.guardReason}` : 'no result'),
    };
  } finally {
    await removeWorkingDirectory(workingDirectory);
  }
}

// An infra failure (claude -p or the MCP server never got going) says nothing about the schemas, so the run is tried
// once more. The retry's record replaces the first; it keeps the first cause in retriedAfter. A second infra failure
// stays marked infra and is left out of pass@1.
async function runTaskWithInfraRetry(task, attempt, systemPromptAddition) {
  const first = await runTask(task, attempt, systemPromptAddition);
  if (!first.infra) return first;
  console.log(`${task.id.padEnd(16)} #${attempt} infra ${first.zeroCalls.cause}: retrying once`);
  const second = await runTask(task, attempt, systemPromptAddition, '-retry');
  return { ...second, retriedAfter: first.zeroCalls.cause };
}

if (!['on', 'off'].includes(options.branches)) throw new RangeError('--branches must be on or off');
if (!['on', 'off'].includes(options.relations)) throw new RangeError('--relations must be on or off');
if (!['on', 'off'].includes(options.findings)) throw new RangeError('--findings must be on or off');
const tasks = options.tasks ? options.tasks.split(',').map(taskById) : TASKS;
await mkdir(rawDirectory, { recursive: true });
await mkdir(resultsDirectory, { recursive: true });
const systemPromptAddition = options.skill ? await skillPrompt() : null;
const summaryPath = join(resultsDirectory, `${runName}.json`);
const records = options.resume ? JSON.parse(await readFile(summaryPath, 'utf8')).records : [];
const attempts = Number(options.runs);
if (!Number.isInteger(attempts) || attempts < 1) throw new RangeError('--runs must be a whole number from 1');
// Records from before --runs existed have no attempt number: they are the first attempt.
const recordedAttempts = new Set(records.map(record => `${record.task}#${record.attempt ?? 1}`));

function summarize() {
  return {
    run: runName,
    model: records.find(record => record.model)?.model ?? options.model,
    date: new Date().toISOString(),
    skill: options.skill,
    branches: options.branches,
    relations: options.relations,
    findings: options.findings,
    runsPerTask: attempts,
    passed: records.filter(record => record.pass).length,
    tasks: records.length,
    toolCalls: records.reduce((sum, record) => sum + record.toolCalls, 0),
    costUsd: Number(records.reduce((sum, record) => sum + (record.costUsd ?? 0), 0).toFixed(2)),
    byModel: totalsByModel(records),
    records,
  };
}

const pending = [];
for (let attempt = 1; attempt <= attempts; attempt++) {
  for (const task of tasks) {
    if (!recordedAttempts.has(`${task.id}#${attempt}`)) pending.push({ task, attempt });
  }
}

for (const { task, attempt } of pending) {
  const record = await runTaskWithInfraRetry(task, attempt, systemPromptAddition);
  records.push(record);
  const label = record.infra ? `INFRA ${record.zeroCalls.cause}` : record.pass ? 'PASS' : `FAIL${record.zeroCalls ? ` ${record.zeroCalls.cause}` : ''}`;
  console.log(`${record.task.padEnd(16)} #${attempt} ${label} ${record.passed}/${record.total}  calls ${record.toolCalls} (errors ${record.toolErrors})  $${record.costUsd ?? '?'}  ${record.wallSeconds}s${record.failed.length ? `  ${record.failed.join(' | ')}` : ''}`);
  // Saved after every task, so a run that gets killed keeps what it already paid for.
  await writeFile(summaryPath, `${JSON.stringify(summarize(), null, 2)}\n`);
}
const summary = summarize();
console.log(`${summary.passed}/${summary.tasks} passed (${Math.round(totalsOf(records).successRate * 100)}%), ${summary.toolCalls} tool calls, $${summary.costUsd}. Summary: bench/agent-modeling/results/${runName}.json`);
