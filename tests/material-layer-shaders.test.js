import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const SHADERS_PATH = new URL('../src/shaders.js', import.meta.url);
const RENDERER_PATH = new URL('../src/renderer.js', import.meta.url);

test('the core shader sources carry no anisotropy or iridescence code', () => {
  for (const path of [SHADERS_PATH, RENDERER_PATH]) {
    const source = readFileSync(path, 'utf8');
    assert.doesNotMatch(source, /anisotropicSpecular|filmReflectance|setAnisotropyFrame/, `${path.pathname} holds layer GLSL`);
  }
});

test('the static graph of the core shaders does not reach the layer shader module', () => {
  for (const path of [SHADERS_PATH, RENDERER_PATH]) {
    assert.doesNotMatch(readFileSync(path, 'utf8'), /(from|import\() *'\.\/material-layer-shaders/);
  }
});

test('a layer without registered code fails with the import to add', async () => {
  const { createFragmentShader, fragmentShader } = await import('../src/shaders.js?without-layer-code');
  assert.doesNotMatch(fragmentShader, /anisotropicSpecular|filmReflectance/);
  assert.throws(() => createFragmentShader(['anisotropy']), /anisotropy feature needs its shader code.*addons\/material-layer-shaders/);
  assert.throws(() => createFragmentShader(['iridescence']), /iridescence feature needs its shader code.*addons\/material-layer-shaders/);
  assert.doesNotThrow(() => createFragmentShader(['floor']));
});

test('importing the layer shader module registers the code for the shader that asked for it', async () => {
  await import('../src/material-layer-shaders.js');
  const { createFragmentShader } = await import('../src/shaders.js');
  const shader = createFragmentShader(['anisotropy', 'iridescence']);
  assert.match(shader, /float anisotropicSpecular\(/);
  assert.match(shader, /vec3 filmReflectance\(/);
  assert.doesNotMatch(createFragmentShader(['anisotropy']), /filmReflectance/);
  assert.doesNotMatch(createFragmentShader(['iridescence']), /anisotropicSpecular/);
});

test('the normal map transform is applied only when its feature is on', async () => {
  await import('../src/material-layer-shaders.js');
  const { createFragmentShader } = await import('../src/shaders.js');
  const plain = createFragmentShader(['normalMap']);
  const transformed = createFragmentShader(['normalMap', 'normalMapTransform']);
  assert.match(transformed, /texture\(normalMap, normalCoordinates \* normalMapTransform\.xy \+ normalMapTransform\.zw\)/);
  assert.match(plain, /texture\(normalMap, normalCoordinates\)/);
  assert.doesNotMatch(plain, /normalMapTransform/);
});
