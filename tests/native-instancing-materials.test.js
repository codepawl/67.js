import assert from 'node:assert/strict';
import { cookModule, cookTest } from './support/cook.js';
import { createCamera } from '../src/path-tracer.js';
import * as pack from '../src/path-tracer-gpu-pack.js';
import { buildTraceScene, resolveTexture } from '../src/path-tracer-scene.js';

const cook = await cookModule();
const jobInput = await cookModule('job-input');
const { STRUCT_STRIDES_V2 } = cook ?? {};
const { buildFlattenedJobNativeInput, buildJobNativeInput } = jobInput ?? {};

const camera = createCamera({ eye: [0, 0, 8], target: [0, 0, 0], fov: 50 }, 16, 16);
const options = { width: 16, height: 16, samples: 1, bounces: 4, seed: 1, fireflyClamp: 20, noiseThreshold: 0 };
const environment = { keyColor: [3, 3, 3], lightDirection: [0.4, 0.8, 0.5] };

function quad(scale) {
  return {
    positions: Float32Array.from([-scale, -scale, 0, scale, -scale, 0, scale, scale, 0, -scale, scale, 0]),
    normals: Float32Array.from([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
    uvs: Float32Array.from([0, 0, 1, 0, 1, 1, 0, 1]),
    indices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
  };
}

const sharedQuad = quad(1);
const translate = x => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, 0, 1];

// Two copies of one mesh, then parts that each have a geometry of their own and use a material field the v1 job tables drop.
function partsWithSharedMesh() {
  return [
    { name: 'copy-a', geometry: sharedQuad, matrix: translate(-2), material: { color: [0.8, 0.2, 0.2], roughness: 0.5 } },
    { name: 'copy-b', geometry: sharedQuad, matrix: translate(2), material: { color: [0.2, 0.2, 0.8], roughness: 0.5 } },
    { name: 'pane', geometry: quad(0.9), matrix: translate(0), material: { color: [0.6, 0.8, 1], opacity: 0.3, alphaMode: 'blend', roughness: 0.1 } },
    { name: 'velvet', geometry: quad(0.8), matrix: translate(0.1), material: { color: [0.4, 0.1, 0.5], sheenColor: [1, 1, 1], sheenRoughness: 0.4, roughness: 0.8 } },
    { name: 'glass', geometry: quad(0.7), matrix: translate(0.2), material: { color: [1, 1, 1], transmission: 0.9, ior: 1.45, roughness: 0.05, attenuationDistance: 2, attenuationColor: [0.5, 0.8, 0.6] } },
    { name: 'foil', geometry: quad(0.6), matrix: translate(0.3), material: { color: [0.9, 0.8, 0.5], metallic: 1, anisotropy: 0.6, iridescence: 0.5, specular: 0.8, roughness: 0.3 } },
  ];
}

function materialRecords(input) {
  const records = [];
  for (let index = 0; index < input.materialCount; index++) {
    records.push(Buffer.from(input.materials.buffer, input.materials.byteOffset + index * STRUCT_STRIDES_V2.material, STRUCT_STRIDES_V2.material).toString('hex'));
  }
  return records;
}

// What a native job without shared geometry sends.
function flattenedJobInput(parts) {
  return buildFlattenedJobNativeInput(buildTraceScene(parts, environment), camera, options, pack, resolveTexture);
}

cookTest('a part keeps the same material record whether or not other geometry in the job is shared', () => {
  const parts = partsWithSharedMesh();
  const flattened = materialRecords(flattenedJobInput(parts));
  const instancedScene = buildTraceScene(parts, environment, { instancing: true });
  assert.ok(instancedScene.instances, 'the two copies of one mesh make the job instanced');
  const instanced = materialRecords(buildJobNativeInput(instancedScene, camera, options, pack, resolveTexture));
  assert.equal(instanced.length, parts.length);
  parts.forEach((part, index) => assert.equal(instanced[index], flattened[index], `material record of ${part.name}`));
});
