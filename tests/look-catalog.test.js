import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { sphere } from '../src/geometry.js';
import { agentEnvironmentMap, normalizeAgentLook } from '../src/agent-look.js';
import { parseRadianceHdr } from '../src/hdri.js';
import { renderPathTracedImage, toneMapToRgba8 } from '../src/path-tracer.js';
import { parseCube } from '../src/view-transform.js';
import {
  BUNDLED_CUBE_LOOK_NAMES, BUNDLED_ENVIRONMENT_NAMES, catalogLook, catalogLookReferences, registerCatalogEnvironment, registerCatalogLook,
} from '../src/look-catalog.js';

const shippedFile = (name, extension) => readFileSync(new URL(`../assets/looks/${name}.${extension}`, import.meta.url));

for (const name of BUNDLED_ENVIRONMENT_NAMES) registerCatalogEnvironment(name, parseRadianceHdr(shippedFile(name, 'hdr')));
for (const name of BUNDLED_CUBE_LOOK_NAMES) registerCatalogLook(name, parseCube(shippedFile(name, 'cube').toString('utf8')));

const SMALL = { width: 24, height: 18, samples: 8, bounces: 2, threads: 1 };
const CAMERA = { eye: [0, 0.3, 4], target: [0, 0, 0], up: [0, 1, 0], fov: 40 };
const MIRROR_BALL = [{
  name: 'ball',
  geometry: sphere(24, 16),
  matrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
  material: { tag: 'surface', color: [0.9, 0.9, 0.9], metallic: 1, roughness: 0.05, emission: 0 },
}];

async function renderWithHdri(hdri, environmentRotation = 0) {
  const { environment } = normalizeAgentLook({ environment: { hdri, environmentRotation, keyIntensity: 0, world: true } });
  return renderPathTracedImage({ parts: MIRROR_BALL, environment: { ...environment, map: agentEnvironmentMap(environment) }, camera: CAMERA }, SMALL);
}

function meanLinear(frame) {
  return frame.linear.reduce((sum, value) => sum + value, 0) / frame.linear.length;
}

function frameDifference(first, second) {
  let total = 0;
  for (let index = 0; index < first.length; index++) total += Math.abs(first[index] - second[index]);
  return total / first.length;
}

test('a catalog HDRI lights and reflects: the frame is lit, differs per HDRI and turns with rotation', async () => {
  const sky = await renderWithHdri('sky-clouds');
  const studio = await renderWithHdri('studio-softbox');
  const turned = await renderWithHdri('sky-clouds', Math.PI);
  assert.ok(meanLinear(sky) > 0.05, 'the HDRI lights the frame with no key light');
  assert.ok(frameDifference(sky.rgba, studio.rgba) > 4, 'two HDRIs give two frames');
  assert.ok(frameDifference(sky.rgba, turned.rgba) > 4, 'rotation turns the reflection');
  const centre = (Math.floor(SMALL.height / 2) * SMALL.width + SMALL.width / 2) * 4;
  const top = (Math.floor(SMALL.height / 3) * SMALL.width + SMALL.width / 2) * 4;
  assert.notDeepEqual([...sky.rgba.subarray(top, top + 3)], [...sky.rgba.subarray(centre, centre + 3)], 'the mirror ball shows the sky varying across it');
});

test('environment strength scales the HDRI light and the map is cached per setting', async () => {
  const { environment } = normalizeAgentLook({ environment: { hdri: 'sky-clouds', environmentIntensity: 2 } });
  assert.equal(agentEnvironmentMap(environment), agentEnvironmentMap(environment));
  assert.equal(agentEnvironmentMap(environment).intensity, 2);
});

test('a .cube look changes a frame and the shipped looks differ', async () => {
  const frame = await renderWithHdri('sky-clouds');
  const plain = toneMapToRgba8(frame.linear, frame.width, frame.height);
  const tealOrange = toneMapToRgba8(frame.linear, frame.width, frame.height, { look: catalogLook('teal-orange') });
  const noir = toneMapToRgba8(frame.linear, frame.width, frame.height, { look: catalogLook('noir') });
  assert.ok(frameDifference(plain, tealOrange) > 2);
  assert.ok(frameDifference(tealOrange, noir) > 2);
  for (let pixel = 0; pixel < frame.width * frame.height; pixel++) {
    assert.ok(Math.abs(noir[pixel * 4] - noir[pixel * 4 + 1]) <= 1, 'noir is monochrome');
  }
});

test('recipes validate hdri and look names and never take a path or URL', () => {
  assert.equal(normalizeAgentLook({ environment: { hdri: 'studio-softbox', look: 'noir' } }).environment.hdri, 'studio-softbox');
  const catalogId = 'a'.repeat(64);
  assert.equal(normalizeAgentLook({ environment: { hdri: catalogId, look: catalogId } }).environment.look, catalogId);
  for (const hdri of ['moonlit', 'https://example.com/sky.hdr', '../sky.hdr', 'C:/sky.hdr', 7]) {
    assert.throws(() => normalizeAgentLook({ environment: { hdri } }), /environment\.hdri/);
  }
  for (const look of ['https://example.com/a.cube', '../a.cube', 'sepia']) {
    assert.throws(() => normalizeAgentLook({ environment: { look } }), /environment\.look/);
  }
  assert.equal('hdri' in normalizeAgentLook({ environment: { hdri: null } }).environment, false);
  assert.throws(() => agentEnvironmentMap({ hdri: catalogId }), /not loaded/);
});

test('catalogLookReferences finds names in recipes and set-environment operations', () => {
  const found = catalogLookReferences({ operations: [{ type: 'set-environment', environment: { hdri: 'sky-clouds', look: 'noir' } }, { type: 'set-environment', environment: { look: 'warm' } }] });
  assert.deepEqual(found, { environments: ['sky-clouds'], looks: ['noir'] });
});
