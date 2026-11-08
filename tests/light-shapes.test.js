import test from 'node:test';
import assert from 'node:assert/strict';
import { IES_PROFILE_NAMES, parseIesPhotometry, profileGain, profileSamples, resolveIesProfile } from '../src/light-shapes.js';
import { createLightingState, updateLightingState, NO_SHADOW_TILE } from '../src/lighting.js';
import { effectiveShadowCascades } from '../src/cascaded-shadows.js';
import { normalizeAgentLook } from '../src/agent-look.js';
import { loadAgentSceneModules } from '../src/agent-scene-modules.js';
import { buildTraceScene, SUN_ANGULAR_RADIUS } from '../src/path-tracer-scene.js';
import { box } from '../src/geometry.js';

const areaLight = { position: [0, 3, 0], direction: [0, -1, 0], width: 1, height: 1 };

test('a bundled profile is 1 on the axis and falls to the plane of the lamp', () => {
  for (const name of IES_PROFILE_NAMES) assert.equal(profileSamples(name)[0], 1, name);
  const narrow = profileSamples('narrow-spot');
  assert.ok(narrow[8] < 0.05, 'a narrow spot has almost nothing at 48 degrees');
  assert.equal(profileGain(narrow, 1), 1);
  assert.equal(profileGain(narrow, -0.2), 0);
  assert.ok(profileSamples('batwing')[5] > 0.95, 'a batwing peaks near 30 to 60 degrees');
});

test('an inline profile is checked and normalized to its axis value', () => {
  const samples = profileSamples(resolveIesProfile({ angles: [0, 90], candela: [200, 100] }));
  assert.equal(samples[0], 1);
  assert.ok(Math.abs(samples[15] - 0.5) < 1e-6);
  assert.throws(() => resolveIesProfile('floodlight'), /must be one of/);
  assert.throws(() => resolveIesProfile({ angles: [0, 0], candela: [1, 1] }), /strictly rising/);
  assert.throws(() => resolveIesProfile({ angles: [0, 45], candela: [0, 0] }), /above zero/);
});

test('an IES file averages its horizontal planes and applies the multiplier', () => {
  const text = ['IESNA:LM-63-2002', '[TEST] sample', 'TILT=NONE', '1 1000 2 3 2 1 2 0 0 0', '1 1 100', '0 45 90', '0 90', '100 80 0', '300 120 0'].join('\n');
  const profile = parseIesPhotometry(text);
  assert.deepEqual(profile.angles, [0, 45, 90]);
  assert.deepEqual(profile.candela, [400, 200, 0]);
  assert.throws(() => parseIesPhotometry('TILT=INCLUDE\n1'), /not supported/);
});

test('an area light that casts a shadow takes one tile after the spot lights, and the default takes none', () => {
  const plain = updateLightingState(createLightingState(), { areaLights: [areaLight] });
  assert.equal(plain.shadowCasters.length, 0);
  assert.equal(plain.areaShadowCount, 0);
  assert.equal(plain.areaPositions[3], NO_SHADOW_TILE);
  const shadowed = updateLightingState(createLightingState(), {
    spotLights: [{ position: [0, 2, 0], direction: [0, -1, 0], castShadow: true }],
    areaLights: [areaLight, { ...areaLight, castShadow: true }],
  });
  assert.equal(shadowed.shadowCasters.length, 2);
  assert.equal(shadowed.areaShadowCount, 1);
  assert.equal(shadowed.areaPositions[3], NO_SHADOW_TILE);
  assert.equal(shadowed.areaPositions[7], 1);
  assert.throws(() => updateLightingState(createLightingState(), { pointLights: Array.from({ length: 5 }, () => ({ position: [0, 1, 0], castShadow: true })) }), /atlas/);
});

test('a lamp with an ies profile is counted so the renderer compiles the profile code', () => {
  const state = updateLightingState(createLightingState(), { spotLights: [{ position: [0, 2, 0], direction: [0, -1, 0], ies: 'downlight' }], areaLights: [areaLight] });
  assert.equal(state.profileCount, 1);
  assert.equal(updateLightingState(createLightingState(), {}).profileCount, 0);
});

test('a named sun angle gives the sun at least one cascade, and an explicit count wins', () => {
  assert.equal(effectiveShadowCascades({}, { extent: 3.5 }), 0);
  assert.equal(effectiveShadowCascades({ sunAngularRadius: 0.02 }, { extent: 3.5 }), 1);
  assert.equal(effectiveShadowCascades({ sunAngularRadius: 0.02 }, { extent: 60 }), 3);
  assert.equal(effectiveShadowCascades({ sunAngularRadius: 0.02, shadowCascades: 0 }, { extent: 3.5 }), 0);
});

test('a recipe look carries the sun angle, area shadows and profiles, and refuses bad values', async () => {
  await loadAgentSceneModules({ environment: { sunAngularRadius: 0.01, areaLights: [{}], spotLights: [{ ies: 'x' }] } });
  const { environment } = normalizeAgentLook({ environment: {
    sunAngularRadius: 0.02,
    areaLights: [{ ...areaLight, castShadow: true, ies: 'batwing' }],
    spotLights: [{ position: [0, 2, 0], direction: [0, -1, 0], ies: { angles: [0, 60], candela: [10, 5] } }],
  } });
  assert.equal(environment.sunAngularRadius, 0.02);
  assert.equal(environment.areaLights[0].castShadow, true);
  assert.equal(environment.areaLights[0].ies, 'batwing');
  assert.deepEqual(environment.spotLights[0].ies, { angles: [0, 60], candela: [10, 5] });
  assert.throws(() => normalizeAgentLook({ environment: { sunAngularRadius: 1 } }), /sunAngularRadius/);
  assert.throws(() => normalizeAgentLook({ environment: { areaLights: [{ ...areaLight, ies: 'nope' }] } }), /ies/);
  assert.equal(Object.hasOwn(normalizeAgentLook().environment, 'sunAngularRadius'), false);
});

test('the path tracer reads the same sun disk and profile samples as the raster', () => {
  const parts = [{ geometry: box(0, 1), matrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]), material: { color: [1, 1, 1] } }];
  const lit = buildTraceScene(parts, { keyColor: [1, 1, 1], spotLights: [{ position: [0, 2, 0], direction: [0, -1, 0], angle: 0.5, intensity: 1, ies: 'downlight' }] });
  assert.equal(lit.lights.sun.angularRadius, SUN_ANGULAR_RADIUS);
  assert.deepEqual(lit.lights.spots[0].profile, Array.from(profileSamples('downlight')));
  const soft = buildTraceScene(parts, { keyColor: [1, 1, 1], sunAngularRadius: 0.05, areaLights: [areaLight] });
  assert.equal(soft.lights.sun.angularRadius, 0.05);
  assert.equal(soft.lights.areas[0].profile, null);
});
