// A recipe light bake through the MCP server, timed from scene_create to the answer, with the backend scene_inspect reports.
// Run it through gpu-lock.
//   node bench/native-tracer/recipe-bake.mjs <output directory> [--recipe tests/fixtures/demo-room.recipe.json] [--label run1]
// Writes recipe-bake-<label>.json (seconds, the `bake` block of scene_inspect). The native package is used when it is built;
// remove packages/render-native/build to see the fallback.
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { constants, setPriority, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const argumentsGiven = process.argv.slice(2);
const outputDirectory = resolve(argumentsGiven[0]);

function valueAfter(flag, fallback) {
  const index = argumentsGiven.indexOf(flag);
  return index >= 0 ? argumentsGiven[index + 1] : fallback;
}

const label = valueAfter('--label', 'run1');
const recipePath = valueAfter('--recipe', 'tests/fixtures/demo-room.recipe.json');

setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL);
await mkdir(outputDirectory, { recursive: true });
const workDirectory = await mkdtemp(join(tmpdir(), '67js-native-bake-'));
const transport = new StdioClientTransport({ command: process.execPath,
  args: [resolve('bin/67js-mcp.mjs'), '--backend', 'gpu', '--memory', '384', '--jobs', join(workDirectory, 'jobs')], cwd: workDirectory, stderr: 'pipe' });
let diagnostics = '';
transport.stderr.on('data', bytes => { diagnostics = (diagnostics + bytes).slice(-4096); });
const client = new Client({ name: '67js-native-bake-bench', version: '1' });

try {
  await client.connect(transport);
  const recipe = JSON.parse(await readFile(recipePath, 'utf8'));
  const started = performance.now();
  const created = (await client.callTool({ name: 'scene_create', arguments: { recipe } }, { timeout: 600000 })).structuredContent;
  const createSeconds = (performance.now() - started) / 1000;
  const inspected = (await client.callTool({ name: 'scene_inspect', arguments: { sessionId: created.sessionId } }, { timeout: 600000 })).structuredContent;
  const summary = { label, createSeconds, bake: inspected.bake, kernels: inspected.kernels };
  await writeFile(join(outputDirectory, `recipe-bake-${label}.json`), JSON.stringify(summary, null, 1));
  console.log(JSON.stringify(summary));
} catch (error) {
  console.error(diagnostics);
  throw error;
} finally {
  await client.close();
}
