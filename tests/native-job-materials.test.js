import assert from 'node:assert/strict';
import test from 'node:test';
import { traceFrameNative } from '../scripts/agent-native-trace.mjs';
import { exportNativeSceneTables } from '../scripts/native-bake-page.js';
import { createCamera, describeIgnoredFeatures } from '../src/path-tracer.js';
import * as pack from '../src/path-tracer-gpu-pack.js';
import { cookInstalled, cookModule, cookTest } from './support/cook.js';
import { buildTraceScene, resolveTexture } from '../src/path-tracer-scene.js';

const cook = await cookModule();
const packInput = await cookModule('pack-input');
const packV2 = await cookModule('pack-input-v2');
const jobInput = await cookModule('job-input');
const { STRUCT_STRIDES_V2, buildNativeInputV2, packMaterialRecordV2, upgradeNativeInputV1ToV2, findNativeAddon, prepareCyclesInput, traceNative } = cook ?? {};
const realTracer = cook;
const { buildNativeInput, packNativeMaterialTables } = packInput ?? {};
const { reduceV1MaterialTable } = packV2 ?? {};
const { buildFlattenedJobNativeInput, buildJobNativeInput, carriedMaterialFields } = jobInput ?? {};

const WIDTH = 24;
const HEIGHT = 16;
const camera = createCamera({ eye: [0, 0, 8], target: [0, 0, 0], fov: 50 }, WIDTH, HEIGHT);
const packOptions = { width: WIDTH, height: HEIGHT, samples: 16, bounces: 4, seed: 7, fireflyClamp: 20, noiseThreshold: 0 };
// The options the runner hands the tracer, which patch the kernel parameters of a v1 input as they are upgraded.
const traceOptions = { width: WIDTH, height: HEIGHT, samples: 16, maxSeconds: 60, kernel: 'cycles', noiseThreshold: 0 };
const environment = { keyColor: [3, 3, 3], lightDirection: [0.4, 0.8, 0.5] };

function quad(scale, withUvs = true) {
  return {
    positions: Float32Array.from([-scale, -scale, 0, scale, -scale, 0, scale, scale, 0, -scale, scale, 0]),
    normals: Float32Array.from([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
    ...(withUvs ? { uvs: Float32Array.from([0, 0, 1, 0, 1, 1, 0, 1]) } : {}),
    indices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
  };
}

const translate = x => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, 0, 1];

function checker(size, seedByte) {
  const data = new Uint8ClampedArray(size * size * 4);
  for (let texel = 0; texel < size * size; texel++) {
    data.set([(texel * 37 + seedByte) % 256, (texel * 91) % 256, (texel * 13 + seedByte * 3) % 256, 255 - (texel % 4) * 40], texel * 4);
  }
  return { image: { width: size, height: size, data }, colorSpace: 'srgb' };
}

function part(name, x, material, scale = 0.8) {
  return { name, geometry: quad(scale), matrix: translate(x), material };
}

// Scenes whose materials set none of the fields the v1 job tables drop: their job input must not change.
const unchangedScenes = {
  'plain surfaces and an emitter': [
    part('floor', 0, { color: [0.6, 0.6, 0.6], roughness: 0.9 }),
    part('metal', 0.1, { color: [0.9, 0.7, 0.3], metallic: 1, roughness: 0.2 }),
    part('lamp', 0.2, { color: [1, 0.8, 0.6], emission: 3 }),
  ],
  'textures': [
    part('painted', 0, { color: [1, 1, 1], map: checker(4, 1), normalMap: checker(4, 2), metallicRoughnessMap: checker(4, 3), roughness: 1, metallic: 1 }),
    part('screen', 0.1, { color: [1, 1, 1], emission: 2, emissiveMap: checker(2, 4) }),
    part('leaf', 0.2, { color: [1, 1, 1], map: checker(4, 5), alphaMode: 'mask', alphaCutoff: 0.4 }),
  ],
  'glass, clearcoat, subsurface and a light mask': [
    part('glass', 0, { color: [1, 1, 1], transmission: 0.9, ior: 1.45, roughness: 0.05 }),
    part('lacquer', 0.1, { color: [0.7, 0.1, 0.1], clearcoat: 0.8, clearcoatRoughness: 0.1 }),
    part('wax', 0.2, { color: [0.9, 0.8, 0.6], subsurface: { weight: 0.5, radius: [1, 0.4, 0.2] } }),
    part('masked', 0.3, { color: [0.5, 0.5, 0.9], lightMask: 1 }),
  ],
  'fields set to their defaults': [
    part('blend at full opacity', 0, { color: [0.5, 0.5, 0.5], alphaMode: 'blend', opacity: 1 }),
    part('black sheen', 0.1, { color: [0.5, 0.5, 0.5], sheenColor: [0, 0, 0], sheenRoughness: 0 }),
    part('white specular tint', 0.2, { color: [0.9, 0.9, 0.9], metallic: 1, specularColor: [1, 1, 1], specular: 1 }),
    part('no attenuation', 0.3, { color: [1, 1, 1], transmission: 0.5, attenuationDistance: Infinity, attenuationColor: [0.3, 0.3, 0.3] }),
    part('flat film', 0.4, { color: [0.5, 0.5, 0.5], iridescence: 0, iridescenceThickness: 400, iridescenceIor: 1.3, anisotropy: 0, anisotropyRotation: 0 }),
    part('one sided', 0.5, { color: [0.5, 0.5, 0.5], doubleSided: false }),
  ],
};

function sameBytes(label, actual, expected) {
  const keys = new Set([...Object.keys(actual), ...Object.keys(expected)]);
  for (const key of keys) {
    const left = actual[key];
    const right = expected[key];
    if (ArrayBuffer.isView(left) && ArrayBuffer.isView(right)) {
      const leftBytes = new Uint8Array(left.buffer, left.byteOffset, left.byteLength);
      const rightBytes = new Uint8Array(right.buffer, right.byteOffset, right.byteLength);
      assert.equal(Buffer.compare(leftBytes, rightBytes), 0, `${label}: table ${key} differs`);
    } else {
      assert.deepEqual(left, right, `${label}: ${key} differs`);
    }
  }
}

// What a native job without carried fields sent before: the v1 tables, upgraded by the kernel with the trace options.
function legacyJobInput(parts) {
  return prepareCyclesInput(buildNativeInput(buildTraceScene(parts, environment), camera, packOptions, pack), traceOptions);
}

for (const [sceneName, parts] of Object.entries(unchangedScenes)) {
  cookTest(`a flattened job with ${sceneName} sends the tables it always did`, () => {
    const scene = buildTraceScene(parts, environment);
    const jobInput = buildFlattenedJobNativeInput(scene, camera, packOptions, pack, resolveTexture);
    sameBytes(sceneName, prepareCyclesInput(jobInput, traceOptions), legacyJobInput(parts));
  });
}

cookTest('shared geometry without carried fields keeps the instanced input it had', () => {
  const shared = quad(1);
  const parts = [
    { name: 'copy-a', geometry: shared, matrix: translate(-2), material: { color: [0.8, 0.2, 0.2], roughness: 0.5, map: checker(4, 9) } },
    { name: 'copy-b', geometry: shared, matrix: translate(2), material: { color: [0.2, 0.2, 0.8], clearcoat: 0.5, transmission: 0.2 } },
    ...unchangedScenes['plain surfaces and an emitter'],
  ];
  const scene = buildTraceScene(parts, environment, { instancing: true });
  assert.ok(scene.instances);
  // The instanced input before the carried fields: the same reduction, without them.
  const tables = packNativeMaterialTables(scene.traceMaterials, null, pack);
  const reducedMaterials = reduceV1MaterialTable({ materials: tables.materials, atlas: tables.atlas, atlasWidth: tables.atlasWidth,
    subsurfaceVec4Offset: tables.subsurfaceVec4Offset, materialCount: scene.traceMaterials.length });
  const instances = scene.instances.map(instance => {
    const lightMask = reducedMaterials.materialLightMasks[instance.materialIndex] ?? 0xffffffff;
    return { ...instance, lightMask, lightMaskHi: lightMask === 0xffffffff ? 0xffffffff : 0 };
  });
  const { fireflyClamp, ...withoutClamp } = packOptions;
  const before = buildNativeInputV2(scene, camera, { ...withoutClamp, instances, reducedMaterials });
  sameBytes('instanced', buildJobNativeInput(scene, camera, packOptions, pack, resolveTexture), before);
});

function recordFloats(input, index) {
  const offset = input.materials.byteOffset + index * STRUCT_STRIDES_V2.material;
  return {
    floats: new Float32Array(input.materials.buffer, offset, STRUCT_STRIDES_V2.material / 4),
    words: new Uint32Array(input.materials.buffer, offset, STRUCT_STRIDES_V2.material / 4),
    indices: new Int32Array(input.materials.buffer, offset, STRUCT_STRIDES_V2.material / 4),
  };
}

const ALPHA_BLEND = 2;

// A part for each field the v1 tables drop, laid out as the record fields (float index) they land in.
const carriedParts = [
  part('pane', 0, { color: [0.6, 0.8, 1], opacity: 0.3, alphaMode: 'blend', roughness: 0.1 }),
  part('velvet', 0.1, { color: [0.4, 0.1, 0.5], sheenColor: [0.9, 0.8, 0.7], sheenRoughness: 0.4, roughness: 0.8 }),
  part('glass', 0.2, { color: [1, 1, 1], transmission: 0.9, ior: 1.45, roughness: 0.05, attenuationDistance: 2, attenuationColor: [0.5, 0.8, 0.6] }),
  part('foil', 0.3, { color: [0.9, 0.8, 0.5], metallic: 1, anisotropy: 0.6, anisotropyRotation: 0.5, iridescence: 0.5, iridescenceThickness: 500, iridescenceIor: 1.4, specular: 0.8, specularColor: [1, 0.5, 0.2], roughness: 0.3 }),
  part('lacquer', 0.4, { color: [0.7, 0.1, 0.1], clearcoat: 0.8, clearcoatRoughness: 0.1, coatTint: [0.5, 0.9, 0.5], coatIor: 1.6, coatNormalScale: 0.7, thinWalled: true, diffuseRoughness: 0.3, bumpDistance: 0.02 }),
  part('cloth', 0.5, { color: [0.4, 0.4, 0.8], sheenColor: [1, 1, 1], anisotropy: 0.4, map: checker(4, 6), layerMaps: { sheenColorTexture: checker(2, 7), anisotropyTexture: checker(2, 8), clearcoatNormalTexture: checker(2, 9) }, clearcoat: 0.5 }),
];

cookTest('a flattened job sends blend opacity, sheen, specular, anisotropy, iridescence, attenuation and the coat to the kernel', () => {
  const scene = buildTraceScene(carriedParts, environment);
  const input = buildFlattenedJobNativeInput(scene, camera, packOptions, pack, resolveTexture);
  const pane = recordFloats(input, 0);
  assert.equal(pane.words[49], ALPHA_BLEND);
  assert.ok(Math.abs(pane.floats[14] - 0.3) < 1e-6, 'opacity');
  const velvet = recordFloats(input, 1);
  assert.deepEqual(Array.from(velvet.floats.slice(24, 28)).map(value => Number(value.toFixed(3))), [0.9, 0.8, 0.7, 1]);
  assert.ok(Math.abs(velvet.floats[44] - 0.4) < 1e-6, 'sheen roughness');
  const glass = recordFloats(input, 2);
  assert.equal(glass.floats[31], 2);
  assert.deepEqual(Array.from(glass.floats.slice(28, 31)).map(value => Number(value.toFixed(3))), [0.5, 0.8, 0.6]);
  const foil = recordFloats(input, 3);
  // Strength 0.6 at roughness 0.3 as the Cycles parameters (the conversion of render-cycles.py), rotation in turns.
  const alpha = 0.3 * 0.3;
  const tangentAlpha = alpha + (1 - alpha) * 0.36;
  assert.ok(Math.abs(foil.floats[11] - (1 - alpha / tangentAlpha) / 0.9) < 1e-6, 'anisotropy');
  assert.ok(Math.abs(foil.floats[12] - 0.5 / (2 * Math.PI)) < 1e-6, 'anisotropy rotation in turns');
  assert.ok(Math.abs(foil.floats[4] - (alpha * tangentAlpha) ** 0.25) < 1e-6, 'roughness of an anisotropic material');
  assert.ok(Math.abs(foil.floats[6] - 0.4) < 1e-6, 'specular ior level is half the specular factor');
  assert.deepEqual(Array.from(foil.floats.slice(8, 11)).map(value => Number(value.toFixed(3))), [1, 0.5, 0.2]);
  assert.ok(foil.floats[22] > 0, 'thin film thickness');
  assert.ok(Math.abs(foil.floats[23] - 1.4) < 1e-6, 'thin film ior');
  const lacquer = recordFloats(input, 4);
  assert.deepEqual(Array.from(lacquer.floats.slice(16, 19)).map(value => Number(value.toFixed(3))), [0.5, 0.9, 0.5]);
  assert.ok(Math.abs(lacquer.floats[21] - 1.6) < 1e-6, 'coat ior');
  assert.ok(Math.abs(lacquer.floats[47] - 0.7) < 1e-6, 'coat normal scale');
  assert.ok(Math.abs(lacquer.floats[7] - 0.3) < 1e-6, 'diffuse roughness');
  assert.ok(Math.abs(lacquer.floats[50] - 0.02) < 1e-6, 'bump distance');
  assert.notEqual(lacquer.words[48] & 2, 0, 'thin walled flag');
  const cloth = recordFloats(input, 5);
  assert.ok(cloth.indices[60] >= 0, 'sheen texture');
  assert.ok(cloth.indices[61] >= 0, 'anisotropy texture');
  assert.ok(cloth.indices[59] >= 0, 'coat normal texture');
  assert.ok(cloth.indices[52] >= 0, 'base colour texture still comes from the atlas');
});

cookTest('a flattened and an instanced job send the same record for each part', () => {
  const shared = quad(1);
  const parts = [
    { name: 'copy-a', geometry: shared, matrix: translate(-2), material: { color: [0.8, 0.2, 0.2] } },
    { name: 'copy-b', geometry: shared, matrix: translate(2), material: { color: [0.2, 0.2, 0.8] } },
    ...carriedParts,
  ];
  const flattened = buildFlattenedJobNativeInput(buildTraceScene(parts, environment), camera, packOptions, pack, resolveTexture);
  const instancedScene = buildTraceScene(parts, environment, { instancing: true });
  assert.ok(instancedScene.instances);
  const instanced = buildJobNativeInput(instancedScene, camera, packOptions, pack, resolveTexture);
  assert.equal(instanced.materialCount, flattened.materialCount);
  assert.equal(Buffer.compare(Buffer.from(instanced.materials), Buffer.from(flattened.materials)), 0, 'material records');
  assert.equal(Buffer.compare(Buffer.from(instanced.textureDescriptors), Buffer.from(flattened.textureDescriptors)), 0, 'texture descriptors');
});

cookTest('carried fields never replace what the v1 tables carry', () => {
  const material = { color: [0.6, 0.8, 1], opacity: 0.3, alphaMode: 'blend', map: checker(4, 3), alphaCutoff: 0.5 };
  const scene = buildTraceScene([part('cutout', 0, { ...material, alphaMode: 'mask', opacity: 0.3 })], environment);
  const carried = carriedMaterialFields(scene.partMaterials[0], scene.materials[0], resolveTexture);
  assert.equal(carried.alphaMode, undefined, 'a mask keeps its cutoff and is not blended');
  const blended = carriedMaterialFields({ alphaMode: 'blend', opacity: 1 }, { alphaCutoff: 0, texture: null }, resolveTexture);
  assert.deepEqual(blended, {}, 'blending at full opacity changes no pixel and stays opaque');
  const graphCutout = carriedMaterialFields({ alphaMode: 'blend', opacity: 0.4 }, { alphaCutoff: 0.5 }, resolveTexture);
  assert.deepEqual(graphCutout, {}, 'a graph opacity output stays the cutout at one half');
});

cookTest('layer textures reach the record only while their layer is on', () => {
  const resolved = { transmission: 0, clearcoat: 0, transmissionTexture: { width: 1, height: 1, data: new Uint8ClampedArray(4) }, clearcoatTexture: { width: 1, height: 1, data: new Uint8ClampedArray(4) } };
  assert.deepEqual(carriedMaterialFields({}, resolved, resolveTexture), {});
  const layered = carriedMaterialFields({}, { ...resolved, transmission: 1, clearcoat: 1 }, resolveTexture);
  assert.deepEqual(Object.keys(layered.textures).sort(), ['coatWeightRoughness', 'transmission']);
});

cookTest('a carried record equals the record of the whole material where the tables agree with it', () => {
  const material = { color: [0.4, 0.1, 0.5], roughness: 0.8, sheenColor: [0.9, 0.8, 0.7], sheenRoughness: 0.4, opacity: 0.5, alphaMode: 'blend', attenuationDistance: 3, attenuationColor: [0.2, 0.9, 0.4], transmission: 0.5 };
  const scene = buildTraceScene([part('one', 0, material)], environment);
  const input = buildFlattenedJobNativeInput(scene, camera, packOptions, pack, resolveTexture);
  const whole = packMaterialRecordV2({ ...material, ...scene.materials[0] }, null).bytes;
  const sent = new Uint8Array(input.materials.buffer, input.materials.byteOffset, STRUCT_STRIDES_V2.material);
  assert.equal(Buffer.compare(Buffer.from(sent), Buffer.from(whole)), 0);
});

test('the job report keeps a note only for what the kernel does not shade', () => {
  const parts = [
    { material: { alphaMode: 'blend', opacity: 0.4, anisotropy: 0.5, iridescence: 0.3, sheenColor: [1, 1, 1], transmissionMap: {}, layerMaps: { clearcoatTexture: {}, sheenColorTexture: {}, anisotropyTexture: {}, clearcoatNormalTexture: {} } } },
  ];
  const legacy = describeIgnoredFeatures(parts, { map: {} });
  assert.ok(legacy.includes('Blended transparency is traced as opaque.'));
  assert.ok(legacy.includes('sheen is ignored.'));
  const whole = describeIgnoredFeatures(parts, { map: {} }, 'cpu', { kernelMaterials: true });
  assert.deepEqual(whole, []);
  const left = describeIgnoredFeatures([
    { material: { alphaMode: 'blend', pattern: { type: 'graph', graph: { opacity: 1 } }, moss: 1, occlusionMap: {}, layerMaps: { sheenRoughnessTexture: {}, clearcoatRoughnessTexture: {} }, lightMap: {}, tag: 'liquid' } },
  ], { map: {} }, 'cpu', { kernelMaterials: true });
  assert.deepEqual(left.sort(), [
    'A graph opacity output is traced as a cutout at 0.5.', 'lightMap is ignored.', 'liquid materials are traced as plain surfaces.', 'moss is ignored.',
    'occlusionMap is ignored.', 'splat layers is ignored.',
  ].sort());
});

function exportModules(overrides = {}) {
  return { buildTraceScene, refuseLocalVolumes: () => {}, resolveTexture, buildNativeInput: (scene, view, options, tables) => buildNativeInput(scene, view, options, tables),
    buildJobNativeInput, buildFlattenedJobNativeInput, pack, ...overrides };
}

function exportScene(parts, { kernel = 'cycles', instancing = true, modules = exportModules() } = {}) {
  return exportNativeSceneTables({ parts, environment, camera, options: packOptions, kernel, instancing, modules });
}

cookTest('every cycles job is exported as FORMAT-v2, instanced or not, and the legacy kernel keeps the v1 tables', () => {
  const flattened = exportScene(carriedParts);
  assert.equal(flattened.schemaVersion, 2);
  assert.equal(flattened.wholeMaterials, true);
  assert.equal(flattened.instances, undefined);
  const shared = quad(1);
  const sharedParts = [part('a', -2, { color: [1, 0, 0] }), part('b', 2, { color: [0, 1, 0] })].map(entry => ({ ...entry, geometry: shared }));
  const instanced = exportScene(sharedParts);
  assert.equal(instanced.schemaVersion, 2);
  assert.equal(instanced.instances, 2);
  const withoutInstancing = exportScene(sharedParts, { instancing: false });
  assert.equal(withoutInstancing.schemaVersion, 2);
  assert.equal(withoutInstancing.instances, undefined);
  const legacy = exportScene(carriedParts, { kernel: 'legacy' });
  assert.equal(legacy.schemaVersion, undefined);
  assert.equal(legacy.wholeMaterials, false);
  assert.ok(legacy.tables.triangles);
});

cookTest('a scene whose FORMAT-v2 materials cannot be built is exported as v1 tables with the reason', () => {
  const exported = exportScene(carriedParts, { modules: exportModules({ buildFlattenedJobNativeInput: () => { throw new RangeError('too many textures'); } }) });
  assert.equal(exported.schemaVersion, undefined);
  assert.equal(exported.wholeMaterials, false);
  assert.equal(exported.materialsReason, 'too many textures');
  assert.ok(exported.tables.triangles);
});

const addonSkip = !cookInstalled || !findNativeAddon() ? 'the native addon is not built' : false;

// The linear colour the native tracer returned for a job frame of these parts, or undefined when the box has no adapter.
async function traceJobFrame(parts, kernel, t) {
  const exported = JSON.parse(JSON.stringify({ ...exportScene(parts, { kernel }), ignored: [] }));
  let traced;
  const recordingTracer = { ...realTracer, traceNative(tables, traceOptions) {
    traced = realTracer.traceNative(tables, traceOptions);
    return traced;
  } };
  try {
    await traceFrameNative({ tracer: recordingTracer, exported, width: WIDTH, height: HEIGHT, samples: 8, denoise: 'none', kernel });
  } catch (error) {
    if (/adapter|Vulkan|ray quer/i.test(error.message)) return t.skip(error.message);
    throw error;
  }
  return Buffer.from(traced.rgba.buffer, traced.rgba.byteOffset, traced.rgba.byteLength);
}

cookTest('a job frame of a scene without carried fields has the pixels of the v1 tables', { skip: addonSkip }, async t => {
  const parts = unchangedScenes['glass, clearcoat, subsurface and a light mask'];
  const viaV2 = await traceJobFrame(parts, 'cycles', t);
  if (!viaV2) return;
  const direct = traceNative(buildNativeInput(buildTraceScene(parts, environment), camera, packOptions, pack), { width: WIDTH, height: HEIGHT, samples: 8, kernel: 'cycles' });
  assert.deepEqual(viaV2, Buffer.from(direct.rgba.buffer, direct.rgba.byteOffset, direct.rgba.byteLength));
});

cookTest('a job frame with a blend pane differs from the same scene traced from the v1 tables with the same kernel', { skip: addonSkip }, async t => {
  // The pane hangs in front of the wall (two quads in one plane would hide it).
  const inFront = { ...carriedParts[0], matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 2, 1], geometry: quad(1.5) };
  const parts = [inFront, part('wall', 0, { color: [0.9, 0.2, 0.2] }, 1.5)];
  const viaV2 = await traceJobFrame(parts, 'cycles', t);
  if (!viaV2) return;
  const direct = traceNative(buildNativeInput(buildTraceScene(parts, environment), camera, packOptions, pack), { width: WIDTH, height: HEIGHT, samples: 8, kernel: 'cycles' });
  assert.notDeepEqual(viaV2, Buffer.from(direct.rgba.buffer, direct.rgba.byteOffset, direct.rgba.byteLength));
});

// The kernel reads the green channel of the coat map as a roughness scale and the alpha of the sheen map as one; a Crucible
// material keeps those in other maps, so a weight or tint map is carried only when it cannot change the roughness (#1036).
cookTest('a coat or sheen map is carried only when its other channel cannot change the roughness', () => {
  const coatMask = checker(2, 9);
  const sheenTint = checker(2, 11);
  const resolvedCoat = roughness => ({ clearcoat: 1, clearcoatRoughness: roughness, clearcoatTexture: resolveTexture(coatMask), transmission: 0 });
  const smoothCoat = carriedMaterialFields({ layerMaps: { clearcoatTexture: coatMask } }, resolvedCoat(0), resolveTexture);
  assert.ok(smoothCoat.textures.coatWeightRoughness, 'a coat without roughness keeps its mask');
  const roughCoat = carriedMaterialFields({ layerMaps: { clearcoatTexture: coatMask } }, resolvedCoat(0.3), resolveTexture);
  assert.equal(roughCoat.textures, undefined, 'the green channel of a mask would scale the roughness');
  const packedCoat = carriedMaterialFields({ layerMaps: { clearcoatTexture: coatMask, clearcoatRoughnessTexture: { ...coatMask } } }, resolvedCoat(0.3), resolveTexture);
  assert.ok(packedCoat.textures.coatWeightRoughness, 'one image for weight and roughness is what the slot holds');

  const sheen = roughness => ({ sheenColor: [1, 1, 1], sheenRoughness: roughness, layerMaps: { sheenColorTexture: sheenTint } });
  assert.ok(carriedMaterialFields(sheen(0), { transmission: 0, clearcoat: 0 }, resolveTexture).textures.sheenColorRoughness);
  assert.equal(carriedMaterialFields(sheen(0.5), { transmission: 0, clearcoat: 0 }, resolveTexture).textures, undefined);

  const notes = describeIgnoredFeatures([{ material: { clearcoat: 1, clearcoatRoughness: 0.3, layerMaps: { clearcoatTexture: coatMask } } }], { map: {} }, 'cpu', { kernelMaterials: true });
  assert.deepEqual(notes, ['A clearcoat or sheen colour map is ignored when the layer has a roughness above 0 kept in another map.']);
});

cookTest('a record field that is not a finite number, a boolean or an array of finite numbers is refused', () => {
  const resolved = { transmission: 0, clearcoat: 0 };
  assert.throws(() => carriedMaterialFields({ coatIor: 'glass' }, resolved, resolveTexture), /Material field coatIor must be a finite number/);
  assert.throws(() => carriedMaterialFields({ coatTint: [1, Number.NaN, 1] }, resolved, resolveTexture), /Material field coatTint/);
  assert.deepEqual(carriedMaterialFields({ coatIor: 1.6, thinWalled: true, coatTint: [0.5, 0.9, 0.5] }, resolved, resolveTexture), { coatIor: 1.6, thinWalled: true, coatTint: [0.5, 0.9, 0.5] });
});
