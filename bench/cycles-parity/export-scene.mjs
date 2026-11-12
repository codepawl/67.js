// Exports a 67js reference scene to JSON for Cycles parity runs and verifies lossless round-trip packing.
//   node bench/cycles-parity/export-scene.mjs <outputDirectory> [--scene lit-interior]
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createCamera } from '../../src/path-tracer.js';
import * as packModule from '../../src/path-tracer-gpu-pack.js';
import { buildTraceSceneWithManyLights } from './trace-scene-many-lights.mjs';
import { buildNativeInput } from '../../packages/render-native/pack-input.mjs';
import { loadReferenceScene, reconstructTraceSceneSource, serializeSceneDescription } from './scene-bridge.mjs';

const TABLE_NAMES = ['triangles', 'materials', 'lights', 'atlas', 'environmentColors', 'environmentTables', 'parameters'];

function readFlagValue(argumentList, flagName, fallbackValue) {
  const flagIndex = argumentList.indexOf(flagName);
  if (flagIndex === -1) {
    return fallbackValue;
  }
  const nextValue = argumentList[flagIndex + 1];
  if (nextValue === undefined || nextValue.startsWith('--')) {
    throw new RangeError(`Flag ${flagName} requires a value.`);
  }
  return nextValue;
}

function viewAsBytes(typedArray) {
  return Buffer.from(typedArray.buffer, typedArray.byteOffset, typedArray.byteLength);
}

function buildPackedTables(traceSource) {
  const options = {
    width: 960,
    height: 540,
    bounces: 8,
    seed: 1,
    fireflyClamp: 1e9,
    noiseThreshold: 0,
  };
  const traceScene = buildTraceSceneWithManyLights(traceSource.parts, traceSource.environment);
  const camera = createCamera(traceSource.camera, options.width, options.height);
  return buildNativeInput(traceScene, camera, options, packModule);
}

function assertIdenticalPackedInputs(directInput, roundTripInput, sceneId) {
  if (directInput.triangleCount !== roundTripInput.triangleCount) {
    throw new Error(`Scene "${sceneId}" round-trip triangleCount mismatch: ${directInput.triangleCount} vs ${roundTripInput.triangleCount}.`);
  }
  for (const tableName of TABLE_NAMES) {
    const directBytes = viewAsBytes(directInput[tableName]);
    const roundTripBytes = viewAsBytes(roundTripInput[tableName]);
    if (!directBytes.equals(roundTripBytes)) {
      throw new Error(`Scene "${sceneId}" round-trip mismatch in native table "${tableName}" (${directBytes.length} vs ${roundTripBytes.length} bytes).`);
    }
  }
}

async function runCli() {
  const argumentList = process.argv.slice(2);
  if (argumentList.length === 0 || argumentList[0].startsWith('--')) {
    throw new RangeError('Usage: node bench/cycles-parity/export-scene.mjs <outputDirectory> [--scene lit-interior]');
  }
  const outputDirectory = resolve(argumentList[0]);
  const sceneId = readFlagValue(argumentList, '--scene', 'lit-interior');
  const loaded = await loadReferenceScene(sceneId);
  const description = await serializeSceneDescription(sceneId, loaded.rawScene);
  const jsonText = JSON.stringify(description);
  const parsedDescription = JSON.parse(jsonText);
  const reconstructedSource = await reconstructTraceSceneSource(parsedDescription);
  const directInput = buildPackedTables(loaded.traceSource);
  const roundTripInput = buildPackedTables(reconstructedSource);
  assertIdenticalPackedInputs(directInput, roundTripInput, sceneId);
  const scenesDirectory = join(outputDirectory, 'scenes');
  await mkdir(scenesDirectory, { recursive: true });
  const outputPath = join(scenesDirectory, `${sceneId}.json`);
  await writeFile(outputPath, jsonText);
  const summary = {
    sceneId,
    outputPath,
    partCount: description.parts.length,
    materialCount: description.materials.length,
    triangleCount: directInput.triangleCount,
    pointLightCount: (description.environment.pointLights ?? []).length,
    spotLightCount: (description.environment.spotLights ?? []).length,
    areaLightCount: (description.environment.areaLights ?? []).length,
    roundTripVerified: true,
  };
  console.log(JSON.stringify(summary));
}

await runCli();
