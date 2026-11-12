// Job-level check of the export size rule (#1055): about 1,500,000 unique triangles with 150,000 instances stay inside both job bounds but
// not inside one message, so the export must refuse with the new RangeError; the same triangles with 20,000 instances must export.
//   NODE_OPTIONS=--max-old-space-size=16384 node bench/cycles-parity/native-export-size-check.mjs
import * as pack from '../../src/path-tracer-gpu-pack.js';
import { buildNativeInput } from '../../packages/render-native/pack-input.mjs';
import { buildFlattenedJobNativeInput, buildJobNativeInput } from '../../packages/render-native/job-input.mjs';
import { buildTraceScene, refuseLocalVolumes, resolveTexture } from '../../src/path-tracer-scene.js';
import { NATIVE_EXPORT_MAXIMUM_CHARACTERS, exportNativeSceneTables } from '../../scripts/native-bake-page.js';
import { NATIVE_CAP_ENVIRONMENT, NATIVE_CAP_PACK_OPTIONS, buildNativeCapParts, nativeCapCamera } from './native-cap-scene.mjs';
import { buildCardField } from './native-instance-scene.mjs';

const modules = { buildTraceScene, refuseLocalVolumes, resolveTexture, buildNativeInput, buildJobNativeInput, buildFlattenedJobNativeInput, pack };

function exportWithCards(cardCount) {
  const parts = [...buildNativeCapParts(1_500_000, true).parts, ...buildCardField(cardCount, cardCount)];
  try {
    const exported = exportNativeSceneTables({ parts, environment: NATIVE_CAP_ENVIRONMENT, camera: nativeCapCamera(), options: NATIVE_CAP_PACK_OPTIONS, kernel: 'cycles', instancing: true, modules });
    const characters = Object.values(exported.tables).reduce((total, text) => total + text.length, 0);
    return { cardCount, outcome: 'exported', instances: exported.instances, triangles: exported.triangles, characters, limit: NATIVE_EXPORT_MAXIMUM_CHARACTERS, instancing: exported.instancing ?? 'kept' };
  } catch (error) {
    return { cardCount, outcome: 'refused', exportTooLarge: error.exportTooLarge === true, message: error.message };
  }
}

for (const cardCount of [20_000, 150_000]) console.log(`NATIVE_EXPORT_SIZE ${JSON.stringify(exportWithCards(cardCount))}`);
