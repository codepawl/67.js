import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveVolumeFog, validateFogField } from '../src/volumetric.js';
import { createLightingState, updateLightingState } from '../src/lighting.js';
import { FOG_LIGHT_LIMIT, createFogLightBuffers, packFogLights, FogFieldTexture } from '../src/fog-field.js';
import { createPostFragment, POST_STEPS } from '../src/post.js';

function fieldOf(width, height) {
  return { width, height, data: new Float32Array(width * height * 4).fill(1) };
}

test('a volume fog without field, flow or profile resolves to the same keys as before', () => {
  const resolved = resolveVolumeFog({ density: 0.1 });
  for (const key of ['field', 'flowStrength', 'flowPeriod', 'profile']) assert.equal(Object.hasOwn(resolved, key), false, key);
});

test('a fog field is kept by reference with its flow knobs and profile', () => {
  const field = fieldOf(4, 3);
  const resolved = resolveVolumeFog({ density: 0.1, field, flowStrength: 0.5, flowPeriod: 3, profile: 'smoothstep' });
  assert.equal(resolved.field, field);
  assert.equal(resolved.flowStrength, 0.5);
  assert.equal(resolved.flowPeriod, 3);
  assert.equal(resolved.profile, 'smoothstep');
});

test('fog field validation names the problem', () => {
  assert.throws(() => validateFogField(null), /object/);
  assert.throws(() => validateFogField({ width: 0, height: 2, data: new Float32Array(0) }), /width/);
  assert.throws(() => validateFogField({ width: 2, height: 2.5, data: new Float32Array(10) }), /height/);
  assert.throws(() => validateFogField({ width: 2, height: 2, data: [1, 2, 3] }), /Float32Array/);
  assert.throws(() => validateFogField({ width: 2, height: 2, data: new Float32Array(15) }), /16 values, got 15/);
  const withNaN = fieldOf(2, 2);
  withNaN.data[5] = NaN;
  assert.throws(() => validateFogField(withNaN), /finite/);
  assert.throws(() => resolveVolumeFog({ flowStrength: -1 }), RangeError);
  assert.throws(() => resolveVolumeFog({ flowPeriod: 0 }), RangeError);
  assert.throws(() => resolveVolumeFog({ profile: 'linear' }), /exponential, smoothstep/);
});

test('the post program has the field and light steps only when asked, and the default program has neither', () => {
  assert.equal(POST_STEPS.includes('field'), false);
  assert.equal(POST_STEPS.includes('lights'), false);
  const defaultSource = createPostFragment();
  assert.match(defaultSource, /#define POST_FIELD false/);
  assert.match(defaultSource, /#define POST_LIGHTS false/);
  const fogSource = createPostFragment([...POST_STEPS, 'field', 'lights']);
  assert.match(fogSource, /#define POST_FIELD \(true\)/);
  assert.match(fogSource, /#define POST_LIGHTS \(volumeLightCount > 0\)/);
});

test('fog lights take points then spots, premultiplied by intensity, up to the limit', () => {
  const lighting = createLightingState();
  const pointLights = Array.from({ length: 6 }, (_, index) => ({ position: [index, 1, 0], color: [1, 0.5, 0.25], intensity: 4, range: 5 }));
  const spotLights = Array.from({ length: 4 }, () => ({ position: [0, 3, 0], direction: [0, -1, 0], color: [1, 1, 1], intensity: 2, range: 8, angle: 0.5 }));
  updateLightingState(lighting, { pointLights, spotLights });
  const buffers = createFogLightBuffers();
  assert.equal(packFogLights(lighting, buffers), FOG_LIGHT_LIMIT);
  assert.deepEqual(Array.from(buffers.colors.subarray(0, 3)), [4, 2, 1]);
  assert.equal(buffers.positions[3], 5);
  assert.equal(buffers.cones[1], 0, 'a point light has no cone');
  assert.equal(buffers.cones[6 * 4 + 1], 1, 'the seventh light is the first spot');
  assert.ok(buffers.colors[3] >= 0.1, 'the radius has a floor');
  updateLightingState(lighting, {});
  assert.equal(packFogLights(lighting, buffers), 0);
});

test('the field texture allocates once per size and writes into it afterwards', () => {
  const calls = [];
  const context = new Proxy({ TEXTURE_2D: 1, RGBA: 2, FLOAT: 3, RGBA16F: 4, createTexture: () => ({}), deleteTexture: () => calls.push('delete') }, {
    get: (target, name) => target[name] ?? ((...args) => { calls.push(String(name)); return args; }),
  });
  const texture = new FogFieldTexture(context);
  texture.upload(fieldOf(8, 8));
  texture.upload(fieldOf(8, 8));
  texture.upload(fieldOf(4, 4));
  assert.deepEqual(calls.filter(name => name.startsWith('tex') && name.endsWith('2D')), ['texImage2D', 'texSubImage2D', 'texImage2D']);
  texture.dispose();
  assert.equal(calls.at(-1), 'delete');
});
