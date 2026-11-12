// The material parity of a native job against Cycles, per material field.
//   node bench/job-materials/parity.mjs describe <folder> [scene...]
//     Writes <scene>.json, the scene description render-cycles.py reads (bench/cycles-parity).
//   node bench/job-materials/parity.mjs cook|before <folder> <samples> [scene...]
//     Reads <scene>.json, exports the scene the way a native render job does (FORMAT-v2 tables for the "cycles" kernel),
//     traces it with the runner function of the job (traceFrameNative) and writes <scene>-cook.npy (linear RGB); `before` writes <scene>-before.npy from the v1 tables.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PARITY_SCENE_NAMES, parityScene } from './scenes.mjs';
import { reconstructTraceSceneSource, serializeSceneDescription } from '../cycles-parity/scene-bridge.mjs';
import { writeFloat32Npy } from '../cycles-parity/npy.mjs';

export const WIDTH = 192;
export const HEIGHT = 128;

async function describe(folder, names) {
  for (const name of names) {
    const description = await serializeSceneDescription(name, parityScene(name));
    await writeFile(join(folder, `${name}.json`), JSON.stringify(description));
  }
}

// `before` exports the way a job did before #1036: the v1 tables, which drop the fields the kernel now receives.
async function cook(folder, samples, names, before) {
  const [{ exportNativeSceneTables }, { createCamera }, pack, { buildTraceScene, refuseLocalVolumes, resolveTexture }, { buildNativeInput }, jobInput, { traceFrameNative }, tracer] = await Promise.all([
    import('../../scripts/native-bake-page.js'), import('../../src/path-tracer.js'), import('../../src/path-tracer-gpu-pack.js'),
    import('../../src/path-tracer-scene.js'), import('../../packages/render-native/pack-input.mjs'), import('../../packages/render-native/job-input.mjs'),
    import('../../scripts/agent-native-trace.mjs'), import('../../packages/render-native/index.mjs'),
  ]);
  const modules = { buildTraceScene, refuseLocalVolumes, resolveTexture, buildNativeInput, buildJobNativeInput: jobInput.buildJobNativeInput,
    buildFlattenedJobNativeInput: before ? () => { throw new RangeError('before #1036'); } : jobInput.buildFlattenedJobNativeInput, pack };
  for (const name of names) {
    const description = JSON.parse(await readFile(join(folder, `${name}.json`), 'utf8'));
    const source = await reconstructTraceSceneSource(description);
    const camera = createCamera(source.camera, WIDTH, HEIGHT);
    const options = { width: WIDTH, height: HEIGHT, bounces: 8, seed: 1, fireflyClamp: 20, noiseThreshold: 0, samples };
    const exportedTables = exportNativeSceneTables({ parts: source.parts, environment: source.environment, camera, options, kernel: 'cycles', instancing: true, modules });
    const exported = JSON.parse(JSON.stringify({ ...exportedTables, ignored: [] }));
    let traced;
    const recordingTracer = { ...tracer, traceNative(tables, traceOptions) {
      traced = tracer.traceNative(tables, traceOptions);
      return traced;
    } };
    const result = await traceFrameNative({ tracer: recordingTracer, exported, width: WIDTH, height: HEIGHT, samples, bounces: 8, seed: 1, denoise: 'none', kernel: 'cycles' });
    const linear = new Float32Array(WIDTH * HEIGHT * 3);
    for (let pixel = 0; pixel < WIDTH * HEIGHT; pixel++) linear.set(traced.rgba.subarray(pixel * 4, pixel * 4 + 3), pixel * 3);
    await writeFloat32Npy(join(folder, `${name}-${before ? 'before' : 'cook'}.npy`), linear, [HEIGHT, WIDTH, 3]);
    console.log(JSON.stringify({ scene: name, wholeMaterials: exported.wholeMaterials, schemaVersion: exported.schemaVersion, tracedSeconds: result.report.tracedSeconds }));
  }
}

const [command, folderArgument, ...rest] = process.argv.slice(2);
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const folder = resolve(folderArgument ?? '');
  await mkdir(folder, { recursive: true });
  if (command === 'describe') await describe(folder, rest.length ? rest : PARITY_SCENE_NAMES);
  else if (command === 'cook' || command === 'before') await cook(folder, Number(rest[0]), rest.length > 1 ? rest.slice(1) : PARITY_SCENE_NAMES, command === 'before');
  else throw new RangeError('Usage: describe <folder> [scene...], or cook|before <folder> <samples> [scene...].');
}
