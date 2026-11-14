// The look score of the agent modeling suite: how the finished object looks, kept beside the recipe checks and
// never merged with them.
//
// Silhouette score: the recipe and the task's reference are both seen from the same three fixed cameras (placed
// from the reference), and each view scores the intersection over union of what they cover. A task scores the mean.
// Images: the same cameras, drawn by the engine in a headless browser on SwiftShader, for the vision judge (judge.mjs).
//
// node bench/agent-modeling/look.mjs <task-id> <recipe.json> [--images <directory>]
// node bench/agent-modeling/look.mjs --references
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAgentScene, loadAllAgentSceneModules, loadMeshBooleans, needsMeshBooleans } from '../../src/agent-scene.js';
import { boundsOfGeometries, lookCameras } from './look-cameras.mjs';
import { worldGeometry } from './measure.mjs';
import { REFERENCES } from './references.mjs';
import { intersectionOverUnion, rasterizeSilhouette } from './silhouette.mjs';
import { TASKS } from './tasks.mjs';

const repository = resolve(import.meta.dirname, '../..');
const IMAGE_SIZE = 512;
const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const SWIFTSHADER_ARGUMENTS = ['--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'];

const roundScore = value => Number(value.toFixed(4));

// The look is the authored base pose, which recipe physics does not change, and the render page has no solver.
function withoutPhysics(recipe) {
  const { physics, ...staticRecipe } = recipe;
  return staticRecipe;
}

/** World-space triangles of every drawn node, with motion sampled at time zero. Asset recipes have none here. */
export async function worldGeometriesOf(recipe) {
  if (recipe.format === 'crucible.asset') return null;
  await loadAllAgentSceneModules();
  if (needsMeshBooleans(recipe)) await loadMeshBooleans();
  const scene = createAgentScene(withoutPhysics(recipe));
  if (recipe.motion) scene.sampleMotion(0);
  return scene.parts.map(worldGeometry);
}

/** The three fixed cameras of a task, placed from its reference recipe. Null for asset tasks. */
export async function camerasForTask(taskId) {
  const referenceGeometries = await worldGeometriesOf(REFERENCES[taskId]);
  return referenceGeometries ? lookCameras(boundsOfGeometries(referenceGeometries)) : null;
}

/** Per-view silhouette overlap with the task's reference, and its mean. Null for asset tasks. */
export async function scoreSilhouette(taskId, recipe) {
  const views = await camerasForTask(taskId);
  if (!views) return null;
  const referenceGeometries = await worldGeometriesOf(REFERENCES[taskId]);
  const candidateGeometries = await worldGeometriesOf(recipe);
  const overlap = {};
  for (const { name, camera } of views) {
    overlap[name] = roundScore(intersectionOverUnion(rasterizeSilhouette(candidateGeometries, camera), rasterizeSilhouette(referenceGeometries, camera)));
  }
  const values = Object.values(overlap);
  return { views: overlap, mean: roundScore(values.reduce((sum, value) => sum + value, 0) / values.length) };
}

/** Opens the look harness in headless Chrome. The viewport is the size of every image drawn in the callback. */
export async function withLookPage(callback, viewport = { width: IMAGE_SIZE, height: IMAGE_SIZE }) {
  const { chromium } = await import('playwright');
  const { createServer } = await import('vite');
  const server = await createServer({ root: repository, server: { host: '127.0.0.1', port: 0 }, logLevel: 'silent' });
  await server.listen();
  let browser = null;
  try {
    // The Windows path is this machine's Chrome; elsewhere (CI on Linux) Playwright finds the installed Chrome by channel.
    browser = await chromium.launch({ ...(existsSync(CHROME) ? { executablePath: CHROME } : { channel: 'chrome' }), headless: true, args: SWIFTSHADER_ARGUMENTS });
    const page = await browser.newPage({ viewport });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/bench/agent-modeling/look-harness.html`, { timeout: 60000 });
    await page.waitForFunction(() => window.renderLookViews);
    const result = await callback(page);
    if (errors.length) throw new Error(errors.join('\n'));
    return result;
  } finally {
    // A failed launch must still close the server, or the test process never exits.
    if (browser) await browser.close();
    await server.close();
  }
}

/** Draws a recipe once from its own camera and measures the picture: brightness, warmth, clipped and crushed shares. */
export async function measureRenderedLook(recipe) {
  return withLookPage(async page => {
    const [view] = await page.evaluate(sceneRecipe => window.renderLookViews(sceneRecipe, [{ name: 'recipe' }], true), withoutPhysics(recipe));
    return view.statistics;
  });
}

/** Draws jobs ([{ recipe, taskId, prefix, directory }]) from the task cameras; returns repository-relative PNG paths per job. */
export async function renderLookImages(jobs) {
  return withLookPage(async page => {
    const written = [];
    for (const { recipe, taskId, prefix, directory } of jobs) {
      const views = await camerasForTask(taskId);
      if (!views) {
        written.push([]);
        continue;
      }
      const images = await page.evaluate(([sceneRecipe, cameraViews]) => window.renderLookViews(sceneRecipe, cameraViews), [withoutPhysics(recipe), views]);
      await mkdir(directory, { recursive: true });
      const paths = [];
      for (const { name, image } of images) {
        const path = join(directory, `${prefix}-${name}.png`);
        await writeFile(path, Buffer.from(image, 'base64'));
        paths.push(relative(repository, path).replaceAll('\\', '/'));
      }
      written.push(paths);
    }
    return written;
  });
}

/** The look record of one finished task: silhouette scores and the images they came from (or imagesError). Judges are added later. */
export async function scoreLook(taskId, recipe, { imageDirectory, renderImages = renderLookImages } = {}) {
  const silhouette = await scoreSilhouette(taskId, recipe);
  if (!silhouette) return { skipped: 'asset recipes have no static silhouette' };
  const look = { silhouette };
  if (imageDirectory) {
    // The silhouette needs no picture, so a failed image step is recorded and the score is kept.
    try {
      const [images] = await renderImages([{ recipe, taskId, prefix: taskId, directory: imageDirectory }]);
      look.images = images;
    } catch (error) {
      look.imagesError = error.message.split('\n')[0];
    }
  }
  return look;
}

/** Like scoreLook, but an invalid recipe or a render failure becomes a recorded error, so one task cannot stop a run. */
export async function scoreLookSafely(taskId, recipe, options) {
  try {
    return await scoreLook(taskId, recipe, options);
  } catch (error) {
    return { error: error.message.split('\n')[0] };
  }
}

/** Renders every reference from its own cameras, the images a judge sees as the target. */
export async function renderReferenceImages() {
  const directory = join(repository, 'artifacts', 'agent-modeling', 'references');
  const jobs = TASKS.map(task => ({ recipe: REFERENCES[task.id], taskId: task.id, prefix: task.id, directory }));
  return renderLookImages(jobs);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [first, second, flag, directory] = process.argv.slice(2);
  if (first === '--references') {
    const paths = await renderReferenceImages();
    console.log(`${paths.flat().length} reference images in artifacts/agent-modeling/references`);
  } else {
    const recipe = JSON.parse(await readFile(second, 'utf8'));
    const look = await scoreLook(first, recipe, { imageDirectory: flag === '--images' ? resolve(directory) : undefined });
    console.log(JSON.stringify(look, null, 2));
  }
}
