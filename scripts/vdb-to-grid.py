# /// script
# requires-python = ">=3.10"
# dependencies = ["numpy"]
# ///
"""Convert an OpenVDB file of float grids (smoke, fire, explosions) to a Crucible volume grid file.

    uv run --no-project scripts/vdb-to-grid.py frame.vdb out.67vg --max-resolution 128
    uv run --no-project scripts/vdb-to-grid.py frame.vdb out.67vg --map flame=flames --map temperature=heat
    uv run --no-project scripts/vdb-to-grid.py "sim/smoke_*.vdb" blast --sequence --max-resolution 128

With --sequence the first argument is a glob and the second a name prefix: the matching files, in numeric order, become blast_0000.67vg,
blast_0001.67vg and so on, all on one box and resolution (the union of every frame's box) with the same channels (a channel any frame has, zero in the others), and the script prints the `frames` list for the
volume. Frame size at 128 cubed is 4 MiB per channel and at 256 cubed 32 MiB; a sequence may hold 256 MiB in all (docs/volumetric.md).

The reader is written here, so no OpenVDB build or wheel is needed (none is published for Windows). It reads OpenVDB file
versions 222 and later with float grids of tree shape 5-4-3 (the shape every DCC tool writes), stored as full or half floats,
uncompressed or zip compressed. A Blosc compressed file stops with an error that says how to re-export it.

Output (docs/volumetric.md, "Grid volumes"): the bytes "67VG", a uint32 version (1), a uint32 header length, a JSON header padded
to 4 bytes, then each channel as half floats with x fastest, then y, then z. The axes are y up: a Z up VDB (Blender, EmberGen)
is turned so its z becomes y.
"""
import argparse
import glob
import json
import re
import struct
import sys
import zlib
from pathlib import Path

import numpy

MAGIC = 0x56444220
LEAF_DIMENSION = 8
MAXIMUM_SEQUENCE_FRAMES = 512  # src/volume-grid-sequence.js
MAXIMUM_SEQUENCE_BYTES = 256 * 1024 * 1024
LEVEL_LOG2 = (3, 4, 5)  # leaf, first internal node, second internal node (child counts 8^3, 16^3, 32^3 per node)
COMPRESS_ZIP = 0x1
COMPRESS_ACTIVE_MASK = 0x2
COMPRESS_BLOSC = 0x4
MAXIMUM_AXIS = 256
CHANNEL_NAMES = ("density", "temperature", "flame")
DEFAULT_SOURCE_NAMES = {
    "density": ("density",),
    "temperature": ("temperature", "heat", "temp"),
    "flame": ("flame", "flames", "fire", "fuel"),
}
# Mask metadata of OpenVDB's compressed value blocks.
NO_MASK_OR_INACTIVE_VALS, NO_MASK_AND_MINUS_BG, NO_MASK_AND_ONE_INACTIVE_VAL, MASK_AND_NO_INACTIVE_VALS, MASK_AND_ONE_INACTIVE_VAL, MASK_AND_TWO_INACTIVE_VALS, NO_MASK_AND_ALL_VALS = range(7)


class Reader:
    def __init__(self, data):
        self.data = memoryview(data)
        self.offset = 0

    def take(self, count):
        end = self.offset + count
        if end > len(self.data):
            raise ValueError("the VDB file ends early; it is damaged or not an OpenVDB file")
        chunk = self.data[self.offset:end]
        self.offset = end
        return chunk

    def unpack(self, form):
        return struct.unpack("<" + form, self.take(struct.calcsize("<" + form)))

    def string(self):
        (length,) = self.unpack("I")
        return bytes(self.take(length)).decode("utf-8", errors="replace")

    def metadata(self):
        (count,) = self.unpack("I")
        result = {}
        for _ in range(count):
            name = self.string()
            type_name = self.string()
            (size,) = self.unpack("I")
            raw = bytes(self.take(size))
            if type_name == "string":
                result[name] = raw[4:].decode("utf-8", errors="replace")
            elif type_name == "vec3i":
                result[name] = struct.unpack("<3i", raw)
            elif type_name == "vec3d":
                result[name] = struct.unpack("<3d", raw)
            elif type_name == "float":
                result[name] = struct.unpack("<f", raw)[0]
            elif type_name == "int64":
                result[name] = struct.unpack("<q", raw)[0]
        return result


def read_mask(reader, bit_count):
    words = numpy.frombuffer(bytes(reader.take(bit_count // 8)), dtype="<u8")
    return numpy.unpackbits(words.view(numpy.uint8), bitorder="little")[:bit_count].astype(bool)


def read_values(reader, count, compression, from_half, bytes_per_value=None):
    width = 2 if from_half else 4
    expected = count * width
    if compression & COMPRESS_BLOSC:
        raise ValueError("this VDB uses Blosc compression, which this reader does not decode; re-export it with zip or no compression, "
                         "or convert it with Blender (File > Export is not needed: save the volume as .vdb with 'Compression: Zip')")
    if compression & COMPRESS_ZIP:
        (stored,) = reader.unpack("q")
        raw = bytes(reader.take(stored)) if stored > 0 else bytes(reader.take(expected))
        if stored > 0:
            raw = zlib.decompress(raw)
    else:
        raw = bytes(reader.take(expected))
    if len(raw) != expected:
        raise ValueError(f"a value block holds {len(raw)} bytes where {expected} were expected; the file layout is not the one this reader knows")
    if from_half:
        return numpy.frombuffer(raw, dtype="<f2").astype(numpy.float32)
    return numpy.frombuffer(raw, dtype="<f4").copy()


def read_compressed_values(reader, count, value_mask, compression, from_half, background):
    (metadata,) = reader.unpack("b")
    inactive_first = background if metadata == NO_MASK_OR_INACTIVE_VALS else -background
    inactive_second = background
    if metadata in (NO_MASK_AND_ONE_INACTIVE_VAL, MASK_AND_ONE_INACTIVE_VAL, MASK_AND_TWO_INACTIVE_VALS):
        (inactive_first,) = reader.unpack("f")
        if metadata == MASK_AND_TWO_INACTIVE_VALS:
            (inactive_second,) = reader.unpack("f")
    selection = None
    if (compression & COMPRESS_ACTIVE_MASK) and metadata in (MASK_AND_NO_INACTIVE_VALS, MASK_AND_ONE_INACTIVE_VAL, MASK_AND_TWO_INACTIVE_VALS):
        selection = read_mask(reader, count)
    if (compression & COMPRESS_ACTIVE_MASK) and metadata != NO_MASK_AND_ALL_VALS:
        stored = read_values(reader, int(value_mask.sum()), compression, from_half)
        values = numpy.empty(count, dtype=numpy.float32)
        values[value_mask] = stored
        inactive = ~value_mask
        values[inactive] = inactive_first
        if selection is not None:
            values[inactive & selection] = inactive_second
        return values
    return read_values(reader, count, compression, from_half)


class Node:
    def __init__(self, level, origin):
        self.level = level  # 0 leaf, 1 and 2 internal
        self.origin = origin
        self.child_mask = None
        self.value_mask = None
        self.tile_values = None
        self.children = []
        self.data = None


def read_node_topology(reader, level, origin, compression, from_half, background):
    node = Node(level, origin)
    if level == 0:
        node.value_mask = read_mask(reader, LEAF_DIMENSION ** 3)
        return node
    log2 = LEVEL_LOG2[level]
    slots = 1 << (3 * log2)
    node.child_mask = read_mask(reader, slots)
    node.value_mask = read_mask(reader, slots)
    node.tile_values = read_compressed_values(reader, slots, node.value_mask, compression, from_half, background)
    child_extent = 1 << sum(LEVEL_LOG2[:level])
    side = 1 << log2
    for slot in numpy.flatnonzero(node.child_mask):
        x, y, z = int(slot) >> (2 * log2), (int(slot) >> log2) & (side - 1), int(slot) & (side - 1)
        child_origin = (origin[0] + x * child_extent, origin[1] + y * child_extent, origin[2] + z * child_extent)
        node.children.append(read_node_topology(reader, level - 1, child_origin, compression, from_half, background))
    return node


def read_node_buffers(reader, node, compression, from_half, background):
    if node.level == 0:
        node.value_mask = read_mask(reader, LEAF_DIMENSION ** 3)  # a leaf stores its mask again ahead of its values
        node.data = read_compressed_values(reader, LEAF_DIMENSION ** 3, node.value_mask, compression, from_half, background)
        return
    for child in node.children:
        read_node_buffers(reader, child, compression, from_half, background)


def read_grid(reader, descriptor, version):
    (compression,) = reader.unpack("I") if version >= 222 else (0,)
    metadata = reader.metadata()
    transform_name = reader.string()
    if "ScaleTranslate" not in transform_name:
        raise ValueError(f"the transform {transform_name} is not supported; use a UniformScaleTranslateMap grid")
    values = reader.unpack("18d")  # translation, scale values, voxel size, then three derived vec3d
    translation, voxel_size = values[0:3], values[6:9]
    (buffer_count,) = reader.unpack("i")
    background = reader.unpack("f")[0]
    tile_count, child_count = reader.unpack("II")
    from_half = descriptor["type"].endswith("_HalfFloat")
    tiles = []
    for _ in range(tile_count):
        x, y, z = reader.unpack("3i")
        (value,) = reader.unpack("f")
        (active,) = reader.unpack("?")
        tiles.append(((x, y, z), value, active))
    roots = []
    for _ in range(child_count):
        origin = reader.unpack("3i")
        roots.append(read_node_topology(reader, 2, origin, compression, from_half, background))
    for root in roots:
        read_node_buffers(reader, root, compression, from_half, background)
    return {"metadata": metadata, "voxel_size": voxel_size, "translation": translation, "background": background, "tiles": tiles, "roots": roots}


def read_vdb(path):
    reader = Reader(Path(path).read_bytes())
    (magic,) = reader.unpack("q")
    if magic != MAGIC:
        raise ValueError(f"{path} is not an OpenVDB file (wrong magic number)")
    (version,) = reader.unpack("I")
    if version < 222:
        raise ValueError(f"{path} is OpenVDB file version {version}; this reader needs 222 or later, so re-save it from a current tool")
    reader.unpack("II")  # library version
    (has_offsets,) = reader.unpack("b")
    if not has_offsets:
        raise ValueError("this VDB has no grid offsets; re-save it with a current tool")
    reader.take(36)  # file UUID
    reader.metadata()
    (grid_count,) = reader.unpack("I")
    grids = {}
    for _ in range(grid_count):
        name = reader.string().split("\x1e")[0]
        type_name = reader.string()
        reader.string()  # instance parent
        grid_start, block_start, grid_end = reader.unpack("3q")
        descriptor = {"name": name, "type": type_name}
        if not type_name.startswith("Tree_float_5_4_3"):
            reader.offset = grid_end
            print(f"skipping grid '{name}' ({type_name}); only float grids are read", file=sys.stderr)
            continue
        grid = read_grid(reader, descriptor, version)
        reader.offset = grid_end
        grids[name] = grid
    return grids


def leaves_of(grid):
    leaves = []

    def collect(node):
        if node.level == 0:
            leaves.append(node)
        else:
            for child in node.children:
                collect(child)

    for root in grid["roots"]:
        collect(root)
    return leaves


def bounds_of(leaves):
    origins = numpy.array([leaf.origin for leaf in leaves])
    return origins.min(axis=0), origins.max(axis=0) + LEAF_DIMENSION


def densify(leaves, box_minimum, box_shape):
    """Writes the leaves into a dense array[x][y][z] over the box, clipping what falls outside it."""
    dense = numpy.zeros(box_shape, dtype=numpy.float32)
    for leaf in leaves:
        start = [int(leaf.origin[axis] - box_minimum[axis]) for axis in range(3)]
        cut_low = [max(0, -start[axis]) for axis in range(3)]
        cut_high = [min(LEAF_DIMENSION, box_shape[axis] - start[axis]) for axis in range(3)]
        if any(cut_high[axis] <= cut_low[axis] for axis in range(3)):
            continue
        block = leaf.data.reshape(8, 8, 8)
        target = tuple(slice(start[axis] + cut_low[axis], start[axis] + cut_high[axis]) for axis in range(3))
        source_block = tuple(slice(cut_low[axis], cut_high[axis]) for axis in range(3))
        dense[target] = block[source_block]
    return dense


def resample(dense, target):
    """Box-average `dense` down to `target` (each target axis divides evenly after padding)."""
    result = dense
    for axis in range(3):
        factor = -(-result.shape[axis] // target[axis])
        padded = factor * target[axis]
        pad = [(0, 0)] * 3
        pad[axis] = (0, padded - result.shape[axis])
        result = numpy.pad(result, pad)
        shape = list(result.shape)
        shape[axis:axis + 1] = [target[axis], factor]
        result = result.reshape(shape).mean(axis=axis + 1)
    return result


def write_grid(path, channels, size, source):
    resolution = list(next(iter(channels.values())).shape)
    header = json.dumps({"resolution": resolution, "channels": list(channels), "size": size, "source": source}, separators=(",", ":")).encode()
    header += b" " * (-len(header) % 4)
    with open(path, "wb") as output:
        output.write(b"67VG" + struct.pack("<II", 1, len(header)) + header)
        for array in channels.values():
            output.write(numpy.ascontiguousarray(array.transpose(2, 1, 0)).astype("<f2").tobytes())  # x fastest


def natural_key(path):
    """Sorts frame_2 before frame_10: digit runs compare as numbers."""
    return [int(part) if part.isdigit() else part for part in re.split(r"(\d+)", str(path))]


def choose_channels(grids, name_map, source_name):
    """The VDB grid each channel is read from. Stops with the file's name when it has no density grid."""
    chosen = {}
    for channel in CHANNEL_NAMES:
        for candidate in name_map.get(channel, DEFAULT_SOURCE_NAMES[channel]):
            if candidate in grids:
                chosen[channel] = candidate
                break
    if "density" not in chosen:
        raise SystemExit(f"{source_name}: no density grid; the file holds: {', '.join(grids) or 'no float grids'}. Pass --map density=<grid name>")
    return chosen


def output_resolution(box_shape, arguments):
    """The resolution a box is written at, and its edge lengths in voxels, in the output's axis order."""
    scale = min(1.0, arguments.max_resolution / max(box_shape))
    target = tuple(max(1, round(extent * scale)) for extent in box_shape)
    if arguments.up == "z":
        target = (target[0], target[2], target[1])
    return target


def convert(grids, chosen, density_leaves, box_minimum, box_maximum, arguments, source_name, output_path, channel_names=None):
    """Writes one grid file on the box [box_minimum, box_maximum). Returns the target resolution and its size in VDB units.

    `channel_names` (sequence mode) lists the channels every frame carries: one this frame lacks, or holds no voxels of, is written as zeros, so
    all the frames of a sequence have the same channels. Without it a channel that is empty in the file is left out.
    """
    box_shape = tuple(int(extent) for extent in box_maximum - box_minimum)
    voxel = grids[chosen["density"]]["voxel_size"]
    wanted = channel_names or list(chosen)
    aligned = {}
    for channel in wanted:
        leaves = density_leaves if channel == "density" else (leaves_of(grids[chosen[channel]]) if channel in chosen else [])
        if leaves or channel_names:
            aligned[channel] = densify(leaves, box_minimum, box_shape)
        else:
            print(f"channel {channel} ({chosen[channel]}) is empty in {source_name} and is left out", file=sys.stderr)
    size_metres = [box_shape[axis] * voxel[axis] for axis in range(3)]
    target = output_resolution(box_shape, arguments)
    if arguments.up == "z":
        # (x, y, z) -> (x, z, -y): rotate the z-up box to y up without mirroring it.
        aligned = {channel: numpy.flip(array, axis=1).transpose(0, 2, 1) for channel, array in aligned.items()}
        size_metres = [size_metres[0], size_metres[2], size_metres[1]]
    outputs = {channel: resample(array, target) for channel, array in aligned.items()}
    write_grid(output_path, outputs, [round(extent, 6) for extent in size_metres], source_name)
    peaks = {channel: float(array.max()) for channel, array in outputs.items()}
    voxels = int(numpy.prod(target))
    print(f"wrote {output_path}: {target[0]}x{target[1]}x{target[2]} voxels, channels {list(outputs)}, "
          f"{voxels * 2 * len(outputs)} bytes of data, size {size_metres} (VDB units), channel maxima {peaks}")
    return target, size_metres


def convert_sequence(files, name_map, arguments):
    # Pass one reads only what the plan needs from each frame: its density box and which channels hold voxels. Every frame is then put on the union of
    # the boxes and carries the union of the channels, so the whole sequence has one resolution and one channel list.
    union_minimum = union_maximum = None
    present = set()
    for file in files:
        grids = read_vdb(file)
        chosen = choose_channels(grids, name_map, file)
        density_leaves = leaves_of(grids[chosen["density"]])
        if density_leaves:
            present.add("density")
            frame_minimum, frame_maximum = bounds_of(density_leaves)
            union_minimum = frame_minimum if union_minimum is None else numpy.minimum(union_minimum, frame_minimum)
            union_maximum = frame_maximum if union_maximum is None else numpy.maximum(union_maximum, frame_maximum)
        else:
            print(f"{file}: the density grid has no voxels; this frame is written empty", file=sys.stderr)
        present.update(channel for channel in chosen if channel != "density" and leaves_of(grids[chosen[channel]]))
    if union_minimum is None:
        raise SystemExit(f"no density voxels in any of the {len(files)} files matching {arguments.vdb!r}")
    channel_names = [channel for channel in CHANNEL_NAMES if channel in present]
    box_shape = tuple(int(extent) for extent in union_maximum - union_minimum)
    shape = output_resolution(box_shape, arguments)
    total = int(numpy.prod(shape)) * 2 * len(channel_names) * len(files)
    if total > MAXIMUM_SEQUENCE_BYTES:
        raise SystemExit(f"{len(files)} frames of {shape[0]}x{shape[1]}x{shape[2]} with {len(channel_names)} channels ({', '.join(channel_names)}) are {total} bytes, "
                         f"over the {MAXIMUM_SEQUENCE_BYTES} byte limit of a sequence; nothing was written. Use a lower --max-resolution or fewer frames")
    names = []
    for index, file in enumerate(files):
        grids = read_vdb(file)
        chosen = choose_channels(grids, name_map, file)
        density_leaves = leaves_of(grids[chosen["density"]])
        name = f"{arguments.output}_{index:04d}.67vg"
        convert(grids, chosen, density_leaves, union_minimum, union_maximum, arguments, Path(file).name, name, channel_names)
        names.append(Path(name).name)
    print(f"{len(files)} frames of {shape[0]}x{shape[1]}x{shape[2]}, channels {channel_names}, {total} bytes in all (a sequence may hold {MAXIMUM_SEQUENCE_BYTES}); the volume's frames:")
    print(json.dumps(names))


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("vdb", help="a VDB file, or with --sequence a glob such as 'sim/smoke_*.vdb'")
    parser.add_argument("output", help="the grid file, or with --sequence the name prefix of the numbered files")
    parser.add_argument("--max-resolution", type=int, default=128, help=f"longest axis in voxels, at most {MAXIMUM_AXIS} (default 128)")
    parser.add_argument("--map", action="append", default=[], metavar="CHANNEL=GRID", help="read a channel from another VDB grid name, e.g. flame=fire")
    parser.add_argument("--up", choices=("y", "z"), default="z", help="the VDB's up axis (default z, as Blender and EmberGen write); the output is y up")
    parser.add_argument("--sequence", action="store_true", help="convert every file the glob matches, in numeric order, onto one shared box, resolution and channel list")
    arguments = parser.parse_args()
    if not 2 <= arguments.max_resolution <= MAXIMUM_AXIS:
        parser.error(f"--max-resolution must be 2 to {MAXIMUM_AXIS}")
    name_map = {}
    for entry in arguments.map:
        channel, _, grid_name = entry.partition("=")
        if channel not in CHANNEL_NAMES or not grid_name:
            parser.error(f"--map takes CHANNEL=GRID with CHANNEL one of {', '.join(CHANNEL_NAMES)}")
        name_map[channel] = (grid_name,)
    if not arguments.sequence:
        grids = read_vdb(arguments.vdb)
        chosen = choose_channels(grids, name_map, arguments.vdb)
        density_leaves = leaves_of(grids[chosen["density"]])
        if not density_leaves:
            raise SystemExit(f"{arguments.vdb}: the density grid has no voxels")
        box_minimum, box_maximum = bounds_of(density_leaves)
        convert(grids, chosen, density_leaves, box_minimum, box_maximum, arguments, Path(arguments.vdb).name, arguments.output)
        return
    files = sorted(glob.glob(arguments.vdb), key=natural_key)
    if not files:
        raise SystemExit(f"no file matches {arguments.vdb!r}; quote the glob so the shell passes it on")
    if len(files) > MAXIMUM_SEQUENCE_FRAMES:
        raise SystemExit(f"{len(files)} files match, over the {MAXIMUM_SEQUENCE_FRAMES} frames a sequence may hold; narrow the glob")
    convert_sequence(files, name_map, arguments)


if __name__ == "__main__":
    main()
