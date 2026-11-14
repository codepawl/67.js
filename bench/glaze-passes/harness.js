// Runs in the page. Loads one scene file the way src/file-scene.js does, then times each pass of Glaze on the GPU.
import { CrucibleRenderer } from '../../src/renderer.js';
import { createSharedTextures, loadGltf } from '../../src/gltf.js';
import { loadHdri } from '../../src/hdri.js';
import { createCascadedShadows } from '../../src/cascaded-shadows.js';

const WARMUP_FRAMES = 20;
const NANOSECONDS_PER_MILLISECOND = 1e6;
const ONE_PIXEL = new Uint8Array(4);
const OTHER_SEGMENT = 'opaque or other';
const TIMED_METHODS = ['createShadowMap', 'updateLocalShadows', 'drawEnvironmentBackground', 'drawTranslucent', 'drawBlendBatches', 'resolveFrame'];

function median(values) {
  const sorted = [...values].sort((first, second) => first - second);
  return sorted[Math.floor(sorted.length / 2)];
}

// One GPU timer query may run at a time, so the frame is cut into consecutive segments: each timed method closes the
// segment that was open and opens its own, and the code after it belongs to the segment named OTHER_SEGMENT.
function createSegmentTimer(context) {
  const extension = context.getExtension('EXT_disjoint_timer_query_webgl2');
  if (!extension) throw new Error('This browser has no EXT_disjoint_timer_query_webgl2.');
  let open = null;
  let frameSegments = [];
  const finishedFrames = [];
  return {
    start(name) {
      this.stop();
      const query = context.createQuery();
      context.beginQuery(extension.TIME_ELAPSED_EXT, query);
      open = { name, query };
    },
    stop() {
      if (!open) return;
      context.endQuery(extension.TIME_ELAPSED_EXT);
      frameSegments.push(open);
      open = null;
    },
    // Closes the frame: its queries wait in line until the GPU has finished them.
    endFrame() {
      this.stop();
      finishedFrames.push(frameSegments);
      frameSegments = [];
    },
    // Returns the per-segment milliseconds of every frame whose queries are all ready, oldest first. A frame the GPU
    // reported as disjoint is dropped.
    drain() {
      const ready = [];
      while (finishedFrames.length) {
        const segments = finishedFrames[0];
        if (!segments.every(({ query }) => context.getQueryParameter(query, context.QUERY_RESULT_AVAILABLE))) break;
        const disjoint = context.getParameter(extension.GPU_DISJOINT_EXT);
        const milliseconds = {};
        for (const { name, query } of segments) {
          milliseconds[name] = (milliseconds[name] ?? 0) + context.getQueryParameter(query, context.QUERY_RESULT) / NANOSECONDS_PER_MILLISECOND;
          context.deleteQuery(query);
        }
        finishedFrames.shift();
        if (!disjoint) ready.push(milliseconds);
      }
      return ready;
    },
    pendingFrames: () => finishedFrames.length,
  };
}

function wrapSegment(owner, methodName, timer) {
  const original = owner[methodName].bind(owner);
  owner[methodName] = (...parameters) => {
    timer.start(methodName);
    const result = original(...parameters);
    timer.start(OTHER_SEGMENT);
    return result;
  };
}

const TRIVIAL_FRAGMENT = '#version 300 es\nprecision highp float;\nout vec4 outputColour;\nvoid main() { outputColour = vec4(1.0); }';
const TRIVIAL_VERTEX = '#version 300 es\nprecision highp float;\nlayout(location=0) in vec3 position;\nlayout(location=2) in mat4 instanceMatrix;\nuniform mat4 viewProjection;\nvoid main() { gl_Position = viewProjection * (instanceMatrix * vec4(position, 1.0)); }';

// Experiment only: swaps the colour pass shaders for trivial ones to find how much of the frame is the shaders.
function replaceColourShaders(replaceVertex) {
  const original = WebGL2RenderingContext.prototype.shaderSource;
  WebGL2RenderingContext.prototype.shaderSource = function shaderSource(shader, source) {
    const isColourFragment = source.includes('worldPosition') && source.includes('shadowPosition') && source.includes('out vec4') && source.includes('baseColor');
    const isColourVertex = source.includes('layout(location=2) in mat4 instanceMatrix') && source.includes('gl_Position = viewProjection * world;') && source.includes('out vec4 shadowPosition');
    if (isColourFragment) return original.call(this, shader, TRIVIAL_FRAGMENT);
    if (replaceVertex && isColourVertex) return original.call(this, shader, TRIVIAL_VERTEX);
    return original.call(this, shader, source);
  };
}

window.measureScene = async function measureScene({ description, glbUrl, hdriUrl, frames = 200, capture = false, alternate = false, segmented = true, width = 1280, height = 720, rendererOverrides = {}, experiment = null }) {
  const canvas = document.querySelector('#viewport');
  const experiments = new Set(String(experiment ?? '').split(','));
  if (experiments.has('no-invariant')) {
    const originalSource = WebGL2RenderingContext.prototype.shaderSource;
    WebGL2RenderingContext.prototype.shaderSource = function shaderSource(shader, source) {
      return originalSource.call(this, shader, source.replace('invariant gl_Position;', ''));
    };
  }
  if (experiments.has('light-prepass-vertex')) {
    // Experiment only: the prepass program (the colour vertex shader that follows the colour fragment shader) gets a position-only vertex shader.
    const originalSource = WebGL2RenderingContext.prototype.shaderSource;
    let afterColourFragment = false;
    WebGL2RenderingContext.prototype.shaderSource = function shaderSource(shader, source) {
      if (source.includes('worldPosition') && source.includes('shadowPosition') && source.includes('baseColor') && source.includes('out vec4')) afterColourFragment = true;
      const isColourVertex = source.includes('gl_Position = viewProjection * world;') && source.includes('out vec4 shadowPosition');
      if (isColourVertex && afterColourFragment) {
        afterColourFragment = false;
        return originalSource.call(this, shader, TRIVIAL_VERTEX);
      }
      return originalSource.call(this, shader, source);
    };
  }
  if (experiment === 'trivial-fragment') replaceColourShaders(false);
  if (experiment === 'trivial-both') replaceColourShaders(true);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  description = { ...description, renderer: { ...(description.renderer ?? {}), ...rendererOverrides } };
  const [model, map] = await Promise.all([
    fetch(glbUrl).then(response => response.blob()),
    loadHdri(hdriUrl, description.hdriOptions ?? {}),
  ]);
  const asset = await loadGltf(model, { baseUrl: new URL('.', new URL(glbUrl, location.href)).href, sharedTextures: createSharedTextures(), ...(description.gltfOptions ?? {}) });
  const rendererOptions = description.renderer ?? {};
  const shadowCascades = rendererOptions.shadowCascades ? createCascadedShadows(rendererOptions.shadowCascades) : undefined;
  const renderer = new CrucibleRenderer(canvas, asset.parts, {
    ground: false, hdr: true, samples: 4, ...rendererOptions, shadowCascades,
    environment: { ...(rendererOptions.environment ?? {}), map },
  });
  const context = renderer.context;
  const timer = createSegmentTimer(context);
  // The renderer's own timer would open a query inside ours, and WebGL allows one at a time.
  renderer.gpuTimer = null;
  const frame = { exposure: description.exposure ?? 1, ...(description.frame ?? {}), eye: description.eye, target: description.target };
  if (experiment === 'discard') {
    // Vertex work only: the rasterizer throws every triangle away, so no pixel is shaded.
    const originalDraw = renderer.drawAlphaBatch.bind(renderer);
    renderer.drawAlphaBatch = (...parameters) => {
      context.enable(context.RASTERIZER_DISCARD);
      const result = originalDraw(...parameters);
      context.disable(context.RASTERIZER_DISCARD);
      return result;
    };
  }
  if (alternate) {
    // The depth prepass alone: the colour draws are skipped, to price the prepass by itself.
    const shadeBatch = renderer.drawShadedBatch.bind(renderer);
    renderer.drawShadedBatch = (...parameters) => (prepassOnly ? undefined : shadeBatch(...parameters));
  }
  if (segmented) {
    for (const methodName of TIMED_METHODS) wrapSegment(renderer, methodName, timer);
    if (renderer.shadowCascades) wrapSegment(renderer.shadowCascades, 'update', timer);
  }
  const perSegment = {};
  const wallMilliseconds = [];
  const totals = [];
  // With `alternate`, frames alternate between the depth prepass off and on, so both see the same load of a shared card.
  const alternating = { off: [], on: [], only: [] };
  const alternatingSegments = { off: {}, on: {}, only: {} };
  const frameModes = [];
  let prepassOnly = false;
  let framesSeen = 0;
  const record = (milliseconds) => {
    const mode = frameModes.shift();
    framesSeen++;
    if (framesSeen <= WARMUP_FRAMES) return;
    const total = Object.values(milliseconds).reduce((sum, value) => sum + value, 0);
    totals.push(total);
    for (const [name, value] of Object.entries(milliseconds)) (perSegment[name] ??= []).push(value);
    if (!alternate) return;
    alternating[mode].push(total);
    for (const [name, value] of Object.entries(milliseconds)) (alternatingSegments[mode][name] ??= []).push(value);
  };
  for (let index = 0; index < WARMUP_FRAMES + frames; index++) {
    const started = performance.now();
    const mode = ['off', 'on', 'only'][index % 3];
    if (alternate) {
      renderer.setDepthPrepass(mode !== 'off');
      prepassOnly = mode === 'only';
    }
    frameModes.push(mode);
    timer.start(segmented ? 'setup before first pass' : 'whole frame');
    renderer.render(frame);
    timer.endFrame();
    context.readPixels(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1, context.RGBA, context.UNSIGNED_BYTE, ONE_PIXEL);
    if (index >= WARMUP_FRAMES) wallMilliseconds.push(performance.now() - started);
    timer.drain().forEach(record);
  }
  for (let attempt = 0; attempt < 200 && timer.pendingFrames(); attempt++) {
    await new Promise(resolve => setTimeout(resolve, 10));
    timer.drain().forEach(record);
  }
  let capturedFrame = null;
  if (capture) {
    // One more frame, read back whole in the same task, so the canvas still holds it.
    renderer.render(frame);
    const pixels = new Uint8Array(canvas.width * canvas.height * 4);
    context.readPixels(0, 0, canvas.width, canvas.height, context.RGBA, context.UNSIGNED_BYTE, pixels);
    let binary = '';
    for (let offset = 0; offset < pixels.length; offset += 0x8000) binary += String.fromCharCode(...pixels.subarray(offset, offset + 0x8000));
    capturedFrame = btoa(binary);
  }
  const geometries = new Set(asset.parts.map(part => part.geometry));
  const geometryStats = {
    vertices: [...geometries].reduce((sum, geometry) => sum + geometry.positions.length / 3, 0),
    indices: [...geometries].reduce((sum, geometry) => sum + geometry.indices.length, 0),
    batches: renderer.batches.length,
    batchesWithFlushRanges: renderer.batches.filter(batch => batch.flushOrder?.ranges).length,
    flushRangeDraws: renderer.batches.reduce((sum, batch) => sum + (batch.flushOrder?.ranges?.length ?? 0), 0),
    batchIndexTotal: renderer.batches.reduce((sum, batch) => sum + batch.indexCount * batch.instanceCount, 0),
  };
  return {
    geometryStats,
    parts: asset.parts.length,
    canvas: [canvas.width, canvas.height],
    samples: totals.length,
    wallMedianMs: Number(median(wallMilliseconds).toFixed(3)),
    gpuTotalMedianMs: Number(median(totals).toFixed(3)),
    segmentMedianMs: Object.fromEntries(Object.entries(perSegment).map(([name, values]) => [name, Number(median(values).toFixed(3))])),
    depthPrepassActive: renderer.depthPrepassActive,
    alternating: alternate ? Object.fromEntries(['off', 'on', 'only'].map(mode => [mode, {
      gpuTotalMedianMs: Number(median(alternating[mode]).toFixed(3)),
      gpuTotalRangeMs: [Number(Math.min(...alternating[mode]).toFixed(3)), Number(Math.max(...alternating[mode]).toFixed(3))],
      segmentMedianMs: Object.fromEntries(Object.entries(alternatingSegments[mode]).map(([name, values]) => [name, Number(median(values).toFixed(3))])),
    }])) : undefined,
    pairedOnOverOffMedian: alternate ? Number(median(alternating.on.slice(0, alternating.off.length).map((value, index) => value / alternating.off[index])).toFixed(3)) : undefined,
    capturedFrame,
    centerPixel: Array.from(ONE_PIXEL),
    glError: context.getError(),
  };
};
window.harnessReady = true;
