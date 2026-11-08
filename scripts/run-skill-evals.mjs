// Runs the skill evals through headless `claude -p` with the 67js MCP server, one model at a time.
// Usage: node scripts/run-skill-evals.mjs --model haiku|sonnet|opus [--only <eval name>] [--out <folder>]
// It needs the built server (`npm run build:lib`), Chrome and the claude CLI. Each eval file holds a prompt and checks that
// read the tool calls and the last recipe the agent exported with scene_export_recipe. Skills are injected as system
// prompt text (with ${CLAUDE_SKILL_DIR} replaced), because the claude CLI would otherwise also load the user's own copies.
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const skillsFolder = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'skills');
const repositoryRoot = resolve(skillsFolder, '..');
const options = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => (value.startsWith('--') ? [...pairs, [value.slice(2), all[index + 1]]] : pairs), []));
const model = options.model ?? 'haiku';
const outputFolder = resolve(options.out ?? mkdtempSync(join(tmpdir(), 'skill-evals-')));
mkdirSync(outputFolder, { recursive: true });

function loadEvals() {
  const evals = [];
  for (const skill of readdirSync(skillsFolder, { withFileTypes: true })) {
    if (!skill.isDirectory()) continue;
    let files = [];
    try { files = readdirSync(join(skillsFolder, skill.name, 'evals')).filter(name => name.endsWith('.json')); } catch { continue; }
    for (const file of files) evals.push(JSON.parse(readFileSync(join(skillsFolder, skill.name, 'evals', file), 'utf8')));
  }
  return evals.filter(item => !options.only || item.name === options.only);
}

function skillText(skill) {
  const folder = join(skillsFolder, skill);
  const text = readFileSync(join(folder, 'SKILL.md'), 'utf8').replaceAll('${CLAUDE_SKILL_DIR}', folder.replaceAll('\\', '/'));
  return `<skill name="${skill}">\n${text}\n</skill>`;
}

function runClaude(item, workFolder) {
  const mcpConfig = {
    mcpServers: { '67js': { command: process.execPath, args: [join(repositoryRoot, 'bin', '67js-mcp.mjs'), '--backend', 'cpu', '--jobs', join(workFolder, 'jobs')] } },
  };
  const configPath = join(workFolder, 'mcp.json');
  writeFileSync(configPath, JSON.stringify(mcpConfig));
  const system = `You have the 67js MCP tools. Follow these skills. Read bundled reference files with the Read tool.\n${item.skills.map(skillText).join('\n')}`;
  const args = ['-p', '--model', model, '--output-format', 'stream-json', '--verbose', '--mcp-config', configPath, '--strict-mcp-config',
    '--disable-slash-commands', '--allowedTools', 'mcp__67js__*', 'Read', '--append-system-prompt', system, '--permission-mode', 'default'];
  return new Promise(resolveRun => {
    const child = spawn('claude', args, { cwd: workFolder, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    const timer = setTimeout(() => child.kill(), (item.timeoutSeconds ?? 420) * 1000);
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', () => {});
    child.on('close', () => { clearTimeout(timer); resolveRun(output); });
    child.stdin.end(item.prompt);
  });
}

function readTranscript(output) {
  const calls = [];
  const results = new Map();
  for (const line of output.split('\n')) {
    if (!line.trim().startsWith('{')) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    for (const block of event.message?.content ?? []) {
      if (block.type === 'tool_use') calls.push({ id: block.id, tool: block.name.replace(/^mcp__67js__/, ''), input: block.input });
      if (block.type === 'tool_result') {
        const text = Array.isArray(block.content) ? block.content.filter(part => part.type === 'text').map(part => part.text).join('\n') : String(block.content);
        results.set(block.tool_use_id, { text, isError: block.is_error === true });
      }
    }
  }
  return { calls, results };
}

function lastRecipe({ calls, results }) {
  for (const call of [...calls].reverse()) {
    if (call.tool !== 'scene_export_recipe') continue;
    try {
      const parsed = JSON.parse(results.get(call.id)?.text ?? '');
      return parsed.recipe ?? parsed;
    } catch { /* keep looking */ }
  }
  return null;
}

const valueAt = (object, path) => path.split('.').reduce((value, key) => (value == null ? undefined : value[key]), object);

function runCheck(check, transcript, recipe) {
  const { calls } = transcript;
  if (check.anyOf) return check.anyOf.some(inner => runCheck(inner, transcript, recipe));
  if (check.atMostOne) return check.atMostOne.filter(inner => runCheck(inner, transcript, recipe)).length < 2;
  if (check.toolCalled) return calls.some(call => call.tool === check.toolCalled);
  if (check.toolInputIncludes) {
    return calls.some(call => call.tool === check.toolInputIncludes.tool && JSON.stringify(call.input).includes(check.toolInputIncludes.text));
  }
  if (check.lookAfterLastEdit) {
    const edits = ['scene_create', 'scene_apply', 'scene_restore'];
    const lastEdit = calls.findLastIndex(call => edits.includes(call.tool));
    return calls.findLastIndex(call => call.tool === 'scene_look') > lastEdit && lastEdit >= 0;
  }
  const value = valueAt(recipe, check.path);
  if (check.op === 'exists') return value !== undefined && value !== null;
  if (check.op === 'absent') return value === undefined || value === null || value === 0;
  if (check.op === 'equals') return value === check.value;
  if (check.op === 'gt') return typeof value === 'number' && value > check.value;
  if (check.op === 'someMatches') {
    return Array.isArray(value) && value.some(entry => Object.entries(check.match).every(([key, expected]) => (expected === '*' ? entry[key] !== undefined : entry[key] === expected)));
  }
  if (check.op === 'minLength') return Array.isArray(value) && value.length >= check.value;
  throw new Error(`Unknown check ${JSON.stringify(check)}`);
}

const summary = [];
for (const item of loadEvals()) {
  const workFolder = mkdtempSync(join(outputFolder, `${item.name}-`));
  const started = Date.now();
  const output = await runClaude(item, workFolder);
  writeFileSync(join(workFolder, 'transcript.jsonl'), output);
  const transcript = readTranscript(output);
  const recipe = lastRecipe(transcript) ?? {};
  const failures = [];
  for (const check of item.checks) {
    let passed = false;
    try { passed = runCheck(check, transcript, recipe); } catch (error) { failures.push(`${check.label}: ${error.message}`); continue; }
    if (!passed) failures.push(check.label);
  }
  const result = { name: item.name, model, passed: failures.length === 0, failures, toolCalls: transcript.calls.length, seconds: Math.round((Date.now() - started) / 1000) };
  summary.push(result);
  console.log(JSON.stringify(result));
}
writeFileSync(join(outputFolder, `summary-${model}.json`), JSON.stringify(summary, null, 2));
