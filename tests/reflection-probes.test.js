import test from 'node:test';
import assert from 'node:assert/strict';
import { box, sphere } from '../src/geometry.js';
import { applyReflectionProbes, isReflectivePart, normalizeProbeList, placeProbes, selectProbe, roomCentreProbe, traceObjectProbes } from '../src/reflection-probes.js';
import { MAXIMUM_OBJECT_PROBES, traceProbeMaps, traceProbes } from '../src/probe-trace.js';
import { createFragmentShader } from '../src/shaders.js';
import { normalizeAgentBake } from '../src/agent-bake.js';

const cube = box(0, 1);
const ball = sphere(16, 12);

function placed(name, geometry, translation, scale, material = {}) {
  const matrix = new Float32Array([scale[0], 0, 0, 0, 0, scale[1], 0, 0, 0, 0, scale[2], 0, translation[0], translation[1], translation[2], 1]);
  return { name, geometry, matrix, material: { tag: 'surface', color: [0.7, 0.7, 0.7], metallic: 0, roughness: 0.8, emission: 0, ...material } };
}

function closedRoom() {
  return [
    placed('floor', cube, [0, -0.05, 0], [6, 0.1, 6]),
    placed('ceiling', cube, [0, 3.05, 0], [6, 0.1, 6]),
    placed('back', cube, [0, 1.5, -3.05], [6, 3.2, 0.1], { color: [0.8, 0.1, 0.1] }),
    placed('left', cube, [-3.05, 1.5, 0], [0.1, 3.2, 6]),
    placed('right', cube, [3.05, 1.5, 0], [0.1, 3.2, 6]),
    placed('front', cube, [0, 1.5, 3.05], [6, 3.2, 0.1]),
    placed('mirror', ball, [1.5, 0.5, 0], [0.5, 0.5, 0.5], { metallic: 1, roughness: 0.05 }),
  ];
}

const lamp = { pointLights: [{ position: [0, 2.6, 0], color: [1, 1, 1], intensity: 8, radius: 0.05 }], keyColor: [0, 0, 0] };

test('an enclosed room gets one automatic probe at its centre', () => {
  const result = applyReflectionProbes(closedRoom(), lamp, 'room');
  assert.equal(result.report.placed.length, 1);
  assert.deepEqual(result.report.placed[0].position.map(value => Math.round(value * 100) / 100), [0, 1.5, 0]);
  assert.ok(result.report.placed[0].hitFraction >= 0.9);
  assert.equal(result.report.partsWithProbe, 7);
  assert.ok(result.parts.every(part => part.material.environmentProbe === result.probes[0].map));
});

test('an open scene gets no automatic probe and says why', () => {
  const openParts = [placed('floor', cube, [0, -0.05, 0], [6, 0.1, 6]), placed('post', cube, [2, 1, 0], [0.2, 2, 0.2])];
  const result = applyReflectionProbes(openParts, lamp, 'room');
  assert.equal(result.probes.length, 0);
  assert.match(result.report.skipped, /open scene/);
  assert.equal(result.report.partsWithProbe, 0);
});

test('a probe sees the coloured wall it faces and is lit by the lamp', () => {
  const [probe] = traceProbeMaps(closedRoom(), lamp, [[0, 1.5, 0]], { width: 32, samples: 8 });
  // Row 8 of 16 looks at the horizon; the middle column looks toward -Z, where the red wall is.
  const offset = (8 * 32 + 16) * 3;
  const [red, green] = [probe.data[offset], probe.data[offset + 1]];
  assert.ok(red > 0.05 && red > green * 3, `wall seen as red ${red} ${green}`);
  assert.equal(probe.hitFraction, 1);
});

test('the same input traces the same bytes', () => {
  const first = traceProbes(closedRoom(), lamp, 'room', { samples: 8 });
  const second = traceProbes(closedRoom(), lamp, 'room', { samples: 8 });
  assert.deepEqual(Array.from(first.traced[0].data), Array.from(second.traced[0].data));
});

test('a part takes the nearest probe in range, else none', () => {
  const near = { position: [0, 0, 0], radius: 2 };
  const far = { position: [10, 0, 0], radius: 2 };
  assert.equal(selectProbe([far, near], [0.5, 0, 0]), near);
  assert.equal(selectProbe([far, near], [9, 0, 0]), far);
  assert.equal(selectProbe([far, near], [5, 0, 0]), null);
  const overlapping = { position: [1, 0, 0], radius: 2 };
  assert.equal(selectProbe([near, overlapping], [0.4, 0, 0]), near);
  assert.equal(selectProbe([overlapping, near], [0.6, 0, 0]), overlapping);
});

test('explicit probes with a radius leave distant parts without one', () => {
  const room = closedRoom();
  const result = applyReflectionProbes(room, lamp, [{ position: [1.5, 1, 0], radius: 1.2 }], { samples: 4 });
  assert.deepEqual(result.parts.filter(part => part.material.environmentProbe).map(part => part.name), ['mirror']);
});

test('probe lists are validated', () => {
  assert.throws(() => normalizeProbeList(Array.from({ length: 5 }, () => ({ position: [0, 0, 0] }))), /at most 4/);
  assert.throws(() => normalizeProbeList([{ position: [0, 0] }]), /position/);
  assert.throws(() => normalizeProbeList([{ position: [0, 0, 0], size: 1 }]), /unknown field/);
  assert.throws(() => normalizeProbeList([{ position: [0, 0, 0], radius: 0 }]), /radius/);
  assert.deepEqual(roomCentreProbe(closedRoom()).position.map(Math.round), [0, 2, 0]);
});

test('bake.probes defaults to room, and false opts out', () => {
  assert.equal(normalizeAgentBake({}).probes, 'room');
  assert.equal(normalizeAgentBake({ preset: 'draft' }).probes, 'room');
  assert.equal(normalizeAgentBake({ probes: false }).probes, false);
  assert.equal(normalizeAgentBake({ probes: 'room' }).probes, 'room');
  assert.deepEqual(normalizeAgentBake({ probes: [{ position: [0, 1, 0] }] }).probes, [{ position: [0, 1, 0] }]);
});

test('the probe shader code compiles in only when asked for', () => {
  assert.doesNotMatch(createFragmentShader(), /probeEnabled/);
  assert.match(createFragmentShader(['probe']), /probeEnabled > 0.5\) surroundings/);
});

test('a probe on a light-mapped part keeps its light map fields and still reads live colour', () => {
  const lightMap = { width: 2, height: 2, data: new Uint8Array(16) };
  const lightMapped = placed('mirror', ball, [0, 1, 0], [0.5, 0.5, 0.5], { metallic: 1, roughness: 0.05, lightMap, lightMapScale: 2, emission: 0.5 });
  const [probed] = applyReflectionProbes([lightMapped], lamp, [{ position: [0, 1, 0], radius: 5 }], {}).parts;
  assert.ok(probed.material.environmentProbe);
  assert.equal(probed.material.lightMap, lightMap);
  assert.equal(probed.material.lightMapScale, 2);
  lightMapped.material.color = [0.2, 0.3, 0.4];
  assert.deepEqual(probed.material.color, [0.2, 0.3, 0.4]);
});

const openAir = { pointLights: [], keyColor: [0, 0, 0] };

function objectScene() {
  return [
    placed('floor', cube, [0, -0.05, 0], [20, 0.1, 20], { color: [0.5, 0.5, 0.5] }),
    placed('mirror', ball, [-1, 0.5, 0], [0.5, 0.5, 0.5], { metallic: 1, roughness: 0.05 }),
    placed('block', cube, [1, 0.5, 0], [1, 1, 1], { color: [0.9, 0.1, 0.1] }),
  ];
}

test('a reflective part gets a probe of its own, and no other part is probed', () => {
  const parts = objectScene();
  const trace = traceObjectProbes(parts, openAir, { width: 32 });
  assert.equal(trace.traced.length, 1);
  assert.equal(trace.traced[0].part, 1);
  assert.deepEqual(trace.traced[0].position.map(value => Math.round(value * 100) / 100), [-1, 0.5, 0]);
  const result = placeProbes(parts, trace);
  assert.equal(result.report.partsWithProbe, 1);
  assert.equal(result.parts[1].material.environmentProbe, result.probes[0].map);
  assert.equal(result.parts[0].material.environmentProbe, undefined);
  assert.equal(result.parts[2].material.environmentProbe, undefined);
});

test('the probe of a part never hits the part itself and sees the floor and the block', () => {
  const [probe] = traceObjectProbes(objectScene(), openAir, { width: 64 }).traced;
  // The floor fills the lower half of the view and the block part of the upper half; a mirror that traced itself would fill every ray.
  assert.ok(probe.hitFraction > 0.45 && probe.hitFraction < 0.65, `floor and block fill about half the view: ${probe.hitFraction}`);
});

test('an object probe records the level floor under it so the lookup can follow the ray to the floor', () => {
  const parts = objectScene();
  const trace = traceObjectProbes(parts, openAir, { width: 32 });
  assert.ok(Math.abs(trace.traced[0].floorHeight) < 1e-3, `floor top is at 0: ${trace.traced[0].floorHeight}`);
  const { probes } = placeProbes(parts, trace);
  assert.deepEqual(probes[0].map.parallax.map(value => Math.round(value * 100) / 100), [-1, 0.5, 0, 0]);
  assert.match(createFragmentShader(['probe']), /probeFloor/);
});

test('a room probe keeps the plain lookup', () => {
  const parts = objectScene();
  const trace = traceProbes(parts, openAir, [{ position: [0, 1, 0], radius: 9 }]);
  assert.equal(placeProbes(parts, trace).probes[0].map.parallax, undefined);
});

test('a scene with no reflective part, or too many, traces nothing', () => {
  const plain = objectScene().map(part => ({ ...part, material: { ...part.material, metallic: 0 } }));
  assert.equal(traceObjectProbes(plain, openAir).traced.length, 0);
  const crowd = Array.from({ length: MAXIMUM_OBJECT_PROBES + 1 }, (item, index) => placed(`post-${index}`, cube, [index, 1, 0], [0.2, 2, 0.2], { metallic: 1, roughness: 0.3 }));
  const trace = traceObjectProbes(crowd, openAir);
  assert.equal(trace.traced.length, 0);
  assert.match(trace.skipped, /more than 8/);
  const largeScene = [
    placed('mirror', ball, [0, 0.5, 0], [0.5, 0.5, 0.5], { metallic: 1, roughness: 0.3 }),
    ...Array.from({ length: 257 }, (item, index) => placed(`box-${index}`, cube, [index, 0.5, 0], [1, 1, 1])),
  ];
  const largeTrace = traceObjectProbes(largeScene, openAir);
  assert.equal(largeTrace.traced.length, 0);
  assert.match(largeTrace.skipped, /more than 256 other parts/);
});

test('rough metal and plain surfaces are not reflective', () => {
  assert.equal(isReflectivePart({ metallic: 1, roughness: 0.3 }), true);
  assert.equal(isReflectivePart({ metallic: 1, roughness: 0.9 }), false);
  assert.equal(isReflectivePart({ metallic: 0.2, roughness: 0.1 }), false);
  assert.equal(isReflectivePart({}), false);
});

test('a bounce in the probe trace adds light to a lit surface and never takes direct light away', () => {
  const total = options => {
    const [probe] = traceObjectProbes(objectScene(), lamp, { width: 32, samples: 8, ...options }).traced;
    return probe.data.reduce((sum, value) => sum + value, 0);
  };
  const withoutBounce = total({ bounces: 0 });
  assert.ok(withoutBounce > 0);
  assert.ok(total({ bounces: 1 }) >= withoutBounce, 'the gatherer reuses the direct light buffer, which must not leak into the probe pixel');
});
