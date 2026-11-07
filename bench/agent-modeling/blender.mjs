// The Blender MCP side of the agent friendliness comparison (issue #31): the same task prompts and model as run.mjs and
// threejs.mjs, but the agent only has the official Blender MCP server (https://www.blender.org/lab/mcp-server/).
//
// The official server runs model-written Python without guards, so Blender and the server run ONLY inside a disposable
// Docker container on a separate machine (see blender-container/). This script drives it over SSH and an SSH port forward:
//
//   1. one-time on the remote machine: build the image from blender-container/ (`docker build --platform linux/amd64`)
//   2. open the forward:  ssh -N -L 127.0.0.1:9191:127.0.0.1:9191 <host>
//   3. node bench/agent-modeling/blender.mjs --ssh-host <host> [--claude <executable>] [--model sonnet] [--tasks crate,bolt]
//
// Per task the script starts a fresh container (a fresh Blender), mounts only a scratch folder, lets `claude -p` use the
// MCP server and nothing else (no Bash, no file tools on this machine), then copies geometry.json and scene.png back and
// grades them like threejs.mjs does: the task checks on the world-space triangles plus the silhouette look score.
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { removeLocalPaths, totalsByModel, totalsOf } from './aggregate.mjs';
import { checkPng } from './png-check.mjs';
import { gradeGeometries, readTranscript, scoreSilhouetteOfGeometries } from './threejs.mjs';
import { taskById } from './tasks.mjs';

const repository = resolve(import.meta.dirname, '../..');
const MCP_SERVER_NAME = 'blender';
const SERVER_URL = 'http://127.0.0.1:9191/';
const BUILT_IN_TOOLS_DENIED = ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Agent', 'Task', 'NotebookEdit'];
const DOCKER = 'export PATH=/opt/homebrew/bin:$PATH;';

export const BLENDER_PREAMBLE = `You are modeling in Blender through the Blender MCP server. Blender 5.1 runs headless in a container with no GPU and no
internet; the folder /work inside it is the only place files persist. Build the object described below as a closed,
watertight solid, in metres, Y up as in glTF (Blender itself is Z up, so convert when you export). Rest the object on the
ground (lowest point at Y = 0), centred on X = 0 and Z = 0.
Leave two files in /work and then reply with one line saying so:
1. geometry.json: a JSON array with one entry { "positions": [...], "indices": [...] } per mesh, with every vertex in world
   space (apply each object's world matrix and any modifiers, then the Z-up to Y-up change) and indices as a flat triangle list.
2. scene.png: a render of the scene, 512 by 512 pixels, any render engine that works headless (Cycles on the CPU works).`;

export function parseBlenderArguments(argv) {
  return parseArgs({
    args: argv,
    options: {
      'ssh-host': { type: 'string' },
      image: { type: 'string', default: 'blender67' },
      claude: { type: 'string', default: process.env.CLAUDE_EXECUTABLE ?? 'claude' },
      model: { type: 'string', default: 'sonnet' },
      tasks: { type: 'string', default: 'crate,bolt,window,table,fence,bracket' },
      runs: { type: 'string', default: '1' },
      budget: { type: 'string', default: '3' },
      timeout: { type: 'string', default: '1200' },
      label: { type: 'string', default: 'blender-mcp' },
    },
  }).values;
}

/** The scratch folder and the container are both removed by the script that created them. */
function remote(options, command) {
  return execFileSync('ssh', [options['ssh-host'], `${DOCKER} ${command}`], { encoding: 'utf8', timeout: 300_000 });
}

async function callServer(code) {
  const response = await fetch(SERVER_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'execute_blender_code', arguments: { code } } }),
    signal: AbortSignal.timeout(20_000),
  });
  return (await response.text()).includes('"status\\": \\"ok\\"');
}

async function waitForBlender() {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      if (await callServer('result = {}')) return;
    } catch {
      // The container is still starting.
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 2000));
  }
  throw new Error('the Blender MCP server never answered');
}

function runAgent(options, prompt, workingDirectory, configPath) {
  return new Promise(resolvePromise => {
    const started = performance.now();
    const child = spawn(options.claude, [
      '-p', prompt, '--model', options.model, '--output-format', 'stream-json', '--verbose',
      '--mcp-config', configPath, '--strict-mcp-config',
      '--allowedTools', `mcp__${MCP_SERVER_NAME}`,
      '--disallowedTools', ...BUILT_IN_TOOLS_DENIED,
      '--permission-mode', 'dontAsk', '--setting-sources', 'project', '--no-session-persistence', '--max-budget-usd', options.budget,
    ], { cwd: workingDirectory, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', () => {});
    const timer = setTimeout(() => child.kill(), Number(options.timeout) * 1000);
    child.on('close', code => {
      clearTimeout(timer);
      resolvePromise({ output, code, wallMs: Math.round(performance.now() - started) });
    });
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const options = parseBlenderArguments(process.argv.slice(2));
  if (!options['ssh-host']) throw new Error('--ssh-host is required: the machine that runs the disposable container');
  const runName = `${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}-${options.model}-${options.label}`;
  const rawDirectory = join(repository, 'artifacts', 'agent-modeling', runName);
  const resultsDirectory = join(repository, 'bench', 'agent-modeling', 'results');
  await mkdir(rawDirectory, { recursive: true });
  await mkdir(resultsDirectory, { recursive: true });
  execFileSync('scp', ['-q', join(import.meta.dirname, 'blender-container', 'entry.sh'), `${options['ssh-host']}:bench-scratch/entry.sh`]);
  const blenderVersion = remote(options, `docker run --rm --platform linux/amd64 ${options.image} /opt/blender/blender --version | head -1`).trim();

  const records = [];
  const summarize = () => ({
    run: runName,
    system: 'Blender MCP (official server in a container)',
    blenderVersion,
    model: records.find(record => record.model)?.model ?? options.model,
    date: new Date().toISOString(),
    runsPerTask: Number(options.runs),
    passed: records.filter(record => record.pass).length,
    tasks: records.length,
    toolCalls: records.reduce((sum, record) => sum + record.toolCalls, 0),
    byModel: totalsByModel(records),
    records,
  });

  const workingDirectory = await mkdtemp(join(tmpdir(), '67js-blender-agent-'));
  const configPath = join(workingDirectory, 'mcp.json');
  await writeFile(configPath, JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: { type: 'http', url: SERVER_URL } } }));
  try {
    for (let attempt = 1; attempt <= Number(options.runs); attempt++) {
      for (const task of options.tasks.split(',').map(taskById)) {
        const container = `blender67-${task.id}-${attempt}`;
        const scratch = `bench-scratch/${runName}/${task.id}-${attempt}`;
        const localCopy = join(rawDirectory, `${task.id}-${attempt}`);
        await mkdir(localCopy, { recursive: true });
        let run = { output: '', code: null, wallMs: 0 };
        let startError = null;
        try {
          remote(options, `mkdir -p "$HOME/${scratch}" && docker run -d --name ${container} --platform linux/amd64 --memory 6g -p 127.0.0.1:9191:9191 -v "$HOME/${scratch}:/work" -v "$HOME/bench-scratch/entry.sh:/entry.sh:ro" ${options.image} sh /entry.sh`);
          await waitForBlender();
          run = await runAgent(options, `${BLENDER_PREAMBLE}\n\n${task.prompt.replace(/\n/g, ' ')}`, workingDirectory, configPath);
        } catch (error) {
          startError = error.message.split('\n')[0];
        } finally {
          try {
            execFileSync('scp', ['-q', `${options['ssh-host']}:${scratch}/geometry.json`, `${options['ssh-host']}:${scratch}/scene.png`, localCopy], { stdio: 'ignore' });
          } catch {
            // A file the agent never wrote is a failed check below.
          }
          remote(options, `docker rm -f ${container} >/dev/null; rm -rf "$HOME/${scratch}"`);
        }
        const transcript = readTranscript(run.output);
        await writeFile(join(rawDirectory, `${task.id}-${attempt}.jsonl`), run.output);
        let geometries = null;
        let grade = { pass: false, passed: 0, total: task.checks.length, results: [{ kind: 'geometry', pass: false, detail: startError ?? 'no geometry.json' }] };
        try {
          geometries = JSON.parse(await readFile(join(localCopy, 'geometry.json'), 'utf8'));
          grade = gradeGeometries(task, geometries);
        } catch (error) {
          grade.results[0].detail = startError ?? `geometry.json unreadable: ${error.message.split('\n')[0]}`;
        }
        const png = await checkPng(join(localCopy, 'scene.png'));
        const silhouette = geometries ? await scoreSilhouetteOfGeometries(task.id, geometries).catch(error => ({ error: error.message.split('\n')[0] })) : null;
        const usage = transcript.result?.usage ?? {};
        const failed = grade.results.filter(result => !result.pass).map(result => `${result.label ?? result.kind}: ${result.detail}`);
        if (!png.pass) failed.push(`scene.png: ${png.detail}`);
        const record = {
          task: task.id,
          attempt,
          pass: grade.pass && png.pass,
          passed: grade.passed,
          total: grade.total,
          pngPass: png.pass,
          failed: failed.map(removeLocalPaths),
          model: transcript.model,
          toolCalls: transcript.toolCalls,
          toolErrors: transcript.toolErrors,
          toolsByName: transcript.toolsByName,
          look: silhouette ? { silhouette } : null,
          turns: transcript.result?.num_turns ?? null,
          costUsd: null,
          inputTokens: (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
          outputTokens: usage.output_tokens ?? 0,
          wallSeconds: Math.round(run.wallMs / 1000),
          exitCode: run.code,
          stopped: transcript.result?.subtype ?? 'no result',
        };
        records.push(record);
        console.log(`${record.task.padEnd(10)} #${attempt} ${record.pass ? 'PASS' : 'FAIL'} ${record.passed}/${record.total} png ${png.pass}  calls ${record.toolCalls} (errors ${record.toolErrors})  look ${silhouette?.mean ?? '-'}  ${record.wallSeconds}s${failed.length ? `  ${failed.join(' | ')}` : ''}`);
        await writeFile(join(resultsDirectory, `${runName}.json`), `${JSON.stringify(summarize(), null, 2)}\n`);
      }
    }
  } finally {
    await rm(workingDirectory, { recursive: true, force: true }).catch(() => {});
  }
  console.log(`${records.filter(record => record.pass).length}/${records.length} passed, ${totalsOf(records).toolCalls} tool calls. Summary: bench/agent-modeling/results/${runName}.json`);
}
