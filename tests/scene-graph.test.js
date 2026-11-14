import assert from 'node:assert/strict';
import test from 'node:test';
import { mat4, quat, vec3 } from 'gl-matrix';
import { Object3D } from 'three';
import { createSceneGraph } from '../src/scene-graph.js';
import { createAnimationClip, createAnimationPlayer } from '../src/animation.js';
import { createAnimationMixer } from '../src/animation-mixer.js';
import { box } from '../src/geometry.js';

function transform(translation = [0, 0, 0], angles = [0, 0, 0], scale = [1, 1, 1]) {
  return mat4.fromRotationTranslationScale(mat4.create(), quat.fromEuler(quat.create(), ...angles), translation, scale);
}

function closeMatrix(actual, expected, tolerance = 2e-5) {
  for (let index = 0; index < 16; index++) {
    assert.ok(Math.abs(actual[index] - expected[index]) < tolerance, `component ${index}: ${actual[index]} differs from ${expected[index]}`);
  }
}

function snapshot(graph) {
  return graph.nodes.map(node => ({ name: node.name, parent: node.parent, world: Array.from(node.worldMatrix) }));
}

function material() {
  return { color: [0.5, 0.6, 0.7], metallic: 0.2, roughness: 0.5, emission: 0, map: {} };
}

test('child-first definitions propagate nested rotations and nonuniform scales like Three Object3D', () => {
  const definitions = [
    { name: 'tip', parent: 'arm', matrix: transform([0, 2, 0], [15, 25, 30], [0.5, 1.5, 0.75]) },
    { name: 'arm', parent: 'body', matrix: transform([1, 0, 0], [0, 0, 60], [1, 2, 1]) },
    { name: 'body', matrix: transform([3, 4, 5], [0, 45, 0], [2, 3, 4]) },
  ];
  const graph = createSceneGraph(definitions);
  const reference = new Map();
  for (const definition of definitions) {
    const object = new Object3D();
    object.matrixAutoUpdate = false;
    object.matrix.fromArray(definition.matrix);
    reference.set(definition.name, object);
  }
  reference.get('body').add(reference.get('arm'));
  reference.get('arm').add(reference.get('tip'));
  reference.get('body').updateMatrixWorld(true);
  for (const node of graph.nodes) closeMatrix(node.worldMatrix, reference.get(node.name).matrixWorld.elements);
  const reordered = createSceneGraph([...definitions].reverse());
  for (const node of graph.nodes) closeMatrix(reordered.getNode(node.name).worldMatrix, node.worldMatrix);
});

test('pivot conjugation places the pivot correctly under parent translation, rotation and scale', () => {
  const graph = createSceneGraph([
    { name: 'parent', matrix: transform([2, 0, 0]) },
    { name: 'rotor', parent: 'parent', matrix: transform([5, 0, 0], [0, 0, 90]), pivot: [1, 0, 0] },
  ]);
  const rotor = graph.getNode('rotor');
  closeMatrix(rotor.worldMatrix, transform([8, -1, 0], [0, 0, 90]));
  const pivotPosition = vec3.transformMat4(new Float64Array(3), [1, 0, 0], rotor.worldMatrix);
  assert.ok(Math.abs(pivotPosition[0] - 8) < 1e-5);
  assert.ok(Math.abs(pivotPosition[1]) < 1e-5);
  graph.getNode('parent').localMatrix.set(transform([0, 0, 0], [0, 0, 90], [2, 3, 1]));
  graph.update();
  const transformedPivot = vec3.transformMat4(new Float64Array(3), [1, 0, 0], rotor.worldMatrix);
  assert.ok(Math.abs(transformedPivot[0]) < 1e-5);
  assert.ok(Math.abs(transformedPivot[1] - 12) < 1e-5);
});

test('roots, empty graphs and multiple render meshes keep a stable CrucibleRenderer part shape', () => {
  const geometry = box(0, 1);
  const sharedMaterial = material();
  const graph = createSceneGraph([
    { name: 'first', matrix: transform([2, 0, 0]), geometry, material: sharedMaterial },
    { name: 'group' },
    { name: 'second', matrix: transform([0, 3, 0]), geometry, material: sharedMaterial },
  ]);
  const parts = graph.parts;
  const targets = graph.animationTargets;
  assert.equal(parts.length, 2);
  assert.equal(targets.length, 3);
  assert.deepEqual(parts.map(part => part.name), ['first', 'second']);
  for (const part of parts) {
    assert.equal(part.geometry, geometry);
    assert.equal(part.material, sharedMaterial);
    assert.equal(part.matrix, graph.getNode(part.name).worldMatrix);
    assert.ok(part.matrix instanceof Float32Array);
    assert.ok(part.matrix.every(Number.isFinite));
    assert.ok(part.geometry.positions instanceof Float32Array);
  }
  for (const target of targets) assert.equal(target.matrix, graph.getNode(target.name).localMatrix);
  assert.equal(graph.update(), parts);
  assert.equal(graph.parts, parts);
  assert.equal(graph.animationTargets, targets);
  const empty = createSceneGraph();
  assert.deepEqual(empty.nodes, []);
  assert.deepEqual(empty.update(), []);
});

test('definition matrices and pivots copy serializable inputs while geometry and material remain shared', () => {
  const definitions = [{ name: 'root', matrix: Array.from(transform([3, 0, 0])), pivot: [1, 0, 0] }];
  const restored = createSceneGraph(JSON.parse(JSON.stringify(definitions)));
  const graph = createSceneGraph(definitions);
  definitions[0].matrix[12] = 100;
  definitions[0].pivot[0] = 100;
  definitions[0].name = 'changed';
  graph.update();
  closeMatrix(graph.getNode('root').worldMatrix, restored.getNode('root').worldMatrix);
  assert.deepEqual(Array.from(graph.getNode('root').pivot), [1, 0, 0]);
  assert.throws(() => graph.getNode('changed'), /not found/);
});

test('nonsingular affine shear and reflected transforms remain valid graph transforms', () => {
  const shear = mat4.create();
  shear[4] = 0.5;
  const graph = createSceneGraph([
    { name: 'reflected', matrix: transform([0, 0, 0], [0, 0, 0], [-1, 2, 3]) },
    { name: 'sheared', parent: 'reflected', matrix: shear },
  ]);
  assert.ok(mat4.determinant(graph.getNode('sheared').worldMatrix) < 0);
  const clip = createAnimationClip({ duration: 1, tracks: [{ target: 'sheared', property: 'translation', keyframes: [{ time: 0, value: [0, 0, 0] }] }] });
  assert.throws(() => createAnimationPlayer(clip, graph.animationTargets), /shear/);
});

test('local mixer and parent animation propagate independently for arbitrary seek order', () => {
  const graph = createSceneGraph([
    { name: 'parent', matrix: transform([0, 0, 0], [0, 0, 0], [2, 3, 1]) },
    { name: 'child', parent: 'parent', matrix: transform([1, 0, 0]), pivot: [1, 0, 0], geometry: box(0, 1), material: material() },
  ]);
  const parentClip = createAnimationClip({ duration: 2, tracks: [{ target: 'parent', property: 'translation', keyframes: [
    { time: 0, value: [0, 0, 0] }, { time: 2, value: [4, 0, 0] },
  ] }] });
  const childClip = createAnimationClip({ duration: 2, tracks: [{ target: 'child', property: 'rotation', keyframes: [
    { time: 0, value: [0, 0, 0, 1] }, { time: 2, value: Array.from(quat.fromEuler(quat.create(), 0, 0, 90)) },
  ] }] });
  const parentPlayer = createAnimationPlayer(parentClip, graph.animationTargets);
  const mixer = createAnimationMixer(graph.animationTargets);
  mixer.clipAction(childClip).play();
  parentPlayer.apply(1);
  mixer.apply(1);
  graph.update();
  const expected = snapshot(graph);
  const node = graph.getNode('child');
  const world = node.worldMatrix;
  const local = node.localMatrix;
  const pivotPosition = vec3.transformMat4(new Float64Array(3), [1, 0, 0], world);
  assert.ok(Math.abs(pivotPosition[0] - 6) < 1e-5);
  assert.ok(Math.abs(pivotPosition[1]) < 1e-5);
  for (const time of [2, 0, 1.75, 0.25, 1]) {
    mixer.apply(time);
    parentPlayer.apply(time);
    graph.update();
  }
  assert.deepEqual(snapshot(graph), expected);
  assert.equal(node.worldMatrix, world);
  assert.equal(node.localMatrix, local);
});

test('animation target material assignment forwards retained isolation to render parts and preserves map identity', () => {
  const shared = Object.freeze(material());
  const graph = createSceneGraph([
    { name: 'first', geometry: box(0, 1), material: shared },
    { name: 'second', geometry: box(0, 1), material: shared },
  ]);
  const clip = createAnimationClip({ duration: 2, tracks: [{ target: 'first', property: 'emission', keyframes: [
    { time: 0, value: 0 }, { time: 2, value: 2 },
  ] }] });
  const player = createAnimationPlayer(clip, graph.animationTargets);
  const renderPart = graph.parts[0];
  const isolated = renderPart.material;
  assert.notEqual(isolated, shared);
  assert.equal(isolated.map, shared.map);
  assert.equal(graph.animationTargets[0].material, isolated);
  assert.equal(graph.getNode('first').material, isolated);
  const mixer = createAnimationMixer(graph.animationTargets);
  mixer.clipAction(clip).play();
  assert.equal(renderPart.material, isolated);
  player.apply(1);
  assert.equal(renderPart.material.emission, 1);
  mixer.apply(2);
  assert.equal(renderPart.material.emission, 2);
  assert.equal(renderPart.material, isolated);
  assert.equal(graph.parts[1].material, shared);
  assert.equal(shared.emission, 0);
  const replacement = { ...isolated, emission: 3 };
  graph.animationTargets[0].material = replacement;
  assert.equal(renderPart.material, replacement);
});

test('all published world matrices remain unchanged when any local, pivot or composed world is invalid', () => {
  const graph = createSceneGraph([{ name: 'root' }, { name: 'child', parent: 'root', matrix: transform([1, 0, 0]) }]);
  const expected = snapshot(graph);
  const root = graph.getNode('root');
  const child = graph.getNode('child');
  root.localMatrix[12] = 5;
  for (const corrupt of [
    () => { child.localMatrix[0] = NaN; },
    () => { child.localMatrix[3] = 1; },
    () => { child.localMatrix[0] = 0; },
    () => { child.pivot[0] = Infinity; },
  ]) {
    child.localMatrix.set(transform([1, 0, 0]));
    child.pivot[0] = 0;
    corrupt();
    assert.throws(() => graph.update(), RangeError);
    assert.deepEqual(snapshot(graph), expected);
  }
  child.pivot[0] = 0;
  root.localMatrix.set(transform([0, 0, 0], [0, 0, 0], [1e30, 1, 1]));
  child.localMatrix.set(transform([0, 0, 0], [0, 0, 0], [1e30, 1, 1]));
  assert.throws(() => graph.update(), /finite Float32/);
  assert.deepEqual(snapshot(graph), expected);
  root.localMatrix.set(transform([0, 0, 0], [0, 0, 0], [1e-30, 1, 1]));
  child.localMatrix.set(transform([0, 0, 0], [0, 0, 0], [1e-30, 1, 1]));
  assert.throws(() => graph.update(), /nonsingular/);
  assert.deepEqual(snapshot(graph), expected);
  root.localMatrix.set(transform([5, 0, 0]));
  child.localMatrix.set(transform([1, 0, 0]));
  graph.update();
  assert.equal(child.worldMatrix[12], 6);
});

test('keepWorld reparent preserves pivoted subtrees under rotated nonuniform scales without changing identities', () => {
  const graph = createSceneGraph([
    { name: 'first', matrix: transform([2, 3, 4], [0, 35, 15], [2, 3, 4]) },
    { name: 'second', matrix: transform([-3, 1, 2], [20, -25, 10], [1, 2, 3]) },
    { name: 'child', parent: 'first', matrix: transform([1, 2, 0], [30, 45, 0]), pivot: [0.5, 1, 0], geometry: box(0, 1), material: material() },
    { name: 'tip', parent: 'child', matrix: transform([0, 2, 1]) },
  ]);
  const child = graph.getNode('child');
  const localIdentity = child.localMatrix;
  const worldIdentity = child.worldMatrix;
  const partsIdentity = graph.parts;
  const childWorld = Array.from(child.worldMatrix);
  const tipWorld = Array.from(graph.getNode('tip').worldMatrix);
  assert.equal(graph.reparent('child', 'second', { keepWorld: true }), graph);
  assert.equal(child.parent, 'second');
  assert.equal(child.localMatrix, localIdentity);
  assert.equal(child.worldMatrix, worldIdentity);
  assert.equal(graph.parts, partsIdentity);
  closeMatrix(child.worldMatrix, childWorld);
  closeMatrix(graph.getNode('tip').worldMatrix, tipWorld);
  graph.reparent('child', null, { keepWorld: true });
  assert.equal(child.parent, null);
  closeMatrix(child.worldMatrix, childWorld);
  closeMatrix(graph.getNode('tip').worldMatrix, tipWorld);
});

test('reparent without keepWorld preserves local pose and keepWorld includes unpublished local edits', () => {
  const graph = createSceneGraph([
    { name: 'first', matrix: transform([2, 0, 0]) },
    { name: 'second', matrix: transform([10, 0, 0]) },
    { name: 'child', parent: 'first', matrix: transform([1, 0, 0]) },
  ]);
  const child = graph.getNode('child');
  const initialLocal = Array.from(child.localMatrix);
  graph.reparent('child', 'second');
  assert.deepEqual(Array.from(child.localMatrix), initialLocal);
  assert.equal(child.worldMatrix[12], 11);
  graph.getNode('second').localMatrix[12] = 20;
  graph.reparent('child', 'first', { keepWorld: true });
  assert.equal(child.worldMatrix[12], 21);
  assert.equal(child.localMatrix[12], 19);
  assert.equal(graph.getNode('second').worldMatrix[12], 20);
});

test('reparent rejects cycles, excessive depth and invalid candidate worlds atomically', () => {
  const graph = createSceneGraph([{ name: 'root' }, { name: 'child', parent: 'root' }, { name: 'other' }], { maxDepth: 2 });
  const expected = snapshot(graph);
  const local = Array.from(graph.getNode('root').localMatrix);
  assert.throws(() => graph.reparent('root', 'child'), /cycle/);
  assert.throws(() => graph.reparent('root', 'root'), /cycle/);
  assert.throws(() => graph.reparent('other', 'child'), /maxDepth/);
  assert.throws(() => graph.reparent('child', 'missing'), /not found/);
  assert.throws(() => graph.reparent('missing', 'root'), /not found/);
  assert.throws(() => graph.reparent('child', 'other', { keepWorld: 1 }), TypeError);
  assert.deepEqual(snapshot(graph), expected);
  assert.deepEqual(Array.from(graph.getNode('root').localMatrix), local);

  const extreme = createSceneGraph([
    { name: 'large', matrix: transform([0, 0, 0], [0, 0, 0], [1e30, 1, 1]) },
    { name: 'small', matrix: transform([0, 0, 0], [0, 0, 0], [1e-30, 1, 1]) },
    { name: 'child', matrix: transform([0, 0, 0], [0, 0, 0], [1e30, 1, 1]) },
  ]);
  const previous = snapshot(extreme);
  const previousLocal = Array.from(extreme.getNode('child').localMatrix);
  assert.throws(() => extreme.reparent('child', 'large'), /finite Float32/);
  assert.throws(() => extreme.reparent('child', 'small', { keepWorld: true }), /finite Float32/);
  assert.deepEqual(snapshot(extreme), previous);
  assert.deepEqual(Array.from(extreme.getNode('child').localMatrix), previousLocal);
});

test('hierarchy guards bound node count and depth without recursive traversal', () => {
  assert.throws(() => createSceneGraph([{ name: 'first' }, { name: 'first' }]), /Duplicate/);
  assert.throws(() => createSceneGraph([{ name: 'child', parent: 'missing' }]), /not found/);
  assert.throws(() => createSceneGraph([{ name: 'first', parent: 'second' }, { name: 'second', parent: 'first' }]), /cycle/);
  assert.throws(() => createSceneGraph([{ name: 'self', parent: 'self' }]), /cycle/);
  assert.throws(() => createSceneGraph([{ name: 'root' }, { name: 'child', parent: 'root' }], { maxDepth: 1 }), /maxDepth/);
  assert.throws(() => createSceneGraph([{ name: 'first' }, { name: 'second' }], { maxNodes: 1 }), /maxNodes/);
  for (const limit of [0, -1, 1.5, Infinity, NaN]) {
    assert.throws(() => createSceneGraph([], { maxNodes: limit }), RangeError);
    assert.throws(() => createSceneGraph([], { maxDepth: limit }), RangeError);
  }
  const chain = Array.from({ length: 300 }, (_, index) => ({ name: `node-${index}`, parent: index ? `node-${index - 1}` : null }));
  assert.throws(() => createSceneGraph(chain), /maxDepth/);
  assert.equal(createSceneGraph(chain, { maxDepth: 300 }).nodes.length, 300);
});

test('malformed matrices, pivots and mesh definitions fail before graph publication', () => {
  assert.throws(() => createSceneGraph({}), TypeError);
  assert.throws(() => createSceneGraph([{ name: '' }]), TypeError);
  assert.throws(() => createSceneGraph([{ name: 'node', parent: 1 }]), TypeError);
  assert.throws(() => createSceneGraph([{ name: 'node', matrix: [1] }]), TypeError);
  const nonfinite = Array.from(mat4.create());
  nonfinite[0] = 1e100;
  assert.throws(() => createSceneGraph([{ name: 'node', matrix: nonfinite }]), TypeError);
  assert.throws(() => createSceneGraph([{ name: 'node', matrix: transform([0, 0, 0], [0, 0, 0], [0, 1, 1]) }]), /nonsingular/);
  const projective = mat4.create();
  projective[3] = 0.5;
  assert.throws(() => createSceneGraph([{ name: 'node', matrix: projective }]), /affine/);
  assert.throws(() => createSceneGraph([{ name: 'node', pivot: [Infinity, 0, 0] }]), TypeError);
  assert.throws(() => createSceneGraph([{ name: 'node', geometry: {} }]), TypeError);
  assert.throws(() => createSceneGraph([{ name: 'node', material: {} }]), TypeError);
});

test('update reuses parent matrices and effective-local buffers across repeated evaluation', () => {
  const graph = createSceneGraph([{ name: 'parent' }, { name: 'child', parent: 'parent', matrix: transform([1, 0, 0]) }]);
  const originalMultiply = mat4.multiply;
  let retained;
  let calls = 0;
  mat4.multiply = (output, parent, local) => {
    if (!retained) retained = [output, parent, local];
    else {
      assert.equal(output, retained[0]);
      assert.equal(parent, retained[1]);
      assert.equal(local, retained[2]);
    }
    calls++;
    return originalMultiply(output, parent, local);
  };
  try {
    for (let frame = 0; frame < 200; frame++) {
      graph.getNode('parent').localMatrix[12] = frame * 17 % 20;
      graph.update();
    }
  } finally {
    mat4.multiply = originalMultiply;
  }
  assert.equal(calls, 200);
});
