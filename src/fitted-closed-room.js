import { CLOSED_ROOM_MAXIMUM_TRIANGLES, CLOSED_ROOM_SHARE, closedRoomShare } from './closed-room.js';

// A closed-room test for rooms with a garden outside the window and heavy props inside. closedRoomShare (which the inspect
// diagnostic uses) shoots from the middle of the bounds, so a lawn beside the room moves the start out of it, and it gives up
// above CLOSED_ROOM_MAXIMUM_TRIANGLES. This one leaves out the heaviest parts and the parts far from the rest, then runs the
// same test; it lives in a module of its own so the core bundle does not carry it.

function triangleCountOf(part) {
  return part.geometry.indices.length / 3;
}

// The lightest parts that fit the triangle budget: walls and floors are a few triangles, a scanned prop is thousands.
function lightestParts(parts) {
  const kept = new Set();
  let total = 0;
  for (const part of [...parts].sort((first, second) => triangleCountOf(first) - triangleCountOf(second))) {
    total += triangleCountOf(part);
    if (total > CLOSED_ROOM_MAXIMUM_TRIANGLES) {
      break;
    }
    kept.add(part);
  }
  return parts.filter(part => kept.has(part));
}

// The middle of a part's local bounds, in world space.
function partCentre(part, matrix) {
  const { positions } = part.geometry;
  const minimum = [Infinity, Infinity, Infinity];
  const maximum = [-Infinity, -Infinity, -Infinity];
  for (let index = 0; index < positions.length; index++) {
    minimum[index % 3] = Math.min(minimum[index % 3], positions[index]);
    maximum[index % 3] = Math.max(maximum[index % 3], positions[index]);
  }
  const middle = minimum.map((value, axis) => (value + maximum[axis]) / 2);
  return [0, 1, 2].map(axis => matrix[axis] * middle[0] + matrix[4 + axis] * middle[1] + matrix[8 + axis] * middle[2] + matrix[12 + axis]);
}

// The parts whose centre lies within 1.5 times the widest spread of the middle 60 percent of the centres (20th to 80th
// percentile) from that spread, on every axis. A lawn or a hedge beside a room is farther out than that.
function partsNearTheRest(parts, worldMatrices) {
  const centres = parts.map(part => partCentre(part, worldMatrices.get(part.name)));
  const spreads = [0, 1, 2].map(axis => {
    const values = centres.map(centre => centre[axis]).sort((first, second) => first - second);
    return [values[Math.floor((values.length - 1) * 0.2)], values[Math.ceil((values.length - 1) * 0.8)]];
  });
  const margin = 1.5 * Math.max(...spreads.map(([low, high]) => high - low));
  return parts.filter((part, index) => spreads.every(([low, high], axis) => centres[index][axis] >= low - margin && centres[index][axis] <= high + margin));
}

/**
 * The share of rays from the middle of the bounds that hit a part's inner face (closedRoomShare), or, when that is not a room,
 * the same test on the parts near the rest, if that is larger. The heaviest parts are left out when the scene has more than
 * CLOSED_ROOM_MAXIMUM_TRIANGLES triangles. Null when nothing is left to test. `worldMatrices` maps a part's name to its world matrix.
 */
export function fittedClosedRoomShare(parts, worldMatrices) {
  const kept = lightestParts(parts.filter(part => !['blend', 'add'].includes(part.material?.alphaMode)));
  const share = closedRoomShare(kept, worldMatrices);
  if (share === null || share >= CLOSED_ROOM_SHARE) {
    return share;
  }
  return Math.max(share, closedRoomShare(partsNearTheRest(kept, worldMatrices), worldMatrices) ?? 0);
}
