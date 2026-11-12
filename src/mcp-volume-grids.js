import { readFileSync, statSync } from 'node:fs';
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
    let size;
    try {
      size = statSync(path).size;
    } catch {
      return null;
    }
    if (size > VOLUME_GRID_MAX_BYTES + 4096) throw new RangeError(`grid file "${name}" is ${size} bytes, over the ${VOLUME_GRID_MAX_BYTES} byte limit; convert it with a lower --max-resolution`);
    return new Uint8Array(readFileSync(path));
  });
}
