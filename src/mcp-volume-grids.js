import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { resolve } from 'node:path';
import { setVolumeGridLoader, VOLUME_GRID_MAX_BYTES } from './volume-grid.js';
import { VOLUME_GRID_SEQUENCE_MAX_BYTES, VOLUME_GRID_SEQUENCE_MAX_FRAMES } from './volume-grid-sequence.js';

// Lets a recipe name a grid volume's file (`grid: "blast.67vg"`) in the MCP server: the name is looked up in one folder, never as a path, so a
// recipe cannot read anywhere else. The folder is the server's working directory unless this variable names another.
export const GRID_DIRECTORY_VARIABLE = 'JS67_GRID_DIRECTORY';
const GRID_FILE_NAME = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*\.67vg$/;

function gridRoot(directory) {
  return resolve(directory || process.env[GRID_DIRECTORY_VARIABLE] || process.cwd());
}

/** The bytes of the grid file `name` in `directory`, or null when the name is not a plain .67vg file name or no such file exists. */
export function readVolumeGridFile(name, directory) {
  if (typeof name !== 'string' || !GRID_FILE_NAME.test(name)) return null;
  const path = resolve(gridRoot(directory), name);
  let descriptor;
  try {
    descriptor = openSync(path, 'r');
  } catch {
    return null;
  }
  try {
    // The size comes from the open file, so the file checked is the file read.
    const size = fstatSync(descriptor).size;
    if (size > VOLUME_GRID_MAX_BYTES + 4096) throw new RangeError(`grid file "${name}" is ${size} bytes, over the ${VOLUME_GRID_MAX_BYTES} byte limit; convert it with a lower --max-resolution`);
    const bytes = new Uint8Array(size);
    let offset = 0;
    while (offset < size) {
      const read = readSync(descriptor, bytes, offset, size - offset, offset);
      if (read === 0) break;
      offset += read;
    }
    return offset === size ? bytes : bytes.subarray(0, offset);
  } finally {
    closeSync(descriptor);
  }
}

/** Makes volume grid names that end in .67vg load from `directory`. */
export function installVolumeGridFiles(directory) {
  const root = gridRoot(directory);
  setVolumeGridLoader(name => readVolumeGridFile(name, root));
}

/** The grid volumes of a recipe or edit list: one `{ names, label }` per volume, `names` being its `frames` or its one `grid`. */
export function volumeGridUses(value) {
  const uses = [];
  const visit = (node, depth) => {
    if (!node || typeof node !== 'object' || depth > 12) return;
    if (Array.isArray(node)) {
      node.forEach(child => visit(child, depth + 1));
      return;
    }
    if (Array.isArray(node.localVolumes)) {
      node.localVolumes.forEach((volume, index) => {
        if (!volume || typeof volume !== 'object' || volume.shape !== 'grid') return;
        uses.push({ names: Array.isArray(volume.frames) ? volume.frames : [volume.grid], label: `environment.localVolumes[${index}]` });
      });
    }
    Object.values(node).forEach(child => visit(child, depth + 1));
  };
  visit(value, 0);
  return uses;
}

/**
 * The grid files a recipe or edit list names, as a Map of name to bytes, for the preview page, which has no file access. Throws an error that says
 * what to pass instead when a name is not a .67vg file name, no such file is in the grid folder, or a sequence is over its byte budget.
 */
export function readVolumeGridFiles(value, directory) {
  const files = new Map();
  for (const { names, label } of volumeGridUses(value)) {
    if (names.length > VOLUME_GRID_SEQUENCE_MAX_FRAMES) throw new RangeError(`${label}.frames lists ${names.length} grids; a sequence has at most ${VOLUME_GRID_SEQUENCE_MAX_FRAMES}`);
    let sequenceBytes = 0;
    for (const name of names) {
      if (typeof name !== 'string' || !GRID_FILE_NAME.test(name)) {
        throw new TypeError(`${label} names the grid ${JSON.stringify(name)}; in the MCP server a grid is a file name such as "blast.67vg" in the grid folder, never a path`);
      }
      if (!files.has(name)) {
        const bytes = readVolumeGridFile(name, directory);
        if (!bytes) {
          throw new RangeError(`${label} names the grid "${name}", which is not in the grid folder: put the file made by scripts/vdb-to-grid.py there (the server's working directory, or the folder ${GRID_DIRECTORY_VARIABLE} names)`);
        }
        files.set(name, bytes);
      }
      sequenceBytes += files.get(name).length;
      if (sequenceBytes > VOLUME_GRID_SEQUENCE_MAX_BYTES) {
        throw new RangeError(`${label}.frames hold ${sequenceBytes} bytes by "${name}", over the ${VOLUME_GRID_SEQUENCE_MAX_BYTES} byte limit for a sequence; use fewer frames or convert with a lower --max-resolution`);
      }
    }
  }
  return files;
}
