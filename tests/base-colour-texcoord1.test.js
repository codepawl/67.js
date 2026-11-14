import test from 'node:test';
import assert from 'node:assert/strict';
import '../src/material-layer-shaders.js';
import { CrucibleRenderer } from '../src/renderer.js';
import { createDepthFragmentShader, createDepthVertexShader, createFragmentShader } from '../src/shaders.js';

const LAYER_TEXTURE_FEATURES = ['clearcoatTexture', 'clearcoatRoughnessTexture', 'clearcoatNormalTexture', 'sheenColorTexture', 'sheenRoughnessTexture', 'anisotropyTexture'];

test('the colour shader samples the base colour map through the map flag', () => {
  const source = createFragmentShader(['baseMap']);
  assert.match(source, /texture\(baseMap, mapUV\(hasBaseMap\)\)/);
  assert.doesNotMatch(source, /texture\(baseMap, textureUV\)/);
});

test('the depth alpha pass reads the second UV set when the base colour map does', () => {
  const vertex = createDepthVertexShader([]);
  const fragment = createDepthFragmentShader([]);
  assert.match(vertex, /out vec2 lightmapUV;/);
  assert.match(vertex, /lightmapUV = uvSets\.zw;/);
  assert.match(fragment, /in vec2 lightmapUV;/);
  assert.match(fragment, /texture\(baseMap, mapUV\(hasBaseMap\)\)\.a/);
  assert.doesNotMatch(fragment, /texture\(baseMap, textureUV\)/);
});

test('the tinted shadow pass samples the base colour map through the map flag', () => {
  const fragment = createDepthFragmentShader(['tintedShadows']);
  assert.match(fragment, /texture\(baseMap, mapUV\(hasBaseMap\)\)/);
  assert.doesNotMatch(fragment, /texture\(baseMap, textureUV\)/);
});

test('every layer map samples through its own flag', () => {
  const source = createFragmentShader(['baseMap', ...LAYER_TEXTURE_FEATURES]);
  for (const name of LAYER_TEXTURE_FEATURES) {
    assert.doesNotMatch(source, new RegExp(`texture\\(${name}, textureUV\\)`), `${name} still reads textureUV`);
    assert.ok(source.includes(`mapUV(${name}On)`), `${name} is not sampled through its flag`);
  }
});

test('the shadow alpha pass binds the map flag as 2 for a base colour map on the second UV set', () => {
  const renderer = Object.create(CrucibleRenderer.prototype);
  renderer.depthAlphaUniforms = { alphaMasked: 'masked', alphaCutoff: 'cutoff', materialOpacity: 'opacity', hasBaseMap: 'hasBaseMap' };
  renderer.uniforms = {};
  const flags = [];
  renderer.context = {
    CULL_FACE: 2884, TEXTURE0: 33984, TEXTURE_2D: 3553,
    enable() {}, disable() {}, activeTexture() {}, bindTexture() {},
    uniform1f(name, value) { if (name === 'hasBaseMap') flags.push(value); },
  };
  const batch = { doubleSided: true, alphaMode: 'mask', alphaCutoff: 0.5, opacity: 1, textures: [{}] };
  renderer.applyAlphaState({ ...batch, mapState: [{ uvChannel: 1 }] }, false);
  renderer.applyAlphaState({ ...batch, mapState: [{ uvChannel: 0 }] }, false);
  renderer.applyAlphaState({ ...batch, mapState: [null] }, false);
  assert.deepEqual(flags, [2, 1, 0]);
});
