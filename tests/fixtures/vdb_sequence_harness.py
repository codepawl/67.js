# /// script
# requires-python = ">=3.10"
# dependencies = ["numpy"]
# ///
"""Runs scripts/vdb-to-grid.py --sequence on three made-up frames without any VDB file.

    uv run --no-project tests/fixtures/vdb_sequence_harness.py <script> <output folder> [scenario]

Scenarios: "moving" (default) a block of density that moves, so every frame has its own box; "mixed" frame_1 has density and flame, frame_2 density only and
frame_10 an empty density grid; "over-budget" the byte limit of a sequence is lowered to 100 bytes. The frames are named frame_2, frame_10 and frame_1,
and the glob returns them out of order, so the run proves the numeric order. The last line printed is the frames list.
"""
import importlib.util
import sys
from pathlib import Path
from types import SimpleNamespace

import numpy

script_path, output_folder = sys.argv[1], Path(sys.argv[2])
scenario = sys.argv[3] if len(sys.argv) > 3 else "moving"
specification = importlib.util.spec_from_file_location("vdb_to_grid", script_path)
converter = importlib.util.module_from_spec(specification)
specification.loader.exec_module(converter)

# Each frame is one 8-voxel leaf at a different place, so the union of the boxes is larger than any of them.
ORIGINS = {"frame_1.vdb": (0, 0, 0), "frame_2.vdb": (8, 0, 0), "frame_10.vdb": (8, 8, 0)}


def leaf_at(path, value=1.0):
    return SimpleNamespace(level=0, origin=ORIGINS[Path(path).name], data=numpy.full(512, value, dtype=numpy.float32))


def grid_of(leaves):
    return {"roots": leaves, "voxel_size": (0.1, 0.1, 0.1)}


def fake_vdb(path):
    name = Path(path).name
    grids = {"density": grid_of([leaf_at(path)])}
    if scenario == "mixed":
        if name == "frame_1.vdb":
            grids["flame"] = grid_of([leaf_at(path, 5.0)])
        if name == "frame_10.vdb":
            grids["density"] = grid_of([])
    return grids


converter.read_vdb = fake_vdb
converter.glob.glob = lambda pattern: sorted(ORIGINS)
if scenario == "over-budget":
    converter.MAXIMUM_SEQUENCE_BYTES = 100
sys.argv = ["vdb-to-grid.py", "sim/frame_*.vdb", str(output_folder / "blast"), "--sequence", "--max-resolution", "16", "--up", "y"]
converter.main()
