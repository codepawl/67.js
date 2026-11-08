// One timed trace of the demo room with the native ray query tracer (packages/render-native). Run it through gpu-lock.
//   node bench/native-tracer/run.mjs <output directory> [--samples 64] [--width 1920] [--height 1080] [--label run1]
// Writes native-<label>.png (tone mapped as the browser harness does) and native-<label>.json.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { constants, setPriority } from 'node:os';
import { resolve } from 'node:path';
import { buildNativeInput, traceNative } from '../../packages/render-native/index.mjs';
import { createAgentScene, loadAllAgentSceneModules, loadMeshBooleans, needsMeshBooleans, setManifoldModuleLoader } from '../../src/agent-scene.js';
import { agentEnvironmentMap } from '../../src/agent-look.js';
import { encodePng } from '../../src/export-png.js';
import * as pack from '../../src/path-tracer-gpu-pack.js';
import { createCamera, toneMapToRgba8 } from '../../src/path-tracer.js';
import { buildTraceScene } from '../../src/path-tracer-scene.js';

const argumentsGiven = process.argv.slice(2);
const outputDirectory = resolve(argumentsGiven[0]);

function valueAfter(flag, fallback) {
  const index = argumentsGiven.indexOf(flag);
  return index >= 0 ? argumentsGiven[index + 1] : fallback;
}

const options = {
  width: Number(valueAfter('--width', 1920)),
  height: Number(valueAfter('--height', 1080)),
  samples: Number(valueAfter('--samples', 64)),
  bounces: 8,
  seed: 0,
  fireflyClamp: 20,
};
const label = valueAfter('--label', 'run1');

setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL);
await mkdir(outputDirectory, { recursive: true });
const recipe = JSON.parse(await readFile('tests/fixtures/demo-room.recipe.json', 'utf8'));
await loadAllAgentSceneModules();
if (needsMeshBooleans(recipe)) {
  setManifoldModuleLoader(() => import('manifold-3d'));
  await loadMeshBooleans();
}
const agentScene = createAgentScene(recipe);
const environment = { ...agentScene.environment, map: agentEnvironmentMap(agentScene.environment) };
const buildStarted = performance.now();
const scene = buildTraceScene(agentScene.parts, environment);
const camera = createCamera(agentScene.camera, options.width, options.height);
const input = buildNativeInput(scene, camera, options, pack);
const buildSeconds = (performance.now() - buildStarted) / 1000;

const traceStarted = performance.now();
const result = traceNative(input, options);
const wallSeconds = (performance.now() - traceStarted) / 1000;

const { rgba, albedo, normal, depth, variance, ...numbers } = result;
const linear = new Float32Array(options.width * options.height * 3);
for (let pixel = 0; pixel < options.width * options.height; pixel++) {
  linear.set(rgba.subarray(pixel * 4, pixel * 4 + 3), pixel * 3);
}
const toneMapped = toneMapToRgba8(linear, options.width, options.height, { viewTransform: 'aces', look: null });
await writeFile(`${outputDirectory}/native-${label}.png`, encodePng(toneMapped, options.width, options.height));
const record = { variant: 'native', label, ...options, triangles: scene.indices.length / 3, buildSeconds, wallSeconds, ...numbers };
record.pathsPerSecond = (options.width * options.height * options.samples) / record.tracedSeconds;
await writeFile(`${outputDirectory}/native-${label}.json`, JSON.stringify(record, null, 1));
console.log(JSON.stringify(record));
