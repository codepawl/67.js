import assert from 'node:assert/strict';
import test from 'node:test';
import { createAnimationClip, sampleAnimationClip } from '../src/animation.js';
import { compileAgentMotion, normalizeAgentMotion } from '../src/agent-motion.js';
import { valueNoise } from '../src/animation-modifiers.js';

const rampKeyframes = [{ time: 1, value: 0 }, { time: 3, value: 4 }];

function sampler(extra, keyframes = rampKeyframes, loop = false) {
  const clip = createAnimationClip({ duration: 4, loop, tracks: [{ target: 'part', property: 'value', keyframes, ...extra }] });
  return time => sampleAnimationClip(clip, time)[0].value;
}

test('extrapolation constant holds ends and linear continues the end slopes', () => {
  const constant = sampler({ extrapolation: 'constant' });
  assert.equal(constant(-5), 0);
  assert.equal(constant(10), 4);
  const linear = sampler({ extrapolation: 'linear' });
  assert.equal(linear(0), -2);
  assert.equal(linear(5), 8);
  assert.equal(linear(2), 2);
  const single = sampler({ extrapolation: 'linear' }, [{ time: 1, value: 3 }]);
  assert.equal(single(9), 3);
  const vector = createAnimationClip({ duration: 2, tracks: [{ target: 'part', property: 'translation', extrapolation: 'linear', keyframes: [{ time: 0, value: [0, 1, 2] }, { time: 1, value: [1, 1, 0] }] }] });
  assert.deepEqual(sampleAnimationClip(vector, 3)[0].value, [3, 1, -4]);
});

test('cycles repeat, offset and mirror before and after the keys, with finite counts', () => {
  const repeat = sampler({ modifiers: [{ type: 'cycles' }] });
  assert.equal(repeat(4), 2);
  assert.equal(repeat(7), 0);
  assert.equal(repeat(-0.5), 1);
  const offset = sampler({ modifiers: [{ type: 'cycles', before: 'offset', after: 'offset' }] });
  assert.equal(offset(4), 6);
  assert.equal(offset(6), 10);
  assert.equal(offset(0), -2);
  assert.equal(offset(-1), -4);
  const mirror = sampler({ modifiers: [{ type: 'cycles', before: 'mirror', after: 'mirror' }] });
  assert.equal(mirror(3.5), 3);
  assert.equal(mirror(5), 0);
  assert.equal(mirror(7), 4);
  const counted = sampler({ modifiers: [{ type: 'cycles', after: 'offset', afterCount: 1 }] });
  assert.equal(counted(4), 6);
  assert.equal(counted(4.5), 7);
  assert.equal(counted(5.9), 8);
  assert.equal(counted(50), 8);
  const none = sampler({ modifiers: [{ type: 'cycles', before: 'none', after: 'none' }] });
  assert.equal(none(10), 4);
});

test('cycles keep going past the clip duration', () => {
  const value = sampler({ modifiers: [{ type: 'cycles', after: 'offset' }] });
  assert.equal(value(11), 20);
});

test('stepped holds the curve for each step', () => {
  const stepped = sampler({ modifiers: [{ type: 'stepped', step: 0.5 }] });
  assert.equal(stepped(1.9), 1);
  assert.equal(stepped(2.49), 2);
  assert.equal(stepped(2.5), 3);
  const shifted = sampler({ modifiers: [{ type: 'stepped', step: 1, offset: 0.25 }] });
  assert.equal(shifted(2.2), 0.5);
});

test('generator replaces or adds a polynomial of time', () => {
  const replace = sampler({ modifiers: [{ type: 'generator', coefficients: [1, 2, 3] }] });
  assert.equal(replace(2), 1 + 2 * 2 + 3 * 4);
  const additive = sampler({ modifiers: [{ type: 'generator', coefficients: [10, 0, 1], additive: true }] });
  assert.equal(additive(2), 2 + 10 + 4);
});

test('limits clamp and envelope remaps a value range over time', () => {
  const limits = sampler({ modifiers: [{ type: 'limits', min: 1, max: 3 }] });
  assert.equal(limits(0), 1);
  assert.equal(limits(2), 2);
  assert.equal(limits(3), 3);
  const wave = [{ time: 0, value: -1 }, { time: 4, value: 1 }];
  const envelope = sampler({ modifiers: [{ type: 'envelope', points: [{ time: 0, min: 0, max: 2 }, { time: 4, min: -2, max: 6 }] }] }, wave);
  assert.equal(envelope(0), 0);
  assert.equal(envelope(4), 6);
  assert.equal(envelope(2), 1.5);
});

test('noise is seeded, bounded, smooth and independent of the order of seeks', () => {
  const noisy = sampler({ modifiers: [{ type: 'noise', scale: 0.25, strength: 0.5, seed: 7 }] });
  const forward = [0, 0.1, 0.37, 1, 2.2, 3, 3.9].map(noisy);
  const backward = [3.9, 3, 2.2, 1, 0.37, 0.1, 0].map(noisy).reverse();
  assert.deepEqual(forward, backward);
  const plain = sampler({});
  for (const time of [0.1, 1.5, 2.2, 3.5]) assert.ok(Math.abs(noisy(time) - plain(time)) <= 0.5);
  const reseeded = sampler({ modifiers: [{ type: 'noise', scale: 0.25, strength: 0.5, seed: 8 }] });
  assert.notEqual(noisy(2.2), reseeded(2.2));
  assert.equal(valueNoise(3, 1), valueNoise(3, 1));
  const step = Math.abs(valueNoise(1.001, 5) - valueNoise(1, 5));
  assert.ok(step < 0.01);
  assert.equal(noisy(2.2), sampler({ modifiers: [{ type: 'noise', scale: 0.25, strength: 0.5, seed: 7 }] })(2.2));
});

test('noise differs per axis and a pinned sample stays byte stable', () => {
  const clip = createAnimationClip({ duration: 1, tracks: [{ target: 'part', property: 'translation', modifiers: [{ type: 'noise', scale: 0.1, strength: 1, seed: 3 }], keyframes: [{ time: 0, value: [0, 0, 0] }] }] });
  const [x, y, z] = sampleAnimationClip(clip, 0.33)[0].value;
  assert.notEqual(x, y);
  assert.notEqual(y, z);
  assert.deepEqual(sampleAnimationClip(clip, 0.33)[0].value, [x, y, z]);
});

test('modifiers run time steps first, then value steps, and compose with extrapolation', () => {
  const composed = sampler({ extrapolation: 'linear', modifiers: [{ type: 'limits', max: 6 }, { type: 'stepped', step: 1 }] });
  assert.equal(composed(5.9), 6);
  assert.equal(composed(5.4), 6);
  assert.equal(composed(3.9), 4);
});

test('rotation tracks take only repeat or mirror cycles and stepped', () => {
  const rotation = { target: 'part', property: 'rotation', keyframes: [{ time: 0, value: [0, 0, 0, 1] }, { time: 1, value: [0, 1, 0, 1] }] };
  const clip = createAnimationClip({ duration: 1, tracks: [{ ...rotation, modifiers: [{ type: 'cycles', after: 'mirror' }] }] });
  const first = sampleAnimationClip(clip, 0.25)[0].value;
  const mirrored = sampleAnimationClip(clip, 1.75)[0].value;
  first.forEach((component, index) => assert.ok(Math.abs(component - mirrored[index]) < 1e-12));
  assert.throws(() => createAnimationClip({ duration: 1, tracks: [{ ...rotation, extrapolation: 'linear' }] }), /Rotation tracks cannot extrapolate/);
  assert.throws(() => createAnimationClip({ duration: 1, tracks: [{ ...rotation, modifiers: [{ type: 'noise' }] }] }), /only cycles and stepped/);
  assert.throws(() => createAnimationClip({ duration: 1, tracks: [{ ...rotation, modifiers: [{ type: 'cycles', after: 'offset' }] }] }), /does not apply to rotation/);
});

test('invalid modifiers name the field and an accepted example', () => {
  const bad = modifiers => () => sampler({ modifiers });
  assert.throws(bad([{ type: 'wiggle' }]), /Unknown modifier type wiggle/);
  assert.throws(bad([{ type: 'noise', scale: 0 }]), /noise scale/);
  assert.throws(bad([{ type: 'noise', speed: 1 }]), /no field speed/);
  assert.throws(bad([{ type: 'stepped', step: 0 }]), /stepped step/);
  assert.throws(bad([{ type: 'limits' }]), /min, max or both/);
  assert.throws(bad([{ type: 'limits', min: 2, max: 1 }]), /must not exceed/);
  assert.throws(bad([{ type: 'generator', coefficients: [] }]), /coefficients/);
  assert.throws(bad([{ type: 'envelope', points: [] }]), /envelope points/);
  assert.throws(bad([{ type: 'cycles', after: 'spin' }]), /cycles after/);
  assert.throws(() => sampler({ extrapolation: 'cubic' }), /constant or linear/);
});

const recipe = { nodes: [{ id: 'cube' }], camera: { eye: [0, 0, 5], target: [0, 0, 0], up: [0, 1, 0], fov: 45, near: 0.1, far: 100 } };

test('recipe motion tracks keep modifiers, sample them at the same times in every sampler and seek backwards', () => {
  const input = {
    duration: 2,
    tracks: [
      { kind: 'node', id: 'cube', property: 'translation', extrapolation: 'linear',
        modifiers: [{ type: 'noise', scale: 0.2, strength: 0.1, seed: 4 }],
        keyframes: [{ time: 0, value: [0, 0, 0] }, { time: 1, value: [1, 0, 0] }] },
      { kind: 'camera', property: 'eye', modifiers: [{ type: 'cycles', after: 'offset' }],
        keyframes: [{ time: 0, value: [0, 0, 5] }, { time: 1, value: [1, 0, 5] }] },
    ],
  };
  const normalized = normalizeAgentMotion(input, recipe);
  assert.equal(normalized.tracks[0].extrapolation, 'linear');
  assert.deepEqual(normalized.tracks[0].modifiers[0], { type: 'noise', scale: 0.2, strength: 0.1, phase: 0, seed: 4 });
  assert.deepEqual(normalizeAgentMotion(normalized, recipe), normalized);
  const compiled = compileAgentMotion(input, recipe);
  const read = time => {
    const output = compiled.sample(time);
    return { cube: Array.from(output.nodes.get('cube').translation), eye: Array.from(output.camera.eye) };
  };
  const forward = [0.3, 1.5, 2.5].map(read);
  const backward = [2.5, 1.5, 0.3].map(read).reverse();
  assert.deepEqual(forward, backward);
  assert.ok(Math.abs(forward[1].cube[0] - 1.5) <= 0.1);
  assert.ok(Math.abs(forward[2].eye[0] - 2.5) < 1e-6);
});
