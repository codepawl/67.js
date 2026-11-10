// Crosses the procedural tile world through the runtime, with tiles built in workers and streamed under a byte budget.
// window.runCrossing(options) resolves with per-frame timings, resident bytes and counts. See run.mjs and docs/streaming.md.
import { Renderer67, box } from '../../src/index.js';
import { createRuntime } from '../../src/runtime.js';
import { createStreaming, createWorkerLoader } from '../../src/streaming.js';
import { createCrossingWorld, createPathPlayer, tileId } from './world.js';

const TERRAIN_MATERIAL = { color: [0.2, 0.36, 0.15], metallic: 0, roughness: 0.92, emission: 0 };
const MARKER_MATERIAL = { color: [0.95, 0.75, 0.2], metallic: 0, roughness: 0.5, emission: 0 };
const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const WARMUP_FRAMES = 60;
const LONG_TASK_MILLISECONDS = 50;
const CROSSING_DEADLINE_MARGIN_SECONDS = 120;
const SHEET_COLUMNS = 4;
const SHEET_ROWS = 2;
const SHEET_FRAME_WIDTH = 480;

function percentile(sortedValues, fraction) {
  if (sortedValues.length === 0) return 0;
  return sortedValues[Math.min(sortedValues.length - 1, Math.floor(fraction * sortedValues.length))];
}

function summarize(values) {
  const sorted = [...values].sort((first, second) => first - second);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  return {
    frames: sorted.length,
    median: percentile(sorted, 0.5),
    mean: sorted.length ? total / sorted.length : 0,
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    max: sorted.length ? sorted[sorted.length - 1] : 0,
  };
}

function markerMatrix(position) {
  return new Float32Array([1.2, 0, 0, 0, 0, 3, 0, 0, 0, 0, 1.2, 0, position[0], position[1] - 1.5, position[2], 1]);
}

function chaseCamera(player) {
  const [x, y, z] = player.state.position;
  const [headingX, headingZ] = player.state.heading;
  return { eye: [x - headingX * 14, y + 7, z - headingZ * 14], target: [x + headingX * 20, y - 2, z + headingZ * 20], up: [0, 1, 0], far: 320 };
}

async function loadingScreen(streaming) {
  const start = performance.now();
  for (let round = 0; round < 200; round += 1) {
    const before = streaming.events.length;
    streaming.update();
    await streaming.settled();
    if (streaming.stats.activeLoads === 0 && streaming.events.length === before) break;
  }
  return performance.now() - start;
}

async function runCrossing(options = {}) {
  const world = createCrossingWorld(options.world ?? {});
  const { settings } = world;
  const canvas = document.querySelector('canvas');
  const marker = { name: 'Player', geometry: box(), matrix: IDENTITY, material: MARKER_MATERIAL };
  const renderer = new Renderer67(canvas, [marker], { world: true, ground: false, pixelRatio: 1, samples: 4 });
  renderer.resize();

  const workerLoader = createWorkerLoader({ createWorker: () => new Worker(new URL('./tile-worker.js', import.meta.url), { type: 'module' }) });
  const player = createPathPlayer({ waypoints: world.path, seed: settings.seed, speed: settings.playerSpeed, eyeHeight: settings.eyeHeight });
  const counts = { evictBudget: 0, evictLevelSwitch: 0, loaded: 0, loadStarts: 0, maximumActiveLoads: 0 };
  const streaming = createStreaming({
    budgetBytes: settings.budgetBytes,
    maximumConcurrentLoads: options.concurrentLoads ?? 4,
    loaders: { 'terrain-tile': workerLoader },
    assets: world.assets,
    focus: () => player.state.position,
    onEvent: event => {
      if (event.type === 'evict') counts[event.reason === 'budget' ? 'evictBudget' : 'evictLevelSwitch'] += 1;
      if (event.type === 'loaded') counts.loaded += 1;
      if (event.type === 'load-start') counts.loadStarts += 1;
    },
  });

  const partsByGeometry = new WeakMap();
  let shownParts = [marker];
  function tilePart(geometry, id) {
    if (!partsByGeometry.has(geometry)) partsByGeometry.set(geometry, { name: id, geometry, matrix: IDENTITY, material: TERRAIN_MATERIAL });
    return partsByGeometry.get(geometry);
  }
  const half = settings.tilesPerSide / 2;
  function groundResident() {
    const column = Math.min(settings.tilesPerSide - 1, Math.max(0, Math.floor(player.state.position[0] / settings.tileSize + half)));
    const row = Math.min(settings.tilesPerSide - 1, Math.max(0, Math.floor(player.state.position[2] / settings.tileSize + half)));
    return streaming.getAsset(tileId(column, row)) !== null;
  }
  // Rebuild the drawn tiles from what is resident. replaceParts runs only when the set of geometries changed.
  function syncParts() {
    const parts = [marker];
    for (const asset of world.assets) {
      const geometry = streaming.getAsset(asset.id);
      if (geometry) parts.push(tilePart(geometry, asset.id));
    }
    const unchanged = parts.length === shownParts.length && parts.every((part, index) => part === shownParts[index]);
    if (unchanged) return 0;
    const start = performance.now();
    renderer.replaceParts(parts, { retainedUnchanged: true });
    shownParts = parts;
    return performance.now() - start;
  }

  const sheet = options.sheet ? { frames: [], next: 0 } : null;
  const target = {
    render(frame) {
      renderer.render(frame);
      if (!sheet || sheet.next >= SHEET_COLUMNS * SHEET_ROWS) return;
      if (player.state.distance < (sheet.next + 0.5) / (SHEET_COLUMNS * SHEET_ROWS) * player.total) return;
      const copy = document.createElement('canvas');
      copy.width = SHEET_FRAME_WIDTH;
      copy.height = Math.round(SHEET_FRAME_WIDTH * canvas.height / canvas.width);
      copy.getContext('2d').drawImage(canvas, 0, 0, copy.width, copy.height);
      sheet.frames.push(copy);
      sheet.next += 1;
    },
  };

  const loadingMilliseconds = await loadingScreen(streaming);
  const initialBytes = streaming.stats.bytesInUse;
  syncParts();

  const longTasks = [];
  const observer = new PerformanceObserver(list => {
    for (const entry of list.getEntries()) if (entry.duration >= LONG_TASK_MILLISECONDS) longTasks.push(entry.duration);
  });
  try { observer.observe({ type: 'longtask', buffered: false }); } catch { /* long tasks are not reported by this browser */ }

  const samples = { frame: [], update: [], render: [], streamingUpdate: [], replaceParts: [], bytes: [], geometryBytes: [], heap: [] };
  let framesWithoutGround = 0;
  let frames = 0;
  let pendingSyncMilliseconds = 0;
  let streamingUpdateMilliseconds = 0;
  const streamingSystem = {
    name: 'streaming',
    update(deltaSeconds, context) {
      const start = performance.now();
      streaming.update(deltaSeconds, context);
      streamingUpdateMilliseconds = performance.now() - start;
    },
    dispose() { streaming.dispose(); },
  };
  const probe = {
    name: 'probe',
    update() {
      frames += 1;
      const stats = runtime.stats;
      // runtime.stats describes the frame before this one; the first frames include startup, so they are tagged by index.
      samples.frame.push(stats.frameMilliseconds);
      samples.update.push(stats.updateMilliseconds);
      samples.render.push(stats.renderMilliseconds);
      samples.streamingUpdate.push(streamingUpdateMilliseconds);
      samples.replaceParts.push(pendingSyncMilliseconds);
      samples.bytes.push(streaming.stats.bytesInUse);
      samples.geometryBytes.push(renderer.geometryBytes ?? 0);
      samples.heap.push(performance.memory ? performance.memory.usedJSHeapSize : 0);
      counts.maximumActiveLoads = Math.max(counts.maximumActiveLoads, streaming.stats.activeLoads);
      if (!groundResident()) framesWithoutGround += 1;
    },
  };
  const runtime = createRuntime(target, {
    mode: 'variable',
    systems: [player, streamingSystem, probe],
    frame: () => {
      pendingSyncMilliseconds = syncParts();
      marker.matrix = markerMatrix(player.state.position);
      renderer.updateParts([marker]);
      return { ...chaseCamera(player), time: runtime.stats.frames / 60 };
    },
  });

  const startedAt = performance.now();
  runtime.start();
  const deadlineSeconds = player.total / settings.playerSpeed + CROSSING_DEADLINE_MARGIN_SECONDS;
  while (!player.state.finished) {
    if ((performance.now() - startedAt) / 1000 > deadlineSeconds) {
      runtime.stop();
      throw new Error(`The crossing did not finish within ${deadlineSeconds.toFixed(0)} s (path ${player.total.toFixed(0)} units at ${settings.playerSpeed} units per second plus ${CROSSING_DEADLINE_MARGIN_SECONDS} s); it reached ${player.state.distance.toFixed(0)} units after ${frames} frames. Pass a higher --speed or check that frames are being drawn.`);
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const crossingSeconds = (performance.now() - startedAt) / 1000;
  runtime.stop();
  observer.disconnect();
  await streaming.settled();

  const steady = name => summarize(samples[name].slice(WARMUP_FRAMES));
  const result = {
    userAgent: navigator.userAgent,
    renderer: renderer.context.getParameter(renderer.context.RENDERER),
    gpu: (() => {
      const extension = renderer.context.getExtension('WEBGL_debug_renderer_info');
      return extension ? renderer.context.getParameter(extension.UNMASKED_RENDERER_WEBGL) : 'unknown';
    })(),
    viewport: [canvas.width, canvas.height],
    world: { tiles: world.assets.length, tileSize: settings.tileSize, levels: settings.levelResolutions.length, levelResolutions: settings.levelResolutions, worldSide: settings.tilesPerSide * settings.tileSize, pathLength: player.total, playerSpeed: settings.playerSpeed },
    budgetBytes: settings.budgetBytes,
    loadingScreenMilliseconds: loadingMilliseconds,
    initialBytes,
    crossingSeconds,
    frames,
    frameMilliseconds: { all: summarize(samples.frame.slice(1)), afterWarmup: steady('frame') },
    updateMilliseconds: steady('update'),
    renderMilliseconds: steady('render'),
    streamingUpdateMilliseconds: steady('streamingUpdate'),
    replacePartsMilliseconds: summarize(samples.replaceParts.filter(value => value > 0)),
    longTasks: { count: longTasks.length, maximum: longTasks.length ? Math.max(...longTasks) : 0 },
    framesOver50: samples.frame.slice(1).filter(value => value > LONG_TASK_MILLISECONDS).length,
    framesOver33: samples.frame.slice(WARMUP_FRAMES).filter(value => value > 33.4).length,
    residentBytes: { peak: Math.max(...samples.bytes), final: samples.bytes[samples.bytes.length - 1], overBudgetFrames: samples.bytes.filter(value => value > settings.budgetBytes).length },
    geometryBytesPeak: Math.max(...samples.geometryBytes),
    jsHeapBytes: samples.heap[0] ? { start: samples.heap[0], peak: Math.max(...samples.heap) } : null,
    streaming: { ...counts, stats: streaming.stats, framesWithoutGround },
  };
  if (sheet) {
    const output = document.createElement('canvas');
    output.width = SHEET_COLUMNS * SHEET_FRAME_WIDTH;
    output.height = SHEET_ROWS * sheet.frames[0].height;
    const context = output.getContext('2d');
    sheet.frames.forEach((frame, index) => context.drawImage(frame, (index % SHEET_COLUMNS) * SHEET_FRAME_WIDTH, Math.floor(index / SHEET_COLUMNS) * frame.height));
    result.sheet = output.toDataURL('image/png');
  }
  runtime.dispose();
  return result;
}

window.runCrossing = runCrossing;
