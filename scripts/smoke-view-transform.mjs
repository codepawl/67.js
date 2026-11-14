// Draws the agent preview fixture through one renderer while a recipe switches environment.viewTransform and environment.look,
// in HDR (the curve runs in the post pass) and in 8-bit (it runs in the main program). The three curves must give different
// pixels, the look must change them again, going back to aces must restore the first picture exactly, and the shaders must
// compile without a console error or warning: npm run smoke:view-transform [cpu|gpu]
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { constants, setPriority } from 'node:os';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { createAgentPreviewFixture } from './agent-preview-fixture.mjs';

setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL);
const backend = process.argv[2] ?? 'cpu';
assert.ok(['cpu', 'gpu'].includes(backend));
await mkdir('artifacts', { recursive: true });
const recipe = createAgentPreviewFixture();
recipe.environment = { world: true, lightDirection: [-3, 6, 4], keyColor: [4, 3.4, 2.6], fillIntensity: 0.25, ambientIntensity: 0.35, skyTop: [0.2, 0.35, 0.6], skyBottom: [0.7, 0.75, 0.8], fogDensity: 0 };
const VARIANTS = [
  { name: 'aces', environment: { viewTransform: 'aces' } },
  { name: 'agx', environment: { viewTransform: 'agx' } },
  { name: 'neutral', environment: { viewTransform: 'neutral' } },
  { name: 'agx+warm', environment: { viewTransform: 'agx', look: 'warm' } },
  { name: 'aces again', environment: { viewTransform: 'aces', look: null } },
];

function harness(hdr) {
  return `<!doctype html><html><body style="margin:0"><canvas style="width:384px;height:256px;display:block"></canvas><script type="module">
import {createAgentScene,loadAllAgentSceneModules} from '/src/agent-scene.js';
import {CrucibleRenderer} from '/src/renderer.js';
await loadAllAgentSceneModules();
const session=createAgentScene(${JSON.stringify(recipe)});
const renderer=new CrucibleRenderer(document.querySelector('canvas'),session.parts,{ground:false,hdr:${hdr},samples:1,pixelRatio:1});
renderer.resize();
const context=renderer.context;
function draw(){
  renderer.render({...session.camera,environment:session.environment,effects:session.effects,exposure:session.effects.exposure,time:0});
  const pixels=new Uint8Array(context.drawingBufferWidth*context.drawingBufferHeight*4);
  context.readPixels(0,0,context.drawingBufferWidth,context.drawingBufferHeight,context.RGBA,context.UNSIGNED_BYTE,pixels);
  return pixels;
}
window.__viewTransformProof={session,renderer,draw};
</script></body></html>`;
}

function measure(pixels) {
  const sums = [0, 0, 0];
  for (let offset = 0; offset < pixels.length; offset += 4) for (let channel = 0; channel < 3; channel++) sums[channel] += pixels[offset + channel];
  return sums.map(sum => Math.round(sum / (pixels.length / 4) * 10) / 10);
}

const server = await createServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'silent' });
let browser;
const report = {};
try {
  await server.listen();
  const args = ['--enable-webgl', '--ignore-gpu-blocklist', '--disable-renderer-backgrounding'];
  if (backend === 'cpu') args.push('--use-angle=swiftshader', '--enable-unsafe-swiftshader');
  browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args });
  for (const hdr of [true, false]) {
    const label = hdr ? 'hdr' : 'sdr';
    await writeFile(`artifacts/view-transform-${label}.html`, harness(hdr));
    const page = await browser.newPage({ viewport: { width: 384, height: 256 } });
    const problems = [];
    page.on('pageerror', error => problems.push(error.message));
    // The driver's ReadPixels stall note and the browser's favicon request are not shader problems.
    const noise = /GL Driver Message \(OpenGL, Performance|status of 404/;
    page.on('console', message => { if (['error', 'warning'].includes(message.type()) && !noise.test(message.text())) problems.push(message.text()); });
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/artifacts/view-transform-${label}.html`);
    await page.waitForFunction(() => window.__viewTransformProof, null, { timeout: 120000 });
    const result = await page.evaluate(variants => {
      const { session, renderer, draw } = window.__viewTransformProof;
      const frames = [];
      for (const variant of variants) {
        session.apply([{ type: 'set-environment', environment: variant.environment }], { expectedRevision: session.revision });
        frames.push({ name: variant.name, pixels: Array.from(draw()) });
      }
      const glError = renderer.context.getError();
      renderer.dispose();
      return { frames, glError };
    }, VARIANTS);
    const frames = result.frames.map(frame => ({ name: frame.name, pixels: Uint8Array.from(frame.pixels) }));
    const means = Object.fromEntries(frames.map(frame => [frame.name, measure(frame.pixels)]));
    report[label] = { means, glError: result.glError, problems };
    // Mean absolute difference per colour channel, in 0 to 255 steps: two curves can share a channel mean and still differ.
    const differs = (first, second) => {
      let total = 0;
      for (let offset = 0; offset < first.length; offset += 4) for (let channel = 0; channel < 3; channel++) total += Math.abs(first[offset + channel] - second[offset + channel]);
      return total / (first.length / 4 * 3) >= 1;
    };
    const byName = Object.fromEntries(frames.map(frame => [frame.name, frame.pixels]));
    assert.deepEqual(problems, [], `${label}: console errors or warnings`);
    assert.equal(result.glError, 0, `${label}: WebGL error`);
    assert.ok(differs(byName.aces, byName.agx), `${label}: agx looks like aces`);
    assert.ok(differs(byName.aces, byName.neutral), `${label}: neutral looks like aces`);
    assert.ok(differs(byName.agx, byName.neutral), `${label}: neutral looks like agx`);
    assert.ok(differs(byName.agx, byName['agx+warm']), `${label}: the warm look changes nothing`);
    assert.ok(byName['aces again'].every((value, index) => value === byName.aces[index]), `${label}: going back to aces does not restore the picture`);
    await page.close();
  }
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser?.close();
  await server.close();
}
