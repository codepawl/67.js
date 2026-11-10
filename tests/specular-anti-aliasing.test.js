import test from 'node:test';
import assert from 'node:assert/strict';
import { createLightingState, updateLightingState, DEFAULT_SPECULAR_ANTI_ALIASING, MAXIMUM_SPECULAR_ANTI_ALIASING } from '../src/lighting.js';
import { normalizeAgentLook } from '../src/agent-look.js';

test('specular anti-aliasing is on by default and a lighting update sets or clears it', () => {
  const state = createLightingState();
  assert.equal(state.specularAntiAliasing, DEFAULT_SPECULAR_ANTI_ALIASING);
  updateLightingState(state, { specularAntiAliasing: 2.5 });
  assert.equal(state.specularAntiAliasing, 2.5);
  updateLightingState(state, { specularAntiAliasing: 0 });
  assert.equal(state.specularAntiAliasing, 0);
  updateLightingState(state, {});
  assert.equal(state.specularAntiAliasing, DEFAULT_SPECULAR_ANTI_ALIASING);
});

test('specular anti-aliasing outside zero to the maximum is refused', () => {
  const state = createLightingState();
  for (const value of [-0.1, MAXIMUM_SPECULAR_ANTI_ALIASING + 0.1, Infinity, NaN]) {
    assert.throws(() => updateLightingState(state, { specularAntiAliasing: value }), /Specular anti-aliasing/);
  }
});

test('a look keeps specularAntiAliasing only when it is set, and bounds it', () => {
  assert.equal('specularAntiAliasing' in normalizeAgentLook({ environment: {} }).environment, false);
  assert.equal(normalizeAgentLook({ environment: { specularAntiAliasing: 0 } }).environment.specularAntiAliasing, 0);
  assert.equal(normalizeAgentLook({ environment: { specularAntiAliasing: 3 } }).environment.specularAntiAliasing, 3);
  for (const specularAntiAliasing of [-1, 5, 'high', null]) {
    assert.throws(() => normalizeAgentLook({ environment: { specularAntiAliasing } }), /specularAntiAliasing/);
  }
});
