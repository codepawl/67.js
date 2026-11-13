// scripts/vdb-to-grid.py --sequence (#1045): numbered frames on one box and one resolution, in numeric order. The VDB reader is replaced by three
// made-up frames in tests/fixtures/vdb_sequence_harness.py, so no VDB file is needed. Skipped when uv is not installed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeVolumeGrid } from '../src/volume-grid.js';

const uvAvailable = spawnSync('uv', ['--version'], { encoding: 'utf8' }).status === 0;

test('a numbered VDB sequence converts to grid files that share one resolution, in numeric order', { skip: !uvAvailable && 'uv is not installed' }, () => {
  const folder = mkdtempSync(join(tmpdir(), 'grid-sequence-'));
  try {
    const run = spawnSync('uv', ['run', '--no-project', 'tests/fixtures/vdb_sequence_harness.py', 'scripts/vdb-to-grid.py', folder], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    const names = JSON.parse(run.stdout.trim().split('\n').at(-1));
    assert.deepEqual(names, ['blast_0000.67vg', 'blast_0001.67vg', 'blast_0002.67vg']);
    const grids = names.map(name => decodeVolumeGrid(readFileSync(join(folder, name)), name));
    for (const grid of grids) {
      assert.deepEqual(grid.resolution, grids[0].resolution, 'one resolution for every frame');
      assert.deepEqual(grid.size, grids[0].size, 'one size for every frame');
    }
    // The union of the three leaves is 16 x 16 x 8 voxels of 0.1; the ball of frame_1 sits at the low corner, the one of frame_10 at the high corner.
    assert.deepEqual(grids[0].resolution, [16, 16, 8]);
    assert.ok(grids[0].channels.density[0] > 0, 'frame_1 fills the low corner');
    assert.equal(grids[2].channels.density[0], 0, 'frame_10 leaves the low corner empty');
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
