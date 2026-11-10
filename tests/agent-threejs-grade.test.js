import assert from 'node:assert/strict';
import test from 'node:test';
import { worldGeometriesOf } from '../bench/agent-modeling/look.mjs';
import { REFERENCES } from '../bench/agent-modeling/references.mjs';
import { gradeGeometries, scoreSilhouetteOfGeometries } from '../bench/agent-modeling/threejs.mjs';
import { taskById } from '../bench/agent-modeling/tasks.mjs';

const asJson = geometries => geometries.map(({ positions, indices }) => ({ positions: Array.from(positions), indices: Array.from(indices) }));

test('the three.js grader passes the reference geometry of each sampled task and scores its look as 1', async () => {
  for (const id of ['crate', 'bolt', 'window', 'table', 'fence', 'bracket']) {
    const geometries = asJson(await worldGeometriesOf(REFERENCES[id]));
    const grade = gradeGeometries(taskById(id), geometries);
    assert.equal(grade.pass, true, `${id}: ${JSON.stringify(grade.results.filter(result => !result.pass))}`);
    assert.equal((await scoreSilhouetteOfGeometries(id, geometries)).mean, 1);
  }
});

test('the three.js grader fails an open surface of the wrong size', () => {
  const crate = taskById('crate');
  const quad = { positions: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0], indices: [0, 1, 2, 0, 2, 3] };
  const grade = gradeGeometries(crate, [quad]);
  assert.equal(grade.pass, false);
  assert.equal(grade.results.find(result => result.kind === 'lint').pass, false);
});
