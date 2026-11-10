import './support/load-agent-scene-modules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentScene } from '../src/agent-scene.js';
import { loadMeshBooleans } from '../src/mesh-boolean.js';
import { meshCacheStats } from '../src/agent-mesh.js';

await loadMeshBooleans();

const materials = [{ id: 'steel', color: [0.7, 0.7, 0.72] }];

function bore(cutter, name = 'bore') {
  return { op: 'boolean', operation: 'difference', name, cutter, scale: [0.3, 2, 0.3] };
}

function recipeWith(geometries) {
  return { format: '67js.scene', schemaVersion: 1, geometries, materials, nodes: [{ id: 'block', geometry: geometries[0].id, material: 'steel' }] };
}

function meshReport(geometries) {
  const scene = createAgentScene(recipeWith(geometries));
  return { scene, report: scene.inspectMeshes().meshes[0] };
}

function drilled(id, cutterId) {
  return { id, type: 'mesh', base: { type: 'box', bevel: 0 }, edits: [bore({ geometry: cutterId })] };
}

test('a boolean cuts with another recipe geometry named by ID', () => {
  const { report } = meshReport([
    drilled('block', 'tool'),
    { id: 'tool', type: 'mesh', base: { type: 'cylinder', segments: 24, bevel: 0 }, edits: [] },
  ]);
  assert.equal(report.ok, true, JSON.stringify(report.problems));
  assert.ok(report.edits[0].tags['bore.cut'] > 0);
});

test('an ID cutter gives the same result as the inline record it names', () => {
  const inline = { id: 'block', type: 'mesh', base: { type: 'box', bevel: 0 }, edits: [bore({ type: 'cylinder', segments: 24, bevel: 0 })] };
  const named = meshReport([drilled('block', 'tool'), { id: 'tool', type: 'cylinder', segments: 24, bevel: 0 }]);
  const reference = meshReport([inline]);
  assert.deepEqual(named.report.bounds, reference.report.bounds);
  assert.equal(named.report.parts.closed, reference.report.parts.closed);
});

test('a chain of two cutter geometries resolves, and the result is repeatable', () => {
  const geometries = () => [
    drilled('block', 'drill'),
    { id: 'drill', type: 'mesh', base: { type: 'cylinder', segments: 24, bevel: 0 }, edits: [bore({ geometry: 'slot' }, 'slotted')] },
    { id: 'slot', type: 'box' },
  ];
  const first = meshReport(geometries());
  assert.equal(first.report.ok, true, JSON.stringify(first.report.problems));
  const second = meshReport(geometries());
  assert.deepEqual(second.report, first.report);
});

test('editing the cutter geometry changes the dependent mesh, and unchanged cutters hit the cache', () => {
  const build = segments => meshReport([
    drilled('block', 'tool'),
    { id: 'tool', type: 'cylinder', segments, bevel: 0 },
  ]);
  const vertexCount = built => JSON.stringify(built.report.counts);
  assert.notEqual(vertexCount(build(6)), vertexCount(build(48)));
  const before = meshCacheStats();
  build(48);
  assert.ok(meshCacheStats().hits > before.hits, 'an unchanged cutter and mesh reuse the evaluation cache');
});

test('a cycle is refused with the chain', () => {
  assert.throws(() => createAgentScene(recipeWith([drilled('a', 'b'), drilled('b', 'a')])), /cutter\.geometry: got "a -> b -> a"; expected a geometry that does not cut with itself/);
  assert.throws(() => createAgentScene(recipeWith([drilled('a', 'a')])), /got "a -> a"/);
});

test('a missing ID is refused with the chain and the IDs that exist', () => {
  assert.throws(() => createAgentScene(recipeWith([drilled('a', 'nope')])), /geometries\[0\]\.cutter\.geometry: got "a -> nope"; expected the ID of a geometry in geometries, one of a;/);
});

test('the chain depth is bounded', () => {
  const ids = ['g0', 'g1', 'g2', 'g3', 'g4', 'g5'];
  const geometries = ids.map((id, index) => index < ids.length - 1 ? drilled(id, ids[index + 1]) : { id, type: 'box' });
  assert.throws(() => createAgentScene(recipeWith(geometries)), /got "g0 -> g1 -> g2 -> g3 -> g4 -> g5"; expected a chain of at most 4 cutter geometries/);
  assert.doesNotThrow(() => createAgentScene(recipeWith(geometries.slice(1))));
});

test('the total cutter work is bounded', () => {
  const heavy = { id: 'tool', type: 'sphere', segments: 512, rings: 256 };
  const twice = { ...drilled('block', 'tool'), edits: [bore({ geometry: 'tool' }), bore({ geometry: 'tool' }, 'second')] };
  assert.throws(() => createAgentScene(recipeWith([twice, heavy])), /expected cutter geometries that total at most 250000/);
});

test('replacing the cutter geometry in a live scene rebuilds the mesh that names it', () => {
  const scene = createAgentScene(recipeWith([drilled('block', 'tool'), { id: 'tool', type: 'cylinder', segments: 6, bevel: 0 }]));
  const before = JSON.stringify(scene.inspectMeshes().meshes[0].counts);
  scene.apply([
    { type: 'remove-geometry', id: 'tool' },
    { type: 'add-geometry', geometry: { id: 'tool', type: 'cylinder', segments: 48, bevel: 0 } },
  ], { expectedRevision: 0 });
  assert.notEqual(JSON.stringify(scene.inspectMeshes().meshes[0].counts), before);
});

test('removing a cutter geometry that a mesh names fails with the chain', () => {
  const scene = createAgentScene(recipeWith([drilled('block', 'tool'), { id: 'tool', type: 'box' }]));
  assert.throws(() => scene.apply([{ type: 'remove-geometry', id: 'tool' }], { expectedRevision: 0 }), /got "block -> tool"/);
});

test('a cutter record takes only the geometry field', () => {
  assert.throws(() => createAgentScene(recipeWith([
    { id: 'block', type: 'mesh', base: { type: 'box' }, edits: [bore({ geometry: 'tool', type: 'box' })] },
    { id: 'tool', type: 'box' },
  ])), /put translation, rotation and scale on the boolean edit/);
});
