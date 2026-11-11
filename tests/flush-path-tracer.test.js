import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveFlushParts } from '../src/coplanar-overlap.js';
import { renderPathTracedImage } from '../src/path-tracer.js';
import { liftRankedTriangles } from '../src/flush-lift.js';
import { setFlushOrder } from '../src/depth-layer.js';

// The path tracer draws the cut geometry of the flush pass (path-tracer-scene.js), but a rank is a rasteriser bias it cannot use.
// Where the pass ranks two faces on one plane instead of cutting one away, the rays see both at the same distance and the
// face behind may win the pixel (issue #751, effects on cut geometry). Each case here looks at one flush pair head on and reads the
// albedo of the first surface hit at the middle pixel: it must be the face the pass ranked in front.
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const RED = [0.9, 0.1, 0.1];
const GREEN = [0.1, 0.9, 0.1];
const CAMERA = { eye: [0, 0, 4], target: [0, 0, 0], up: [0, 1, 0], fov: 30 };
const OPTIONS = { width: 17, height: 17, samples: 1, bounces: 1, denoise: false, threads: 1 };

function quadPart(name, half, color, material = {}) {
  const geometry = {
    positions: new Float32Array([-half, -half, 0, half, -half, 0, half, half, 0, -half, half, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  };
  return { name, geometry, matrix: new Float32Array(IDENTITY), material: { tag: 'surface', metallic: 0, roughness: 1, color, ...material } };
}

async function centreAlbedo(parts) {
  const { features } = await renderPathTracedImage({ parts, environment: { keyColor: [1, 1, 1], lightDirection: [0, 0, 1] }, camera: CAMERA }, OPTIONS);
  const centre = (8 * 17 + 8) * 3;
  return Array.from(features.albedo.slice(centre, centre + 3), value => Math.round(value * 10) / 10);
}

async function centreAlbedoOfBothOrders(first, second) {
  const forward = [first(), second()];
  resolveFlushParts(forward);
  const backward = [second(), first()];
  resolveFlushParts(backward);
  return [await centreAlbedo(forward), await centreAlbedo(backward)];
}

test('of two identical faces on one plane the later part shows, in either part order', async () => {
  const lower = () => quadPart('lower', 1, RED);
  const upper = () => quadPart('upper', 1, GREEN);
  const [forward, backward] = await centreAlbedoOfBothOrders(lower, upper);
  assert.deepEqual(forward, GREEN, 'upper comes last');
  assert.deepEqual(backward, RED, 'lower comes last');
});

test('a one-sided patch on a double-sided leaf shows the patch', async () => {
  const leaf = () => quadPart('leaf', 2, RED, { doubleSided: true });
  const patch = () => quadPart('patch', 1, GREEN);
  const [forward, backward] = await centreAlbedoOfBothOrders(leaf, patch);
  assert.deepEqual(forward, GREEN);
  assert.deepEqual(backward, GREEN);
});

test('a lift moves only ranked triangles, along their front normal, on copied vertices', () => {
  const lower = quadPart('lower', 1, RED);
  const upper = quadPart('upper', 1, GREEN);
  const parts = [lower, upper];
  resolveFlushParts(parts);
  assert.equal(liftRankedTriangles(lower, lower.geometry), lower.geometry, 'a part with no rank keeps its geometry object');
  const lifted = liftRankedTriangles(upper, upper.geometry);
  assert.equal(lifted.positions.length, (4 + 6) * 3, 'two ranked triangles bring three vertices each');
  assert.deepEqual(Array.from(lifted.positions.slice(0, 12)), Array.from(upper.geometry.positions), 'the original vertices stay as they were');
  const step = 1e-4 + (1 * 1 + 0) * 2 ** -19;
  for (let vertex = 4; vertex < 10; vertex++) assert.ok(Math.abs(lifted.positions[vertex * 3 + 2] - step) < 1e-9, 'lifted by one rank along +z');
  assert.equal(lifted.normals.length, lifted.positions.length);
});

test('a skinned part with ranked triangles is lifted at its pose, so the ranked face is hit first', async () => {
  const skinned = (name, color) => {
    const part = quadPart(name, 1, color);
    part.geometry.skinIndices = new Uint16Array([0, 0, 0, 0]);
    part.geometry.skinWeights = new Float32Array([1, 1, 1, 1]);
    part.skin = { jointMatrices: new Float32Array(IDENTITY) };
    return part;
  };
  const lower = skinned('lower', RED);
  const upper = skinned('upper', GREEN);
  // The flush search leaves deforming parts out (flush-search.js), so no pass ranks a skinned part today; the order is set by hand.
  setFlushOrder(upper, { indices: upper.geometry.indices, ranges: [{ start: 0, count: 6, rank: 1 }], triangleRanks: new Uint8Array([1, 1]) });
  assert.deepEqual(await centreAlbedo([lower, upper]), GREEN);
  assert.deepEqual(await centreAlbedo([upper, lower]), GREEN, 'the rank wins in either part order');
});
