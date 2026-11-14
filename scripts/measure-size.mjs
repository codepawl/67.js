// Measures what an app pays for each package entry, and for small scenes against three.js: npm run size
// A pull request fails when a bundle grows past its allowance against the base branch (--base, default origin/main) unless
// its own changes/*.size.md accepts it. --absolute also enforces the release budgets in bench/size/budgets.json.
// --update-baseline and --set-budgets refresh the baseline and the budgets at release.
import { readFile, writeFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import { build } from 'esbuild';
import { glslCommentStripperForEsbuild } from './strip-glsl-comments.mjs';
import { budgetsFrom, compareToBudgets, formatRows, initialOutputPaths } from './size-budget.mjs';
import { compareToBase, formatGrowthRows, goalProblems } from './size-growth.mjs';
import { measureArchiveBytes } from './measure-archive.mjs';
import { DEFAULT_BASE_REF, baseRefExists, measureBase, readAcceptedBundles } from './size-base.mjs';

const BUDGETS_PATH = 'bench/size/budgets.json';
const BASELINE_PATH = 'bench/size/baseline.json';
const EXTERNAL_PACKAGES = ['manifold-3d', '@dimforge/rapier3d-compat', 'jolt-physics'];
const CORE_ENTRY = 'core';

// Each scene does the same small job in both engines, so a size difference is the cost of the engine.
const SCENES = {
  'lit-box': {
    three: `
      import { Scene, PerspectiveCamera, WebGLRenderer, Mesh, BoxGeometry, MeshStandardMaterial, DirectionalLight } from 'three';
      const scene = new Scene();
      const renderer = new WebGLRenderer();
      scene.add(new Mesh(new BoxGeometry(), new MeshStandardMaterial()), new DirectionalLight());
      renderer.render(scene, new PerspectiveCamera());`,
    engine: `
      import { Renderer67 as CrucibleRenderer } from './src/renderer.js';
      import { box } from './src/geometry.js';
      const material = { tag: 'surface', color: [1, 1, 1], metallic: 0, roughness: 0.5 };
      const parts = [{ name: 'box', geometry: box(0, 1), matrix: new Float32Array(16), material }];
      new CrucibleRenderer(document.createElement('canvas'), parts, {}).render({ eye: [3, 3, 3], target: [0, 0, 0], up: [0, 1, 0], fov: 45, near: 0.1, far: 100 });`,
  },
  'gltf-box': {
    three: `
      import { Scene, PerspectiveCamera, WebGLRenderer, Mesh, BoxGeometry, MeshStandardMaterial, DirectionalLight } from 'three';
      import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
      const scene = new Scene();
      const renderer = new WebGLRenderer();
      new GLTFLoader().load('x.glb', model => scene.add(model.scene));
      scene.add(new Mesh(new BoxGeometry(), new MeshStandardMaterial()), new DirectionalLight());
      renderer.render(scene, new PerspectiveCamera());`,
    engine: `
      import { Renderer67 as CrucibleRenderer } from './src/renderer.js';
      import { parseGltf } from './src/gltf.js';
      parseGltf(new ArrayBuffer(0)).then(asset => new CrucibleRenderer(document.createElement('canvas'), asset.parts, {}).render({}));`,
  },
  'agent-scene': {
    engine: `
      import { createAgentScene } from './src/agent-scene.js';
      import { Renderer67 as CrucibleRenderer } from './src/renderer.js';
      const scene = createAgentScene({});
      new CrucibleRenderer(document.createElement('canvas'), scene.parts, {}).render(scene.camera);`,
  },
};

function gzipSize(contents) {
  return gzipSync(contents, { level: 9 }).length;
}

// Dynamic imports become separate chunks. What a page pays at start is the entry chunk and every chunk it imports
// statically; the rest loads when a feature asks for it. Both are reported so lazy code never hides.
function chunkSizes(result) {
  const outputsByPath = new Map(result.outputFiles.map(file => [relative(process.cwd(), file.path).replaceAll('\\', '/'), file]));
  const initialPaths = initialOutputPaths(result.metafile);
  const sizeOf = paths => {
    const parts = [...paths].map(path => outputsByPath.get(path).contents);
    const bytes = Buffer.concat(parts);
    return { min: bytes.length, gzip: parts.reduce((total, part) => total + gzipSize(part), 0), brotli: parts.reduce((total, part) => total + brotliCompressSync(part).length, 0) };
  };
  return { initial: sizeOf(initialPaths), all: sizeOf(outputsByPath.keys()) };
}

async function measureSource(contents) {
  const result = await build({
    stdin: { contents, resolveDir: process.cwd(), loader: 'js' },
    bundle: true, minify: true, format: 'esm', write: false, treeShaking: true, metafile: true,
    splitting: true, outdir: 'size-output', plugins: [glslCommentStripperForEsbuild()],
    external: EXTERNAL_PACKAGES, logLevel: 'silent', target: 'es2022',
    loader: { '.css': 'empty', '.json': 'json' },
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  return chunkSizes(result);
}

async function packageEntries() {
  const manifest = JSON.parse(await readFile('package.json', 'utf8'));
  const addons = Object.keys(manifest.exports).filter(key => key.startsWith('./addons/')).map(key => key.slice('./addons/'.length));
  return { [CORE_ENTRY]: 'src/index.js', ...Object.fromEntries(addons.map(name => [name, `src/${name}.js`])) };
}

// A bundle with on-demand code gets a second row, so the total after every lazy chunk is visible and budgeted.
function addMeasured(measured, name, sizes) {
  measured[name] = sizes.initial;
  if (sizes.all.gzip !== sizes.initial.gzip) measured[`${name}+lazy`] = sizes.all;
}

async function measureAll() {
  const jobs = Object.entries(await packageEntries()).map(([name, path]) => {
    const absolute = resolve(path).replace(/\\/g, '/');
    return { label: `entry:${name}`, source: `export * from '${absolute}';` };
  });
  for (const [name, scene] of Object.entries(SCENES)) jobs.push({ label: `scene:${name}`, source: scene.engine });
  const sizes = await mapWithLimit(jobs, job => measureSource(job.source));
  const measured = {};
  jobs.forEach((job, index) => addMeasured(measured, job.label, sizes[index]));
  return measured;
}

// A few builds at once use the cores of a CI runner without holding every build in memory together.
const BUILDS_AT_ONCE = 4;

async function mapWithLimit(items, work) {
  const results = new Array(items.length);
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index]);
    }
  };
  await Promise.all(Array.from({ length: BUILDS_AT_ONCE }, lane));
  return results;
}

async function measureThree() {
  const measured = {};
  for (const [name, scene] of Object.entries(SCENES)) {
    if (scene.three) measured[name] = (await measureSource(scene.three)).initial;
  }
  return measured;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 1)}\n`);
}

function printComparisonWithThree(measured, three) {
  console.log('\nThe same scene in both engines, in bytes gzip:');
  for (const [name, threeSize] of Object.entries(three)) {
    console.log(`  ${name.padEnd(14)} Crucible ${measured[`scene:${name}`].gzip}, three.js ${threeSize.gzip}`);
  }
}

// A positive distance is bytes over the goal. A budget raised to fit a change shows here as the distance growing.
function printGoals(measured, goals, budgets) {
  console.log('\nGoal scenes against their goals, in bytes gzip:');
  for (const [name, goal] of Object.entries(goals)) {
    const size = measured[`scene:${name}`].gzip;
    const distance = size - goal;
    const status = distance <= 0 ? 'met' : `${distance} over`;
    console.log(`  ${name.padEnd(14)} ${String(size).padStart(7)} of goal ${goal}: ${status} (budget ${budgets[`scene:${name}`]}, ${budgets[`scene:${name}`] - goal} over the goal)`);
  }
}

const argumentsGiven = process.argv.slice(2);
const flags = new Set(argumentsGiven);

function valueAfter(flag) {
  const index = argumentsGiven.indexOf(flag);
  return index === -1 ? undefined : argumentsGiven[index + 1];
}

// A child run for the base branch: print the measurement and stop.
if (flags.has('--json')) {
  process.stdout.write(JSON.stringify(await measureAll()));
  process.exit(0);
}

// The gate: growth against the base branch. An explicit --base must resolve. Without one, origin/main is used when it exists.
// The base is measured beside the pull request, and not at all when the run only refreshes the release numbers.
const requestedBase = valueAfter('--base');
const baseRef = requestedBase ?? DEFAULT_BASE_REF;
if (requestedBase && !baseRefExists(baseRef)) {
  console.error(`The base ref ${baseRef} does not exist. Fetch it first, for example: git fetch origin main`);
  process.exit(1);
}
const refreshing = flags.has('--set-budgets') || flags.has('--update-baseline');
const checkGrowth = baseRefExists(baseRef) && !refreshing;
const baseMeasurement = checkGrowth ? measureBase(baseRef) : null;
const measured = await measureAll();
const three = await measureThree();
const budgetFile = await readJson(BUDGETS_PATH);
const baselineFile = await readJson(BASELINE_PATH);

// Budgets and the baseline move at release, never in a feature pull request.
if (flags.has('--set-budgets')) {
  budgetFile.budgets = budgetsFrom(measured);
  budgetFile.archiveBytes = Math.ceil(measureArchiveBytes() * 1.02);
}
if (flags.has('--set-budgets') || flags.has('--update-baseline')) {
  const threeManifest = await readJson('node_modules/three/package.json');
  await writeJson(BUDGETS_PATH, budgetFile);
  await writeJson(BASELINE_PATH, { threeVersion: threeManifest.version, three, bundles: measured });
}

const { rows, problems: ceilingProblems } = compareToBudgets(measured, budgetFile.budgets, baselineFile.bundles);
const problems = [];

if (checkGrowth) {
  const accepted = readAcceptedBundles(baseRef);
  const growth = compareToBase(measured, await baseMeasurement, accepted);
  console.log(`Growth against ${baseRef}, in bytes gzip:`);
  console.log(formatGrowthRows(growth.rows));
  for (const [name, reason] of accepted) console.log(`Accepted: ${name}, ${reason}`);
  problems.push(...growth.problems);
  problems.push(...goalProblems(measured, await baseMeasurement, budgetFile.goals, accepted));
} else if (!refreshing) {
  console.log(`No ${baseRef} to compare with, so the growth check is skipped. Fetch it, or pass --base <ref>.`);
}

// The absolute budgets are the release ceilings. They are reported on a pull request and enforced with --absolute.
console.log('\nAgainst the release budgets:');
console.log(formatRows(rows));
printComparisonWithThree(measured, three);
printGoals(measured, budgetFile.goals, budgetFile.budgets);
if (ceilingProblems.length) {
  if (flags.has('--absolute')) {
    problems.push(...ceilingProblems);
  } else {
    console.log(`\n${ceilingProblems.length} bundle(s) are past their release budget. A release refreshes the budgets with npm run size:release. List them with npm run size -- --absolute.`);
  }
}
if (problems.length) {
  console.error(`\n${problems.length} size problem(s):`);
  for (const problem of problems) console.error(`- ${problem}`);
  process.exit(1);
}
console.log('\nNo bundle grew past its allowance.');

