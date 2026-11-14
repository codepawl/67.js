import assert from 'node:assert/strict';
import test from 'node:test';
import { NATIVE_JOB_MAXIMUM_PARTS } from '../scripts/native-bake-page.js';
import {
  buildTraceScene, MAX_NATIVE_TRACE_INSTANCES, MAX_NATIVE_TRACE_PARTS, MAX_NATIVE_TRACE_TRIANGLES, MAX_TRACE_PARTS,
} from '../src/path-tracer-scene.js';

const MATERIAL = { color: [0.8, 0.8, 0.8] };

// A strip of `triangleCount` triangles over one row of vertices; every index is in range.
function stripGeometry(triangleCount, offset = 0) {
  const vertexCount = triangleCount + 2;
  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  for (let vertex = 0; vertex < vertexCount; vertex++) {
    positions[vertex * 3] = vertex * 0.01 + offset;
    positions[vertex * 3 + 1] = vertex % 2 === 0 ? 0 : 0.01;
    normals[vertex * 3 + 2] = 1;
  }
  const indices = new Uint32Array(triangleCount * 3);
  for (let triangle = 0; triangle < triangleCount; triangle++) {
    indices.set([triangle, triangle + 1, triangle + 2], triangle * 3);
  }
  return { positions, normals, indices };
}

function stripParts(partCount, trianglesPerPart) {
  return Array.from({ length: partCount }, (_, index) => ({ name: `strip${index}`, geometry: stripGeometry(trianglesPerPart, index), material: MATERIAL }));
}

test('the CPU and WebGL bound is still 1,024 parts with its old message', () => {
  assert.equal(MAX_TRACE_PARTS, 1024);
  assert.throws(() => buildTraceScene(stripParts(MAX_TRACE_PARTS + 1, 1)), { name: 'RangeError', message: 'A path trace takes 1 to 1024 parts.' });
});

test('the native option takes more than 1,024 parts in a flattened scene', () => {
  assert.equal(NATIVE_JOB_MAXIMUM_PARTS, MAX_NATIVE_TRACE_PARTS);
  const scene = buildTraceScene(stripParts(MAX_TRACE_PARTS + 200, 2), {}, { maximumParts: MAX_NATIVE_TRACE_PARTS });
  assert.equal(scene.materials.length, MAX_TRACE_PARTS + 200);
});

test('a native flattened scene past maximumParts names the limit and what to do', () => {
  assert.throws(() => buildTraceScene(stripParts(5, 1), {}, { maximumParts: 4 }),
    { name: 'RangeError', message: /native path trace takes 1 to 4 parts, got 5\. Merge small meshes/ });
});

test('a two million triangle instanced scene of 2,000 distinct meshes passes the native bounds', () => {
  const distinct = stripParts(2000, 1000);
  const parts = [...distinct, { ...distinct[0], name: 'copy' }];
  const scene = buildTraceScene(parts, {}, {
    instancing: true,
    maximumTriangles: MAX_NATIVE_TRACE_TRIANGLES,
    maximumInstances: MAX_NATIVE_TRACE_INSTANCES,
    maximumParts: MAX_NATIVE_TRACE_PARTS,
  });
  assert.ok(scene.instances, 'the scene stays instanced');
  assert.equal(scene.instances.length, 2001);
});

test('without maximumParts an instanced scene keeps 1,024 distinct geometries', () => {
  const distinct = stripParts(MAX_TRACE_PARTS + 1, 1);
  const parts = [...distinct, { ...distinct[0], name: 'copy' }];
  assert.throws(() => buildTraceScene(parts, {}, { instancing: true, maximumTriangles: MAX_NATIVE_TRACE_TRIANGLES }),
    { name: 'RangeError', message: /instanced native path trace takes at most 1024 distinct geometries, got 1025|instanced path trace takes at most 1024 distinct geometries, got 1025/ });
  assert.throws(() => buildTraceScene(parts, {}, { instancing: true, maximumTriangles: MAX_NATIVE_TRACE_TRIANGLES, maximumParts: 1024 }),
    { name: 'RangeError', message: /instanced native path trace takes at most 1024 distinct geometries, got 1025.*merge small meshes/ });
});

test('maximumParts outside 1 to 1,000,000 is refused', () => {
  for (const bad of [0, -1, 1.5, MAX_NATIVE_TRACE_PARTS + 1, '5']) {
    assert.throws(() => buildTraceScene(stripParts(1, 1), {}, { maximumParts: bad }), { name: 'RangeError', message: /maximumParts is an integer from 1 to 1000000/ });
  }
});
