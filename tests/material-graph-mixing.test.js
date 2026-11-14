import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { bakeMaterialPattern, normalizeMaterialPattern } from '../src/material-patterns.js';
import { compileMaterialGraph } from '../src/material-graph.js';
import { AGENT_SCENE_CAPABILITIES } from '../src/agent-scene-capabilities.js';
import { createAgentScene } from '../src/agent-scene.js';
import { describeIgnoredFeatures } from '../src/path-tracer.js';

const RUST = [0.45, 0.18, 0.06];
const PAINT = [0.1, 0.35, 0.7];
const chippedPaint = { curve: { value: { noise: { scale: 6, seed: 4 } }, points: [[0.2, 0], [0.8, 1]] } };

// Blue paint over rust: the paint covers where the chip mask is high, rust shows through where it chipped.
const paintedOverRust = {
  color: { layer: { base: RUST, top: PAINT, mask: chippedPaint, edge: 0.5, softness: 0.05 } },
  roughness: { layer: { base: 0.95, top: 0.3, mask: chippedPaint, edge: 0.5, softness: 0.05 } },
  clearcoat: { layer: { base: 0, top: 1, mask: chippedPaint, edge: 0.5, softness: 0.05 } },
};

function evaluate(graph, output, u = 0.3, v = 0.6) {
  const compiled = compileMaterialGraph(graph).outputs[output];
  return compiled.kind === 'vector' ? compiled.parts.map(part => part(u, v)) : compiled.evaluate(u, v);
}

test('layer puts the top over the base where the mask passes the edge', () => {
  const graph = mask => ({ color: { layer: { base: [1, 0, 0], top: [0, 0, 1], mask, edge: 0.5, softness: 0 } } });
  assert.deepEqual(evaluate(graph(0.2), 'color'), [1, 0, 0]);
  assert.deepEqual(evaluate(graph(0.9), 'color'), [0, 0, 1]);
  assert.throws(() => compileMaterialGraph({ color: { layer: { base: 1, top: 0 } } }), /needs "mask"/);
  assert.throws(() => compileMaterialGraph({ color: { layer: { base: 1, top: 0, mask: [1, 1, 1] } } }), /mask" needs a number/);
});

test('hue shifts a colour around the wheel and curve remaps with straight segments', () => {
  const [red, green, blue] = evaluate({ color: { hue: { color: [1, 0, 0], shift: 1 / 3 } } }, 'color');
  assert.ok(green > 0.99 && red < 0.01 && blue < 0.01);
  assert.deepEqual(evaluate({ color: { hue: { color: [0.5, 0.5, 0.5], shift: 0.4 } } }, 'color'), [0.5, 0.5, 0.5]);
  const curve = value => evaluate({ height: { curve: { value, points: [[0, 0], [0.5, 1], [1, 0.5]] } } }, 'height');
  assert.equal(curve(0.25), 0.5);
  assert.equal(curve(0.75), 0.75);
  assert.equal(curve(-3), 0);
  assert.throws(() => compileMaterialGraph({ height: { curve: { value: 0.5, points: [[0, 0], [0, 1]] } } }), /x rising/);
});

test('opacity bakes into base texture alpha, clearcoat and transmission into red channel masks', () => {
  const baked = bakeMaterialPattern(normalizeMaterialPattern({
    type: 'graph', resolution: 256,
    graph: { color: PAINT, opacity: { uv: 'u' }, clearcoat: { uv: 'v' }, transmission: 0.5 },
  }));
  const pixel = (descriptor, column, row) => descriptor.image.data.slice((row * 256 + column) * 4, (row * 256 + column) * 4 + 4);
  assert.equal(pixel(baked.map, 0, 100)[3], 0);
  assert.ok(pixel(baked.map, 255, 100)[3] >= 254);
  assert.equal(pixel(baked.layerMaps.clearcoatTexture, 10, 0)[0], 0);
  assert.ok(pixel(baked.layerMaps.clearcoatTexture, 10, 255)[0] >= 254);
  assert.equal(pixel(baked.transmissionMap, 10, 10)[0], 128);
  assert.equal(baked.layerMaps.clearcoatTexture.colorSpace, 'linear');
  const opacityOnly = bakeMaterialPattern(normalizeMaterialPattern({ type: 'graph', resolution: 256, graph: { opacity: 0.5 } }));
  assert.deepEqual([...pixel(opacityOnly.map, 3, 3)], [255, 255, 255, 128]);
  assert.equal(opacityOnly.layerMaps, undefined);
});

test('a painted-over-rust material renders from one recipe', () => {
  const recipe = {
    format: 'crucible.scene', schemaVersion: 1,
    materials: [{ id: 'worn-paint', pattern: { type: 'graph', graph: paintedOverRust, resolution: 256 } }],
    geometries: [{ id: 'panel', type: 'mesh', base: { type: 'box', bevel: 0 } }],
    nodes: [{ id: 'panel', geometry: 'panel', material: 'worn-paint' }],
  };
  const { material } = createAgentScene(recipe).parts[0];
  assert.equal(material.clearcoat, 1);
  assert.equal(material.roughness, 1);
  assert.ok(material.layerMaps.clearcoatTexture.image);
  const data = material.map.image.data;
  let rustPixels = 0;
  let paintPixels = 0;
  for (let index = 0; index < data.length; index += 4) {
    if (data[index] > data[index + 2]) rustPixels++;
    else paintPixels++;
  }
  assert.ok(rustPixels > 1000 && paintPixels > 1000, `both layers show: rust ${rustPixels}, paint ${paintPixels}`);
  const coat = material.layerMaps.clearcoatTexture.image.data;
  const roughness = material.metallicRoughnessMap.image.data;
  let checked = 0;
  for (let index = 0; index < coat.length; index += 4 * 97) {
    // Pixels inside the soft edge blend both layers, so only fully covered or fully chipped ones are compared.
    if (coat[index] !== 0 && coat[index] !== 255) continue;
    const painted = coat[index] === 255;
    assert.equal(data[index] < data[index + 2], painted, 'paint is blue, rust is red');
    assert.equal(roughness[index + 1] < 128, painted, 'the paint is smoother than the rust');
    checked++;
  }
  assert.ok(checked > 100);
});

test('opacity blends the material, and the tracer cuts it out and says what it ignores', () => {
  const recipe = {
    format: 'crucible.scene', schemaVersion: 1,
    materials: [{ id: 'veil', pattern: { type: 'graph', graph: { color: PAINT, opacity: { uv: 'u' }, transmission: 0.5 }, resolution: 256 } }],
    geometries: [{ id: 'panel', type: 'mesh', base: { type: 'box', bevel: 0 } }],
    nodes: [{ id: 'panel', geometry: 'panel', material: 'veil' }],
  };
  const { parts } = createAgentScene(recipe);
  assert.equal(parts[0].material.alphaMode, 'blend');
  assert.equal(parts[0].material.transmission, 1);
  const notes = describeIgnoredFeatures(parts, {});
  assert.ok(notes.some(note => /graph opacity output is traced as a cutout/.test(note)));
  assert.ok(notes.some(note => /clearcoat and transmission masks are read by the CPU tracer/.test(note)));
});

test('describeIgnoredFeatures names a fresnel emission factor on the GPU backends only', () => {
  const parts = [{ material: { emission: 1, emissionFresnel: 1.5 } }];
  const fresnelNote = /emission fresnel is ignored by the GPU path tracers/;
  assert.ok(!describeIgnoredFeatures(parts, {}).some(note => fresnelNote.test(note)));
  assert.ok(!describeIgnoredFeatures(parts, {}, 'cpu').some(note => fresnelNote.test(note)));
  assert.ok(describeIgnoredFeatures(parts, {}, 'gpu').some(note => fresnelNote.test(note)));
  assert.ok(describeIgnoredFeatures(parts, {}, 'webgpu').some(note => fresnelNote.test(note)));
  assert.ok(!describeIgnoredFeatures([{ material: { emission: 1 } }], {}, 'gpu').some(note => fresnelNote.test(note)));
});

test('scene_capabilities lists the new outputs and mixing nodes', () => {
  const { outputs, operators, nodes } = AGENT_SCENE_CAPABILITIES.materialGraph;
  for (const name of ['opacity', 'clearcoat', 'transmission']) assert.ok(outputs.includes(name), name);
  for (const name of ['layer', 'hue', 'curve']) {
    assert.ok(operators.includes(name), name);
    assert.ok(nodes.mixing.includes(`"${name}"`), name);
  }
});

test('describeIgnoredFeatures names softFalloff on a point or spot light unless the native cycles kernel draws it', () => {
  const softFalloffNote = /softFalloff is ignored/;
  const softPoint = { pointLights: [{ position: [0, 2, 0], radius: 0.2, softFalloff: true }] };
  const softSpot = { spotLights: [{ position: [0, 2, 0], direction: [0, -1, 0], radius: 0.2, softFalloff: true }] };
  const spherePoint = { pointLights: [{ position: [0, 2, 0], radius: 0.2, softFalloff: false }, { position: [1, 2, 0], radius: 0.2 }] };
  for (const backend of ['cpu', 'gpu', 'webgpu']) {
    assert.ok(describeIgnoredFeatures([], softPoint, backend).some(note => softFalloffNote.test(note)));
    assert.ok(describeIgnoredFeatures([], softSpot, backend).some(note => softFalloffNote.test(note)));
  }
  assert.ok(!describeIgnoredFeatures([], spherePoint).some(note => softFalloffNote.test(note)));
  assert.ok(!describeIgnoredFeatures([], softPoint, 'cpu', { kernelMaterials: true }).some(note => softFalloffNote.test(note)));
});
