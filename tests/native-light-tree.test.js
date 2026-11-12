import assert from 'node:assert/strict';
import test from 'node:test';
import { STRUCT_STRIDES_V2, buildNativeInputV2 } from '../packages/render-native/index.mjs';
import { NO_TREE_ROOT } from '../packages/render-native/light-tree-v2.mjs';
import { createCamera } from '../src/path-tracer.js';
import { buildTraceScene } from '../src/path-tracer-scene.js';

const KERNEL_FLAGS_WORD = 8;
const FLAG_USE_LIGHT_TREE = 1;
const FLAG_PCG_SAMPLER = 64;
const FLAG_USE_EMISSIVE_LIGHT_TREE = 128;

function floorGeometry() {
  return {
    positions: new Float32Array([-4, 0, -4, 4, 0, -4, 4, 0, 4, -4, 0, 4]),
    normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]),
    uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
    colors: new Float32Array(12).fill(1),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  };
}

function pointLights(count) {
  return Array.from({ length: count }, (_, index) => ({
    position: [(index % 5) - 2, 1 + (index % 3) * 0.5, Math.floor(index / 5) - 2],
    color: [1, 0.9, 0.8],
    intensity: 1 + index,
    radius: 0.05,
  }));
}

function pack(environment, options = {}, parts = [{ name: 'floor', geometry: floorGeometry(), material: { color: [0.5, 0.5, 0.5] } }]) {
  const scene = buildTraceScene(parts, environment);
  const camera = createCamera({ eye: [0, 2, 6], target: [0, 0, 0], fov: 45 }, 32, 16);
  return buildNativeInputV2(scene, camera, { width: 32, height: 16, samples: 4, ...options });
}

function kernelFlags(input) {
  return new Uint32Array(input.kernelParams.buffer, input.kernelParams.byteOffset, STRUCT_STRIDES_V2.kernelParams / 4)[KERNEL_FLAGS_WORD];
}

function nodeViews(input) {
  const stride = STRUCT_STRIDES_V2.lightTreeNode;
  return Array.from({ length: input.lightTreeNodeCount }, (_, index) => {
    const offset = input.lightTreeNodes.byteOffset + index * stride;
    return {
      f32: new Float32Array(input.lightTreeNodes.buffer, offset, stride / 4),
      i32: new Int32Array(input.lightTreeNodes.buffer, offset, stride / 4),
      u32: new Uint32Array(input.lightTreeNodes.buffer, offset, stride / 4),
    };
  });
}

function parentOf(node) {
  return node.i32[12] < 0 ? -1 - node.i32[12] : node.u32[14] & 0xffff;
}

test('the Sobol-Burley sampler is the default and sampler "pcg" sets the opt-out flag', () => {
  assert.equal(kernelFlags(pack({})) & FLAG_PCG_SAMPLER, 0);
  assert.equal(kernelFlags(pack({}, { sampler: 'sobol' })) & FLAG_PCG_SAMPLER, 0);
  assert.equal(kernelFlags(pack({}, { sampler: 'pcg' })) & FLAG_PCG_SAMPLER, FLAG_PCG_SAMPLER);
  assert.throws(() => pack({}, { sampler: 'halton' }), /sampler.*sobol.*pcg/);
});

test('a scene with few lights keeps the cumulative pick, and useLightTree forces or forbids the tree', () => {
  const environment = { pointLights: pointLights(3) };
  assert.equal(pack(environment).lightTreeNodeCount, 0);
  assert.equal(kernelFlags(pack(environment)) & FLAG_USE_LIGHT_TREE, 0);
  assert.equal(pack(environment, { useLightTree: true }).lightTreeNodeCount, 1 + 5);
  assert.equal(pack({ pointLights: pointLights(20) }, { useLightTree: false }).lightTreeNodeCount, 0);
  assert.throws(() => pack(environment, { useLightTree: 'yes' }), /useLightTree/);
});

test('the analytic light tree links every light to the root through its parents and sums their energy', () => {
  const lightCount = 20;
  const input = pack({ pointLights: pointLights(lightCount) });
  assert.equal(kernelFlags(input) & FLAG_USE_LIGHT_TREE, FLAG_USE_LIGHT_TREE);
  assert.equal(kernelFlags(input) & FLAG_USE_EMISSIVE_LIGHT_TREE, 0);
  assert.equal(input.lightTreeNodeCount, 1 + (2 * lightCount - 1));

  const nodes = nodeViews(input);
  const analyticRoot = nodes[0].i32[12];
  assert.equal(nodes[0].u32[13], NO_TREE_ROOT, 'no emissive tree');
  assert.equal(parentOf(nodes[analyticRoot]), 0, 'the root hangs off the directory node');

  let leafEnergy = 0;
  for (let lightIndex = 0; lightIndex < lightCount; lightIndex++) {
    const leaf = nodes[1 + lightIndex];
    assert.ok(leaf.i32[12] < 0, 'leaf marker');
    assert.equal(leaf.u32[13], lightIndex, 'leaf stores its light index');
    leafEnergy += leaf.f32[3];
    let current = 1 + lightIndex;
    for (let depth = 0; current !== analyticRoot; depth++) {
      assert.ok(depth < 32, 'chain reaches the root');
      const parent = parentOf(nodes[current]);
      assert.ok(parent > 0, 'parent is a real node');
      const children = [nodes[parent].i32[12], nodes[parent].u32[13]];
      assert.ok(children.includes(current), 'the parent lists the child');
      current = parent;
    }
  }
  assert.ok(leafEnergy > 0);
  assert.ok(Math.abs(nodes[analyticRoot].f32[3] - leafEnergy) <= leafEnergy * 1e-5, 'root energy is the sum of the leaves');
});

test('a sun, or light-linking masks, keep the analytic lights on the cumulative pick', () => {
  const withSun = pack({ pointLights: pointLights(20), keyColor: [3, 3, 3], lightDirection: [0, 1, 0] });
  assert.equal(kernelFlags(withSun) & FLAG_USE_LIGHT_TREE, 0);
  assert.equal(withSun.lightTreeNodeCount, 0);
});

test('emissive triangles get their own tree, found through the directory node', () => {
  const emissivePanels = Array.from({ length: 12 }, (_, index) => {
    const geometry = floorGeometry();
    geometry.positions = geometry.positions.map((value, position) => (position % 3 === 1 ? 3 : value * 0.1 + (index - 6) * 0.6));
    return { name: `panel-${index}`, geometry, material: { color: [0.5, 0.5, 0.5], emission: 5 } };
  });
  const input = pack({}, {}, emissivePanels);
  assert.equal(kernelFlags(input) & FLAG_USE_EMISSIVE_LIGHT_TREE, FLAG_USE_EMISSIVE_LIGHT_TREE);
  assert.equal(kernelFlags(input) & FLAG_USE_LIGHT_TREE, 0);
  assert.equal(input.emissiveTriangleCount, 24);

  const nodes = nodeViews(input);
  const emissiveRoot = nodes[0].u32[13];
  const leafBase = nodes[0].u32[15];
  assert.notEqual(emissiveRoot, NO_TREE_ROOT);
  assert.equal(leafBase, 1);
  for (let triangle = 0; triangle < input.emissiveTriangleCount; triangle++) {
    let current = leafBase + triangle;
    assert.equal(nodes[current].u32[13], triangle);
    for (let depth = 0; current !== emissiveRoot; depth++) {
      assert.ok(depth < 32);
      current = parentOf(nodes[current]);
    }
  }
});
