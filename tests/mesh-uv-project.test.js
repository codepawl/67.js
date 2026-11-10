import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { box, cylinder, sphere } from '../src/geometry.js';
import { meshFromGeometry, applyMeshEdits } from '../src/mesh.js';
import { projectUv, packUvIslands } from '../src/mesh-uv-project.js';
import { normalizeMeshEdits, normalizeMeshStack } from '../src/mesh-recipe.js';

const crate = () => meshFromGeometry(box(0, 1));
const barrel = () => meshFromGeometry(cylinder(24, 0, 1));

function triangleRatios(mesh) {
  const uv = mesh.attributes.corner.uv.data;
  const ratios = [];
  let flipped = 0;
  for (let face = 0; face < mesh.faceCount; face++) {
    const start = mesh.faceOffsets[face];
    const end = mesh.faceOffsets[face + 1];
    const point = corner => [0, 1, 2].map(axis => mesh.positions[mesh.cornerVertices[corner] * 3 + axis]);
    for (let corner = start + 1; corner < end - 1; corner++) {
      const [a, b, c] = [point(start), point(corner), point(corner + 1)];
      const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      const area3d = Math.hypot(ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]) / 2;
      const area2d = ((uv[corner * 2] - uv[start * 2]) * (uv[(corner + 1) * 2 + 1] - uv[start * 2 + 1])
        - (uv[(corner + 1) * 2] - uv[start * 2]) * (uv[corner * 2 + 1] - uv[start * 2 + 1])) / 2;
      if (area2d < 0) flipped++;
      if (area3d > 1e-9) ratios.push(Math.abs(area2d) / area3d);
    }
  }
  return { ratios, flipped };
}

function densitySpread(mesh) {
  const { ratios } = triangleRatios(mesh);
  const sorted = [...ratios].sort((left, right) => left - right);
  const median = sorted[sorted.length >> 1];
  return { low: sorted[0] / median, high: sorted.at(-1) / median };
}

function islandBoxes(mesh) {
  const uv = mesh.attributes.corner.uv.data;
  const parents = Array.from({ length: mesh.faceCount }, (_, face) => face);
  const find = face => (parents[face] === face ? face : (parents[face] = find(parents[face])));
  const owners = new Map();
  for (let face = 0; face < mesh.faceCount; face++) {
    for (let corner = mesh.faceOffsets[face]; corner < mesh.faceOffsets[face + 1]; corner++) {
      const key = `${uv[corner * 2].toFixed(5)},${uv[corner * 2 + 1].toFixed(5)}`;
      if (owners.has(key)) parents[find(face)] = find(owners.get(key));
      else owners.set(key, face);
    }
  }
  const boxes = new Map();
  for (let face = 0; face < mesh.faceCount; face++) {
    const root = find(face);
    const entry = boxes.get(root) ?? { minU: Infinity, minV: Infinity, maxU: -Infinity, maxV: -Infinity };
    for (let corner = mesh.faceOffsets[face]; corner < mesh.faceOffsets[face + 1]; corner++) {
      entry.minU = Math.min(entry.minU, uv[corner * 2]);
      entry.maxU = Math.max(entry.maxU, uv[corner * 2]);
      entry.minV = Math.min(entry.minV, uv[corner * 2 + 1]);
      entry.maxV = Math.max(entry.maxV, uv[corner * 2 + 1]);
    }
    boxes.set(root, entry);
  }
  return [...boxes.values()];
}

function assertPacked(mesh, margin = 0.01) {
  for (const value of mesh.attributes.corner.uv.data) assert.ok(value >= margin - 1e-6 && value <= 1 - margin + 1e-6, `uv ${value} left the square`);
  const boxes = islandBoxes(mesh);
  for (let first = 0; first < boxes.length; first++) {
    for (let second = first + 1; second < boxes.length; second++) {
      const left = boxes[first];
      const right = boxes[second];
      const apart = left.maxU <= right.minU + 1e-6 || right.maxU <= left.minU + 1e-6 || left.maxV <= right.minV + 1e-6 || right.maxV <= left.minV + 1e-6;
      assert.ok(apart, `islands ${first} and ${second} overlap`);
    }
  }
}

test('cube projection gives a crate six islands of one texel density inside the square', () => {
  const { mesh, islands } = projectUv(crate(), { mode: 'cube' });
  assert.equal(islands, 6);
  assertPacked(mesh);
  const spread = densitySpread(mesh);
  assert.ok(spread.low > 0.999 && spread.high < 1.001, JSON.stringify(spread));
  assert.equal(triangleRatios(mesh).flipped, 0);
});

test('cylinder projection keeps a barrel within 15 percent of its median texel density', () => {
  const { mesh, islands } = projectUv(barrel(), { mode: 'cylinder', axis: 'y' });
  assert.ok(islands >= 3, `${islands} islands`);
  assertPacked(mesh);
  const spread = densitySpread(mesh);
  assert.ok(spread.low > 0.85 && spread.high < 1.15, JSON.stringify(spread));
  assert.equal(triangleRatios(mesh).flipped, 0);
});

test('sphere projection wraps without flipping and stays packed', () => {
  const { mesh } = projectUv(meshFromGeometry(sphere(32, 16)), { mode: 'sphere' });
  assertPacked(mesh);
  assert.equal(triangleRatios(mesh).flipped, 0);
});

test('projections are deterministic byte for byte', () => {
  for (const mode of ['cube', 'cylinder', 'sphere']) {
    const first = projectUv(barrel(), { mode }).mesh.attributes.corner.uv.data;
    const second = projectUv(barrel(), { mode }).mesh.attributes.corner.uv.data;
    assert.deepEqual(Buffer.from(first.buffer), Buffer.from(second.buffer));
  }
});

test('pack false keeps uv in mesh units and uv_pack then fits the square without overlaps', () => {
  const raw = projectUv(crate(), { mode: 'cube', pack: false });
  assert.ok(raw.mesh.attributes.corner.uv.data.some(value => value < 0));
  const packed = packUvIslands(raw.mesh, { margin: 0.05, rotate: false });
  assert.equal(packed.islands, 6);
  assertPacked(packed.mesh, 0.05);
  const { mesh, results } = applyMeshEdits(crate(), [{ op: 'uv_project', mode: 'cube', pack: false }, { op: 'uv_pack', margin: 0.02 }]);
  assert.equal(results[1].islands, 6);
  assertPacked(mesh, 0.02);
});

test('packing needs uv and the edits validate their fields', () => {
  assert.throws(() => applyMeshEdits(crate(), [{ op: 'uv_pack' }]), /has no uv to pack/);
  assert.throws(() => normalizeMeshEdits([{ op: 'uv_project' }]), /edits\[0\]\.mode: got undefined; expected one of cube, cylinder, sphere/);
  assert.throws(() => normalizeMeshEdits([{ op: 'uv_project', mode: 'cube', axis: 'w' }]), /edits\[0\]\.axis/);
  assert.throws(() => normalizeMeshEdits([{ op: 'uv_project', mode: 'cube', pack: 1 }]), /edits\[0\]\.pack/);
  assert.throws(() => normalizeMeshEdits([{ op: 'uv_pack', margin: 0.5 }]), /margin/);
  assert.deepEqual(normalizeMeshEdits([{ op: 'uv_project', mode: 'sphere' }])[0], { op: 'uv_project', mode: 'sphere', axis: 'y', pack: true, margin: 0.01, rotate: true });
  assert.equal(normalizeMeshStack([{ op: 'uv_project', mode: 'cube' }, { op: 'uv_pack' }]).length, 2);
});
