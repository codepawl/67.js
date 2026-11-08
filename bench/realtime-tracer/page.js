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
    const result = tracer.frame(orbitCamera(scene.camera, frame * degreesPerFrame), { wait: true });
    await result.done;
    if (frame >= warmup) times.push(performance.now() - started);
  }
  const summary = { gpu: tracer.gpu, backend: tracer.backend, fallbackReason: tracer.fallbackReason, compileSeconds: tracer.compileSeconds, frames, degreesPerFrame, medianMilliseconds: median(times), minimumMilliseconds: Math.min(...times), maximumMilliseconds: Math.max(...times) };
  tracer.dispose();
  return summary;
};

// A resting camera for `seconds` (or exactly `frameLimit` frames when given); returns the last frame and how many frames fitted.
window.renderRestingFrame = async function renderRestingFrame(source, options, seconds = 1, frameLimit = 0) {
  const { scene, tracer } = await openTracer(source, options);
  await tracer.frame(scene.camera, { wait: true }).done;
  const started = performance.now();
  let frames = 1;
  while (frameLimit ? frames < frameLimit : performance.now() - started < seconds * 1000) {
    await tracer.frame(scene.camera, { wait: true }).done;
    frames++;
  }
  const image = toBase64Png(await tracer.readFrame());
  tracer.dispose();
  return { image, frames, elapsedSeconds: (performance.now() - started) / 1000 };
};

// Frames of a camera move: `warmupFrames` at rest, then the orbit, saving every `saveEvery` frames of the move.
window.renderCameraMove = async function renderCameraMove(source, options, { warmupFrames = 30, moveFrames = 24, degreesPerFrame = 2, saveEvery = 3 } = {}) {
  const { scene, tracer } = await openTracer(source, options);
  for (let frame = 0; frame < warmupFrames; frame++) await tracer.frame(scene.camera, { wait: true }).done;
  const images = [];
  for (let frame = 1; frame <= moveFrames; frame++) {
    await tracer.frame(orbitCamera(scene.camera, frame * degreesPerFrame), { wait: true }).done;
    if (frame % saveEvery === 0) images.push(toBase64Png(await tracer.readFrame()));
  }
  tracer.dispose();
  return images;
};

function boxPart(halfSize, color) {
  const faces = [
    { normal: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] }, { normal: [0, 0, -1], u: [-1, 0, 0], v: [0, 1, 0] },
    { normal: [1, 0, 0], u: [0, 0, -1], v: [0, 1, 0] }, { normal: [-1, 0, 0], u: [0, 0, 1], v: [0, 1, 0] },
    { normal: [0, 1, 0], u: [1, 0, 0], v: [0, 0, -1] }, { normal: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] },
  ];
  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];
  faces.forEach((face, faceIndex) => {
    for (const [cornerU, cornerV] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      for (let axis = 0; axis < 3; axis++) positions.push((face.normal[axis] + face.u[axis] * cornerU + face.v[axis] * cornerV) * halfSize);
      normals.push(...face.normal);
      uvs.push((cornerU + 1) / 2, (cornerV + 1) / 2);
    }
    const first = faceIndex * 4;
    indices.push(first, first + 1, first + 2, first, first + 2, first + 3);
  });
  const geometry = { positions: new Float32Array(positions), normals: new Float32Array(normals), uvs: new Float32Array(uvs), indices: new Uint32Array(indices) };
  return { name: 'moving box', geometry, material: { color } };
}

const translationMatrix = ([x, y, z]) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];

function meanAbsoluteDifference(first, second, inside) {
  let sum = 0;
  let count = 0;
  for (let row = 0; row < first.height; row++) {
    for (let column = 0; column < first.width; column++) {
      if (!inside(column + 0.5, row + 0.5)) continue;
      const offset = (row * first.width + column) * 4;
      sum += (Math.abs(first.rgba[offset] - second.rgba[offset]) + Math.abs(first.rgba[offset + 1] - second.rgba[offset + 1]) + Math.abs(first.rgba[offset + 2] - second.rgba[offset + 2])) / 3;
      count++;
    }
  }
  return Number((sum / Math.max(count, 1)).toFixed(3));
}

// A box slides across the frame, one scene update per frame, then the camera rests. The frame is compared with a tracer that
// rested on the final scene for as many frames: `trailError` is the mean absolute difference (8 bit levels) where the box was at the
// start, `frameError` over the whole frame. With the motion followed the trail is as clean as the rest of the frame; with
// `followPartMotion: false` the history stays as it was and the old box shows through.
window.measureMovingPart = async function measureMovingPart(source, options, { moveFrames = 10, restFrames = 12, warmupFrames = 30 } = {}) {
  const { createRealtimeTracer } = await import('/src/path-tracer-realtime.js');
  const { createCamera } = await import('/src/path-tracer.js');
  const { projectToPixel } = await import('/src/path-tracer-reprojection.js');
  const scene = await window.loadTraceSceneFor(source);
  const { eye, target } = scene.camera;
  const toTarget = [0, 1, 2].map(axis => target[axis] - eye[axis]);
  const distance = Math.hypot(...toTarget);
  const forward = toTarget.map(value => value / distance);
  const rightRaw = [-forward[2], 0, forward[0]];
  const right = rightRaw.map(value => value / Math.hypot(...rightRaw));
  const halfSize = distance * 0.05;
  const startAt = [0, 1, 2].map(axis => target[axis] - right[axis] * distance * 0.15);
  const position = step => startAt.map((value, axis) => value + right[axis] * distance * 0.03 * step);
  const withBox = step => [...scene.parts, { ...boxPart(halfSize, [0.9, 0.1, 0.1]), matrix: translationMatrix(position(step)) }];
  const environment = scene.environment;
  const restFrame = async (tracerOptions, slide) => {
    const tracer = await createRealtimeTracer({ ...scene, parts: withBox(slide ? 0 : moveFrames), environment }, tracerOptions);
    for (let frame = 0; frame < warmupFrames; frame++) await tracer.frame(scene.camera, { wait: true }).done;
    for (let step = 1; slide && step <= moveFrames; step++) {
      await tracer.update({ parts: withBox(step), environment });
      await tracer.frame(scene.camera, { wait: true }).done;
    }
    for (let frame = 0; frame < (slide ? restFrames : moveFrames + restFrames); frame++) await tracer.frame(scene.camera, { wait: true }).done;
    const picture = await tracer.readFrame();
    tracer.dispose();
    return picture;
  };
  const reference = await restFrame(options, false);
  const view = createCamera(scene.camera, reference.width, reference.height);
  const startPixel = projectToPixel(view, position(0), reference.width, reference.height);
  const edgePixel = projectToPixel(view, position(0).map((value, axis) => value + right[axis] * halfSize), reference.width, reference.height);
  const radius = Math.max(8, Math.abs(edgePixel.x - startPixel.x) * 1.5);
  const results = { trail: { x: startPixel.x, y: startPixel.y, radius }, reference: { image: toBase64Png(reference) } };
  for (const [label, followPartMotion] of [['follow', true], ['ignore', false]]) {
    const moved = await restFrame({ ...options, followPartMotion }, true);
    results[label] = {
      trailError: meanAbsoluteDifference(moved, reference, (x, y) => Math.hypot(x - startPixel.x, y - startPixel.y) <= radius),
      frameError: meanAbsoluteDifference(moved, reference, () => true),
      image: toBase64Png(moved),
    };
  }
  return results;
};
