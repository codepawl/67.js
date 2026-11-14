import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMaterialSnippet, probeMaterialSnippets, MATERIAL_SNIPPET_CAPABILITIES } from '../src/material-snippet.js';
import { createFragmentShader, createVertexShader, createDepthVertexShader, withDepthCode, depthFragmentShader } from '../src/shaders.js';
import { groupParts } from '../src/renderer.js';
import { createAgentScene, loadAgentSceneModules } from '../src/agent-scene.js';

const DISSOLVE = `float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
void materialHook(inout vec3 color, inout float alpha, vec2 uv, vec3 worldPosition) {
  if (hash(floor(worldPosition.xz * 8.0)) < threshold) discard;
  color *= tint;
}`;
const dissolve = (overrides = {}) => ({ fragment: DISSOLVE, uniforms: { threshold: 0.4, tint: [1, 0.8, 0.6] }, ...overrides });

function refuses(snippet, pattern, options) {
  assert.throws(() => normalizeMaterialSnippet(snippet, options), error => {
    assert.match(error.message, pattern);
    assert.match(error.message, /Fix: /);
    return true;
  });
}

test('a valid snippet is normalized, frozen and registered as a shader feature', () => {
  const snippet = normalizeMaterialSnippet(dissolve());
  assert.match(snippet.feature, /^s[0-9a-f]{8}$/);
  assert.deepEqual(snippet.uniforms, { threshold: { type: 'float', value: 0.4 }, tint: { type: 'vec3', value: [1, 0.8, 0.6] } });
  assert.ok(Object.isFrozen(snippet));
  assert.equal(normalizeMaterialSnippet(dissolve()).feature, snippet.feature);
  assert.notEqual(normalizeMaterialSnippet(dissolve({ fragment: `${DISSOLVE}\n` })).feature, snippet.feature);
});

test('the snippet follows the part 1 validation rules and names a fix', () => {
  refuses(dissolve({ fragment: `#define X 1\n${DISSOLVE}` }), /line 1, column 1.*Preprocessor/s);
  refuses(dissolve({ fragment: DISSOLVE.replace('discard;', 'discard; while (true) { }') }), /"while" loops are not allowed/);
  refuses(dissolve({ fragment: DISSOLVE.replace('threshold', 'gl_Position') }), /gl_/);
  refuses(dissolve({ fragment: DISSOLVE.replace('color *= tint', 'color *= u67_secret') }), /u67_/);
  refuses(dissolve({ fragment: 'void materialHook(inout vec3 color) { }' }), /entry function is missing.*materialHook/s);
  refuses(dissolve({ uniforms: { materialHook: 1 } }), /keyword or an input the engine provides/);
  refuses(dissolve({ uniforms: { threshold: Infinity } }), /finite/);
  refuses(dissolve({ uniforms: Object.fromEntries(Array.from({ length: 17 }, (_, index) => [`value${index}`, 1])) }), /17 uniforms; the limit is 16/);
  refuses(dissolve({ fragment: 'x'.repeat(5000) }), /4096|bytes/i);
  assert.throws(() => normalizeMaterialSnippet({ ...dissolve(), extra: 1 }), /Unknown snippet field: extra\. Allowed fields: fragment, uniforms, mask/);
});

test('mask reads the material map and needs one', () => {
  const masked = { fragment: 'void materialHook(inout vec3 color, inout float alpha, vec2 uv, vec3 worldPosition) { if (texture(snippetMask, uv).r < 0.5) discard; }', mask: 'map' };
  refuses(masked, /mask needs a map/, { hasMap: false });
  refuses({ ...masked, mask: 'remote.png' }, /mask must be "map"/, { hasMap: true });
  refuses({ fragment: masked.fragment }, /uses snippetMask without a mask/, { hasMap: true });
  assert.equal(normalizeMaterialSnippet(masked, { hasMap: true }).mask, 'map');
});

test('the main shader runs the hook before the render-pass output, with prefixed names', () => {
  const snippet = normalizeMaterialSnippet(dissolve());
  const source = createFragmentShader(['studioLighting', snippet.feature]);
  const prefix = `u67_${snippet.feature}`;
  assert.match(source, new RegExp(`uniform float ${prefix};`));
  assert.match(source, new RegExp(`uniform float ${prefix}_threshold;`));
  assert.match(source, new RegExp(`float ${prefix}_hash\\(vec2 p\\)`));
  assert.match(source, new RegExp(`void ${prefix}_materialHook\\(inout vec3 color`));
  const call = source.indexOf(`${prefix}_materialHook(color, textureAlpha, textureUV, worldPosition)`);
  assert.ok(call > 0);
  assert.ok(call < source.indexOf('float alpha = surfaceAlpha(textureAlpha)'), 'before the cutoff, so alpha can cut');
  assert.ok(call < source.indexOf('if (USES_RENDER_PASS)'), 'before the ID pass output');
  assert.doesNotMatch(createFragmentShader(['studioLighting']), /u67_s[0-9a-f]{8}/);
});

test('two materials with the same helper names share one shader without clashing', () => {
  const first = normalizeMaterialSnippet(dissolve());
  const second = normalizeMaterialSnippet(dissolve({ uniforms: { threshold: 0.4, tint: [1, 1, 1], extra: 2 } }));
  assert.notEqual(first.feature, second.feature);
  const source = createFragmentShader(['studioLighting', first.feature, second.feature]);
  assert.match(source, new RegExp(`float u67_${first.feature}_hash`));
  assert.match(source, new RegExp(`float u67_${second.feature}_hash`));
});

test('the shadow shaders run the same hook so a discarded fragment casts no shadow', () => {
  const snippet = normalizeMaterialSnippet(dissolve());
  const features = new Set(['studioLighting', snippet.feature]);
  const vertex = createDepthVertexShader(features);
  assert.match(vertex, /out vec3 snippetWorld;/);
  assert.match(vertex, /snippetWorld = world\.xyz;/);
  const fragment = withDepthCode(depthFragmentShader, features);
  assert.match(fragment, /in vec3 snippetWorld;/);
  assert.match(fragment, new RegExp(`u67_${snippet.feature}_materialHook\\(hookColor, hookAlpha, textureUV, snippetWorld\\)`));
  assert.ok(fragment.indexOf('materialHook(hookColor') < fragment.indexOf('if (alphaMasked < 0.5) return;'), 'the hook runs for opaque casters too');
  assert.match(fragment, /float alpha = materialOpacity \* hookAlpha;/);
  const other = normalizeMaterialSnippet(dissolve({ uniforms: { threshold: 0.1, tint: [1, 1, 1], extra: 2 } }));
  const both = withDepthCode(depthFragmentShader, new Set([snippet.feature, other.feature]));
  assert.equal(both.split('in vec3 snippetWorld;').length, 2, 'declared once');
  assert.equal(both.split('(hookColor, hookAlpha').length, 3, 'one call per snippet');
  assert.equal(withDepthCode(depthFragmentShader, new Set(['studioLighting'])), depthFragmentShader);
  assert.equal(createDepthVertexShader(['studioLighting']), createDepthVertexShader([]));
});

test('materials with different snippets land in different batches, and a stored snippet normalizes again', async () => {
  const snippet = normalizeMaterialSnippet(dissolve());
  const recipe = {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'box', type: 'box' }],
    materials: [{ id: 'hooked', snippet: dissolve() }, { id: 'plain' }],
    nodes: ['a', 'b', 'c'].map((id, index) => ({ id, geometry: 'box', material: id === 'b' ? 'plain' : 'hooked', translation: [index * 2, 0, 0] })),
  };
  await loadAgentSceneModules(recipe);
  const batches = groupParts(createAgentScene(recipe).parts);
  assert.deepEqual(batches.map(batch => batch.map(entry => entry.name)), [['a', 'c'], ['b']]);
  assert.equal(normalizeMaterialSnippet(JSON.parse(JSON.stringify(snippet))).feature, snippet.feature);
  assert.equal(normalizeMaterialSnippet(structuredClone(snippet)).feature, snippet.feature);
});

test('probing a snippet maps the driver log to snippet lines and names the parts', () => {
  const snippet = normalizeMaterialSnippet({ fragment: 'void materialHook(inout vec3 color, inout float alpha, vec2 uv, vec3 worldPosition) {\n  vec3 wrong = 1.0;\n}' });
  const header = 6;
  const context = {
    FRAGMENT_SHADER: 1, COMPILE_STATUS: 2,
    createShader: () => ({}), shaderSource() {}, compileShader() {}, deleteShader() {},
    getShaderParameter: () => false,
    getShaderInfoLog: () => `ERROR: 0:${header + 2}: '=' : cannot convert from 'const float' to 'highp 3-component vector of float'`,
    getExtension: () => null,
  };
  const parts = [{ name: 'wall', material: { snippet } }, { name: 'floor', material: {} }];
  assert.throws(() => probeMaterialSnippets(parts, () => context), error => {
    assert.match(error.message, /Material snippet \(used by wall\) failed to compile as GLSL ES 3\.00/);
    assert.match(error.message, /snippet line 2: '=' : cannot convert/);
    assert.match(error.message, /vec3 wrong = 1\.0;/);
    return true;
  });
  assert.doesNotThrow(() => probeMaterialSnippets([{ name: 'floor', material: {} }], () => { throw new Error('no context needed'); }));
});

test('a recipe sets, edits and clears the snippet and scene_capabilities reports the limits', async () => {
  const recipe = {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'box', type: 'box' }],
    materials: [{ id: 'stone', color: [0.5, 0.5, 0.5], snippet: dissolve() }, { id: 'plain', color: [0.2, 0.2, 0.2] }],
    nodes: [{ id: 'a', geometry: 'box', material: 'stone' }, { id: 'b', geometry: 'box', material: 'plain', translation: [2, 0, 0] }],
  };
  await loadAgentSceneModules(recipe);
  const scene = createAgentScene(recipe);
  const hooked = scene.parts.find(part => part.name === 'a').material;
  assert.match(hooked.snippet.feature, /^s[0-9a-f]{8}$/);
  assert.equal(scene.parts.find(part => part.name === 'b').material.snippet, undefined);
  scene.apply([{ type: 'set-material', id: 'stone', snippet: dissolve({ uniforms: { threshold: 0.7, tint: [1, 1, 1] } }) }], { expectedRevision: scene.revision });
  assert.equal(scene.parts.find(part => part.name === 'a').material.snippet.uniforms.threshold.value, 0.7);
  assert.throws(() => scene.apply([{ type: 'set-material', id: 'stone', snippet: dissolve({ fragment: '#define A 1\n' + DISSOLVE }) }], { expectedRevision: scene.revision }), /Preprocessor lines/);
  assert.equal(scene.parts.find(part => part.name === 'a').material.snippet.uniforms.threshold.value, 0.7, 'a refused edit changes nothing');
  scene.apply([{ type: 'set-material', id: 'stone', snippet: null }], { expectedRevision: scene.revision });
  assert.equal(scene.parts.find(part => part.name === 'a').material.snippet, undefined);
  assert.equal(MATERIAL_SNIPPET_CAPABILITIES.limits.maxUniforms, 16);
});
