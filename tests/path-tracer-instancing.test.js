import assert from 'node:assert/strict';
import test from 'node:test';
import { buildNativeInput, buildNativeInputV2, STRUCT_STRIDES_V2 } from '../packages/render-native/index.mjs';
import { createCamera } from '../src/path-tracer.js';
import * as pack from '../src/path-tracer-gpu-pack.js';
import { MAX_TRACE_INSTANCES, MAX_TRACE_PARTS, MAX_TRACE_TRIANGLES, buildTraceScene } from '../src/path-tracer-scene.js';

function quadGeometry(z = 0) {
  return {
    positions: new Float32Array([-1, -1, z, 1, -1, z, 1, 1, z, -1, 1, z]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
    uvs: new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  };
}

// A strip of `triangleCount` triangles on a few vertices: enough to hit a triangle cap without a large allocation.
function heavyGeometry(triangleCount) {
  const indices = new Uint32Array(triangleCount * 3);
  for (let slot = 0; slot < indices.length; slot++) indices[slot] = slot % 3;
  return {
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices,
  };
}

function translation(x, y = 0, z = 0) {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
}

function copiesOf(geometry, count, material = { color: [0.5, 0.5, 0.5] }) {
  return Array.from({ length: count }, (_, index) => ({ name: `copy-${index}`, geometry, matrix: translation(index * 3), material }));
}

const FLATTENED_FIELDS = ['positions', 'normals', 'uvs', 'colors', 'indices', 'triangleMaterial'];

test('without the instancing option every scene is flattened, and a scene with no shared geometry is unchanged by the option', () => {
  const parts = [
    { name: 'a', geometry: quadGeometry(0), matrix: translation(0), material: { color: [1, 0, 0] } },
    { name: 'b', geometry: quadGeometry(1), matrix: translation(4), material: { color: [0, 1, 0] }, shadowOnly: true },
  ];
  const plain = buildTraceScene(parts, {});
  const optedIn = buildTraceScene(parts, {}, { instancing: true });
  assert.equal(plain.instances, undefined);
  assert.equal(optedIn.instances, undefined);
  for (const field of FLATTENED_FIELDS) assert.deepEqual(optedIn[field], plain[field], field);
  assert.deepEqual(optedIn.materials, plain.materials);
  assert.deepEqual(optedIn.shadowOnlyParts, plain.shadowOnlyParts);
  assert.equal(optedIn.surfaceOffset, plain.surfaceOffset);
  assert.equal(optedIn.farDistance, plain.farDistance);

  const shared = copiesOf(quadGeometry(), 3);
  assert.equal(buildTraceScene(shared, {}).instances, undefined);
  assert.equal(buildTraceScene(shared, {}, { instancing: false }).instances, undefined);
});

test('parts that share one geometry become instances of it, in part order', () => {
  const geometry = quadGeometry();
  const parts = copiesOf(geometry, 5);
  const scene = buildTraceScene(parts, {}, { instancing: true });
  assert.equal(scene.positions, undefined);
  assert.equal(scene.bvh, undefined);
  assert.equal(scene.instances.length, 5);
  scene.instances.forEach((instance, index) => {
    assert.equal(instance.geometry, geometry);
    assert.deepEqual(instance.matrix, parts[index].matrix);
    assert.equal(instance.materialIndex, index);
    assert.equal(instance.objectId, index);
    assert.equal(instance.visibilityFlags, undefined);
  });
  assert.equal(scene.materials.length, 5);
  assert.deepEqual(scene.materials[0].color, [0.5, 0.5, 0.5]);
});

test('a part whose geometry is rebuilt for the trace stays flattened into world space beside the shared ones', () => {
  const geometry = quadGeometry();
  const boxMapped = { name: 'boxed', geometry, matrix: translation(10), material: { color: [1, 1, 1], boxMapScale: 1 } };
  const parts = [...copiesOf(geometry, 2), boxMapped];
  const scene = buildTraceScene(parts, {}, { instancing: true });
  const [first, second, baked] = scene.instances;
  assert.equal(first.geometry, geometry);
  assert.equal(second.geometry, geometry);
  assert.notEqual(baked.geometry, geometry);
  assert.deepEqual(baked.matrix, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  assert.equal(baked.geometry.triangleMaterial, undefined);
  assert.equal(baked.geometry.positions[0], 9);
});

test('a shadow-only part is an instance the camera does not see', () => {
  const parts = copiesOf(quadGeometry(), 2);
  parts[1].shadowOnly = true;
  const scene = buildTraceScene(parts, {}, { instancing: true });
  assert.equal(scene.instances[0].visibilityFlags, undefined);
  assert.equal(scene.instances[1].visibilityFlags, 2 | 4 | 8 | 16 | 32);
});

test('the extent that scales the ray offsets covers every instance', () => {
  const parts = copiesOf(quadGeometry(), 3);
  const flattened = buildTraceScene(parts, {});
  const instanced = buildTraceScene(parts, {}, { instancing: true });
  assert.equal(instanced.surfaceOffset, flattened.surfaceOffset);
  assert.equal(instanced.farDistance, flattened.farDistance);
});

test('the triangle cap counts unique triangles, so shared copies pass where the flattened scene fails', () => {
  const geometry = heavyGeometry(500);
  const parts = copiesOf(geometry, 1000);
  assert.throws(() => buildTraceScene(parts, {}), /triangles in total/);
  assert.equal(buildTraceScene(parts, {}, { instancing: true }).instances.length, 1000);
});

test('the part cap bounds distinct geometries for an instanced scene, and copies have their own cap', () => {
  const shared = quadGeometry();
  const pastPartCap = copiesOf(shared, MAX_TRACE_PARTS + 76);
  assert.throws(() => buildTraceScene(pastPartCap, {}), /1 to 1024 parts/);
  assert.equal(buildTraceScene(pastPartCap, {}, { instancing: true }).instances.length, MAX_TRACE_PARTS + 76);

  const manyGeometries = [...copiesOf(shared, 2), ...Array.from({ length: MAX_TRACE_PARTS }, () => ({ geometry: quadGeometry(), matrix: translation(0), material: { color: [1, 1, 1] } }))];
  assert.throws(() => buildTraceScene(manyGeometries, {}, { instancing: true }), /at most 1024 distinct geometries, got 1025.*Share one geometry object/);

  const tooManyCopies = copiesOf(shared, MAX_TRACE_INSTANCES + 1);
  assert.throws(() => buildTraceScene(tooManyCopies, {}, { instancing: true }), /at most 65536 instances, got 65537.*fewer parts/);
});

test('unique triangles past the cap are refused with what to change', () => {
  const half = MAX_TRACE_TRIANGLES / 2 + 1;
  const parts = [...copiesOf(heavyGeometry(half), 2), ...copiesOf(heavyGeometry(half), 2)];
  assert.throws(() => buildTraceScene(parts, {}, { instancing: true }), /at most 400000 unique triangles.*got 400002.*Share geometry/);
});

test('an invalid matrix or geometry in an instanced scene is named by its part', () => {
  const parts = copiesOf(quadGeometry(), 2);
  parts[1].matrix = translation(Number.NaN);
  assert.throws(() => buildTraceScene(parts, {}, { instancing: true }), /Part copy-1 matrix must be finite/);
  const brokenGeometry = quadGeometry();
  brokenGeometry.indices = new Uint32Array([0, 1, 9]);
  assert.throws(() => buildTraceScene(copiesOf(brokenGeometry, 2), {}, { instancing: true }), /index past its last vertex/);
});

test('N copies of one mesh pack as one geometry record set and N instance records', () => {
  const camera = createCamera({ eye: [0, 0, 40], target: [0, 0, 0], fov: 45 }, 16, 16);
  const copyCount = 200;
  const parts = copiesOf(quadGeometry(), copyCount);
  const instanced = buildNativeInputV2(buildTraceScene(parts, {}, { instancing: true }), camera, { width: 16, height: 16, samples: 1 });
  const flattened = buildNativeInputV2(buildTraceScene(parts, {}), camera, { width: 16, height: 16, samples: 1 });
  assert.equal(instanced.instanceCount, copyCount);
  assert.equal(instanced.triangleCount, 2);
  assert.equal(instanced.triangles.byteLength, 2 * STRUCT_STRIDES_V2.triangle);
  assert.equal(instanced.instances.byteLength, copyCount * STRUCT_STRIDES_V2.instance);
  assert.equal(flattened.instanceCount, copyCount);
  assert.equal(flattened.triangleCount, copyCount * 2);
  assert.ok(instanced.triangles.byteLength < flattened.triangles.byteLength);
});

test('the legacy v1 packer refuses an instanced scene and says what to use instead', () => {
  const camera = createCamera({ eye: [0, 0, 40], target: [0, 0, 0], fov: 45 }, 16, 16);
  const scene = buildTraceScene(copiesOf(quadGeometry(), 3), {}, { instancing: true });
  assert.throws(() => buildNativeInput(scene, camera, { width: 16, height: 16, samples: 1, bounces: 2, seed: 1 }, pack), /cannot read instances.*buildNativeInputV2.*"cycles"/);
});
