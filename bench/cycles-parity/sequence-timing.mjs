// Times a bounded sequence of frames (24 by default) on an exported scene, one mode per process so the cold compile of one mode never
// warms the other: "session" renders the frames through a native sequence (the route a stills or video job takes), "oneshot" renders each with
// traceNative. Prints one SEQUENCE_TIMING line of JSON with the per-frame phase seconds, the route of each frame, the wall seconds of the
// whole sequence and the SHA-256 of every frame, so the two modes can be compared byte for byte.
//   node bench/cycles-parity/sequence-timing.mjs <sceneJsonPath> --mode session|oneshot [--variant camera|object-light] [--frames 24]
//     [--samples 16] [--width 480] [--height 270] [--seed 1] [--instancing]
// Variants: "camera" orbits the camera; "object-light" also moves the part named "block" and swings the first point light's intensity.
// --instancing builds the scene with shared geometry, so a moved part is an instance transform (an update) instead of new triangles.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createCamera } from '../../src/path-tracer.js';
import * as packModule from '../../src/path-tracer-gpu-pack.js';
import { buildTraceScene } from '../../src/path-tracer-scene.js';
import * as renderNative from '../../packages/render-native/index.mjs';
import { createNativeSequence } from '../../scripts/agent-native-sequence.mjs';
import { applyCookOnlyFields } from './cook-only-fields.mjs';
import { buildTraceSceneWithManyLights } from './trace-scene-many-lights.mjs';
import { reconstructTraceSceneSource } from './scene-bridge.mjs';

const PHASE_NAMES = ['setupSeconds', 'compileSeconds', 'uploadSeconds', 'accelerationBuildSeconds', 'tracedSeconds'];
const MOVING_PART_NAME = 'block';
const ORBIT_RADIANS = Math.PI / 6;

function readFlag(argumentList, flagName, fallbackValue) {
  const flagIndex = argumentList.indexOf(flagName);
  return flagIndex === -1 ? fallbackValue : argumentList[flagIndex + 1];
}

function sha256Of(values) {
  return createHash('sha256').update(Buffer.from(values.buffer, values.byteOffset, values.byteLength)).digest('hex');
}

function orbitedCamera(camera, frameIndex, frameCount) {
  const angle = ORBIT_RADIANS * frameIndex / Math.max(1, frameCount - 1);
  const [targetX, , targetZ] = camera.target;
  const offsetX = camera.eye[0] - targetX;
  const offsetZ = camera.eye[2] - targetZ;
  const eye = [targetX + offsetX * Math.cos(angle) - offsetZ * Math.sin(angle), camera.eye[1], targetZ + offsetX * Math.sin(angle) + offsetZ * Math.cos(angle)];
  return { ...camera, eye };
}

function frameScene(source, variant, frameIndex, frameCount) {
  if (variant === 'camera') return { parts: source.parts, environment: source.environment };
  const phase = frameIndex / Math.max(1, frameCount - 1);
  const parts = source.parts.map(part => {
    if (part.name !== MOVING_PART_NAME) return part;
    const matrix = new Float32Array(part.matrix);
    matrix[12] += 0.6 * Math.sin(phase * Math.PI * 2);
    return { ...part, matrix };
  });
  const pointLights = source.environment.pointLights.map((light, index) => (index === 0 ? { ...light, intensity: light.intensity * (0.5 + phase) } : light));
  return { parts, environment: { ...source.environment, pointLights } };
}

function buildInputs(source, settings) {
  const { variant, frameCount, width, height, instancing, renderOptions } = settings;
  const inputs = [];
  for (let frameIndex = 0; frameIndex < frameCount; frameIndex++) {
    const { parts, environment } = frameScene(source, variant, frameIndex, frameCount);
    const traceScene = instancing
      ? applyCookOnlyFields(buildTraceScene(parts, environment, { instancing }), parts, environment)
      : buildTraceSceneWithManyLights(parts, environment);
    const camera = createCamera(orbitedCamera(source.camera, frameIndex, frameCount), width, height);
    inputs.push(renderNative.buildNativeInputV2(traceScene, camera, { ...renderOptions, parts }, packModule));
  }
  return inputs;
}

function summarizeFrame(traced, route, wallSeconds) {
  const frame = { rgbaSha256: sha256Of(traced.rgba), wallSeconds: Number(wallSeconds.toFixed(6)), path: route?.path ?? 'one-shot' };
  for (const phaseName of PHASE_NAMES) frame[phaseName] = Number((traced[phaseName] ?? 0).toFixed(6));
  if (route?.reason) frame.reason = route.reason;
  if (route?.changedTables) frame.changedTables = route.changedTables;
  return frame;
}

function averageOfWarmFrames(frames, fieldName) {
  const warmFrames = frames.slice(1);
  const total = warmFrames.reduce((sum, frame) => sum + frame[fieldName], 0);
  return Number((total / Math.max(1, warmFrames.length)).toFixed(6));
}

function runSequence(inputs, mode, traceOptions) {
  const sequence = mode === 'session' ? createNativeSequence({ tracer: renderNative }) : null;
  const frames = [];
  const sequenceStarted = performance.now();
  try {
    for (const input of inputs) {
      const frameStarted = performance.now();
      const { traced, route } = sequence ? sequence.trace(input, traceOptions) : { traced: renderNative.traceNative(input, traceOptions) };
      frames.push(summarizeFrame(traced, route, (performance.now() - frameStarted) / 1000));
    }
  } finally {
    sequence?.close();
  }
  return { frames, totalSeconds: Number(((performance.now() - sequenceStarted) / 1000).toFixed(6)) };
}

async function run() {
  const argumentList = process.argv.slice(2);
  const mode = readFlag(argumentList, '--mode', null);
  if (!argumentList[0] || argumentList[0].startsWith('--') || !['session', 'oneshot'].includes(mode)) {
    throw new RangeError('Usage: node bench/cycles-parity/sequence-timing.mjs <sceneJsonPath> --mode session|oneshot [--variant camera|object-light] [--frames 24] [--samples 16] [--width 480] [--height 270] [--seed 1] [--instancing]');
  }
  const variant = readFlag(argumentList, '--variant', 'camera');
  if (!['camera', 'object-light'].includes(variant)) throw new RangeError(`--variant must be camera or object-light; got "${variant}".`);
  const frameCount = Number(readFlag(argumentList, '--frames', 24));
  const width = Number(readFlag(argumentList, '--width', 480));
  const height = Number(readFlag(argumentList, '--height', 270));
  const samples = Number(readFlag(argumentList, '--samples', 16));
  const seed = Number(readFlag(argumentList, '--seed', 1));
  const instancing = argumentList.includes('--instancing');
  const description = JSON.parse(await readFile(resolve(argumentList[0]), 'utf8'));
  const source = await reconstructTraceSceneSource(description);
  const renderOptions = { width, height, samples, bounces: 8, seed };
  const inputs = buildInputs(source, { variant, frameCount, width, height, instancing, renderOptions });
  const { frames, totalSeconds } = runSequence(inputs, mode, { ...renderOptions, kernel: 'cycles' });
  const paths = {};
  for (const frame of frames) paths[frame.path] = (paths[frame.path] ?? 0) + 1;
  const summary = { scene: description.id, mode, variant, instancing, frameCount, width, height, samples, seed, totalSeconds, paths,
    coldFrame: frames[0], warmAverage: Object.fromEntries([...PHASE_NAMES, 'wallSeconds'].map(name => [name, averageOfWarmFrames(frames, name)])), frames };
  console.log(`SEQUENCE_TIMING ${JSON.stringify(summary)}`);
}

await run();
