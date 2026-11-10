// Mesh volumes (issue 807): environment.localVolumes entries with shape "mesh" take their place and size from a part.
// Bounds fit becomes an oriented box for the rasterizer and the tracer; mesh fit walks the closed mesh in the CPU tracer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveLocalVolumes, createLocalVolumeBuffers, packLocalVolumes, localVolumeInterval } from '../src/local-volumes.js';
import { bindLocalVolumeParts } from '../src/local-volume-parts.js';
import { createLocalVolumeCrossing, prepareMeshVolume, countOpenEdges } from '../src/path-tracer-volume.js';
import { renderPathTracedImage } from '../src/path-tracer.js';
import { normalizeAgentLook } from '../src/agent-look.js';

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

// A closed box from (0,0,0) to (1,1,1), eight shared corners and twelve triangles.
function unitBox() {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1]);
  const indices = new Uint32Array([0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5]);
  return { positions, indices };
}

// An L-shaped prism: three unit squares in x and z (the notch is x in 1..2, z in 1..2), extruded in y from 0 to 1.
function lPrism() {
  const outline = [[0, 0], [1, 0], [2, 0], [2, 1], [1, 1], [1, 2], [0, 2], [0, 1]];
  const positions = [];
  for (const height of [0, 1]) for (const [x, z] of outline) positions.push(x, height, z);
  const indices = [];
  const top = outline.length;
  for (const [a, b, c, d] of [[0, 1, 4, 7], [1, 2, 3, 4], [7, 4, 5, 6]]) {
    indices.push(a, b, c, a, c, d, top + a, top + c, top + b, top + a, top + d, top + c);
  }
  for (let corner = 0; corner < outline.length; corner++) {
    const next = (corner + 1) % outline.length;
    indices.push(corner, next, top + next, corner, top + next, top + corner);
  }
  return { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
}

// Two unit boxes with a gap of two units between them, as one closed mesh in two shells.
function dumbbell() {
  const box = unitBox();
  const positions = new Float32Array(48);
  positions.set(box.positions);
  for (let index = 0; index < box.positions.length; index += 3) {
    positions[24 + index] = box.positions[index] + 3;
    positions[24 + index + 1] = box.positions[index + 1];
    positions[24 + index + 2] = box.positions[index + 2];
  }
  const indices = new Uint32Array(72);
  indices.set(box.indices);
  for (let index = 0; index < box.indices.length; index++) indices[36 + index] = box.indices[index] + 8;
  return { positions, indices };
}

function part(name, mesh, matrix = IDENTITY, extra = {}) {
  return { name, geometry: { ...mesh, normals: new Float32Array(mesh.positions.length) }, matrix, ...extra };
}

const SMOKE = { density: 1, falloff: 0, steps: 8 };

function transmittanceAlong(volumes, origin, direction, length) {
  const crossing = createLocalVolumeCrossing(volumes);
  const throughput = new Float64Array([1, 1, 1]);
  crossing(...origin, ...direction, length, 0.5, throughput, new Float64Array(3));
  return throughput[0];
}

function closedVolume(mesh, volumeFields = {}, matrix = IDENTITY) {
  const [resolved] = resolveLocalVolumes([{ shape: 'mesh', part: 'room', fit: 'mesh', ...SMOKE, ...volumeFields }]);
  const [bound] = bindLocalVolumeParts([resolved], [part('room', mesh, matrix)]);
  return prepareMeshVolume(bound, 'environment.localVolumes[0]');
}

test('a mesh volume resolves to a part and refuses the fields of a box or a sphere, naming the field', () => {
  const [volume] = resolveLocalVolumes([{ shape: 'mesh', part: 'room' }]);
  assert.equal(volume.part, 'room');
  assert.equal(volume.fit, 'bounds');
  assert.equal('center' in volume, false);
  assert.throws(() => resolveLocalVolumes([{ shape: 'mesh' }]), /localVolumes\[0\]\.part must be the name of the part/);
  assert.throws(() => resolveLocalVolumes([{ shape: 'mesh', part: 'room', size: [1, 1, 1] }]), /localVolumes\[0\]\.size belongs to a box or a sphere/);
  assert.throws(() => resolveLocalVolumes([{ shape: 'mesh', part: 'room', fit: 'hull' }]), /localVolumes\[0\]\.fit must be one of bounds, mesh/);
  assert.throws(() => resolveLocalVolumes([{ center: [0, 0, 0], size: [1, 1, 1], part: 'room' }]), /localVolumes\[0\]\.part and localVolumes\[0\]\.fit belong to shape "mesh"/);
  assert.equal(normalizeAgentLook({ environment: { localVolumes: [{ shape: 'mesh', part: 'room' }] } }).environment.localVolumes[0].part, 'room');
});

test('a part reference that names no part throws with the field and the part names', () => {
  const [volume] = resolveLocalVolumes([{ shape: 'mesh', part: 'hall' }]);
  assert.throws(() => bindLocalVolumeParts([volume], [part('room', unitBox()), part('floor', unitBox())]), /environment\.localVolumes\[0\]\.part "hall" names no part in the scene; parts: room, floor/);
  assert.throws(() => bindLocalVolumeParts([{ ...volume, part: 'room' }], [part('room', unitBox(), IDENTITY, { skin: {} })]), /localVolumes\[0\]\.part "room" is skinned/);
  assert.throws(() => bindLocalVolumeParts([{ ...volume, part: 'room' }], [part('room', unitBox(), [0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])]), /has a flat transform/);
});

test('the bounds of a rotated, scaled part become an oriented box that the interval and the packing carry', () => {
  const quarterTurn = [0, 0, -2, 0, 0, 3, 0, 0, 1, 0, 0, 0, 10, 0, 0, 1];
  const [volume] = resolveLocalVolumes([{ shape: 'mesh', part: 'room', falloff: 0 }]);
  const [box] = bindLocalVolumeParts([volume], [part('room', unitBox(), quarterTurn)]);
  assert.equal(box.shape, 'box');
  assert.deepEqual(box.size.map(extent => Math.round(extent * 1e6) / 1e6), [2, 3, 1]);
  assert.deepEqual(box.center.map(value => Math.round(value * 1e6) / 1e6), [10.5, 1.5, -1]);
  const span = new Float64Array(2);
  assert.equal(localVolumeInterval(box, 10.5, 1.5, -5, 0, 0, 1, 100, span), true, 'the long axis lies along z after the turn');
  assert.deepEqual(Array.from(span).map(value => Math.round(value * 1e6) / 1e6), [3, 5]);
  assert.equal(localVolumeInterval(box, 10.5, 1.5, -5, 1, 0, 0, 100, span), false);
  const buffers = packLocalVolumes([box], createLocalVolumeBuffers());
  assert.deepEqual(Array.from(buffers.axes.slice(0, 12)).map(value => Math.round(value)), [0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0]);
  assert.throws(() => packLocalVolumes([volume], createLocalVolumeBuffers()), /bindLocalVolumeParts/);
});

test('a fit "mesh" volume packs for the rasterizer as its bounds plus a slot in the mesh buffer', () => {
  const [volume] = resolveLocalVolumes([{ shape: 'mesh', part: 'room', fit: 'mesh' }]);
  const room = part('room', unitBox());
  const buffers = packLocalVolumes(bindLocalVolumeParts([volume], [room]), createLocalVolumeBuffers());
  assert.equal(buffers.centers[3], 2, 'packed as a mesh shape');
  assert.equal(buffers.steps[1], 0, 'the first slot');
  assert.deepEqual(buffers.meshParts, [{ part: room, label: 'environment.localVolumes[0]' }]);
  const bounds = packLocalVolumes(bindLocalVolumeParts(resolveLocalVolumes([{ shape: 'mesh', part: 'room' }]), [room]), createLocalVolumeBuffers());
  assert.equal(bounds.centers[3], 0, 'fit bounds packs as a box');
  assert.equal(bounds.meshParts.length, 0);
});

test('an open mesh has no inside: it throws with the open edge count, and a closed one reports none', () => {
  const closed = lPrism();
  assert.equal(countOpenEdges(closed.positions, closed.indices, 1e-6), 0);
  assert.equal(countOpenEdges(unitBox().positions, unitBox().indices, 1e-6), 0);
  const open = { positions: closed.positions, indices: closed.indices.slice(0, closed.indices.length - 6) };
  assert.throws(() => closedVolume(open), /environment\.localVolumes\[0\]\.part "room" is not a closed mesh \(\d+ open edges\)/);
});

test('the transmittance through an L-shaped closed mesh is exp(-density * length inside), against the analytic length', () => {
  const volume = closedVolume(lPrism(), { density: 0.7 });
  const alongArm = transmittanceAlong([volume], [-1, 0.37, 0.43], [1, 0, 0], 10);
  assert.ok(Math.abs(alongArm - Math.exp(-0.7 * 2)) < 1e-9, `through the long arm ${alongArm}`);
  const throughShortArm = transmittanceAlong([volume], [-1, 0.37, 1.43], [1, 0, 0], 10);
  assert.ok(Math.abs(throughShortArm - Math.exp(-0.7 * 1)) < 1e-9, `through the short arm ${throughShortArm}`);
  const pastNotch = transmittanceAlong([volume], [1.43, 0.37, 3], [0, 0, -1], 10);
  assert.ok(Math.abs(pastNotch - Math.exp(-0.7 * 1)) < 1e-9, `from the notch side ${pastNotch}`);
  const thread = transmittanceAlong([volume], [1.61, 0.37, 1.71], [0, 0, 1], 10);
  assert.equal(thread, 1, 'a ray through the notch crosses no smoke');
  const upward = transmittanceAlong([volume], [0.31, -2, 1.47], [0, 1, 0], 10);
  assert.ok(Math.abs(upward - Math.exp(-0.7 * 1)) < 1e-9, `through the height ${upward}`);
});

test('a ray that leaves a closed mesh and comes back crosses both pieces, starts inside, and stops at its limit', () => {
  const volume = closedVolume(dumbbell(), { density: 1 });
  const both = transmittanceAlong([volume], [-1, 0.37, 0.43], [1, 0, 0], 20);
  assert.ok(Math.abs(both - Math.exp(-2)) < 1e-9, `two shells ${both}`);
  const fromInside = transmittanceAlong([volume], [0.5, 0.37, 0.43], [1, 0, 0], 20);
  assert.ok(Math.abs(fromInside - Math.exp(-1.5)) < 1e-9, `starting inside ${fromInside}`);
  const cut = transmittanceAlong([volume], [-1, 0.37, 0.43], [1, 0, 0], 1.5);
  assert.ok(Math.abs(cut - Math.exp(-0.5)) < 1e-9, `cut by a surface ${cut}`);
});

test('mesh volumes are deterministic: the same ray and jitter give the same bits', () => {
  const volume = closedVolume(lPrism(), { density: 0.9, emission: [1, 0.5, 0.2], emissionStrength: 2, falloff: 0.5 });
  const run = () => {
    const throughput = new Float64Array([1, 1, 1]);
    const emitted = new Float64Array(3);
    createLocalVolumeCrossing([volume])(-1, 0.37, 0.43, 1, 0, 0, 10, 0.31, throughput, emitted);
    return [...throughput, ...emitted];
  };
  assert.deepEqual(run(), run());
});

const LOOKING_DOWN = { eye: [0, 3, 0], target: [0, 0, 0], up: [0, 0, -1], fov: 40 };
const IMAGE = { width: 16, height: 16, denoise: false, threads: 1, bounces: 1, samples: 1 };

function glowingGround() {
  const half = 20;
  const geometry = {
    positions: new Float32Array([-half, 0, half, half, 0, half, half, 0, -half, -half, 0, -half]),
    normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]),
    uvs: new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  };
  return { name: 'ground', geometry, material: { tag: 'surface', metallic: 0, roughness: 1, color: [0, 0, 0], ior: 1, emission: 1, emissiveColor: [1, 1, 1] } };
}

async function pixel(fit, column, row) {
  // The L covers x and z from -0.4 to 0.4 with its notch in the corner where both are positive, from y 0.2 to 1.2.
  const matrix = [0.4, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0.4, 0, -0.4, 0.2, -0.4, 1];
  const room = part('room', lPrism(), matrix, { visible: false, material: glowingGround().material });
  const environment = { localVolumes: [{ shape: 'mesh', part: 'room', fit, density: 1, falloff: 0, steps: 8 }] };
  const { linear } = await renderPathTracedImage({ parts: [glowingGround(), room], environment, camera: LOOKING_DOWN }, IMAGE);
  return linear[(row * 16 + column) * 3];
}

test('the path tracer fills a hidden L-shaped part with smoke and leaves the notch clear, while bounds fill the whole box', async () => {
  const insideArm = await pixel('mesh', 5, 5);
  const inNotch = await pixel('mesh', 10, 10);
  const boundsNotch = await pixel('bounds', 10, 10);
  const outside = await pixel('mesh', 1, 1);
  assert.ok(Math.abs(insideArm - Math.exp(-1)) < 0.01, `arm ${insideArm}`);
  assert.equal(inNotch, 1, 'the notch of the L is clear');
  assert.ok(Math.abs(boundsNotch - Math.exp(-1)) < 0.01, `bounds fill the notch: ${boundsNotch}`);
  assert.equal(outside, 1);
  assert.equal(await pixel('mesh', 5, 5), insideArm, 'the same scene renders the same pixel');
});

test('a scene without mesh volumes builds the same trace scene as before', async () => {
  const withoutVolumes = await renderPathTracedImage({ parts: [glowingGround()], environment: {}, camera: LOOKING_DOWN }, IMAGE);
  const emptyList = await renderPathTracedImage({ parts: [glowingGround()], environment: { localVolumes: [] }, camera: LOOKING_DOWN }, IMAGE);
  assert.deepEqual(Array.from(emptyList.linear), Array.from(withoutVolumes.linear));
});
