import assert from 'node:assert/strict';
import test from 'node:test';

import { buildTraceScene, MAX_GPU_TRACE_TRIANGLES, MAX_TRACE_TRIANGLES } from '../src/path-tracer-scene.js';
import { gpuTriangleCapacity, packNodes, packTriangles } from '../src/path-tracer-gpu-pack.js';
import { DATA_TEXTURE_WIDTH, TRIANGLE_TEXELS } from '../src/path-tracer-gpu-shader.js';

const AVATAR_COUNT = 43;
const QUADS_ACROSS = 70;
const QUADS_UP = 72;
const TRIANGLES_PER_AVATAR = QUADS_ACROSS * QUADS_UP * 2;
const CROWD_TRIANGLES = AVATAR_COUNT * TRIANGLES_PER_AVATAR;
const ENVIRONMENT = { keyColor: [1, 1, 1], lightDirection: [0, 1, 0] };

// A standing sheet of quads whose lower half follows joint 0 and upper half joint 1, like a skinned avatar body.
function skinnedAvatarGeometry() {
  const vertexCount = (QUADS_ACROSS + 1) * (QUADS_UP + 1);
  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const skinIndices = new Uint16Array(vertexCount * 2);
  const skinWeights = new Float32Array(vertexCount * 2);
  for (let row = 0; row <= QUADS_UP; row++) {
    for (let column = 0; column <= QUADS_ACROSS; column++) {
      const vertex = row * (QUADS_ACROSS + 1) + column;
      positions.set([column * 0.01, row * 0.025, 0], vertex * 3);
      normals.set([0, 0, 1], vertex * 3);
      const upperShare = row / QUADS_UP;
      skinIndices.set([0, 1], vertex * 2);
      skinWeights.set([1 - upperShare, upperShare], vertex * 2);
    }
  }
  const indices = new Uint32Array(TRIANGLES_PER_AVATAR * 3);
  let slot = 0;
  for (let row = 0; row < QUADS_UP; row++) {
    for (let column = 0; column < QUADS_ACROSS; column++) {
      const corner = row * (QUADS_ACROSS + 1) + column;
      const above = corner + QUADS_ACROSS + 1;
      indices.set([corner, corner + 1, above, corner + 1, above + 1, above], slot);
      slot += 6;
    }
  }
  return { positions, normals, indices, skinIndices, skinWeights };
}

function jointMatrices(upperJointShift) {
  const matrices = new Float32Array(32);
  matrices.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], 0);
  matrices.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, upperJointShift, 0, 0, 1], 16);
  return matrices;
}

function skinnedCrowd() {
  const sharedGeometry = skinnedAvatarGeometry();
  return Array.from({ length: AVATAR_COUNT }, (_, index) => ({
    name: `avatar-${index}`,
    geometry: sharedGeometry,
    skin: { jointMatrices: jointMatrices(0.5) },
    matrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, index * 2, 0, 0, 1]),
    material: { color: [0.8, 0.7, 0.6] },
  }));
}

test('a skinned crowd over 400,000 triangles is refused by default and the default bound stays 400,000', () => {
  assert.equal(MAX_TRACE_TRIANGLES, 400_000);
  assert.ok(CROWD_TRIANGLES > MAX_TRACE_TRIANGLES);
  assert.throws(() => buildTraceScene(skinnedCrowd(), ENVIRONMENT), { name: 'RangeError', message: 'A path trace takes at most 400000 triangles in total.' });
});

test('with the device bound the crowd flattens, skins and packs into tables that fit a 16384 row texture', () => {
  const scene = buildTraceScene(skinnedCrowd(), ENVIRONMENT, { gpuTriangleLimit: 1_000_000 });
  assert.equal(scene.indices.length / 3, CROWD_TRIANGLES);
  assert.equal(scene.bvh.triangleOrder.length, CROWD_TRIANGLES);
  // The last vertex of the first avatar sits on the upper joint, which moved 0.5 along x.
  const lastVertex = (QUADS_ACROSS + 1) * (QUADS_UP + 1) - 1;
  assert.ok(Math.abs(scene.positions[lastVertex * 3] - (QUADS_ACROSS * 0.01 + 0.5)) < 1e-4);
  const triangles = packTriangles(scene);
  assert.equal(triangles.height, Math.ceil((CROWD_TRIANGLES * TRIANGLE_TEXELS) / DATA_TEXTURE_WIDTH));
  assert.ok(triangles.height <= 16384);
  assert.ok(packNodes(scene.bvh).height <= triangles.height);
});

test('a crowd past the device bound is refused with the count, the bound and what to do', () => {
  assert.throws(() => buildTraceScene(skinnedCrowd(), ENVIRONMENT, { gpuTriangleLimit: 400_000 }), (error) => {
    assert.equal(error.name, 'RangeError');
    assert.match(error.message, /at most 400000 triangles/);
    assert.match(error.message, new RegExp(`got ${CROWD_TRIANGLES}\\.`));
    assert.match(error.message, /Simplify or drop meshes.*native Cook backend/);
    return true;
  });
});

test('gpuTriangleLimit is validated at the boundary', () => {
  const parts = skinnedCrowd().slice(0, 1);
  for (const bad of [0, -1, 1.5, '1000', Number.NaN, MAX_GPU_TRACE_TRIANGLES + 1]) {
    assert.throws(() => buildTraceScene(parts, ENVIRONMENT, { gpuTriangleLimit: bad }), /gpuTriangleLimit is an integer from 1 to 2000000/);
  }
  assert.throws(() => buildTraceScene(parts, ENVIRONMENT, { gpuTriangleLimit: 10, maximumTriangles: 10 }), /not both/);
});

test('the capacity of a device follows its texture size or buffer size, up to the ceiling', () => {
  const rowTriangles = (rows) => Math.floor((rows * DATA_TEXTURE_WIDTH) / TRIANGLE_TEXELS);
  assert.equal(gpuTriangleCapacity({ maximumTextureSize: 16384 }, MAX_GPU_TRACE_TRIANGLES), MAX_GPU_TRACE_TRIANGLES);
  assert.equal(gpuTriangleCapacity({ maximumTextureSize: 4096 }, MAX_GPU_TRACE_TRIANGLES), rowTriangles(4096));
  assert.equal(gpuTriangleCapacity({ maximumTextureSize: 2048 }, MAX_GPU_TRACE_TRIANGLES), rowTriangles(2048));
  assert.equal(gpuTriangleCapacity({ maximumTextureSize: 65536 }, 10_000_000), rowTriangles(16384));
  assert.equal(gpuTriangleCapacity({ maximumBufferBytes: 128 * 1024 * 1024 }, MAX_GPU_TRACE_TRIANGLES), Math.floor((128 * 1024 * 1024) / (TRIANGLE_TEXELS * 16)));
  assert.equal(gpuTriangleCapacity({ maximumBufferBytes: 1 << 30 }, MAX_GPU_TRACE_TRIANGLES), MAX_GPU_TRACE_TRIANGLES);
  assert.equal(gpuTriangleCapacity({ maximumBufferBytes: 10 }, MAX_GPU_TRACE_TRIANGLES), 1);
});

test('a 2048 row WebGL2 device still holds the 400,000 triangles the old bound allowed', () => {
  assert.ok(gpuTriangleCapacity({ maximumTextureSize: 2048 }, MAX_GPU_TRACE_TRIANGLES) >= MAX_TRACE_TRIANGLES);
});
