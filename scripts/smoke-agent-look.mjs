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
recipe.geometries.push({ id: 'floor', type: 'box', bevel: 0 });
recipe.materials.push({ id: 'floor', color: [0.12, 0.16, 0.18], roughness: 0.75 });
recipe.nodes.push({ id: 'floor', geometry: 'floor', material: 'floor', translation: [0, -0.08, 0], scale: [7, 0.15, 7] });
recipe.environment = {
  world: true, lightDirection: [-3, 6, 4], keyColor: [3, 2.5, 1.8],
  fillIntensity: 0.2, ambientIntensity: 0.3,
  skyTop: [0.035, 0.06, 0.09], skyBottom: [0.15, 0.2, 0.23],
  fogDensity: 0,
  pointLights: [{ position: [0, 1.4, 0], color: [0.15, 1, 0.7], intensity: 3, radius: 0.3 }],
};
recipe.shadow = { extent: 5, far: 20 };
const harness = `<!doctype html><html><head><style>html,body{margin:0;height:100%}canvas{width:100vw;height:100vh;display:block}</style></head><body><canvas></canvas><script type="module">
import {createAgentScene,loadAllAgentSceneModules} from '/src/agent-scene.js';
import {resolveAgentShadow} from '/src/agent-look.js';
import {CrucibleRenderer} from '/src/renderer.js';
await loadAllAgentSceneModules();
const session=createAgentScene(${JSON.stringify(recipe)});
const renderer=new CrucibleRenderer(document.querySelector('canvas'),session.parts,{ground:false,hdr:true,depth:true,samples:1,pixelRatio:1,memoryBudgetMiB:192});
const counters={buffers:0,textures:0,framebuffers:0,renderbuffers:0};
const context=renderer.context;
for(const [method,field] of [['createBuffer','buffers'],['createTexture','textures'],['createFramebuffer','framebuffers'],['createRenderbuffer','renderbuffers']]) {
  const original=context[method].bind(context);
  context[method]=(...parameters)=>{counters[field]++;return original(...parameters);};
}
let shadowKey;
function draw() {
  const environment=session.environment;
  const effects=session.effects;
  const nextKey=JSON.stringify([environment.lightDirection,session.shadow]);
  if(shadowKey!==nextKey) {
    renderer.shadowBounds=resolveAgentShadow(session.shadow,environment.lightDirection);
    renderer.shadowsDirty=true;
    shadowKey=nextKey;
  }
  renderer.world=environment.world;
  renderer.resize();
  renderer.updateParts(session.parts);
  renderer.render({...session.camera,environment,effects,exposure:effects.exposure,time:0});
}
function pixels() {
  const result=new Uint8Array(context.drawingBufferWidth*context.drawingBufferHeight*4);
  context.readPixels(0,0,context.drawingBufferWidth,context.drawingBufferHeight,context.RGBA,context.UNSIGNED_BYTE,result);
  return result;
}
draw();
window.__lookProof={session,renderer,draw,pixels,counters};
</script></body></html>`;
await writeFile('artifacts/agent-look-harness.html', harness);
const server = await createServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'silent' });
let browser;
try {
  await server.listen();
  const args = ['--enable-webgl', '--ignore-gpu-blocklist', '--disable-renderer-backgrounding'];
  if (backend === 'cpu') args.push('--use-angle=swiftshader', '--enable-unsafe-swiftshader');
  browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args });
  const page = await browser.newPage({ viewport: { width: 768, height: 512 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/artifacts/agent-look-harness.html`);
  await page.waitForFunction(() => window.__lookProof);
  await page.screenshot({ path: `artifacts/agent-look-${backend}-before.png` });
  const result = await page.evaluate(() => {
    const { session, renderer, draw, pixels, counters } = window.__lookProof;
    draw();
    const before = pixels();
    const checkpoint = session.checkpoint();
    const parts = session.parts;
    const originalCounters = { ...counters };
    session.apply([
      { type: 'set-environment', environment: {
        lightDirection: [0, 1, 0], keyColor: [1.1, 1.8, 4], keyIntensity: 1.5,
        pointLights: [{ position: [-1, 1.4, 1], color: [1, 0.3, 0.04], intensity: 12, radius: 0.2 }],
        volumeFog: { density: 0.12, minimum: [-4, 0, -4], maximum: [4, 4, 4], noiseAmount: 0.4, steps: 16 },
      } },
      { type: 'set-effects', effects: { exposure: 0.85, contrast: 1.08, bloom: { strength: 0.25 } } },
      { type: 'set-shadow', shadow: { distance: 9, extent: 5, near: 0.1, far: 20 } },
    ], { expectedRevision: 0 });
    draw();
    const fog = pixels();
    const differences = data => data.reduce((count, value, index) => count + Number(value !== before[index]), 0);
    const after = document.querySelector('canvas').toDataURL('image/png').split(',')[1];
    session.apply([{ type: 'set-environment', environment: { volumeFog: { density: 0 } } }], { expectedRevision: 1 });
    draw();
    const dry = pixels();
    const fogChannels = fog.reduce((count, value, index) => count + Number(value !== dry[index]), 0);
    session.restore(checkpoint, { expectedRevision: 2 });
    draw();
    const restored = pixels();
    const debug = renderer.context.getExtension('WEBGL_debug_renderer_info');
    return {
      after, changedChannels: differences(fog), fogChannels,
      exactRestore: restored.every((value, index) => value === before[index]),
      retainedParts: parts === session.parts, topologyRevision: session.topologyRevision,
      allocations: Object.fromEntries(Object.entries(counters).map(([field, count]) => [field, count - originalCounters[field]])),
      glError: renderer.context.getError(), hdr: renderer.capabilities.hdr, depth: renderer.depth,
      graphics: renderer.context.getParameter(debug ? debug.UNMASKED_RENDERER_WEBGL : renderer.context.RENDERER),
      estimatedBytes: renderer.memoryPlan.estimatedBytes,
    };
  });
  await writeFile(`artifacts/agent-look-${backend}-after.png`, Buffer.from(result.after, 'base64'));
  delete result.after;
  await writeFile(`artifacts/agent-look-${backend}.json`, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  assert.deepEqual(errors, []);
  assert.equal(result.exactRestore, true);
  assert.equal(result.retainedParts, true);
  assert.equal(result.topologyRevision, 0);
  assert.equal(result.glError, 0);
  assert.equal(result.hdr, true);
  assert.equal(result.depth, true);
  assert.ok(result.changedChannels > 10000);
  assert.ok(result.fogChannels > 1000);
  assert.ok(Object.values(result.allocations).every(count => count === 0));
  if (backend === 'gpu') assert.doesNotMatch(result.graphics, /swiftshader|llvmpipe|software/i);
  await page.evaluate(() => window.__lookProof.renderer.dispose());
} finally {
  await browser?.close();
  await server.close();
}
