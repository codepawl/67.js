import './support/load-agent-scene-modules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentScene } from '../src/agent-scene.js';
import { agentEnvironmentMap, normalizeAgentLook } from '../src/agent-look.js';

function skyEnvironment(sky) {
  return normalizeAgentLook({ environment: { sky: { type: 'physical', ...sky } } }).environment;
}

const redOverBlue = color => color[0] / Math.max(color[2], 1e-6);
const MAP_WIDTH = 1024;
const MAP_HEIGHT = 512;

function mapColorAt(environment, polarDegrees, azimuthDegrees) {
  const { data } = agentEnvironmentMap(environment);
  const row = Math.floor(polarDegrees / 180 * MAP_HEIGHT);
  const column = Math.floor((azimuthDegrees / 360 + 0.5) * MAP_WIDTH);
  return [0, 1, 2].map(channel => data[(row * MAP_WIDTH + column) * 3 + channel]);
}

test('a low sun warms the key and the horizon while the zenith stays blue', () => {
  const golden = skyEnvironment({ sunElevation: 6 });
  assert.ok(redOverBlue(golden.keyColor) > 4, `key ${golden.keyColor}`);
  assert.ok(redOverBlue(golden.skyBottom) > 1.3, `horizon ${golden.skyBottom}`);
  assert.ok(golden.skyTop[2] > golden.skyTop[0] * 2.5, `zenith ${golden.skyTop}`);
  const grazing = skyEnvironment({ sunElevation: 2 });
  assert.ok(redOverBlue(grazing.skyBottom) > redOverBlue(golden.skyBottom));
  const sideHorizon = mapColorAt(grazing, 88, 90);
  assert.ok(sideHorizon[0] > sideHorizon[2] * 1.4, `the map horizon at 2 degrees is warm: ${sideHorizon}`);
  const zenith = mapColorAt(grazing, 1, 0);
  assert.ok(zenith[2] > zenith[0] * 2.5, `the map zenith stays blue: ${zenith}`);
});

test('a sun above 14 degrees keeps the sky and key it had before the low-sun fit', () => {
  const noon = skyEnvironment({ sunElevation: 45 });
  assert.deepEqual(noon.keyColor, [2.963, 2.716, 2.248]);
  const expectedTop = [0.13, 0.25, 0.47];
  const expectedBottom = [0.41, 0.7, 1];
  noon.skyTop.forEach((component, index) => assert.ok(Math.abs(component - expectedTop[index]) < 0.006, `top ${noon.skyTop}`));
  noon.skyBottom.forEach((component, index) => assert.ok(Math.abs(component - expectedBottom[index]) < 0.006, `bottom ${noon.skyBottom}`));
  assert.deepEqual(skyEnvironment({ sunElevation: 15 }).keyColor, [2.345, 1.856, 1.114]);
});

test('sky presets set the sun, are deterministic, and fields beside them win', () => {
  const first = skyEnvironment({ preset: 'golden-hour' });
  assert.deepEqual(first, skyEnvironment({ preset: 'golden-hour' }));
  assert.equal(first.sky.sunElevation, 4);
  assert.equal(first.sky.preset, undefined);
  assert.equal(skyEnvironment({ preset: 'sunset' }).sky.sunElevation, 1);
  assert.ok(skyEnvironment({ preset: 'blue-hour' }).sky.sunElevation < 0);
  assert.equal(skyEnvironment({ preset: 'golden-hour', sunElevation: 9, turbidity: 5 }).sky.sunElevation, 9);
  assert.ok(redOverBlue(skyEnvironment({ preset: 'sunset' }).keyColor) > redOverBlue(first.keyColor));
});

test('a preset in set-environment replaces the earlier sky, and a bad preset names the field', () => {
  const session = createAgentScene({ format: 'crucible.scene', schemaVersion: 1, geometries: [], materials: [], nodes: [],
    environment: { sky: { type: 'physical', sunElevation: 60, turbidity: 8 } } });
  session.apply([{ type: 'set-environment', environment: { sky: { preset: 'golden-hour' } } }], { expectedRevision: 0 });
  assert.equal(session.environment.sky.sunElevation, 4);
  assert.equal(session.environment.sky.turbidity, 3);
  assert.throws(() => skyEnvironment({ preset: 'noon' }), /environment\.sky\.preset.*golden-hour, sunset, blue-hour/);
});
