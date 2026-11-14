// Times two frames of a persistent native session on an exported scene: a cold frame (shader compile, upload and
// acceleration structure build) against a warm frame (a second camera of the same scene), and the one-shot render of each
// camera for comparison. Prints one SESSION_TIMING line of JSON with the phase seconds, the reuse flags and the SHA-256
// of every float plane, so a run on another build (one without sessions) can be compared byte for byte.
//   node bench/cycles-parity/session-timing.mjs <sceneJsonPath> [--samples 64] [--width 480] [--height 270] [--seed 1]
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createCamera } from '../../src/path-tracer.js';
import * as packModule from '../../src/path-tracer-gpu-pack.js';
import * as renderNative from '@codepawlhq/cook';
import { buildTraceSceneWithManyLights } from './trace-scene-many-lights.mjs';
import { reconstructTraceSceneSource } from './scene-bridge.mjs';

const CAMERA_SHIFT = [0.25, 0.1, 0];
const PHASE_NAMES = ['setupSeconds', 'compileSeconds', 'uploadSeconds', 'accelerationBuildSeconds', 'tracedSeconds'];

function readNumberFlag(argumentList, flagName, fallbackValue) {
  const flagIndex = argumentList.indexOf(flagName);
  return flagIndex === -1 ? fallbackValue : Number(argumentList[flagIndex + 1]);
}

function sha256Of(values) {
  return createHash('sha256').update(Buffer.from(values.buffer, values.byteOffset, values.byteLength)).digest('hex');
}

function summarize(result) {
  const summary = { rgbaSha256: sha256Of(result.rgba), depthSha256: sha256Of(result.depth), adapter: result.adapter };
  for (const phaseName of PHASE_NAMES) {
    summary[phaseName] = Number(result[phaseName].toFixed(6));
  }
  for (const flagName of ['pipelineReused', 'accelerationReused', 'filmReused', 'frameIndex']) {
    if (result[flagName] !== undefined) summary[flagName] = result[flagName];
  }
  return summary;
}

async function run() {
  const argumentList = process.argv.slice(2);
  const width = readNumberFlag(argumentList, '--width', 480);
  const height = readNumberFlag(argumentList, '--height', 270);
  const samples = readNumberFlag(argumentList, '--samples', 64);
  const seed = readNumberFlag(argumentList, '--seed', 1);
  const description = JSON.parse(await readFile(resolve(argumentList[0]), 'utf8'));
  const traceSource = await reconstructTraceSceneSource(description);
  const traceScene = buildTraceSceneWithManyLights(traceSource.parts, traceSource.environment);
  const renderOptions = { width, height, samples, bounces: 8, seed };
  const packOptions = { ...renderOptions, parts: traceSource.parts };
  const cameraA = traceSource.camera;
  const cameraB = { ...cameraA, eye: cameraA.eye.map((value, axis) => value + CAMERA_SHIFT[axis]) };
  const inputOf = (camera) => renderNative.buildNativeInputV2(traceScene, createCamera(camera, width, height), packOptions, packModule);
  const inputA = inputOf(cameraA);
  const inputB = inputOf(cameraB);
  const traceOptions = { ...renderOptions, kernel: 'cycles' };

  const report = { scene: description.id, width, height, samples, seed };
  // The session goes first: a one-shot render would leave the compiled pipeline in the process cache and hide the cold compile.
  if (typeof renderNative.createNativeSession === 'function') {
    const session = renderNative.createNativeSession(inputA, { kernel: 'cycles' });
    report.sessionColdA = summarize(session.render(traceOptions));
    report.sessionWarmB = summarize(session.render({ ...traceOptions, kernelParams: inputB.kernelParams }));
    report.sessionWarmA = summarize(session.render(traceOptions));
    session.close();
  }
  report.oneShotA = summarize(renderNative.traceNative(inputA, traceOptions));
  report.oneShotB = summarize(renderNative.traceNative(inputB, traceOptions));
  if (report.sessionColdA) {
    report.sessionMatchesOneShot = report.sessionColdA.rgbaSha256 === report.oneShotA.rgbaSha256
      && report.sessionWarmB.rgbaSha256 === report.oneShotB.rgbaSha256
      && report.sessionWarmA.rgbaSha256 === report.oneShotA.rgbaSha256;
  }
  console.log(`SESSION_TIMING ${JSON.stringify(report)}`);
}

await run();
