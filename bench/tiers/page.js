// Page side of bench/tiers/run-glaze.mjs: loaded into bench/reference/harness.html, which supplies the scenes and the scene preparation.
const median = values => [...values].sort((first, second) => first - second)[Math.floor(values.length / 2)];

function pngOf(canvas) {
  return canvas.toDataURL('image/png').split(',')[1];
}

// Draws one reference scene with the renderer options of a tier.
//   setupMilliseconds: scene build plus renderer construction (geometry upload, shadow map and frame targets).
//   firstFrameMilliseconds: the first render, with the shader compile and the environment prefilter, until the pixels are back.
//   frameMilliseconds: the next `frameCount` renders, each until a pixel read waits for the GPU (finish() returns early on a hardware GPU).
window.renderTierScene = async function renderTierScene(sceneId, tier, frameCount = 10) {
  const { SCENES, Renderer67, applyLightLinks, withDerivedGroundBounce, withFloorSky, skyOpenness, fogSkyVisibility } = window.referenceInternals;
  const setupStarted = performance.now();
  const scene = await SCENES[sceneId]();
  scene.environment = withDerivedGroundBounce(scene, scene.parts);
  const parts = withFloorSky(sceneId, scene.parts, scene);
  const canvas = document.querySelector('canvas');
  const renderer = new Renderer67(canvas, applyLightLinks(parts, scene.environment), {
    ground: false, world: true, memoryBudgetMiB: 1024,
    environment: scene.environment, shadowBounds: scene.shadow, skyOpenness, fogSkyVisibility,
    ...tier.rendererOptions,
  });
  renderer.resize();
  const setupMilliseconds = performance.now() - setupStarted;
  // A still frame: time 0 and no wind, as the reference suite draws, so every frame is the same picture.
  const frame = { ...scene.camera, environment: scene.environment, time: 0, wind: 0, exposure: 1, effects: { ambientOcclusionRadius: 0.5, ...tier.frameEffects } };
  const context = renderer.context;
  const pixel = new Uint8Array(4);
  const finishDrawing = () => context.readPixels(0, 0, 1, 1, context.RGBA, context.UNSIGNED_BYTE, pixel);
  const firstStarted = performance.now();
  renderer.render(frame);
  finishDrawing();
  const firstFrameMilliseconds = performance.now() - firstStarted;
  const frameMilliseconds = [];
  let image = null;
  for (let index = 0; index < frameCount; index++) {
    const started = performance.now();
    renderer.render(frame);
    finishDrawing();
    frameMilliseconds.push(performance.now() - started);
    if (index === frameCount - 1) image = pngOf(canvas);
  }
  // Throughput: many draws queued back to back, then one pixel read. The per-frame figure above ends in a read each time, which on a fast
  // scene is mostly the read and the driver round trip; this one is the card's work per frame, so draft against realtime shows.
  const throughputFrames = 30;
  const throughputStarted = performance.now();
  for (let index = 0; index < throughputFrames; index++) renderer.render(frame);
  finishDrawing();
  const throughputMilliseconds = (performance.now() - throughputStarted) / throughputFrames;
  const debug = context.getExtension('WEBGL_debug_renderer_info');
  const result = {
    throughputMilliseconds,
    sceneId,
    tier: tier.label,
    canvasWidth: canvas.width,
    canvasHeight: canvas.height,
    setupMilliseconds,
    firstFrameMilliseconds,
    frameMilliseconds,
    medianFrameMilliseconds: median(frameMilliseconds),
    glError: context.getError(),
    capabilities: renderer.capabilities,
    memoryReport: renderer.memoryReport(),
    graphics: context.getParameter(debug ? debug.UNMASKED_RENDERER_WEBGL : context.RENDERER),
    image,
  };
  renderer.dispose();
  return result;
};

function floatsToBase64(values) {
  const bytes = new Uint8Array(values.buffer, values.byteOffset, values.byteLength);
  let binary = '';
  for (let start = 0; start < bytes.length; start += 0x8000) binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
  return btoa(binary);
}

// Cook (the path tracer) on one reference scene with matched settings: no denoiser, no clamp, no adaptive sampling, a Box filter of width 1
// (the tracer jitters each sample uniformly inside the pixel). Returns the untouched linear pixels and the tracer's own report.
window.renderCookScene = async function renderCookScene(sceneId, options) {
  const { SCENES, applyLightLinks } = window.referenceInternals;
  const scene = await SCENES[sceneId]();
  const { renderPathTracedImage } = await import('/src/path-tracer.js');
  const started = performance.now();
  const result = await renderPathTracedImage(
    { parts: applyLightLinks(scene.parts, scene.environment), environment: scene.environment, camera: scene.camera },
    { bounces: 8, seed: 1, fireflyClamp: 1000, noiseThreshold: 0, denoise: false, ...options },
  );
  return { linear: floatsToBase64(result.linear), report: result.report, wallSeconds: (performance.now() - started) / 1000 };
};

function pngOfPixels(frame) {
  const canvas = document.createElement('canvas');
  canvas.width = frame.width;
  canvas.height = frame.height;
  canvas.getContext('2d').putImageData(new ImageData(frame.rgba, frame.width, frame.height), 0, 0);
  return canvas.toDataURL('image/png').split(',')[1];
}

// The experimental real-time path tracer at rest: frame times, then checkpoints of the accumulated picture at growing frame counts with
// the time since the first frame, for scoring against a reference offline. Checkpoint reads are not counted in the elapsed time.
window.settleRealtimeTracer = async function settleRealtimeTracer(sceneId, tracerOptions, checkpointFrames) {
  const { createRealtimeTracer } = await import('/src/path-tracer-realtime.js');
  const scene = await window.loadTraceSceneFor(sceneId);
  const createStarted = performance.now();
  const tracer = await createRealtimeTracer(scene, tracerOptions);
  const createSeconds = (performance.now() - createStarted) / 1000;
  const checkpoints = [];
  const frameMilliseconds = [];
  let elapsedMilliseconds = 0;
  const lastFrame = Math.max(...checkpointFrames);
  for (let frameNumber = 1; frameNumber <= lastFrame; frameNumber++) {
    const started = performance.now();
    await tracer.frame(scene.camera, { wait: true }).done;
    const frameTime = performance.now() - started;
    frameMilliseconds.push(frameTime);
    elapsedMilliseconds += frameTime;
    if (checkpointFrames.includes(frameNumber)) {
      const frame = await tracer.readFrame();
      checkpoints.push({ frame: frameNumber, elapsedSeconds: elapsedMilliseconds / 1000, image: pngOfPixels(frame) });
    }
  }
  const summary = { backend: tracer.backend, fallbackReason: tracer.fallbackReason, gpu: tracer.gpu, compileSeconds: tracer.compileSeconds, createSeconds, medianFrameMilliseconds: median(frameMilliseconds.slice(5)), frameMilliseconds, checkpoints };
  tracer.dispose();
  return summary;
};
