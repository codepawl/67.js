import assert from 'node:assert/strict';
import test from 'node:test';
import { createFragmentShader, fragmentShader } from '../src/shaders.js';
import { createPostFragment } from '../src/post.js';
import '../src/fog-shader.js';

test('the sun shadow is one hardware comparison fetch for each filter tap', () => {
  assert.match(fragmentShader, /uniform highp sampler2DShadow shadowMap;/);
  assert.match(createFragmentShader([]), /uniform highp sampler2DShadow shadowMap;/);
  assert.equal(fragmentShader.includes('texelFetch(shadowMap'), false);
  assert.equal(fragmentShader.split('texture(shadowMap').length - 1, 1);
});

test('the fog volume reads the same shadow texture through a comparison sampler', () => {
  const post = createPostFragment(['volume']);
  assert.match(post, /uniform highp sampler2DShadow volumeShadowMap;/);
  assert.match(post, /texture\(volumeShadowMap, vec3\(/);
});
