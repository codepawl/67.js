// Renders the reference scenes in 67js and Blender, then scores them: npm run reference
// --ambient-occlusion <strength> [--ambient-occlusion-radius <units>] turns occlusion on (off by default).
// --bake [<id>,<id>] [--bake-preset <name>] bakes bounced light into the named scenes (every scene when no ids follow) before 67js draws them;
// Blender still gets the plain scene.
// --probes [<id>,<id>] adds reflection probes (src/reflection-probes.js) to the named scenes, on top of --bake when both are given.
// --no-glossy draws the scenes with metallic 0 and specular 0 on every material (and, in the harness, no sky reflection), the 67js side of render-blender.py --no-glossy (issue #506).
// --ambient <scale> multiplies the light the world gives every surface (0 removes it); with --skip-blender it measures what the world adds.
// --path-tracer [--samples <n>] [--noise-threshold <n>] [--scene <id>] draws the scenes with the offline path tracer (src/path-tracer.js) instead, keeps the
// Cycles renders of an earlier run, and scores them into path-tracer.json (--path-tracer-backend gpu draws them with the GPU tracer and
// writes path-tracer-gpu.json instead). Nothing in baseline.json or images/ changes.
// Use --score-only to score existing renders, --skip-blender to keep them, and --scene <id> for one scene.
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { constants, setPriority } from 'node:os';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';

// --khronos draws the Khronos sample assets in artifacts/khronos (Blender imports the same files) into their own work
// directory, and scores them into khronos.json. Nothing in baseline.json or images/<scene>.jpg changes.
// --cloth draws the cloth scenes (a pinned banner in wind, a sheet dropped on a ball) with 67js's solver and with a Blender
// cloth bake, and scores them into cloth.json the same way (the pixels the scene covers, with the sky left out).
const khronos = process.argv.includes('--khronos');
const cloth = process.argv.includes('--cloth');
// --no-ground-bounce draws the scenes without the light their floor bounces (src/ground-bounce.js), which is otherwise found from the floor part.
// --no-water draws the scenes without the water reflection (src/water-reflection.js), which is otherwise found from the materials; --ssr-water draws them with bench/reference/ssr-water.js instead.
// --grand draws the options for the grand scenes (grand-scenes.js, issue #168) and scores them into grand.json.
const grand = process.argv.includes('--grand');
// --option <scene>:<option>,<scene>:<option> draws named looks (look-options.js, issue #168) with the GPU only, into artifacts/reference-look/<scene>-<option>-gpu.png. No Blender, no score, no baseline.
const optionFlag = process.argv.indexOf('--option');
const lookIds = optionFlag >= 0 ? process.argv[optionFlag + 1].split(',').map(name => name.replace(':', '-')) : null;
const sceneSet = khronos ? 'khronos' : cloth ? 'cloth' : grand ? 'grand' : lookIds ? 'look' : null;
// --view-transform <agx|neutral> draws the scenes with that environment.viewTransform and renders Cycles with the matching Blender view
// transform (AgX, Khronos PBR Neutral), then scores the pair with view-transform-score.py into view-transform.json (issue #282).
// Use it with --scene <id>,<id>; the work directory is separate and baseline.json stays as it is.
const viewTransformFlag = process.argv.indexOf('--view-transform');
const viewTransform = viewTransformFlag >= 0 ? process.argv[viewTransformFlag + 1] : null;
const BLENDER_VIEW_TRANSFORMS = { agx: 'AgX', neutral: 'Khronos PBR Neutral' };
if (viewTransform && !BLENDER_VIEW_TRANSFORMS[viewTransform]) throw new Error(`--view-transform must be one of ${Object.keys(BLENDER_VIEW_TRANSFORMS).join(', ')}.`);
const WORK_DIRECTORY = resolve(viewTransform ? `artifacts/reference-view-${viewTransform}` : sceneSet ? `artifacts/reference-${sceneSet}` : 'artifacts/reference');
const OUTPUT_DIRECTORY = resolve('bench/reference');
const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BLENDER = process.env.BLENDER_PATH ?? 'C:/Program Files/Blender Foundation/Blender 5.2/blender.exe';
const WIDTH = 960;
const HEIGHT = 540;
// This process runs below normal priority, so a busy machine takes the page load past Playwright's 30 second default
// (measured 22 s, against 5 s when idle). Load time does not affect any score.
const PAGE_LOAD_TIMEOUT = 180000;
// --no-gpu keeps the whole run off the GPU: the "gpu" render uses SwiftShader and Cycles runs on the CPU. The scene
// descriptions and the Cycles images are what the path tracer comparison needs; the rasterizer scores of such a run are not comparable.
const noGpu = process.argv.includes('--no-gpu');
const BACKEND_ARGUMENTS = {
  gpu: noGpu ? ['--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : ['--enable-webgl', '--ignore-gpu-blocklist', '--disable-renderer-backgrounding'],
  cpu: ['--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
};

const argumentsGiven = process.argv.slice(2);
// --floor-sky-rooms also traces closed rooms, which are left as they are otherwise.
// Closed rooms lit by a sun get the floor sky trace by default, as in the recipe path; --no-floor-sky draws without it (environment.floorSkyTrace: false).
// --floor-sky [<strength>] traces the sky each floor texel sees (src/floor-sky-visibility.js) and scales the world light on floors by it (strength 1 when none follows).
const floorSkyFlag = argumentsGiven.indexOf('--floor-sky');
// --sun-bounce <n> sets environment.sunBounce on every scene (0 draws without the sunlit patches' lights; the default is 1).
const sunBounceFlag = argumentsGiven.indexOf('--sun-bounce');
const sunBounceQuery = sunBounceFlag < 0 ? null : `sunBounce=${Number(argumentsGiven[sunBounceFlag + 1])}`;
const floorSkyStrength = floorSkyFlag < 0 ? 0 : Number(argumentsGiven[floorSkyFlag + 1]) || 1;
const scoreOnly = argumentsGiven.includes('--score-only');
const skipBlender = argumentsGiven.includes('--skip-blender') || lookIds !== null;
// --skip-cpu leaves out the SwiftShader render (very slow for the 9 million triangle scenes) and the scoring, which needs it.
const skipCpuFlag = argumentsGiven.includes('--skip-cpu') || lookIds !== null;
const sceneFlag = argumentsGiven.indexOf('--scene');
const occlusionFlag = argumentsGiven.indexOf('--ambient-occlusion');
const ambientOcclusion = occlusionFlag >= 0 ? Number(argumentsGiven[occlusionFlag + 1]) : 0;
const radiusFlag = argumentsGiven.indexOf('--ambient-occlusion-radius');
const ambientOcclusionRadius = radiusFlag >= 0 ? Number(argumentsGiven[radiusFlag + 1]) : 0.5;
const bakeFlag = argumentsGiven.indexOf('--bake');
const bakeValue = bakeFlag >= 0 ? argumentsGiven[bakeFlag + 1] : undefined;
const bakedSceneIds = bakeFlag >= 0 && bakeValue && !bakeValue.startsWith('--') ? bakeValue.split(',') : null;
// --sky-only <texelsPerUnit>,<samples> makes the --bake rows sky visibility alone (no light written) at that density.
const skyOnlyFlag = argumentsGiven.indexOf('--sky-only');
const [skyTexelsPerUnit, skySamples] = skyOnlyFlag >= 0 ? argumentsGiven[skyOnlyFlag + 1].split(',').map(Number) : [];
const skyOnlyOptions = skyOnlyFlag >= 0 ? { skyOnly: true, texelsPerUnit: skyTexelsPerUnit, samples: skySamples } : {};
// --bake-preset <draft|standard|fine> bakes the way a recipe does (`bake: { preset }`): the preset's own samples, bounces and
// texel density, scaled down to the preset's path work budget, and the scene's own `bakeOptions` are ignored. Needs --bake.
const bakePresetFlag = argumentsGiven.indexOf('--bake-preset');
const bakePreset = bakePresetFlag >= 0 ? argumentsGiven[bakePresetFlag + 1] : null;
// --bake-backend <cpu|gpu> picks the tracer of the --bake rows (the GPU path tracer's kernel; the default is the CPU reference),
// and --bake-samples <n> and --bake-density <texels per unit> set those on top of the scene's own bake options.
const bakeBackendFlag = argumentsGiven.indexOf('--bake-backend');
const bakeBackend = bakeBackendFlag >= 0 ? argumentsGiven[bakeBackendFlag + 1] : null;
const bakeSamplesFlag = argumentsGiven.indexOf('--bake-samples');
const bakeSamples = bakeSamplesFlag >= 0 ? Number(argumentsGiven[bakeSamplesFlag + 1]) : null;
const bakeDensityFlag = argumentsGiven.indexOf('--bake-density');
const bakeDensity = bakeDensityFlag >= 0 ? Number(argumentsGiven[bakeDensityFlag + 1]) : null;
const probesFlag =argumentsGiven.indexOf('--probes');
const probesValue = probesFlag >= 0 ? argumentsGiven[probesFlag + 1] : undefined;
const probedSceneIds = probesFlag >= 0 && probesValue && !probesValue.startsWith('--') ? probesValue.split(',') : null;
// Each reflective part gets a probe of its own (traceObjectProbes), as a recipe gives it by default. --no-object-probes draws the scenes without them,
// and --object-probes <id>,<id> limits them to the named scenes.
const objectProbesFlag = argumentsGiven.indexOf('--object-probes');
const objectProbesValue = objectProbesFlag >= 0 ? argumentsGiven[objectProbesFlag + 1] : undefined;
const objectProbeSceneIds = objectProbesFlag >= 0 && objectProbesValue && !objectProbesValue.startsWith('--') ? objectProbesValue.split(',') : null;
const cascadesFlag = argumentsGiven.indexOf('--cascades');
const cascades = cascadesFlag >= 0 ? Number(argumentsGiven[cascadesFlag + 1]) : 0;
const ambientFlag = argumentsGiven.indexOf('--ambient');
const ambient = ambientFlag >= 0 ? Number(argumentsGiven[ambientFlag + 1]) : null;
// --key <scale> multiplies the sun and --fog-density <density> replaces the volume fog's density (0 removes the haze): measurement switches that split a picture into its light components (issue #543).
const keyFlag = argumentsGiven.indexOf('--key');
const keyScale = keyFlag >= 0 ? Number(argumentsGiven[keyFlag + 1]) : null;
const fogDensityFlag = argumentsGiven.indexOf('--fog-density');
// --fog-set name=value,name=value replaces any other volume fog fields, for example scatterOctaves=3,keyTransmittance=1.
const fogSetFlag = argumentsGiven.indexOf('--fog-set');
const fogSet = fogSetFlag >= 0 ? Object.fromEntries(argumentsGiven[fogSetFlag + 1].split(',').map(pair => pair.split('=')).map(([name, value]) => [name, Number(value)])) : {};
const fogDensity = fogDensityFlag >= 0 || fogSetFlag >= 0 ? { ...fogSet, ...(fogDensityFlag >= 0 ? { density: Number(argumentsGiven[fogDensityFlag + 1]) } : {}) } : null;
const pathTracerFlag = argumentsGiven.includes('--path-tracer');
const samplesFlag = argumentsGiven.indexOf('--samples');
const pathTracerSamples = samplesFlag >= 0 ? Number(argumentsGiven[samplesFlag + 1]) : 64;
const noiseThresholdFlag = argumentsGiven.indexOf('--noise-threshold');
const pathTracerBackendFlag = argumentsGiven.indexOf('--path-tracer-backend');
const pathTracerBackend = pathTracerBackendFlag >= 0 ? argumentsGiven[pathTracerBackendFlag + 1] : 'cpu';
const pathTracerNoiseThreshold = noiseThresholdFlag >= 0 ? Number(argumentsGiven[noiseThresholdFlag + 1]) : undefined;
// --scene takes one id or several separated by commas.
const sceneIdsGiven = lookIds ?? (sceneFlag >= 0 ? argumentsGiven[sceneFlag + 1].split(',') : null);
// --bake <id>,<id> alone is a baked-score run: it draws and scores only those scenes, with the GPU, against the Cycles and EEVEE renders
// of an earlier run (use --skip-blender), and writes bake.json. With an option that changes the bake (--sky-only, --bake-preset, --probes,
// --ambient, --ambient-occlusion, --cascades) the scores go to the work directory and the committed files stay as they are.
// The fresh bake.json lands in the work directory and is checked against the committed one (compare-scores.mjs); --update-baseline replaces
// the committed bake.json and images/<id>-baked.jpg with it.
const bakeScoreRun = bakedSceneIds !== null && !sceneSet && !pathTracerFlag;
const bakeVariantFlags = ['--no-glossy', '--sky-only', '--bake-preset', '--bake-grid', '--bake-grid-fog', '--no-bake-worker', '--bake-bounces', '--bake-backend', '--bake-samples', '--bake-density', '--probes', '--ambient', '--key', '--fog-density', '--fog-set', '--ambient-occlusion', '--cascades', '--no-object-probes', '--object-probes', '--no-water', '--ssr-water', '--no-ground-bounce', '--floor-sky', '--floor-sky-rooms', '--no-floor-sky'];
const bakeScoreIsBaseline = bakeScoreRun && argumentsGiven.includes('--update-baseline') && !bakeVariantFlags.some(flag => argumentsGiven.includes(flag));
const onlyScenes = sceneIdsGiven ?? (bakeScoreRun ? bakedSceneIds : null);
const skipCpu = skipCpuFlag || bakeScoreRun || Boolean(viewTransform);

async function renderBackend(backend, serverUrl, graphics) {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: BACKEND_ARGUMENTS[backend] });
  try {
    const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => message.text().includes('GL_') && console.log('PAGE', message.text().slice(0, 200)));
    // Each scene gets a fresh page, so a large scene leaves no GL state or memory behind for the next one.
    const openHarness = async () => {
      const harnessQuery = [sceneSet ? `set=${sceneSet}` : null, argumentsGiven.includes('--no-glossy') ? 'glossy=0' : null, argumentsGiven.includes('--no-bake-worker') ? 'kernelWorkers=off' : null, argumentsGiven.includes('--no-water') ? 'water=off' : argumentsGiven.includes('--ssr-water') ? 'water=ssr' : null, argumentsGiven.includes('--no-ground-bounce') ? 'groundBounce=off' : null, floorSkyStrength ? `floorSky=${floorSkyStrength}` : argumentsGiven.includes('--no-floor-sky') ? 'floorSky=0' : null, argumentsGiven.includes('--floor-sky-rooms') ? 'floorSkyRooms=1' : null, sunBounceQuery].filter(Boolean).join('&');
      await page.goto(`${serverUrl}/bench/reference/harness.html${harnessQuery ? `?${harnessQuery}` : ''}`, { timeout: PAGE_LOAD_TIMEOUT });
      await page.waitForFunction(() => window.renderReferenceScene, null, { timeout: PAGE_LOAD_TIMEOUT });
    };
    await openHarness();
    const sceneIds = await page.evaluate(() => window.referenceSceneIds);
    for (const id of sceneIds) {
      if (onlyScenes && !onlyScenes.includes(id)) continue;
      await openHarness();
      const started = performance.now();
      const describe = backend === 'gpu';
      const probesThisScene = probesFlag >= 0 && (probedSceneIds === null || probedSceneIds.includes(id));
      const bakesThisScene = bakeFlag >= 0 && (bakedSceneIds === null || bakedSceneIds.includes(id));
      // Object probes are on by default, as in a recipe, so the baseline scores what a user gets.
      const objectProbesThisScene = !argumentsGiven.includes('--no-object-probes') && (objectProbeSceneIds === null || objectProbeSceneIds.includes(id));
      const probes = probesThisScene || (objectProbesThisScene ? 'objects' : false);
      const bake = bakesThisScene ? { ...skyOnlyOptions, ...(bakePreset ? { preset: bakePreset } : {}), ...(argumentsGiven.includes('--bake-grid') ? { irradianceGrid: Number(argumentsGiven[argumentsGiven.indexOf('--bake-grid') + 1]) || true } : {}), ...(argumentsGiven.includes('--bake-grid-fog') ? { gridFog: true } : {}), ...(argumentsGiven.includes('--bake-bounces') ? { bounces: Number(argumentsGiven[argumentsGiven.indexOf('--bake-bounces') + 1]) } : {}), ...(bakeBackend ? { backend: bakeBackend } : {}), ...(bakeSamples ? { samples: bakeSamples } : {}), ...(bakeDensity ? { texelsPerUnit: bakeDensity } : {}) } : null;
      const result = await page.evaluate(([sceneId, shouldDescribe, ambientOcclusion, ambientOcclusionRadius, bakeOptions, cascadeCount, withProbes, ambientScale, selectedViewTransform, keyScaleGiven, fogGiven]) => window.renderReferenceScene(sceneId, { describe: shouldDescribe, ambientOcclusion, ambientOcclusionRadius, bake: bakeOptions, cascades: cascadeCount, probes: withProbes, ambient: ambientScale, viewTransform: selectedViewTransform, key: keyScaleGiven, volumeFog: fogGiven }), [id, describe, ambientOcclusion, ambientOcclusionRadius, bake, cascades, probes, ambient, viewTransform, keyScale, fogDensity]);
      if (result.glError !== 0) throw new Error(`${id} on ${backend} gave WebGL error ${result.glError}.`);
      graphics[backend] = result.graphics;
      await writeFile(`${WORK_DIRECTORY}/${id}-${backend}.png`, Buffer.from(result.image, 'base64'));
      if (describe) await writeFile(`${WORK_DIRECTORY}/scenes/${id}.json`, JSON.stringify(result.description));
      if ((khronos || cloth) && describe) {
        const background = await page.evaluate(sceneId => window.renderReferenceScene(sceneId, { describe: false, backgroundOnly: true }), id);
        await writeFile(`${WORK_DIRECTORY}/${id}-background.png`, Buffer.from(background.image, 'base64'));
      }
      const bakeNote = result.bake?.report.refused ? `, bake REFUSED, drawn unbaked: ${result.bake.report.refused}` : result.bake ? `, bake ${result.bake.seconds.toFixed(1)} s, ${result.bake.report.texels} texels${result.bake.report.used ? ` (used ${result.bake.report.used.samples} samples, ${result.bake.report.used.bounces} bounces, ${result.bake.report.used.texelsPerUnit} texels per unit${result.bake.report.reduced ? ', reduced' : ''})` : ''}` : '';
      const probeNote = result.probes ? `, probes ${result.probes.report.placed.length} on ${result.probes.report.partsWithProbe} parts` : '';
      const floorSkyNote = result.floorSky ? `, floor sky ${result.floorSky.reason ?? `${result.floorSky.texels} texels, mean visibility ${result.floorSky.meanVisibility?.toFixed(3)}, ${result.floorSky.rays} rays, ${result.floorSky.seconds.toFixed(2)} s`}` : '';
      console.log(`${id} on ${backend}: ${Math.round(performance.now() - started)} ms${bakeNote}${probeNote}${floorSkyNote}`);
    }
    if (errors.length) throw new Error(errors.join('\n'));
  } finally {
    await browser.close();
  }
}

async function renderPathTracerScenes(serverUrl) {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: BACKEND_ARGUMENTS[pathTracerBackend === 'gpu' ? 'gpu' : 'cpu'] });
  const timings = {};
  try {
    const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });
    page.setDefaultTimeout(0);
    await page.goto(`${serverUrl}/bench/reference/harness.html`, { timeout: PAGE_LOAD_TIMEOUT });
    await page.waitForFunction(() => window.renderReferencePathTraced, null, { timeout: PAGE_LOAD_TIMEOUT });
    const sceneIds = await page.evaluate(() => window.referenceSceneIds);
    for (const id of sceneIds) {
      if (onlyScenes && !onlyScenes.includes(id)) continue;
      const options = { width: WIDTH, height: HEIGHT, samples: pathTracerSamples, maxSeconds: 1800, backend: pathTracerBackend, ...(pathTracerNoiseThreshold === undefined ? {} : { noiseThreshold: pathTracerNoiseThreshold }) };
      const result = await page.evaluate(([sceneId, tracerOptions]) => window.renderReferencePathTraced(sceneId, tracerOptions), [id, options]);
      await writeFile(`${WORK_DIRECTORY}/${id}-pathtracer${pathTracerBackend === 'gpu' ? '-gpu' : ''}.png`, Buffer.from(result.image, 'base64'));
      timings[id] = { seconds: Number(result.report.seconds.toFixed(1)), samples: result.report.samples, averageSamples: Number(result.report.averageSamples.toFixed(1)), ignored: result.report.ignored };
      console.log(`${id} path traced: ${timings[id].seconds} s at ${timings[id].samples} samples`);
    }
  } finally {
    await browser.close();
  }
  await writeFile(`${WORK_DIRECTORY}/pathtracer${pathTracerBackend === 'gpu' ? '-gpu' : ''}-timings.json`, JSON.stringify(timings, null, 1));
}

function runChecked(command, commandArguments) {
  const result = spawnSync(command, commandArguments, { stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8', maxBuffer: 1 << 28, env: { ...process.env, ...(noGpu ? { CYCLES_DEVICE: 'CPU' } : {}) } });
  const lines = result.stdout.split('\n').filter(line => !/^(Fra:|Saved:|Time:|\s*$)/.test(line));
  console.log(lines.slice(-30).join('\n'));
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status}.`);
}

setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL);
await mkdir(`${WORK_DIRECTORY}/scenes`, { recursive: true });

if (pathTracerFlag && !scoreOnly) {
  const server = await createServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'silent' });
  await server.listen();
  try {
    await renderPathTracerScenes(`http://127.0.0.1:${server.httpServer.address().port}`);
  } finally {
    await server.close();
  }
}

if (!scoreOnly && !pathTracerFlag) {
  const server = await createServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'silent' });
  await server.listen();
  const graphics = {};
  try {
    const serverUrl = `http://127.0.0.1:${server.httpServer.address().port}`;
    await renderBackend('gpu', serverUrl, graphics);
    if (!skipCpu) await renderBackend('cpu', serverUrl, graphics);
  } finally {
    await server.close();
  }
  await writeFile(`${WORK_DIRECTORY}/graphics.json`, JSON.stringify(graphics, null, 1));
  if (!skipBlender) {
    const sceneArguments = onlyScenes ?? [];
    const viewTransformArguments = viewTransform ? ['--view-transform', BLENDER_VIEW_TRANSFORMS[viewTransform]] : [];
    runChecked(BLENDER, ['-b', '--factory-startup', '-t', '6', '--python', 'bench/reference/render-blender.py', '--', WORK_DIRECTORY, ...viewTransformArguments, ...sceneArguments]);
  }
}

if (viewTransform) {
  runChecked('uv', [
    'run', '--no-project', '--python', '3.12', '--with', 'flip-evaluator', '--with', 'pillow', '--with', 'numpy',
    'python', '-I', 'bench/reference/view-transform-score.py', WORK_DIRECTORY, OUTPUT_DIRECTORY, viewTransform, ...(onlyScenes ?? []),
  ]);
}

if ((!onlyScenes && !skipCpu) || pathTracerFlag || bakeScoreRun) {
  runChecked('uv', [
    'run', '--no-project', '--python', '3.12', '--with', 'flip-evaluator', '--with', 'pillow', '--with', 'numpy',
    'python', '-I', 'bench/reference/score.py', WORK_DIRECTORY, bakeScoreRun && !bakeScoreIsBaseline ? WORK_DIRECTORY : OUTPUT_DIRECTORY, ...(pathTracerFlag ? ['--path-tracer', ...(pathTracerBackend === 'gpu' ? ['--gpu-tracer'] : [])] : []), ...(bakeScoreRun ? ['--bake', bakedSceneIds.join(',')] : []), ...(sceneSet ? [`--${sceneSet}`] : []),
  ]);
  if (bakeScoreRun && !bakeScoreIsBaseline && !bakeVariantFlags.some(flag => argumentsGiven.includes(flag))) {
    const comparison = spawnSync('node', ['bench/reference/compare-scores.mjs', `${WORK_DIRECTORY}/bake.json`], { stdio: 'inherit' });
    if (comparison.status !== 0) process.exitCode = 1;
  }
}
else {
  // Scoring reads every scene in the work directory, so a run of one scene would mix new and old renders; it leaves the scores as they were.
  console.log('--scene renders one scene and does not score it. Run without --scene to rescore; the numbers in baseline.json are unchanged.');
}
