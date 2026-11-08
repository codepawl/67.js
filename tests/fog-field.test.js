import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveVolumeFog, validateFogField } from '../src/volumetric.js';
import { createLightingState, updateLightingState } from '../src/lighting.js';
import { normalizeAgentLook } from '../src/agent-look.js';
import { resolveFogDetail, fogUsesDetail, FOG_LIGHT_LIMIT, createFogLightBuffers, packFogLights, FogFieldTexture } from '../src/fog-field.js';
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

const DETAIL_FIELDS = ['detailOctaves', 'detailAmount', 'warp', 'contrast', 'profileSoftness', 'keyScattering'];

test('a fog without detail controls resolves to the default detail and needs no detail step', () => {
  const resolved = resolveVolumeFog({ density: 0.1 });
  for (const key of DETAIL_FIELDS) assert.equal(Object.hasOwn(resolved, key), false, key);
  assert.deepEqual(resolveFogDetail(resolved), { detailOctaves: 1, detailAmount: 0.5, warp: 0, contrast: 1, profileSoftness: 0.5, keyScattering: 1, scatterOctaves: 1, multiScatter: 0.5, multiExtinction: 0.5, multiAnisotropy: 0.5, keyTransmittance: 0, surfaceTransmittance: 0 });
  assert.equal(fogUsesDetail(resolved), false);
  assert.equal(fogUsesDetail(resolveVolumeFog({ density: 0.1, detailOctaves: 1, warp: 0, contrast: 1, profileSoftness: 0.2, keyScattering: 3 })), false, 'profile and key scattering are plain uniforms');
});

test('detail controls are kept, bounded and typed when the fog addon resolves them', () => {
  const resolved = resolveVolumeFog({ detailOctaves: 3, detailAmount: 0.6, warp: 0.8, contrast: 1.6, profileSoftness: 0.1, keyScattering: 2 });
  assert.deepEqual(DETAIL_FIELDS.map(key => resolveFogDetail(resolved)[key]), [3, 0.6, 0.8, 1.6, 0.1, 2]);
  assert.equal(fogUsesDetail(resolved), true);
  for (const bounds of [{ detailOctaves: 4 }, { detailOctaves: 0 }, { detailAmount: 1.1 }, { warp: -1 }, { warp: 5 }, { contrast: 4.5 }, { profileSoftness: 1 }, { keyScattering: 11 }, { keyScattering: -1 }]) {
    assert.throws(() => resolveFogDetail(resolveVolumeFog(bounds)), RangeError, JSON.stringify(bounds));
  }
  assert.throws(() => resolveFogDetail(resolveVolumeFog({ detailOctaves: 2.5 })), /integer/);
  for (const field of DETAIL_FIELDS) {
    for (const bad of ['1', null, NaN, Infinity]) assert.throws(() => resolveFogDetail(resolveVolumeFog({ [field]: bad })), /must be between/, `${field} ${bad}`);
  }
});

test('the recipe look accepts the detail controls and rejects a non-number', () => {
  const look = normalizeAgentLook({ environment: { volumeFog: { density: 0.5, detailOctaves: 2, detailAmount: 0.4, warp: 1, contrast: 1.2, profileSoftness: 0.3, keyScattering: 1.5 } } });
  assert.equal(look.environment.volumeFog.detailOctaves, 2);
  assert.equal(look.environment.volumeFog.keyScattering, 1.5);
  assert.throws(() => normalizeAgentLook({ environment: { volumeFog: { warp: 'wide' } } }));
});

test('the detail step is compiled in only on request', () => {
  assert.equal(POST_STEPS.includes('detail'), false);
  assert.match(createPostFragment(), /#define POST_DETAIL false/);
  assert.match(createPostFragment([...POST_STEPS, 'detail']), /#define POST_DETAIL \(true\)/);
});
