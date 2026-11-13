import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { resolve } from 'node:path';
import { setVolumeGridLoader, VOLUME_GRID_MAX_BYTES } from './volume-grid.js';

// Lets a recipe name a grid volume's file (`grid: "blast.67vg"`) in the MCP server: the name is looked up in one folder, never as a path, so a
// recipe cannot read anywhere else. The folder is the server's working directory unless this variable names another.
export const GRID_DIRECTORY_VARIABLE = 'JS67_GRID_DIRECTORY';
const GRID_FILE_NAME = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*\.67vg$/;

/** Makes volume grid names that end in .67vg load from `directory`. */
export function installVolumeGridFiles(directory = process.env[GRID_DIRECTORY_VARIABLE] || process.cwd()) {
  const root = resolve(directory);
  setVolumeGridLoader(name => {
    if (!GRID_FILE_NAME.test(name)) return null;
    const path = resolve(root, name);
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
  });
}
