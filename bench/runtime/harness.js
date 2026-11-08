// Runs in the page. It measures one engine on one scene, in a page of its own, so runs do not share a heap.
import { create67Adapter, createThreeAdapter } from './adapters.js';
import { BENCHMARK_SCENES } from './scenes.js';

const WARMUP_FRAMES = 20;
const FRAME_TIME_STEP = 1 / 60;
const BYTES_PER_PIXEL_BY_FORMAT = new Map([
  [WebGL2RenderingContext.R8, 1], [WebGL2RenderingContext.RG8, 2], [WebGL2RenderingContext.RGBA16F, 8],
  [WebGL2RenderingContext.RGBA32F, 16], [WebGL2RenderingContext.R32F, 4], [WebGL2RenderingContext.RG16F, 4],
  [WebGL2RenderingContext.R11F_G11F_B10F, 4], [WebGL2RenderingContext.DEPTH_COMPONENT16, 2],
]);
const DEFAULT_BYTES_PER_PIXEL = 4;
const BYTES_FOR_MIP_CHAINS = 4 / 3;
const ONE_PIXEL = new Uint8Array(4);

// Counts draw calls and GPU memory by watching WebGL, so one method applies to both engines.
function watchWebGl() {
  const prototype = WebGL2RenderingContext.prototype;
  const counters = { drawCalls: 0, triangles: 0 };
  const sizes = new Map();
  const bound = new Map();
  const wrap = (name, after) => {
    const original = prototype[name];
    prototype[name] = function wrapped(...parameters) {
      const result = original.apply(this, parameters);
      after(this, parameters, result);
      return result;
    };
  };
  const addTriangles = (mode, count, instances = 1) => {
    counters.drawCalls += 1;
    if (mode === WebGL2RenderingContext.TRIANGLES) counters.triangles += (count / 3) * instances;
  };
  wrap('drawElements', (_, [mode, count]) => addTriangles(mode, count));
  wrap('drawArrays', (_, [mode, , count]) => addTriangles(mode, count));
  wrap('drawElementsInstanced', (_, [mode, count, , , instances]) => addTriangles(mode, count, instances));
  wrap('drawArraysInstanced', (_, [mode, , count, instances]) => addTriangles(mode, count, instances));
  wrap('bindBuffer', (_, [target, buffer]) => bound.set(target, buffer));
  wrap('bufferData', (_, [target, data]) => {
    const handle = bound.get(target);
    if (handle) sizes.set(handle, typeof data === 'number' ? data : data?.byteLength ?? 0);
  });
  wrap('deleteBuffer', (_, [buffer]) => sizes.delete(buffer));
  wrap('bindTexture', (_, [target, texture]) => bound.set(target, texture));
  wrap('texImage2D', (_, [target, level, format, width, height]) => {
    const handle = bound.get(target) ?? bound.get(WebGL2RenderingContext.TEXTURE_CUBE_MAP);
    if (handle && level === 0 && typeof width === 'number' && typeof height === 'number') {
      sizes.set(handle, width * height * (BYTES_PER_PIXEL_BY_FORMAT.get(format) ?? DEFAULT_BYTES_PER_PIXEL));
    }
  });
  wrap('texStorage2D', (_, [target, levels, format, width, height]) => {
    const handle = bound.get(target);
    if (!handle) return;
    const mipFactor = levels > 1 ? BYTES_FOR_MIP_CHAINS : 1;
    sizes.set(handle, width * height * (BYTES_PER_PIXEL_BY_FORMAT.get(format) ?? DEFAULT_BYTES_PER_PIXEL) * mipFactor);
  });
  wrap('deleteTexture', (_, [texture]) => sizes.delete(texture));
  wrap('bindRenderbuffer', (_, [target, renderbuffer]) => bound.set(target, renderbuffer));
  wrap('renderbufferStorage', (_, [target, format, width, height]) => {
    const handle = bound.get(target);
    if (handle) sizes.set(handle, width * height * (BYTES_PER_PIXEL_BY_FORMAT.get(format) ?? DEFAULT_BYTES_PER_PIXEL));
  });
  wrap('renderbufferStorageMultisample', (_, [target, samples, format, width, height]) => {
    const handle = bound.get(target);
    if (handle) sizes.set(handle, width * height * samples * (BYTES_PER_PIXEL_BY_FORMAT.get(format) ?? DEFAULT_BYTES_PER_PIXEL));
  });
  wrap('deleteRenderbuffer', (_, [renderbuffer]) => sizes.delete(renderbuffer));
  return {
    counters,
    gpuBytes: () => [...sizes.values()].reduce((total, size) => total + size, 0),
    resetDrawCounters() {
      counters.drawCalls = 0;
      counters.triangles = 0;
    },
  };
}

// context.finish() returns at once in Chrome. Reading one pixel waits until the GPU has finished the frame, so frames
// can not pile up in its queue, and the wait stays outside the measured time.
function waitForGpu(context) {
  context.readPixels(0, 0, 1, 1, context.RGBA, context.UNSIGNED_BYTE, ONE_PIXEL);
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((first, second) => first - second);
  return sorted[Math.floor(sorted.length / 2)];
}

function heapBytes() {
  globalThis.gc?.();
  return performance.memory?.usedJSHeapSize ?? null;
}

async function readTimerQueries(context, queries, timer) {
  const results = [];
  for (const query of queries) {
    const started = performance.now();
    while (!context.getQueryParameter(query, context.QUERY_RESULT_AVAILABLE)) {
      if (performance.now() - started > 5000) throw new Error('A GPU timer query timed out.');
      await new Promise(resolve => setTimeout(resolve, 1));
    }
    if (!context.getParameter(timer.GPU_DISJOINT_EXT)) results.push(context.getQueryParameter(query, context.QUERY_RESULT) / 1e6);
    context.deleteQuery(query);
  }
  return results;
}

async function createAdapter(engine, canvas, scene, characters) {
  if (engine === '67js') return create67Adapter(canvas, scene, characters);
  if (engine === '67js-no-lod') return create67Adapter(canvas, scene, characters, { lods: false });
  if (engine === '67js-no-culling') return create67Adapter(canvas, scene, characters, { culling: false, lods: false });
  if (engine === '67js-ldr') return create67Adapter(canvas, scene, characters, { hdr: false });
  if (engine === '67js-light') return create67Adapter(canvas, scene, characters, { shading: 'light' });
  if (engine === '67js-one-sample') return create67Adapter(canvas, scene, characters, { samples: 1 });
  if (engine === '67js-ldr-one-sample') return create67Adapter(canvas, scene, characters, { hdr: false, samples: 1 });
  if (engine === 'three-one-sample') return createThreeAdapter(canvas, scene, characters, { antialias: false });
  if (engine === 'three-instanced') return createThreeAdapter(canvas, scene, characters, { instanced: true });
  return createThreeAdapter(canvas, scene, characters);
}

const watcher = watchWebGl();

async function runBenchmark(sceneId, engine, frames) {
  const definition = BENCHMARK_SCENES[sceneId];
  const canvas = document.querySelector('canvas');
  const heapBefore = heapBytes();
  const started = performance.now();
  const scene = definition.build();
  const adapter = await createAdapter(engine, canvas, scene, definition.characters);
  adapter.update(0);
  adapter.render();
  waitForGpu(adapter.context);
  const firstFrameMilliseconds = performance.now() - started;
  const firstImage = canvas.toDataURL('image/png');
  const timer = adapter.context.getExtension('EXT_disjoint_timer_query_webgl2');
  let time = 0;
  for (let frame = 0; frame < WARMUP_FRAMES; frame++) {
    time += FRAME_TIME_STEP;
    adapter.update(time);
    adapter.render();
    waitForGpu(adapter.context);
  }
  const updateTimes = [];
  const renderTimes = [];
  const fullFrameTimes = [];
  const queries = [];
  watcher.resetDrawCounters();
  if (adapter.updatePartsTimes) adapter.updatePartsTimes.length = 0;
  for (let frame = 0; frame < frames; frame++) {
    time += FRAME_TIME_STEP;
    const beforeUpdate = performance.now();
    adapter.update(time);
    const beforeRender = performance.now();
    let query = null;
    if (timer) {
      query = adapter.context.createQuery();
      adapter.context.beginQuery(timer.TIME_ELAPSED_EXT, query);
    }
    adapter.render();
    if (timer) {
      adapter.context.endQuery(timer.TIME_ELAPSED_EXT);
      queries.push(query);
    }
    const afterRender = performance.now();
    waitForGpu(adapter.context);
    fullFrameTimes.push(performance.now() - beforeRender);
    updateTimes.push(beforeRender - beforeUpdate);
    renderTimes.push(afterRender - beforeRender);
  }
  const gpuTimes = timer ? await readTimerQueries(adapter.context, queries, timer) : [];
  const drawCalls = watcher.counters.drawCalls / frames;
  const triangles = watcher.counters.triangles / frames;
  adapter.update(0);
  adapter.render();
  const finalImage = canvas.toDataURL('image/png');
  const image = finalImage.split(',')[1];
  const result = {
    scene: sceneId, engine,
    firstFrameMilliseconds,
    updateMilliseconds: median(updateTimes),
    updatePartsMilliseconds: adapter.updatePartsTimes?.length ? median(adapter.updatePartsTimes) : null,
    renderCpuMilliseconds: median(renderTimes),
    gpuMilliseconds: median(gpuTimes),
    fullFrameMilliseconds: median(fullFrameTimes),
    drawCalls, triangles,
    gpuBytes: watcher.gpuBytes(),
    renderTargets: adapter.memoryReport?.().targets ?? null,
    heapBytes: heapBefore === null ? null : heapBytes() - heapBefore,
    glError: adapter.context.getError(),
    // The frame at time 0 after many frames must match the first frame drawn: nothing may depend on what came before.
    repeatable: finalImage === firstImage,
    image,
  };
  adapter.dispose();
  return result;
}

window.runBenchmark = runBenchmark;
window.benchmarkScenes = Object.fromEntries(Object.entries(BENCHMARK_SCENES).map(([id, scene]) => [id, scene.description]));
