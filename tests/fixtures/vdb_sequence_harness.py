# /// script
# requires-python = ">=3.10"
# dependencies = ["numpy"]
# ///
"""Runs scripts/vdb-to-grid.py --sequence on three made-up frames (a ball that grows and moves) without any VDB file.

    uv run --no-project tests/fixtures/vdb_sequence_harness.py <script> <output folder>

The frames are named frame_2, frame_10 and frame_1 so the run proves the numeric order; it prints the frames list the script printed.
"""
import importlib.util
import sys
from pathlib import Path
from types import SimpleNamespace

import numpy

script_path, output_folder = sys.argv[1], Path(sys.argv[2])
specification = importlib.util.spec_from_file_location("vdb_to_grid", script_path)
converter = importlib.util.module_from_spec(specification)
specification.loader.exec_module(converter)

# Each frame is one 8-voxel leaf, at a different place, so every frame has its own box and the union is larger than any of them.
FRAMES = {"frame_1.vdb": (0, 0, 0), "frame_2.vdb": (8, 0, 0), "frame_10.vdb": (8, 8, 0)}


def fake_vdb(path):
    leaf = SimpleNamespace(level=0, origin=FRAMES[Path(path).name], data=numpy.full(512, 1.0, dtype=numpy.float32))
    return {"density": {"roots": [leaf], "voxel_size": (0.1, 0.1, 0.1)}}


converter.read_vdb = fake_vdb
converter.glob.glob = lambda pattern: sorted(FRAMES)
sys.argv = ["vdb-to-grid.py", "sim/frame_*.vdb", str(output_folder / "blast"), "--sequence", "--max-resolution", "16", "--up", "y"]
converter.main()
