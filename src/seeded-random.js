// Integer hashing keeps seeded results identical on every platform.

export function hashCell(cellX, cellY, cellZ, seed) {
  let hash = Math.imul(cellX, 0x27d4eb2d) ^ Math.imul(cellY, 0x165667b1) ^ Math.imul(cellZ, 0x85ebca77) ^ Math.imul(seed, 0x9e3779b1);
  hash = Math.imul(hash ^ (hash >>> 15), 0x85ebca6b);
  hash = Math.imul(hash ^ (hash >>> 13), 0xc2b2ae35);
  return ((hash ^ (hash >>> 16)) >>> 0) / 4294967296;
}

/** Per-element random number in 0 to 1 from a whole-number key and a seed. */
export function seededRandom(key, channel, seed) {
  return hashCell(key, channel, 0, seed);
}
