import test from 'node:test';
import assert from 'node:assert/strict';
import { BufferGeometry, Float32BufferAttribute, Mesh, Vector3 } from 'three';
import { MAX_MORPH_TARGETS, MAX_STORED_MORPH_TARGETS, selectMorphSlots, createMorphPose, validateMorphGeometry, validateMorphPose, packMorphTargets } from '../src/morph.js';
import { skinTextureLayout } from '../src/skinning.js';

function triangle() {
  return {
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    morphTargets: [
      { positions: new Float32Array([1, 2, 0, 0, 2, 0, 1, 0, 0]), normals: new Float32Array([0, 1, -1, 0, 1, -1, 0, 1, -1]) },
      { positions: new Float32Array([0, 0, 2, -2, 0, 1, 0, -1, 2]) },
    ],
  };
}

test('signed relative target blends match literal positions and the installed Three.js Mesh implementation', () => {
  const geometry = triangle();
  const pose = createMorphPose(2);
  pose.weights.set([0.5, -2]);
  const metadata = validateMorphGeometry(geometry, pose);
  const packed = packMorphTargets(geometry, skinTextureLayout(metadata.texelCount, 16, 2));
  const threeGeometry = new BufferGeometry();
  threeGeometry.setAttribute('position', new Float32BufferAttribute(geometry.positions, 3));
  threeGeometry.morphAttributes.position = geometry.morphTargets.map(target => new Float32BufferAttribute(target.positions, 3));
  threeGeometry.morphTargetsRelative = true;
  const mesh = new Mesh(threeGeometry);
  mesh.morphTargetInfluences = Array.from(pose.weights);
  const expected = [[0.5, 1, -4], [5, 1, -2], [0.5, 3, -4]];
  for (let vertex = 0; vertex < 3; vertex++) {
    const actual = Array.from(geometry.positions.subarray(vertex * 3, vertex * 3 + 3));
    for (let target = 0; target < 2; target++) {
      for (let component = 0; component < 3; component++) actual[component] += pose.weights[target] * packed[(target * 3 + vertex) * 8 + component];
    }
    assert.deepEqual(actual, expected[vertex]);
    assert.deepEqual(mesh.getVertexPosition(vertex, new Vector3()).toArray(), expected[vertex]);
  }
  assert.deepEqual(Array.from(pose.weights), [0.5, -2]);
  assert.deepEqual([0, 0.5, 0.5], [0, packed[5] * 0.5, 1 + packed[6] * 0.5]);
  mesh.material.dispose();
  threeGeometry.dispose();
});

test('target-major two-texel packing preserves channels, missing zeros and texture padding', () => {
  const geometry = triangle();
  geometry.morphTargets.push({ normals: new Float32Array([1, 0, 0, 0, 2, 0, 0, 0, 3]) });
  const metadata = validateMorphGeometry(geometry, createMorphPose(3));
  const layout = skinTextureLayout(metadata.texelCount, 8, 2);
  assert.deepEqual(layout, { width: 6, height: 3, bytes: 288 });
  const data = packMorphTargets(geometry, { width: 8, height: 3, bytes: 384 });
  assert.deepEqual(Array.from(data.subarray(0, 8)), [1, 2, 0, 0, 0, 1, -1, 0]);
  assert.deepEqual(Array.from(data.subarray(24, 32)), [0, 0, 2, 0, 0, 0, 0, 0]);
  assert.deepEqual(Array.from(data.subarray(48, 56)), [0, 0, 0, 0, 1, 0, 0, 0]);
  assert.deepEqual(Array.from(data.subarray(64, 72)), [0, 0, 0, 0, 0, 0, 3, 0]);
  assert.ok(data.subarray(72).every(value => value === 0));
  assert.equal(data.byteLength, 384);
  assert.equal(metadata.vertexCount, 3);
  assert.equal(metadata.targetCount, 3);
  assert.deepEqual(metadata.targets[0].positionMaxima, [1, 2, 0]);
});

test('one static metadata object accepts independent retained poses and validates without changing their weights', () => {
  const geometry = triangle();
  const first = createMorphPose(2);
  const second = createMorphPose(2);
  const weights = second.weights;
  const metadata = validateMorphGeometry(geometry, first);
  second.weights.set([-1, 1.5]);
  assert.equal(validateMorphPose(second, metadata), metadata);
  assert.equal(second.weights, weights);
  assert.deepEqual(Array.from(weights), [-1, 1.5]);
  second.weights[1] = NaN;
  assert.throws(() => validateMorphPose(second, metadata), /finite Float32/);
  assert.equal(second.weights, weights);
  assert.equal(second.weights[0], -1);
  assert.ok(Number.isNaN(second.weights[1]));
  assert.ok(Object.isFrozen(metadata));
  assert.ok(Object.isFrozen(metadata.targets[0].positionMaxima));
  assert.throws(() => validateMorphPose(first, { ...metadata }), /metadata/);
});

test('cheap pose validation pins static channel identities and leaves content rescans to full preflight', () => {
  const geometry = triangle();
  const pose = createMorphPose(2);
  const metadata = validateMorphGeometry(geometry, pose);
  const original = geometry.morphTargets[0].positions;
  geometry.morphTargets[0].positions = new Float32Array(original);
  assert.throws(() => validateMorphPose(pose, metadata), /identities/);
  geometry.morphTargets[0].positions = original;
  original[0] = NaN; // Deliberate contract violation proves the frame validator does not scan vertices.
  assert.equal(validateMorphPose(pose, metadata), metadata);
  assert.throws(() => validateMorphGeometry(geometry, pose), /finite/);
  original[0] = 1;
  geometry.positions = new Float32Array(geometry.positions);
  assert.throws(() => validateMorphPose(pose, metadata), /identities/);
});

test('zero and cancelled normal blends remain valid for shader fallback, while overflow bounds reject atomically', () => {
  const geometry = triangle();
  const pose = createMorphPose(2);
  const metadata = validateMorphGeometry(geometry, pose);
  geometry.morphTargets[0].normals.set([0, 0, -1, 0, 0, -1, 0, 0, -1]);
  const cancellationMetadata = validateMorphGeometry(geometry, pose);
  pose.weights[0] = 1;
  validateMorphPose(pose, cancellationMetadata);
  pose.weights[0] = 1e20;
  const before = Array.from(pose.weights);
  assert.throws(() => validateMorphPose(pose, metadata), /normal squared/);
  assert.deepEqual(Array.from(pose.weights), before);
  pose.weights[0] = 3e38;
  assert.throws(() => validateMorphPose(pose, metadata), /Float32 position or normal/);
  pose.weights[0] = Infinity;
  assert.throws(() => validateMorphPose(pose, metadata), /finite/);
});

test('Float32 accumulation guards aggregate overflow even when every target product is finite', () => {
  const geometry = triangle();
  geometry.morphTargets = [
    { positions: new Float32Array(9).fill(2e38) },
    { positions: new Float32Array(9).fill(-2e38) },
  ];
  const pose = createMorphPose(2);
  const metadata = validateMorphGeometry(geometry, pose);
  pose.weights.fill(1);
  assert.throws(() => validateMorphPose(pose, metadata), /Float32 position/);
});

test('malformed channels, poses, target counts and unsafe base normals reject before packing', () => {
  for (const count of [0, 257, 1.5, NaN, Infinity]) assert.throws(() => createMorphPose(count), /count/);
  assert.equal(MAX_MORPH_TARGETS, 64);
  assert.equal(MAX_STORED_MORPH_TARGETS, 256);
  assert.equal(createMorphPose(64).weights.length, 64);
  assert.equal(createMorphPose(256).weights.length, 256);
  assert.equal(validateMorphGeometry({}, undefined), undefined);
  assert.throws(() => validateMorphGeometry(triangle(), null), /pose/);
  for (const targets of [[], new Array(65).fill({}), [{}], [{ position: new Float32Array(9) }], [null]]) {
    assert.throws(() => validateMorphGeometry({ ...triangle(), morphTargets: targets }, createMorphPose(1)));
  }
  for (const values of [new Float32Array(8), new Float64Array(9), new Array(9).fill(0), new Float32Array(9).fill(Infinity)]) {
    const geometry = triangle();
    geometry.morphTargets[0].positions = values;
    assert.throws(() => validateMorphGeometry(geometry, createMorphPose(2)), /Float32/);
    assert.throws(() => packMorphTargets(geometry, { width: 4, height: 3 }), /Float32/);
  }
  for (const normals of [new Float32Array(9), new Float32Array(9).fill(1e-30), new Float32Array(9).fill(1e-20), new Float32Array(9).fill(1e20)]) {
    assert.throws(() => validateMorphGeometry({ ...triangle(), normals }, createMorphPose(2)), /squared length/);
  }
  const geometry = triangle();
  const metadata = validateMorphGeometry(geometry, createMorphPose(2));
  for (const weights of [new Float64Array(2), [0, 0], new Float32Array(1)]) {
    assert.throws(() => validateMorphPose({ weights }, metadata), /Float32 weight/);
  }
});

test('all 64 targets pack within explicit texture capacity and invalid layouts fail before allocation', () => {
  const geometry = triangle();
  geometry.morphTargets = Array.from({ length: 64 }, () => ({ positions: new Float32Array(9) }));
  const metadata = validateMorphGeometry(geometry, createMorphPose(64));
  const layout = skinTextureLayout(metadata.texelCount, 32, 2);
  assert.equal(packMorphTargets(geometry, layout).byteLength, layout.bytes);
  assert.throws(() => skinTextureLayout(metadata.texelCount, 16, 2), /MAX_TEXTURE_SIZE/);
  for (const layout of [null, {}, { width: 3, height: 128 }, { width: 2, height: 1 }, { width: 32, height: 12, bytes: 1 }, { width: 2 ** 30, height: 2 ** 30 }]) {
    assert.throws(() => packMorphTargets(geometry, layout), /layout/);
  }
});

test('above 64 targets a draw applies the 64 largest nonzero weights', () => {
  const slotTargets = new Float32Array(64);
  const slotWeights = new Float32Array(64);
  const rig = new Float32Array(175);
  rig[170] = 0.5;
  rig[3] = -0.9;
  rig[100] = 0.5;
  assert.equal(selectMorphSlots(rig, slotTargets, slotWeights), 3);
  assert.deepEqual([...slotTargets.subarray(0, 3)], [3, 100, 170], 'largest magnitude first, lower target wins a tie');
  assert.deepEqual([...slotWeights.subarray(0, 3)].map(weight => Math.fround(weight)), [Math.fround(-0.9), 0.5, 0.5]);

  const crowded = Float32Array.from({ length: 175 }, (_, index) => (index + 1) / 200);
  assert.equal(selectMorphSlots(crowded, slotTargets, slotWeights), 64);
  assert.equal(slotTargets[0], 174);
  assert.equal(slotTargets[63], 111, 'the 64 largest weights are targets 111 to 174');
});
