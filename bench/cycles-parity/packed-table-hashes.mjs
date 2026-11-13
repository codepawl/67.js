// SHA-256 of every packed table of two scenes under the old 400,000 triangle bound, to show a change to buildTraceScene's triangle bound
// leaves the bytes alone (#1041): the lit-interior reference scene (flattened, as v1 tables and as FORMAT-v2 job tables) and an
// instanced scene (FORMAT-v2 job tables). Run it before and after a change and compare the output.
//   node bench/cycles-parity/packed-table-hashes.mjs [--native-bound] [--scenes lit-interior,many-lights-500,spot-area]
// --scenes hashes those reference scenes (#1060: a change to the light tables must leave scenes without the new field byte for byte).
// --native-bound builds with maximumTriangles, which a build before #1041 ignores.
import { createHash } from 'node:crypto';
import { createCamera } from '../../src/path-tracer.js';
import * as pack from '../../src/path-tracer-gpu-pack.js';
import { buildNativeInput } from '../../packages/render-native/pack-input.mjs';
import { buildFlattenedJobNativeInput, buildJobNativeInput } from '../../packages/render-native/job-input.mjs';
import { buildTraceScene, resolveTexture } from '../../src/path-tracer-scene.js';
import { buildTraceSceneWithManyLights } from './trace-scene-many-lights.mjs';
import { loadReferenceScene } from './scene-bridge.mjs';
import { NATIVE_CAP_ENVIRONMENT, NATIVE_CAP_PACK_OPTIONS, buildNativeCapParts, nativeCapCamera } from './native-cap-scene.mjs';

const LIT_INTERIOR_OPTIONS = { width: 960, height: 540, bounces: 8, seed: 1, fireflyClamp: 1e9, noiseThreshold: 0 };

function hashTables(input) {
  const hashes = {};
  for (const [name, value] of Object.entries(input)) {
    if (ArrayBuffer.isView(value)) hashes[name] = createHash('sha256').update(Buffer.from(value.buffer, value.byteOffset, value.byteLength)).digest('hex');
    else if (typeof value === 'number') hashes[name] = value;
  }
  return hashes;
}

async function referenceSceneHashes(sceneName, buildOptions) {
  const { traceSource } = await loadReferenceScene(sceneName);
  const camera = createCamera(traceSource.camera, LIT_INTERIOR_OPTIONS.width, LIT_INTERIOR_OPTIONS.height);
  const scene = buildTraceSceneWithManyLights(traceSource.parts, traceSource.environment, buildOptions);
  return {
    flattenedV1: hashTables(buildNativeInput(scene, camera, LIT_INTERIOR_OPTIONS, pack)),
    flattenedJobV2: hashTables(buildFlattenedJobNativeInput(scene, camera, LIT_INTERIOR_OPTIONS, pack, resolveTexture)),
  };
}

function instancedSceneHashes(buildOptions) {
  const { parts } = buildNativeCapParts(20_000, true);
  const scene = buildTraceScene(parts, NATIVE_CAP_ENVIRONMENT, { instancing: true, ...buildOptions });
  return { instancedJobV2: hashTables(buildJobNativeInput(scene, nativeCapCamera(), NATIVE_CAP_PACK_OPTIONS, pack, resolveTexture)) };
}

const buildOptions = process.argv.includes('--native-bound') ? { maximumTriangles: 4_000_000 } : {};
const scenesFlagIndex = process.argv.indexOf('--scenes');
if (scenesFlagIndex === -1) {
  console.log(JSON.stringify({ litInterior: await referenceSceneHashes('lit-interior', buildOptions), instanced: instancedSceneHashes(buildOptions) }, null, 1));
} else {
  const hashesByScene = {};
  for (const sceneName of process.argv[scenesFlagIndex + 1].split(',')) {
    hashesByScene[sceneName] = await referenceSceneHashes(sceneName, buildOptions);
  }
  console.log(JSON.stringify({ scenes: hashesByScene, instanced: instancedSceneHashes(buildOptions) }, null, 1));
}
