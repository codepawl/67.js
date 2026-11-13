import { findVolumeGrid } from './volume-grid.js';

// Animated grids (#1045): a grid volume names `frames`, a list of grid files, and `fps`. Every frame is held in memory as half floats, so the whole
// sequence has one byte budget, and the renderer uploads only the frame the time selects.
export const VOLUME_GRID_SEQUENCE_MAX_BYTES = 256 * 1024 * 1024;
export const VOLUME_GRID_SEQUENCE_MAX_FRAMES = 512;

/** Bytes of half floats a decoded grid holds. */
export function volumeGridBytes(grid) {
  return grid.resolution[0] * grid.resolution[1] * grid.resolution[2] * 2 * Object.keys(grid.channels).length;
}

/**
 * The frame a time selects: floor(time * fps), wrapped over the frame count when `loop` is true and held on the last frame otherwise. A time before 0
 * reads frame 0. It depends on nothing but its arguments, so a render at a given time always draws the same frame.
 */
export function volumeGridFrameIndex(frameCount, fps, time, loop = true) {
  const seconds = Number.isFinite(time) ? Math.max(time, 0) : 0;
  const step = Math.floor(seconds * fps + 1e-9);
  return loop ? step % frameCount : Math.min(step, frameCount - 1);
}

/**
 * The decoded grids of a frame list, in order. Throws an error that names the field when the frames differ in resolution or size, or when they hold more
 * than VOLUME_GRID_SEQUENCE_MAX_BYTES together (checked as each frame loads, so an oversized sequence stops early).
 */
export function findVolumeGridSequence(names, label) {
  if (!Array.isArray(names) || names.length < 1 || names.length > VOLUME_GRID_SEQUENCE_MAX_FRAMES) {
    throw new RangeError(`${label}.frames must be a list of 1 to ${VOLUME_GRID_SEQUENCE_MAX_FRAMES} grid names, got ${Array.isArray(names) ? names.length : typeof names}`);
  }
  let total = 0;
  const grids = [];
  names.forEach((name, index) => {
    const grid = findVolumeGrid(name, `${label}.frames[${index}]`);
    total += volumeGridBytes(grid);
    if (total > VOLUME_GRID_SEQUENCE_MAX_BYTES) {
      throw new RangeError(`${label}.frames hold ${total} bytes by frame ${index + 1} of ${names.length}, over the ${VOLUME_GRID_SEQUENCE_MAX_BYTES} byte limit for a sequence; use fewer frames or convert with a lower --max-resolution`);
    }
    if (grids.length > 0) {
      const first = grids[0];
      if (grid.resolution.join('x') !== first.resolution.join('x')) {
        throw new RangeError(`${label}.frames[${index}] ("${name}") is ${grid.resolution.join('x')} but frame 0 is ${first.resolution.join('x')}; every frame of a sequence has one resolution`);
      }
      if (String(grid.size) !== String(first.size)) {
        throw new RangeError(`${label}.frames[${index}] ("${name}") has size ${grid.size} but frame 0 has ${first.size}; every frame of a sequence has one size`);
      }
    }
    grids.push(grid);
  });
  return grids;
}
