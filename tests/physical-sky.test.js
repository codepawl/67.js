import './support/load-agent-scene-modules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentScene } from '../src/agent-scene.js';
import { agentSceneModulesNeeded } from '../src/agent-scene-modules.js';
import { agentEnvironmentMap, normalizeAgentLook } from '../src/agent-look.js';

function skyEnvironment(sky, extra = {}) {
  return normalizeAgentLook({ environment: { sky: { type: 'physical', ...sky }, ...extra } }).environment;
}

test('a recipe without a sky keeps the default look and loads no sky code', () => {
  const environment = normalizeAgentLook({}).environment;
  assert.equal(environment.sky, undefined);
  assert.equal(environment.fogDensity, null);
  assert.deepEqual(environment.lightDirection, [-3, 6, 4]);
  assert.ok(!agentSceneModulesNeeded({ environment: { setup: 'sunset' } }).includes('physicalSky'));
  assert.ok(agentSceneModulesNeeded({ environment: { sky: { type: 'physical' } } }).includes('physicalSky'));
});

test('the key light follows the sun elevation and rotation', () => {
  const noon = skyEnvironment({ sunElevation: 60, sunRotation: 0 });
  assert.ok(Math.abs(noon.lightDirection[1] - Math.sin(Math.PI / 3)) < 1e-9);
  assert.ok(noon.lightDirection[2] < 0);
  const east = skyEnvironment({ sunElevation: 0, sunRotation: 90 });
  assert.ok(Math.abs(east.lightDirection[0] - 1) < 1e-9);
});

test('the sun reddens and dims toward the horizon and sets below it', () => {
  const keyAt = elevation => skyEnvironment({ sunElevation: elevation }).keyColor;
  const [high, low, grazing, below] = [60, 15, 2, -5].map(keyAt);
  const redOverBlue = color => color[0] / Math.max(color[2], 1e-6);
  assert.ok(redOverBlue(low) > redOverBlue(high));
  assert.ok(redOverBlue(grazing) > redOverBlue(low));
  assert.ok(high[1] > low[1] && low[1] > grazing[1]);
  assert.deepEqual(below, [0, 0, 0]);
});

test('turbidity thickens the haze and aerial perspective scales it', () => {
  const clear = skyEnvironment({ turbidity: 1 });
  const hazy = skyEnvironment({ turbidity: 8 });
  assert.ok(hazy.fogDensity > clear.fogDensity);
  assert.ok(hazy.keyColor[2] < clear.keyColor[2]);
  assert.equal(skyEnvironment({ aerialPerspective: 0 }).fogDensity, 0);
  assert.ok(skyEnvironment({ aerialPerspective: 2 }).fogDensity > skyEnvironment({ aerialPerspective: 1 }).fogDensity);
  for (const component of [...hazy.fogColor, ...hazy.skyTop, ...hazy.skyBottom]) {
    assert.ok(component >= 0 && component <= 1);
  }
});

test('the sky map is deterministic, finite, cached and follows the ground albedo', () => {
  const environment = skyEnvironment({ sunElevation: 30 });
  const map = agentEnvironmentMap(environment);
  assert.equal(map.kind, 'environment-map');
  assert.ok(map.data.every(Number.isFinite));
  assert.equal(agentEnvironmentMap(skyEnvironment({ sunElevation: 30 })), map);
  const bright = agentEnvironmentMap(skyEnvironment({ sunElevation: 30, groundAlbedo: 0.9 }));
  const sum = values => values.reduce((total, value) => total + value, 0);
  assert.ok(sum(bright.data) > sum(map.data));
  const sunrise = agentEnvironmentMap(skyEnvironment({ sunElevation: 2 }));
  assert.notEqual(sum(sunrise.data).toFixed(3), sum(map.data).toFixed(3));
});

test('a sky field names the value and an accepted example when it is wrong', () => {
  assert.throws(() => skyEnvironment({ sunElevation: 120 }), /environment\.sky\.sunElevation.*120.*-90 to 90/s);
  assert.throws(() => skyEnvironment({ turbidity: 0 }), /environment\.sky\.turbidity/);
  assert.throws(() => skyEnvironment({ dust: 1 }), /environment\.sky/);
  assert.throws(() => normalizeAgentLook({ environment: { sky: { type: 'cloudy' } } }), /physical/);
});

test('set-environment changes one sky field and keeps the others', () => {
  const session = createAgentScene({ format: 'crucible.scene', schemaVersion: 1, geometries: [], materials: [], nodes: [],
    environment: { sky: { type: 'physical', sunElevation: 60, turbidity: 5 } } });
  session.apply([{ type: 'set-environment', environment: { sky: { sunElevation: 10 } } }], { expectedRevision: 0 });
  const { sky, lightDirection } = session.environment;
  assert.equal(sky.sunElevation, 10);
  assert.equal(sky.turbidity, 5);
  assert.ok(Math.abs(lightDirection[1] - Math.sin(10 * Math.PI / 180)) < 1e-9);
});

test('ozone deepens twilight blue and sunDisc adds the solar disc to the sky map', () => {
  const noOzone = skyEnvironment({ sunElevation: 4, ozone: 0 });
  const heavyOzone = skyEnvironment({ sunElevation: 4, ozone: 6 });
  assert.ok(heavyOzone.keyColor[0] < noOzone.keyColor[0]);
  assert.ok(heavyOzone.skyTop[2] / Math.max(heavyOzone.skyTop[0], 1e-6) > noOzone.skyTop[2] / Math.max(noOzone.skyTop[0], 1e-6));

  const withDisc = agentEnvironmentMap(skyEnvironment({ sunElevation: 30, sunDisc: true }));
  const withoutDisc = agentEnvironmentMap(skyEnvironment({ sunElevation: 30, sunDisc: false }));
  const peak = values => values.reduce((largest, value) => Math.max(largest, value), 0);
  assert.ok(peak(withDisc.data) > peak(withoutDisc.data) * 1.2);
  assert.throws(() => skyEnvironment({ ozone: -1 }), /environment\.sky\.ozone/);
  assert.throws(() => skyEnvironment({ sunDisc: 1 }), /environment\.sky\.sunDisc/);
});

test('environment motion tracks animate physical sky sunElevation, sunRotation and turbidity', () => {
  const session = createAgentScene({
    format: 'crucible.scene', schemaVersion: 1, geometries: [], materials: [], nodes: [],
    environment: { sky: { type: 'physical', sunElevation: 60, sunRotation: 0, turbidity: 2 } },
    motion: {
      duration: 2,
      tracks: [
        { kind: 'environment', property: 'sunElevation', keyframes: [{ time: 0, value: 60 }, { time: 2, value: 5 }] },
        { kind: 'environment', property: 'sunRotation', keyframes: [{ time: 0, value: 0 }, { time: 2, value: 90 }] },
        { kind: 'environment', property: 'turbidity', keyframes: [{ time: 0, value: 2 }, { time: 2, value: 8 }] },
      ],
    },
  });
  session.sampleMotion(2);
  const sampled = session.environment;
  assert.equal(sampled.sky.sunElevation, 5);
  assert.equal(sampled.sky.sunRotation, 90);
  assert.equal(sampled.sky.turbidity, 8);
  assert.ok(Math.abs(sampled.lightDirection[1] - Math.sin(5 * Math.PI / 180)) < 1e-6);
  assert.ok(sampled.fogDensity > 0.0025 * 2);

  assert.throws(() => createAgentScene({
    format: 'crucible.scene', schemaVersion: 1, geometries: [], materials: [], nodes: [],
    motion: { duration: 1, tracks: [{ kind: 'environment', property: 'sunElevation', keyframes: [{ time: 0, value: 45 }] }] },
  }), /environment\.sky/);
});

test('the sky map has no step at the horizon: haze fills the first degrees below it', () => {
  const map = agentEnvironmentMap(skyEnvironment({ sunElevation: 9, turbidity: 2 }));
  const column = Math.floor(map.width / 2);
  const radianceAt = row => map.data[(row * map.width + column) * 3 + 1];
  const horizonRow = map.height / 2;
  const above = radianceAt(horizonRow - 1);
  const below = radianceAt(horizonRow);
  assert.ok(Math.abs(above - below) / above < 0.03, `radiance steps from ${above} to ${below} across the horizon`);
  const deepBelow = radianceAt(horizonRow + Math.round(map.height / 12));
  assert.ok(Math.abs(deepBelow - below) / below > 0.1, 'well below the horizon the ground colour takes over');
});
