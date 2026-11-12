// The three.js side of the agent friendliness comparison (issue #31): the same task prompts and model as run.mjs, but the
// agent has no MCP. It gets an empty folder with `three` installed from npm and writes code.
//
// node bench/agent-modeling/threejs.mjs --claude <claude executable> [--model sonnet] [--tasks crate,bolt] [--runs 1]
//   [--budget 3] [--timeout 1200] [--label threejs]
//
// The agent writes build.mjs, which builds the object with three.js, writes geometry.json (the world-space triangles of
// every mesh) and renders scene.png with headless Chrome. The same task checks and the same silhouette look score as
// the 67js runs grade geometry.json, so the two systems are measured on the same shape. A run passes when every check
// passes and scene.png is a real picture.
//
// Raw transcripts go to artifacts/agent-modeling/<run>/ (ignored by Git); the summary goes to
// bench/agent-modeling/results/<run>.json.
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createRunGuard } from './run-guard.mjs';
import { removeLocalPaths, totalsByModel, totalsOf } from './aggregate.mjs';
import { checkOne } from './check.mjs';
import { camerasForTask, worldGeometriesOf } from './look.mjs';
import { countTips, lineHits, sectionLoops, signedVolume } from './measure.mjs';
import { checkPng } from './png-check.mjs';
import { REFERENCES } from './references.mjs';
import { intersectionOverUnion, rasterizeSilhouette } from './silhouette.mjs';
import { taskById } from './tasks.mjs';

const repository = resolve(import.meta.dirname, '../..');
const BUILT_IN_TOOLS_DENIED = ['WebFetch', 'WebSearch', 'Agent', 'Task', 'NotebookEdit'];
const WELD_SCALE = 1e5;

export const THREEJS_PREAMBLE = `You are modeling with three.js code. The folder you are in has three installed from npm (node_modules/three). Build the
object described below as a closed, watertight solid, in metres with Y up. Rest the object on the ground (lowest point at
Y = 0), centred on X = 0 and Z = 0.
Write a Node.js script named build.mjs that does three things and run it:
1. Builds the object with three.js.
2. Writes geometry.json: a JSON array with one entry { "positions": [...], "indices": [...] } per mesh, with every vertex in
   world space (apply each mesh's world matrix) and indices as a flat triangle list.
3. Renders the scene to scene.png, 512 by 512 pixels, with headless Google Chrome (installed; use --use-angle=swiftshader
   --enable-unsafe-swiftshader --enable-webgl --ignore-gpu-blocklist so it needs no GPU). There is no internet access.
The files build.mjs, geometry.json and scene.png are what gets graded. When they exist, reply with one line saying so.`;

/** Measures an array of { positions, indices } meshes like measure.mjs does for a recipe, welding shared corners first. */
export function measureGeometries(rawGeometries) {
  const geometries = rawGeometries.map(({ positions, indices }) => ({
    positions: Float32Array.from(positions),
    indices: Uint32Array.from(indices ?? Array.from({ length: positions.length / 3 }, (_, index) => index)),
  }));
  const bounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  let signed = 0;
  let triangles = 0;
  let vertexCount = 0;
  let edgeCount = 0;
  let faceCount = 0;
  let components = 0;
  let closedComponents = 0;
  for (const geometry of geometries) {
    const weldedIndex = new Map();
    const welded = [];
    for (let vertex = 0; vertex < geometry.positions.length / 3; vertex++) {
      const point = [0, 1, 2].map(axis => geometry.positions[vertex * 3 + axis]);
      for (let axis = 0; axis < 3; axis++) {
        bounds.min[axis] = Math.min(bounds.min[axis], point[axis]);
        bounds.max[axis] = Math.max(bounds.max[axis], point[axis]);
      }
      const key = point.map(value => Math.round(value * WELD_SCALE)).join(',');
      if (!weldedIndex.has(key)) weldedIndex.set(key, weldedIndex.size);
      welded.push(weldedIndex.get(key));
    }
    signed += signedVolume(geometry);
    triangles += geometry.indices.length / 3;
    const edgeUses = new Map();
    const parent = Array.from({ length: weldedIndex.size }, (_, index) => index);
    const find = vertex => (parent[vertex] === vertex ? vertex : (parent[vertex] = find(parent[vertex])));
    let faces = 0;
    for (let triangle = 0; triangle < geometry.indices.length; triangle += 3) {
      const corners = [0, 1, 2].map(corner => welded[geometry.indices[triangle + corner]]);
      if (new Set(corners).size < 3) continue;
      faces++;
      for (let corner = 0; corner < 3; corner++) {
        const [from, to] = [corners[corner], corners[(corner + 1) % 3]];
        const key = from < to ? `${from}-${to}` : `${to}-${from}`;
        edgeUses.set(key, (edgeUses.get(key) ?? 0) + 1);
        parent[find(from)] = find(to);
      }
    }
    const roots = new Set(Array.from({ length: weldedIndex.size }, (_, vertex) => find(vertex)));
    components += roots.size;
    const closed = [...edgeUses.values()].every(uses => uses === 2);
    if (closed) closedComponents += roots.size;
    vertexCount += weldedIndex.size;
    edgeCount += edgeUses.size;
    faceCount += faces;
  }
  const allClosed = closedComponents === components;
  const volume = Math.abs(signed);
  return {
    parts: components,
    closedParts: closedComponents,
    lintProblems: allClosed ? 0 : components - closedComponents,
    problemKinds: allClosed ? [] : ['open or non-manifold edges'],
    holes: allClosed ? (2 * components - (vertexCount - edgeCount + faceCount)) / 2 : null,
    volume,
    triangles,
    bounds,
    size: [0, 1, 2].map(axis => bounds.max[axis] - bounds.min[axis]),
    tips: countTips(geometries, bounds),
    section: (axis, at) => sectionLoops(geometries, axis, at),
    lineHits: (axis, point) => lineHits(geometries, axis, point),
  };
}

/** Same shape as gradeRecipe: { pass, passed, total, results }. Tasks with checks this module cannot measure fail loudly. */
export function gradeGeometries(task, rawGeometries) {
  const unsupported = task.checks.filter(check => !['lint', 'parts', 'size', 'extent', 'ground', 'holes', 'volume', 'section', 'through', 'tips', 'triangles'].includes(check.kind));
  if (unsupported.length) throw new RangeError(`threejs.mjs cannot grade ${unsupported.map(check => check.kind).join(', ')}`);
  const measures = measureGeometries(rawGeometries);
  const results = task.checks.map(check => ({ kind: check.kind, ...(check.label ? { label: check.label } : {}), ...checkOne(check, measures) }));
  const passed = results.filter(result => result.pass).length;
  return { pass: passed === results.length, passed, total: results.length, results };
}

/** The look score of the suite (silhouette overlap from the three fixed cameras) for loose geometries. */
export async function scoreSilhouetteOfGeometries(taskId, rawGeometries) {
  const views = await camerasForTask(taskId);
  const reference = await worldGeometriesOf(REFERENCES[taskId]);
  const candidate = rawGeometries.map(({ positions, indices }) => ({ positions: Float32Array.from(positions), indices: Uint32Array.from(indices) }));
  const overlap = {};
  for (const { name, camera } of views) {
    overlap[name] = Number(intersectionOverUnion(rasterizeSilhouette(candidate, camera), rasterizeSilhouette(reference, camera)).toFixed(4));
  }
  const values = Object.values(overlap);
  return { views: overlap, mean: Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(4)) };
}

export function readTranscript(output) {
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
        if (block.type !== 'tool_use' || block.name === 'ToolSearch') continue;
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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values: options } = parseArgs({
    options: {
      claude: { type: 'string', default: process.env.CLAUDE_EXECUTABLE ?? 'claude' },
      model: { type: 'string', default: 'sonnet' },
      tasks: { type: 'string', default: 'crate,bolt,window,table,fence,bracket' },
      runs: { type: 'string', default: '1' },
      budget: { type: 'string', default: '3' },
      timeout: { type: 'string', default: '1200' },
      label: { type: 'string', default: 'threejs' },
    },
  });
  const npmExecutable = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const runName = `${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}-${options.model}-${options.label}`;
  const rawDirectory = join(repository, 'artifacts', 'agent-modeling', runName);
  const resultsDirectory = join(repository, 'bench', 'agent-modeling', 'results');
  await mkdir(rawDirectory, { recursive: true });
  await mkdir(resultsDirectory, { recursive: true });

  // One install of three from npm, copied into each attempt's fresh folder.
  const template = await mkdtemp(join(tmpdir(), '67js-threejs-template-'));
  await writeFile(join(template, 'package.json'), JSON.stringify({ name: 'threejs-task', private: true, type: 'module' }));
  execFileSync(npmExecutable, ['install', 'three', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: template, stdio: 'ignore', shell: process.platform === 'win32' });
  const threeVersion = JSON.parse(await readFile(join(template, 'node_modules', 'three', 'package.json'), 'utf8')).version;

  const runAgent = (prompt, workingDirectory) => new Promise(resolvePromise => {
    const started = performance.now();
    const child = spawn(options.claude, [
      '-p', prompt, '--model', options.model, '--output-format', 'stream-json', '--verbose', '--strict-mcp-config',
      '--allowedTools', 'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep',
      '--disallowedTools', ...BUILT_IN_TOOLS_DENIED,
      '--permission-mode', 'dontAsk', '--setting-sources', 'project', '--no-session-persistence',
    ], { cwd: workingDirectory, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let errors = '';
    const guard = createRunGuard({ child, model: options.model, budgetUsd: options.budget, timeoutSeconds: options.timeout });
    child.stdout.on('data', chunk => { output += chunk; guard.feed(chunk); });
    child.stderr.on('data', chunk => { errors += chunk; });
    child.on('close', code => {
      guard.stop();
      resolvePromise({ output, errors, code, wallMs: Math.round(performance.now() - started) });
    });
  });

  const records = [];
  const summarize = () => ({
    run: runName,
    system: 'three.js by code',
    threeVersion,
    model: records.find(record => record.model)?.model ?? options.model,
    date: new Date().toISOString(),
    runsPerTask: Number(options.runs),
    passed: records.filter(record => record.pass).length,
    tasks: records.length,
    toolCalls: records.reduce((sum, record) => sum + record.toolCalls, 0),
    byModel: totalsByModel(records),
    records,
  });
  try {
    for (let attempt = 1; attempt <= Number(options.runs); attempt++) {
      for (const task of options.tasks.split(',').map(taskById)) {
        const workingDirectory = await mkdtemp(join(tmpdir(), '67js-threejs-task-'));
        try {
          await cp(template, workingDirectory, { recursive: true });
          const run = await runAgent(`${THREEJS_PREAMBLE}\n\n${task.prompt.replace(/\n/g, ' ')}`, workingDirectory);
          const transcript = readTranscript(run.output);
          await writeFile(join(rawDirectory, `${task.id}-${attempt}.jsonl`), run.output);
          let geometries = null;
          let grade = { pass: false, passed: 0, total: task.checks.length, results: [{ kind: 'geometry', pass: false, detail: 'no geometry.json' }] };
          try {
            geometries = JSON.parse(await readFile(join(workingDirectory, 'geometry.json'), 'utf8'));
            grade = gradeGeometries(task, geometries);
          } catch (error) {
            grade.results[0].detail = `geometry.json unreadable: ${error.message.split('\n')[0]}`;
          }
          const png = await checkPng(join(workingDirectory, 'scene.png'));
          if (geometries) {
            await cp(join(workingDirectory, 'scene.png'), join(rawDirectory, `${task.id}-${attempt}.png`)).catch(() => {});
            await cp(join(workingDirectory, 'build.mjs'), join(rawDirectory, `${task.id}-${attempt}.build.mjs`)).catch(() => {});
          }
          let silhouette = null;
          if (geometries) silhouette = await scoreSilhouetteOfGeometries(task.id, geometries).catch(error => ({ error: error.message.split('\n')[0] }));
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
            filesWritten: (await readdir(workingDirectory)).filter(name => !['node_modules', 'package-lock.json'].includes(name)),
          };
          records.push(record);
          console.log(`${record.task.padEnd(10)} #${attempt} ${record.pass ? 'PASS' : 'FAIL'} ${record.passed}/${record.total} png ${png.pass}  calls ${record.toolCalls} (errors ${record.toolErrors})  look ${silhouette?.mean ?? '-'}  ${record.wallSeconds}s${failed.length ? `  ${failed.join(' | ')}` : ''}`);
          await writeFile(join(resultsDirectory, `${runName}.json`), `${JSON.stringify(summarize(), null, 2)}\n`);
        } finally {
          await removeFolder(workingDirectory);
        }
      }
    }
  } finally {
    await removeFolder(template);
  }
  console.log(`${records.filter(record => record.pass).length}/${records.length} passed, ${totalsOf(records).toolCalls} tool calls. Summary: bench/agent-modeling/results/${runName}.json`);
}
