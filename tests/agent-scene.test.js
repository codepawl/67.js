import './support/load-agent-scene-modules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Matrix4, Quaternion, Vector3 } from 'three';
import { createAgentScene, AGENT_SCENE_CAPABILITIES, AGENT_SCENE_DEFAULT_LIMITS } from '../src/agent-scene.js';
import * as lightweightCapabilities from '../src/agent-scene-capabilities.js';

test('the plain-data capabilities module matches the scene engine', () => {
  const scene = createAgentScene({ format: '67js.scene', schemaVersion: 1, geometries: [], materials: [], nodes: [] });
  assert.deepEqual(scene.limits, lightweightCapabilities.AGENT_SCENE_DEFAULT_LIMITS);
  assert.equal(AGENT_SCENE_DEFAULT_LIMITS, lightweightCapabilities.AGENT_SCENE_DEFAULT_LIMITS);
  assert.equal(AGENT_SCENE_CAPABILITIES, lightweightCapabilities.AGENT_SCENE_CAPABILITIES);
  assert.equal(scene.capabilities, lightweightCapabilities.AGENT_SCENE_CAPABILITIES);
});

function recipe() {
  return { format: '67js.scene', schemaVersion: 1,
    geometries: [{ id: 'box', type: 'box', bevel: 0 }],
    materials: [{ id: 'finish', color: [0.2, 0.4, 0.6] }],
    nodes: [{ id: 'child', parent: 'root', geometry: 'box', material: 'finish', translation: [1, 2, 0] },
      { id: 'root', label: 'Same label', translation: [3, 0, 0] },
      { id: 'other', label: 'Same label', geometry: 'box', material: 'finish' }] };
}

test('authored look patches preserve resources and undo light, fog, exposure and projector together', () => {
  const session = createAgentScene(recipe());
  const before = session.exportRecipe();
  const parts = session.parts;
  const checkpoint = session.checkpoint();
  session.apply([
    { type: 'set-environment', environment: { world: true, lightDirection: [0, 1, 0], pointLights: [{ position: [1, 2, 3], intensity: 12 }], volumeFog: { density: 0.2 } } },
    { type: 'set-effects', effects: { exposure: 0.8, bloom: { strength: 0.3 } } },
    { type: 'set-shadow', shadow: { extent: 10, far: 40 } },
  ], { expectedRevision: 0 });
  assert.equal(session.parts, parts);
  assert.equal(session.topologyRevision, 0);
  assert.equal(session.environment.volumeFog.density, 0.2);
  assert.deepEqual(session.environment.volumeFog.minimum, before.environment.volumeFog.minimum);
  assert.equal(session.effects.bloom.threshold, before.effects.bloom.threshold);
  const detached = session.environment;
  detached.pointLights[0].position[0] = 999;
  assert.equal(session.environment.pointLights[0].position[0], 1);
  session.apply([{ type: 'set-environment', environment: { pointLights: [] } }], { expectedRevision: 1 });
  assert.equal(session.environment.pointLights.length, 0);
  session.restore(checkpoint, { expectedRevision: 2 });
  assert.deepEqual(session.exportRecipe(), before);
  assert.equal(session.parts, parts);
  assert.equal(session.topologyRevision, 0);
});

test('invalid look in a mixed batch cannot publish transforms, material or render controls', () => {
  const session = createAgentScene(recipe());
  const before = session.exportRecipe();
  const matrix = Array.from(session.parts[0].matrix);
  for (const invalid of [
    { type: 'set-environment', environment: { lightDirection: [0, 0, 0] } },
    { type: 'set-effects', effects: { bloom: { unknown: 1 } } },
    { type: 'set-shadow', shadow: { near: 15, far: 1 } },
  ]) {
    assert.throws(() => session.apply([
      { type: 'set-node', id: 'child', translation: [9, 8, 7] },
      { type: 'set-material', id: 'finish', color: [1, 0, 0] },
      { type: 'set-effects', effects: { exposure: 2 } }, invalid,
    ], { expectedRevision: 0 }));
    assert.equal(session.revision, 0);
    assert.deepEqual(session.exportRecipe(), before);
    assert.deepEqual(Array.from(session.parts[0].matrix), matrix);
  }
});

test('shader arithmetic rejects cancelling product overflow and nonfinite emission atomically', () => {
  const input = recipe();
  const coordinate = Math.fround(1e20);
  const nextCoordinate = Math.fround(coordinate + 1e14);
  input.geometries = [{ id: 'box', type: 'extrude', depth: 1,
    contour: [[coordinate, coordinate], [nextCoordinate, coordinate], [nextCoordinate, nextCoordinate], [coordinate, nextCoordinate]] }];
  input.nodes = [
    { id: 'root' },
    { id: 'child', parent: 'root', geometry: 'box', material: 'finish', rotation: [0, 0, Math.sin(Math.PI / 8), Math.cos(Math.PI / 8)] },
  ];
  const session = createAgentScene(input);
  const before = session.exportRecipe();
  const matrix = Array.from(session.parts[0].matrix);
  assert.throws(() => session.apply([{ type: 'set-node', id: 'root', scale: [1e20, 1e-20, 1] }], { expectedRevision: 0 }), /world geometry bounds/);
  assert.throws(() => session.apply([{ type: 'set-material', id: 'finish', emission: 1e30, emissiveColor: [1e30, 0, 0] }], { expectedRevision: 0 }), /Emissive radiance/);
  assert.deepEqual(session.exportRecipe(), before);
  assert.deepEqual(Array.from(session.parts[0].matrix), matrix);
  assert.equal(session.revision, 0);
  input.materials[0].tag = 'unlit';
  input.materials[0].emission = 70000;
  input.materials[0].emissiveColor = [1, 0, 0];
  assert.throws(() => createAgentScene(input), /half-float HDR/);
});

test('recipes author liquid, foam and blended glass with batch-safe material handles', () => {
  assert.deepEqual(AGENT_SCENE_CAPABILITIES.materialTags, ['surface', 'unlit', 'liquid', 'foam', 'foliage', 'grass', 'water']);
  const input = recipe();
  input.materials.push({ id: 'water', tag: 'liquid', color: [0.56, 0.84, 0.88], roughness: 0.05 });
  input.materials.push({ id: 'glass', color: [0.9, 0.95, 1], opacity: 0.3, doubleSided: true });
  input.environment = { liquid: { thickness: 0.8 } };
  const session = createAgentScene(input);
  const exported = session.exportRecipe();
  const glass = exported.materials.find(material => material.id === 'glass');
  assert.equal(glass.alphaMode, 'blend', 'opacity below one opts into blending');
  assert.equal(glass.doubleSided, true);
  assert.equal(exported.materials.find(material => material.id === 'finish').alphaMode, 'opaque');
  assert.equal(session.environment.liquid.thickness, 0.8);
  assert.equal(session.environment.liquid.ior, 1.33);
  const finishMaterial = session.parts.find(part => part.name === 'child').material;
  session.apply([{ type: 'set-material', id: 'finish', color: [1, 0, 0] }], { expectedRevision: 0 });
  assert.equal(session.parts.find(part => part.name === 'child').material, finishMaterial, 'a color edit keeps the batch');
  session.apply([{ type: 'set-material', id: 'finish', opacity: 0.5 }], { expectedRevision: 1 });
  const blended = session.parts.find(part => part.name === 'child').material;
  assert.notEqual(blended, finishMaterial, 'blending changes the batch, so the part is replaced');
  assert.equal(blended.alphaMode, 'blend');
  assert.throws(() => session.apply([{ type: 'set-material', id: 'finish', alphaMode: 'mask' }], { expectedRevision: 2 }), /alphaMode/);
  assert.throws(() => session.apply([{ type: 'set-environment', environment: { liquid: { ior: 9 } } }], { expectedRevision: 2 }), /liquid\.ior/);
  assert.throws(() => session.apply([{ type: 'set-environment', environment: { liquid: { depth: 1 } } }], { expectedRevision: 2 }), /Unknown liquid/);
});

test('trailing sparse array holes reject recipes and command batches without commit', () => {
  const input = recipe();
  input.nodes.length++;
  assert.throws(() => createAgentScene(input), /trailing holes/);
  const session = createAgentScene(recipe());
  const before = session.exportRecipe();
  const operations = [{ type: 'set-node', id: 'root', translation: [2, 0, 0] }];
  operations.length++;
  assert.throws(() => session.apply(operations, { expectedRevision: 0 }), /trailing holes/);
  assert.deepEqual(session.exportRecipe(), before);
  assert.equal(session.revision, 0);
});

test('shared resources and retained renderer identities survive apply and restore', () => {
  const input = recipe();
  const session = createAgentScene(input);
  input.nodes[1].translation[0] = 100;
  const parts = session.parts;
  const identities = parts.map(part => [part, part.matrix, part.geometry, part.material]);
  assert.equal(parts[0].geometry, parts[1].geometry);
  assert.equal(parts[0].material, parts[1].material);
  assert.equal(parts[0].matrix[12], 4);
  assert.equal(session.capabilities, AGENT_SCENE_CAPABILITIES);
  const checkpoint = session.checkpoint();
  assert.equal(session.apply([{ type: 'set-node', id: 'root', translation: [7, 0, 0] },
    { type: 'set-material', id: 'finish', color: [1, 0, 0], emission: 2 }], { expectedRevision: 0 }), 1);
  assert.equal(parts[0].matrix[12], 8);
  assert.deepEqual(parts[1].material.color, [1, 0, 0]);
  session.restore(checkpoint, { expectedRevision: 1 });
  assert.equal(session.revision, 2);
  assert.equal(parts[0].matrix[12], 4);
  assert.deepEqual(parts[0].material.color, [0.2, 0.4, 0.6]);
  parts.forEach((part, index) => {
    [part, part.matrix, part.geometry, part.material].forEach((value, component) => {
      assert.equal(value, identities[index][component]);
    });
  });
  assert.equal(parts[0].material.color, parts[0].material.color);
  assert.equal(session.parts, parts);
  const inspection = session.inspect();
  assert.equal(inspection.counts.vertices, 24);
  assert.equal(inspection.geometryBytes, 720);
});

test('transactions reject conflicts and invalid late commands without publishing any changes', () => {
  const session = createAgentScene(recipe());
  const before = session.exportRecipe();
  const matrix = Array.from(session.parts[0].matrix);
  const invalidCommands = [
    { type: 'set-node', id: 'root', parent: 'child' },
    { type: 'set-node', id: 'child', parent: 'missing' },
    { type: 'set-node', id: 'child', scale: [0, 1, 1] },
    { type: 'set-node', id: 'child', rotation: [0, 0, 0, 0] },
    { type: 'set-material', id: 'finish', roughness: 2 },
    { type: 'set-camera', eye: [0, 0, 0], target: [0, 0, 0] },
    { type: 'set-camera', near: 10, far: 1 },
    { type: 'set-node', id: 'child', surprise: true },
    { type: 'set-node', id: 'child', translation: null },
  ];
  for (const command of invalidCommands) {
    assert.throws(() => session.apply([{ type: 'set-node', id: 'root', translation: [9, 0, 0] }, command], { expectedRevision: 0 }));
    assert.deepEqual(session.exportRecipe(), before);
    assert.deepEqual(Array.from(session.parts[0].matrix), matrix);
    assert.equal(session.revision, 0);
  }
  assert.throws(() => session.apply([{ type: 'set-camera', fov: 60 }]));
  assert.throws(() => session.apply([{ type: 'set-camera', fov: 60 }], { expectedRevision: 1 }));
  session.apply([{ type: 'set-camera', fov: 60 }], { expectedRevision: 0 });
  assert.equal(session.camera.fov, 60);
});

test('hierarchy and actual vertex bounds agree with an independent double precision transform', () => {
  const input = recipe();
  const rotation = [0, 0, Math.sin(Math.PI / 8) * 2, Math.cos(Math.PI / 8) * 2];
  input.nodes[1].rotation = rotation;
  input.nodes[1].scale = [2, 3, 4];
  input.nodes[0].scale = [0.5, 1.5, 0.75];
  const session = createAgentScene(input);
  const root = new Matrix4().compose(new Vector3(3, 0, 0), new Quaternion(...rotation).normalize(), new Vector3(2, 3, 4));
  const child = new Matrix4().compose(new Vector3(1, 2, 0), new Quaternion(), new Vector3(0.5, 1.5, 0.75));
  const world = root.multiply(child);
  const minimum = [Infinity, Infinity, Infinity];
  const maximum = [-Infinity, -Infinity, -Infinity];
  for (const x of [-0.5, 0.5]) {
    for (const y of [-0.5, 0.5]) {
      for (const z of [-0.5, 0.5]) {
        const point = new Vector3(x, y, z).applyMatrix4(world).toArray();
        for (let axis = 0; axis < 3; axis++) {
          minimum[axis] = Math.min(minimum[axis], point[axis]);
          maximum[axis] = Math.max(maximum[axis], point[axis]);
        }
      }
    }
  }
  const actual = session.inspect({ ids: ['child'], includeBounds: true }).nodes[0].bounds;
  for (let axis = 0; axis < 3; axis++) {
    assert.ok(Math.abs(actual.min[axis] - minimum[axis]) < 1e-5);
    assert.ok(Math.abs(actual.max[axis] - maximum[axis]) < 1e-5);
  }
  session.parts[0].matrix.fill(NaN);
  assert.deepEqual(session.inspect({ ids: ['child'], includeBounds: true }).nodes[0].bounds, actual);
  const exported = session.exportRecipe();
  exported.nodes[0].translation[0] = 999;
  const camera = session.camera;
  camera.eye[0] = 999;
  session.apply([{ type: 'set-node', id: 'child', label: 'Renamed' }], { expectedRevision: 0 });
  assert.ok(session.parts[0].matrix.every(Number.isFinite));
  assert.equal(session.inspect({ ids: ['child'] }).nodes[0].label, 'Renamed');
  assert.equal(session.parts[0].name, 'child');
});

test('depth and world overflow checks reject an entire candidate and allow recovery', () => {
  const session = createAgentScene(recipe(), { maxDepth: 2 });
  assert.throws(() => session.apply([{ type: 'set-node', id: 'other', parent: 'child' }], { expectedRevision: 0 }), /maxDepth/);
  assert.throws(() => session.apply([{ type: 'set-node', id: 'root', scale: [1e30, 1e30, 1e30] },
    { type: 'set-node', id: 'child', scale: [1e30, 1e30, 1e30] }], { expectedRevision: 0 }), /finite Float32/);
  assert.equal(session.revision, 0);
  session.apply([{ type: 'set-node', id: 'other', parent: 'root' }], { expectedRevision: 0 });
  assert.equal(session.inspect({ ids: ['other'] }).nodes[0].parent, 'root');
});

test('checkpoints are private, bounded, session-specific and releaseable', () => {
  const session = createAgentScene(recipe(), { maxCheckpoints: 1 });
  const checkpoint = session.checkpoint();
  assert.ok(Object.isFrozen(checkpoint));
  assert.throws(() => session.checkpoint(), /budget/);
  const foreign = createAgentScene(recipe()).checkpoint();
  assert.throws(() => session.restore(foreign, { expectedRevision: 0 }), /Unknown/);
  assert.throws(() => session.releaseCheckpoint(foreign), /Unknown/);
  session.apply([{ type: 'set-node', id: 'root', translation: [8, 0, 0] }], { expectedRevision: 0 });
  assert.throws(() => session.restore(checkpoint, { expectedRevision: 0 }), /expectedRevision/);
  session.restore(checkpoint, { expectedRevision: 1 });
  session.releaseCheckpoint(checkpoint);
  assert.throws(() => session.restore(checkpoint, { expectedRevision: 2 }), /released/);
  assert.throws(() => session.releaseCheckpoint(checkpoint), /released/);
  assert.ok(session.checkpoint());
});

test('camera supports explicit top views and rejects degenerate or collapsed projection ranges', () => {
  const session = createAgentScene(recipe());
  for (const camera of [{ eye: [0, 3, 0], target: [0, 0, 0] }, { up: [0, 0, 0] },
    { near: 1e-100 }, { near: 1, far: 1 + 1e-10 }, { fov: 1e-40 }]) {
    assert.throws(() => session.apply([{ type: 'set-camera', ...camera }], { expectedRevision: 0 }));
    assert.equal(session.revision, 0);
  }
  session.apply([{ type: 'set-camera', eye: [0, 3, 0], target: [0, 0, 0], up: [0, 0, -2] }], { expectedRevision: 0 });
  assert.deepEqual(session.camera.up, [0, 0, -1]);
});

test('finite matrices still reject world geometry overflow using cached local bounds', () => {
  const input = recipe();
  input.geometries = [{ id: 'box', type: 'lathe', profile: [[1e30, -1], [1e30, 1]], segments: 8 }];
  const session = createAgentScene(input);
  const before = session.exportRecipe();
  assert.throws(() => session.apply([{ type: 'set-node', id: 'child', scale: [1e30, 1, 1] }], { expectedRevision: 0 }), /world geometry/);
  assert.deepEqual(session.exportRecipe(), before);
  assert.equal(session.revision, 0);
});

test('recipe boundary rejects malformed JSON, unknown keys and oversized geometry before generation', () => {
  assert.throws(() => createAgentScene({ ...recipe(), eval: 'code' }), /Unknown/);
  assert.throws(() => createAgentScene(recipe(), { maxNodes: 4097 }), /4096/);
  assert.throws(() => createAgentScene(recipe(), { maxRecipeBytes: 100 }), /maxRecipeBytes/);
  assert.throws(() => createAgentScene(recipe(), { maxGeometryBytes: 100 }), /preflight/);
  const huge = recipe();
  huge.geometries = [{ id: 'box', type: 'sphere', segments: 2048, rings: 2048 }];
  assert.throws(() => createAgentScene(huge), /preflight/);
  const cyclic = recipe();
  cyclic.camera = cyclic;
  assert.throws(() => createAgentScene(cyclic), /acyclic/);
  const accessor = recipe();
  Object.defineProperty(accessor, 'camera', {
    enumerable: true,
    get() {
      throw new Error('must not execute');
    },
  });
  assert.throws(() => createAgentScene(accessor), /accessors/);
  const bad = recipe();
  bad.nodes[0].rotation = [0, 0, NaN, 1];
  assert.throws(() => createAgentScene(bad), /JSON/);
});

test('command and resource budgets, bounded inspection and missing IDs report failures', () => {
  assert.throws(() => createAgentScene(recipe(), { maxNodes: 2 }), /resource limit/);
  const extra = recipe();
  extra.geometries.push({ id: 'sphere', type: 'sphere', segments: 8, rings: 4 });
  assert.throws(() => createAgentScene(extra, { maxGeometries: 1 }), /resource limit/);
  const duplicate = recipe();
  duplicate.nodes[2].id = 'root';
  assert.throws(() => createAgentScene(duplicate), /Duplicate/);
  const session = createAgentScene(recipe(), { maxOperations: 1 });
  assert.throws(() => session.apply([{ type: 'set-camera', fov: 60 }, { type: 'set-camera', fov: 70 }], { expectedRevision: 0 }), /maxOperations/);
  assert.throws(() => session.apply([], { expectedRevision: 0 }), /commands/);
  const inspection = session.inspect({ limit: 1 });
  assert.equal(inspection.nodes.length, 1);
  assert.equal(inspection.truncated, true);
  assert.equal(inspection.counts.nodes, 3);
  assert.throws(() => session.inspect({ ids: ['missing'] }), /not found/);
  assert.throws(() => session.inspect({ includeBounds: 'yes' }), /boolean/);
  assert.equal(session.revision, 0);
});

test('detached privileged adapter matrices cannot partially publish a transaction', () => {
  const session = createAgentScene(recipe());
  const before = session.exportRecipe();
  const checkpoint = session.checkpoint();
  structuredClone(session.parts[1].matrix.buffer, { transfer: [session.parts[1].matrix.buffer] });
  assert.throws(() => session.apply([{ type: 'set-node', id: 'root', translation: [10, 0, 0] },
    { type: 'set-material', id: 'finish', color: [1, 0, 0] }], { expectedRevision: 0 }), /detached/);
  assert.equal(session.revision, 0);
  assert.deepEqual(session.exportRecipe(), before);
  assert.deepEqual(session.parts[0].material.color, [0.2, 0.4, 0.6]);
  assert.equal(session.parts[0].matrix[12], 4);
  assert.throws(() => session.restore(checkpoint, { expectedRevision: 0 }), /detached/);
  assert.equal(session.revision, 0);
});

test('all seven generators remain within conservative aggregate vertex and byte estimates', () => {
  const input = { format: '67js.scene', schemaVersion: 1, materials: [{ id: 'material' }], nodes: [], geometries: [
    { id: 'box', type: 'box', subdivisions: 2 },
    { id: 'cylinder', type: 'cylinder', segments: 8, bevelSegments: 2 },
    { id: 'sphere', type: 'sphere', segments: 8, rings: 4 },
    { id: 'torus', type: 'torus', segments: 8, sides: 4, arc: Math.PI },
    { id: 'lathe', type: 'lathe', profile: [[0.5, -1], [1, 0], [0.5, 1]], segments: 8 },
    { id: 'extrude', type: 'extrude', contour: [[0, 0], [1, 0], [1, 1], [0, 1]], depth: 0.5 },
    { id: 'tube', type: 'tube', path: [[0, 0, 0], [0, 1, 0], [1, 2, 0]], segments: 8, radialSegments: 4 },
  ] };
  input.nodes = input.geometries.map(geometry => ({ id: geometry.id, geometry: geometry.id, material: 'material' }));
  const session = createAgentScene(input);
  const inspection = session.inspect({ includeBounds: true });
  assert.equal(inspection.counts.geometries, 7);
  assert.ok(inspection.geometryBytes <= inspection.estimatedGeometryBytes);
  assert.ok(inspection.nodes.every(node => node.bounds.min.every(Number.isFinite)));
  assert.deepEqual(createAgentScene(session.exportRecipe()).inspect(), session.inspect());
  const originalBox = session.parts[0];
  session.apply([{ type: 'set-node', id: 'box', geometry: 'sphere' }], { expectedRevision: 0 });
  assert.notEqual(session.parts[0], originalBox);
  assert.equal(session.parts[0].geometry, session.parts[2].geometry);
  assert.equal(session.topologyRevision, 1);
  assert.throws(() => session.apply([{ type: 'set-material', id: 'material', tag: 'unlit' }], { expectedRevision: 1 }), /Unknown/);
});

function emptyRecipe() {
  return { format: '67js.scene', schemaVersion: 1, geometries: [], materials: [], nodes: [] };
}

test('topology can grow from an empty session while sharing resources and preserving existing part identities', () => {
  const session = createAgentScene(emptyRecipe());
  const emptyParts = session.parts;
  assert.equal(session.topologyRevision, 0);
  assert.equal(session.capabilities.fixedResources, false);
  assert.equal(session.capabilities.dynamicTopology, true);
  session.apply([
    { type: 'add-node', node: { id: 'first', parent: 'group', geometry: 'cube', material: 'red' } },
    { type: 'add-node', node: { id: 'group' } },
    { type: 'add-material', material: { id: 'red', color: [1, 0, 0] } },
    { type: 'add-geometry', geometry: { id: 'cube', type: 'box', bevel: 0 } },
  ], { expectedRevision: 0 });
  assert.notEqual(session.parts, emptyParts);
  assert.equal(session.revision, 1);
  assert.equal(session.topologyRevision, 1);
  const first = session.parts[0];
  session.apply([{ type: 'add-node', node: { id: 'second', geometry: 'cube', material: 'red' } }], { expectedRevision: 1 });
  assert.equal(session.parts[0], first);
  assert.equal(session.parts[1].geometry, first.geometry);
  assert.equal(session.parts[1].material, first.material);
  assert.equal(session.topologyRevision, 2);
  const retainedList = session.parts;
  session.apply([
    { type: 'set-node', id: 'group', translation: [3, 0, 0] },
    { type: 'set-material', id: 'red', roughness: 0.2 },
    { type: 'set-camera', fov: 60 },
    { type: 'add-node', node: { id: 'unused-group' } },
  ], { expectedRevision: 2 });
  assert.equal(session.parts, retainedList);
  assert.equal(first.matrix[12], 3);
  assert.equal(first.material.roughness, 0.2);
  assert.equal(session.topologyRevision, 2);
});

test('topology failures roll back recipes, geometry, materials, matrices and both revisions', () => {
  const session = createAgentScene(recipe());
  const before = session.exportRecipe();
  const parts = session.parts;
  const matrices = parts.map(part => Array.from(part.matrix));
  const invalidBatches = [
    [{ type: 'remove-geometry', id: 'box' }],
    [{ type: 'remove-material', id: 'finish' }],
    [{ type: 'add-node', node: { id: 'cycle', parent: 'child' } }, { type: 'set-node', id: 'root', parent: 'cycle' }],
    [{ type: 'add-node', node: { id: 'mesh', geometry: 'box' } }],
    [{ type: 'add-node', node: { id: 'mesh', geometry: 'missing', material: 'finish' } }],
    [{ type: 'add-node', node: { id: 'mesh', parent: 'missing' } }],
    [{ type: 'add-geometry', geometry: { id: 'box', type: 'sphere' } }],
    [{ type: 'add-material', material: { id: 'finish' } }],
    [{ type: 'add-node', node: { id: 'root' } }],
    [{ type: 'remove-node', id: 'missing' }],
    [{ type: 'remove-geometry', id: 'missing' }],
    [{ type: 'remove-material', id: 'missing' }],
    [{ type: 'add-geometry', geometry: { id: 'invalid', type: 'box', bevel: 2 } }],
    [{ type: 'add-material', material: { id: 'invalid', roughness: 2 } }],
    [{ type: 'add-geometry', geometry: { id: 'huge', type: 'sphere', segments: 2048, rings: 2048 } }],
    [{ type: 'remove-node', id: 'root', recursive: 'true' }],
    [{ type: 'remove-node', id: 'other', extra: true }],
    [{ type: 'add-node', node: { id: 'mesh' }, extra: true }],
    [{ type: 'add-node', node: { id: 'mesh', extra: true } }],
  ];
  for (const operations of invalidBatches) {
    assert.throws(() => session.apply([
      { type: 'set-material', id: 'finish', color: [1, 0, 0] },
      { type: 'set-node', id: 'root', translation: [8, 0, 0] },
      ...operations,
    ], { expectedRevision: 0 }));
    assert.deepEqual(session.exportRecipe(), before);
    assert.equal(session.parts, parts);
    assert.deepEqual(parts.map(part => Array.from(part.matrix)), matrices);
    assert.deepEqual(parts[0].material.color, [0.2, 0.4, 0.6]);
    assert.equal(session.revision, 0);
    assert.equal(session.topologyRevision, 0);
  }
  session.apply([{ type: 'remove-node', id: 'other' }], { expectedRevision: 0 });
  assert.equal(session.parts[0], parts[0]);
  assert.equal(session.topologyRevision, 1);
});

test('node deletion distinguishes nonrecursive rejection from explicit subtree removal', () => {
  const input = recipe();
  input.nodes.push({ id: 'grandchild', parent: 'child', geometry: 'box', material: 'finish' });
  const session = createAgentScene(input);
  assert.throws(() => session.apply([
    { type: 'remove-node', id: 'root' }, { type: 'remove-node', id: 'child', recursive: true },
  ], { expectedRevision: 0 }), /Nonrecursive/);
  session.apply([{ type: 'remove-node', id: 'root', recursive: true }], { expectedRevision: 0 });
  assert.deepEqual(session.exportRecipe().nodes.map(node => node.id), ['other']);
  assert.deepEqual(session.parts.map(part => part.name), ['other']);
  assert.equal(session.inspect().counts.geometries, 1);
  session.apply([
    { type: 'remove-node', id: 'other' },
    { type: 'remove-material', id: 'finish' },
    { type: 'remove-geometry', id: 'box' },
  ], { expectedRevision: 1 });
  assert.equal(session.parts.length, 0);
  assert.equal(session.inspect().residentGeometryBytes, 0);
});

test('resource removal and node rebinding resolve final references after sequential commands', () => {
  const session = createAgentScene(recipe());
  const oldParts = session.parts;
  session.apply([
    { type: 'remove-geometry', id: 'box' },
    { type: 'remove-material', id: 'finish' },
    { type: 'add-geometry', geometry: { id: 'sphere', type: 'sphere', segments: 8, rings: 4 } },
    { type: 'add-material', material: { id: 'green', color: [0, 1, 0] } },
    { type: 'set-node', id: 'child', geometry: 'sphere', material: 'green' },
    { type: 'set-node', id: 'other', geometry: 'sphere', material: 'green' },
  ], { expectedRevision: 0 });
  assert.notEqual(session.parts[0], oldParts[0]);
  assert.notEqual(session.parts[0].matrix, oldParts[0].matrix);
  assert.equal(session.parts[0].geometry, session.parts[1].geometry);
  assert.equal(session.parts[0].material, session.parts[1].material);
  assert.equal(session.topologyRevision, 1);
  assert.deepEqual(oldParts[0].material.color, [0.2, 0.4, 0.6]);
  session.apply([{ type: 'set-node', id: 'root', geometry: 'sphere', material: 'green' }], { expectedRevision: 1 });
  assert.equal(session.parts.length, 3);
  assert.equal(session.parts[0].name, 'child');
});

test('unchanged definitions reuse geometry while changed definitions replace bound parts', () => {
  const session = createAgentScene(recipe());
  const originalParts = session.parts;
  session.apply([
    { type: 'remove-geometry', id: 'box' },
    { type: 'add-geometry', geometry: { bevel: 0, type: 'box', id: 'box' } },
  ], { expectedRevision: 0 });
  assert.equal(session.parts, originalParts);
  assert.equal(session.topologyRevision, 0);
  session.apply([
    { type: 'remove-geometry', id: 'box' },
    { type: 'add-geometry', geometry: { id: 'box', type: 'sphere', segments: 8, rings: 4 } },
  ], { expectedRevision: 1 });
  assert.notEqual(session.parts[0].geometry, originalParts[0].geometry);
  assert.notEqual(session.parts[0], originalParts[0]);
  assert.equal(session.parts[0].geometry, session.parts[1].geometry);
  assert.equal(session.topologyRevision, 1);
});

test('checkpoints restore removed geometry and parts with bounded private retained identities', () => {
  const session = createAgentScene(recipe());
  const originalParts = session.parts;
  const checkpoint = session.checkpoint();
  session.apply([
    { type: 'remove-node', id: 'root', recursive: true },
    { type: 'remove-node', id: 'other' },
    { type: 'remove-geometry', id: 'box' },
    { type: 'remove-material', id: 'finish' },
  ], { expectedRevision: 0 });
  assert.equal(session.parts.length, 0);
  assert.equal(session.inspect().geometryBytes, 0);
  assert.equal(session.inspect().residentGeometryBytes, 720);
  session.restore(checkpoint, { expectedRevision: 1 });
  assert.equal(session.parts[0], originalParts[0]);
  assert.equal(session.parts[1], originalParts[1]);
  assert.equal(session.topologyRevision, 2);
  const restoredList = session.parts;
  session.restore(checkpoint, { expectedRevision: 2 });
  assert.equal(session.parts, restoredList);
  assert.equal(session.topologyRevision, 2);
  session.releaseCheckpoint(checkpoint);
  assert.equal(session.inspect().residentGeometryBytes, 720);
});

test('peak geometry budgets count checkpoint ownership and free it on release', () => {
  const session = createAgentScene(recipe(), { maxVertices: 24, maxGeometryBytes: 1344 });
  const originalParts = session.parts;
  const firstCheckpoint = session.checkpoint();
  const secondCheckpoint = session.checkpoint();
  assert.equal(session.inspect().residentGeometryVertices, 24);
  session.apply([
    { type: 'remove-node', id: 'root', recursive: true }, { type: 'remove-node', id: 'other' },
    { type: 'remove-geometry', id: 'box' }, { type: 'remove-material', id: 'finish' },
  ], { expectedRevision: 0 });
  const add = [{ type: 'add-geometry', geometry: { id: 'new', type: 'box', bevel: 0 } }];
  assert.throws(() => session.apply(add, { expectedRevision: 1 }), /peak/);
  assert.equal(session.revision, 1);
  session.releaseCheckpoint(firstCheckpoint);
  assert.throws(() => session.apply(add, { expectedRevision: 1 }), /peak/);
  session.restore(secondCheckpoint, { expectedRevision: 1 });
  assert.equal(session.parts[0], originalParts[0]);
  session.apply([
    { type: 'remove-node', id: 'root', recursive: true }, { type: 'remove-node', id: 'other' },
    { type: 'remove-geometry', id: 'box' }, { type: 'remove-material', id: 'finish' },
  ], { expectedRevision: 2 });
  session.releaseCheckpoint(secondCheckpoint);
  assert.equal(session.inspect().residentGeometryBytes, 0);
  session.apply(add, { expectedRevision: 3 });
  assert.equal(session.inspect().geometryBytes, 720);
  assert.equal(session.topologyRevision, 3);
});

test('atomic replacement budgets include old active resources until commit', () => {
  const session = createAgentScene(recipe(), { maxGeometryBytes: 1344 });
  assert.throws(() => session.apply([
    { type: 'remove-geometry', id: 'box' },
    { type: 'add-geometry', geometry: { id: 'box', type: 'box', bevel: 0, subdivisions: 1 } },
  ], { expectedRevision: 0 }), /peak/);
  assert.equal(session.revision, 0);
  assert.equal(session.topologyRevision, 0);
  assert.equal(session.inspect().geometryBytes, 720);
});

test('new topology enforces world geometry overflow and depth before publishing', () => {
  const session = createAgentScene(emptyRecipe(), { maxDepth: 1 });
  const emptyParts = session.parts;
  assert.throws(() => session.apply([
    { type: 'add-node', node: { id: 'root' } },
    { type: 'add-node', node: { id: 'child', parent: 'root' } },
  ], { expectedRevision: 0 }), /maxDepth/);
  assert.throws(() => session.apply([
    { type: 'add-geometry', geometry: { id: 'huge', type: 'lathe', profile: [[1e30, -1], [1e30, 1]], segments: 8 } },
    { type: 'add-material', material: { id: 'finish' } },
    { type: 'add-node', node: { id: 'mesh', geometry: 'huge', material: 'finish', scale: [1e30, 1, 1] } },
  ], { expectedRevision: 0 }), /world geometry bounds/);
  assert.equal(session.parts, emptyParts);
  assert.equal(session.revision, 0);
  assert.equal(session.topologyRevision, 0);
});

test('topology rejects stale revisions and detached active or checkpoint matrices atomically', () => {
  const session = createAgentScene(recipe());
  const checkpoint = session.checkpoint();
  const oldParts = session.parts;
  session.apply([{ type: 'remove-node', id: 'other' }], { expectedRevision: 0 });
  assert.throws(() => session.apply([{ type: 'remove-node', id: 'child' }], { expectedRevision: 0 }), /expectedRevision/);
  structuredClone(oldParts[1].matrix.buffer, { transfer: [oldParts[1].matrix.buffer] });
  const before = session.exportRecipe();
  const parts = session.parts;
  assert.throws(() => session.restore(checkpoint, { expectedRevision: 1 }), /detached/);
  assert.deepEqual(session.exportRecipe(), before);
  assert.equal(session.parts, parts);
  assert.equal(session.topologyRevision, 1);
  structuredClone(parts[0].matrix.buffer, { transfer: [parts[0].matrix.buffer] });
  assert.throws(() => session.apply([{ type: 'remove-node', id: 'child' }], { expectedRevision: 1 }), /detached/);
  assert.deepEqual(session.exportRecipe(), before);
  assert.equal(session.revision, 1);
});

test('a node with a geometry and no material gets an explicit default material, deterministically', () => {
  const input = recipe();
  delete input.nodes[0].material;
  const first = createAgentScene(input).exportRecipe();
  const second = createAgentScene(input).exportRecipe();
  assert.deepEqual(first, second);
  assert.equal(first.nodes.find(node => node.id === 'child').material, 'default');
  assert.deepEqual(first.materials.map(material => material.id), ['finish', 'default']);
  assert.deepEqual(createAgentScene(first).exportRecipe(), first);
});

test('an existing default material is reused and a node with only a material still names the fix', () => {
  const input = recipe();
  input.materials.push({ id: 'default', color: [0.9, 0.1, 0.1] });
  delete input.nodes[0].material;
  const exported = createAgentScene(input).exportRecipe();
  assert.equal(exported.materials.filter(material => material.id === 'default').length, 1);
  const orphan = recipe();
  delete orphan.nodes[1].geometry;
  orphan.nodes[1].material = 'finish';
  assert.throws(() => createAgentScene(orphan), /Name a geometry to draw it, or drop material/);
});

test('a recipe without a materials or geometries list reads them as empty, and the export lists them', () => {
  const minimal = { format: '67js.scene', schemaVersion: 1,
    geometries: [{ id: 'box', type: 'box', bevel: 0 }],
    nodes: [{ id: 'part', geometry: 'box' }] };
  const exported = createAgentScene(minimal).exportRecipe();
  assert.deepEqual(exported.materials.map(material => material.id), ['default']);
  const bare = createAgentScene({ format: '67js.scene', schemaVersion: 1, nodes: [{ id: 'group' }] }).exportRecipe();
  assert.deepEqual(bare.geometries, []);
  assert.deepEqual(bare.materials, []);
  assert.throws(() => createAgentScene({ format: '67js.scene', schemaVersion: 1 }), /nodes/);
});

test("recipe materials accept alphaMode 'add' and keep it when opacity is below one", () => {
  assert.ok(AGENT_SCENE_CAPABILITIES.alphaModes.includes('add'));
  const input = recipe();
  input.materials.push({ id: 'spark', color: [1, 0.6, 0.2], emission: 4, alphaMode: 'add' });
  input.materials.push({ id: 'faint spark', color: [1, 0.6, 0.2], alphaMode: 'add', opacity: 0.4 });
  const exported = createAgentScene(input).exportRecipe();
  assert.equal(exported.materials.find(material => material.id === 'spark').alphaMode, 'add');
  assert.equal(exported.materials.find(material => material.id === 'faint spark').alphaMode, 'add');
  input.materials.push({ id: 'bad', color: [1, 1, 1], alphaMode: 'multiply' });
  assert.throws(() => createAgentScene(input), /alphaMode: got .*; expected one of opaque, blend, add/);
});
