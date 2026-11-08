import assert from 'node:assert/strict';
import test from 'node:test';

import { box, sphere } from '../src/geometry.js';
import { createEnvironmentMap } from '../src/environment.js';
import { PATH_TRACER_JOB_LIMITS } from '../src/path-tracer-capabilities.js';
import {
  createCamera, describeIgnoredFeatures, MAX_TRACE_PIXELS, normalizePathTracerOptions, PATH_TRACER_LIMITS, renderBand, renderPathTracedImage, toneMapToRgba8,
} from '../src/path-tracer.js';
import { attachTracer, buildTraceScene } from '../src/path-tracer-scene.js';

function placed(translation, scale) {
  return new Float32Array([scale[0], 0, 0, 0, 0, scale[1], 0, 0, 0, 0, scale[2], 0, translation[0], translation[1], translation[2], 1]);
}

function surface(color, extra = {}) {
  return { tag: 'surface', metallic: 0, roughness: 0.5, emission: 0, color, ...extra };
}

const FLOOR_ALBEDO = 0.5;
const SUN_STRENGTH = 3;
const FLOOR_ONLY = [{ name: 'floor', geometry: box(0, 1), matrix: placed([0, -0.05, 0], [40, 0.1, 40]), material: surface([FLOOR_ALBEDO, FLOOR_ALBEDO, FLOOR_ALBEDO], { roughness: 1 }) }];
const OVERHEAD_SUN = { keyColor: [SUN_STRENGTH, SUN_STRENGTH, SUN_STRENGTH], lightDirection: [0, 1, 0] };
const LOOKING_DOWN = { eye: [0, 3, 0], target: [0, 0, 0], up: [0, 0, -1], fov: 40 };
const SMALL = { width: 32, height: 24, samples: 4, bounces: 3, threads: 1 };

function checkerScene() {
  return {
    parts: [
      ...FLOOR_ONLY,
      { name: 'ball', geometry: sphere(24, 16), matrix: placed([0, 0.6, 0], [0.6, 0.6, 0.6]), material: surface([0.8, 0.3, 0.2], { metallic: 0.5, clearcoat: 0.5 }) },
      { name: 'glass', geometry: sphere(24, 16), matrix: placed([1.2, 0.5, 0], [0.5, 0.5, 0.5]), material: surface([1, 1, 1], { transmission: 1, roughness: 0.05 }) },
    ],
    environment: {
      ...OVERHEAD_SUN,
      pointLights: [{ position: [0, 2, 1], color: [1, 1, 1], intensity: 4, radius: 0.1 }],
      map: createEnvironmentMap({ width: 8, height: 4, data: new Float32Array(8 * 4 * 3).fill(0.4) }),
    },
    camera: { eye: [0, 2, 5], target: [0, 0.5, 0], up: [0, 1, 0], fov: 40 },
  };
}

test('the job limits listed for agents match the limits the tracer enforces', () => {
  for (const name of ['samples', 'bounces', 'seed']) {
    assert.equal(PATH_TRACER_JOB_LIMITS[name].minimum, PATH_TRACER_LIMITS[name].minimum, name);
    assert.equal(PATH_TRACER_JOB_LIMITS[name].maximum, PATH_TRACER_LIMITS[name].maximum, name);
    assert.equal(PATH_TRACER_JOB_LIMITS[name].default, PATH_TRACER_LIMITS[name].fallback, name);
  }
  assert.ok(PATH_TRACER_JOB_LIMITS.maxSeconds.maximum <= PATH_TRACER_LIMITS.maxSeconds.maximum);
  assert.ok(PATH_TRACER_JOB_LIMITS.noiseThreshold.maximum <= PATH_TRACER_LIMITS.noiseThreshold.maximum);
  assert.equal(PATH_TRACER_JOB_LIMITS.noiseThreshold.default, PATH_TRACER_LIMITS.noiseThreshold.fallback);
});

test('options are validated with their bounds', () => {
  assert.equal(normalizePathTracerOptions().samples, 64);
  assert.equal(normalizePathTracerOptions().width, 960);
  const refused = [
    { samples: 0 }, { samples: 1025 }, { samples: 1.5 }, { samples: Number.NaN }, { samples: '8' }, { bounces: 17 }, { bounces: 0 },
    { width: 4097 }, { width: 8 }, { height: -1 }, { seed: -1 }, { seed: 2 ** 31 }, { threads: 9 }, { threads: 0 },
    { maxSeconds: 0 }, { maxSeconds: 1801 }, { maxSeconds: Infinity }, { fireflyClamp: 0 }, { denoise: 'yes' },
    { width: 4096, height: 4096 },
    { width: 2000, height: 1000, samples: 1024, bounces: 16 },
  ];
  for (const options of refused) assert.throws(() => normalizePathTracerOptions(options), /Path tracer|too much|at most/, JSON.stringify(options));
  assert.throws(() => normalizePathTracerOptions(null), TypeError);
  assert.ok(MAX_TRACE_PIXELS >= 1920 * 1080);
});

test('hostile cameras and scenes are refused before any ray is traced', async () => {
  const { parts, environment } = checkerScene();
  const badCameras = [
    undefined,
    { eye: [0, 0, 0], target: [0, 0, 0], up: [0, 1, 0], fov: 40 },
    { eye: [0, 0, 5], target: [0, 0, 0], up: [0, 0, 1], fov: 40 },
    { eye: [0, 0, Number.NaN], target: [0, 0, 0], up: [0, 1, 0], fov: 40 },
    { eye: [0, 0, 5], target: [0, 0, 0], up: [0, 1, 0], fov: 0 },
    { eye: [0, 0, 5], target: [0, 0, 0], up: [0, 1, 0], fov: 179 },
    { eye: [0, 0, 5, 1], target: [0, 0, 0], up: [0, 1, 0], fov: 40 },
  ];
  for (const camera of badCameras) await assert.rejects(renderPathTracedImage({ parts, environment, camera }, SMALL), /camera|Cannot read/i);
  const camera = checkerScene().camera;
  await assert.rejects(renderPathTracedImage({ parts: [], environment, camera }, SMALL), /1 to/);
  await assert.rejects(renderPathTracedImage({ parts: 'floor', environment, camera }, SMALL), /1 to/);
  const nonFinite = [{ ...parts[0], matrix: placed([Number.NaN, 0, 0], [1, 1, 1]) }];
  await assert.rejects(renderPathTracedImage({ parts: nonFinite, environment, camera }, SMALL), /finite/);
  const brokenIndices = [{ ...parts[0], geometry: { ...parts[0].geometry, indices: new Uint32Array([0, 1, 999999]) } }];
  await assert.rejects(renderPathTracedImage({ parts: brokenIndices, environment, camera }, SMALL), /index/i);
  const flooded = { ...environment, pointLights: Array.from({ length: 40 }, () => ({ position: [0, 2, 0], color: [1, 1, 1], intensity: 1 })) };
  await assert.rejects(renderPathTracedImage({ parts, environment: flooded, camera }, SMALL), /at most/);
});

test('the same scene and seed give the same bytes, and another seed does not', async () => {
  const first = await renderPathTracedImage(checkerScene(), SMALL);
  const second = await renderPathTracedImage(checkerScene(), SMALL);
  assert.deepEqual(first.rgba, second.rgba);
  assert.deepEqual(first.linear, second.linear);
  const other = await renderPathTracedImage(checkerScene(), { ...SMALL, seed: 7 });
  assert.notDeepEqual(first.rgba, other.rgba);
  assert.ok(first.linear.every(Number.isFinite));
  assert.equal(first.report.width, SMALL.width);
  assert.equal(first.report.threads, 1);
});

test('a floor lit by an overhead sun matches the diffuse closed form', async () => {
  const { linear } = await renderPathTracedImage(
    { parts: FLOOR_ONLY, environment: OVERHEAD_SUN, camera: LOOKING_DOWN },
    { width: 16, height: 16, samples: 32, bounces: 1, denoise: false, threads: 1 },
  );
  const centre = (8 * 16 + 8) * 3;
  // Radiance of a diffuse surface under irradiance E is albedo * E / pi, shrunk by the Fresnel share the specular lobe
  // takes (4 percent at normal incidence). That lobe adds F0 * D(0) / 4 * E, and a fully rough GGX has D(0) = 1 / pi.
  const expected = FLOOR_ALBEDO * (1 - 0.04) * SUN_STRENGTH / Math.PI + 0.04 / (4 * Math.PI) * SUN_STRENGTH;
  assert.ok(Math.abs(linear[centre] - expected) / expected < 0.05, `got ${linear[centre]}, expected near ${expected}`);
});

test('a rough floor keeps its diffuse light when seen at a grazing angle', async () => {
  const GRAZING = { eye: [0, 0.3, 6], target: [0, 0, 0], up: [0, 1, 0], fov: 10 };
  const options = { width: 16, height: 16, samples: 32, bounces: 1, denoise: false, threads: 1 };
  const down = await renderPathTracedImage({ parts: FLOOR_ONLY, environment: OVERHEAD_SUN, camera: LOOKING_DOWN }, options);
  const grazing = await renderPathTracedImage({ parts: FLOOR_ONLY, environment: OVERHEAD_SUN, camera: GRAZING }, options);
  const centre = (8 * 16 + 8) * 3;
  // Cycles does not dim a rough dielectric's diffuse layer toward the horizon: its specular layer reflects little there.
  assert.ok(grazing.linear[centre] > 0.9 * down.linear[centre], `grazing ${grazing.linear[centre]} against ${down.linear[centre]} looking down`);
});

test('a block between the sun and the floor leaves a shadow', async () => {
  const blocker = { name: 'block', geometry: box(0, 1), matrix: placed([0, 1, 0], [2, 0.2, 2]), material: surface([0.5, 0.5, 0.5]) };
  // Sun from +x at 45 degrees: the block (x from -1 to 1, 1 m up) shades the floor from x = -2 to 0. Seen from above,
  // the floor at x = -1.5 is clear of the block's top and inside its shadow.
  const slantedSun = { keyColor: [3, 3, 3], lightDirection: [1, 1, 0] };
  const render = parts => renderPathTracedImage({ parts, environment: slantedSun, camera: { eye: [0, 8, 0], target: [0, 0, 0], up: [0, 0, -1], fov: 30 } },
    { width: 16, height: 16, samples: 16, bounces: 1, denoise: false, threads: 1 });
  const lit = await render(FLOOR_ONLY);
  const shaded = await render([...FLOOR_ONLY, blocker]);
  const pixel = (8 * 16 + 2) * 3;
  assert.ok(lit.linear[pixel] > 0.2, `unshaded floor: ${lit.linear[pixel]}`);
  assert.ok(shaded.linear[pixel] < 0.01, `shaded floor: ${shaded.linear[pixel]}`);
});

test('a render that runs out of time throws and returns nothing', async () => {
  // Each clock read costs a second, so the limit is passed on any machine.
  const realNow = performance.now;
  let clockReads = 0;
  performance.now = () => {
    clockReads += 1;
    return clockReads * 1000;
  };
  try {
    await assert.rejects(
      renderPathTracedImage(checkerScene(), { width: 256, height: 256, samples: 1024, bounces: 4, maxSeconds: 1, threads: 1 }),
      /1 second limit/,
    );
  } finally {
    performance.now = realNow;
  }
});

test('denoising keeps the mean of a noisy image and removes some of its noise', async () => {
  const scene = checkerScene();
  const options = { width: 48, height: 32, samples: 2, bounces: 3, threads: 1 };
  const noisy = await renderPathTracedImage(scene, { ...options, denoise: false });
  const clean = await renderPathTracedImage(scene, { ...options, denoise: true });
  const mean = buffer => buffer.reduce((sum, value) => sum + value, 0) / buffer.length;
  const roughness = buffer => {
    let total = 0;
    for (let index = 3; index < buffer.length; index++) total += Math.abs(buffer[index] - buffer[index - 3]);
    return total / buffer.length;
  };
  assert.ok(Math.abs(mean(clean.linear) - mean(noisy.linear)) / mean(noisy.linear) < 0.1);
  assert.ok(roughness(clean.linear) < roughness(noisy.linear));
  assert.ok(clean.linear.every(Number.isFinite));
});

test('the display transform matches the rasterizer post pass at known values', () => {
  const pixels = toneMapToRgba8(new Float32Array([0, 0, 0, 1, 1, 1]), 2, 1);
  assert.deepEqual([...pixels.slice(0, 4)], [0, 0, 0, 255]);
  // (1 * (2.51 + 0.03)) / (1 * (2.43 + 0.59) + 0.14) = 0.8038, then 0.8038 ^ (1 / 2.2) = 0.9055.
  assert.equal(pixels[4], Math.round(0.9055 * 255));
});

test('what the tracer does not draw is named in the report', () => {
  const notes = describeIgnoredFeatures(
    [{ material: { occlusionMap: {}, tag: 'liquid' } }, { material: { alphaMode: 'blend', anisotropy: 0.5, iridescence: 1 } }],
    { volumeFog: { density: 1 } },
  );
  assert.ok(notes.some(note => note.includes('volumeFog')));
  assert.ok(notes.some(note => note.includes('occlusionMap')));
  assert.ok(notes.some(note => note.includes('anisotropy')));
  assert.ok(notes.some(note => note.includes('iridescence')));
  assert.ok(notes.some(note => note.includes('liquid')));
  assert.ok(notes.some(note => note.includes('Blended')));
  assert.ok(notes.some(note => note.includes('environment map')));
});

// ---- Maps, light selection and band independence (issue #129) ----

function floorQuad() {
  const half = 20;
  return {
    positions: new Float32Array([-half, 0, half, half, 0, half, half, 0, -half, -half, 0, -half]),
    normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]),
    uvs: new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  };
}

function singleTexel(red, green, blue) {
  return { image: { data: new Uint8Array([red, green, blue, 255]), width: 1, height: 1 }, colorSpace: 'linear' };
}

async function renderMappedFloor(materialExtra) {
  const parts = [{ name: 'floor', geometry: floorQuad(), material: surface([0.5, 0.5, 0.5], { roughness: 1, ...materialExtra }) }];
  const slantedSun = { keyColor: [3, 3, 3], lightDirection: [1, 1, 0] };
  const { linear } = await renderPathTracedImage({ parts, environment: slantedSun, camera: LOOKING_DOWN },
    { width: 16, height: 16, samples: 16, bounces: 1, denoise: false, threads: 1 });
  return linear[(8 * 16 + 8) * 3];
}

test('a normal map tilts the surface toward or away from the light', async () => {
  const flat = await renderMappedFloor({});
  const flatMap = await renderMappedFloor({ normalMap: singleTexel(128, 128, 255) });
  const towardSun = await renderMappedFloor({ normalMap: singleTexel(204, 128, 230) });
  const awayFromSun = await renderMappedFloor({ normalMap: singleTexel(51, 128, 230) });
  assert.ok(Math.abs(flatMap - flat) / flat < 0.02, `flat map ${flatMap} against none ${flat}`);
  assert.ok(towardSun > flat * 1.2, `tilted toward the sun ${towardSun} against flat ${flat}`);
  assert.ok(awayFromSun < flat * 0.5, `tilted away ${awayFromSun} against flat ${flat}`);
});

test('a metallic-roughness map scales the metallic and roughness of the material', async () => {
  const plain = await renderMappedFloor({ metallic: 0 });
  const metalMasked = await renderMappedFloor({ metallic: 1, metallicRoughnessMap: singleTexel(0, 255, 0) });
  const unmasked = await renderMappedFloor({ metallic: 1 });
  assert.equal(metalMasked, plain, 'blue channel 0 removes the metal');
  assert.notEqual(unmasked, plain);
  const smoothed = await renderMappedFloor({ metallicRoughnessMap: singleTexel(0, 0, 0) });
  assert.notEqual(smoothed, plain, 'green channel 0 makes the surface smooth');
});

test('normal and roughness maps on box-projected materials are drawn through the projection UVs', async () => {
  const notes = describeIgnoredFeatures([{ material: { normalMap: {}, metallicRoughnessMap: {}, boxMapScale: 2 } }], {});
  assert.ok(!notes.some(note => note.includes('normalMap') || note.includes('metallicRoughnessMap')), notes.join(' '));
  const boxed = { boxMapScale: 2, boxMapAxis: 1 };
  const flat = await renderMappedFloor({ ...boxed });
  const towardSun = await renderMappedFloor({ ...boxed, normalMap: singleTexel(204, 128, 230) });
  const awayFromSun = await renderMappedFloor({ ...boxed, normalMap: singleTexel(51, 128, 230) });
  assert.ok(towardSun > flat * 1.2, `tilted toward the sun ${towardSun} against flat ${flat}`);
  assert.ok(awayFromSun < flat * 0.5, `tilted away ${awayFromSun} against flat ${flat}`);
  const plain = await renderMappedFloor({ ...boxed, metallic: 0 });
  const metalMasked = await renderMappedFloor({ ...boxed, metallic: 1, metallicRoughnessMap: singleTexel(0, 255, 0) });
  assert.equal(metalMasked, plain, 'blue channel 0 removes the metal on a box-projected material');
});

test('drawing one light at random past the first hit keeps the average', async () => {
  const room = lights => ({
    parts: [
      ...FLOOR_ONLY,
      { name: 'wall', geometry: box(0, 1), matrix: placed([0, 1, -2], [6, 2, 0.1]), material: surface([0.7, 0.7, 0.7], { roughness: 1 }) },
    ],
    environment: { pointLights: lights },
    camera: { eye: [0, 1.5, 3], target: [0, 0.8, -2], up: [0, 1, 0], fov: 50 },
  });
  const light = intensity => ({ position: [0.5, 1.5, -0.5], color: [1, 1, 1], intensity, radius: 0 });
  const options = { width: 16, height: 16, samples: 256, bounces: 4, denoise: false, threads: 1 };
  const mean = image => image.linear.reduce((sum, value) => sum + value, 0) / image.linear.length;
  const single = mean(await renderPathTracedImage(room([light(8)]), options));
  const split = mean(await renderPathTracedImage(room([light(4), light(4)]), options));
  assert.ok(Math.abs(single - split) / single < 0.03, `one light ${single}, the same light split in two ${split}`);
});

test('bands drawn in any order and split anywhere give the pixels of the whole image', () => {
  const { parts, environment, camera } = checkerScene();
  const options = normalizePathTracerOptions({ width: 24, height: 18, samples: 3, bounces: 3, threads: 1 });
  const scene = buildTraceScene(parts, environment);
  const view = createCamera(camera, options.width, options.height);
  const whole = renderBand(scene, view, options, 0, options.height);
  const rowFloats = options.width * 3;
  for (const [start, end] of [[11, 18], [0, 5], [5, 11]]) {
    const band = renderBand(scene, view, options, start, end);
    assert.deepEqual(band.color, whole.color.slice(start * rowFloats, end * rowFloats), `rows ${start} to ${end}`);
    assert.deepEqual(band.depth, whole.depth.slice(start * options.width, end * options.width));
  }
});

test('a scene sent to a worker gets its ray query back from the arrays', () => {
  const { parts, environment } = checkerScene();
  const scene = buildTraceScene(parts, environment);
  const { tracer: _removed, ...sent } = scene;
  const revived = attachTracer(structuredClone(sent));
  const hit = revived.tracer.trace(0, 5, 0, 0, -1, 0, 100, false);
  assert.ok(hit.nearestTriangle >= 0);
});

// ---- Adaptive sampling (issue #129) ----

const NOISY_AND_QUIET = { width: 24, height: 18, samples: 48, bounces: 3, threads: 1, denoise: false };

test('a threshold of zero draws every sample, and a threshold stops the pixels that have converged', async () => {
  const fixed = await renderPathTracedImage(checkerScene(), NOISY_AND_QUIET);
  assert.equal(fixed.report.averageSamples, 48);
  const adaptive = await renderPathTracedImage(checkerScene(), { ...NOISY_AND_QUIET, noiseThreshold: 0.05 });
  assert.ok(adaptive.report.averageSamples < 48, `average ${adaptive.report.averageSamples}`);
  assert.ok(adaptive.report.averageSamples >= 16, 'no pixel stops before its minimum');
  const mean = image => image.linear.reduce((sum, value) => sum + value, 0) / image.linear.length;
  assert.ok(Math.abs(mean(adaptive) - mean(fixed)) / mean(fixed) < 0.05, `mean ${mean(adaptive)} against ${mean(fixed)}`);
});

test('adaptive bands split anywhere give the pixels of the whole image', () => {
  const { parts, environment, camera } = checkerScene();
  const options = normalizePathTracerOptions({ ...NOISY_AND_QUIET, noiseThreshold: 0.05 });
  const scene = buildTraceScene(parts, environment);
  const view = createCamera(camera, options.width, options.height);
  const whole = renderBand(scene, view, options, 0, options.height);
  assert.ok(new Set(whole.samplesTaken).size > 1, 'the pixels stop at different sample counts');
  const rowFloats = options.width * 3;
  for (const [start, end] of [[7, 18], [0, 9]]) {
    const band = renderBand(scene, view, options, start, end);
    assert.deepEqual(band.color, whole.color.slice(start * rowFloats, end * rowFloats), `rows ${start} to ${end}`);
    assert.deepEqual(band.samplesTaken, whole.samplesTaken.slice(start * options.width, end * options.width));
  }
});

test('the noise threshold is validated', () => {
  for (const noiseThreshold of [-0.1, 1.5, Number.NaN, '0.1']) assert.throws(() => normalizePathTracerOptions({ noiseThreshold }), /noiseThreshold/);
});

test('a camera ray and a shadow ray pass through a deep stack of transparent cutouts', async () => {
  const transparentTexel = { image: { data: new Uint8Array([255, 255, 255, 0]), width: 1, height: 1 }, colorSpace: 'linear' };
  const floor = { name: 'floor', geometry: floorQuad(), material: surface([0.5, 0.5, 0.5], { roughness: 1 }) };
  const layerCount = 24;
  const layers = Array.from({ length: layerCount }, (unused, layer) => ({
    name: `layer-${layer}`,
    geometry: floorQuad(),
    matrix: placed([0, 0.1 + layer * 0.05, 0], [1, 1, 1]),
    material: surface([1, 1, 1], { map: transparentTexel, alphaMode: 'mask', alphaCutoff: 0.5, doubleSided: true }),
  }));
  const options = { width: 16, height: 16, samples: 4, bounces: 1, denoise: false, threads: 1 };
  const scene = parts => ({ parts, environment: OVERHEAD_SUN, camera: LOOKING_DOWN });
  const plain = await renderPathTracedImage(scene([floor]), options);
  const stacked = await renderPathTracedImage(scene([floor, ...layers]), options);
  const centre = (8 * 16 + 8) * 3;
  assert.ok(plain.linear[centre] > 0.1, 'the plain floor is lit');
  assert.equal(stacked.linear[centre], plain.linear[centre], 'transparent layers change neither the hit nor the shadow');
});
