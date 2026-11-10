import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { bakeMaterialPattern, normalizeMaterialPattern } from '../src/material-patterns.js';
import { compileMaterialGraph } from '../src/material-graph.js';
import { AGENT_SCENE_CAPABILITIES } from '../src/agent-scene-capabilities.js';

function evaluate(graph, output, u = 0.3, v = 0.6, options) {
  const compiled = compileMaterialGraph(graph, options).outputs[output];
  return compiled.kind === 'vector' ? compiled.parts.map(part => part(u, v)) : compiled.evaluate(u, v);
}

test('coord reports the unit tile as generated and metres across the tile as object and world', () => {
  assert.deepEqual(evaluate({ color: { coord: 'generated' } }, 'color', 0.25, 0.5, { size: 4 }), [0.25, 0.5, 0]);
  assert.deepEqual(evaluate({ color: { coord: 'object' } }, 'color', 0.25, 0.5, { size: 4 }), [1, 2, 0]);
  assert.deepEqual(evaluate({ color: { coord: 'world' } }, 'color', 0.25, 0.5, { size: 4 }), [1, 2, 0]);
});

test('mapping scales, turns around Z and moves a vector, defaulting to the generated coordinates', () => {
  const mapped = settings => evaluate({ color: { mapping: settings } }, 'color', 0.5, 0.25);
  assert.deepEqual(mapped({ scale: 2 }), [1, 0.5, 0]);
  assert.deepEqual(mapped({ offset: [1, 2, 3] }), [1.5, 2.25, 3]);
  const [turnedX, turnedY] = mapped({ rotate: Math.PI / 2 });
  assert.ok(Math.abs(turnedX + 0.25) < 1e-12 && Math.abs(turnedY - 0.5) < 1e-12);
  assert.deepEqual(evaluate({ color: { mapping: { vector: { coord: 'object' }, scale: [1, 1, 1] } } }, 'color', 0.5, 0.25, { size: 2 }), [1, 0.5, 0]);
});

test('a mapped vector can place a texture through "at"', () => {
  const stretched = evaluate({ height: { gradient: { type: 'u', at: { mapping: { scale: [0.5, 1, 1] } } } } }, 'height', 0.5, 0.5);
  assert.equal(stretched, 0.25);
});

test('brick lays a running bond: mortar between bricks, a random value inside each brick, offset on odd rows', () => {
  const brick = (output, u, v, extra = {}) => evaluate({ height: { brick: { columns: 4, rows: 4, mortar: 0.2, output, ...extra } } }, 'height', u, v);
  assert.equal(brick('mortar', 0.125, 0.125), 0, 'centre of a brick is not mortar');
  assert.equal(brick('mortar', 0.25, 0.125), 1, 'the vertical joint is mortar');
  assert.equal(brick('mortar', 0.125, 0.25), 1, 'the horizontal joint is mortar');
  assert.equal(brick('mortar', 0.25, 0.375), 0, 'odd rows shift by half a brick, so a joint of row 0 is a brick centre in row 1');
  assert.equal(brick('edge', 0.125, 0.125), 1);
  assert.equal(brick('edge', 0.25, 0.125), 0);
  assert.equal(brick('cell', 0.1, 0.1), brick('cell', 0.2, 0.2), 'one value for the whole brick');
  assert.notEqual(brick('cell', 0.1, 0.1), brick('cell', 0.1, 0.4));
  assert.notEqual(brick('cell', 0.1, 0.1, { seed: 1 }), brick('cell', 0.1, 0.1, { seed: 2 }));
});

test('brick and whiteNoise tile over the unit square and are deterministic for the same seed', () => {
  const graph = seed => ({
    height: { add: [{ brick: { columns: 5, rows: 6, output: 'cell', seed } }, { whiteNoise: { scale: 7, seed } }] },
  });
  const first = compileMaterialGraph(graph(3)).outputs.height;
  const second = compileMaterialGraph(graph(3)).outputs.height;
  const other = compileMaterialGraph(graph(4)).outputs.height;
  const epsilon = 1e-9;
  for (const v of [0.05, 0.33, 0.9]) {
    assert.equal(first.evaluate(epsilon, v), first.evaluate(1 + epsilon, v));
    assert.equal(first.evaluate(v, epsilon), first.evaluate(v, 1 + epsilon));
    assert.equal(first.evaluate(v, 0.4), second.evaluate(v, 0.4));
  }
  assert.notEqual(first.evaluate(0.31, 0.77), other.evaluate(0.31, 0.77));
});

test('whiteNoise is one value per cell and a colour is three independent values', () => {
  const value = (u, v) => evaluate({ height: { whiteNoise: { scale: 4, seed: 9 } } }, 'height', u, v);
  assert.equal(value(0.01, 0.01), value(0.24, 0.24));
  assert.notEqual(value(0.01, 0.01), value(0.3, 0.01));
  const [red, green, blue] = evaluate({ color: { whiteNoise: { scale: 4, output: 'color' } } }, 'color', 0.1, 0.1);
  assert.ok(red !== green && green !== blue);
  for (const channel of [red, green, blue, value(0.5, 0.5)]) assert.ok(channel >= 0 && channel < 1);
});

test('invalid input names the node and the fix', () => {
  const failing = (graph, message) => assert.throws(() => compileMaterialGraph(graph), message);
  failing({ color: { coord: 'camera' } }, /coord must be one of generated, object, world/);
  failing({ color: { coord: 'object', extra: 1 } }, /one operator|coord takes no other fields/);
  failing({ color: { mapping: { scale: 'big' } } }, /mapping "scale" is a number or \[x, y, z\]/);
  failing({ color: { mapping: { vector: 0.5 } } }, /mapping "vector" needs a vector/);
  failing({ color: { mapping: { rotate: Infinity } } }, /mapping "rotate" is an angle/);
  failing({ color: { mapping: { colour: 1 } } }, /mapping does not take "colour"/);
  failing({ height: { brick: { rows: 3 } } }, /brick rows must be even/);
  failing({ height: { brick: { columns: 0 } } }, /brick columns must be a whole number from 1 to 64/);
  failing({ height: { brick: { mortar: 0.9 } } }, /brick mortar is the joint width/);
  failing({ height: { brick: { output: 'shine' } } }, /brick output must be one of mortar, edge, cell/);
  failing({ height: { whiteNoise: { scale: 100 } } }, /whiteNoise scale must be a whole number from 1 to 64/);
  failing({ height: { whiteNoise: { output: 'rgb' } } }, /whiteNoise output must be one of value, color/);
});

test('a graph with the new nodes bakes on box mapping without UVs and counts toward the work budget', () => {
  const pattern = normalizeMaterialPattern({
    type: 'graph', resolution: 256, size: 2,
    graph: {
      color: { ramp: { value: { brick: { columns: 4, rows: 4, output: 'cell' } }, stops: [[0, [0.4, 0.1, 0.05]], [1, [0.7, 0.3, 0.2]]] } },
      height: { invert: { brick: { columns: 4, rows: 4, mortar: 0.1 } } },
    },
  });
  assert.equal(pattern.mapping, undefined, 'box mapping, so the mesh needs no UVs');
  const first = bakeMaterialPattern(pattern);
  const second = bakeMaterialPattern(pattern);
  assert.ok(first.map && first.normalMap);
  assert.ok(first.boxMapScale > 0);
  assert.deepEqual(first.map.image.data, second.map.image.data);
  assert.throws(() => normalizeMaterialPattern({
    type: 'graph', resolution: 1024,
    graph: Object.fromEntries(['color', 'roughness', 'metallic', 'height'].map(name => [name, { brick: { columns: 64, rows: 64, at: { mapping: { scale: 2, vector: { mapping: { scale: 2 } } } } } }])),
  }), /work units per pixel|nodes/);
});

test('object coordinates follow the pattern size when baked', () => {
  const graph = { color: { fract: { coord: 'object' } } };
  const small = bakeMaterialPattern(normalizeMaterialPattern({ type: 'graph', resolution: 256, size: 0.5, graph }));
  const large = bakeMaterialPattern(normalizeMaterialPattern({ type: 'graph', resolution: 256, size: 4, graph }));
  assert.notDeepEqual(small.map.image.data, large.map.image.data);
});

test('scene_capabilities lists the new operators and the coordinate topic text', () => {
  const { materialGraph } = AGENT_SCENE_CAPABILITIES;
  for (const operator of ['coord', 'mapping', 'brick', 'whiteNoise']) assert.ok(materialGraph.operators.includes(operator), operator);
  assert.ok(materialGraph.nodes.coordinates.includes('"coord"'));
  assert.ok(materialGraph.nodes.textures.brick && materialGraph.nodes.textures.whiteNoise);
});
