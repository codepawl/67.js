import assert from 'node:assert/strict';
import test from 'node:test';
import { mat4, vec3 } from 'gl-matrix';
import { createFragmentShader } from '../src/shaders.js';
import { CascadedShadows, cascadeSplitDistances, createCascadedShadows, writeCascadeMatrix } from '../src/cascaded-shadows.js';

const TOWARD_LIGHT = vec3.normalize(vec3.create(), [-0.7, 0.8, 0.35]);
const RESOLUTION = 2048;
const CASTER_REACH = 200;

function projectedPoint(matrix, point) {
  return vec3.transformMat4(vec3.create(), point, matrix);
}

test('split distances grow, end at the far plane and sit between a uniform and a logarithmic split', () => {
  const splits = cascadeSplitDistances(4, 0.1, 100, 0.7);
  assert.equal(splits.length, 4);
  assert.equal(splits[3], 100);
  for (let index = 1; index < splits.length; index++) assert.ok(splits[index] > splits[index - 1]);
  const uniformFirst = 0.1 + (100 - 0.1) / 4;
  assert.ok(splits[0] < uniformFirst, 'the first slice is shorter than a uniform one');
  assert.ok(splits[0] > 0.1);
});

test('one cascade covers the whole range', () => {
  assert.deepEqual(cascadeSplitDistances(1, 0.5, 80), [80]);
});

test('a cascade matrix maps its own sphere inside the depth map', () => {
  const sphere = { center: [3, 1, -20], radius: 12 };
  const matrix = mat4.create();
  const { texel, range } = writeCascadeMatrix(matrix, sphere, TOWARD_LIGHT, RESOLUTION, CASTER_REACH);
  assert.ok(Math.abs(texel - 24 / RESOLUTION) < 1e-12);
  assert.ok(range > CASTER_REACH);
  const centre = projectedPoint(matrix, sphere.center);
  assert.ok(Math.abs(centre[0]) < 2 / RESOLUTION * 1.01 && Math.abs(centre[1]) < 2 / RESOLUTION * 1.01, 'the centre stays within a texel of the middle');
  const towardCamera = projectedPoint(matrix, vec3.scaleAndAdd(vec3.create(), sphere.center, TOWARD_LIGHT, 150));
  assert.ok(towardCamera[2] > -1 && towardCamera[2] < 1, 'a caster far toward the light is inside the depth range');
});

test('moving the slice by less than a texel leaves the matrix unchanged, so edges do not crawl', () => {
  const first = mat4.create();
  const second = mat4.create();
  const sphere = { center: [3, 1, -20], radius: 12 };
  writeCascadeMatrix(first, sphere, TOWARD_LIGHT, RESOLUTION, CASTER_REACH);
  const texel = 24 / RESOLUTION;
  const nudged = { center: [3 + texel * 0.01, 1, -20], radius: 12 };
  writeCascadeMatrix(second, nudged, TOWARD_LIGHT, RESOLUTION, CASTER_REACH);
  assert.deepEqual([...second], [...first]);
  const far = { center: [3 + texel * 5, 1, -20], radius: 12 };
  writeCascadeMatrix(second, far, TOWARD_LIGHT, RESOLUTION, CASTER_REACH);
  assert.notDeepEqual([...second], [...first]);
});

test('a vertical light still gets a valid view', () => {
  const matrix = mat4.create();
  writeCascadeMatrix(matrix, { center: [0, 0, 0], radius: 5 }, [0, 1, 0], RESOLUTION, CASTER_REACH);
  assert.ok([...matrix].every(Number.isFinite));
});

test('options are checked', () => {
  assert.throws(() => createCascadedShadows({ count: 0 }), /cascade count/);
  assert.throws(() => createCascadedShadows({ count: 5 }), /cascade count/);
  assert.throws(() => createCascadedShadows({ count: 2.5 }), /cascade count/);
  assert.throws(() => createCascadedShadows({ resolution: 100 }), /cascade resolution/);
  assert.throws(() => createCascadedShadows({ maximumDistance: -1 }), /maximumDistance/);
  assert.throws(() => createCascadedShadows({ splitLambda: 2 }), /splitLambda/);
  assert.ok(createCascadedShadows({ count: 4 }) instanceof CascadedShadows);
});

test('the cascade shader replaces the classic sun map and a plain shader has no trace of it', () => {
  const cascaded = createFragmentShader(['cascadedShadows']);
  assert.match(cascaded, /#define shadowVisibility\(normal\) cascadeVisibility\(normal\)/);
  const plain = createFragmentShader([]);
  assert.doesNotMatch(plain, /cascadeVisibility|cascadeShadowMap/);
  assert.doesNotMatch(plain, /#define shadowVisibility/);
});

test('an update redraws only the slices whose matrix changed, and every slice when a caster changed', () => {
  const context = new Proxy({}, { get: (target, name) => (name in target ? target[name] : () => ({})) });
  const drawnLayers = [];
  const renderer = { context, renderTargets: { record() {} }, drawShadowCasters: matrix => drawnLayers.push(matrix[0]) };
  const cascades = createCascadedShadows({ count: 3, resolution: 256 });
  const setMatrices = firstValues => {
    firstValues.forEach((value, layer) => cascades.matrices.fill(value, layer * 16, layer * 16 + 16));
    cascades.fitToCamera = () => cascades.matrices.some((value, index) => value !== cascades.drawnMatrices[index]);
  };
  setMatrices([1, 2, 3]);
  cascades.update(renderer, false);
  assert.deepEqual(drawnLayers.splice(0), [1, 2, 3]);
  cascades.update(renderer, false);
  assert.deepEqual(drawnLayers.splice(0), [], 'nothing moved');
  setMatrices([1, 2, 4]);
  cascades.update(renderer, false);
  assert.deepEqual(drawnLayers.splice(0), [4], 'only the moved slice');
  cascades.update(renderer, true);
  assert.deepEqual(drawnLayers.splice(0), [1, 2, 4], 'a changed caster redraws every slice');
});

test('a far slice that drifts toward the light keeps its map, because the wide fit also reaches further on the light side', () => {
  const cascades = createCascadedShadows({ count: 2, resolution: 2048 });
  const sphereAlongLight = distance => ({ center: TOWARD_LIGHT.map(value => value * distance), radius: 80 });
  cascades.chooseFit(1, sphereAlongLight(0), TOWARD_LIGHT);
  const wide = cascades.chooseFit(1, sphereAlongLight(1), TOWARD_LIGHT);
  assert.equal(cascades.chooseFit(1, sphereAlongLight(4), TOWARD_LIGHT), wide, 'a drift toward the light stays covered');
});

test('a moving camera keeps a far slice\'s map until the slice leaves it, and a stopped camera settles on the exact fit', () => {
  const cascades = createCascadedShadows({ count: 2, resolution: 2048 });
  const sphereAt = x => ({ center: [x, 0, -100], radius: 80 });
  const exact = cascades.chooseFit(1, sphereAt(0), TOWARD_LIGHT);
  assert.equal(exact.radius, 80, 'the first fit is exact');
  const wide = cascades.chooseFit(1, sphereAt(2), TOWARD_LIGHT);
  assert.ok(wide.radius > 80, 'the first move draws wider than needed');
  const kept = cascades.chooseFit(1, sphereAt(6), TOWARD_LIGHT);
  assert.equal(kept, wide, 'a small move stays inside the wide map');
  const redrawn = cascades.chooseFit(1, sphereAt(60), TOWARD_LIGHT);
  assert.notEqual(redrawn, wide, 'a large move leaves it');
  const settled = cascades.chooseFit(1, sphereAt(60), TOWARD_LIGHT);
  assert.equal(settled.radius, 80, 'a camera that stopped gets the exact fit');
  assert.equal(cascades.chooseFit(0, sphereAt(0), TOWARD_LIGHT).radius, 80);
  assert.equal(cascades.chooseFit(0, sphereAt(3), TOWARD_LIGHT).radius, 80, 'the nearest slice always fits exactly');
});
