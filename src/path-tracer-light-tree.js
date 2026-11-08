// The light tree of Conty and Kulla (2018, "Importance Sampling of Many Lights with Adaptive Tree Splitting") as Cycles
// uses it (src/kernel/light/tree.h): the point, spot and area lights sit in a binary tree whose nodes keep a bounding box,
// an orientation cone and the summed energy, and a shading point walks down it choosing the child by an importance estimate.
// The same data table and the same walk feed the CPU tracer and the GLSL kernel (path-tracer-gpu-shader.js reads the table
// as a float texture), so the CPU reference draws the lights with the same chances. The sun and the sky are not in the
// tree: like the distant lights of Cycles they keep a uniform share of the emitter choice.

export const LIGHT_TREE_NODE_FLOATS = 16;
export const LIGHT_TREE_NODE_TEXELS = 4;
// Past this many local lights the tree also draws one light at the first hit; below it the first hit lights from every
// light, as the other selections do.
export const LIGHT_TREE_FIRST_HIT_LIGHTS = 16;

const LEAF = -1;
const HALF_PI = Math.PI / 2;

function luminance(color) {
  return 0.2126 * color[0] + 0.7152 * color[1] + 0.0722 * color[2];
}

function sphereBounds(position, radius) {
  return { minimum: position.map(value => value - radius), maximum: position.map(value => value + radius) };
}

function rectangleBounds(light) {
  const minimum = [Infinity, Infinity, Infinity];
  const maximum = [-Infinity, -Infinity, -Infinity];
  for (const acrossSign of [-0.5, 0.5]) {
    for (const alongSign of [-0.5, 0.5]) {
      for (let axis = 0; axis < 3; axis++) {
        const corner = light.position[axis] + light.across[axis] * acrossSign * light.width + light.along[axis] * alongSign * light.height;
        minimum[axis] = Math.min(minimum[axis], corner);
        maximum[axis] = Math.max(maximum[axis], corner);
      }
    }
  }
  return { minimum, maximum };
}

/** One light as a tree leaf: its box, the cone its light leaves in (axis, spread `thetaO` around it, `thetaE` beyond) and its energy. */
export function describeLight(light, type) {
  const energy = luminance(light.color) * light.intensity;
  if (type === 'area') {
    return { ...rectangleBounds(light), axis: [...light.normal], thetaO: 0, thetaE: HALF_PI, energy };
  }
  const bounds = sphereBounds(light.position, light.radius ?? 0);
  if (type === 'spot') return { ...bounds, axis: [...light.direction], thetaO: 0, thetaE: Math.acos(Math.min(1, Math.max(-1, light.cosineHalfAngle))), energy };
  return { ...bounds, axis: [0, 1, 0], thetaO: Math.PI, thetaE: HALF_PI, energy };
}

function angleBetween(first, second) {
  const cosine = first[0] * second[0] + first[1] * second[1] + first[2] * second[2];
  return Math.acos(Math.min(1, Math.max(-1, cosine)));
}

function anyPerpendicular(axis) {
  const smallest = axis.map(Math.abs).indexOf(Math.min(...axis.map(Math.abs)));
  const basis = [0, 0, 0];
  basis[smallest] = 1;
  const crossed = [axis[1] * basis[2] - axis[2] * basis[1], axis[2] * basis[0] - axis[0] * basis[2], axis[0] * basis[1] - axis[1] * basis[0]];
  const length = Math.hypot(...crossed);
  return crossed.map(value => value / length);
}

/** The smallest cone holding two cones (Conty and Kulla, section 3.2): the wider one grown just enough toward the narrower. */
export function mergeCones(first, second) {
  const [wide, narrow] = second.thetaO > first.thetaO ? [second, first] : [first, second];
  const thetaE = Math.max(first.thetaE, second.thetaE);
  const between = angleBetween(wide.axis, narrow.axis);
  if (Math.min(between + narrow.thetaO, Math.PI) <= wide.thetaO) return { axis: [...wide.axis], thetaO: wide.thetaO, thetaE };
  const thetaO = (wide.thetaO + between + narrow.thetaO) / 2;
  if (thetaO >= Math.PI) return { axis: [...wide.axis], thetaO: Math.PI, thetaE };
  const turn = thetaO - wide.thetaO;
  if (Math.sin(between) < 1e-6) return { axis: anyPerpendicular(wide.axis), thetaO, thetaE };
  const wideWeight = Math.sin(between - turn) / Math.sin(between);
  const narrowWeight = Math.sin(turn) / Math.sin(between);
  const axis = wide.axis.map((value, index) => value * wideWeight + narrow.axis[index] * narrowWeight);
  const length = Math.hypot(...axis) || 1;
  return { axis: axis.map(value => value / length), thetaO, thetaE };
}

function mergeEntries(first, second) {
  const cone = mergeCones(first, second);
  return {
    minimum: first.minimum.map((value, axis) => Math.min(value, second.minimum[axis])),
    maximum: first.maximum.map((value, axis) => Math.max(value, second.maximum[axis])),
    energy: first.energy + second.energy,
    ...cone,
  };
}

function centroidOf(entry, axis) {
  return entry.minimum[axis] + entry.maximum[axis];
}

/**
 * The tree over `lights` ({ points, spots, areas }), leaves numbered in the order the tracers sample the lights (points,
 * spots, areas). Nodes split the longest centroid axis at the median, so the tree is balanced: depth about log2(count).
 * Returns { nodeCount, data } where each node is LIGHT_TREE_NODE_FLOATS floats:
 *   (box minimum, energy) (box maximum, cos thetaO) (cone axis, cos thetaE) (left child or -1, right child, light index, 0).
 */
export function buildLightTree(lights) {
  const entries = [
    ...lights.points.map(light => describeLight(light, 'point')),
    ...lights.spots.map(light => describeLight(light, 'spot')),
    ...lights.areas.map(light => describeLight(light, 'area')),
  ].map((entry, lightIndex) => ({ ...entry, lightIndex }));
  const nodes = [];

  function build(group) {
    const nodeIndex = nodes.length;
    const node = { left: LEAF, right: LEAF, lightIndex: LEAF };
    nodes.push(node);
    if (group.length === 1) {
      Object.assign(node, group[0]);
      return nodeIndex;
    }
    let splitAxis = 0;
    let longest = -1;
    for (let axis = 0; axis < 3; axis++) {
      const values = group.map(entry => centroidOf(entry, axis));
      const extent = Math.max(...values) - Math.min(...values);
      if (extent > longest) {
        longest = extent;
        splitAxis = axis;
      }
    }
    const sorted = [...group].sort((first, second) => centroidOf(first, splitAxis) - centroidOf(second, splitAxis));
    const middle = sorted.length >> 1;
    node.left = build(sorted.slice(0, middle));
    node.right = build(sorted.slice(middle));
    Object.assign(node, mergeEntries(nodes[node.left], nodes[node.right]));
    return nodeIndex;
  }

  if (entries.length === 0) return { nodeCount: 0, data: new Float32Array(LIGHT_TREE_NODE_FLOATS) };
  build(entries);
  const data = new Float32Array(nodes.length * LIGHT_TREE_NODE_FLOATS);
  nodes.forEach((node, index) => {
    const base = index * LIGHT_TREE_NODE_FLOATS;
    data.set([...node.minimum, node.energy], base);
    data.set([...node.maximum, Math.cos(node.thetaO)], base + 4);
    data.set([...node.axis, Math.cos(node.thetaE)], base + 8);
    data.set([node.left, node.right, node.lightIndex, 0], base + 12);
  });
  return { nodeCount: nodes.length, data };
}

const importance = { maximum: 0, minimum: 0 };

/**
 * What a node is worth to the shading point at (px, py, pz) with surface normal (nx, ny, nz), as two measures: the
 * maximum one (energy times the cosines of the best angles the box and cone allow, over the squared distance to the
 * nearest point the box may hold) and the minimum one (energy over the squared distance to the farthest, no angles). The
 * walk mixes them half and half, so a node the angle test culls still keeps a chance and the choice stays unbiased.
 */
export function nodeImportance(data, node, px, py, pz, nx, ny, nz) {
  const base = node * LIGHT_TREE_NODE_FLOATS;
  const energy = data[base + 3];
  const centerX = (data[base] + data[base + 4]) * 0.5;
  const centerY = (data[base + 1] + data[base + 5]) * 0.5;
  const centerZ = (data[base + 2] + data[base + 6]) * 0.5;
  const halfDiagonal = 0.5 * Math.hypot(data[base + 4] - data[base], data[base + 5] - data[base + 1], data[base + 6] - data[base + 2]);
  const deltaX = centerX - px;
  const deltaY = centerY - py;
  const deltaZ = centerZ - pz;
  const distance = Math.hypot(deltaX, deltaY, deltaZ);
  const nearest = Math.max(distance, halfDiagonal, 1e-4);
  const farthest = distance + halfDiagonal;
  importance.minimum = energy / Math.max(farthest * farthest, 1e-8);
  if (distance <= halfDiagonal) {
    importance.maximum = energy / (nearest * nearest);
    return importance;
  }
  const towardX = deltaX / distance;
  const towardY = deltaY / distance;
  const towardZ = deltaZ / distance;
  const thetaU = Math.acos(Math.sqrt(Math.max(0, 1 - (halfDiagonal / distance) ** 2)));
  const axisCosine = -(data[base + 8] * towardX + data[base + 9] * towardY + data[base + 10] * towardZ);
  const theta = Math.acos(Math.min(1, Math.max(-1, axisCosine)));
  const thetaO = Math.acos(Math.min(1, Math.max(-1, data[base + 7])));
  const thetaE = Math.acos(Math.min(1, Math.max(-1, data[base + 11])));
  const thetaPrime = Math.max(theta - thetaO - thetaU, 0);
  if (thetaPrime >= thetaE) {
    importance.maximum = 0;
    return importance;
  }
  const surfaceTheta = Math.acos(Math.min(1, Math.max(-1, nx * towardX + ny * towardY + nz * towardZ)));
  const surfaceCosine = Math.max(Math.cos(Math.max(surfaceTheta - thetaU, 0)), 0);
  importance.maximum = energy * Math.cos(thetaPrime) * surfaceCosine / (nearest * nearest);
  return importance;
}

/** The chance of taking the left child, mixing the maximum and the minimum measure evenly; -1 when both children are worth nothing. */
export function leftChildProbability(leftMaximum, leftMinimum, rightMaximum, rightMinimum) {
  const totalMaximum = leftMaximum + rightMaximum;
  const totalMinimum = leftMinimum + rightMinimum;
  if (!(totalMinimum > 0)) return -1;
  if (!(totalMaximum > 0)) return leftMinimum / totalMinimum;
  return 0.5 * (leftMaximum / totalMaximum + leftMinimum / totalMinimum);
}

const choice = { lightIndex: -1, probability: 0 };

/**
 * Walks the tree from the root, each step drawing one child with `nextRandom()`. Returns the shared `choice`: the light
 * index (in sampling order) and the chance of that whole path, or lightIndex -1 when no light is worth sampling.
 */
export function chooseLightFromTree(tree, px, py, pz, nx, ny, nz, nextRandom) {
  choice.lightIndex = -1;
  choice.probability = 0;
  if (tree.nodeCount === 0) return choice;
  const { data } = tree;
  let node = 0;
  let probability = 1;
  while (data[node * LIGHT_TREE_NODE_FLOATS + 12] >= 0) {
    const base = node * LIGHT_TREE_NODE_FLOATS;
    const left = data[base + 12];
    const right = data[base + 13];
    nodeImportance(data, left, px, py, pz, nx, ny, nz);
    const leftMaximum = importance.maximum;
    const leftMinimum = importance.minimum;
    nodeImportance(data, right, px, py, pz, nx, ny, nz);
    const leftProbability = leftChildProbability(leftMaximum, leftMinimum, importance.maximum, importance.minimum);
    if (leftProbability < 0) return choice;
    if (nextRandom() < leftProbability) {
      node = left;
      probability *= leftProbability;
    } else {
      node = right;
      probability *= 1 - leftProbability;
    }
  }
  choice.lightIndex = data[node * LIGHT_TREE_NODE_FLOATS + 14];
  choice.probability = probability;
  return choice;
}
