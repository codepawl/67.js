import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentScene } from '../src/agent-scene.js';
import { compileMaterialGraph, bakeMaterialGraph } from '../src/material-graph.js';
import { fresnelSchlick, materialLayerState } from '../src/material-layers.js';
import { renderPathTracedImage } from '../src/path-tracer.js';
import { createFragmentShader } from '../src/shaders.js';
import '../src/material-layer-shaders.js';

const fresnelNode = (ior) => (ior === undefined ? { fresnel: {} } : { fresnel: { ior } });

// Reference values worked out by hand: F0 = ((n - 1) / (n + 1))^2 and F = F0 + (1 - F0) (1 - cos)^5.
test('fresnelSchlick matches the hand-worked curve', () => {
  assert.ok(Math.abs(fresnelSchlick(1, 1.5) - 0.04) < 1e-12);
  assert.equal(fresnelSchlick(0, 1.5), 1);
  assert.ok(Math.abs(fresnelSchlick(0.5, 1.5) - (0.04 + 0.96 * 0.03125)) < 1e-12);
  assert.ok(Math.abs(fresnelSchlick(1, 2) - 1 / 9) < 1e-12);
  assert.equal(fresnelSchlick(-0.3, 1.5), 1);
  assert.ok(Math.abs(fresnelSchlick(7, 1.5) - 0.04) < 1e-12);
});

test('fresnel alone or in a mul becomes a render-time factor and bakes the rest of the emission', () => {
  assert.equal(compileMaterialGraph({ emission: fresnelNode() }).emissionFresnel, 1.5);
  assert.equal(compileMaterialGraph({ emission: fresnelNode(1.33) }).emissionFresnel, 1.33);
  const product = compileMaterialGraph({ emission: { mul: [[1, 0.5, 0.25], fresnelNode(2)] } });
  assert.equal(product.emissionFresnel, 2);
  assert.deepEqual(product.outputs.emission.parts.map(part => part(0.5, 0.5)), [1, 0.5, 0.25]);
  const reversed = compileMaterialGraph({ emission: { mul: [fresnelNode(2), 0.25] } });
  assert.equal(reversed.emissionFresnel, 2);
  assert.equal(reversed.outputs.emission.evaluate(0.5, 0.5), 0.25);
  assert.equal(compileMaterialGraph({ emission: 1 }).emissionFresnel, undefined);
});

test('a baked graph carries the IOR next to its emission map, and no fresnel leaves the default bake unchanged', () => {
  const withFresnel = bakeMaterialGraph({ emission: { mul: [[1, 0.5, 0.25], fresnelNode(1.8)] } }, { resolution: 8, bump: 1 });
  assert.equal(withFresnel.emissionFresnel, 1.8);
  assert.ok(withFresnel.emissiveMap);
  const plain = bakeMaterialGraph({ emission: [1, 0.5, 0.25] }, { resolution: 8, bump: 1 });
  assert.equal(plain.emissionFresnel, undefined);
  assert.deepEqual(Array.from(plain.emissiveMap.image.data), Array.from(withFresnel.emissiveMap.image.data));
});

test('fresnel is checked at the boundary and refused outside emission', () => {
  assert.throws(() => compileMaterialGraph({ emission: fresnelNode(0.5) }), /fresnel ior must be a number from 1.01 to 3/);
  assert.throws(() => compileMaterialGraph({ emission: fresnelNode(4) }), /fresnel ior must be a number from 1.01 to 3/);
  assert.throws(() => compileMaterialGraph({ emission: { fresnel: { ior: 'glass' } } }), /fresnel ior/);
  assert.throws(() => compileMaterialGraph({ emission: { fresnel: { power: 2 } } }), /power/);
  assert.throws(() => compileMaterialGraph({ roughness: fresnelNode() }), /only works as a factor of emission/);
  assert.throws(() => compileMaterialGraph({ color: { mul: [[1, 1, 1], fresnelNode()] } }), /only works as a factor of emission/);
  assert.throws(() => compileMaterialGraph({ emission: { add: [1, fresnelNode()] } }), /only works as a factor of emission/);
  assert.throws(() => compileMaterialGraph({ emission: { mul: [fresnelNode(), fresnelNode()] } }), /only works as a factor of emission/);
});

function recipeWithFresnel(ior) {
  return {
    format: '67js.scene', schemaVersion: 1,
    geometries: [{ id: 'block', type: 'box', bevel: 0 }],
    materials: [{ id: 'rim', emissiveColor: [1, 1, 1], pattern: { type: 'graph', graph: { emission: { mul: [[1, 1, 1], fresnelNode(ior)] } }, mapping: 'uv', resolution: 256 } }],
    nodes: [{ id: 'part', geometry: 'block', material: 'rim' }],
  };
}

test('a recipe material exposes the factor, the renderer state carries it and the shader splices it in', () => {
  const { material } = createAgentScene(recipeWithFresnel(1.7)).parts[0];
  assert.equal(material.emissionFresnel, 1.7);
  assert.equal(materialLayerState(material)[24], 1.7);
  assert.equal(materialLayerState({}).at(24), 0);
  const shader = createFragmentShader(['emissionFresnel']);
  assert.match(shader, /uniform float materialEmissionFresnel/);
  assert.match(shader, /emission \*= emissionNormalIncidence \+ \(1\.0 - emissionNormalIncidence\) \* pow\(1\.0 - clamp\(dot\(normal, viewDirection\), 0\.0, 1\.0\), 5\.0\)/);
  assert.doesNotMatch(createFragmentShader([]), /materialEmissionFresnel/);
});

function groundParts(emissionFresnel) {
  const half = 20;
  const geometry = {
    positions: new Float32Array([-half, 0, half, half, 0, half, half, 0, -half, -half, 0, -half]),
    normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]),
    uvs: new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  };
  return [{ name: 'ground', geometry, material: { tag: 'surface', metallic: 0, roughness: 1, color: [0, 0, 0], emission: 2, emissiveColor: [1, 1, 1], emissionFresnel } }];
}

async function centerRadiance(eye, emissionFresnel) {
  const camera = { eye, target: [0, 0, 0], up: [0, 0, -1], fov: 4 };
  const { linear } = await renderPathTracedImage({ parts: groundParts(emissionFresnel), environment: {}, camera }, { width: 16, height: 16, denoise: false, threads: 1, bounces: 1, samples: 1 });
  return linear[(8 * 16 + 8) * 3];
}

test('the CPU path tracer scales emission by the reference curve at the view angle', async () => {
  const straightDown = await centerRadiance([0, 3, 0], 1.5);
  assert.ok(Math.abs(straightDown - 2 * 0.04) < 1e-5, `facing ${straightDown}`);
  const slanted = await centerRadiance([4, 4, 0], 1.5);
  const expected = 2 * fresnelSchlick(Math.SQRT1_2, 1.5);
  assert.ok(Math.abs(slanted - expected) < 5e-3, `45 degrees ${slanted} against ${expected}`);
  const grazing = await centerRadiance([40, 1, 0], 2);
  assert.ok(grazing > 2 * 0.5, `grazing ${grazing}`);
  const unchanged = await centerRadiance([0, 3, 0], undefined);
  assert.equal(unchanged, 2);
});
