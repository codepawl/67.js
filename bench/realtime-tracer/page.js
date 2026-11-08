// Page side of bench/realtime-tracer/run.mjs: loaded into bench/reference/harness.html (which supplies the scenes).
const median = values => [...values].sort((first, second) => first - second)[Math.floor(values.length / 2)];

function orbitCamera(camera, degrees) {
  const radians = degrees * Math.PI / 180;
  const offsetX = camera.eye[0] - camera.target[0];
  const offsetZ = camera.eye[2] - camera.target[2];
  const eye = [
    camera.target[0] + offsetX * Math.cos(radians) - offsetZ * Math.sin(radians),
    camera.eye[1],
    camera.target[2] + offsetX * Math.sin(radians) + offsetZ * Math.cos(radians),
  ];
  return { ...camera, eye };
}

function toBase64Png(frame) {
  const canvas = document.createElement('canvas');
  canvas.width = frame.width;
  canvas.height = frame.height;
  canvas.getContext('2d').putImageData(new ImageData(frame.rgba, frame.width, frame.height), 0, 0);
  return canvas.toDataURL('image/png').split(',')[1];
}

async function openTracer(source, options) {
  const scene = await window.loadTraceSceneFor(source);
  const { createRealtimeTracer } = await import('/src/path-tracer-realtime.js');
  const tracer = await createRealtimeTracer(scene, options);
  return { scene, tracer };
}

// Median of `frames` frames; the camera orbits `degreesPerFrame` each frame (0 for a resting camera).
window.measureRealtimeFrames = async function measureRealtimeFrames(source, options, frames = 200, degreesPerFrame = 0.5, warmup = 10) {
  const { scene, tracer } = await openTracer(source, options);
  const times = [];
  for (let frame = 0; frame < frames + warmup; frame++) {
    const started = performance.now();
    tracer.frame(orbitCamera(scene.camera, frame * degreesPerFrame), { wait: true });
    if (frame >= warmup) times.push(performance.now() - started);
  }
  const result = { gpu: tracer.gpu, compileSeconds: tracer.compileSeconds, frames, degreesPerFrame, medianMilliseconds: median(times), minimumMilliseconds: Math.min(...times), maximumMilliseconds: Math.max(...times) };
  tracer.dispose();
  return result;
};

// A resting camera for `seconds`; returns the last frame and how many frames fitted.
window.renderRestingFrame = async function renderRestingFrame(source, options, seconds = 1) {
  const { scene, tracer } = await openTracer(source, options);
  tracer.frame(scene.camera, { wait: true });
  const started = performance.now();
  let frames = 1;
  while (performance.now() - started < seconds * 1000) {
    tracer.frame(scene.camera, { wait: true });
    frames++;
  }
  const image = toBase64Png(tracer.readFrame());
  tracer.dispose();
  return { image, frames, elapsedSeconds: (performance.now() - started) / 1000 };
};

// Frames of a camera move: `warmupFrames` at rest, then the orbit, saving every `saveEvery` frames of the move.
window.renderCameraMove = async function renderCameraMove(source, options, { warmupFrames = 30, moveFrames = 24, degreesPerFrame = 2, saveEvery = 3 } = {}) {
  const { scene, tracer } = await openTracer(source, options);
  for (let frame = 0; frame < warmupFrames; frame++) tracer.frame(scene.camera, { wait: true });
  const images = [];
  for (let frame = 1; frame <= moveFrames; frame++) {
    tracer.frame(orbitCamera(scene.camera, frame * degreesPerFrame), { wait: true });
    if (frame % saveEvery === 0) images.push(toBase64Png(tracer.readFrame()));
  }
  tracer.dispose();
  return images;
};
