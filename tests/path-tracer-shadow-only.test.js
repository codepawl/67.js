import assert from 'node:assert/strict';
import test from 'node:test';

import { box } from '../src/geometry.js';
import { describeIgnoredFeatures, renderPathTracedImage } from '../src/path-tracer.js';

function placed(translation, scale) {
  return new Float32Array([scale[0], 0, 0, 0, 0, scale[1], 0, 0, 0, 0, scale[2], 0, translation[0], translation[1], translation[2], 1]);
}

function surface(color) {
  return { tag: 'surface', metallic: 0, roughness: 1, emission: 0, color };
}

const environment = { keyColor: [3, 3, 3], lightDirection: [0, 1, 0] };
const camera = { eye: [0, 6, 0], target: [0, 0, 0], up: [0, 0, -1], fov: 30 };
const OPTIONS = { width: 16, height: 16, samples: 16, bounces: 2, denoise: false, threads: 1, backend: 'cpu' };

function floor() {
  return { name: 'floor', geometry: box(0, 1), matrix: placed([0, -0.05, 0], [20, 0.1, 20]), material: surface([0.5, 0.5, 0.5]) };
}

function caster(extra) {
  return { name: 'caster', geometry: box(0, 1), matrix: placed([0, 1.5, 0], [3, 0.2, 3]), material: surface([0.9, 0.2, 0.1]), ...extra };
}

async function centreBrightness(parts) {
  const { linear } = await renderPathTracedImage({ parts, environment, camera }, OPTIONS);
  const centre = (8 * 16 + 8) * 3;
  return linear[centre] + linear[centre + 1] + linear[centre + 2];
}

test('Cook draws the shadow of a shadow-only caster and not the caster', async () => {
  const lit = await centreBrightness([floor()]);
  const visibleCaster = await centreBrightness([floor(), caster()]);
  const shadowOnly = await centreBrightness([floor(), caster({ shadowOnly: true })]);
  assert.ok(lit > 0.5, 'the bare floor is lit by the sun');
  assert.ok(visibleCaster > lit * 0.5, 'a visible caster is drawn in the middle of the picture');
  assert.ok(shadowOnly < lit * 0.15, `the floor under a shadow-only caster is in its shadow: ${shadowOnly} against ${lit}`);
  assert.ok(visibleCaster > shadowOnly * 5, 'the shadow-only caster is not drawn');
});

test('a part without the flag leaves the trace scene and the notes unchanged', () => {
  assert.deepEqual(describeIgnoredFeatures([floor(), caster()], {}, 'cpu').filter(note => note.startsWith('shadowOnly')), []);
});

test('no Cook backend lists shadowOnly as an ignored feature', () => {
  for (const backend of ['cpu', 'gpu', 'webgpu', 'native']) {
    const notes = describeIgnoredFeatures([floor(), caster({ shadowOnly: true })], {}, backend);
    assert.deepEqual(notes.filter(note => note.startsWith('shadowOnly')), [], backend);
  }
});
