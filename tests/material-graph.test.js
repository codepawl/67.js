import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { bakeMaterialPattern, materialPatternTextures, normalizeMaterialPattern } from '../src/material-patterns.js';
import { compileMaterialGraph } from '../src/material-graph.js';
import { AGENT_SCENE_CAPABILITIES, MATERIAL_GRAPH_LIMITS, MATERIAL_GRAPH_OPERATORS } from '../src/agent-scene-capabilities.js';
import { createAgentScene } from '../src/agent-scene.js';
import { exportGlb } from '../src/export.js';

const brickGraph = {
  color: {
    ramp: {
      value: { add: [{ mul: [{ noise: { scale: 8, seed: 3 } }, 0.5] }, { mul: [{ wave: { frequency: 4, direction: 'v', shape: 'saw' } }, 0.5] }] },
      stops: [[0, [0.15, 0.05, 0.03]], [1, [0.6, 0.25, 0.15]]],
    },
  },
  roughness: { mix: [0.6, 0.95, { noise: { scale: 16, seed: 5 } }] },
  height: { noise: { scale: 12, seed: 9 } },
};

const graphPattern = (overrides = {}) => ({ type: 'graph', graph: brickGraph, resolution: 256, ...overrides });

function sha(baked) {
  const hash = createHash('sha256');
  for (const channel of ['map', 'normalMap', 'metallicRoughnessMap', 'emissiveMap']) {
    if (baked[channel]) hash.update(Buffer.from(baked[channel].image.data));
  }
  return hash.digest('hex');
}

function glbJson(bytes) {
  const array = new Uint8Array(bytes);
  const view = new DataView(array.buffer, array.byteOffset, array.byteLength);
  const length = view.getUint32(12, true);
  return JSON.parse(new TextDecoder().decode(array.subarray(20, 20 + length)));
}

function checkerboardSum(image) {
  let total = 0;
  for (const byte of image.data) total += byte;
  return total;
}

test('a graph bakes the outputs it has, and only those', () => {
  const baked = bakeMaterialPattern(normalizeMaterialPattern(graphPattern()));
  assert.equal(baked.map.colorSpace, 'srgb');
  assert.equal(baked.metallicRoughnessMap.colorSpace, 'linear');
  assert.equal(baked.normalMap.colorSpace, 'linear');
  assert.equal(baked.emissiveMap, undefined);
  const colorOnly = bakeMaterialPattern(normalizeMaterialPattern({ type: 'graph', graph: { color: [1, 0, 0] }, resolution: 256 }));
  assert.equal(colorOnly.normalMap, undefined);
  assert.equal(colorOnly.metallicRoughnessMap, undefined);
  assert.equal(colorOnly.map.image.data[0], 255);
  assert.equal(colorOnly.map.image.data[1], 0);
});

test('a baked graph is identical bytes every time', () => {
  const first = sha(bakeMaterialPattern(normalizeMaterialPattern(graphPattern())));
  const second = sha(bakeMaterialPattern(normalizeMaterialPattern(graphPattern())));
  assert.equal(first, second);
  const reseeded = structuredClone(brickGraph);
  reseeded.height.noise.seed = 10;
  assert.notEqual(sha(bakeMaterialPattern(normalizeMaterialPattern(graphPattern({ graph: reseeded })))), first);
});

test('height becomes a normal map: flat height is a flat normal, relief tilts it', () => {
  const flat = bakeMaterialPattern(normalizeMaterialPattern({ type: 'graph', graph: { height: 0.5 }, resolution: 256 }));
  assert.deepEqual(Array.from(flat.normalMap.image.data.slice(0, 3)), [128, 128, 255]);
  const ridge = bakeMaterialPattern(normalizeMaterialPattern({ type: 'graph', graph: { height: { wave: { frequency: 4 } } }, resolution: 256, bump: 2 }));
  const tilted = Array.from({ length: 256 }, (_, column) => ridge.normalMap.image.data[column * 4]);
  assert.ok(Math.max(...tilted) - Math.min(...tilted) > 40);
});

test('a height ramp tilts the normal by bump / 32 per UV unit at any resolution, the sign pointing downhill', () => {
  for (const resolution of [256, 512]) {
    const ramp = bakeMaterialPattern(normalizeMaterialPattern({ type: 'graph', graph: { height: { uv: 'u' } }, resolution, bump: 4 }));
    const { data } = ramp.normalMap.image;
    const slope = 4 / 32;
    const length = Math.hypot(slope, 1);
    const offset = (Math.floor(resolution / 2) * resolution + Math.floor(resolution / 2)) * 4;
    assert.equal(data[offset], Math.round((-slope / length * 0.5 + 0.5) * 255));
    assert.equal(data[offset + 1], 128);
    assert.equal(data[offset + 2], Math.round((1 / length * 0.5 + 0.5) * 255));
  }
});

test('the slope of a sharp joint edge stays within one texel of the edge instead of spreading over three', () => {
  const resolution = 256;
  const step = { smoothstep: [0.5, 0.5 + 1 / resolution, { uv: 'u' }] };
  const edge = bakeMaterialPattern(normalizeMaterialPattern({ type: 'graph', graph: { height: step }, resolution, bump: 1 }));
  const tiltedColumns = Array.from({ length: resolution }, (_, column) => column).filter(column => edge.normalMap.image.data[(10 * resolution + column) * 4] !== 128);
  assert.ok(tiltedColumns.length <= 2, `${tiltedColumns.length} texels are tilted`);
});

test('every graph texture node tiles across the seam', () => {
  const nodes = [{ noise: { scale: 6 } }, { voronoi: { scale: 5, output: 'edge' } }, { wave: { frequency: 3, direction: 'diagonal' } }, { checker: { count: 8 } }];
  for (const node of nodes) {
    const { outputs } = compileMaterialGraph({ height: node });
    const evaluate = outputs.height.evaluate;
    const step = 1 / 1024;
    for (const row of [0.13, 0.5, 0.87]) {
      const seam = Math.abs(evaluate(1 - step / 2, row) - evaluate(step / 2, row));
      const interior = Math.abs(evaluate(0.5 + step / 2, row) - evaluate(0.5 - step / 2, row));
      assert.ok(seam < 0.2 + interior, `${Object.keys(node)[0]} seam ${seam}`);
    }
  }
});

test('the noise node returns the values of Blender 5.2 Noise Texture (2D, scale 10, detail 2, roughness 0.5, normalized)', () => {
  // Fac read back from a Cycles bake at these positions (bench/reference/README.md, 2026-11-04).
  const golden = [
    [0.080078125, 0.041015625, 0.439068],
    [0.783203125, 0.236328125, 0.398615],
    [0.501953125, 0.501953125, 0.495776],
    [0.130859375, 0.783203125, 0.461263],
    [0.998046875, 0.998046875, 0.511450],
    [0.978515625, 0.013671875, 0.487824],
  ];
  const { outputs } = compileMaterialGraph({ height: { noise: { scale: 10, octaves: 3, tile: false } } });
  for (const [u, v, expected] of golden) {
    assert.ok(Math.abs(outputs.height.evaluate(u, v) - expected) < 1e-4, `noise at ${u}, ${v}`);
  }
});

test('a noise tiles by default and differs from the endless one (tile false) only near the far edges', () => {
  const endless = compileMaterialGraph({ height: { noise: { scale: 10, octaves: 3, tile: false } } }).outputs.height.evaluate;
  const tiled = compileMaterialGraph({ height: { noise: { scale: 10, octaves: 3 } } }).outputs.height.evaluate;
  assert.ok(Math.abs(tiled(0.4, 0.3) - endless(0.4, 0.3)) < 1e-12);
  assert.ok(Math.abs(tiled(0.4, 0.3) - tiled(1.4, 2.3)) < 1e-9);
  assert.throws(() => compileMaterialGraph({ height: { noise: { tile: 'yes' } } }), /tile/);
});

test('patterns with mapping uv use the geometry UVs from uv_unwrap instead of box projection', () => {
  const recipe = {
    format: '67js.scene', schemaVersion: 1,
    geometries: [{ id: 'crate', type: 'mesh', base: { type: 'box', bevel: 0 }, stack: [{ op: 'uv_unwrap' }] }],
    materials: [{ id: 'wall', pattern: graphPattern({ mapping: 'uv' }) }, { id: 'boxed', pattern: { type: 'wood', resolution: 256 } }],
    nodes: [{ id: 'part', geometry: 'crate', material: 'wall' }],
  };
  const scene = createAgentScene(recipe);
  const [part] = scene.parts;
  assert.equal(part.material.boxMapScale, 0);
  assert.equal(part.geometry.uvs.length, part.geometry.positions.length / 3 * 2);
  assert.equal(scene.exportRecipe().materials[1].pattern.mapping, undefined);
  assert.equal(scene.exportRecipe().materials[0].pattern.mapping, 'uv');
  assert.ok(part.material.map && part.material.normalMap && part.material.metallicRoughnessMap);
  assert.equal(part.material.roughness, 1);
  const gltf = glbJson(exportGlb(scene.parts));
  assert.equal(gltf.textures.length, 3);
  assert.ok(gltf.meshes[0].primitives.every(primitive => primitive.attributes.TEXCOORD_0 !== undefined));
  assert.ok(gltf.materials[0].normalTexture);
});

test('a graph that makes emission, roughness or metallic passes it through by default', () => {
  const recipe = {
    format: '67js.scene', schemaVersion: 1,
    geometries: [{ id: 'block', type: 'box', bevel: 0 }],
    materials: [{ id: 'lamp', pattern: { type: 'graph', graph: { emission: { checker: { count: 4 } }, metallic: 1 }, mapping: 'uv', resolution: 256 } }],
    nodes: [{ id: 'part', geometry: 'block', material: 'lamp' }],
  };
  const { material } = createAgentScene(recipe).parts[0];
  assert.equal(material.emission, 1);
  assert.equal(material.metallic, 1);
  assert.equal(material.emissiveMap.colorSpace, 'srgb');
});

test('graph and preset fields do not mix', () => {
  assert.throws(() => normalizeMaterialPattern({ type: 'graph' }), /graph must be an object/);
  assert.throws(() => normalizeMaterialPattern({ type: 'wood', graph: { height: 1 } }), /unless its type is graph/);
  assert.throws(() => normalizeMaterialPattern({ type: 'graph', graph: { height: 1 }, colors: [[0, 0, 0], [1, 1, 1]] }), /does not take colors/);
  assert.throws(() => normalizeMaterialPattern({ type: 'wood', mapping: 'planar' }), /mapping must be one of/);
  const normalized = normalizeMaterialPattern(graphPattern({ mapping: 'uv' }));
  assert.deepEqual(normalizeMaterialPattern(normalized), normalized);
  assert.equal(Object.hasOwn(normalizeMaterialPattern({ type: 'wood' }), 'mapping'), false);
});

test('every capability operator compiles, and no other operator does', () => {
  const samples = {
    uv: { uv: 'u' }, image: { image: { asset: 'a'.repeat(64) } }, coord: { coord: 'object' }, mapping: { mapping: {} }, whiteNoise: { whiteNoise: {} }, brick: { brick: {} }, vec: { vec: [1, 2, 3] }, ramp: { ramp: { value: 0.5, stops: [[0, 0], [1, 1]] } },
    noise: { noise: {} }, voronoi: { voronoi: {} }, wave: { wave: {} }, checker: { checker: {} }, gradient: { gradient: {} },
    layer: { layer: { base: [0, 0, 0], top: [1, 1, 1], mask: 0.5 } }, hue: { hue: { color: [1, 0, 0], shift: 0.1 } }, curve: { curve: { value: 0.5, points: [[0, 0], [1, 1]] } },
  };
  for (const name of MATERIAL_GRAPH_OPERATORS) {
    const node = samples[name] ?? (['abs', 'floor', 'fract', 'sqrt', 'invert'].includes(name) ? { [name]: 0.5 } : { [name]: [0.2, 0.4, 0.6].slice(0, ['clamp', 'smoothstep', 'mix'].includes(name) ? 3 : 2) });
    assert.doesNotThrow(() => compileMaterialGraph({ color: node }), name);
  }
  assert.deepEqual(AGENT_SCENE_CAPABILITIES.materialGraph.operators, MATERIAL_GRAPH_OPERATORS);
  assert.equal(AGENT_SCENE_CAPABILITIES.materialGraph.maxNodes, MATERIAL_GRAPH_LIMITS.maxNodes);
});

// ---------------------------------------------------------------------------------------------------------------
// Boundary: a graph is data. Every hostile input is rejected before any pixel is evaluated, or is inert.

function nested(depth) {
  let node = 0.5;
  for (let level = 0; level < depth; level++) node = { abs: node };
  return node;
}

test('hostile graphs are rejected', () => {
  const cycle = { abs: null };
  cycle.abs = cycle;
  const wide = { add: [0, 0] };
  for (let index = 0; index < MATERIAL_GRAPH_LIMITS.maxNodes; index++) wide.add[0] = { add: [wide.add[0], 1] };
  const hostile = {
    'proto key': JSON.parse('{"height":{"__proto__":{"abs":1}}}'),
    'proto output': JSON.parse('{"__proto__":{"height":1}}'),
    'constructor operator': { height: { constructor: [1, 2] } },
    'prototype operator': { height: { toString: [1] } },
    'inherited operator name': { height: { hasOwnProperty: 1 } },
    'cycle': { height: cycle },
    'deep nesting': { height: nested(MATERIAL_GRAPH_LIMITS.maxDepth + 5) },
    'too many nodes': { height: wide },
    'glsl as an operator': { height: { 'void main(){discard;}': 1 } },
    'glsl as a value': { height: 'void main() { gl_FragColor = vec4(1.0); }' },
    'glsl in an enum': { height: { wave: { direction: 'u; discard;' } } },
    'glsl as an output name': { 'gl_Position = vec4(0)': 1 },
    'shader injected in at': { height: { noise: { at: '1.0); evil(' } } },
    'function value': { height: () => 1 },
    'huge noise scale': { height: { noise: { scale: 1e9 } } },
    'fractional scale': { height: { noise: { scale: 2.5 } } },
    'octave bomb': { height: { noise: { octaves: 1000 } } },
    'odd checker': { height: { checker: { count: 7 } } },
    'huge literal': { height: 1e300 },
    'not a number': { height: Number.NaN },
    'infinite': { height: Number.POSITIVE_INFINITY },
    'vector for a scalar output': { height: [1, 2, 3] },
    'extra operator key': { height: { abs: 1, floor: 2 } },
    'ramp out of order': { color: { ramp: { value: 0.5, stops: [[0.8, 0], [0.2, 1]] } } },
    'ramp too long': { color: { ramp: { value: 0.5, stops: Array.from({ length: 40 }, (_, index) => [index / 40, 0]) } } },
    'empty': {},
    'array': [],
    'string graph': 'noise',
  };
  for (const [name, graph] of Object.entries(hostile)) {
    assert.throws(() => normalizeMaterialPattern({ type: 'graph', graph, resolution: 256 }), Error, name);
  }
});

test('hostile sizes and costs are rejected before any work', () => {
  assert.throws(() => normalizeMaterialPattern({ type: 'graph', graph: { height: 1 }, resolution: 100000 }), /resolution must be one of/);
  assert.throws(() => normalizeMaterialPattern({ type: 'graph', graph: { height: 1 }, resolution: '512' }), /resolution must be one of/);
  const costly = { height: { voronoi: { scale: 8, at: { add: [{ uv: 'both' }, { mul: [{ vec: [{ noise: { octaves: 6 } }, { noise: { octaves: 6 } }, 0] }, 0.1] }] } } } };
  let graph = costly.height;
  for (let level = 0; level < 5; level++) graph = { add: [graph, { voronoi: { scale: 4, at: { vec: [graph, 0, 0] } } }] };
  // The limits reject the graph while it is normalized, before any pixel is evaluated, so no clock is involved.
  assert.throws(
    () => normalizeMaterialPattern({ type: 'graph', graph: { height: graph }, resolution: 1024 }),
    error => /^Material graph: nesting deeper than/.test(error.message),
  );
});

test('hostile strings never reach a texture, a recipe or a shader', () => {
  const marker = 'discard;';
  const accepted = normalizeMaterialPattern({ type: 'graph', graph: { height: { noise: { scale: 4 } } }, resolution: 256 });
  assert.equal(JSON.stringify(accepted).includes(marker), false);
  const recipe = {
    format: '67js.scene', schemaVersion: 1, geometries: [{ id: 'block', type: 'box', bevel: 0 }],
    materials: [{ id: 'bad', pattern: { type: 'graph', graph: { color: { wave: { direction: marker } } } } }],
    nodes: [{ id: 'part', geometry: 'block', material: 'bad' }],
  };
  assert.throws(() => createAgentScene(recipe), /wave direction/);
});

test('math nodes compute the numbers they name, on numbers and on vectors', () => {
  const value = node => compileMaterialGraph({ color: node }).outputs.color;
  const scalarAt = node => value(node).evaluate(0.25, 0.75);
  assert.equal(scalarAt({ min: [0.3, 0.2] }), 0.2);
  assert.equal(scalarAt({ max: [0.3, 0.2] }), 0.3);
  assert.equal(scalarAt({ add: [{ uv: 'u' }, { uv: 'v' }] }), 1);
  assert.equal(scalarAt({ invert: 0.25 }), 0.75);
  assert.equal(scalarAt({ fract: 2.75 }), 0.75);
  assert.equal(scalarAt({ clamp: [5, 0, 1] }), 1);
  assert.equal(scalarAt({ mix: [2, 4, 0.25] }), 2.5);
  assert.equal(scalarAt({ div: [1, 0] }), 0);
  const mixed = value({ mix: [[0, 0, 0], [1, 0.5, 0.25], 0.5] });
  assert.deepEqual(mixed.parts.map(part => part(0, 0)), [0.5, 0.25, 0.125]);
});

test('the same graph shares one baked texture set across materials', () => {
  const pattern = normalizeMaterialPattern(graphPattern());
  assert.equal(materialPatternTextures(pattern), materialPatternTextures(pattern));
  assert.ok(checkerboardSum(materialPatternTextures(pattern).map.image) > 0);
});

test('graph errors name the valid options, and scene_capabilities lists the nodes an agent can use', () => {
  assert.throws(() => compileMaterialGraph({ color: { glow: 1 } }), /unknown operator "glow"\. Use one of uv, coord, mapping, vec, ramp/);
  assert.throws(() => compileMaterialGraph({ shine: 1 }), /color, roughness, metallic, emission, height/);
  assert.throws(() => compileMaterialGraph({ color: { noise: { size: 4 } } }), /does not take "size"; fields: /);
  assert.throws(() => compileMaterialGraph({ color: { wave: { frequency: 4, shape: 'square' } } }), /must be one of sine, saw, triangle/);
  const { nodes } = AGENT_SCENE_CAPABILITIES.materialGraph;
  assert.ok(nodes.textures.noise.includes('"noise"'));
  const documented = JSON.stringify(nodes);
  for (const operator of MATERIAL_GRAPH_OPERATORS) {
    assert.ok(documented.includes(operator), `${operator} is documented in scene_capabilities`);
  }
});
