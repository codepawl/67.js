// Times a bounded sequence of frames (24 by default) on an exported scene, one mode per process so the cold compile of one mode never
// warms the other: "session" renders the frames through a native sequence (the route a stills or video job takes), "oneshot" renders each with
// traceNative. Prints one SEQUENCE_TIMING line of JSON with the per-frame phase seconds, the route of each frame, the wall seconds of the
// whole sequence and the SHA-256 of every frame, so the two modes can be compared byte for byte.
//   node bench/cycles-parity/sequence-timing.mjs <sceneJsonPath> --mode session|oneshot [--variant camera|object-light] [--frames 24]
//     [--samples 16] [--width 480] [--height 270] [--seed 1] [--instancing]
// Variants: "camera" orbits the camera; "object-light" also moves the part named "block" and swings the first point light's intensity.
// --instancing builds the scene with shared geometry, so a moved part is an instance transform (an update) instead of new triangles.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createCamera } from '../../src/path-tracer.js';
import * as packModule from '../../src/path-tracer-gpu-pack.js';
import { buildTraceScene } from '../../src/path-tracer-scene.js';
import * as renderNative from '@codepawlhq/cook';
import { PHASE_NAMES, averageOfWarmFrames, readFlag, runSequence } from './sequence-bench-core.mjs';
import { applyCookOnlyFields } from './cook-only-fields.mjs';
import { buildTraceSceneWithManyLights } from './trace-scene-many-lights.mjs';
import { reconstructTraceSceneSource } from './scene-bridge.mjs';

const MOVING_PART_NAME = 'block';
const ORBIT_RADIANS = Math.PI / 6;

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
  const { frames, totalSeconds } = runSequence(inputs.length, frameIndex => inputs[frameIndex], mode, { ...renderOptions, kernel: 'cycles' });
  const paths = {};
  for (const frame of frames) paths[frame.path] = (paths[frame.path] ?? 0) + 1;
  const summary = { scene: description.id, mode, variant, instancing, frameCount, width, height, samples, seed, totalSeconds, paths,
    coldFrame: frames[0], warmAverage: Object.fromEntries([...PHASE_NAMES, 'wallSeconds'].map(name => [name, averageOfWarmFrames(frames, name)])), frames };
  console.log(`SEQUENCE_TIMING ${JSON.stringify(summary)}`);
}

await run();
