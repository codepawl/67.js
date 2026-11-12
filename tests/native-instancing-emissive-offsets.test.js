import assert from 'node:assert/strict';
import test from 'node:test';
import { buildNativeInputV2, STRUCT_STRIDES_V2 } from '../packages/render-native/index.mjs';
import { createCamera } from '../src/path-tracer.js';

const NO_INDEX = 0xffffffff;
const camera = createCamera({ eye: [0, 0, 6], target: [0, 0, 0], fov: 50 }, 16, 16);

// Four triangles over a strip; the second one has no area, so an emissive pass skips it.
const stripWithDegenerateTriangle = {
  positions: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0, 2, 0, 0, 2, 1, 0, 3, 0, 0, 3, 1, 0, 1, 1, 0]),
  normals: Float32Array.from([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
  indices: Uint32Array.from([0, 1, 2, 1, 3, 8, 1, 4, 3, 4, 5, 3, 3, 8, 8]),
};

const MATTE = { color: [0.7, 0.7, 0.7], roughness: 0.6 };
const WARM_LIGHT = { color: [1, 0.8, 0.6], emission: 4 };
const COOL_LIGHT = { color: [0.6, 0.8, 1], emission: 2 };

function pack(materials, instances) {
  return buildNativeInputV2({ materials, instances, lights: {} }, camera, { width: 16, height: 16, samples: 1 });
}

function words(bytes, stride, index) {
  return new Uint32Array(bytes.buffer, bytes.byteOffset + index * stride, stride / 4);
}

// Every emissive hit reads emissive_triangles[instance.emissive_base_offset + triangle.local_emissive_offset]; that entry must be the
// same instance and the same triangle as the hit.
function assertEmissiveLookups(input) {
  for (let instanceIndex = 0; instanceIndex < input.instanceCount; instanceIndex++) {
    const instance = words(input.instances, STRUCT_STRIDES_V2.instance, instanceIndex);
    const base = instance[32];
    if (base === NO_INDEX) continue;
    const triangleOffset = instance[25];
    let looked = 0;
    for (let local = 0; local < instance[27]; local++) {
      const localOffset = words(input.triangles, STRUCT_STRIDES_V2.triangle, triangleOffset + local)[7];
      if (localOffset === NO_INDEX) continue;
      const emitted = words(input.emissiveTriangles, STRUCT_STRIDES_V2.emissiveTriangle, base + localOffset);
      assert.equal(emitted[7], instanceIndex, `instance ${instanceIndex} triangle ${local} reads another instance's emissive entry`);
      assert.equal(emitted[11], triangleOffset + local, `instance ${instanceIndex} triangle ${local} reads another triangle's emissive entry`);
      looked++;
    }
    assert.ok(looked > 0, `instance ${instanceIndex} has an emissive base and no triangle that reaches it`);
  }
}

test('an emissive default material indexes its emissive entries past a degenerate triangle', () => {
  const input = pack([WARM_LIGHT], [
    { geometry: stripWithDegenerateTriangle, materialIndex: 0 },
    { geometry: stripWithDegenerateTriangle, materialIndex: 0, matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, -2, 0, 1] },
  ]);
  assert.equal(input.emissiveTriangleCount, 6);
  assertEmissiveLookups(input);
});

test('an instance whose override makes the shared mesh emissive gets lookups that match its own entries', () => {
  const input = pack([MATTE, WARM_LIGHT], [
    { geometry: stripWithDegenerateTriangle, materialIndex: 0 },
    { geometry: stripWithDegenerateTriangle, materialIndex: 1, matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, -2, 0, 1] },
    { geometry: stripWithDegenerateTriangle, materialIndex: 1, matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, -4, 0, 1] },
  ]);
  assert.equal(input.emissiveTriangleCount, 6);
  assertEmissiveLookups(input);
});

test('an override that switches emission off and another that switches it back on keep the lookups valid', () => {
  const input = pack([WARM_LIGHT, MATTE, COOL_LIGHT], [
    { geometry: stripWithDegenerateTriangle, materialIndex: 0 },
    { geometry: stripWithDegenerateTriangle, materialIndex: 1, matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, -2, 0, 1] },
    { geometry: stripWithDegenerateTriangle, materialIndex: 2, matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, -4, 0, 1] },
  ]);
  assert.equal(input.emissiveTriangleCount, 6);
  const middle = words(input.instances, STRUCT_STRIDES_V2.instance, 1);
  assert.equal(middle[32], NO_INDEX, 'the matte override has no emissive entries');
  assertEmissiveLookups(input);
});

test('a copy scaled so small that it drops an emissive triangle the others keep is refused with the instance named', () => {
  const bigAndSmall = {
    positions: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0, 2, 0, 0, 2.05, 0, 0, 2, 0.04, 0]),
    normals: Float32Array.from([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: Uint32Array.from([0, 1, 2, 3, 4, 5]),
  };
  const shrunk = [1e-5, 0, 0, 0, 0, 1e-5, 0, 0, 0, 0, 1e-5, 0, 0, 0, 0, 1];
  assert.throws(
    () => pack([WARM_LIGHT], [
      { geometry: bigAndSmall, materialIndex: 0 },
      { geometry: bigAndSmall, materialIndex: 0, matrix: shrunk },
    ]),
    /Instance\[1\] scales some emissive triangles/,
  );
});
