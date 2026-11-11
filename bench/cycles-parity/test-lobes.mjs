// Runs Cycles lobe white-furnace and PDF grid probes plus end-to-end uniform-sky sphere furnace renders.
//   node bench/cycles-parity/test-lobes.mjs <outputDirectory> [--samples-width 512] [--samples-height 512] [--grid-width 1024] [--grid-height 512]
import { mkdir, writeFile } from 'node:fs/promises';
import { constants, setPriority } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sphere } from '../../src/geometry.js';
import { createEnvironmentMap } from '../../src/hdri.js';
import { createCamera } from '../../src/path-tracer.js';
import * as packModule from '../../src/path-tracer-gpu-pack.js';
import { buildTraceScene } from '../../src/path-tracer-scene.js';
import * as renderNative from '../../packages/render-native/index.mjs';
import { writeFloat32Npy } from './npy.mjs';

const MATERIAL_RECORD_BYTE_LENGTH = 256;
const MATERIAL_FLAG_MULTISCATTER_GGX = 1;
const MATERIAL_FLAG_F82_METALLIC = 32;
const INVALID_SVM_OFFSET = 0xFFFFFFFF;
const IDENTITY_MATRIX = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

export const LOBE_PROBE_CASES = [
  {
    id: 'diffuse-lambert-normal',
    family: 'diffuse',
    wo: [0.0, 0.0, 1.0],
    frontFace: true,
    expectWhiteFurnace: true,
    expectChiSquare: true,
    material: {
      baseColor: [1.0, 1.0, 1.0],
      specularIorLevel: 0.0,
      diffuseRoughness: 0.0,
      flags: MATERIAL_FLAG_MULTISCATTER_GGX,
    },
  },
  {
    id: 'diffuse-principled-oblique',
    family: 'diffuse',
    wo: [0.6, 0.0, 0.8],
    frontFace: true,
    expectWhiteFurnace: true,
    expectChiSquare: true,
    material: {
      baseColor: [1.0, 1.0, 1.0],
      specularIorLevel: 0.0,
      diffuseRoughness: 0.6,
      flags: MATERIAL_FLAG_MULTISCATTER_GGX,
    },
  },
  {
    id: 'dielectric-glossy-sharp-oblique',
    family: 'glossy_ggx',
    wo: [0.6, 0.0, 0.8],
    frontFace: true,
    expectWhiteFurnace: true,
    expectChiSquare: false,
    material: {
      baseColor: [1.0, 1.0, 1.0],
      metallic: 0.0,
      roughness: 0.05,
      ior: 1.5,
      specularIorLevel: 0.5,
      flags: MATERIAL_FLAG_MULTISCATTER_GGX,
    },
  },
  {
    id: 'dielectric-glossy-rough-oblique',
    family: 'glossy_ggx',
    wo: [0.6, 0.0, 0.8],
    frontFace: true,
    expectWhiteFurnace: true,
    expectChiSquare: true,
    material: {
      baseColor: [1.0, 1.0, 1.0],
      metallic: 0.0,
      roughness: 0.35,
      ior: 1.5,
      specularIorLevel: 0.5,
      flags: MATERIAL_FLAG_MULTISCATTER_GGX,
    },
  },
  {
    id: 'dielectric-glossy-grazing',
    family: 'glossy_ggx',
    wo: [0.88, 0.0, 0.47497],
    frontFace: true,
    expectWhiteFurnace: true,
    expectChiSquare: true,
    material: {
      baseColor: [1.0, 1.0, 1.0],
      metallic: 0.0,
      roughness: 0.6,
      ior: 1.5,
      specularIorLevel: 0.5,
      flags: MATERIAL_FLAG_MULTISCATTER_GGX,
    },
  },
  {
    id: 'conductor-ggx-sharp',
    family: 'glossy_ggx',
    wo: [0.5, 0.0, 0.86603],
    frontFace: true,
    expectWhiteFurnace: true,
    expectChiSquare: false,
    material: {
      baseColor: [1.0, 1.0, 1.0],
      f82Tint: [1.0, 1.0, 1.0],
      metallic: 1.0,
      roughness: 0.05,
      flags: MATERIAL_FLAG_MULTISCATTER_GGX | MATERIAL_FLAG_F82_METALLIC,
    },
  },
  {
    id: 'conductor-ggx-medium',
    family: 'glossy_ggx',
    wo: [0.6, 0.0, 0.8],
    frontFace: true,
    expectWhiteFurnace: true,
    expectChiSquare: true,
    material: {
      baseColor: [1.0, 1.0, 1.0],
      f82Tint: [1.0, 1.0, 1.0],
      metallic: 1.0,
      roughness: 0.35,
      flags: MATERIAL_FLAG_MULTISCATTER_GGX | MATERIAL_FLAG_F82_METALLIC,
    },
  },
  {
    id: 'conductor-ggx-rough-grazing',
    family: 'glossy_ggx',
    wo: [0.9, 0.0, 0.43589],
    frontFace: true,
    expectWhiteFurnace: true,
    expectChiSquare: true,
    material: {
      baseColor: [1.0, 1.0, 1.0],
      f82Tint: [1.0, 1.0, 1.0],
      metallic: 1.0,
      roughness: 0.75,
      flags: MATERIAL_FLAG_MULTISCATTER_GGX | MATERIAL_FLAG_F82_METALLIC,
    },
  },
  {
    id: 'conductor-f82-gold-oblique',
    family: 'glossy_ggx',
    wo: [0.75, 0.0, 0.66144],
    frontFace: true,
    expectWhiteFurnace: false,
    expectColorOrder: [0, 1, 2],
    expectChiSquare: true,
    material: {
      baseColor: [1.0, 0.78, 0.34],
      f82Tint: [0.92, 0.86, 0.65],
      metallic: 1.0,
      roughness: 0.35,
      flags: MATERIAL_FLAG_MULTISCATTER_GGX | MATERIAL_FLAG_F82_METALLIC,
    },
  },
  {
    id: 'anisotropic-ggx-unrotated',
    family: 'anisotropic_ggx',
    wo: [0.5, 0.3, 0.8124],
    frontFace: true,
    expectWhiteFurnace: true,
    expectChiSquare: true,
    material: {
      baseColor: [1.0, 1.0, 1.0],
      f82Tint: [1.0, 1.0, 1.0],
      metallic: 1.0,
      roughness: 0.35,
      anisotropy: 0.7,
      anisotropyRotation: 0.0,
      flags: MATERIAL_FLAG_MULTISCATTER_GGX | MATERIAL_FLAG_F82_METALLIC,
    },
  },
  {
    id: 'anisotropic-ggx-rotated',
    family: 'anisotropic_ggx',
    wo: [0.5, 0.3, 0.8124],
    frontFace: true,
    expectWhiteFurnace: true,
    expectChiSquare: true,
    material: {
      baseColor: [1.0, 1.0, 1.0],
      f82Tint: [1.0, 1.0, 1.0],
      metallic: 1.0,
      roughness: 0.35,
      anisotropy: 0.7,
      anisotropyRotation: 0.2,
      flags: MATERIAL_FLAG_MULTISCATTER_GGX | MATERIAL_FLAG_F82_METALLIC,
    },
  },
  {
    id: 'glass-ggx-frontface-sharp',
    family: 'glass_ggx',
    wo: [0.5, 0.0, 0.86603],
    frontFace: true,
    expectWhiteFurnace: true,
    expectChiSquare: false,
    material: {
      baseColor: [1.0, 1.0, 1.0],
      metallic: 0.0,
      roughness: 0.05,
      ior: 1.5,
      transmissionWeight: 1.0,
      flags: MATERIAL_FLAG_MULTISCATTER_GGX,
    },
  },
  {
    id: 'glass-ggx-frontface-rough',
    family: 'glass_ggx',
    wo: [0.6, 0.0, 0.8],
    frontFace: true,
    expectWhiteFurnace: true,
    expectChiSquare: true,
    material: {
      baseColor: [1.0, 1.0, 1.0],
      metallic: 0.0,
      roughness: 0.35,
      ior: 1.5,
      transmissionWeight: 1.0,
      flags: MATERIAL_FLAG_MULTISCATTER_GGX,
    },
  },
  {
    id: 'glass-ggx-backface-subcritical',
    family: 'glass_ggx',
    wo: [0.3, 0.0, 0.95394],
    frontFace: false,
    expectWhiteFurnace: true,
    expectChiSquare: true,
    material: {
      baseColor: [1.0, 1.0, 1.0],
      metallic: 0.0,
      roughness: 0.35,
      ior: 1.5,
      transmissionWeight: 1.0,
      flags: MATERIAL_FLAG_MULTISCATTER_GGX,
    },
  },
  {
    id: 'glass-ggx-backface-tir',
    family: 'glass_ggx',
    wo: [0.85, 0.0, 0.52678],
    frontFace: false,
    expectWhiteFurnace: true,
    expectChiSquare: true,
    material: {
      baseColor: [1.0, 1.0, 1.0],
      metallic: 0.0,
      roughness: 0.35,
      ior: 1.5,
      transmissionWeight: 1.0,
      flags: MATERIAL_FLAG_MULTISCATTER_GGX,
    },
  },
  {
    id: 'coat-ggx-over-diffuse-sharp',
    family: 'coat_ggx',
    wo: [0.6, 0.0, 0.8],
    frontFace: true,
    expectWhiteFurnace: true,
    expectChiSquare: false,
    material: {
      baseColor: [1.0, 1.0, 1.0],
      metallic: 0.0,
      roughness: 0.5,
      ior: 1.5,
      specularIorLevel: 0.5,
      coatWeight: 1.0,
      coatRoughness: 0.05,
      coatIor: 1.5,
      coatTint: [1.0, 1.0, 1.0],
      flags: MATERIAL_FLAG_MULTISCATTER_GGX,
    },
  },
  {
    id: 'coat-ggx-over-diffuse-rough',
    family: 'coat_ggx',
    wo: [0.6, 0.0, 0.8],
    frontFace: true,
    expectWhiteFurnace: true,
    expectChiSquare: true,
    material: {
      baseColor: [1.0, 1.0, 1.0],
      metallic: 0.0,
      roughness: 0.5,
      ior: 1.5,
      specularIorLevel: 0.5,
      coatWeight: 1.0,
      coatRoughness: 0.35,
      coatIor: 1.5,
      coatTint: [1.0, 1.0, 1.0],
      flags: MATERIAL_FLAG_MULTISCATTER_GGX,
    },
  },
  {
    id: 'coat-ggx-over-metal-rough',
    family: 'coat_ggx',
    wo: [0.6, 0.0, 0.8],
    frontFace: true,
    expectWhiteFurnace: true,
    expectChiSquare: true,
    material: {
      baseColor: [1.0, 1.0, 1.0],
      f82Tint: [1.0, 1.0, 1.0],
      metallic: 1.0,
      roughness: 0.4,
      coatWeight: 1.0,
      coatRoughness: 0.3,
      coatIor: 1.5,
      coatTint: [1.0, 1.0, 1.0],
      flags: MATERIAL_FLAG_MULTISCATTER_GGX | MATERIAL_FLAG_F82_METALLIC,
    },
  },
  {
    id: 'sheen-over-diffuse-rough',
    family: 'sheen',
    wo: [0.6, 0.0, 0.8],
    frontFace: true,
    expectWhiteFurnace: true,
    expectChiSquare: true,
    material: {
      baseColor: [1.0, 1.0, 1.0],
      metallic: 0.0,
      roughness: 0.5,
      ior: 1.0,
      specularIorLevel: 0.0,
      sheenWeight: 1.0,
      sheenRoughness: 0.5,
      sheenTint: [1.0, 1.0, 1.0],
      flags: MATERIAL_FLAG_MULTISCATTER_GGX,
    },
  },
  {
    id: 'sheen-over-diffuse-grazing',
    family: 'sheen',
    wo: [0.95, 0.0, 0.31225],
    frontFace: true,
    expectWhiteFurnace: true,
    expectChiSquare: true,
    material: {
      baseColor: [1.0, 1.0, 1.0],
      metallic: 0.0,
      roughness: 0.5,
      ior: 1.0,
      specularIorLevel: 0.0,
      sheenWeight: 1.0,
      sheenRoughness: 0.3,
      sheenTint: [1.0, 1.0, 1.0],
      flags: MATERIAL_FLAG_MULTISCATTER_GGX,
    },
  },
];

export const FURNACE_SCENE_CASES = [
  {
    id: 'furnace-scene-diffuse',
    material: { color: [1.0, 1.0, 1.0], metallic: 0.0, roughness: 0.5, specular: 0.0 },
  },
  {
    id: 'furnace-scene-dielectric-glossy',
    material: { color: [1.0, 1.0, 1.0], metallic: 0.0, roughness: 0.35, specular: 1.0, ior: 1.5 },
  },
  {
    id: 'furnace-scene-metal',
    material: { color: [1.0, 1.0, 1.0], metallic: 1.0, roughness: 0.35 },
  },
  {
    id: 'furnace-scene-glass',
    material: { color: [1.0, 1.0, 1.0], metallic: 0.0, roughness: 0.15, transmission: 1.0, ior: 1.5 },
  },
  {
    id: 'furnace-scene-coat',
    material: { color: [1.0, 1.0, 1.0], metallic: 0.0, roughness: 0.5, clearcoat: 1.0, clearcoatRoughness: 0.2 },
  },
  {
    id: 'furnace-scene-sheen',
    material: { color: [1.0, 1.0, 1.0], metallic: 0.0, roughness: 0.5, sheenColor: [1.0, 1.0, 1.0], sheenRoughness: 0.4 },
  },
];

function writeVec3(view, byteOffset, rgb) {
  view.setFloat32(byteOffset, rgb[0], true);
  view.setFloat32(byteOffset + 4, rgb[1], true);
  view.setFloat32(byteOffset + 8, rgb[2], true);
}

export function packMaterialRecord(spec) {
  const bytes = new Uint8Array(MATERIAL_RECORD_BYTE_LENGTH);
  const view = new DataView(bytes.buffer);
  writeVec3(view, 0, spec.baseColor ?? [1.0, 1.0, 1.0]);
  view.setFloat32(12, spec.metallic ?? 0.0, true);
  view.setFloat32(16, spec.roughness ?? 0.5, true);
  view.setFloat32(20, spec.ior ?? 1.5, true);
  view.setFloat32(24, spec.specularIorLevel ?? 0.5, true);
  view.setFloat32(28, spec.diffuseRoughness ?? 0.0, true);
  writeVec3(view, 32, spec.f82Tint ?? [1.0, 1.0, 1.0]);
  view.setFloat32(44, spec.anisotropy ?? 0.0, true);
  view.setFloat32(48, spec.anisotropyRotation ?? 0.0, true);
  view.setFloat32(52, spec.transmissionWeight ?? 0.0, true);
  view.setFloat32(56, spec.alpha ?? 1.0, true);
  view.setFloat32(60, spec.alphaCutoff ?? 0.0, true);
  writeVec3(view, 64, spec.coatTint ?? [1.0, 1.0, 1.0]);
  view.setFloat32(76, spec.coatWeight ?? 0.0, true);
  view.setFloat32(80, spec.coatRoughness ?? 0.0, true);
  view.setFloat32(84, spec.coatIor ?? 1.5, true);
  view.setFloat32(88, spec.thinFilmThickness ?? 0.0, true);
  view.setFloat32(92, spec.thinFilmIor ?? 1.33, true);
  writeVec3(view, 96, spec.sheenTint ?? [1.0, 1.0, 1.0]);
  view.setFloat32(108, spec.sheenWeight ?? 0.0, true);
  writeVec3(view, 112, spec.absorptionColor ?? [1.0, 1.0, 1.0]);
  view.setFloat32(124, spec.absorptionDistance ?? 0.0, true);
  writeVec3(view, 128, spec.emissionColor ?? [0.0, 0.0, 0.0]);
  view.setFloat32(140, spec.emissionStrength ?? 0.0, true);
  writeVec3(view, 144, spec.subsurfaceRadius ?? [1.0, 0.2, 0.1]);
  view.setFloat32(156, spec.subsurfaceWeight ?? 0.0, true);
  writeVec3(view, 160, spec.subsurfaceColor ?? [1.0, 1.0, 1.0]);
  view.setFloat32(172, spec.subsurfaceAnisotropy ?? 0.0, true);
  view.setFloat32(176, spec.sheenRoughness ?? 0.5, true);
  view.setFloat32(180, spec.subsurfaceIor ?? 1.4, true);
  view.setFloat32(184, spec.normalScale ?? 1.0, true);
  view.setFloat32(188, spec.coatNormalScale ?? 1.0, true);
  view.setUint32(192, spec.flags ?? MATERIAL_FLAG_MULTISCATTER_GGX, true);
  view.setUint32(196, spec.alphaMode ?? 0, true);
  view.setFloat32(200, spec.bumpDistance ?? 0.0, true);
  view.setUint32(204, INVALID_SVM_OFFSET, true);
  for (let byteOffset = 208; byteOffset < 256; byteOffset += 4) {
    view.setInt32(byteOffset, -1, true);
  }
  return bytes;
}

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

function parseIntegerOption(argumentList, flagName, fallbackValue, minimumValue) {
  const parsed = Number(readFlagValue(argumentList, flagName, fallbackValue));
  if (!Number.isInteger(parsed) || parsed < minimumValue) {
    throw new RangeError(`Option ${flagName} must be an integer >= ${minimumValue}, got ${parsed}.`);
  }
  return parsed;
}

function parseCliArguments(argumentList) {
  if (argumentList.length < 1 || argumentList[0].startsWith('--')) {
    throw new RangeError('Usage: node bench/cycles-parity/test-lobes.mjs <outputDirectory> [--samples-width 512] [--samples-height 512] [--grid-width 1024] [--grid-height 512] [--scene-samples 512] [--seed 1] [--filter <substring>] [--skip-scenes] [--skip-probes]');
  }
  return {
    outputDirectory: resolve(argumentList[0]),
    samplesWidth: parseIntegerOption(argumentList, '--samples-width', 512, 16),
    samplesHeight: parseIntegerOption(argumentList, '--samples-height', 512, 16),
    gridWidth: parseIntegerOption(argumentList, '--grid-width', 1024, 32),
    gridHeight: parseIntegerOption(argumentList, '--grid-height', 512, 32),
    sceneWidth: parseIntegerOption(argumentList, '--scene-width', 128, 32),
    sceneHeight: parseIntegerOption(argumentList, '--scene-height', 128, 32),
    sceneSamples: parseIntegerOption(argumentList, '--scene-samples', 512, 16),
    seed: parseIntegerOption(argumentList, '--seed', 1, 0),
    filter: readFlagValue(argumentList, '--filter', ''),
    skipScenes: argumentList.includes('--skip-scenes'),
    skipProbes: argumentList.includes('--skip-probes'),
  };
}

function unpackModeZeroRows(rawPlanes, sampleCount) {
  const packedRows = new Float32Array(sampleCount * 12);
  const plane1Base = sampleCount * 4;
  const plane2Base = sampleCount * 8;
  for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex++) {
    const planeOffset = sampleIndex * 4;
    const rowOffset = sampleIndex * 12;
    packedRows[rowOffset] = rawPlanes[planeOffset];
    packedRows[rowOffset + 1] = rawPlanes[planeOffset + 1];
    packedRows[rowOffset + 2] = rawPlanes[planeOffset + 2];
    packedRows[rowOffset + 3] = rawPlanes[planeOffset + 3];
    packedRows[rowOffset + 4] = rawPlanes[plane1Base + planeOffset];
    packedRows[rowOffset + 5] = rawPlanes[plane1Base + planeOffset + 1];
    packedRows[rowOffset + 6] = rawPlanes[plane1Base + planeOffset + 2];
    packedRows[rowOffset + 7] = rawPlanes[plane1Base + planeOffset + 3];
    packedRows[rowOffset + 8] = rawPlanes[plane2Base + planeOffset];
    packedRows[rowOffset + 9] = rawPlanes[plane2Base + planeOffset + 1];
    packedRows[rowOffset + 10] = rawPlanes[plane2Base + planeOffset + 2];
    packedRows[rowOffset + 11] = rawPlanes[plane2Base + planeOffset + 3];
  }
  return packedRows;
}

function unpackModeOnePdfGrid(rawPlanes, gridCount) {
  const pdfGrid = new Float32Array(gridCount);
  for (let cellIndex = 0; cellIndex < gridCount; cellIndex++) {
    pdfGrid[cellIndex] = rawPlanes[cellIndex * 4 + 3];
  }
  return pdfGrid;
}

function extractLinearRgb(rgbaPixels, pixelCount) {
  const linearRgb = new Float32Array(pixelCount * 3);
  for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex++) {
    const sourceOffset = pixelIndex * 4;
    const targetOffset = pixelIndex * 3;
    linearRgb[targetOffset] = rgbaPixels[sourceOffset];
    linearRgb[targetOffset + 1] = rgbaPixels[sourceOffset + 1];
    linearRgb[targetOffset + 2] = rgbaPixels[sourceOffset + 2];
  }
  return linearRgb;
}

async function runLobeProbeCase(probeCase, options) {
  const materialBytes = packMaterialRecord(probeCase.material);
  const sampleCount = options.samplesWidth * options.samplesHeight;
  const rawModeZero = renderNative.probeCyclesLobe({
    width: options.samplesWidth,
    height: options.samplesHeight,
    wo: probeCase.wo,
    frontFace: probeCase.frontFace,
    mode: 0,
    seed: options.seed,
    materialBytes,
  });
  const modeZeroFloats = rawModeZero instanceof Float32Array ? rawModeZero : rawModeZero.data;
  if (!(modeZeroFloats instanceof Float32Array) || modeZeroFloats.length < sampleCount * 12) {
    throw new Error(`probeCyclesLobe Mode 0 returned unexpected buffer length for "${probeCase.id}".`);
  }
  const modeZeroPath = join(options.outputDirectory, `${probeCase.id}-mode0.npy`);
  const modeZeroRows = unpackModeZeroRows(modeZeroFloats, sampleCount);
  await writeFloat32Npy(modeZeroPath, modeZeroRows, [sampleCount, 12]);

  let modeOnePath = null;
  if (probeCase.expectChiSquare) {
    const gridCount = options.gridWidth * options.gridHeight;
    const rawModeOne = renderNative.probeCyclesLobe({
      width: options.gridWidth,
      height: options.gridHeight,
      wo: probeCase.wo,
      frontFace: probeCase.frontFace,
      mode: 1,
      seed: options.seed,
      materialBytes,
    });
    const modeOneFloats = rawModeOne instanceof Float32Array ? rawModeOne : rawModeOne.data;
    if (!(modeOneFloats instanceof Float32Array) || modeOneFloats.length < gridCount * 4) {
      throw new Error(`probeCyclesLobe Mode 1 returned unexpected buffer length for "${probeCase.id}".`);
    }
    modeOnePath = join(options.outputDirectory, `${probeCase.id}-mode1-pdf.npy`);
    const pdfGrid = unpackModeOnePdfGrid(modeOneFloats, gridCount);
    await writeFloat32Npy(modeOnePath, pdfGrid, [options.gridHeight, options.gridWidth]);
  }
  return {
    id: probeCase.id,
    family: probeCase.family,
    wo: probeCase.wo,
    frontFace: probeCase.frontFace,
    expectWhiteFurnace: probeCase.expectWhiteFurnace,
    expectColorOrder: probeCase.expectColorOrder ?? null,
    expectChiSquare: probeCase.expectChiSquare,
    sampleCount,
    gridShape: probeCase.expectChiSquare ? [options.gridHeight, options.gridWidth] : null,
    modeZeroPath,
    modeOnePath,
  };
}

async function runFurnaceSceneCase(sceneCase, sphereGeometry, whiteEnvironment, cameraDescriptor, options) {
  const parts = [{
    name: 'furnace-sphere',
    geometry: sphereGeometry,
    matrix: IDENTITY_MATRIX,
    material: sceneCase.material,
  }];
  const traceScene = buildTraceScene(parts, whiteEnvironment);
  const camera = createCamera(cameraDescriptor, options.sceneWidth, options.sceneHeight);
  const furnaceBounces = 64;
  const traceOptions = {
    width: options.sceneWidth,
    height: options.sceneHeight,
    samples: options.sceneSamples,
    samplesPerDispatch: Math.min(options.sceneSamples, 16),
    bounces: furnaceBounces,
    seed: options.seed,
    kernel: 'cycles',
    filterType: 'box',
    filterWidth: 1.0,
    clampDirect: 0.0,
    clampIndirect: 0.0,
    filterGlossy: 0.0,
    fireflyClamp: 1e9,
    noiseThreshold: 0.0,
    maxSeconds: 300,
  };
  const nativeInput = typeof renderNative.buildNativeInputV2 === 'function'
    ? renderNative.buildNativeInputV2(traceScene, camera, { ...traceOptions, parts }, packModule)
    : renderNative.buildNativeInput(traceScene, camera, traceOptions, packModule);
  const traced = renderNative.traceNative(nativeInput, traceOptions);
  const pixelCount = options.sceneWidth * options.sceneHeight;
  const linearRgb = extractLinearRgb(traced.rgba, pixelCount);
  const imagePath = join(options.outputDirectory, `${sceneCase.id}.npy`);
  await writeFloat32Npy(imagePath, linearRgb, [options.sceneHeight, options.sceneWidth, 3]);
  return {
    id: sceneCase.id,
    width: options.sceneWidth,
    height: options.sceneHeight,
    samples: options.sceneSamples,
    bounces: furnaceBounces,
    cameraEyeZ: 3.2,
    cameraFovDegrees: 40,
    sphereRadius: 1.0,
    imagePath,
  };
}

async function runCli() {
  setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL);
  const options = parseCliArguments(process.argv.slice(2));
  if (!renderNative.findNativeAddon()) {
    throw new Error('The render-native addon is missing. Build packages/render-native before running test-lobes.mjs.');
  }
  await mkdir(options.outputDirectory, { recursive: true });
  const probeManifestEntries = [];
  if (!options.skipProbes) {
    if (typeof renderNative.probeCyclesLobe !== 'function') {
      throw new Error('packages/render-native/index.mjs does not export probeCyclesLobe yet. Merge the host and closures lanes before running lobe probes.');
    }
    const selectedProbes = LOBE_PROBE_CASES.filter((item) => !options.filter || item.id.includes(options.filter));
    for (const probeCase of selectedProbes) {
      const result = await runLobeProbeCase(probeCase, options);
      probeManifestEntries.push(result);
    }
  }
  const sceneManifestEntries = [];
  if (!options.skipScenes) {
    const selectedScenes = FURNACE_SCENE_CASES.filter((item) => !options.filter || item.id.includes(options.filter));
    if (selectedScenes.length > 0) {
      const sphereGeometry = sphere(128, 96);
      const constantWhite = new Float32Array(8 * 4 * 3).fill(1.0);
      const environmentMap = createEnvironmentMap({ width: 8, height: 4, data: constantWhite, showBackground: true });
      const whiteEnvironment = {
        map: environmentMap,
        keyColor: [0, 0, 0],
        lightDirection: [0, 1, 0],
        pointLights: [],
        spotLights: [],
        areaLights: [],
      };
      const cameraDescriptor = {
        eye: [0, 0, 3.2],
        target: [0, 0, 0],
        up: [0, 1, 0],
        fov: 40,
        near: 0.1,
        far: 20,
      };
      for (const sceneCase of selectedScenes) {
        const result = await runFurnaceSceneCase(sceneCase, sphereGeometry, whiteEnvironment, cameraDescriptor, options);
        sceneManifestEntries.push(result);
      }
    }
  }
  const manifest = {
    seed: options.seed,
    samplesWidth: options.samplesWidth,
    samplesHeight: options.samplesHeight,
    gridWidth: options.gridWidth,
    gridHeight: options.gridHeight,
    probes: probeManifestEntries,
    furnaceScenes: sceneManifestEntries,
  };
  const manifestPath = join(options.outputDirectory, 'lobes-manifest.json');
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`LOBE_PROBES_WRITTEN ${JSON.stringify({ manifestPath, probeCount: probeManifestEntries.length, furnaceSceneCount: sceneManifestEntries.length })}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await runCli();
}
