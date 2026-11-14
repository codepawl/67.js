import './support/load-agent-scene-modules.mjs';
import { GEOMETRY_PROBLEMS } from '../src/mesh-lint.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createAgentScene, loadMeshBooleans, needsMeshBooleans } from '../src/agent-scene.js';

// The build-crucible-scene skill teaches agents mesh modeling by example. Every json block in its reference must keep
// building a clean mesh, so an API change that breaks an example fails here instead of misleading an agent.
const referenceUrl = new URL('../skills/build-crucible-scene/references/mesh-modeling.md', import.meta.url);
const reference = await readFile(referenceUrl, 'utf8');
const geometries = [...reference.matchAll(/```json\r?\n([\s\S]*?)```/g)].map(match => JSON.parse(match[1]));

test('the skill reference has mesh recipes to check', () => {
  assert.ok(geometries.length >= 6);
  for (const geometry of geometries) assert.equal(geometry.type, 'mesh');
});

for (const geometry of geometries) {
  test(`skill recipe "${geometry.id}" builds a clean mesh`, async () => {
    if (needsMeshBooleans(geometry)) await loadMeshBooleans();
    const scene = createAgentScene({
      format: 'crucible.scene', schemaVersion: 1,
      geometries: [geometry],
      materials: [{ id: 'grey', color: [0.6, 0.6, 0.6] }],
      nodes: [{ id: geometry.id, geometry: geometry.id, material: 'grey' }],
    });
    const [report] = scene.inspectMeshes().meshes;
    assert.equal(report.ok, true, JSON.stringify(report.problems));
    assert.deepEqual(report.problems.filter(problem => !(problem.kind in GEOMETRY_PROBLEMS)), []);
    assert.equal(report.parts.closed, report.parts.count, 'every part is closed');
  });
}
