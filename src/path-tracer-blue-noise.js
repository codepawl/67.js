// Blue noise for the first sample of every pixel (the idea of SAMPLING_PATTERN_BLUE_NOISE_FIRST in Cycles). A tile of
// BLUE_NOISE_SIZE by BLUE_NOISE_SIZE values is made with the void and cluster method (Ulichney 1993): the values of
// neighbouring pixels are far apart, so the error of a one sample image has no low frequency blotches. Four channels
// are four independent tiles. The tile depends only on the seed, so the same seed gives the same bytes.

export const BLUE_NOISE_SIZE = 64;
export const BLUE_NOISE_CHANNELS = 4;

const TILE_PIXELS = BLUE_NOISE_SIZE * BLUE_NOISE_SIZE;
const GAUSSIAN_SIGMA = 1.5;
const KERNEL_RADIUS = 9;
const INITIAL_FRACTION = 0.1;

function createRandomStream(seed) {
  let state = (seed >>> 0) || 1;
  return () => {
    state = (Math.imul(state, 747796405) + 2891336453) >>> 0;
    let word = Math.imul(((state >>> ((state >>> 28) + 4)) ^ state) >>> 0, 277803737) >>> 0;
    word = ((word >>> 22) ^ word) >>> 0;
    return (word >>> 8) / 16777216;
  };
}

function createKernel() {
  const side = KERNEL_RADIUS * 2 + 1;
  const kernel = new Float64Array(side * side);
  for (let dy = -KERNEL_RADIUS; dy <= KERNEL_RADIUS; dy++) {
    for (let dx = -KERNEL_RADIUS; dx <= KERNEL_RADIUS; dx++) {
      kernel[(dy + KERNEL_RADIUS) * side + dx + KERNEL_RADIUS] = Math.exp(-(dx * dx + dy * dy) / (2 * GAUSSIAN_SIGMA * GAUSSIAN_SIGMA));
    }
  }
  return kernel;
}

const KERNEL = createKernel();

// Adds (sign 1) or removes (sign -1) the energy of one set pixel, wrapping around the tile edges.
function addEnergy(energy, pixel, sign) {
  const centerX = pixel % BLUE_NOISE_SIZE;
  const centerY = (pixel - centerX) / BLUE_NOISE_SIZE;
  const side = KERNEL_RADIUS * 2 + 1;
  for (let dy = -KERNEL_RADIUS; dy <= KERNEL_RADIUS; dy++) {
    const row = ((centerY + dy + BLUE_NOISE_SIZE) % BLUE_NOISE_SIZE) * BLUE_NOISE_SIZE;
    for (let dx = -KERNEL_RADIUS; dx <= KERNEL_RADIUS; dx++) {
      energy[row + ((centerX + dx + BLUE_NOISE_SIZE) % BLUE_NOISE_SIZE)] += sign * KERNEL[(dy + KERNEL_RADIUS) * side + dx + KERNEL_RADIUS];
    }
  }
}

// The pixel with the most (or least) energy among the pixels whose set state equals `wantSet`.
function extremePixel(energy, isSet, wantSet, wantMaximum) {
  let best = -1;
  let bestEnergy = wantMaximum ? -Infinity : Infinity;
  for (let pixel = 0; pixel < TILE_PIXELS; pixel++) {
    if ((isSet[pixel] === 1) !== wantSet) continue;
    const value = energy[pixel];
    if (wantMaximum ? value > bestEnergy : value < bestEnergy) {
      bestEnergy = value;
      best = pixel;
    }
  }
  return best;
}

function createSingleChannel(seed) {
  const nextRandom = createRandomStream(seed);
  const isSet = new Uint8Array(TILE_PIXELS);
  const energy = new Float64Array(TILE_PIXELS);
  const order = Array.from({ length: TILE_PIXELS }, (_, index) => index);
  for (let index = TILE_PIXELS - 1; index > 0; index--) {
    const swapWith = Math.floor(nextRandom() * (index + 1));
    [order[index], order[swapWith]] = [order[swapWith], order[index]];
  }
  const initialCount = Math.round(TILE_PIXELS * INITIAL_FRACTION);
  for (let index = 0; index < initialCount; index++) {
    isSet[order[index]] = 1;
    addEnergy(energy, order[index], 1);
  }
  // Relax the first pattern: move the tightest cluster pixel into the largest void until they are the same pixel.
  for (let step = 0; step < TILE_PIXELS; step++) {
    const tightest = extremePixel(energy, isSet, true, true);
    isSet[tightest] = 0;
    addEnergy(energy, tightest, -1);
    const largestVoid = extremePixel(energy, isSet, false, false);
    isSet[largestVoid] = 1;
    addEnergy(energy, largestVoid, 1);
    if (largestVoid === tightest) break;
  }
  const rank = new Uint16Array(TILE_PIXELS);
  const prototype = isSet.slice();
  const prototypeEnergy = energy.slice();
  // Phase one: take the pixels of the pattern away one by one, tightest cluster first; the last one removed is rank 0.
  for (let remaining = initialCount - 1; remaining >= 0; remaining--) {
    const tightest = extremePixel(energy, isSet, true, true);
    isSet[tightest] = 0;
    addEnergy(energy, tightest, -1);
    rank[tightest] = remaining;
  }
  isSet.set(prototype);
  energy.set(prototypeEnergy);
  // Phase two and three: add each next pixel into the largest void of the set ones.
  
  for (let placed = initialCount; placed < TILE_PIXELS; placed++) {
    const pixel = extremePixel(energy, isSet, false, false);
    isSet[pixel] = 1;
    addEnergy(energy, pixel, 1);
    rank[pixel] = placed;
  }
  return rank;
}

/** RGBA8 bytes of a BLUE_NOISE_SIZE square tile, four blue noise channels; the same seed gives the same bytes. */
export function createBlueNoiseTile(seed = 0) {
  const bytes = new Uint8Array(TILE_PIXELS * BLUE_NOISE_CHANNELS);
  for (let channel = 0; channel < BLUE_NOISE_CHANNELS; channel++) {
    const rank = createSingleChannel(Math.imul((seed >>> 0) + 1, 0x9e3779b1) + channel * 0x632be5ab);
    for (let pixel = 0; pixel < TILE_PIXELS; pixel++) bytes[pixel * BLUE_NOISE_CHANNELS + channel] = rank[pixel] >> 4;
  }
  return bytes;
}
