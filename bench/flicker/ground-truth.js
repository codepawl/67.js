// Ground truth for the flicker probe (issue #751). The jitter probe compares a render with a copy of itself, so it counts crease
// anti-aliasing as flicker and misses speckle that sits next to a colour step. This module answers the question directly: for
// every pixel it intersects the camera ray with every triangle in float64, which cannot z-fight, names the triangle that is
// visible, and the probe then asks whether the raster render shows that triangle's colour there.
//
// A triangle's colour is looked up by a key (albedo, vertex colour and facing), not by its own pixels: a plaque flush on a wall
// has no pixel of its own that the wall could not also claim, so the colour it should have is the median of the pixels where
// the ray cast says it is visible. Pixels next to another key (silhouettes, creases, anti-aliased edges) are left out, so only
// the interior of a face is judged.

import { depthLayerOf, RANKS_PER_LAYER } from '../../src/depth-layer.js';
import { castPixelOwners, crossProduct, normalized, subtract, NO_TRIANGLE, RIVALS_PER_PIXEL } from './pixel-cast.js';

export { castPixelOwners, NO_TRIANGLE };

const NORMAL_KEY_SCALE = 100;
const COLOUR_KEY_SCALE = 255;
export const DEFAULT_COLOUR_THRESHOLD = 40;
const MINIMUM_REFERENCE_PIXELS = 3;

function transformPoint(matrix, x, y, z, target, offset) {
  target[offset] = matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12];
  target[offset + 1] = matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13];
  target[offset + 2] = matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14];
}

// The triangles of a part as it is drawn: the cut geometry and the rank of each triangle when the flush pass made an order.
function drawnTriangles(part, flushOrder) {
  if (!flushOrder) return { geometry: part.geometry, indices: part.geometry.indices, ranks: null };
  const geometry = flushOrder.geometry ?? part.geometry;
  const ranks = new Uint8Array(flushOrder.indices.length / 3);
  for (const range of flushOrder.ranges) ranks.fill(range.rank, range.start / 3, (range.start + range.count) / 3);
  return { geometry, indices: flushOrder.indices, ranks };
}

function colourKey(part, geometry, firstVertex, vertexCount, facing) {
  const material = part.material?.color ?? [1, 1, 1];
  const stride = geometry.colors ? geometry.colors.length / vertexCount : 0;
  const vertexColour = stride >= 3 ? [0, 1, 2].map(channel => geometry.colors[firstVertex * stride + channel]) : [1, 1, 1];
  const colour = [0, 1, 2].map(channel => Math.round(material[channel] * vertexColour[channel] * COLOUR_KEY_SCALE));
  const normal = facing.map(value => Math.round(value * NORMAL_KEY_SCALE));
  return `${colour.join(',')}|${normal.join(',')}`;
}

/**
 * Every opaque triangle of the parts in world space, in float64.
 * Returns `{ corners, keys, keyOf, ranks, doubleSided, count }`: `corners` holds nine numbers per triangle, `keyOf` the colour key
 * id of each triangle, `ranks` its flush rank (0 without an order). `flushOrderOf` is the lookup of depth-layer.js.
 * Parts that blend or cut out alpha are skipped: their visible colour is a mix the key cannot name.
 */
export function collectWorldTriangles(parts, flushOrderOf) {
  const cornerChunks = [];
  const keyIds = new Map();
  const keyOf = [];
  const rankList = [];
  const doubleSidedList = [];
  for (const part of parts) {
    if ((part.material?.alphaMode ?? 'opaque') !== 'opaque') continue;
    const { geometry, indices, ranks } = drawnTriangles(part, flushOrderOf(part));
    const vertexCount = geometry.positions.length / 3;
    const triangleCount = indices.length / 3;
    const corners = new Float64Array(triangleCount * 9);
    for (let triangle = 0; triangle < triangleCount; triangle++) {
      for (let corner = 0; corner < 3; corner++) {
        const vertex = indices[triangle * 3 + corner] * 3;
        transformPoint(part.matrix, geometry.positions[vertex], geometry.positions[vertex + 1], geometry.positions[vertex + 2], corners, triangle * 9 + corner * 3);
      }
      const base = triangle * 9;
      const first = [corners[base], corners[base + 1], corners[base + 2]];
      const edgeOne = subtract([corners[base + 3], corners[base + 4], corners[base + 5]], first);
      const edgeTwo = subtract([corners[base + 6], corners[base + 7], corners[base + 8]], first);
      const key = colourKey(part, geometry, indices[triangle * 3], vertexCount, normalized(crossProduct(edgeOne, edgeTwo)));
      if (!keyIds.has(key)) keyIds.set(key, keyIds.size);
      keyOf.push(keyIds.get(key));
      rankList.push(depthLayerOf(part) * RANKS_PER_LAYER + (ranks ? ranks[triangle] : 0));
      doubleSidedList.push(part.material?.doubleSided === true ? 1 : 0);
    }
    cornerChunks.push(corners);
  }
  const total = cornerChunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const corners = new Float64Array(total);
  let offset = 0;
  for (const chunk of cornerChunks) {
    corners.set(chunk, offset);
    offset += chunk.length;
  }
  return { corners, keyOf: Int32Array.from(keyOf), ranks: Uint8Array.from(rankList), doubleSided: Uint8Array.from(doubleSidedList), keyCount: keyIds.size, count: keyOf.length };
}

function channelDistance(pixels, index, reference) {
  return Math.max(Math.abs(pixels[index] - reference[0]), Math.abs(pixels[index + 1] - reference[1]), Math.abs(pixels[index + 2] - reference[2]));
}

function median(values) {
  const sorted = Float64Array.from(values).sort();
  return sorted[Math.floor(sorted.length / 2)];
}

// A pixel is judged only when it and its eight neighbours see one colour key: edges, creases and silhouettes are left out.
function hasUniformSurroundings(keyAt, width, height, x, y) {
  if (x < 1 || y < 1 || x >= width - 1 || y >= height - 1) return false;
  const own = keyAt[y * width + x];
  if (own < 0) return false;
  for (let row = -1; row <= 1; row++) {
    for (let column = -1; column <= 1; column++) {
      if (keyAt[(y + row) * width + x + column] !== own) return false;
    }
  }
  return true;
}

/**
 * Compares a rendered frame (RGBA bytes, rows from the top) with the ray cast of `castPixelOwners`.
 * Returns `{ contested, wrong, swapped, tied, unjudged, edge }`:
 * - `contested`: interior pixels where another colour lies behind the visible one, the only place depth can fight;
 * - `wrong`: contested pixels whose colour is further than `threshold` (0 to 255, largest channel) from the visible face's colour;
 * - `swapped`: wrong pixels that sit within `threshold` of the colour of a face behind, a fight and not shading;
 * - `tied`: contested pixels where the scene itself does not say which face is in front (the flush pass off, or a seam); left out of the other counts;
 * - `unjudged`: contested pixels whose face has too few clean pixels to know its colour;
 * - `edge`: pixels left out for having another colour next to them.
 * `mismatchMask` marks the wrong pixels for a picture: 1 for a wrong pixel, 2 for a swapped one.
 */
export function compareWithGroundTruth({ pixels, world, cast, width, height, threshold = DEFAULT_COLOUR_THRESHOLD }) {
  const keyAt = new Int32Array(width * height);
  for (let pixel = 0; pixel < keyAt.length; pixel++) keyAt[pixel] = cast.owner[pixel] === NO_TRIANGLE ? -1 : world.keyOf[cast.owner[pixel]];
  const references = new Array(world.keyCount);
  const samples = Array.from({ length: world.keyCount }, () => ({ clean: [[], [], []], any: [[], [], []], cleanCount: 0 }));
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      if (!hasUniformSurroundings(keyAt, width, height, x, y)) continue;
      const pixel = y * width + x;
      const bucket = samples[keyAt[pixel]];
      const contested = cast.rivals[pixel * RIVALS_PER_PIXEL] >= 0;
      for (let channel = 0; channel < 3; channel++) {
        bucket.any[channel].push(pixels[pixel * 4 + channel]);
        if (!contested) bucket.clean[channel].push(pixels[pixel * 4 + channel]);
      }
      if (!contested) bucket.cleanCount++;
    }
  }
  samples.forEach((bucket, key) => {
    const source = bucket.cleanCount >= MINIMUM_REFERENCE_PIXELS ? bucket.clean : bucket.any;
    if (source[0].length >= MINIMUM_REFERENCE_PIXELS) references[key] = source.map(median);
  });
  const result = { contested: 0, wrong: 0, swapped: 0, tied: 0, unjudged: 0, edge: 0 };
  const mismatchMask = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const pixel = y * width + x;
      if (keyAt[pixel] < 0 || cast.rivals[pixel * RIVALS_PER_PIXEL] < 0) continue;
      if (!hasUniformSurroundings(keyAt, width, height, x, y)) {
        result.edge++;
        continue;
      }
      result.contested++;
      if (cast.tied[pixel]) {
        result.tied++;
        continue;
      }
      const reference = references[keyAt[pixel]];
      if (!reference) {
        result.unjudged++;
        continue;
      }
      if (channelDistance(pixels, pixel * 4, reference) <= threshold) continue;
      result.wrong++;
      mismatchMask[pixel] = 1;
      for (let slot = 0; slot < RIVALS_PER_PIXEL; slot++) {
        const rival = references[cast.rivals[pixel * RIVALS_PER_PIXEL + slot]];
        if (rival && channelDistance(pixels, pixel * 4, rival) <= threshold) {
          result.swapped++;
          mismatchMask[pixel] = 2;
          break;
        }
      }
    }
  }
  return { ...result, mismatchMask };
}
