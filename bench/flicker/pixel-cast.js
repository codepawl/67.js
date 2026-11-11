// The float64 ray cast behind ground-truth.js (issue #751): which triangle is visible at each pixel centre. It scan-converts every
// triangle into a small per-pixel list of the nearest hits, in double precision with perspective-correct depth, so no depth
// buffer rounding can pick the wrong face. Cost follows the area the triangles cover, not triangles times pixels.

export const NO_TRIANGLE = -1;
export const RIVALS_PER_PIXEL = 2;
const TIE_RELATIVE_DISTANCE = 1e-9;
const HITS_PER_PIXEL = 6;
const NEAR_DEPTH = 1e-4;
// A pixel centre exactly on an edge shared by two triangles must not fall between them through rounding.
const EDGE_SLACK = 1e-9;

export function subtract(first, second) {
  return [first[0] - second[0], first[1] - second[1], first[2] - second[2]];
}

export function dot(first, second) {
  return first[0] * second[0] + first[1] * second[1] + first[2] * second[2];
}

export function crossProduct(first, second) {
  return [first[1] * second[2] - first[2] * second[1], first[2] * second[0] - first[0] * second[2], first[0] * second[1] - first[1] * second[0]];
}

export function normalized(vector) {
  const length = Math.hypot(...vector) || 1;
  return vector.map(value => value / length);
}

function cameraBasis({ eye, target, up = [0, 1, 0], fov = 45 }, width, height) {
  const forward = normalized(subtract(target, eye));
  const right = normalized(crossProduct(forward, up));
  const upward = crossProduct(right, forward);
  return { eye, forward, right, upward, tangent: Math.tan(fov * Math.PI / 360), aspect: width / height };
}

// A world point as [sideways, up, depth] from the camera.
function toCameraSpace(basis, x, y, z) {
  const relative = [x - basis.eye[0], y - basis.eye[1], z - basis.eye[2]];
  return [dot(relative, basis.right), dot(relative, basis.upward), dot(relative, basis.forward)];
}

// The part of a camera-space triangle in front of the near depth, as a polygon of up to four points.
function clipToNear(points) {
  const kept = [];
  for (let index = 0; index < points.length; index++) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    const currentInside = current[2] >= NEAR_DEPTH;
    if (currentInside) kept.push(current);
    if (currentInside !== (next[2] >= NEAR_DEPTH)) {
      const share = (NEAR_DEPTH - current[2]) / (next[2] - current[2]);
      kept.push([0, 1, 2].map(axis => current[axis] + (next[axis] - current[axis]) * share));
    }
  }
  return kept;
}

// Whether the first hit is nearer than the second; hits at one distance (to 1e-9) go to the higher rank, then the later triangle.
function isNearer(world, firstDistance, firstTriangle, secondDistance, secondTriangle) {
  const gap = firstDistance - secondDistance;
  if (Math.abs(gap) > TIE_RELATIVE_DISTANCE * firstDistance) return gap < 0;
  return world.ranks[firstTriangle] !== world.ranks[secondTriangle] ? world.ranks[firstTriangle] > world.ranks[secondTriangle] : firstTriangle > secondTriangle;
}

function recordHit(world, hitDistances, hitTriangles, pixel, distance, triangle) {
  const base = pixel * HITS_PER_PIXEL;
  let slot = 0;
  while (slot < HITS_PER_PIXEL - 1 && hitTriangles[base + slot] !== NO_TRIANGLE) slot++;
  const full = hitTriangles[base + slot] !== NO_TRIANGLE;
  if (full && !isNearer(world, distance, triangle, hitDistances[base + slot], hitTriangles[base + slot])) return;
  while (slot > 0 && isNearer(world, distance, triangle, hitDistances[base + slot - 1], hitTriangles[base + slot - 1])) {
    hitDistances[base + slot] = hitDistances[base + slot - 1];
    hitTriangles[base + slot] = hitTriangles[base + slot - 1];
    slot--;
  }
  hitDistances[base + slot] = distance;
  hitTriangles[base + slot] = triangle;
}

// Scan-converts one camera-space triangle: pixel centres inside it, with depth interpolated as 1/depth in screen space.
function rasterize(world, basis, triangle, points, width, height, hitDistances, hitTriangles) {
  const screen = points.map(([sideways, upward, depth]) => [
    (sideways / depth / (basis.aspect * basis.tangent) * 0.5 + 0.5) * width,
    (0.5 - upward / depth / basis.tangent * 0.5) * height,
    1 / depth,
  ]);
  const [first, second, third] = screen;
  const area = (second[0] - first[0]) * (third[1] - first[1]) - (second[1] - first[1]) * (third[0] - first[0]);
  if (area === 0) return;
  const minimumX = Math.max(0, Math.floor(Math.min(first[0], second[0], third[0]) - 0.5));
  const maximumX = Math.min(width - 1, Math.ceil(Math.max(first[0], second[0], third[0]) - 0.5));
  const minimumY = Math.max(0, Math.floor(Math.min(first[1], second[1], third[1]) - 0.5));
  const maximumY = Math.min(height - 1, Math.ceil(Math.max(first[1], second[1], third[1]) - 0.5));
  for (let y = minimumY; y <= maximumY; y++) {
    for (let x = minimumX; x <= maximumX; x++) {
      const centreX = x + 0.5;
      const centreY = y + 0.5;
      const weightFirst = ((second[0] - centreX) * (third[1] - centreY) - (second[1] - centreY) * (third[0] - centreX)) / area;
      const weightSecond = ((third[0] - centreX) * (first[1] - centreY) - (third[1] - centreY) * (first[0] - centreX)) / area;
      const weightThird = 1 - weightFirst - weightSecond;
      if (weightFirst < -EDGE_SLACK || weightSecond < -EDGE_SLACK || weightThird < -EDGE_SLACK) continue;
      const inverseDepth = weightFirst * first[2] + weightSecond * second[2] + weightThird * third[2];
      recordHit(world, hitDistances, hitTriangles, y * width + x, 1 / inverseDepth, triangle);
    }
  }
}

// Whether the triangle faces the eye (counter-clockwise seen from it); double-sided triangles always count.
function facesEye(world, basis, triangle) {
  if (world.doubleSided[triangle] === 1) return true;
  const base = triangle * 9;
  const corners = world.corners;
  const edgeOne = [corners[base + 3] - corners[base], corners[base + 4] - corners[base + 1], corners[base + 5] - corners[base + 2]];
  const edgeTwo = [corners[base + 6] - corners[base], corners[base + 7] - corners[base + 1], corners[base + 8] - corners[base + 2]];
  return dot(crossProduct(edgeOne, edgeTwo), subtract(basis.eye, [corners[base], corners[base + 1], corners[base + 2]])) > 0;
}

// Two faces of different colour at one distance with one rank: nothing in the scene says which is in front, so no render is wrong.
function isTie(world, distances, triangles, base) {
  const nearestTriangle = triangles[base];
  for (let slot = 1; slot < HITS_PER_PIXEL && triangles[base + slot] !== NO_TRIANGLE; slot++) {
    if (Math.abs(distances[base + slot] - distances[base]) > TIE_RELATIVE_DISTANCE * distances[base]) return false;
    const other = triangles[base + slot];
    if (world.keyOf[nearestTriangle] !== world.keyOf[other] && world.ranks[nearestTriangle] === world.ranks[other]) return true;
  }
  return false;
}

/**
 * Casts one ray through every pixel centre of a `width` x `height` image. `world` is the result of `collectWorldTriangles`,
 * `camera` the `{ eye, target, up, fov }` of the frame. Returns `{ owner, rivals, tied, distance }`: `distance` is the depth of the visible face in front of the camera (0 for the background); `owner` is the visible triangle of
 * each pixel (`NO_TRIANGLE` for the background), `rivals` holds up to two colour keys of other triangles on the same ray, or
 * -1, and `tied` marks pixels where two faces of different colour lie at one distance with one rank. Only the six nearest
 * faces of a ray are kept, which is enough to name its visible face and the faces right behind it.
 */
export function castPixelOwners(world, camera, width, height) {
  const basis = cameraBasis(camera, width, height);
  const hitDistances = new Float64Array(width * height * HITS_PER_PIXEL);
  const hitTriangles = new Int32Array(width * height * HITS_PER_PIXEL).fill(NO_TRIANGLE);
  for (let triangle = 0; triangle < world.count; triangle++) {
    if (!facesEye(world, basis, triangle)) continue;
    const base = triangle * 9;
    const points = [0, 1, 2].map(corner => toCameraSpace(basis, world.corners[base + corner * 3], world.corners[base + corner * 3 + 1], world.corners[base + corner * 3 + 2]));
    const polygon = points.every(point => point[2] >= NEAR_DEPTH) ? points : clipToNear(points);
    for (let corner = 1; corner + 1 < polygon.length; corner++) {
      rasterize(world, basis, triangle, [polygon[0], polygon[corner], polygon[corner + 1]], width, height, hitDistances, hitTriangles);
    }
  }
  const owner = new Int32Array(width * height).fill(NO_TRIANGLE);
  const rivals = new Int32Array(width * height * RIVALS_PER_PIXEL).fill(-1);
  const tied = new Uint8Array(width * height);
  const distance = new Float64Array(width * height);
  for (let pixel = 0; pixel < width * height; pixel++) {
    const base = pixel * HITS_PER_PIXEL;
    if (hitTriangles[base] === NO_TRIANGLE) continue;
    owner[pixel] = hitTriangles[base];
    distance[pixel] = hitDistances[base];
    tied[pixel] = isTie(world, hitDistances, hitTriangles, base) ? 1 : 0;
    const ownKey = world.keyOf[hitTriangles[base]];
    let stored = 0;
    for (let slot = 1; slot < HITS_PER_PIXEL && hitTriangles[base + slot] !== NO_TRIANGLE && stored < RIVALS_PER_PIXEL; slot++) {
      const key = world.keyOf[hitTriangles[base + slot]];
      const known = key === ownKey || (stored > 0 && rivals[pixel * RIVALS_PER_PIXEL] === key);
      if (!known) rivals[pixel * RIVALS_PER_PIXEL + stored++] = key;
    }
  }
  return { owner, rivals, tied, distance, hitTriangles, hitDistances, hitsPerPixel: HITS_PER_PIXEL };
}
