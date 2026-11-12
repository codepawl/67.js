import assert from 'node:assert/strict';
import test from 'node:test';
import { STRUCT_STRIDES_V2, buildNativeInputV2, withLightSamplingFlag } from '../packages/render-native/index.mjs';
import { readFileSync } from 'node:fs';
import {
  LIGHT_TREE_EMITTER_BYTES,
  LIGHT_TREE_KERNEL_MAX_LEAF_EMITTERS,
  LIGHT_TREE_MAX_EMITTERS,
  LIGHT_TREE_NODE_BYTES,
  buildLightTree,
  coneMeasure,
  mergeCones,
} from '../packages/render-native/light-tree-v2.mjs';
import { createCamera } from '../src/path-tracer.js';
import { buildTraceScene } from '../src/path-tracer-scene.js';

const LIGHT_BYTES = 128;
const TRIANGLE_BYTES = 96;
const TYPE_POINT = 0;
const TYPE_SPOT = 1;
const TYPE_AREA_RECT = 2;
const TYPE_SUN = 4;
const LEAF_LIMIT = 8;

function createRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function randomDirection(random) {
  const z = random() * 2 - 1;
  const angle = random() * Math.PI * 2;
  const ring = Math.sqrt(1 - z * z);
  return [ring * Math.cos(angle), ring * Math.sin(angle), z];
}

function writeLight(bytes, index, light) {
  const floats = new Float32Array(bytes.buffer, index * LIGHT_BYTES, LIGHT_BYTES / 4);
  const words = new Uint32Array(bytes.buffer, index * LIGHT_BYTES, LIGHT_BYTES / 4);
  floats.set(light.position, 0);
  words[3] = light.type;
  floats.set(light.radiance, 4);
  floats.set(light.direction, 8);
  floats[11] = light.radius ?? 0;
  floats.set(light.axisU ?? [1, 0, 0], 12);
  floats[15] = light.sizeU ?? 0;
  floats.set(light.axisV ?? [0, 1, 0], 16);
  floats[19] = light.sizeV ?? 0;
  floats[20] = light.cosHalfAngle ?? 0;
  floats[22] = light.tanHalfSpread ?? 0;
  floats[24] = light.areaOrSolidAngle ?? 0;
  words[30] = light.maskLow ?? 1;
}

function makeLights(count, seed, { includeSun = false } = {}) {
  const random = createRandom(seed);
  const bytes = new Uint8Array(Math.max(1, count) * LIGHT_BYTES);
  for (let index = 0; index < count; index++) {
    const position = [random() * 40 - 20, random() * 10, random() * 40 - 20];
    const radiance = [0.2 + random() * 5, 0.2 + random() * 5, 0.2 + random() * 5];
    const direction = randomDirection(random);
    const choice = includeSun && index === count - 1 ? 3 : Math.floor(random() * 3);
    if (choice === 0) {
      writeLight(bytes, index, { position, type: TYPE_POINT, radiance, direction, radius: random() * 0.3 });
    } else if (choice === 1) {
      writeLight(bytes, index, {
        position, type: TYPE_SPOT, radiance, direction, radius: 0.05, cosHalfAngle: Math.cos(0.2 + random()),
      });
    } else if (choice === 2) {
      const width = 0.5 + random();
      const height = 0.5 + random();
      writeLight(bytes, index, {
        position, type: TYPE_AREA_RECT, radiance, direction, sizeU: width, sizeV: height, areaOrSolidAngle: width * height,
      });
    } else {
      writeLight(bytes, index, {
        position, type: TYPE_SUN, radiance, direction, cosHalfAngle: Math.cos(0.005), areaOrSolidAngle: 6.8e-5,
      });
    }
  }
  return bytes;
}

function makeTriangles(count, seed) {
  const random = createRandom(seed);
  const bytes = new Uint8Array(Math.max(1, count) * TRIANGLE_BYTES);
  for (let index = 0; index < count; index++) {
    const floats = new Float32Array(bytes.buffer, index * TRIANGLE_BYTES, TRIANGLE_BYTES / 4);
    const words = new Uint32Array(bytes.buffer, index * TRIANGLE_BYTES, TRIANGLE_BYTES / 4);
    const origin = [random() * 40 - 20, random() * 10, random() * 40 - 20];
    const edgeOne = [random() - 0.5, random() - 0.5, random() - 0.5];
    const edgeTwo = [random() - 0.5, random() - 0.5, random() - 0.5];
    const cross = [
      edgeOne[1] * edgeTwo[2] - edgeOne[2] * edgeTwo[1],
      edgeOne[2] * edgeTwo[0] - edgeOne[0] * edgeTwo[2],
      edgeOne[0] * edgeTwo[1] - edgeOne[1] * edgeTwo[0],
    ];
    const crossLength = Math.hypot(...cross);
    floats.set(origin, 0);
    floats[3] = 0.5 * crossLength;
    floats.set(edgeOne, 4);
    floats.set(edgeTwo, 8);
    floats.set(cross.map((value) => value / crossLength), 12);
    floats.set([1 + random() * 4, 1 + random() * 4, 1 + random() * 4], 16);
    words[22] = 1;
  }
  return bytes;
}

function readNode(tree, index) {
  const offset = index * LIGHT_TREE_NODE_BYTES;
  const floats = new Float32Array(tree.nodes.buffer, offset, 16);
  const words = new Uint32Array(tree.nodes.buffer, offset, 16);
  const ints = new Int32Array(tree.nodes.buffer, offset, 16);
  return {
    boxMin: [floats[0], floats[1], floats[2]],
    energy: floats[3],
    boxMax: [floats[4], floats[5], floats[6]],
    thetaO: floats[7],
    axis: [floats[8], floats[9], floats[10]],
    thetaE: floats[11],
    leftChild: ints[12],
    rightOrFirst: words[13],
    count: words[14] & 0xffff,
    isDistant: (words[14] & (1 << 17)) !== 0,
    maskOr: words[15],
    isLeaf: ints[12] < 0,
  };
}

function readEmitter(tree, slot) {
  const offset = slot * LIGHT_TREE_EMITTER_BYTES;
  const floats = new Float32Array(tree.emitters.buffer, offset, 8);
  const words = new Uint32Array(tree.emitters.buffer, offset, 8);
  return {
    energy: floats[0],
    thetaO: floats[1],
    thetaE: floats[2],
    isTriangle: (words[3] & 1) !== 0,
    isDistant: (words[3] & 2) !== 0,
    depth: words[3] >>> 8,
    recordIndex: words[4],
    leafIndex: words[5],
    trailLow: words[6],
    trailHigh: words[7],
  };
}

function normalize(vector) {
  const length = Math.hypot(...vector);
  return vector.map((value) => value / length);
}

function angleBetween(a, b) {
  const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  return Math.acos(Math.min(1, Math.max(-1, dot)));
}

// The geometry of one emitter as the test reads it back from the packed records.
function describeEmitter(lights, triangles, lightCount, unifiedIndex) {
  if (unifiedIndex < lightCount) {
    const floats = new Float32Array(lights.buffer, unifiedIndex * LIGHT_BYTES, LIGHT_BYTES / 4);
    const position = [floats[0], floats[1], floats[2]];
    const type = new Uint32Array(lights.buffer, unifiedIndex * LIGHT_BYTES, 4)[3];
    const direction = normalize([floats[8], floats[9], floats[10]]);
    if (type === TYPE_SUN) {
      return { axis: direction, normal: null, boxMin: null, boxMax: null };
    }
    let extent = [floats[11], floats[11], floats[11]];
    if (type === TYPE_AREA_RECT) {
      extent = [0, 1, 2].map(
        (axis) => 0.5 * floats[15] * Math.abs(floats[12 + axis]) + 0.5 * floats[19] * Math.abs(floats[16 + axis])
      );
    }
    return {
      axis: direction,
      normal: type === TYPE_AREA_RECT || type === TYPE_SPOT ? direction : null,
      normalSlack: 2e-3,
      boxMin: position.map((value, axis) => value - extent[axis]),
      boxMax: position.map((value, axis) => value + extent[axis]),
    };
  }
  const triangleIndex = unifiedIndex - lightCount;
  const floats = new Float32Array(triangles.buffer, triangleIndex * TRIANGLE_BYTES, TRIANGLE_BYTES / 4);
  const origin = [floats[0], floats[1], floats[2]];
  const vertices = [
    origin,
    origin.map((value, axis) => value + floats[4 + axis]),
    origin.map((value, axis) => value + floats[8 + axis]),
  ];
  return {
    axis: normalize([-floats[4], -floats[5], -floats[6]]),
    normal: [floats[12], floats[13], floats[14]],
    // A double-sided triangle cone is centred on an in-plane axis, so its normal is a quarter turn from it.
    normalSlack: Math.PI / 2 + 2e-3,
    boxMin: [0, 1, 2].map((axis) => Math.min(...vertices.map((vertex) => vertex[axis]))),
    boxMax: [0, 1, 2].map((axis) => Math.max(...vertices.map((vertex) => vertex[axis]))),
  };
}

function boxInside(innerMin, innerMax, outerMin, outerMax, slack = 1e-4) {
  return [0, 1, 2].every(
    (axis) => innerMin[axis] >= outerMin[axis] - slack && innerMax[axis] <= outerMax[axis] + slack
  );
}

// Walks the whole tree and returns every leaf with the chain of ancestors above it.
function collectLeaves(tree) {
  const leaves = [];
  const visit = (nodeIndex, ancestors, depth, trailLow) => {
    const node = readNode(tree, nodeIndex);
    if (node.isLeaf) {
      leaves.push({ nodeIndex, node, ancestors, depth, trailLow });
      return;
    }
    visit(node.leftChild, [...ancestors, nodeIndex], depth + 1, trailLow);
    visit(node.rightOrFirst, [...ancestors, nodeIndex], depth + 1, (trailLow | (1 << depth)) >>> 0);
  };
  visit(0, [], 0, 0);
  return leaves;
}

function checkTreeInvariants(tree, lights, triangles, lightCount, triangleCount) {
  const totalEmitters = lightCount + triangleCount;
  const leaves = collectLeaves(tree);
  const seenUnified = new Set();
  const seenSlots = new Set();

  for (const leaf of leaves) {
    assert.ok(leaf.node.count >= 1, 'a leaf holds at least one emitter');
    if (!leaf.node.isDistant) {
      assert.ok(leaf.node.count <= LEAF_LIMIT || leaf.depth >= 24, `leaf ${leaf.nodeIndex} holds ${leaf.node.count} emitters`);
    }
    let energySum = 0;
    for (let offset = 0; offset < leaf.node.count; offset++) {
      const slot = leaf.node.rightOrFirst + offset;
      assert.ok(!seenSlots.has(slot), `slot ${slot} appears in two leaves`);
      seenSlots.add(slot);
      const emitter = readEmitter(tree, slot);
      assert.equal(emitter.leafIndex, leaf.nodeIndex, 'emitter points at its leaf');
      assert.equal(emitter.depth, leaf.depth, 'emitter depth is its leaf depth');
      assert.equal(emitter.trailLow, leaf.trailLow, 'trail bits describe the path from the root');
      assert.equal(emitter.trailHigh, 0);
      const unifiedIndex = emitter.isTriangle ? lightCount + emitter.recordIndex : emitter.recordIndex;
      assert.ok(!seenUnified.has(unifiedIndex), `emitter ${unifiedIndex} appears in two leaves`);
      seenUnified.add(unifiedIndex);
      assert.equal(tree.lightToTree[unifiedIndex], slot, 'light_to_tree inverts the emitter order');
      energySum += emitter.energy;

      const geometry = describeEmitter(lights, triangles, lightCount, unifiedIndex);
      for (const ancestorIndex of [leaf.nodeIndex, ...leaf.ancestors.slice().reverse()]) {
        const ancestor = readNode(tree, ancestorIndex);
        if (geometry.boxMin && !ancestor.isDistant) {
          assert.ok(
            boxInside(geometry.boxMin, geometry.boxMax, ancestor.boxMin, ancestor.boxMax),
            `emitter ${unifiedIndex} lies inside the box of node ${ancestorIndex}`
          );
        }
        assert.ok(
          Math.min(Math.PI, angleBetween(ancestor.axis, geometry.axis) + emitter.thetaO) <= ancestor.thetaO + 2e-3,
          `node ${ancestorIndex} cone contains the cone of emitter ${unifiedIndex}`
        );
        assert.ok(ancestor.thetaE >= emitter.thetaE - 1e-6, `node ${ancestorIndex} keeps the widest theta_e`);
        if (geometry.normal) {
          assert.ok(
            angleBetween(ancestor.axis, geometry.normal) <= ancestor.thetaO + geometry.normalSlack,
            `node ${ancestorIndex} cone reaches the normal of emitter ${unifiedIndex}`
          );
        }
      }
    }
    assert.ok(
      Math.abs(leaf.node.energy - energySum) <= 1e-5 * Math.max(1, energySum),
      `leaf ${leaf.nodeIndex} energy is the sum of its emitters`
    );
  }
  assert.equal(seenUnified.size, totalEmitters, 'every emitter is in exactly one leaf');
  assert.equal(seenSlots.size, totalEmitters);

  for (let nodeIndex = 0; nodeIndex < tree.nodeCount; nodeIndex++) {
    const node = readNode(tree, nodeIndex);
    if (node.isLeaf) {
      continue;
    }
    const left = readNode(tree, node.leftChild);
    const right = readNode(tree, node.rightOrFirst);
    assert.ok(
      Math.abs(node.energy - (left.energy + right.energy)) <= 1e-5 * Math.max(1, node.energy),
      `node ${nodeIndex} energy equals the sum of its children`
    );
    assert.equal(node.maskOr, (left.maskOr | right.maskOr) >>> 0);
    for (const child of [left, right]) {
      if (!child.isDistant && child.energy > 0) {
        assert.ok(boxInside(child.boxMin, child.boxMax, node.boxMin, node.boxMax), `child box inside the box of node ${nodeIndex}`);
      }
    }
  }
}


test('every emitter is in exactly one leaf and the node invariants hold for lights and triangles', () => {
  const lights = makeLights(60, 11);
  const triangles = makeTriangles(140, 12);
  const tree = buildLightTree(lights, 60, triangles, 140);
  assert.equal(tree.emitterCount, 200);
  assert.ok(tree.nodeCount > 1);
  assert.equal(tree.nodes.byteLength, tree.nodeCount * LIGHT_TREE_NODE_BYTES);
  assert.equal(tree.emitters.byteLength, 200 * LIGHT_TREE_EMITTER_BYTES);
  checkTreeInvariants(tree, lights, triangles, 60, 140);
});

test('sun lights form one distant leaf on the right of the root, outside the local tree', () => {
  const lights = makeLights(40, 21, { includeSun: true });
  const tree = buildLightTree(lights, 40, makeTriangles(30, 22), 30);
  checkTreeInvariants(tree, lights, makeTriangles(30, 22), 40, 30);
  const root = readNode(tree, 0);
  assert.ok(!root.isLeaf);
  const distant = readNode(tree, root.rightOrFirst);
  assert.ok(distant.isLeaf && distant.isDistant);
  assert.equal(distant.count, 1);
  const sun = readEmitter(tree, distant.rightOrFirst);
  assert.ok(sun.isDistant);
  assert.equal(sun.recordIndex, 39);
  assert.equal(sun.depth, 1);
  assert.equal(sun.trailLow, 1);
  const lightLeaf = new Uint32Array(lights.buffer, 39 * LIGHT_BYTES, 32)[27];
  assert.equal(lightLeaf, 0, 'the packed record is untouched by the builder');
  assert.equal(tree.lightLeafIndices[39], root.rightOrFirst);
});

test('a scene with only a sun is one distant leaf and an empty scene has no nodes', () => {
  const sunOnly = makeLights(1, 3, { includeSun: true });
  const tree = buildLightTree(sunOnly, 1, new Uint8Array(TRIANGLE_BYTES), 0);
  assert.equal(tree.nodeCount, 1);
  assert.ok(readNode(tree, 0).isDistant);

  const empty = buildLightTree(new Uint8Array(LIGHT_BYTES), 0, new Uint8Array(TRIANGLE_BYTES), 0);
  assert.equal(empty.nodeCount, 0);
  assert.equal(empty.emitterCount, 0);
  assert.equal(empty.nodes.byteLength, LIGHT_TREE_NODE_BYTES);
});

test('the same input gives byte-identical output, also from copied buffers', () => {
  const lights = makeLights(120, 31, { includeSun: true });
  const triangles = makeTriangles(300, 32);
  const first = buildLightTree(lights, 120, triangles, 300);
  const second = buildLightTree(lights.slice(), 120, triangles.slice(), 300);
  assert.deepEqual(first.nodes, second.nodes);
  assert.deepEqual(first.emitters, second.emitters);
  assert.deepEqual(first.lightToTree, second.lightToTree);
});

test('co-located emitters and emitters on one plane still build balanced trees within the leaf limit', () => {
  const lights = new Uint8Array(100 * LIGHT_BYTES);
  for (let index = 0; index < 100; index++) {
    writeLight(lights, index, {
      position: [1, 2, 3], type: TYPE_POINT, radiance: [1, 1, 1], direction: [0, 0, -1], radius: 0.1,
    });
  }
  const colocated = buildLightTree(lights, 100, new Uint8Array(TRIANGLE_BYTES), 0);
  checkTreeInvariants(colocated, lights, new Uint8Array(TRIANGLE_BYTES), 100, 0);

  const planar = new Uint8Array(100 * LIGHT_BYTES);
  for (let index = 0; index < 100; index++) {
    writeLight(planar, index, {
      position: [5, index % 10, Math.floor(index / 10)], type: TYPE_POINT, radiance: [1, 1, 1], direction: [0, 0, -1],
    });
  }
  const planarTree = buildLightTree(planar, 100, new Uint8Array(TRIANGLE_BYTES), 0);
  checkTreeInvariants(planarTree, planar, new Uint8Array(TRIANGLE_BYTES), 100, 0);
});

test('a tight spatial cluster of lights splits from a far one so the tree separates them', () => {
  const lights = new Uint8Array(20 * LIGHT_BYTES);
  for (let index = 0; index < 20; index++) {
    const cluster = index < 10 ? 0 : 1000;
    writeLight(lights, index, {
      position: [cluster + (index % 10) * 0.01, 0, 0], type: TYPE_POINT, radiance: [1, 1, 1], direction: [0, 0, -1], radius: 0.01,
    });
  }
  const tree = buildLightTree(lights, 20, new Uint8Array(TRIANGLE_BYTES), 0);
  const root = readNode(tree, 0);
  const left = readNode(tree, root.leftChild);
  const right = readNode(tree, root.rightOrFirst);
  assert.ok(left.boxMax[0] < 1 || right.boxMax[0] < 1, 'one child holds only the near cluster');
  assert.ok(left.boxMin[0] > 100 || right.boxMin[0] > 100, 'the other holds only the far cluster');
});

test('cone merge contains both inputs and the measure grows with the cone', () => {
  const coneA = { axis: [1, 0, 0], thetaO: 0.2, thetaE: 0.3 };
  const coneB = { axis: [0, 1, 0], thetaO: 0.1, thetaE: 0.5 };
  const merged = mergeCones(coneA, coneB);
  for (const cone of [coneA, coneB]) {
    assert.ok(Math.min(Math.PI, angleBetween(merged.axis, cone.axis) + cone.thetaO) <= merged.thetaO + 1e-9);
  }
  assert.equal(merged.thetaE, 0.5);
  assert.ok(coneMeasure(merged) > coneMeasure(coneA));
  assert.equal(coneMeasure({ axis: [0, 0, 0], thetaO: 0, thetaE: 0 }), 0);
  const opposite = mergeCones({ axis: [1, 0, 0], thetaO: 0, thetaE: 0 }, { axis: [-1, 0, 0], thetaO: 0, thetaE: 0 });
  assert.ok(Math.abs(Math.hypot(...opposite.axis) - 1) < 1e-9);
  assert.ok(opposite.thetaO >= Math.PI / 2 - 1e-9);

  const nearlyOpposite = [
    { axis: [1, 0, 0], thetaO: 0.3, thetaE: 0 },
    { axis: normalize([-1, 0.02, 0]), thetaO: 0.1, thetaE: 0 },
  ];
  const nearlyOppositeMerge = mergeCones(nearlyOpposite[0], nearlyOpposite[1]);
  for (const cone of nearlyOpposite) {
    const reach = Math.min(Math.PI, angleBetween(nearlyOppositeMerge.axis, cone.axis) + cone.thetaO);
    assert.ok(reach <= nearlyOppositeMerge.thetaO + 1e-9, 'a near-opposite merge still contains both cones');
  }
});

test('500 lights build in bounded time and 5000 emitters stay within the invariants', () => {
  const lights = makeLights(500, 41);
  const started = performance.now();
  const tree = buildLightTree(lights, 500, new Uint8Array(TRIANGLE_BYTES), 0);
  const elapsedMilliseconds = performance.now() - started;
  assert.ok(elapsedMilliseconds < 5000, `500 lights took ${elapsedMilliseconds.toFixed(0)} ms`);
  checkTreeInvariants(tree, lights, new Uint8Array(TRIANGLE_BYTES), 500, 0);

  const bigLights = makeLights(1000, 42);
  const bigTriangles = makeTriangles(4000, 43);
  const bigTree = buildLightTree(bigLights, 1000, bigTriangles, 4000);
  checkTreeInvariants(bigTree, bigLights, bigTriangles, 1000, 4000);
});

test('the boundary rejects bad counts, short buffers, non-finite values and unknown light types', () => {
  const lights = makeLights(2, 51);
  const triangles = makeTriangles(1, 52);
  assert.throws(() => buildLightTree(lights, -1, triangles, 1), /non-negative integer/);
  assert.throws(() => buildLightTree(lights, 2.5, triangles, 1), /non-negative integer/);
  assert.throws(() => buildLightTree(lights, 3, triangles, 1), /fewer than 3 records of 128 bytes/);
  assert.throws(() => buildLightTree(lights, 2, triangles, 2), /fewer than 2 records of 96 bytes/);
  assert.throws(() => buildLightTree([], 0, triangles, 1), /Uint8Array/);
  assert.throws(
    () => buildLightTree(lights, 2, triangles, LIGHT_TREE_MAX_EMITTERS),
    new RegExp(`exceed the limit of ${LIGHT_TREE_MAX_EMITTERS}`)
  );
  const broken = lights.slice();
  new Float32Array(broken.buffer, 0, 1)[0] = Number.NaN;
  assert.throws(() => buildLightTree(broken, 2, triangles, 1), /analytic light 0 has a non-finite value/);
  const unknownType = lights.slice();
  new Uint32Array(unknownType.buffer, 0, 4)[3] = 9;
  assert.throws(() => buildLightTree(unknownType, 2, triangles, 1), /unknown light_type 9/);
});

test('buildNativeInputV2 packs the tree, fills tree_leaf_index and keeps counts consistent', () => {
  const camera = createCamera({ eye: [0, 0, 6], target: [0, 0, 0], fov: 50 }, 16, 16);
  const quad = {
    positions: new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
    uvs: new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]),
    colors: new Float32Array(12).fill(1),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  };
  const v2 = buildNativeInputV2(
    {
      materials: [{ color: [0.8, 0.8, 0.8] }, { color: [1, 1, 1], emission: 5 }],
      instances: [
        { geometry: quad, matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], materialIndex: 0 },
        { geometry: quad, matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 3, 0, 1], materialOverride: 1 },
      ],
      lights: {
        points: [
          { position: [2, 2, 2], intensity: 10, radius: 0.1 },
          { position: [-3, 1, 0], intensity: 4 },
        ],
        sun: { color: [1, 1, 1], direction: [0, 1, 0.2] },
      },
    },
    camera,
    { width: 16, height: 16, samples: 1 }
  );
  assert.equal(v2.lightCount, 3);
  assert.equal(v2.emissiveTriangleCount, 2);
  assert.equal(v2.lightTreeEmitterCount, 5);
  assert.ok(v2.lightTreeNodeCount >= 3);
  assert.equal(v2.lightTreeNodes.byteLength, v2.lightTreeNodeCount * LIGHT_TREE_NODE_BYTES);
  assert.equal(v2.lightTreeEmitters.byteLength, 5 * LIGHT_TREE_EMITTER_BYTES);
  assert.equal(v2.lightToTree.length, 5);
  const tree = {
    nodes: v2.lightTreeNodes,
    nodeCount: v2.lightTreeNodeCount,
    emitters: v2.lightTreeEmitters,
    lightToTree: v2.lightToTree,
  };
  checkTreeInvariants(tree, v2.lights, v2.emissiveTriangles, 3, 2);
  for (let index = 0; index < 3; index++) {
    const leafIndex = new Uint32Array(v2.lights.buffer, v2.lights.byteOffset + index * LIGHT_BYTES, 32)[27];
    const slot = v2.lightToTree[index];
    assert.equal(leafIndex, readEmitter(tree, slot).leafIndex, `light ${index} tree_leaf_index names its leaf`);
  }
  const kp = new Uint32Array(v2.kernelParams.buffer, v2.kernelParams.byteOffset, 80);
  assert.equal(kp[26], v2.lightTreeNodeCount, 'kernel params carry the node count');
});

test('the distant leaf limit matches the per-leaf clamp of the kernel', () => {
  const kernelSource = readFileSync(new URL('../packages/render-native/src/cycles/light_tree.wgsl', import.meta.url), 'utf8');
  const match = /const LTR_MAX_LEAF_EMITTERS: u32 = (\d+)u;/.exec(kernelSource);
  assert.ok(match, 'light_tree.wgsl declares LTR_MAX_LEAF_EMITTERS');
  assert.equal(Number(match[1]), LIGHT_TREE_KERNEL_MAX_LEAF_EMITTERS);
});

test('more distant lights than the kernel reads from one leaf are rejected with the allowed count', () => {
  const allowed = LIGHT_TREE_KERNEL_MAX_LEAF_EMITTERS;
  const suns = (count) => {
    const bytes = new Uint8Array(count * LIGHT_BYTES);
    for (let index = 0; index < count; index++) {
      writeLight(bytes, index, { position: [0, 0, 0], type: TYPE_SUN, radiance: [1, 1, 1], direction: [0, 1, 0] });
    }
    return bytes;
  };
  assert.doesNotThrow(() => buildLightTree(suns(allowed), allowed, new Uint8Array(TRIANGLE_BYTES), 0));
  assert.throws(
    () => buildLightTree(suns(allowed + 1), allowed + 1, new Uint8Array(TRIANGLE_BYTES), 0),
    new RegExp(`${allowed + 1} distant lights exceed the ${allowed} the kernel reads from one leaf. Pass at most ${allowed}`)
  );
});

test('index words of an emissive triangle are not checked as floats', () => {
  const triangles = makeTriangles(2, 61);
  const words = new Uint32Array(triangles.buffer);
  words[7] = 0xffffffff;
  words[11] = 0x7fc00000;
  words[15] = 0xffffffff;
  assert.doesNotThrow(() => buildLightTree(makeLights(1, 62), 1, triangles, 2));
});

test('lightSampling on a packed v2 input without emitter tables is rejected for "tree" and ignored for "auto"', () => {
  const kernelParams = new Uint8Array(320);
  const staleInput = { kernelParams, lightCount: 40, emissiveTriangleCount: 0, lightTreeNodeCount: 1 };
  const flagsOf = (params) => new DataView(params.buffer, params.byteOffset).getUint32(32, true);
  assert.throws(
    () => withLightSamplingFlag(staleInput, 'tree'),
    /lightSampling "tree" needs the emitter tables .* Repack the scene with buildNativeInputV2/
  );
  assert.equal(flagsOf(withLightSamplingFlag(staleInput, 'auto')) & 1, 0);
  const completeInput = {
    ...staleInput,
    lightTreeEmitters: new Uint8Array(32),
    lightToTree: new Uint32Array(1),
    lightTreeEmitterCount: 40,
  };
  assert.equal(flagsOf(withLightSamplingFlag(completeInput, 'tree')) & 1, 1);
  assert.equal(flagsOf(withLightSamplingFlag(completeInput, 'uniform')) & 1, 0);
});

// Options and packing of a scene built from the trace scene (the tests adapted from the earlier sampler change, #957).
const KERNEL_FLAGS_WORD = 8;
const FLAG_USE_LIGHT_TREE = 1;
const FLAG_WHITE_NOISE_SAMPLER = 64;

function floorGeometry() {
  return {
    positions: new Float32Array([-4, 0, -4, 4, 0, -4, 4, 0, 4, -4, 0, 4]),
    normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]),
    uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
    colors: new Float32Array(12).fill(1),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  };
}

function pointLightList(count) {
  return Array.from({ length: count }, (_, index) => ({
    position: [(index % 5) - 2, 1 + (index % 3) * 0.5, Math.floor(index / 5) - 2],
    color: [1, 0.9, 0.8],
    intensity: 1 + index,
    radius: 0.05,
  }));
}

function packTraceScene(environment, options = {}, parts = [{ name: 'floor', geometry: floorGeometry(), material: { color: [0.5, 0.5, 0.5] } }]) {
  const scene = buildTraceScene(parts, environment);
  const camera = createCamera({ eye: [0, 2, 6], target: [0, 0, 0], fov: 45 }, 32, 16);
  return buildNativeInputV2(scene, camera, { width: 32, height: 16, samples: 4, ...options });
}

function packedKernelFlags(input) {
  return new Uint32Array(input.kernelParams.buffer, input.kernelParams.byteOffset, STRUCT_STRIDES_V2.kernelParams / 4)[KERNEL_FLAGS_WORD];
}

function treeOf(input) {
  return { nodes: input.lightTreeNodes, nodeCount: input.lightTreeNodeCount, emitters: input.lightTreeEmitters, lightToTree: input.lightToTree };
}

test('the Sobol-Burley sampler is the default, "white" sets the opt-out flag and "pcg" and "sobol" are its earlier names', () => {
  assert.equal(packedKernelFlags(packTraceScene({})) & FLAG_WHITE_NOISE_SAMPLER, 0);
  assert.equal(packedKernelFlags(packTraceScene({}, { sampler: 'sobol-burley' })) & FLAG_WHITE_NOISE_SAMPLER, 0);
  assert.equal(packedKernelFlags(packTraceScene({}, { sampler: 'sobol' })) & FLAG_WHITE_NOISE_SAMPLER, 0);
  assert.equal(packedKernelFlags(packTraceScene({}, { sampler: 'white' })) & FLAG_WHITE_NOISE_SAMPLER, FLAG_WHITE_NOISE_SAMPLER);
  assert.equal(packedKernelFlags(packTraceScene({}, { sampler: 'pcg' })) & FLAG_WHITE_NOISE_SAMPLER, FLAG_WHITE_NOISE_SAMPLER);
  assert.throws(() => packTraceScene({}, { sampler: 'halton' }), /sampler.*sobol-burley.*white/);
});

test('light selection: the tree is the default from two emitters, and lightSampling or its alias useLightTree forces or forbids it', () => {
  const few = { pointLights: pointLightList(3) };
  const many = { pointLights: pointLightList(20) };
  assert.equal(packedKernelFlags(packTraceScene({ pointLights: pointLightList(1) })) & FLAG_USE_LIGHT_TREE, 0, 'one emitter needs no pick');
  assert.equal(packedKernelFlags(packTraceScene(few)) & FLAG_USE_LIGHT_TREE, FLAG_USE_LIGHT_TREE);
  assert.equal(packedKernelFlags(packTraceScene(many, { lightSampling: 'uniform' })) & FLAG_USE_LIGHT_TREE, 0);
  assert.equal(packedKernelFlags(packTraceScene(many, { useLightTree: false })) & FLAG_USE_LIGHT_TREE, 0);
  assert.equal(packedKernelFlags(packTraceScene({ pointLights: pointLightList(1) }, { useLightTree: true })) & FLAG_USE_LIGHT_TREE, FLAG_USE_LIGHT_TREE);
  assert.deepEqual(
    packTraceScene(many, { useLightTree: false }).kernelParams,
    packTraceScene(many, { lightSampling: 'uniform' }).kernelParams,
    'the alias packs the same bytes'
  );
  assert.doesNotThrow(() => packTraceScene(many, { useLightTree: true, lightSampling: 'tree' }));
  assert.throws(() => packTraceScene(many, { useLightTree: true, lightSampling: 'uniform' }), /disagrees/);
  assert.throws(() => packTraceScene(many, { useLightTree: 'yes' }), /useLightTree/);
  assert.throws(() => packTraceScene(many, { lightSampling: 'sometimes' }), /lightSampling/);
});

test('the light tree built from a trace scene links every light to the root and sums their energy', () => {
  const lightCount = 20;
  const input = packTraceScene({ pointLights: pointLightList(lightCount) });
  assert.equal(packedKernelFlags(input) & FLAG_USE_LIGHT_TREE, FLAG_USE_LIGHT_TREE);
  assert.equal(input.lightCount, lightCount);
  const tree = treeOf(input);
  checkTreeInvariants(tree, input.lights, input.emissiveTriangles, lightCount, 0);
  const root = readNode(tree, 0);
  const leafEnergy = collectLeaves(tree).reduce((sum, leaf) => sum + leaf.node.energy, 0);
  assert.ok(leafEnergy > 0);
  assert.ok(Math.abs(root.energy - leafEnergy) <= leafEnergy * 1e-5, 'root energy is the sum of the leaves');
});

test('a sun stays in the tree as a distant leaf, so the other lights keep the tree pick', () => {
  const input = packTraceScene({ pointLights: pointLightList(20), keyColor: [3, 3, 3], lightDirection: [0, 1, 0] });
  assert.equal(packedKernelFlags(input) & FLAG_USE_LIGHT_TREE, FLAG_USE_LIGHT_TREE);
  const tree = treeOf(input);
  checkTreeInvariants(tree, input.lights, input.emissiveTriangles, input.lightCount, 0);
  assert.ok(collectLeaves(tree).some((leaf) => leaf.node.isDistant), 'the sun is a distant leaf');
});

test('emissive triangles are leaves of the same tree', () => {
  const emissivePanels = Array.from({ length: 12 }, (_, index) => {
    const geometry = floorGeometry();
    geometry.positions = geometry.positions.map((value, position) => (position % 3 === 1 ? 3 : value * 0.1 + (index - 6) * 0.6));
    return { name: `panel-${index}`, geometry, material: { color: [0.5, 0.5, 0.5], emission: 5 } };
  });
  const input = packTraceScene({}, {}, emissivePanels);
  assert.equal(input.emissiveTriangleCount, 24);
  assert.equal(packedKernelFlags(input) & FLAG_USE_LIGHT_TREE, FLAG_USE_LIGHT_TREE);
  checkTreeInvariants(treeOf(input), input.lights, input.emissiveTriangles, input.lightCount, 24);
});

test('light-link masks do not switch the tree off: every node keeps the OR of the masks below it', () => {
  const input = packTraceScene({ pointLights: pointLightList(20) });
  const lightWords = new Uint32Array(input.lights.buffer, input.lights.byteOffset, input.lights.byteLength / 4);
  let maskOr = 0;
  for (let index = 0; index < input.lightCount; index++) {
    maskOr = (maskOr | lightWords[index * (LIGHT_BYTES / 4) + 30]) >>> 0;
  }
  assert.equal(packedKernelFlags(input) & FLAG_USE_LIGHT_TREE, FLAG_USE_LIGHT_TREE);
  assert.equal(readNode(treeOf(input), 0).maskOr, maskOr);
});
