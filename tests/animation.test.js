import assert from 'node:assert/strict';
import test from 'node:test';
import { mat4, quat } from 'gl-matrix';
import { createAnimationClip, createAnimationPlayer, sampleAnimationClip } from '../src/animation.js';
import { createMotionScene } from '../src/motion.js';

function valueClip(interpolation = 'LINEAR', loop = false) {
  return createAnimationClip({ duration: 4, loop, tracks: [{ target: 'value', property: 'value', interpolation, keyframes: [{ time: 4, value: 8 }, { time: 0, value: 0 }, { time: 2, value: 4 }] }] });
}

test('keyframes normalize input order, clamp endpoints and sample independently of call order', () => {
  const clip = valueClip();
  const value = time => sampleAnimationClip(clip, time)[0].value;
  assert.equal(value(-10), 0);
  assert.equal(value(100), 8);
  assert.equal(value(1.5), 3);
  value(3);
  assert.equal(value(1.5), 3);
  assert.equal(value(2), 4);
  assert.deepEqual(clip.tracks[0].keyframes.map(key => key.time), [0, 2, 4]);
  assert.ok(Object.isFrozen(clip.tracks[0].keyframes));
});

test('STEP and SMOOTH interpolation retain their endpoint behavior', () => {
  const step = valueClip('STEP');
  assert.equal(sampleAnimationClip(step, 1.99)[0].value, 0);
  assert.equal(sampleAnimationClip(step, 2)[0].value, 4);
  assert.equal(sampleAnimationClip(step, 4)[0].value, 8);
  const smooth = valueClip('SMOOTH');
  assert.equal(sampleAnimationClip(smooth, 0.5)[0].value, 0.625);
  assert.equal(sampleAnimationClip(smooth, 1)[0].value, 2);
});

test('looping wraps exact endpoints and negative times', () => {
  const clip = valueClip('LINEAR', true);
  assert.equal(sampleAnimationClip(clip, 4)[0].value, 0);
  assert.equal(sampleAnimationClip(clip, 5)[0].value, 2);
  assert.equal(sampleAnimationClip(clip, -1)[0].value, 6);
});

test('quaternion keyframes normalize and interpolate the shortest arc', () => {
  const clip = createAnimationClip({ duration: 2, tracks: [{ target: 'part', property: 'rotation', keyframes: [{ time: 0, value: [0, 0, 0, 2] }, { time: 2, value: [0, 0, 0, -3] }] }] });
  const rotation = sampleAnimationClip(clip, 1)[0].value;
  assert.ok(Math.abs(Math.hypot(...rotation) - 1) < 1e-6);
  assert.ok(Math.abs(rotation[3]) > 0.999);
  const halfTurn = createAnimationClip({ duration: 2, tracks: [{ target: 'part', property: 'rotation', keyframes: [{ time: 0, value: [0, 0, 0, 1] }, { time: 2, value: [0, 1, 0, 0] }] }] });
  const midpoint = sampleAnimationClip(halfTurn, 1)[0].value;
  assert.ok(Math.abs(midpoint[1] - Math.SQRT1_2) < 1e-6);
});

test('bound animation preserves matrix identities and initial untracked transform components', () => {
  const matrix = mat4.fromRotationTranslationScale(mat4.create(), quat.fromEuler(quat.create(), 0, 35, 0), [1, 2, 3], [2, 3, 4]);
  const mesh = {};
  const part = { name: 'part', matrix, geometry: mesh, material: { emission: 0, roughness: 0.5 } };
  const initialBasis = Array.from(matrix.slice(0, 12));
  const clip = createAnimationClip({ duration: 2, tracks: [
    { target: 'part', property: 'translation', keyframes: [{ time: 0, value: [1, 2, 3] }, { time: 2, value: [5, 6, 7] }] },
    { target: 'part', property: 'emission', keyframes: [{ time: 0, value: 0 }, { time: 2, value: 2 }] },
  ] });
  const player = createAnimationPlayer(clip, [part]);
  player.apply(1);
  const midpoint = Array.from(matrix);
  player.apply(2);
  player.apply(1);
  assert.deepEqual(Array.from(matrix), midpoint);
  assert.equal(part.matrix, matrix);
  assert.equal(part.geometry, mesh);
  assert.equal(part.material.emission, 1);
  assert.deepEqual(Array.from(matrix.slice(12, 15)), [3, 4, 5]);
  const scale = mat4.getScaling(new Float32Array(3), matrix);
  assert.ok(scale.every((value, axis) => Math.abs(value - [2, 3, 4][axis]) < 1e-5));
  assert.ok(Array.from(matrix.slice(0, 12)).every((value, axis) => Math.abs(value - initialBasis[axis]) < 1e-5));
});

test('motion sampling keeps geometry and matrix identities and frames portrait around the same focal point', () => {
  const scene = createMotionScene();
  const matrices = scene.parts.map(part => part.matrix);
  const meshes = scene.parts.map(part => part.geometry);
  const portrait = scene.sample(6, 'portrait');
  const expected = scene.parts.map(part => Array.from(part.matrix));
  scene.sample(2);
  scene.sample(11);
  scene.sample(6);
  for (let index = 0; index < scene.parts.length; index++) {
    assert.equal(scene.parts[index].matrix, matrices[index]);
    assert.equal(scene.parts[index].geometry, meshes[index]);
    assert.deepEqual(Array.from(scene.parts[index].matrix), expected[index]);
    assert.ok(Array.from(scene.parts[index].matrix).every(Number.isFinite));
  }
  assert.equal(scene.sample(3.99).shot, 0);
  assert.equal(scene.sample(4).shot, 1);
  assert.equal(scene.sample(8).shot, 2);
  assert.deepEqual(portrait.camera.target, scene.sample(6).camera.target);
  assert.ok(Math.hypot(...portrait.camera.eye) > Math.hypot(...scene.sample(6).camera.eye));
  assert.equal(scene.duration, 12);
  assert.equal(new Set(meshes).size, 5);
});

test('invalid tracks, values and bindings fail explicitly', () => {
  const track = { target: 'part', property: 'translation', keyframes: [{ time: 0, value: [0, 0, 0] }] };
  assert.throws(() => createAnimationClip({ duration: 0 }), RangeError);
  assert.throws(() => createAnimationClip({ duration: 1, loop: 'yes' }), TypeError);
  assert.throws(() => createAnimationClip({ duration: 1, tracks: [{ ...track, interpolation: 'CUBIC' }] }), RangeError);
  assert.throws(() => createAnimationClip({ duration: 1, tracks: [{ ...track, property: 'unknown' }] }), RangeError);
  assert.throws(() => createAnimationClip({ duration: 1, tracks: [{ ...track, keyframes: [] }] }), RangeError);
  assert.throws(() => createAnimationClip({ duration: 1, tracks: [{ ...track, keyframes: [{ time: 0, value: [NaN, 0, 0] }] }] }), TypeError);
  assert.throws(() => createAnimationClip({ duration: 1, tracks: [track, track] }), RangeError);
  assert.throws(() => createAnimationClip({ duration: 1, tracks: [{ ...track, keyframes: [track.keyframes[0], track.keyframes[0]] }] }), RangeError);
  assert.throws(() => createAnimationClip({ duration: 1, tracks: [{ ...track, keyframes: [{ time: 2, value: [0, 0, 0] }] }] }), RangeError);
  assert.throws(() => createAnimationClip({ duration: 1, tracks: [{ ...track, property: 'rotation', keyframes: [{ time: 0, value: [0, 0, 0, 0] }] }] }), RangeError);
  assert.throws(() => createAnimationClip({ duration: 1, tracks: [{ ...track, property: 'scale', keyframes: [{ time: 0, value: [-1, 1, 1] }] }] }), RangeError);
  assert.throws(() => sampleAnimationClip(valueClip(), Infinity), TypeError);
  assert.throws(() => createAnimationPlayer(createAnimationClip({ duration: 1, tracks: [track] }), []), RangeError);
});

test('orbital showcase preserves speed across keyframe boundaries with fewer spline keys', () => {
  const scene = createMotionScene();
  const track = scene.clip.tracks.find(track => track.target === 'Orbit pod 0');
  assert.equal(track.keyframes.length, 25);
  const position = time => sampleAnimationClip(scene.clip, time).find(sample => sample.target === 'Orbit pod 0').value;
  const step = 1e-4;
  for (let time = 0.5; time < scene.duration; time += 0.5) {
    const before = position(time - step);
    const center = position(time);
    const after = position(time + step);
    for (let axis = 0; axis < 3; axis++) {
      const incomingSpeed = (center[axis] - before[axis]) / step;
      const outgoingSpeed = (after[axis] - center[axis]) / step;
      assert.ok(Math.abs(incomingSpeed - outgoingSpeed) < 0.001);
    }
  }
  const start = position(0);
  const end = position(scene.duration);
  for (let axis = 0; axis < 3; axis++) assertClose(start[axis], end[axis], 1e-12);
});

function splineTrack(property, startValue, endValue, outgoing, incoming, duration = 2, target = 'part') {
  const zero = typeof startValue === 'number' ? 0 : startValue.map(() => 0);
  return {
    target,
    property,
    interpolation: 'CUBICSPLINE',
    keyframes: [
      { time: 0, value: startValue, inTangent: zero, outTangent: outgoing },
      { time: duration, value: endValue, inTangent: incoming, outTangent: zero },
    ],
  };
}

function assertClose(actual, expected, tolerance = 1e-6) {
  assert.ok(Math.abs(actual - expected) < tolerance, `${actual} differs from ${expected}`);
}

test('CUBICSPLINE uses per-second tangents for scalar and vector Hermite curves', () => {
  const scalar = createAnimationClip({ duration: 2, tracks: [splineTrack('value', 0, 2, 4, 0)] });
  assert.equal(sampleAnimationClip(scalar, 0.5)[0].value, 1.4375);
  assert.equal(sampleAnimationClip(scalar, 1)[0].value, 2);
  assert.equal(sampleAnimationClip(scalar, 2)[0].value, 2);
  const vector = createAnimationClip({ duration: 2, tracks: [splineTrack('translation', [0, 2, -2], [2, 4, 2], [4, 0, -4], [0, 4, 0])] });
  assert.deepEqual(sampleAnimationClip(vector, 1)[0].value, [2, 2, -1]);
  const longer = createAnimationClip({ duration: 4, tracks: [splineTrack('value', 0, 2, 4, 0, 4)] });
  assert.equal(sampleAnimationClip(longer, 2)[0].value, 3);
});

test('spline quaternion components use Hermite tangents then normalize without a shortest-arc sign flip', () => {
  const clip = createAnimationClip({ duration: 2, tracks: [splineTrack('rotation', [0, 0, 0, 1], [0, 1, 0, 0], [0, 2, 0, 0], [0, 0, 0, 0])] });
  const midpoint = sampleAnimationClip(clip, 1)[0].value;
  assertClose(midpoint[1], 2 / Math.sqrt(5));
  assertClose(midpoint[3], 1 / Math.sqrt(5));
  assertClose(Math.hypot(...midpoint), 1);
  const signed = createAnimationClip({ duration: 2, tracks: [splineTrack('rotation', [0, 0, 0, 1], [0, -Math.SQRT1_2, 0, -Math.SQRT1_2], [0, 0, 0, 0], [0, 0, 0, 0])] });
  assert.ok(sampleAnimationClip(signed, 1)[0].value[1] < -0.9);
  const invalid = createAnimationClip({ duration: 2, tracks: [splineTrack('rotation', [0, 0, 0, 1], [0, 0, 0, -1], [0, 0, 0, 0], [0, 0, 0, 0])] });
  assert.throws(() => sampleAnimationClip(invalid, 1), /invalid quaternion/);
});

test('spline input values, tangents and sampled arrays remain isolated', () => {
  const track = splineTrack('translation', [0, 0, 0], [2, 2, 2], [4, 0, 0], [0, 0, 0]);
  track.keyframes[0].outTangent = new Float32Array(track.keyframes[0].outTangent);
  const clip = createAnimationClip({ duration: 2, tracks: [track] });
  track.keyframes[0].outTangent[0] = 100;
  track.keyframes[1].value[0] = 100;
  track.keyframes.reverse();
  const sampled = sampleAnimationClip(clip, 1)[0].value;
  assert.deepEqual(sampled, [2, 1, 1]);
  sampled[0] = 100;
  assert.deepEqual(sampleAnimationClip(clip, 1)[0].value, [2, 1, 1]);
  assert.ok(Object.isFrozen(clip.tracks[0].keyframes[0].outTangent));
  const restored = createAnimationClip(JSON.parse(JSON.stringify(clip)));
  assert.deepEqual(sampleAnimationClip(restored, 1), sampleAnimationClip(clip, 1));
});

test('malformed spline tangents and undersized spline tracks fail at compilation', () => {
  for (const property of ['value', 'translation', 'rotation']) {
    const value = property === 'value' ? 1 : property === 'rotation' ? [0, 0, 0, 1] : [0, 0, 0];
    const zero = typeof value === 'number' ? 0 : value.map(() => 0);
    for (const malformed of [undefined, null, NaN, Infinity, [0], [0, 0, NaN], [0, 0, 0, Infinity]]) {
      for (const tangentName of ['inTangent', 'outTangent']) {
        const track = splineTrack(property, value, value, zero, zero);
        track.keyframes[0][tangentName] = malformed;
        assert.throws(() => createAnimationClip({ duration: 2, tracks: [track] }), TypeError);
      }
    }
    const track = splineTrack(property, value, value, zero, zero);
    track.keyframes.pop();
    assert.throws(() => createAnimationClip({ duration: 2, tracks: [track] }), /at least two/);
  }
});

test('spline overshoot stays in positive scale and valid material domains', () => {
  const clip = createAnimationClip({ duration: 2, tracks: [
    splineTrack('scale', [1, 1, 1], [1, 1, 1], [-20, 0, 0], [0, 0, 0]),
    splineTrack('emission', 1, 1, -20, 0),
    splineTrack('metallic', 0.5, 0.5, 20, 0),
    splineTrack('roughness', 0.5, 0.5, -20, 0),
  ] });
  const sampled = sampleAnimationClip(clip, 1);
  assert.deepEqual(sampled.map(track => track.value), [[1e-8, 1, 1], 0, 1, 1e-8]);
  const part = { name: 'part', matrix: mat4.create(), material: {} };
  createAnimationPlayer(clip, [part]).apply(1);
  assert.ok(part.matrix[0] > 0);
  assert.equal(part.material.roughness, 1e-8);
  const upperRoughness = createAnimationClip({ duration: 2, tracks: [splineTrack('roughness', 0.5, 0.5, 20, 0)] });
  assert.equal(sampleAnimationClip(upperRoughness, 1)[0].value, 1);
  const lowerMetallic = createAnimationClip({ duration: 2, tracks: [splineTrack('metallic', 0.5, 0.5, -20, 0)] });
  assert.equal(sampleAnimationClip(lowerMetallic, 1)[0].value, 0);
});

test('compiled playback isolates shared materials and seeks deterministically with stable identities', () => {
  const shared = Object.freeze({ emission: 0, metallic: 0.5, roughness: 0.5, map: {} });
  const parts = ['first', 'second', 'untracked'].map(name => ({ name, matrix: mat4.create(), material: shared }));
  const clip = createAnimationClip({ duration: 2, loop: true, tracks: [
    splineTrack('translation', [0, 0, 0], [2, 4, 6], [4, 0, 0], [0, 0, 0], 2, 'first'),
    { ...splineTrack('emission', 0, 2, 4, 0), target: 'first' },
    { ...splineTrack('emission', 0, 4, 0, 0), target: 'second' },
  ] });
  const player = createAnimationPlayer(clip, parts);
  const matrices = parts.map(part => part.matrix);
  const materials = parts.map(part => part.material);
  assert.notEqual(materials[0], shared);
  assert.notEqual(materials[0], materials[1]);
  assert.equal(materials[2], shared);
  player.apply(0.5);
  const expected = Array.from(parts[0].matrix);
  const emission = parts[0].material.emission;
  for (const time of [1.9, -1, 2, 1, -3, 0.5]) player.apply(time);
  assert.deepEqual(Array.from(parts[0].matrix), expected);
  assert.equal(parts[0].material.emission, emission);
  assert.equal(shared.emission, 0);
  for (let index = 0; index < parts.length; index++) {
    assert.equal(parts[index].matrix, matrices[index]);
    assert.equal(parts[index].material, materials[index]);
    assert.equal(parts[index].material.map, shared.map);
  }
});

test('multiple players share an isolated target material without detaching earlier bindings', () => {
  const shared = Object.freeze({ emission: 0, roughness: 0.5 });
  const part = { name: 'part', matrix: mat4.create(), material: shared };
  const emission = createAnimationPlayer(createAnimationClip({ duration: 2, tracks: [{
    target: 'part', property: 'emission', keyframes: [{ time: 0, value: 0 }, { time: 2, value: 2 }],
  }] }), [part]);
  const material = part.material;
  const roughness = createAnimationPlayer(createAnimationClip({ duration: 2, tracks: [{
    target: 'part', property: 'roughness', keyframes: [{ time: 0, value: 0.5 }, { time: 2, value: 1 }],
  }] }), [part]);
  for (const time of [1, 2, 0, 1]) {
    emission.apply(time);
    roughness.apply(time);
    assert.equal(part.material, material);
    assert.equal(part.material.emission, time);
    assert.equal(part.material.roughness, 0.5 + time / 4);
  }
  assert.equal(shared.emission, 0);
  assert.equal(shared.roughness, 0.5);
});

test('apply reuses the same transform inputs and composed matrix buffers', () => {
  const clip = createAnimationClip({ duration: 2, tracks: [
    splineTrack('translation', [0, 0, 0], [2, 4, 6], [0, 0, 0], [0, 0, 0]),
    splineTrack('rotation', [0, 0, 0, 1], [0, 1, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]),
    splineTrack('scale', [1, 1, 1], [2, 2, 2], [0, 0, 0], [0, 0, 0]),
  ] });
  const part = { name: 'part', matrix: mat4.create(), material: {} };
  const player = createAnimationPlayer(clip, [part]);
  const originalCompose = mat4.fromRotationTranslationScale;
  let firstBuffers;
  let calls = 0;
  mat4.fromRotationTranslationScale = (output, rotation, translation, scale) => {
    if (!firstBuffers) firstBuffers = [output, rotation, translation, scale];
    else {
      assert.equal(output, firstBuffers[0]);
      assert.equal(rotation, firstBuffers[1]);
      assert.equal(translation, firstBuffers[2]);
      assert.equal(scale, firstBuffers[3]);
    }
    calls++;
    return originalCompose(output, rotation, translation, scale);
  };
  try {
    for (let frame = 0; frame < 100; frame++) player.apply((frame % 20) / 10);
  } finally {
    mat4.fromRotationTranslationScale = originalCompose;
  }
  assert.equal(calls, 100);
});

test('invalid sampled outputs leave all bound matrices and material properties unchanged', () => {
  const part = { name: 'part', matrix: mat4.create(), material: { emission: 0 } };
  const zeroRotation = createAnimationClip({ duration: 2, tracks: [
    splineTrack('translation', [0, 0, 0], [2, 0, 0], [0, 0, 0], [0, 0, 0]),
    splineTrack('emission', 0, 2, 0, 0),
    splineTrack('rotation', [0, 0, 0, 1], [0, 0, 0, -1], [0, 0, 0, 0], [0, 0, 0, 0]),
  ] });
  const player = createAnimationPlayer(zeroRotation, [part]);
  const expected = Array.from(part.matrix);
  assert.throws(() => player.apply(1), /invalid quaternion/);
  assert.deepEqual(Array.from(part.matrix), expected);
  assert.equal(part.material.emission, 0);
  player.apply(0);
  assert.deepEqual(Array.from(part.matrix), expected);
  assert.throws(() => player.apply(NaN), TypeError);
  const overflow = createAnimationClip({ duration: 100, tracks: [splineTrack('value', 0, 1, 1e308, 0, 100)] });
  assert.throws(() => sampleAnimationClip(overflow, 50), /finite/);
  const matrixOverflow = createAnimationClip({ duration: 2, tracks: [splineTrack('translation', [0, 0, 0], [1e100, 0, 0], [0, 0, 0], [0, 0, 0])] });
  const overflowPlayer = createAnimationPlayer(matrixOverflow, [part]);
  assert.throws(() => overflowPlayer.apply(1), /finite float range/);
  assert.deepEqual(Array.from(part.matrix), expected);
});

test('spline rotation playback matches public sampling for large finite tangent magnitudes', () => {
  const clip = createAnimationClip({ duration: 2, tracks: [splineTrack('rotation', [0, 0, 0, 1], [0, 1, 0, 0], [0, 1e100, 0, 0], [0, 0, 0, 0])] });
  const part = { name: 'part', matrix: mat4.create(), material: {} };
  const player = createAnimationPlayer(clip, [part]);
  for (const time of [0.5, 1.5, 1, 0, 2]) {
    const sampled = sampleAnimationClip(clip, time)[0].value;
    const expected = mat4.fromRotationTranslationScale(mat4.create(), sampled, [0, 0, 0], [1, 1, 1]);
    player.apply(time);
    assert.deepEqual(part.matrix, expected);
  }
  const invalid = splineTrack('rotation', [1e308, 1e308, 1e308, 1e308], [0, 0, 0, 1], [0, 0, 0, 0], [0, 0, 0, 0]);
  assert.throws(() => createAnimationClip({ duration: 2, tracks: [invalid] }), /finite nonzero/);
});
