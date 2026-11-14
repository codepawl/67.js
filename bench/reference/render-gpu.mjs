// Draws chosen reference scenes with Crucible on the GPU only, into a directory of your choice, with measurement switches. No Blender, no scoring.
//   node bench/reference/render-gpu.mjs <output directory> <scene id>,<scene id> [--ambient <scale>] [--fill <scale>] [--key <scale>]
//     [--bloom <strength,threshold,radius>] [--ambient-occlusion <strength>] [--ambient-occlusion-radius <units>] [--reversed-depth] [--sun-bounce <strength>] [--sun-bounce-range <k>] [--sun-bounce-gain <g>] [--cpu]
// Files are <output directory>/<scene id>-gpu.png, the names measure-depth.py and score.py read. Used to find what makes shadows light (issue #197).
// --bloom <strength,threshold,radius> draws with that bloom; --bake-preset <draft|standard|fine> bakes as a recipe does (and prints the refusal, e.g. over 256 parts); a scene whose map has a bounce colour prints it.
import { mkdir, writeFile } from 'node:fs/promises';
import { constants, setPriority } from 'node:os';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const WIDTH = 960;
const HEIGHT = 540;
const argumentsGiven = process.argv.slice(2);
const outputDirectory = resolve(argumentsGiven[0]);
const sceneIds = argumentsGiven[1].split(',');
// Ids of the grand options end in -a, -b or -c and live in their own scene set.
const setOf = id => (/-[abc]$/.test(id) ? 'grand' : null);
const waterIndex = argumentsGiven.indexOf('--water');
const waterOption = waterIndex >= 0 ? argumentsGiven[waterIndex + 1] : null;
const reversedDepth = argumentsGiven.includes('--reversed-depth');

function bakePresetOption() {
  const index = argumentsGiven.indexOf('--bake-preset');
  return index >= 0 ? { preset: argumentsGiven[index + 1] } : null;
}

function bloomOption() {
  const index = argumentsGiven.indexOf('--bloom');
  if (index < 0) return null;
  const [strength, threshold, radius] = argumentsGiven[index + 1].split(',').map(Number);
  return { strength, threshold, radius };
}

function numberAfter(flag) {
  const index = argumentsGiven.indexOf(flag);
  return index >= 0 ? Number(argumentsGiven[index + 1]) : null;
}

const sunBounce = numberAfter('--sun-bounce');
const sunBounceRange = numberAfter('--sun-bounce-range');
const sunBounceGain = numberAfter('--sun-bounce-gain');

// --fog '<json>' merges those fields into the scene's volumeFog, for example --fog '{"noiseAmount":1,"warp":0.8}'.
function fogOption() {
  const index = argumentsGiven.indexOf('--fog');
  return index >= 0 ? JSON.parse(argumentsGiven[index + 1]) : null;
}

const options = {
  ambient: numberAfter('--ambient'),
  fill: numberAfter('--fill'),
  key: numberAfter('--key'),
  ambientOcclusion: numberAfter('--ambient-occlusion') ?? 0,
  ambientOcclusionRadius: numberAfter('--ambient-occlusion-radius') ?? 0.5,
  bloom: bloomOption(),
  volumeFog: fogOption(),
  bake: bakePresetOption(),
};

setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL);
await mkdir(outputDirectory, { recursive: true });
const server = await createServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'silent' });
await server.listen();
const serverUrl = `http://127.0.0.1:${server.httpServer.address().port}`;
const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--enable-webgl', '--ignore-gpu-blocklist', '--disable-renderer-backgrounding', ...(argumentsGiven.includes('--cpu') ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : [])] });
try {
  const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });
  page.on('pageerror', error => console.log('PAGE ERROR', error.message));
  for (const id of sceneIds) {
    await page.goto(`${serverUrl}/bench/reference/harness.html?${[setOf(id) ? `set=${setOf(id)}` : '', waterOption ? `water=${waterOption}` : '', reversedDepth ? 'reversedDepth=on' : '', sunBounce === null ? '' : `sunBounce=${sunBounce}`, sunBounceRange === null ? '' : `sunBounceRange=${sunBounceRange}`, sunBounceGain === null ? '' : `sunBounceGain=${sunBounceGain}`].filter(Boolean).join('&')}`, { timeout: 180000 });
    await page.waitForFunction(() => window.renderReferenceScene, null, { timeout: 180000 });
    const result = await page.evaluate(([sceneId, renderOptions]) => window.renderReferenceScene(sceneId, { describe: false, ...renderOptions }), [id, options]);
    if (result.glError !== 0) throw new Error(`${id} gave WebGL error ${result.glError}.`);
    await writeFile(`${outputDirectory}/${id}-gpu.png`, Buffer.from(result.image, 'base64'));
    if (result.bounce) console.log('bounce', JSON.stringify(result.bounce));
    if (result.bake) console.log(JSON.stringify(result.bake).slice(0, 600));
    if (process.env.SHOW_SUN_BOUNCE_LIGHTS) console.log(JSON.stringify(await page.evaluate(() => window.sunBounceLights)));
    console.log(`${id} drawn, sun bounce search ${((await page.evaluate(() => window.sunBounceSeconds)) ?? 0).toFixed(3)} s`);
  }
} finally {
  await browser.close();
  await server.close();
}
