// Times a 12 frame sequence on a large generated scene (bench/cycles-parity/large-scene.mjs), session against one-shot, in one process per mode.
// Two variants run one after the other in that process: "camera" (the camera orbits) and "moving" (the camera orbits and one instance
// alternates between two placements each frame, so the instance table changes every frame). Frame inputs are packed once per placement and
// get the frame's camera words; the large tables are copied before each frame's timer starts, as a job decodes fresh tables per frame.
// Prints one LARGE_SEQUENCE_TIMING line of JSON.
// A scene of about 4,000,000 triangles packs about 900 MB of tables in JavaScript: run it with NODE_OPTIONS=--max-old-space-size=16384 (the default 4 GB heap
// ran out in the pack step on 2026-11-12).
//   node bench/cycles-parity/large-sequence-timing.mjs --scene terrain|forest --size <triangles | instances> --mode session|oneshot
//     [--frames 12] [--samples 16] [--width 480] [--height 270] [--seed 1]
import * as renderNative from '@codepawlhq/cook';
import { buildLargeScene, describeLargeScene, orbitCameraFor } from './large-scene.mjs';
import { PHASE_NAMES, averageOfWarmFrames, readFlag, runSequence } from './sequence-bench-core.mjs';

const CAMERA_WORDS_START = 112;
const CAMERA_WORDS_END = 192;
const STEP_COUNT = 2;
const PROBE_SCENE = { materials: [{}], instances: [{ geometry: {
  positions: new Float32Array([-1, 0, -1, 1, 0, -1, 1, 0, 1]), normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0]),
  uvs: new Float32Array([0, 0, 1, 0, 1, 1]), colors: new Float32Array(9).fill(1), indices: new Uint32Array([0, 2, 1]) },
matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], materialIndex: 0 }] };

function requireNumber(argumentList, flagName, fallbackValue) {
  const value = Number(readFlag(argumentList, flagName, fallbackValue));
  if (!Number.isFinite(value) || value < 1) throw new RangeError(`${flagName} must be a number of at least 1; got ${value}.`);
  return value;
}

// The camera words (bytes 112 to 191) of a FORMAT-v2 block for frame `frameIndex`, from a one triangle scene so no large pack is repeated.
function cameraWordsFor(settings, frameIndex) {
  const { scene, size, frameCount, packOptions } = settings;
  const camera = orbitCameraFor(scene, size, frameIndex, frameCount, packOptions.width, packOptions.height);
  return renderNative.buildNativeInputV2(PROBE_SCENE, camera, packOptions).kernelParams.slice(CAMERA_WORDS_START, CAMERA_WORDS_END);
}

function inputWithCamera(stateInput, cameraWords) {
  const kernelParams = new Uint8Array(stateInput.kernelParams);
  kernelParams.set(cameraWords, CAMERA_WORDS_START);
  return { ...stateInput, kernelParams, triangles: stateInput.triangles.slice() };
}

function packStates(settings) {
  const { scene, size, frameCount, packOptions } = settings;
  const states = [];
  for (let step = 0; step < STEP_COUNT; step++) {
    const camera = orbitCameraFor(scene, size, 0, frameCount, packOptions.width, packOptions.height);
    const packed = renderNative.buildNativeInputV2(buildLargeScene(scene, size, step), camera, packOptions);
    if (step > 0) packed.triangles = states[0].triangles;
    states.push(packed);
  }
  return states;
}

function summarize(label, run) {
  const paths = {};
  for (const frame of run.frames) paths[frame.path] = (paths[frame.path] ?? 0) + 1;
  const warmAverage = Object.fromEntries([...PHASE_NAMES, 'wallSeconds'].map(name => [name, averageOfWarmFrames(run.frames, name)]));
  return { variant: label, totalSeconds: run.totalSeconds, paths, coldFrame: run.frames[0], warmAverage, frameHashes: run.frames.map(frame => frame.rgbaSha256) };
}

function run() {
  const argumentList = process.argv.slice(2);
  const scene = readFlag(argumentList, '--scene', null);
  const mode = readFlag(argumentList, '--mode', null);
  if (!['terrain', 'forest'].includes(scene) || !['session', 'oneshot'].includes(mode)) {
    throw new RangeError('Usage: node bench/cycles-parity/large-sequence-timing.mjs --scene terrain|forest --size <triangles | instances> --mode session|oneshot [--frames 12] [--samples 16] [--width 480] [--height 270] [--seed 1]');
  }
  const size = requireNumber(argumentList, '--size', 400000);
  const frameCount = requireNumber(argumentList, '--frames', 12);
  const width = requireNumber(argumentList, '--width', 480);
  const height = requireNumber(argumentList, '--height', 270);
  const samples = requireNumber(argumentList, '--samples', 16);
  const seed = requireNumber(argumentList, '--seed', 1);
  const packOptions = { width, height, samples, bounces: 4, seed, near: 0.05, far: 500 };
  const settings = { scene, size, frameCount, packOptions };
  const states = packStates(settings);
  const cameraWords = Array.from({ length: frameCount }, (unused, frameIndex) => cameraWordsFor(settings, frameIndex));
  const traceOptions = { ...packOptions, kernel: 'cycles' };
  const variants = [
    ['camera', frameIndex => inputWithCamera(states[0], cameraWords[frameIndex])],
    ['moving', frameIndex => inputWithCamera(states[frameIndex % STEP_COUNT], cameraWords[frameIndex])],
  ];
  const results = variants.map(([label, prepareInput]) => summarize(label, runSequence(frameCount, prepareInput, mode, traceOptions)));
  const summary = { ...describeLargeScene(scene, size), mode, frameCount, width, height, samples, triangleCount: states[0].triangleCount, results };
  console.log(`LARGE_SEQUENCE_TIMING ${JSON.stringify(summary)}`);
}

run();
