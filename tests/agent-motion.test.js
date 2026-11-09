import test from 'node:test';
import assert from 'node:assert/strict';
import { constants, setPriority } from 'node:os';
import { normalizeAgentMotion, compileAgentMotion } from '../src/agent-motion.js';

setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL);
const recipe = {
  nodes: [{ id: 'hinge' }, { id: 'child', parent: 'hinge' }],
  materials: [{ id: 'bulb', tag: 'surface', color: [0.2, 0.3, 0.4], roughness: 0, metallic: 0, emission: 0 }],
  camera: { eye: [1, 0, 0], target: [0, 0, 0], up: [0, 1, 0], fov: 45, near: 0.1, far: 100 },
};
const track = (property, start, end, extra = {}) => ({ kind: 'material', id: 'bulb', property,
  keyframes: [{ time: 0, value: start }, { time: 1, value: end }], ...extra });
const motion = tracks => ({ duration: 1, tracks });
function snapshot(output) {
  function copiedPatches(patches) {
    return [...patches].map(([id, patch]) => {
      const fields = Object.entries(patch).map(([key, value]) => [key, typeof value === 'number' ? value : [...value]]);
      return [id, Object.fromEntries(fields)];
    });
  }
  return {
    nodes: copiedPatches(output.nodes),
    materials: copiedPatches(output.materials),
    camera: output.camera && {
      ...output.camera,
      eye: [...output.camera.eye],
      target: [...output.camera.target],
      up: [...output.camera.up],
    },
  };
}

test('normalization preserves public targets, sorts copied keys and normalizes quaternion values', () => {
  const input = motion([{ kind: 'node', id: 'hinge', property: 'rotation', keyframes: [{ time: 1, value: [0, 0, 2, 0] }, { time: 0, value: [0, 0, 0, 2] }] }]);
  const normalized = normalizeAgentMotion(input, recipe);
  assert.deepEqual(normalized.tracks[0].keyframes[0], { time: 0, value: [0, 0, 0, 1] });
  assert.equal(normalized.tracks[0].property, 'rotation');
  assert.equal(normalized.tracks[0].id, 'hinge');
  assert.equal(normalized.loop, false);
  input.tracks[0].keyframes[0].value[2] = 10;
  assert.deepEqual(normalized.tracks[0].keyframes[1].value, [0, 0, 1, 0]);
  assert.equal(normalizeAgentMotion(null, recipe), null);
  assert.equal(compileAgentMotion(undefined, recipe), null);
});

test('all four curves use core interpolation and material roughness retains authored zero', () => {
  for (const [interpolation, expected] of [['LINEAR', 0.25], ['STEP', 0], ['SMOOTH', 0.15625], ['CUBICSPLINE', 0.34375]]) {
    const channel = track('roughness', 0, 1, { interpolation });
    if (interpolation === 'CUBICSPLINE') {
      for (const keyframe of channel.keyframes) {
        Object.assign(keyframe, { inTangent: 2, outTangent: 2 });
      }
    }
    const sampler = compileAgentMotion(motion([channel]), recipe);
    assert.equal(sampler.sample(0).materials.get('bulb').roughness, 0);
    assert.equal(sampler.sample(0.25).materials.get('bulb').roughness, expected);
    assert.equal(sampler.sample(1).materials.get('bulb').roughness, 1);
  }
});

test('retained vectors, typed camera output and arbitrary seeks are deterministic', () => {
  const input = motion([
    { kind: 'node', id: 'hinge', property: 'translation', keyframes: [{ time: 0, value: [0, 0, 0] }, { time: 1, value: [2, 1, 0] }] },
    track('color', [0, 0, 0], [1, 0.5, 0.25]),
    track('emissiveColor', [0, 0, 0], [2, 3, 4]),
    { kind: 'camera', property: 'eye', keyframes: [{ time: 0, value: [1, 0, 0] }, { time: 1, value: [1, 1, 1] }] },
    { kind: 'camera', property: 'roll', keyframes: [{ time: 0, value: 0 }, { time: 1, value: 0.5 }] },
  ]);
  const sampler = compileAgentMotion(input, recipe);
  const output = sampler.sample(0.75);
  const expected = snapshot(output);
  const translation = output.nodes.get('hinge').translation;
  const color = output.materials.get('bulb').color;
  const eye = output.camera.eye;
  assert.ok(translation instanceof Float64Array);
  assert.ok(eye instanceof Float32Array);
  for (const time of [1, 0, 0.25, 0.75]) {
    assert.equal(sampler.sample(time), output);
  }
  assert.deepEqual(snapshot(output), expected);
  assert.equal(output.nodes.get('hinge').translation, translation);
  assert.equal(output.materials.get('bulb').color, color);
  assert.equal(output.camera.eye, eye);
  assert.deepEqual(recipe.materials[0].color, [0.2, 0.3, 0.4]);
});

test('loop modulo and nonloop clamping agree across channels, with bounded absolute time', () => {
  const input = motion([track('emission', 0, 1)]);
  const clamped = compileAgentMotion(input, recipe);
  assert.equal(clamped.sample(3600).materials.get('bulb').emission, 1);
  const looping = compileAgentMotion({ ...input, loop: true }, recipe);
  assert.equal(looping.sample(1).materials.get('bulb').emission, 0);
  assert.equal(looping.sample(2.25).materials.get('bulb').emission, 0.25);
  for (const time of [-1, 3601, NaN, Infinity]) {
    assert.throws(() => looping.sample(time));
  }
});

test('camera-only motion compiles an empty ordinary clip and retains the static camera lens', () => {
  const sampler = compileAgentMotion(motion([{ kind: 'camera', property: 'target', keyframes: [
    { time: 0, value: [0, 0, 0] }, { time: 1, value: [0, 0, 1] },
  ] }]), recipe);
  const output = sampler.sample(0.5);
  assert.equal(output.nodes.size, 0);
  assert.equal(output.materials.size, 0);
  assert.deepEqual([...output.camera.target], [0, 0, 0.5]);
  assert.equal(output.camera.near, 0.1);
  assert.equal(output.camera.far, 100);
  assert.equal(output.camera.fov, 45);
});

test('strict schema, final references, duplicate tracks and allocation bounds reject invalid authoring', () => {
  assert.throws(() => normalizeAgentMotion(motion([]), recipe), /at least one/);
  assert.throws(() => normalizeAgentMotion({ ...motion([]), unknown: true }, recipe), /field/);
  assert.throws(() => normalizeAgentMotion(motion([{ ...track('emission', 0, 1), id: 'missing' }]), recipe), /motion\.tracks\[0\]\.id: got "missing"; expected the ID of a material in this recipe/);
  assert.throws(() => normalizeAgentMotion(motion([track('emission', 0, 1), track('emission', 0, 1)]), recipe), /repeats an earlier track/);
  assert.throws(() => normalizeAgentMotion(motion([{ kind: 'camera', id: 'camera', property: 'fov', keyframes: [{ time: 0, value: 45 }] }]), recipe), /motion\.tracks\[0\]\.id: got "camera"; expected a field left out, since camera tracks have no ID/);
  assert.throws(() => normalizeAgentMotion(motion([{ ...track('emission', 0, 1), keyframes: [{ time: 0, value: 0, outTangent: 1 }] }]), recipe), /keyframes\[0\]\.outTangent: got 1; expected a field left out unless the track interpolation is CUBICSPLINE/);
  assert.throws(() => normalizeAgentMotion(motion([{ ...track('emission', 0, 1), interpolation: 'CUBICSPLINE' }]), recipe), /tangent/i);
  assert.throws(() => normalizeAgentMotion(motion(Array(129)), recipe), /bounded/);
  const tooManyKeys = Array.from({ length: 65 }, (_, index) => ({ time: index / 64, value: 0 }));
  assert.throws(() => normalizeAgentMotion(motion([{ ...track('emission', 0, 1), keyframes: tooManyKeys }]), recipe), /bounded/);
  const manyNodes = Array.from({ length: 33 }, (_, index) => ({ id: `node-${index}` }));
  const manyTracks = manyNodes.map(node => ({
    kind: 'node', id: node.id, property: 'translation',
    keyframes: Array.from({ length: 64 }, (_, index) => ({ time: index / 63, value: [0, 0, 0] })),
  }));
  assert.throws(() => normalizeAgentMotion(motion(manyTracks), { ...recipe, nodes: manyNodes }), /2048/);
  assert.throws(() => normalizeAgentMotion({ ...motion([]), duration: 31 }, recipe), /duration/);
  assert.throws(() => normalizeAgentMotion(motion([{ ...track('emission', 0, 1), keyframes: [{ time: 0, value: 0 }, { time: 0, value: 1 }] }]), recipe), /distinct/);
});

test('invalid cubic scale and material overshoot throw without clamping or partial publication', () => {
  for (const channel of [
    { kind: 'node', id: 'hinge', property: 'scale', keyframes: [
      { time: 0, value: [1, 1, 1], inTangent: [0, 0, 0], outTangent: [-10, 0, 0] },
      { time: 1, value: [1, 1, 1], inTangent: [10, 0, 0], outTangent: [0, 0, 0] },
    ] },
    { ...track('color', [0.5, 0.5, 0.5], [0.5, 0.5, 0.5]), keyframes: [
      { time: 0, value: [0.5, 0.5, 0.5], inTangent: [0, 0, 0], outTangent: [-10, 0, 0] },
      { time: 1, value: [0.5, 0.5, 0.5], inTangent: [10, 0, 0], outTangent: [0, 0, 0] },
    ] },
  ]) {
    const sampler = compileAgentMotion(motion([track('emission', 0, 1), { ...channel, interpolation: 'CUBICSPLINE' }]), recipe);
    const output = sampler.sample(0);
    const before = snapshot(output);
    assert.throws(() => sampler.sample(0.5), /positive numbers|numbers of 0 or more/);
    assert.deepEqual(snapshot(output), before);
    sampler.sample(1);
    sampler.sample(0);
    assert.deepEqual(snapshot(output), before);
  }
});

test('radiance overflow, camera midpose collisions and cubic lens overshoot preserve the previous sample', () => {
  const inputs = [
    motion([track('emission', 0, 1e20), track('emissiveColor', [1e20, 1e20, 1e20], [1e20, 1e20, 1e20])]),
    motion([track('emission', 0, 1), { kind: 'camera', property: 'eye', keyframes: [{ time: 0, value: [1, 0, 0] }, { time: 1, value: [-1, 0, 0] }] }]),
    motion([track('emission', 0, 1), { kind: 'camera', property: 'fov', interpolation: 'CUBICSPLINE', keyframes: [
      { time: 0, value: 45, inTangent: 0, outTangent: 1000 },
      { time: 1, value: 45, inTangent: -1000, outTangent: 0 },
    ] }]),
  ];
  for (const input of inputs) {
    const sampler = compileAgentMotion(input, recipe);
    const output = sampler.sample(0);
    const before = snapshot(output);
    assert.throws(() => sampler.sample(0.5), /materials\.[^.]+\.emission: got|distinct|field of view/);
    assert.deepEqual(snapshot(output), before);
  }
});

test('unlit radiance uses the authored base color when emissiveColor is absent', () => {
  const unlitRecipe = { ...recipe, materials: [{ ...recipe.materials[0], tag: 'unlit', color: [1, 0.5, 0] }] };
  const sampler = compileAgentMotion(motion([track('emission', 0, 200000)]), unlitRecipe);
  const output = sampler.sample(0);
  const before = snapshot(output);
  assert.throws(() => sampler.sample(0.5), /unlit emissiveColor times emission/);
  assert.deepEqual(snapshot(output), before);
  assert.equal(sampler.sample(0.25).materials.get('bulb').emission, 50000);
});
