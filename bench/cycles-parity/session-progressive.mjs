// Checks and times the progressive film and the scene update of a persistent native session (issue 896, slice S2) on an
// exported scene:
//   1. one image built over several calls against one render of the same samples, for both samplers and with path regeneration
//      on and off (SHA-256 of every float plane);
//   2. an update of material values, and of material values plus instance transforms, against a fresh one-shot render of the
//      final input, and its cost against a new session (create and first render).
// Prints one SESSION_PROGRESSIVE line of JSON.
//   node bench/cycles-parity/session-progressive.mjs <sceneJsonPath> [--samples 32] [--width 480] [--height 270] [--seed 1]
//     [--update-samples 4]
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createCamera } from '../../src/path-tracer.js';
import * as packModule from '../../src/path-tracer-gpu-pack.js';
import * as renderNative from '../../packages/render-native/index.mjs';
import { buildTraceSceneWithManyLights } from './trace-scene-many-lights.mjs';
import { reconstructTraceSceneSource } from './scene-bridge.mjs';

const PLANES = ['rgba', 'depth', 'albedo', 'normal', 'variance'];
const MATERIAL_RECORD_BYTES = 256;
const INSTANCE_RECORD_BYTES = 160;
const BASE_COLOR_SCALE = 0.6;
const TRANSLATION = [0.05, 0, 0.03];

function readNumberFlag(argumentList, flagName, fallbackValue) {
  const flagIndex = argumentList.indexOf(flagName);
  return flagIndex === -1 ? fallbackValue : Number(argumentList[flagIndex + 1]);
}

function sha256Of(values) {
  return createHash('sha256').update(Buffer.from(values.buffer, values.byteOffset, values.byteLength)).digest('hex');
}

function planeHashes(result) {
  return Object.fromEntries(PLANES.map((plane) => [plane, sha256Of(result[plane])]));
}

function sameHashes(left, right) {
  return PLANES.every((plane) => left[plane] === right[plane]);
}

function roundSeconds(seconds) {
  return Number(seconds.toFixed(6));
}

// Scales the base colour (three floats at the start of each material record) so the table differs in values only.
function withDimmedMaterials(input) {
  const materials = new Uint8Array(input.materials);
  const view = new DataView(materials.buffer);
  for (let record = 0; record < input.materialCount; record += 1) {
    for (let channel = 0; channel < 3; channel += 1) {
      const byteOffset = record * MATERIAL_RECORD_BYTES + channel * 4;
      view.setFloat32(byteOffset, view.getFloat32(byteOffset, true) * BASE_COLOR_SCALE, true);
    }
  }
  return { ...input, materials };
}

// Translates every instance: the object-to-world translation grows by the offset and the world-to-object translation
// shrinks by the linear part applied to it.
function withShiftedInstances(input) {
  const instances = new Uint8Array(input.instances);
  const view = new DataView(instances.buffer);
  for (let record = 0; record < input.instanceCount; record += 1) {
    const base = record * INSTANCE_RECORD_BYTES;
    for (let row = 0; row < 3; row += 1) {
      const objectToWorldTranslation = base + row * 16 + 12;
      view.setFloat32(objectToWorldTranslation, view.getFloat32(objectToWorldTranslation, true) + TRANSLATION[row], true);
      const inverseRow = base + 48 + row * 16;
      let shift = 0;
      for (let column = 0; column < 3; column += 1) {
        shift += view.getFloat32(inverseRow + column * 4, true) * TRANSLATION[column];
      }
      view.setFloat32(inverseRow + 12, view.getFloat32(inverseRow + 12, true) - shift, true);
    }
  }
  return { ...input, instances };
}

function checkSplits(input, baseOptions, samples) {
  const splits = [[samples / 2, samples / 2], [Math.floor(samples / 4), Math.floor(samples / 2) - 1, samples - Math.floor(samples / 4) - Math.floor(samples / 2) + 1]];
  const rows = [];
  const session = renderNative.createNativeSession(input);
  try {
    for (const sampler of ['sobol-burley', 'white']) {
      for (const pathRegeneration of [true, false]) {
        const options = { ...baseOptions, samples, sampler, pathRegeneration };
        const oneShot = planeHashes(renderNative.traceNative(input, options));
        for (const parts of splits) {
          session.reset();
          let result;
          let drawn = 0;
          for (const partSamples of parts) {
            result = session.render({ ...options, samples: partSamples, accumulate: true, ...(drawn === 0 ? { targetSamples: samples } : {}) });
            drawn += partSamples;
          }
          const resolved = planeHashes(session.resolve());
          rows.push({
            sampler,
            pathRegeneration,
            split: parts.join('+'),
            identical: sameHashes(oneShot, planeHashes(result)),
            resolveIdentical: sameHashes(oneShot, resolved),
            filmSamples: result.filmSamples,
          });
        }
      }
    }
  } finally {
    session.close();
  }
  return rows;
}

function timeUpdate(session, finalInput, options) {
  const started = performance.now();
  const update = session.update(finalInput);
  const frame = session.render(options);
  const wallMilliseconds = performance.now() - started;
  const oneShot = planeHashes(renderNative.traceNative(finalInput, options));
  return {
    wallMilliseconds: Number(wallMilliseconds.toFixed(2)),
    identicalToOneShot: sameHashes(oneShot, planeHashes(frame)),
    uploadedTables: update.uploadedTables,
    accelerationRebuilt: update.accelerationRebuilt,
    changedInstances: update.changedInstances,
    kernelRespecialized: update.kernelRespecialized,
    updateSeconds: roundSeconds(update.updateSeconds),
    uploadSeconds: roundSeconds(update.uploadSeconds),
    accelerationRebuildSeconds: roundSeconds(update.accelerationRebuildSeconds),
    renderPipelineReused: frame.pipelineReused,
    renderAccelerationReused: frame.accelerationReused,
    renderCompileSeconds: roundSeconds(frame.compileSeconds),
    renderAccelerationBuildSeconds: roundSeconds(frame.accelerationBuildSeconds),
    renderTracedSeconds: roundSeconds(frame.tracedSeconds),
  };
}

function timeNewSession(input, options) {
  const started = performance.now();
  const session = renderNative.createNativeSession(input);
  try {
    const frame = session.render(options);
    return {
      wallMilliseconds: Number((performance.now() - started).toFixed(2)),
      setupSeconds: roundSeconds(frame.setupSeconds),
      uploadSeconds: roundSeconds(frame.uploadSeconds),
      accelerationBuildSeconds: roundSeconds(frame.accelerationBuildSeconds),
      compileSeconds: roundSeconds(frame.compileSeconds),
      tracedSeconds: roundSeconds(frame.tracedSeconds),
    };
  } finally {
    session.close();
  }
}

async function run() {
  const argumentList = process.argv.slice(2);
  const width = readNumberFlag(argumentList, '--width', 480);
  const height = readNumberFlag(argumentList, '--height', 270);
  const samples = readNumberFlag(argumentList, '--samples', 32);
  const updateSamples = readNumberFlag(argumentList, '--update-samples', 4);
  const seed = readNumberFlag(argumentList, '--seed', 1);
  const description = JSON.parse(await readFile(resolve(argumentList[0]), 'utf8'));
  const traceSource = await reconstructTraceSceneSource(description);
  const traceScene = buildTraceSceneWithManyLights(traceSource.parts, traceSource.environment);
  const renderOptions = { width, height, samples, bounces: 8, seed, kernel: 'cycles' };
  const packOptions = { ...renderOptions, parts: traceSource.parts };
  const inputA = renderNative.buildNativeInputV2(traceScene, createCamera(traceSource.camera, width, height), packOptions, packModule);
  const dimmed = withDimmedMaterials(inputA);
  const shifted = withShiftedInstances(dimmed);
  const updateOptions = { ...renderOptions, samples: updateSamples };

  const report = {
    scene: description.id,
    width,
    height,
    samples,
    updateSamples,
    instanceCount: inputA.instanceCount,
    triangleCount: inputA.triangleCount,
  };
  // A new session goes first: it pays the shader compile, which the process keeps afterwards for any session.
  report.newSessionCold = timeNewSession(shifted, updateOptions);
  report.newSessionCachedPipeline = timeNewSession(shifted, updateOptions);
  report.splits = checkSplits(inputA, renderOptions, samples);
  report.allSplitsIdentical = report.splits.every((row) => row.identical && row.resolveIdentical);

  const session = renderNative.createNativeSession(inputA);
  try {
    session.render(updateOptions);
    report.updateMaterials = timeUpdate(session, dimmed, updateOptions);
    report.updateMaterialsAndTransforms = timeUpdate(session, shifted, updateOptions);
    report.updateBackToStart = timeUpdate(session, inputA, updateOptions);
  } finally {
    session.close();
  }
  report.allUpdatesIdentical = [report.updateMaterials, report.updateMaterialsAndTransforms, report.updateBackToStart]
    .every((row) => row.identicalToOneShot);
  report.adapter = renderNative.traceNative(inputA, { ...updateOptions, samples: 1 }).adapter;
  console.log(`SESSION_PROGRESSIVE ${JSON.stringify(report)}`);
}

await run();
