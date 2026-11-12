import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FORMAT_V2_MAGIC,
  FORMAT_V2_VERSION,
  KERNEL_PARAMS_V2_FILTER_GLOSSY_BYTE_OFFSET,
  STRUCT_STRIDES_V2,
  buildNativeInput,
  buildNativeInputV2,
  findNativeAddon,
  packMaterialRecordV2,
  probeCyclesLobe,
  traceNative,
  upgradeNativeInputV1ToV2,
} from '../packages/render-native/index.mjs';
import { validatePackOptions } from '../packages/render-native/pack-input-v2.mjs';
import { createEnvironmentMap } from '../src/hdri.js';
import { createCamera } from '../src/path-tracer.js';
import * as pack from '../src/path-tracer-gpu-pack.js';
import { buildTraceScene } from '../src/path-tracer-scene.js';

function quadGeometry(z = 0) {
  return {
    positions: new Float32Array([
      -1, -1, z,
      1, -1, z,
      1, 1, z,
      -1, 1, z,
    ]),
    normals: new Float32Array([
      0, 0, 1,
      0, 0, 1,
      0, 0, 1,
      0, 0, 1,
    ]),
    uvs: new Float32Array([
      0, 1,
      1, 1,
      1, 0,
      0, 0,
    ]),
    colors: new Float32Array([
      1, 1, 1,
      1, 1, 1,
      1, 1, 1,
      1, 1, 1,
    ]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  };
}

function makeCheckerRgba8(width = 4, height = 4, cutoutLeftHalf = false, neutralWhite = false) {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const bright = (x + y) % 2 === 0;
      data[idx] = neutralWhite ? 255 : (bright ? 240 : 60);
      data[idx + 1] = neutralWhite ? 255 : (bright ? 180 : 40);
      data[idx + 2] = neutralWhite ? 255 : (bright ? 100 : 20);
      data[idx + 3] = cutoutLeftHalf && x < width / 2 ? 0 : 255;
    }
  }
  return { width, height, data };
}

function viewRecord(bytes, stride, index = 0) {
  const offset = bytes.byteOffset + index * stride;
  return {
    f32: new Float32Array(bytes.buffer, offset, stride / 4),
    u32: new Uint32Array(bytes.buffer, offset, stride / 4),
    i32: new Int32Array(bytes.buffer, offset, stride / 4),
  };
}

test('buildNativeInputV2 packs empty-emitter scene with valid FORMAT-v2 headers and non-empty dummy tables', () => {
  const parts = [{ name: 'card', geometry: quadGeometry(0), material: { color: [0.6, 0.5, 0.4], roughness: 0.7 } }];
  const scene = buildTraceScene(parts, {});
  const camera = createCamera({ eye: [0, 0, 4], target: [0, 0, 0], fov: 45 }, 32, 16);
  const v2 = buildNativeInputV2(scene, camera, { width: 32, height: 16, samples: 8, bounces: 6, seed: 99 });

  assert.equal(v2.schemaVersion, 2);
  assert.equal(v2.kernelParams.byteLength, STRUCT_STRIDES_V2.kernelParams);
  assert.equal(v2.instanceCount, 1);
  assert.equal(v2.triangleCount, 2);
  assert.equal(v2.materialCount, 1);
  assert.equal(v2.emissiveTriangleCount, 0);
  assert.equal(v2.lightCount, 0);
  assert.equal(v2.lightTreeNodeCount, 0);
  assert.equal(v2.textureCount, 0);

  // Dummy buffers stay >= 16 B and exact stride multiples so storage bindings 2..10 always validate.
  assert.equal(v2.emissiveTriangles.byteLength, STRUCT_STRIDES_V2.emissiveTriangle);
  assert.equal(v2.lights.byteLength, STRUCT_STRIDES_V2.light);
  assert.equal(v2.lightTreeNodes.byteLength, STRUCT_STRIDES_V2.lightTreeNode);
  assert.equal(v2.textureDescriptors.byteLength, STRUCT_STRIDES_V2.textureDescriptor);
  assert.ok(v2.textureTexels.byteLength >= 16);
  assert.ok(v2.environmentTexels.byteLength >= 16);

  const kp = viewRecord(v2.kernelParams, STRUCT_STRIDES_V2.kernelParams);
  assert.equal(kp.u32[0], FORMAT_V2_MAGIC);
  assert.equal(kp.u32[1], FORMAT_V2_VERSION);
  assert.equal(kp.u32[2], 32);
  assert.equal(kp.u32[3], 16);
  assert.equal(kp.u32[6], 8);
  assert.equal(kp.u32[7], 99);
  assert.equal(kp.f32[10], 0);
  assert.equal(kp.f32[11], 0);
  assert.equal(kp.u32[12], 6);
  assert.equal(kp.u32[21], 1);
  assert.equal(kp.u32[22], 2);
  assert.equal(kp.u32[23], 1);
  assert.equal(kp.u32[24], 0);
  assert.equal(kp.u32[25], 0);
  assert.equal(kp.u32[26], 0);
  assert.equal(kp.u32[27], 0);
});

test('buildNativeInputV2 deduplicates shared mesh BLASes, inverts 3x4 transforms, and handles negative-scale instances', () => {
  const sharedMesh = quadGeometry(0);
  const camera = createCamera({ eye: [0, 0, 6], target: [0, 0, 0], fov: 50 }, 16, 16);
  const cosA = Math.cos(0.4);
  const sinA = Math.sin(0.4);
  // Column-major 4x4: rotation around Z + non-uniform scale (2, 0.5, 1.5) + translation (3, -2, 1).
  const positiveTransform = [
    2 * cosA, 2 * sinA, 0, 0,
    -0.5 * sinA, 0.5 * cosA, 0, 0,
    0, 0, 1.5, 0,
    3, -2, 1, 1,
  ];
  // Mirrored across X (det < 0) with translation (-2, 1, -0.5).
  const mirroredTransform = [
    -1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    -2, 1, -0.5, 1,
  ];

  const v2 = buildNativeInputV2(
    {
      materials: [
        { color: [0.8, 0.2, 0.2], roughness: 0.4 },
        { color: [1, 0.9, 0.7], emission: 5, roughness: 0.8 },
      ],
      instances: [
        { geometry: sharedMesh, matrix: positiveTransform, materialIndex: 0 },
        { geometry: sharedMesh, matrix: mirroredTransform, materialOverride: 1, lightMask: 0b101 },
      ],
      lights: {},
    },
    camera,
    { width: 16, height: 16, samples: 1 },
  );

  assert.equal(v2.instanceCount, 2);
  assert.equal(v2.triangleCount, 2, 'shared geometry must pack once into triangles');
  assert.equal(v2.emissiveTriangleCount, 2, 'emissive override instance emits 2 world-space emissive triangles');

  const inst0 = viewRecord(v2.instances, STRUCT_STRIDES_V2.instance, 0);
  const inst1 = viewRecord(v2.instances, STRUCT_STRIDES_V2.instance, 1);
  assert.equal(inst0.u32[24], 0, 'inst0 blas_index');
  assert.equal(inst1.u32[24], 0, 'inst1 shares blas_index 0');
  assert.equal(inst0.u32[29] & 64, 0, 'positive-det instance clears NEGATIVE_SCALE');
  assert.equal(inst1.u32[29] & 64, 64, 'negative-det instance sets INSTANCE_FLAG_NEGATIVE_SCALE (64)');
  assert.equal(inst1.u32[28], 1, 'inst1 material_override');
  assert.equal(inst1.u32[30], 0b101, 'inst1 light_group_mask_lo');
  assert.equal(inst0.u32[32], 0xffffffff, 'non-emissive inst0 emissive_base_offset');
  assert.equal(inst1.u32[32], 0, 'emissive inst1 emissive_base_offset');

  // Verify world_to_object * object_to_world == identity on arbitrary point p = [0.7, -1.3, 2.1].
  const p = [0.7, -1.3, 2.1];
  const o2w = inst0.f32.subarray(0, 12);
  const w2o = inst0.f32.subarray(12, 24);
  const worldP = [
    o2w[0] * p[0] + o2w[1] * p[1] + o2w[2] * p[2] + o2w[3],
    o2w[4] * p[0] + o2w[5] * p[1] + o2w[6] * p[2] + o2w[7],
    o2w[8] * p[0] + o2w[9] * p[1] + o2w[10] * p[2] + o2w[11],
  ];
  const roundTripP = [
    w2o[0] * worldP[0] + w2o[1] * worldP[1] + w2o[2] * worldP[2] + w2o[3],
    w2o[4] * worldP[0] + w2o[5] * worldP[1] + w2o[6] * worldP[2] + w2o[7],
    w2o[8] * worldP[0] + w2o[9] * worldP[1] + w2o[10] * worldP[2] + w2o[11],
  ];
  for (let axis = 0; axis < 3; axis++) {
    assert.ok(Math.abs(roundTripP[axis] - p[axis]) < 1e-5, `axis ${axis} round-trip mismatch`);
  }

  // Mirrored quad across X originally faced +Z; true outward normal after X-mirror still faces +Z!
  const em0 = viewRecord(v2.emissiveTriangles, STRUCT_STRIDES_V2.emissiveTriangle, 0);
  assert.ok(Math.abs(em0.f32[12]) < 1e-6);
  assert.ok(Math.abs(em0.f32[13]) < 1e-6);
  assert.ok(Math.abs(em0.f32[14] - 1.0) < 1e-6, 'mirrored emissive geometric_normal stays +Z');
  const em1 = viewRecord(v2.emissiveTriangles, STRUCT_STRIDES_V2.emissiveTriangle, 1);
  assert.equal(em1.f32[21], 1.0, 'emissive CDF ends at 1.0');

  const tri0 = viewRecord(v2.triangles, STRUCT_STRIDES_V2.triangle, 0);
  const tri1 = viewRecord(v2.triangles, STRUCT_STRIDES_V2.triangle, 1);
  assert.equal(tri0.u32[7], 0, 'shared triangle 0 local_emissive_offset populated for emissive override MIS');
  assert.equal(tri1.u32[7], 1, 'shared triangle 1 local_emissive_offset populated for emissive override MIS');
});

test('packMaterialRecordV2 and texture packing follow Principled v2 flags and deduplicate shared textures', () => {
  const sharedImage = makeCheckerRgba8(4, 4, true);
  const mixedGeo = {
    positions: new Float32Array([
      -1, 0, 0, 1, 0, 0, 0, 1, 0,
      -1, 0, -1, 1, 0, -1, 0, 1, -1,
    ]),
    normals: new Float32Array([
      0, 0, 1, 0, 0, 1, 0, 0, 1,
      0, 0, 1, 0, 0, 1, 0, 0, 1,
    ]),
    uvs: new Float32Array([
      0, 0, 1, 0, 0.5, 1,
      0, 0, 1, 0, 0.5, 1,
    ]),
    indices: new Uint32Array([0, 1, 2, 3, 4, 5]),
    triangleMaterial: new Uint32Array([1, 0]), // tri 0 is cutout (mat 1), tri 1 is opaque (mat 0)
  };
  const floatTex = { width: 2, height: 2, data: new Float32Array(2 * 2 * 4).fill(0.5) };
  const camera = createCamera({ eye: [0, 0, 4], target: [0, 0, 0], fov: 45 }, 16, 16);

  const v2 = buildNativeInputV2(
    {
      materials: [
        {
          color: [0.9, 0.8, 0.5],
          metallic: 1.0,
          roughness: 0.2,
          specular: 0.8,
          specularColor: [1.0, 0.9, 0.7],
          anisotropy: 0.6,
          clearcoat: 1.0,
          clearcoatRoughness: 0.05,
          coatTint: [0.9, 0.95, 1.0],
          iridescence: 1.0,
          iridescenceThickness: 380,
          iridescenceIor: 1.35,
          sheenColor: [0.8, 0.8, 0.9],
          sheenRoughness: 0.4,
          attenuationColor: [0.4, 0.8, 0.9],
          attenuationDistance: 0.25,
          map: { image: sharedImage, colorSpace: 'srgb' },
          normalMap: { image: floatTex },
        },
        {
          color: [1, 1, 1],
          alphaMode: 'mask',
          alphaCutoff: 0.5,
          map: { image: sharedImage, colorSpace: 'srgb' },
        },
      ],
      instances: [{ geometry: mixedGeo, materialIndex: 0 }],
      lights: {},
    },
    camera,
    { width: 16, height: 16, samples: 1, clampDirect: 2.0, clampIndirect: 4.0 },
  );

  // sharedImage used twice -> 1 RGBA8_SRGB descriptor + 1 RGBA32_FLOAT descriptor = 2 total descriptors.
  assert.equal(v2.textureCount, 2);
  const td0 = viewRecord(v2.textureDescriptors, STRUCT_STRIDES_V2.textureDescriptor, 0);
  const td1 = viewRecord(v2.textureDescriptors, STRUCT_STRIDES_V2.textureDescriptor, 1);
  assert.equal(td0.u32[0] % 4, 0, 'td0 16B word alignment');
  assert.equal(td1.u32[0] % 4, 0, 'td1 16B word alignment');
  assert.equal(td0.u32[3] & 0xff, 1, 'RGBA8_SRGB = 1');
  assert.equal(td1.u32[3] & 0xff, 2, 'RGBA32_FLOAT = 2');

  // Within the mesh BLAS, the opaque triangle (originally tri 1) must be ordered before the cutout triangle (tri 0).
  const inst = viewRecord(v2.instances, STRUCT_STRIDES_V2.instance, 0);
  assert.equal(inst.u32[26], 1, 'opaque_triangle_count === 1');
  assert.equal(inst.u32[27], 2, 'total_triangle_count === 2');
  const triOpaque = viewRecord(v2.triangles, STRUCT_STRIDES_V2.triangle, 0);
  const triCutout = viewRecord(v2.triangles, STRUCT_STRIDES_V2.triangle, 1);
  assert.equal(triOpaque.u32[3], 0, 'slot 0 is opaque material 0');
  assert.equal(triCutout.u32[3], 1, 'slot 1 is mask material 1');

  const mat0 = viewRecord(v2.materials, STRUCT_STRIDES_V2.material, 0);
  assert.ok(Math.abs(mat0.f32[6] - 0.4) < 1e-6, 'specular_ior_level = 0.5 * specular');
  assert.ok(Math.abs(mat0.f32[22] - 380) < 1e-6, 'thin_film_thickness');
  assert.ok(Math.abs(mat0.f32[31] - 0.25) < 1e-6, 'absorption_distance');
  assert.equal(mat0.u32[48] & 1, 1, 'MATERIAL_FLAG_MULTISCATTER_GGX = 1u');
  assert.equal(mat0.u32[48] & 4, 4, 'MATERIAL_FLAG_TRANSPARENT_SHADOW = 4u');
  assert.equal(mat0.u32[48] & 8, 8, 'MATERIAL_FLAG_DOUBLE_SIDED = 8u');
  assert.equal(mat0.u32[48] & 32, 32, 'MATERIAL_FLAG_F82_METALLIC = 32u');
  assert.equal(mat0.i32[52], 0, 'base_color_tex');
  assert.equal(mat0.i32[54], 1, 'normal_tex');

  const mat1 = viewRecord(v2.materials, STRUCT_STRIDES_V2.material, 1);
  assert.equal(mat1.u32[49], 1, 'ALPHA_MODE_MASK = 1');
  assert.equal(mat1.i32[52], 0, 'shared base_color_tex');
  assert.equal(mat1.i32[62], -1, 'the base colour map is not also the alpha map: its alpha channel is read as part of base_color_tex');

  // Cycles clamp semantics: multiplied by 3.0.
  const kp = viewRecord(v2.kernelParams, STRUCT_STRIDES_V2.kernelParams);
  assert.ok(Math.abs(kp.f32[10] - 6.0) < 1e-6, 'clamp_direct = 2.0 * 3.0');
  assert.ok(Math.abs(kp.f32[11] - 12.0) < 1e-6, 'clamp_indirect = 4.0 * 3.0');
});

test('buildNativeInputV2 normalizes all 5 Cycles light types, camera-visibility flags, and HDRI marginal/conditional CDFs', () => {
  const hdriPixels = new Float32Array(8 * 4 * 3);
  for (let i = 0; i < 8 * 4; i++) {
    hdriPixels[i * 3] = i === 5 ? 50.0 : 0.5; // 50.0 must clamp to HDRI_RADIANCE_LIMIT = 16
    hdriPixels[i * 3 + 1] = 0.25;
    hdriPixels[i * 3 + 2] = 0.1;
  }
  const envMap = createEnvironmentMap({ width: 8, height: 4, data: hdriPixels, intensity: 1.5 });
  const parts = [{ name: 'floor', geometry: quadGeometry(-2), material: { color: [0.5, 0.5, 0.5] } }];
  const scene = buildTraceScene(parts, {
    map: envMap,
    keyColor: [4, 3, 2],
    lightDirection: [0, 1, 0], // toward sun (+Y), so emission direction must be (0, -1, 0)
    pointLights: [
      { position: [1, 2, 3], color: [1, 0.5, 0.25], intensity: 10, radius: 0.2 },
      { position: [-1, 2, 3], color: [1, 1, 1], intensity: 5, radius: 0 },
    ],
    spotLights: [
      { position: [0, 3, 1], direction: [0, -1, 0], angle: 0.5, penumbra: 0.3, color: [1, 0.9, 0.8], intensity: 20, radius: 0.1 },
    ],
    areaLights: [
      { position: [2, 3, 0], direction: [0, -1, 0], up: [0, 0, 1], width: 2.0, height: 0.5, color: [0.8, 0.9, 1], intensity: 6 },
    ],
  });
  // Also append a disk area light with spread < pi to verify LIGHT_TYPE_AREA_DISK (3) and spread normalization.
  scene.lights.areas.push({
    bit: 26,
    shape: 'disk',
    spread: Math.PI / 3,
    cameraVisible: true,
    position: [-2, 3, 0],
    normal: [0, -1, 0],
    across: [1, 0, 0],
    along: [0, 0, 1],
    width: 1.2,
    height: 1.2,
    color: [1, 1, 1],
    intensity: 4,
  });

  const camera = createCamera({ eye: [0, 0, 5], target: [0, 0, 0], fov: 50 }, 16, 16);
  const v2 = buildNativeInputV2(scene, camera, { width: 16, height: 16, samples: 1 });
  assert.equal(v2.lightCount, 6);

  const sun = viewRecord(v2.lights, STRUCT_STRIDES_V2.light, 0);
  const pointSphere = viewRecord(v2.lights, STRUCT_STRIDES_V2.light, 1);
  const pointDelta = viewRecord(v2.lights, STRUCT_STRIDES_V2.light, 2);
  const spot = viewRecord(v2.lights, STRUCT_STRIDES_V2.light, 3);
  const areaRect = viewRecord(v2.lights, STRUCT_STRIDES_V2.light, 4);
  const areaDisk = viewRecord(v2.lights, STRUCT_STRIDES_V2.light, 5);

  assert.equal(sun.u32[3], 4, 'LIGHT_TYPE_SUN');
  assert.ok(Math.abs(sun.f32[9] + 1.0) < 1e-6, 'sun direction points from emitter into scene (-Y)');
  assert.equal(sun.u32[7] & 4, 0, 'sun CAMERA_VISIBLE off by default');

  assert.equal(pointSphere.u32[3], 0, 'LIGHT_TYPE_POINT');
  const expectedPointRad = 10 / (Math.PI * 0.2 * 0.2);
  assert.ok(Math.abs(pointSphere.f32[4] - expectedPointRad) < 1e-3, 'sphere point radiance = intensity / (pi * r^2)');
  assert.equal(pointSphere.u32[7] & 2, 2, 'finite-radius point enables MULTIPLE_IMPORTANCE');
  assert.equal(pointSphere.u32[7] & 4, 0, 'point CAMERA_VISIBLE off by default');

  assert.ok(Math.abs(pointDelta.f32[4] - 5.0) < 1e-6, 'delta point intensity = color * intensity');
  assert.equal(pointDelta.u32[7] & 2, 0, 'delta point disables MULTIPLE_IMPORTANCE');

  assert.equal(spot.u32[3], 1, 'LIGHT_TYPE_SPOT');
  assert.ok(Math.abs(spot.f32[20] - Math.cos(0.5)) < 1e-6, 'spot cos_half_angle');
  assert.ok(Math.abs(spot.f32[21] - 0.3) < 1e-6, 'spot_blend recovered as 0.3 in [0, 1]');

  assert.equal(areaRect.u32[3], 2, 'LIGHT_TYPE_AREA_RECT');
  assert.ok(Math.abs(areaRect.f32[4] - 0.8 * (6 / (2.0 * 0.5))) < 1e-5, 'area rect radiance = color * intensity / (W * H)');
  assert.equal(areaRect.f32[22], 0, 'default spread=pi sets tan_half_spread = 0');
  assert.equal(areaRect.f32[23], 0, 'default spread=pi sets spread_normalization = 0');

  assert.equal(areaDisk.u32[3], 3, 'LIGHT_TYPE_AREA_DISK');
  assert.equal(areaDisk.u32[7] & 4, 4, 'explicit cameraVisible sets LIGHT_FLAG_CAMERA_VISIBLE');
  assert.ok(areaDisk.f32[22] > 0 && areaDisk.f32[23] > 0, 'spread < pi populates tan_half_spread and spread_normalization');
  assert.equal(areaDisk.f32[29], 1.0, 'analytic light CDF ends at 1.0');

  // HDRI texels + marginal + conditional CDF invariants.
  assert.equal(v2.environmentTexels.length, (2 * 8 * 4 + 4) * 4);
  assert.equal(v2.environmentTexels[5 * 4], 16.0, 'HDRI pixel clamped at 16.0');
  const cdfStart = 8 * 4;
  let marginalProbSum = 0;
  for (let y = 0; y < 4; y++) {
    marginalProbSum += v2.environmentTexels[(cdfStart + y) * 4 + 1];
    let condProbSum = 0;
    for (let x = 0; x < 8; x++) {
      condProbSum += v2.environmentTexels[(cdfStart + 4 + y * 8 + x) * 4 + 1];
    }
    assert.ok(Math.abs(condProbSum - 1.0) < 1e-5, `row ${y} conditional probabilities sum to 1`);
    assert.equal(v2.environmentTexels[(cdfStart + 4 + y * 8 + 7) * 4], 1.0, `row ${y} conditional CDF ends at 1.0`);
  }
  assert.ok(Math.abs(marginalProbSum - 1.0) < 1e-5, 'marginal probabilities sum to 1');
  assert.equal(v2.environmentTexels[(cdfStart + 3) * 4], 1.0, 'marginal CDF ends at 1.0');
});

test('upgradeNativeInputV1ToV2 preserves textures, lights, subsurface, volume, and camera from legacy v1 input', () => {
  const texImage = makeCheckerRgba8(4, 4, true);
  const envMap = createEnvironmentMap({ width: 4, height: 2, data: new Float32Array(4 * 2 * 3).fill(0.4), intensity: 1.0 });
  const parts = [
    {
      name: 'wax',
      geometry: quadGeometry(0),
      material: {
        color: [0.8, 0.5, 0.4],
        roughness: 0.4,
        subsurface: { weight: 0.8, radius: [1, 0.3, 0.1], scale: 0.05 },
      },
    },
    {
      name: 'cutout-card',
      geometry: quadGeometry(1),
      material: {
        color: [1, 1, 1],
        alphaMode: 'mask',
        alphaCutoff: 0.5,
        map: { image: texImage, colorSpace: 'srgb' },
      },
    },
    {
      name: 'lamp',
      geometry: quadGeometry(2),
      material: { color: [1, 0.8, 0.5], emission: 4 },
    },
  ];
  const scene = buildTraceScene(parts, {
    map: envMap,
    keyColor: [3, 3, 3],
    lightDirection: [0, 1, 1],
    spotLights: [{ position: [0, 3, 2], direction: [0, -1, -0.5], angle: 0.6, penumbra: 0.25, color: [1, 1, 1], intensity: 12, radius: 0.05 }],
    volumeFog: { minimum: [-5, -5, -5], maximum: [5, 5, 5], density: 0.1, anisotropy: 0.3 },
  });
  const camera = createCamera({ eye: [0, 1, 6], target: [0, 0, 0], fov: 50 }, 24, 16);
  const v1 = buildNativeInput(scene, camera, { width: 24, height: 16, samples: 4, bounces: 5, seed: 7 }, pack);
  const upgraded = upgradeNativeInputV1ToV2(v1, { width: 24, height: 16, samples: 4 });

  assert.equal(upgraded.schemaVersion, 2);
  assert.equal(upgraded.instanceCount, 3);
  assert.equal(upgraded.triangleCount, 6);
  assert.equal(upgraded.materialCount, 3);
  assert.equal(upgraded.emissiveTriangleCount, 2);
  assert.equal(upgraded.lightCount, 2); // sun + spot
  assert.equal(upgraded.textureCount, 1);

  const kp = viewRecord(upgraded.kernelParams, STRUCT_STRIDES_V2.kernelParams);
  assert.equal(kp.u32[8] & (2 | 4), 2 | 4, 'HAS_VOLUME | HAS_SUBSURFACE set in kernel_flags');
  assert.equal(kp.f32[10], 0, 'unclamped direct by default');
  assert.equal(kp.f32[11], 0, 'unclamped indirect by default');

  const spot = viewRecord(upgraded.lights, STRUCT_STRIDES_V2.light, 1);
  assert.ok(Math.abs(spot.f32[21] - 0.25) < 1e-5, 'spot_blend recovered cleanly from v1 blend');
});

test('Cycles v2 host executes multi-BLAS/TLAS ray queries, cutout alpha masking, v1 auto-upgrade, and probeCyclesLobe on GPU', { skip: !findNativeAddon() }, () => {
  const cutoutImage = makeCheckerRgba8(4, 4, true, true); // left half alpha=0, right half opaque neutral white
  const sharedQuad = quadGeometry(0);
  const camera = createCamera({ eye: [0, 0, 2.4], target: [0, 0, 0], fov: 50 }, 16, 16);

  // Instance 0: cutout quad at z = 0 (left half transparent x < 0, right half opaque green x > 0).
  // Instance 1: mirrored solid red backdrop quad at z = -1 covering full view (shares same geometry!).
  const v2Input = buildNativeInputV2(
    {
      materials: [
        { color: [0.1, 0.9, 0.2], alphaMode: 'mask', alphaCutoff: 0.5, map: { image: cutoutImage, colorSpace: 'srgb' } },
        { color: [0.9, 0.1, 0.1], roughness: 0.8 },
      ],
      instances: [
        { geometry: sharedQuad, matrix: [2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], materialIndex: 0 },
        { geometry: sharedQuad, matrix: [-4, 0, 0, 0, 0, 4, 0, 0, 0, 0, 1, 0, 0, 0, -1, 1], materialOverride: 1 },
      ],
      lights: {
        points: [{ position: [0, 0, 3], color: [1, 1, 1], intensity: 2, radius: 0.1 }],
      },
    },
    camera,
    { width: 16, height: 16, samples: 4 },
  );

  assert.throws(
    () => traceNative(v2Input, { width: 16, height: 16, samples: 1, kernel: 'legacy' }),
    /Cannot pass a FORMAT-v2 scene input to kernel "legacy"/,
  );

  const result = traceNative(v2Input, {
    width: 16,
    height: 16,
    samples: 4,
    samplesPerDispatch: 2,
    kernel: 'cycles',
    bootstrapKernel: true,
  });

  assert.equal(result.rgba.length, 16 * 16 * 4);
  assert.equal(result.albedo.length, 16 * 16 * 3);
  assert.equal(result.normal.length, 16 * 16 * 3);
  assert.equal(result.depth.length, 16 * 16);
  assert.equal(result.variance.length, 16 * 16);
  assert.equal(result.averageSamples, 4);
  assert.equal(result.features, 'EXPERIMENTAL_RAY_QUERY');
  assert.ok(result.rgba.every(Number.isFinite));

  // Left pixel (x=3, y=8) sees through the alpha=0 cutout to the backdrop at z=-1 (red albedo, depth ~ 3.4).
  // Right pixel (x=12, y=8) hits the opaque half of the foreground card at z=0 (green albedo, depth ~ 2.4).
  const leftPixel = 8 * 16 + 3;
  const rightPixel = 8 * 16 + 12;
  assert.ok(result.albedo[leftPixel * 3] > 0.8 && result.albedo[leftPixel * 3 + 1] < 0.2, 'cutout hole hits red backdrop');
  assert.ok(result.albedo[rightPixel * 3 + 1] > 0.8 && result.albedo[rightPixel * 3] < 0.2, 'opaque texel hits green foreground');
  assert.ok(result.depth[leftPixel] > result.depth[rightPixel] + 0.8, 'backdrop depth exceeds foreground depth');
  // Both mirrored backdrop and foreground face +Z toward camera!
  assert.ok(result.normal[leftPixel * 3 + 2] > 0.99, 'mirrored backdrop outward normal is +Z');
  assert.ok(result.normal[rightPixel * 3 + 2] > 0.99, 'foreground outward normal is +Z');

  // Verify v1 input auto-upgrades when kernel: 'cycles' is selected.
  const v1Scene = buildTraceScene([{ name: 'quad', geometry: sharedQuad, material: { color: [0.3, 0.6, 0.9] } }], {});
  const v1Input = buildNativeInput(v1Scene, camera, { width: 8, height: 8, samples: 2, bounces: 2, seed: 1 }, pack);
  const autoUpgradedResult = traceNative(v1Input, {
    width: 8,
    height: 8,
    samples: 2,
    kernel: 'cycles',
    bootstrapKernel: true,
  });
  assert.equal(autoUpgradedResult.rgba.length, 8 * 8 * 4);
  assert.ok(autoUpgradedResult.rgba.every(Number.isFinite));

  // Verify probeCyclesLobe dispatches "test_lobe_samples" and returns all 4 raw planes un-divided.
  const probePlanes = probeCyclesLobe({
    width: 16,
    height: 8,
    mode: 1,
    seed: 42,
    wo: [0, 0.6, 0.8],
    frontFace: false,
    material: {
      color: [0.8, 0.4, 0.2],
      roughness: 0.35,
      metallic: 1.0,
      ior: 1.45,
      f82Tint: [0.95, 0.85, 0.75],
    },
    bootstrapKernel: true,
  });
  const count = 16 * 8;
  assert.equal(probePlanes.length, 4 * count * 4);
  assert.ok(probePlanes.every(Number.isFinite));

  const customMaterialBytes = packMaterialRecordV2({ color: [0.25, 0.5, 0.75], roughness: 0.2 }).bytes;
  const rawBytesProbe = probeCyclesLobe({
    width: 8,
    height: 4,
    materialBytes: customMaterialBytes,
    bootstrapKernel: true,
  });
  assert.equal(rawBytesProbe.length, 4 * 8 * 4 * 4);
  assert.ok(rawBytesProbe.every(Number.isFinite));

  assert.throws(() => probeCyclesLobe({ width: 8, height: 8, wo: [0, 0, 0], bootstrapKernel: true }), /non-zero finite 3D vector/);
});

// ---------------------------------------------------------------------------
// Boundary validation: shared filterGlossy offset constant
// ---------------------------------------------------------------------------

test('KERNEL_PARAMS_V2_FILTER_GLOSSY_BYTE_OFFSET equals 300 (f32[75] * 4)', () => {
  assert.equal(KERNEL_PARAMS_V2_FILTER_GLOSSY_BYTE_OFFSET, 300);
  // Verify pack-input-v2 writes filterGlossy at that offset.
  const parts = [{ name: 'q', geometry: quadGeometry(0), material: { color: [0.5, 0.5, 0.5] } }];
  const scene = buildTraceScene(parts, {});
  const camera = createCamera({ eye: [0, 0, 3], target: [0, 0, 0], fov: 50 }, 8, 8);
  const v2 = buildNativeInputV2(scene, camera, { width: 8, height: 8, samples: 1, filterGlossy: 2.5 });
  const kp = new DataView(v2.kernelParams.buffer, v2.kernelParams.byteOffset, v2.kernelParams.byteLength);
  assert.ok(Math.abs(kp.getFloat32(KERNEL_PARAMS_V2_FILTER_GLOSSY_BYTE_OFFSET, true) - 2.5) < 1e-6, 'filterGlossy at byte 300');
});

// ---------------------------------------------------------------------------
// Boundary validation: width and height
// ---------------------------------------------------------------------------

test('buildNativeInputV2 rejects non-finite, non-integer, out-of-range width and height', () => {
  const minimalScene = buildTraceScene([{ name: 'q', geometry: quadGeometry(0), material: { color: [0.5, 0.5, 0.5] } }], {});
  const camera = createCamera({ eye: [0, 0, 3], target: [0, 0, 0], fov: 50 }, 8, 8);
  const ok = { width: 8, height: 8, samples: 1 };
  const build = (opts) => buildNativeInputV2(minimalScene, camera, { ...ok, ...opts });

  // NaN
  assert.throws(() => build({ width: NaN }), /width/, 'width NaN');
  assert.throws(() => build({ height: NaN }), /height/, 'height NaN');
  // Infinity
  assert.throws(() => build({ width: Infinity }), /width/, 'width Infinity');
  assert.throws(() => build({ height: -Infinity }), /height/, 'height -Infinity');
  // Float
  assert.throws(() => build({ width: 1.5 }), /width/, 'width float');
  assert.throws(() => build({ height: 8.3 }), /height/, 'height float');
  // Zero
  assert.throws(() => build({ width: 0 }), /width/, 'width 0');
  assert.throws(() => build({ height: 0 }), /height/, 'height 0');
  // Negative
  assert.throws(() => build({ width: -1 }), /width/, 'width -1');
  assert.throws(() => build({ height: -100 }), /height/, 'height -100');
  // Over bound
  assert.throws(() => build({ width: 16385 }), /width/, 'width 16385');
  assert.throws(() => build({ height: 99999 }), /height/, 'height 99999');
  // Exact bounds pass
  assert.doesNotThrow(() => build({ width: 1, height: 1 }), 'min bounds');
  assert.doesNotThrow(() => build({ width: 4096, height: 4096 }), 'max pixel count');
  assert.doesNotThrow(() => build({ width: 16384, height: 1 }), 'max width');
  assert.throws(() => build({ width: 16384, height: 16384 }), /pixels/, 'over the pixel limit');
});

// ---------------------------------------------------------------------------
// Boundary validation: samples
// ---------------------------------------------------------------------------

test('buildNativeInputV2 rejects non-finite, non-integer, out-of-range samples', () => {
  const minimalScene = buildTraceScene([{ name: 'q', geometry: quadGeometry(0), material: { color: [0.5, 0.5, 0.5] } }], {});
  const camera = createCamera({ eye: [0, 0, 3], target: [0, 0, 0], fov: 50 }, 8, 8);
  const ok = { width: 8, height: 8, samples: 1 };
  const build = (opts) => buildNativeInputV2(minimalScene, camera, { ...ok, ...opts });

  assert.throws(() => build({ samples: NaN }), /samples/, 'samples NaN');
  assert.throws(() => build({ samples: Infinity }), /samples/, 'samples Infinity');
  assert.throws(() => build({ samples: -Infinity }), /samples/, 'samples -Infinity');
  assert.throws(() => build({ samples: 1.5 }), /samples/, 'samples float');
  assert.throws(() => build({ samples: 0 }), /samples/, 'samples 0');
  assert.throws(() => build({ samples: -1 }), /samples/, 'samples -1');
  assert.throws(() => build({ samples: 1048577 }), /samples/, 'samples 1048577');
  // Exact bounds pass
  assert.doesNotThrow(() => build({ samples: 1 }), 'samples 1');
  assert.doesNotThrow(() => build({ samples: 1048576 }), 'samples 1048576');
});

// ---------------------------------------------------------------------------
// Boundary validation: samplesPerDispatch (optional)
// ---------------------------------------------------------------------------

test('buildNativeInputV2 accepts undefined samplesPerDispatch but rejects invalid values', () => {
  const minimalScene = buildTraceScene([{ name: 'q', geometry: quadGeometry(0), material: { color: [0.5, 0.5, 0.5] } }], {});
  const camera = createCamera({ eye: [0, 0, 3], target: [0, 0, 0], fov: 50 }, 8, 8);
  const ok = { width: 8, height: 8, samples: 1 };
  const build = (opts) => buildNativeInputV2(minimalScene, camera, { ...ok, ...opts });

  // undefined: must be accepted (addon chooses default)
  assert.doesNotThrow(() => build({ samplesPerDispatch: undefined }), 'undefined');
  // Invalid values
  assert.throws(() => build({ samplesPerDispatch: NaN }), /samplesPerDispatch/, 'NaN');
  assert.throws(() => build({ samplesPerDispatch: Infinity }), /samplesPerDispatch/, 'Infinity');
  assert.throws(() => build({ samplesPerDispatch: 1.5 }), /samplesPerDispatch/, 'float');
  assert.throws(() => build({ samplesPerDispatch: 0 }), /samplesPerDispatch/, 'zero');
  assert.throws(() => build({ samplesPerDispatch: -1 }), /samplesPerDispatch/, 'negative');
  assert.throws(() => build({ samplesPerDispatch: 65537 }), /samplesPerDispatch/, '65537');
  // Exact bounds pass
  assert.doesNotThrow(() => build({ samplesPerDispatch: 1 }), 'min 1');
  assert.doesNotThrow(() => build({ samplesPerDispatch: 65536 }), 'max 65536');
});

// ---------------------------------------------------------------------------
// Boundary validation: bounce limits (non-finite / negative / float / over-bound rejection)
// ---------------------------------------------------------------------------

test('buildNativeInputV2 rejects non-finite and out-of-range bounce limit values', () => {
  const minimalScene = buildTraceScene([{ name: 'q', geometry: quadGeometry(0), material: { color: [0.5, 0.5, 0.5] } }], {});
  const camera = createCamera({ eye: [0, 0, 3], target: [0, 0, 0], fov: 50 }, 8, 8);
  const ok = { width: 8, height: 8, samples: 1 };
  const build = (opts) => buildNativeInputV2(minimalScene, camera, { ...ok, ...opts });

  const bounceFields = [
    'bounces', 'maxBounces',
    'diffuseBounces', 'maxDiffuseBounces',
    'glossyBounces', 'maxGlossyBounces',
    'transmissionBounces', 'maxTransmissionBounces',
    'volumeBounces', 'maxVolumeBounces',
    'transparentBounces', 'maxTransparentBounces',
    'minBounceRr',
  ];

  for (const field of bounceFields) {
    // Infinity previously packed to 0 (now rejected)
    assert.throws(() => build({ [field]: Infinity }), new RegExp(field), `${field}: Infinity`);
    assert.throws(() => build({ [field]: -Infinity }), new RegExp(field), `${field}: -Infinity`);
    assert.throws(() => build({ [field]: NaN }), new RegExp(field), `${field}: NaN`);
    assert.throws(() => build({ [field]: -1 }), new RegExp(field), `${field}: -1`);
    assert.throws(() => build({ [field]: 1.5 }), new RegExp(field), `${field}: 1.5`);
    assert.throws(() => build({ [field]: 1025 }), new RegExp(field), `${field}: 1025`);
    // Valid bounds pass
    assert.doesNotThrow(() => build({ [field]: 0 }), `${field}: 0`);
    assert.doesNotThrow(() => build({ [field]: 1024 }), `${field}: 1024`);
  }
});

// ---------------------------------------------------------------------------
// Boundary validation: upgradeNativeInputV1ToV2 validates options too
// ---------------------------------------------------------------------------

test('upgradeNativeInputV1ToV2 validates width, height, samples, samplesPerDispatch, and bounce fields', () => {
  // Minimal valid v1 input (parameters = 256-byte Uint8Array with triangleCount = 0 triangle data).
  const parameters = new Uint8Array(256);
  const v1Input = { parameters, triangleCount: 0, triangles: new Float32Array(0), materials: new Float32Array(0) };

  assert.throws(() => upgradeNativeInputV1ToV2(v1Input, { width: NaN }), /width/, 'width NaN');
  assert.throws(() => upgradeNativeInputV1ToV2(v1Input, { height: Infinity }), /height/, 'height Inf');
  assert.throws(() => upgradeNativeInputV1ToV2(v1Input, { samples: 0 }), /samples/, 'samples 0');
  assert.throws(() => upgradeNativeInputV1ToV2(v1Input, { samplesPerDispatch: -1 }), /samplesPerDispatch/, 'spd -1');
  assert.throws(() => upgradeNativeInputV1ToV2(v1Input, { bounces: Infinity }), /bounces/, 'bounces Inf');
  assert.throws(() => upgradeNativeInputV1ToV2(v1Input, { maxGlossyBounces: 1.5 }), /maxGlossyBounces/, 'float');
  // Valid options pass
  assert.doesNotThrow(
    () => upgradeNativeInputV1ToV2(v1Input, { width: 32, height: 32, samples: 4, bounces: 8 }),
    'valid options'
  );
});

test('traceNative and probeCyclesLobe validate options at the public boundary even on pre-built v2 inputs', () => {
  const minimalScene = buildTraceScene([{ name: 'q', geometry: quadGeometry(0), material: { color: [0.5, 0.5, 0.5] } }], {});
  const camera = createCamera({ eye: [0, 0, 3], target: [0, 0, 0], fov: 50 }, 8, 8);
  const v2Input = buildNativeInputV2(minimalScene, camera, { width: 8, height: 8, samples: 1 });

  assert.throws(() => traceNative(v2Input, { width: Infinity, height: 8, samples: 1, kernel: 'cycles' }), /width/);
  assert.throws(() => traceNative(v2Input, { width: 8, height: 8, samples: NaN, kernel: 'cycles' }), /samples/);
  assert.throws(() => traceNative(v2Input, { width: 8, height: 8, samples: 1, samplesPerDispatch: Infinity, kernel: 'cycles' }), /samplesPerDispatch/);
  assert.throws(() => traceNative(v2Input, { width: 8, height: 8, samples: 1, bounces: Infinity, kernel: 'cycles' }), /bounces/);
  assert.throws(() => traceNative(v2Input, { height: 8, samples: 1, kernel: 'cycles' }), /width/);
  assert.throws(() => probeCyclesLobe({ width: 16385, height: 8 }), /16384/);
});

// ---------------------------------------------------------------------------
// Boundary validation: pixel count, dispatch size, maxSeconds and number types
// ---------------------------------------------------------------------------

test('traceNative bounds the pixel count by the accumulation buffer and states the largest size', () => {
  const minimalScene = buildTraceScene([{ name: 'q', geometry: quadGeometry(0), material: { color: [0.5, 0.5, 0.5] } }], {});
  const camera = createCamera({ eye: [0, 0, 3], target: [0, 0, 0], fov: 50 }, 8, 8);
  const v2Input = buildNativeInputV2(minimalScene, camera, { width: 8, height: 8, samples: 1 });
  const trace = (width, height) => traceNative(v2Input, { width, height, samples: 1, kernel: 'cycles' });

  assert.throws(() => trace(16384, 16384), (error) => error instanceof RangeError && /16777216 pixels \(4096 x 4096\)/.test(error.message));
  assert.throws(() => trace(4097, 4096), RangeError);
  assert.throws(() => probeCyclesLobe({ width: 16384, height: 16384 }), /16777216 pixels/);
  // The exact limits pass validation.
  assert.doesNotThrow(() => validatePackOptions({ width: 4096, height: 4096, samples: 1 }, 'traceNative', true));
  assert.doesNotThrow(() => validatePackOptions({ width: 16384, height: 1, samples: 1 }, 'traceNative', true));
});

test('traceNative bounds samplesPerDispatch times pixel count and says what to pass', () => {
  const options = { width: 4096, height: 4096, samples: 64 };
  assert.doesNotThrow(() => validatePackOptions({ ...options, samplesPerDispatch: 16 }, 'traceNative', true));
  assert.throws(
    () => validatePackOptions({ ...options, samplesPerDispatch: 17 }, 'traceNative', true),
    (error) => error instanceof RangeError && /268435456 path samples per dispatch/.test(error.message) && /16 or less/.test(error.message),
  );
  assert.doesNotThrow(() => validatePackOptions({ width: 8, height: 8, samples: 1, samplesPerDispatch: 65536 }, 'traceNative', true));
});

test('traceNative validates maxSeconds when given', () => {
  const base = { width: 8, height: 8, samples: 1 };
  assert.doesNotThrow(() => validatePackOptions({ ...base, maxSeconds: undefined }, 'traceNative', true));
  assert.doesNotThrow(() => validatePackOptions({ ...base, maxSeconds: 0.5 }, 'traceNative', true));
  for (const invalid of [0, -1, NaN, Infinity, -Infinity]) {
    assert.throws(() => validatePackOptions({ ...base, maxSeconds: invalid }, 'traceNative', true), /maxSeconds/, `maxSeconds ${invalid}`);
  }
  for (const invalid of ['5', true, [5], null, {}]) {
    assert.throws(() => validatePackOptions({ ...base, maxSeconds: invalid }, 'traceNative', true), TypeError, `maxSeconds ${JSON.stringify(invalid)}`);
  }
  assert.throws(() => probeCyclesLobe({ width: 8, height: 8, maxSeconds: 0 }), /maxSeconds/);
});

test('pack options reject strings, booleans, arrays and null instead of coercing them', () => {
  const base = { width: 8, height: 8, samples: 1 };
  for (const field of ['width', 'height', 'samples', 'samplesPerDispatch', 'bounces', 'minBounceRr']) {
    for (const invalid of ['8', true, [8], null]) {
      assert.throws(
        () => validatePackOptions({ ...base, [field]: invalid }, 'traceNative', true),
        (error) => error instanceof TypeError && error.message.includes(field) && /must be a number/.test(error.message),
        `${field} ${JSON.stringify(invalid)}`,
      );
    }
  }
});

function packSunnyEnvironment(options) {
  const width = 16;
  const height = 8;
  const pixels = new Float32Array(width * height * 3).fill(0.2);
  const sunTexelIndex = 2 * width + 5;
  pixels[sunTexelIndex * 3] = 12;
  pixels[sunTexelIndex * 3 + 1] = 12;
  pixels[sunTexelIndex * 3 + 2] = 12;
  const environment = createEnvironmentMap({ width, height, data: pixels, intensity: 1 });
  const parts = [{ name: 'floor', geometry: quadGeometry(-2), material: { color: [0.5, 0.5, 0.5] } }];
  const scene = buildTraceScene(parts, { map: environment });
  const camera = createCamera({ eye: [0, 0, 5], target: [0, 0, 0], fov: 50 }, 16, 16);
  return buildNativeInputV2(scene, camera, { width: 16, height: 16, samples: 1, ...options });
}

function readEnvironmentConditionalProbabilities(packedInput, width, height) {
  const cdfStart = width * height;
  const probabilities = [];
  for (let pixelIndex = 0; pixelIndex < width * height; pixelIndex++) {
    probabilities.push(packedInput.environmentTexels[(cdfStart + height + pixelIndex) * 4 + 1]);
  }
  return probabilities;
}

test('envCompensation is off by default and leaves the environment table unchanged', () => {
  const withoutOption = packSunnyEnvironment({});
  const withFalse = packSunnyEnvironment({ envCompensation: false });
  const withZero = packSunnyEnvironment({ envCompensation: 0 });
  assert.deepEqual(withFalse.environmentTexels, withoutOption.environmentTexels);
  assert.deepEqual(withZero.environmentTexels, withoutOption.environmentTexels);
});

test('envCompensation removes the dim texels from the sampling table and keeps the CDFs valid', () => {
  const plain = packSunnyEnvironment({});
  const compensated = packSunnyEnvironment({ envCompensation: true });
  const width = 16;
  const height = 8;
  const plainProbabilities = readEnvironmentConditionalProbabilities(plain, width, height);
  const compensatedProbabilities = readEnvironmentConditionalProbabilities(compensated, width, height);

  const sunRow = 2;
  const sunColumn = 5;
  assert.ok(plainProbabilities[sunRow * width + 0] > 0, 'dim texels are sampled without compensation');
  assert.equal(compensatedProbabilities[sunRow * width + 0], 0, 'dim texels get zero probability');
  assert.equal(compensatedProbabilities[sunRow * width + sunColumn], 1, 'the sun is the only texel left in its row');

  const cdfStart = width * height;
  let marginalProbabilitySum = 0;
  for (let row = 0; row < height; row++) {
    marginalProbabilitySum += compensated.environmentTexels[(cdfStart + row) * 4 + 1];
  }
  assert.ok(Math.abs(marginalProbabilitySum - 1) < 1e-5, 'marginal probabilities sum to 1');
  assert.equal(compensated.environmentTexels[(cdfStart + height - 1) * 4], 1, 'marginal CDF ends at 1');
  assert.ok(compensated.environmentTexels[0] === plain.environmentTexels[0], 'radiance texels are untouched');
});

test('envCompensation keeps the original table for a uniform map and rejects bad values', () => {
  const width = 8;
  const height = 4;
  const uniformMap = createEnvironmentMap({ width, height, data: new Float32Array(width * height * 3).fill(0.5), intensity: 1 });
  const parts = [{ name: 'floor', geometry: quadGeometry(-2), material: { color: [0.5, 0.5, 0.5] } }];
  const scene = buildTraceScene(parts, { map: uniformMap });
  const camera = createCamera({ eye: [0, 0, 5], target: [0, 0, 0], fov: 50 }, 16, 16);
  const base = { width: 16, height: 16, samples: 1 };
  const plain = buildNativeInputV2(scene, camera, base);
  const compensated = buildNativeInputV2(scene, camera, { ...base, envCompensation: true });
  assert.deepEqual(compensated.environmentTexels, plain.environmentTexels, 'an all-zero table falls back to the plain table');
  for (const [sweepWidth, sweepHeight] of [[16, 8], [32, 16], [64, 32]]) {
    for (const radiance of [0.123, 0.2, 0.5, 1, 3.7]) {
      for (const intensity of [1, 2.5]) {
        const constantMap = createEnvironmentMap({ width: sweepWidth, height: sweepHeight, data: new Float32Array(sweepWidth * sweepHeight * 3).fill(radiance), intensity });
        const constantScene = buildTraceScene(parts, { map: constantMap });
        const plainInput = buildNativeInputV2(constantScene, camera, base);
        const compensatedInput = buildNativeInputV2(constantScene, camera, { ...base, envCompensation: true });
        assert.deepEqual(compensatedInput.environmentTexels, plainInput.environmentTexels, `constant map ${sweepWidth}x${sweepHeight}, radiance ${radiance}, intensity ${intensity}`);
      }
    }
  }
  for (const invalid of [-0.1, 1.5, NaN, '1', null]) {
    assert.throws(() => validatePackOptions({ ...base, envCompensation: invalid }, 'traceNative', true), /envCompensation/, `envCompensation ${JSON.stringify(invalid)}`);
  }
  assert.doesNotThrow(() => validatePackOptions({ ...base, envCompensation: 0.5 }, 'traceNative', true));
});
