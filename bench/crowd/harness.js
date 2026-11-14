// Draws a crowd of the CC0 RobotExpressive walking, through the GPU crowd path or one asset per instance (npm run benchmark:crowd).
import { mat4 } from 'gl-matrix';
import { parseGltf } from '../../src/gltf.js';
import { clipFromGltfAnimation, createAssetPose } from '../../src/skeleton-pose.js';
import { createCrowd } from '../../src/retarget.js';
import { CrucibleRenderer } from '../../src/renderer.js';
import { bakeCrowdPalette, createCrowdParts, createCrowdRig } from '../../src/crowd-skinning.js';

const ROBOT_URL = '/tests/fixtures/RobotExpressive.glb';
const ONE_PIXEL = new Uint8Array(4);

const counters = { drawCalls: 0, instances: 0 };
const originalDraw = WebGL2RenderingContext.prototype.drawElementsInstanced;
WebGL2RenderingContext.prototype.drawElementsInstanced = function counted(mode, count, type, offset, instances) {
  counters.drawCalls += 1;
  counters.instances += instances;
  return originalDraw.call(this, mode, count, type, offset, instances);
};

let robotBytes = null;
async function parseRobot() {
  robotBytes ??= await (await fetch(ROBOT_URL)).arrayBuffer();
  return parseGltf(robotBytes.slice(0), { maxVertices: 500000 });
}

function walkingClip(asset) {
  const source = asset.animations.find(animation => animation.name === 'Walking');
  return { source, clip: clipFromGltfAnimation(source, { loop: true }) };
}

function finish(renderer) {
  renderer.context.readPixels(0, 0, 1, 1, renderer.context.RGBA, renderer.context.UNSIGNED_BYTE, ONE_PIXEL);
}

function readImage(canvas) {
  const copy = document.createElement('canvas');
  copy.width = canvas.width;
  copy.height = canvas.height;
  const context = copy.getContext('2d');
  context.drawImage(canvas, 0, 0);
  return context.getImageData(0, 0, copy.width, copy.height).data;
}

function imageUrl(data, canvas) {
  const copy = document.createElement('canvas');
  copy.width = canvas.width;
  copy.height = canvas.height;
  copy.getContext('2d').putImageData(new ImageData(data, canvas.width, canvas.height), 0, 0);
  return copy.toDataURL('image/png');
}

function compareImages(first, second) {
  let differing = 0;
  let total = 0;
  for (let index = 0; index < first.length; index += 4) {
    const difference = Math.max(Math.abs(first[index] - second[index]), Math.abs(first[index + 1] - second[index + 1]), Math.abs(first[index + 2] - second[index + 2]));
    total += difference;
    if (difference > 8) differing++;
  }
  return { meanDifference: total / (first.length / 4), fractionOver8: differing / (first.length / 4) };
}

function cameraFor(columns, spacing, radius, wide) {
  const extent = Math.max(columns * spacing, radius * 2);
  return wide
    ? { eye: [0, extent * 0.55, extent * 0.9], target: [0, radius * 0.5, 0], up: [0, 1, 0], fov: 45, near: 0.5, far: extent * 6 }
    : { eye: [0, radius * 1.2, radius * 5], target: [0, radius * 0.6, 0], up: [0, 1, 0], fov: 40, near: 0.5, far: extent * 6 };
}

async function buildCrowd(canvas, { count, spacing, wide = true, lods = true, culling = true }) {
  const asset = await parseRobot();
  const { source, clip } = walkingClip(asset);
  const pose = createAssetPose(asset, { layers: [{ clip }] });
  const rig = createCrowdRig(asset.parts);
  const palette = bakeCrowdPalette(rig, seconds => pose.apply(seconds), { duration: source.duration });
  const crowd = createCrowd({ count, clip: { duration: source.duration, tracks: [] }, seed: 5, spacing });
  const set = createCrowdParts({ rig, palette, instances: crowd.instances, lods });
  const columns = Math.ceil(Math.sqrt(count));
  const camera = cameraFor(columns, spacing, palette.bounds.radius, wide);
  const renderer = new CrucibleRenderer(canvas, set.parts, { ground: true, hdr: false, samples: 1, pixelRatio: 1, memoryBudgetMiB: 2048, culling });
  renderer.resize();
  const frame = { ...camera, time: 0, exposure: 1, effects: {} };
  return {
    renderer, palette, rig, set, crowd, frame,
    show(seconds, { exact = false } = {}) {
      set.setTimes(index => (exact ? seconds : crowd.clipTime(index, seconds)));
      renderer.updateParts(set.parts);
      renderer.render(frame);
    },
  };
}

async function measureCrowd(canvas, { count, frames, wide = true, spacing }) {
  const crowdScene = await buildCrowd(canvas, { count, spacing, wide });
  const { renderer } = crowdScene;
  for (let warmup = 0; warmup < 3; warmup++) {
    crowdScene.show(warmup / 60);
    finish(renderer);
  }
  counters.drawCalls = 0;
  counters.instances = 0;
  const times = [];
  for (let frame = 0; frame < frames; frame++) {
    const started = performance.now();
    crowdScene.show((frame + 3) / 60);
    finish(renderer);
    times.push(performance.now() - started);
  }
  times.sort((first, second) => first - second);
  const result = {
    count, parts: crowdScene.set.parts.length, materials: crowdScene.rig.parts.length, frames,
    medianMilliseconds: times[Math.floor(times.length / 2)], bestMilliseconds: times[0],
    drawCallsPerFrame: counters.drawCalls / frames, instancesDrawnPerFrame: counters.instances / frames,
    bounds: crowdScene.palette.bounds, frameCount: crowdScene.palette.frameCount, jointCount: crowdScene.palette.jointCount,
  };
  renderer.dispose();
  return result;
}

// Per-instance skinning as it is today: one parsed asset per instance, posed by applyAnimation.
async function measureInstances(canvas, { count, frames, spacing }) {
  const assets = [];
  const parts = [];
  const crowd = createCrowd({ count, clip: { duration: 1, tracks: [] }, seed: 5, spacing });
  for (let index = 0; index < count; index++) {
    const asset = await parseRobot();
    assets.push(asset);
    for (const part of asset.parts) {
      parts.push(part);
    }
  }
  const walking = assets[0].animations.findIndex(animation => animation.name === 'Walking');
  const renderer = new CrucibleRenderer(canvas, parts, { ground: true, hdr: false, samples: 1, pixelRatio: 1, memoryBudgetMiB: 4096 });
  renderer.resize();
  const frame = { ...cameraFor(Math.ceil(Math.sqrt(count)), spacing, 4, true), time: 0, exposure: 1, effects: {} };
  const run = (seconds) => {
    assets.forEach((asset, index) => {
      asset.applyAnimation(crowd.clipTime(index, seconds), walking);
      for (const part of asset.parts) mat4.multiply(part.matrix, crowd.instances[index].matrix, part.matrix);
    });
    renderer.updateParts(parts);
    renderer.render(frame);
    finish(renderer);
  };
  run(0);
  counters.drawCalls = 0;
  const times = [];
  for (let step = 0; step < frames; step++) {
    const started = performance.now();
    run(step / 60);
    times.push(performance.now() - started);
  }
  times.sort((first, second) => first - second);
  const result = { count, medianMilliseconds: times[Math.floor(times.length / 2)], drawCallsPerFrame: counters.drawCalls / frames };
  renderer.dispose();
  return result;
}

// One crowd instance against the same robot drawn by the renderer's own rigid and skinned paths, and seek against play.
async function checkPictures(canvas, dump = false) {
  const reference = await parseRobot();
  const walking = reference.animations.findIndex(animation => animation.name === 'Walking');
  const seconds = 0.4;
  reference.applyAnimation(seconds, walking);
  const referenceRenderer = new CrucibleRenderer(canvas, reference.parts, { ground: true, hdr: false, samples: 1, pixelRatio: 1, memoryBudgetMiB: 512 });
  referenceRenderer.resize();
  const crowdScene = await buildCrowd(canvas, { count: 1, spacing: 3, wide: false, lods: false, culling: !globalThis.CROWD_NO_CULL });
  const frame = { ...crowdScene.frame, time: 0 };
  referenceRenderer.render(frame);
  const referenceImage = Uint8ClampedArray.from(readImage(canvas));
  crowdScene.show(0.4, { exact: true });
  const crowdImage = Uint8ClampedArray.from(readImage(canvas));
  const againstReference = compareImages(referenceImage, crowdImage);
  const dumps = dump ? { reference: imageUrl(referenceImage, canvas), crowd: imageUrl(crowdImage, canvas) } : null;
  referenceRenderer.dispose();
  crowdScene.renderer.dispose();

  const many = await buildCrowd(canvas, { count: 24, spacing: 2, wide: true });
  const target = 1.37;
  for (let step = 0; step <= 40; step++) many.show(step * target / 40);
  const played = Uint8ClampedArray.from(readImage(canvas));
  many.show(0.2);
  many.show(target);
  const seeked = Uint8ClampedArray.from(readImage(canvas));
  many.renderer.dispose();
  return { againstReference, seekVersusPlay: compareImages(played, seeked), dumps };
}

// A camera that sees one corner of a large crowd: instances outside the view are not drawn.
async function checkCulling(canvas) {
  const crowdScene = await buildCrowd(canvas, { count: 400, spacing: 6, wide: false, lods: false });
  counters.instances = 0;
  counters.drawCalls = 0;
  crowdScene.show(0.3);
  const result = { instances: 400, materials: crowdScene.rig.parts.length, instancesDrawn: counters.instances, drawCalls: counters.drawCalls };
  crowdScene.renderer.dispose();
  return result;
}

window.runCrowd = async (request) => {
  const canvas = document.querySelector('canvas');
  if (request.task === 'measure') return measureCrowd(canvas, request);
  if (request.task === 'instances') return measureInstances(canvas, request);
  if (request.task === 'pictures') return checkPictures(canvas, request.dump);
  if (request.task === 'culling') return checkCulling(canvas);
  throw new Error(`Unknown task ${request.task}`);
};
