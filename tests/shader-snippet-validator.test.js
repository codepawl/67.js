import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  SNIPPET_LIMITS, ShaderSnippetError, validateShaderSnippet, validateSnippetUniforms, snippetUniformDeclarations, mapShaderInfoLog,
} from '../src/shader-snippet-validator.js';
import { normalizeUserPasses, buildPassFragment, describeUserPasses, USER_PASS_INPUTS, USER_PASS_CAPABILITIES } from '../src/user-pass.js';
import { AGENT_SCENE_CAPABILITIES } from '../src/agent-scene-capabilities.js';
import { createAgentScene, loadAgentSceneModules } from '../src/agent-scene.js';

const ENTRY = 'vec4 userPass(vec2 uv) { return texture(sceneColor, uv); }';
const wrap = body => `vec4 userPass(vec2 uv) {\n${body}\n  return texture(sceneColor, uv);\n}`;

function rejects(source, pattern, position) {
  assert.throws(() => validateShaderSnippet(source, { label: 'Test' }), error => {
    assert.ok(error instanceof ShaderSnippetError, String(error));
    assert.match(error.message, pattern);
    assert.match(error.message, /Fix: /);
    assert.ok(error.hint.length > 0);
    if (position) assert.deepEqual([error.line, error.column], position);
    return true;
  });
}

test('the validator refuses each forbidden pattern and says where', () => {
  rejects(wrap('  #define X 1'), /Preprocessor lines \(#\)/, [2, 3]);
  rejects(wrap('  while (true) {}'), /"while" loops are not allowed/, [2, 3]);
  rejects(wrap('  do {} while (false);'), /"do" loops are not allowed/, [2, 3]);
  rejects(wrap('  for (int i = 0; i < 65; i++) {}'), /more than 64 iterations/, [2, 3]);
  rejects(wrap('  for (int i = 0; i < 8; i += 0) {}'), /more than 64 iterations/);
  rejects(wrap('  for (int i = 0; i < 8; i++) { i = 0; }'), /loop counter "i" is changed/);
  rejects(wrap('  for (int i = 0; i < n; i++) {}'), /integer literal/);
  rejects(wrap('  for (float f = 0.0; f < 8.0; f += 1.0) {}'), /declare one counter/);
  rejects(wrap('  for (int i = 0; i < 8; i++) x += 1.0;'), /inside \{ \}/);
  rejects(wrap('  float a = gl_FragDepth;'), /"gl_FragDepth" is not allowed/, [2, 13]);
  rejects(wrap('  vec4 p = gl_Position;'), /"gl_Position" is not allowed/);
  rejects(wrap('  float u67_x = 1.0;'), /starts with u67_/);
  rejects(wrap('  float y = u67_output.x;'), /starts with u67_/);
  rejects(`uniform float strength;\n${ENTRY}`, /"uniform" declarations are not allowed/, [1, 1]);
  rejects(`layout(location = 0) out vec4 c;\n${ENTRY}`, /"layout" declarations/);
  rejects(`${ENTRY}\n/* never closes`, /block comment never closes/, [2, 1]);
  rejects(`${ENTRY}\n// note \\\n`, /backslash/);
  rejects(`${ENTRY} é`, /not allowed/);
  rejects('x'.repeat(SNIPPET_LIMITS.maxBytes + 1), /limit is 4096/);
  rejects('   ', /empty/);
});

test('loops nest and call helpers within the work limit', () => {
  const nested = 'void f() {\n  for (int a = 0; a < 64; a++) {\n    for (int b = 0; b < 64; b++) {\n      for (int c = 0; c < 2; c++) {}\n    }\n  }\n}';
  rejects(nested, /can run 8192 loop iterations/);
  const viaHelper = 'float blur() { float s = 0.0; for (int a = 0; a < 64; a++) { s += 1.0; } return s; }\nvoid g() { for (int b = 0; b < 64; b++) { blur(); } }\nvoid h() { for (int c = 0; c < 2; c++) { g(); } }';
  rejects(viaHelper, /Function h can run 8192/);
  const fine = validateShaderSnippet('void f() { for (int a = 0; a < 64; a++) { for (int b = 8; b > 0; b -= 2) {} } }');
  assert.equal(fine.loopWork, 256);
});

test('comments are blanked and never hide a rule', () => {
  const checked = validateShaderSnippet(`// # while\n/* uniform */ ${ENTRY}`);
  assert.ok(!checked.source.includes('while'));
  assert.equal(checked.source.split('\n').length, 2);
  rejects(`/* ok */ ${wrap('  while (a) {}')}`, /"while"/);
});

test('an entry function can be required', () => {
  const requiredFunction = { pattern: /\bvec4\s+userPass\s*\(/, example: 'vec4 userPass(vec2 uv)' };
  assert.throws(() => validateShaderSnippet('float x = 1.0;', { requiredFunction }), /entry function is missing.*Define vec4 userPass/);
});

test('uniforms: names, types, values and counts', () => {
  const options = { label: 'Pass', reservedNames: USER_PASS_INPUTS };
  const checked = validateSnippetUniforms({ amount: 0.5, tint: [1, 0, 0.5], level: { type: 'int', value: 3 }, offset: { type: 'vec2', value: [1, 2] } }, options);
  assert.deepEqual(checked.tint, { type: 'vec3', value: [1, 0, 0.5] });
  assert.equal(checked.level.type, 'int');
  assert.equal(snippetUniformDeclarations(checked), 'uniform float amount;\nuniform int level;\nuniform vec2 offset;\nuniform vec3 tint;');
  for (const [uniforms, pattern] of [
    [{ Bad: 1 }, /must match/], [{ '1a': 1 }, /must match/], [{ a_b: 1 }, /must match/], [{ ['x'.repeat(33)]: 1 }, /must match/],
    [{ float: 1 }, /keyword/], [{ time: 1 }, /keyword or an input/], [{ sceneColor: 1 }, /keyword or an input/],
    [{ a: Infinity }, /finite number/], [{ a: NaN }, /finite number/], [{ a: '1' }, /type must be one of/], [{ a: [1] }, /type must be one of/],
    [{ a: [1, 2, 3, 4, 5] }, /type must be one of/], [{ a: [1, NaN] }, /finite number/], [{ a: { type: 'int', value: 1.5 } }, /whole number/],
    [{ a: { type: 'mat4', value: [] } }, /type must be one of/], [{ a: { type: 'vec3', value: [1, 2] } }, /array of 3/],
    [{ a: { type: 'float', value: 1, extra: 1 } }, /Unknown/], [{ a: 1e39 }, /finite number/],
    [Object.fromEntries(Array.from({ length: 17 }, (_, index) => [`u${index}`, 1])), /limit is 16/],
  ]) {
    assert.throws(() => validateSnippetUniforms(uniforms, options), pattern, JSON.stringify(uniforms).slice(0, 60));
  }
  assert.deepEqual(validateSnippetUniforms(undefined), {});
});

test('info log lines map to the snippet', () => {
  const pass = normalizeUserPasses([{ name: 'broken', fragment: wrap('  vec3 v = 1.0;'), uniforms: { amount: 1 } }])[0];
  const built = buildPassFragment(pass);
  const absolute = built.headerLines + 2;
  const mapped = mapShaderInfoLog(`ERROR: 0:${absolute}: '=' : cannot convert from 'const float' to 'vec3'\nERROR: 0:3: 'x' : engine\n`, built);
  assert.match(mapped, /ERROR: snippet line 2: '=' : cannot convert/);
  assert.match(mapped, /\| vec3 v = 1\.0;/);
  assert.match(mapped, /ERROR: engine wrapper line 3: 'x' : engine/);
  assert.equal(built.source.split('\n')[built.headerLines].startsWith('vec4 userPass'), true);
  assert.ok(built.source.includes('uniform float amount;'));
});

test('the documented limits match the validator', () => {
  const { limits } = USER_PASS_CAPABILITIES;
  assert.deepEqual({ ...limits }, { maxPasses: 4, maxBytes: 4096, maxUniforms: 16, maxLoopIterations: 64, maxLoopWork: 4096 });
  assert.match(USER_PASS_CAPABILITIES.rules, /64 iterations at most, loop work under 4096/);
  assert.equal(limits.maxBytes, SNIPPET_LIMITS.maxBytes);
  assert.equal(limits.maxUniforms, SNIPPET_LIMITS.maxUniforms);
  assert.equal(limits.maxLoopIterations, SNIPPET_LIMITS.maxLoopIterations);
  assert.equal(limits.maxLoopWork, SNIPPET_LIMITS.maxLoopWork);
  assert.ok(AGENT_SCENE_CAPABILITIES.operations.includes('set-post-passes'));
});

test('passes: count, names, fields, scale and the entry function', () => {
  const pass = (overrides = {}) => ({ name: 'one', fragment: ENTRY, ...overrides });
  assert.equal(normalizeUserPasses([pass()])[0].scale, 1);
  assert.throws(() => normalizeUserPasses(Array.from({ length: 5 }, (_, index) => pass({ name: `p${index}` }))), /limit is 4/);
  assert.throws(() => normalizeUserPasses([pass(), pass()]), /used twice/);
  assert.throws(() => normalizeUserPasses([pass({ name: 'Bad Name' })]), /name must match/);
  assert.throws(() => normalizeUserPasses([pass({ scale: 0 })]), /scale must be between/);
  assert.throws(() => normalizeUserPasses([pass({ scale: 2 })]), /scale must be between/);
  assert.throws(() => normalizeUserPasses([pass({ shader: 'x' })]), /Unknown postPasses\[0\] field: shader/);
  assert.throws(() => normalizeUserPasses([pass({ fragment: 'float x = 1.0;' })]), /Define vec4 userPass/);
  assert.throws(() => normalizeUserPasses('x'), /must be an array/);
  assert.deepEqual(describeUserPasses(normalizeUserPasses([pass({ uniforms: { amount: 1 } })])), [{ name: 'one', scale: 1, uniforms: ['amount:float'], fragmentBytes: ENTRY.length }]);
});

test('the documented example passes the validator and builds a scene', async () => {
  // A Windows checkout may turn the doc's line endings into CRLF.
  const documentation = readFileSync(new URL('../docs/user-passes.md', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
  const recipeText = documentation.match(/```json\n(\{"postPasses".*)\n```/)[1];
  const { postPasses } = JSON.parse(recipeText);
  const [pass] = normalizeUserPasses(postPasses);
  assert.equal(pass.scale, 0.25);
  const glsl = documentation.match(/```glsl\n([\s\S]*?)\n```/)[1];
  assert.equal(glsl, postPasses[0].fragment);
  const recipe = { format: '67js.scene', schemaVersion: 1, geometries: [], materials: [], nodes: [], postPasses };
  await loadAgentSceneModules(recipe);
  const scene = createAgentScene(recipe);
  assert.equal(scene.postPasses[0].name, 'pixel-dither');
  assert.equal(scene.inspect().postPasses[0].uniforms.join(), 'levels:float,spread:float');
  scene.apply([{ type: 'set-post-passes', postPasses: null }], { expectedRevision: scene.revision });
  assert.deepEqual(scene.postPasses, []);
  assert.equal(scene.inspect().postPasses, undefined);
  scene.apply([{ type: 'set-post-passes', postPasses }], { expectedRevision: scene.revision });
  assert.equal(scene.postPasses.length, 1);
  assert.throws(() => scene.apply([{ type: 'set-post-passes', postPasses: [{ ...postPasses[0], fragment: '#define A 1\n' + postPasses[0].fragment }] }], { expectedRevision: scene.revision }), /Preprocessor lines/);
  assert.equal(scene.postPasses.length, 1);
  assert.throws(() => scene.apply([{ type: 'set-post-passes' }], { expectedRevision: scene.revision }), /postPasses: got undefined; expected a postPasses value, or null to clear it/);
  assert.deepEqual(scene.exportRecipe().postPasses, scene.postPasses);
});
