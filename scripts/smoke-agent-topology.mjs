import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { constants, setPriority } from 'node:os';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { createAgentPreviewFixture } from './agent-preview-fixture.mjs';
import { createAgentRuntime } from './agent-runtime.mjs';

setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL);
const backend = process.argv[2] ?? 'gpu';
assert.ok(['gpu', 'cpu'].includes(backend));
await mkdir('artifacts', { recursive: true });
const fixture = createAgentPreviewFixture();
const harness = `<!doctype html><html><head><style>html,body{margin:0;height:100%;background:#182126}canvas{width:100vw;height:100vh;display:block}</style></head><body><canvas></canvas><script type="module">
import {createAgentScene,loadAllAgentSceneModules} from '/src/agent-scene.js';
import {CrucibleRenderer} from '/src/renderer.js';
await loadAllAgentSceneModules();
const recipe=${JSON.stringify(fixture)};
const session=createAgentScene({...recipe,geometries:[],materials:[],nodes:[]});
const renderer=new CrucibleRenderer(document.querySelector('canvas'),session.parts,{ground:false,hdr:true,samples:4,pixelRatio:1,memoryBudgetMiB:192});
const counters={buffers:0,arrays:0,textures:0,framebuffers:0,renderbuffers:0,staticUploads:0,dynamicUploads:0};
const liveBuffers=new Set();
const context=renderer.context;
for(const [method,field] of [['createBuffer','buffers'],['createVertexArray','arrays'],['createTexture','textures'],['createFramebuffer','framebuffers'],['createRenderbuffer','renderbuffers']]) {
  const original=context[method].bind(context);
  context[method]=(...parameters)=>{
    counters[field]++;
    const result=original(...parameters);
    if(method==='createBuffer') liveBuffers.add(result);
    return result;
  };
}
const originalDelete=context.deleteBuffer.bind(context);
context.deleteBuffer=buffer=>{
  liveBuffers.delete(buffer);
  return originalDelete(buffer);
};
const originalUpload=context.bufferData.bind(context);
context.bufferData=(target,data,usage)=>{
  counters[usage===context.STATIC_DRAW?'staticUploads':'dynamicUploads']++;
  return originalUpload(target,data,usage);
};
function draw() {
  renderer.resize();
  renderer.updateParts(session.parts);
  renderer.render({...session.camera,effects:{bloom:{strength:0.12,threshold:1,radius:1},grain:0,vignette:0}});
}
function pixels() {
  const data=new Uint8Array(context.drawingBufferWidth*context.drawingBufferHeight*4);
  context.readPixels(0,0,context.drawingBufferWidth,context.drawingBufferHeight,context.RGBA,context.UNSIGNED_BYTE,data);
  return data;
}
session.apply([...recipe.geometries.map(geometry=>({type:'add-geometry',geometry})),...recipe.materials.map(material=>({type:'add-material',material})),...recipe.nodes.map(node=>({type:'add-node',node}))],{expectedRevision:0});
renderer.replaceParts(session.parts);
draw();
window.__topology={recipe,session,renderer,draw,pixels,counters,liveBuffers};
</script></body></html>`;
await writeFile('artifacts/agent-topology-harness.html', harness);
const server = await createServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'silent' });
let browser;
try {
  await server.listen();
  const port = server.httpServer.address().port;
  const args = ['--enable-webgl', '--ignore-gpu-blocklist', '--disable-renderer-backgrounding'];
  if (backend === 'cpu') args.push('--use-angle=swiftshader', '--enable-unsafe-swiftshader');
  browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args });
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${port}/artifacts/agent-topology-harness.html`);
  await page.waitForFunction(() => window.__topology);
  await page.screenshot({ path: 'artifacts/agent-topology-built.png' });
  const result = await page.evaluate(() => {
    const { session, renderer, draw, pixels, counters, liveBuffers } = window.__topology;
    draw();
    const before = pixels();
    const checkpoint = session.checkpoint();
    const geometryBuffers = renderer.geometryBuffers.get(session.parts.find(part => part.name === 'fin-0').geometry);
    const originalBuffers = [...geometryBuffers.values()];
    const firstCounters = { ...counters };
    session.apply([{ type: 'add-node', node: { id: 'extra-fin', geometry: 'fin', material: 'brass', translation: [-0.9, 0.8, 0.1], scale: [0.5, 0.5, 0.5] } }], { expectedRevision: session.revision });
    renderer.replaceParts(session.parts);
    draw();
    const after = pixels();
    const added = Object.fromEntries(Object.entries(counters).map(([key, count]) => [key, count - firstCounters[key]]));
    const sharedBuffersRetained = originalBuffers.every(buffer => liveBuffers.has(buffer));
    let changedChannels = 0;
    for (let index = 0; index < before.length; index++) {
      if (before[index] !== after[index]) changedChannels++;
    }
    session.restore(checkpoint, { expectedRevision: session.revision });
    renderer.replaceParts(session.parts);
    draw();
    const restored = pixels();
    const exactRestore = restored.every((value, index) => value === before[index]);
    session.releaseCheckpoint(checkpoint);
    const previousBatches = [...renderer.batches];
    const previousBudget = renderer.memoryBudgetMiB;
    renderer.memoryBudgetMiB = renderer.memoryPlan.estimatedBytes / 1048576;
    const staged = { ...session.parts[0], name: 'budget-probe' };
    const allocationCount = counters.buffers;
    let budgetRejected = false;
    try {
      renderer.replaceParts([...session.parts, staged]);
    } catch (error) {
      budgetRejected = /staged replacement/.test(error.message);
    }
    renderer.memoryBudgetMiB = previousBudget;
    const noFailedAllocations = counters.buffers === allocationCount;
    const previousBatchesRetained = previousBatches.every((batch, index) => batch === renderer.batches[index]);
    draw();
    const afterRejected = pixels();
    const failureFrameRetained = afterRejected.every((value, index) => value === before[index]);
    const debug = renderer.context.getExtension('WEBGL_debug_renderer_info');
    const graphics = renderer.context.getParameter(debug.UNMASKED_RENDERER_WEBGL);
    const glError = renderer.context.getError();
    window.__topology.finalImage = document.querySelector('canvas').toDataURL('image/png');
    const estimatedBytes = renderer.memoryPlan.estimatedBytes;
    renderer.dispose();
    return { changedChannels, added, sharedBuffersRetained, exactRestore, budgetRejected, noFailedAllocations, previousBatchesRetained, failureFrameRetained, liveBuffers: liveBuffers.size, graphics, glError, estimatedBytes };
  });
  assert.deepEqual(errors, []);
  assert.match(result.graphics, backend === 'gpu' ? /NVIDIA/ : /SwiftShader/);
  assert.ok(result.changedChannels > 1000);
  assert.deepEqual(result.added, { buffers: 1, arrays: 1, textures: 0, framebuffers: 0, renderbuffers: 0, staticUploads: 0, dynamicUploads: 1 });
  for (const field of ['sharedBuffersRetained', 'exactRestore', 'budgetRejected', 'noFailedAllocations', 'previousBatchesRetained', 'failureFrameRetained']) assert.equal(result[field], true, field);
  assert.equal(result.liveBuffers, 0);
  assert.equal(result.glError, 0);
  const data = await page.evaluate(() => window.__topology.finalImage);
  await writeFile('artifacts/agent-topology-restored.png', Buffer.from(data.split(',')[1], 'base64'));
  await writeFile(`artifacts/agent-topology-${backend}.json`, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  await browser?.close();
  await server.close();
}

// A smaller look must recover an already committed edit whose GPU staging budget failed.
const runtime = createAgentRuntime({ backend: 'cpu', memory: 32 });
try {
  const initial = await runtime.create({ recipe: { ...fixture, geometries: [], materials: [], nodes: [] } });
  const { sessionId } = initial;
  await runtime.look({ sessionId, width: 1024, height: 1024 });
  const edited = await runtime.apply({ sessionId, expectedRevision: 0, operations: [
    ...fixture.geometries.map(geometry => ({ type: 'add-geometry', geometry })),
    ...fixture.materials.map(material => ({ type: 'add-material', material })),
    ...fixture.nodes.map(node => ({ type: 'add-node', node })),
  ] });
  assert.equal(edited.committed, true);
  assert.equal(edited.revision, 1);
  assert.equal(edited.renderSucceeded, false);
  assert.match(edited.renderError, /staged replacement/);
  const recovered = await runtime.look({ sessionId, width: 128, height: 128 });
  assert.equal(recovered.metadata.revision, 1);
  assert.equal(recovered.metadata.geometryBuffers, 7);
  assert.equal(recovered.metadata.width, 128);
  assert.ok(recovered.metadata.estimatedBytes < 32 * 1048576);
  assert.equal((await runtime.inspect({ sessionId })).counts.parts, 19);
  console.log(JSON.stringify({ stagingRecovery: true, revision: 1, preview: [128, 128], budgetMiB: 32 }));
} finally {
  await runtime.close();
}
