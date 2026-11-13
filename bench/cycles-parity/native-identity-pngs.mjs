// SHA-256 of the PNG of a few scenes under the old bounds, traced through the job export on both native kernels (#1055). Run it on a
// build before a change to the instance bound and on the build after it, and compare the output: the pictures must be equal.
//   node bench/cycles-parity/native-identity-pngs.mjs
import { createHash } from 'node:crypto';
import * as pack from '../../src/path-tracer-gpu-pack.js';
import { buildNativeInput } from '../../packages/render-native/pack-input.mjs';
import { buildFlattenedJobNativeInput, buildJobNativeInput } from '../../packages/render-native/job-input.mjs';
import { buildTraceScene, refuseLocalVolumes, resolveTexture } from '../../src/path-tracer-scene.js';
import { exportNativeSceneTables } from '../../scripts/native-bake-page.js';
import { NATIVE_CAP_ENVIRONMENT, NATIVE_CAP_PACK_OPTIONS, buildNativeCapParts, nativeCapCamera } from './native-cap-scene.mjs';
import { CARD_FIELD_ENVIRONMENT, CARD_FIELD_PACK_OPTIONS, buildCardField, buildCardFieldMerged, cardFieldCamera } from './native-instance-scene.mjs';

const SAMPLES = 8;
const CARD_COUNT = 3000;
const modules = { buildTraceScene, refuseLocalVolumes, resolveTexture, buildNativeInput, buildJobNativeInput, buildFlattenedJobNativeInput, pack };

const scenes = [
  { name: 'native-cap-20000', parts: buildNativeCapParts(20_000, true).parts, environment: NATIVE_CAP_ENVIRONMENT, camera: nativeCapCamera(), options: NATIVE_CAP_PACK_OPTIONS },
  { name: 'cards-3000-shared', parts: buildCardField(CARD_COUNT, 2000), environment: CARD_FIELD_ENVIRONMENT, camera: cardFieldCamera(CARD_COUNT), options: CARD_FIELD_PACK_OPTIONS },
  { name: 'cards-3000-merged', parts: buildCardFieldMerged(CARD_COUNT, 2000), environment: CARD_FIELD_ENVIRONMENT, camera: cardFieldCamera(CARD_COUNT), options: CARD_FIELD_PACK_OPTIONS },
];
const routes = [
  { name: 'cycles-instanced', kernel: 'cycles', instancing: true },
  { name: 'cycles-flattened', kernel: 'cycles', instancing: false },
  { name: 'legacy', kernel: 'legacy', instancing: false },
];

const tracer = await import('../../packages/render-native/index.mjs');
const { traceFrameNative } = await import('../../scripts/agent-native-trace.mjs');
const hashes = {};
for (const scene of scenes) {
  for (const route of routes) {
    try {
      const exported = exportNativeSceneTables({ parts: scene.parts, environment: scene.environment, camera: scene.camera, options: scene.options, kernel: route.kernel, instancing: route.instancing, modules });
      const frame = await traceFrameNative({ tracer, exported: { ...exported, ignored: [] }, width: scene.options.width, height: scene.options.height, samples: SAMPLES,
        bounces: scene.options.bounces, seed: 1, denoise: 'none', kernel: route.kernel });
      hashes[`${scene.name} ${route.name}`] = `${createHash('sha256').update(Buffer.from(frame.data, 'base64')).digest('hex')} instances=${exported.instances ?? 0}`;
    } catch (error) {
      // A refusal is part of the comparison: the old and new build must refuse a scene with the same words.
      hashes[`${scene.name} ${route.name}`] = `refused: ${error.message}`;
    }
  }
}
console.log(`NATIVE_IDENTITY ${JSON.stringify(hashes, null, 1)}`);
