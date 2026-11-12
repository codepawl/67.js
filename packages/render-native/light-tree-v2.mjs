// Light tree for the Cycles-parity kernel (Conty and Kulla 2018, as in Cycles `kernel/light/tree.h`).
// Builds `LightTreeNode` records (FORMAT-v2.md section 7) over the packed analytic lights and the packed emissive triangles.
//
// Node layout in the buffer:
//   node 0                          directory: left_child = analytic root, right_or_first_emitter = emissive root
//                                   (0xFFFFFFFF when a tree is absent), light_group_mask_or = first emissive leaf node
//   1 .. 1 + lightCount             analytic leaves, in light order (leaf of light i is node 1 + i)
//   then the analytic inner nodes
//   emissive leaves, in triangle order (leaf of triangle i is node emissiveLeafBase + i), then the emissive inner nodes
// A leaf stores `-1 - parent` in left_child; an inner node stores its parent in the low 16 bits of emitter_count_and_kind.
// The kernel walks up from a leaf to the root to learn the chance of having picked that emitter from a given point.

export const LIGHT_TREE_AUTO_EMITTER_COUNT = 8;
export const NO_TREE_ROOT = 0xffffffff;
const LIGHT_TREE_NODE_BYTES = 64;
// Inner nodes keep their parent in 16 bits and the two trees share one buffer, so each tree stays under 2^14 emitters.
const MAX_EMITTERS_PER_TREE = 16383;
const LIGHT_TYPE_POINT = 0;
const LIGHT_TYPE_SPOT = 1;
const LIGHT_TYPE_SUN = 4;
const HALF_PI = Math.PI / 2;
const NODE_WORDS = 16;
const INSTANCE_WORDS = 40;
const INSTANCE_MASK_WORD = 30;
const KIND_EMISSIVE_BIT = 1 << 16;

function luminance(red, green, blue) {
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function angleBetween(first, second) {
  const cosine = first[0] * second[0] + first[1] * second[1] + first[2] * second[2];
  return Math.acos(Math.min(1, Math.max(-1, cosine)));
}

function anyPerpendicular(axis) {
  const smallest = axis.map(Math.abs).indexOf(Math.min(...axis.map(Math.abs)));
  const basis = [0, 0, 0];
  basis[smallest] = 1;
  const crossed = [
    axis[1] * basis[2] - axis[2] * basis[1],
    axis[2] * basis[0] - axis[0] * basis[2],
    axis[0] * basis[1] - axis[1] * basis[0],
  ];
  const length = Math.hypot(...crossed);
  return crossed.map(value => value / length);
}

// The smallest cone holding two cones (Conty and Kulla, section 3.2).
export function mergeCones(first, second) {
  const [wide, narrow] = second.thetaO > first.thetaO ? [second, first] : [first, second];
  const thetaE = Math.max(first.thetaE, second.thetaE);
  const between = angleBetween(wide.axis, narrow.axis);
  if (Math.min(between + narrow.thetaO, Math.PI) <= wide.thetaO) {
    return { axis: [...wide.axis], thetaO: wide.thetaO, thetaE };
  }
  const thetaO = (wide.thetaO + between + narrow.thetaO) / 2;
  if (thetaO >= Math.PI) {
    return { axis: [...wide.axis], thetaO: Math.PI, thetaE };
  }
  const turn = thetaO - wide.thetaO;
  if (Math.sin(between) < 1e-6) {
    return { axis: anyPerpendicular(wide.axis), thetaO, thetaE };
  }
  const wideWeight = Math.sin(between - turn) / Math.sin(between);
  const narrowWeight = Math.sin(turn) / Math.sin(between);
  const axis = wide.axis.map((value, index) => value * wideWeight + narrow.axis[index] * narrowWeight);
  const length = Math.hypot(...axis) || 1;
  return { axis: axis.map(value => value / length), thetaO, thetaE };
}

function mergeEntries(first, second) {
  return {
    minimum: first.minimum.map((value, axis) => Math.min(value, second.minimum[axis])),
    maximum: first.maximum.map((value, axis) => Math.max(value, second.maximum[axis])),
    energy: first.energy + second.energy,
    ...mergeCones(first, second),
  };
}

function describeAnalyticLight(floats, uints, wordBase) {
  const lightType = uints[wordBase + 3];
  const position = [floats[wordBase], floats[wordBase + 1], floats[wordBase + 2]];
  const radius = floats[wordBase + 11];
  const direction = [floats[wordBase + 8], floats[wordBase + 9], floats[wordBase + 10]];
  const sizeU = floats[wordBase + 15];
  const sizeV = floats[wordBase + 19];
  const weight = floats[wordBase + 28];
  const extent = Math.max(radius, 0.5 * Math.hypot(sizeU, sizeV));
  const minimum = position.map(value => value - extent);
  const maximum = position.map(value => value + extent);
  if (lightType === LIGHT_TYPE_POINT) {
    return { minimum, maximum, axis: [0, 1, 0], thetaO: Math.PI, thetaE: HALF_PI, energy: weight };
  }
  if (lightType === LIGHT_TYPE_SPOT) {
    const thetaE = Math.acos(Math.min(1, Math.max(-1, floats[wordBase + 20])));
    return { minimum, maximum, axis: direction, thetaO: 0, thetaE, energy: weight };
  }
  return { minimum, maximum, axis: direction, thetaO: 0, thetaE: HALF_PI, energy: weight };
}

function describeEmissiveTriangle(floats, wordBase) {
  const p0 = [floats[wordBase], floats[wordBase + 1], floats[wordBase + 2]];
  const edgeOne = [floats[wordBase + 4], floats[wordBase + 5], floats[wordBase + 6]];
  const edgeTwo = [floats[wordBase + 8], floats[wordBase + 9], floats[wordBase + 10]];
  const normal = [floats[wordBase + 12], floats[wordBase + 13], floats[wordBase + 14]];
  const weight = floats[wordBase + 20];
  const corners = [p0, p0.map((v, i) => v + edgeOne[i]), p0.map((v, i) => v + edgeTwo[i])];
  return {
    minimum: [0, 1, 2].map(axis => Math.min(corners[0][axis], corners[1][axis], corners[2][axis])),
    maximum: [0, 1, 2].map(axis => Math.max(corners[0][axis], corners[1][axis], corners[2][axis])),
    axis: normal,
    thetaO: 0,
    thetaE: HALF_PI,
    energy: weight,
  };
}

// Recursive median split on the axis where the leaf centres spread most. Depth stays near log2(count).
function buildSubtree(entries) {
  if (entries.length === 1) {
    return { leaf: entries[0] };
  }
  let splitAxis = 0;
  let widest = -1;
  for (let axis = 0; axis < 3; axis++) {
    const centres = entries.map(entry => entry.minimum[axis] + entry.maximum[axis]);
    const spread = Math.max(...centres) - Math.min(...centres);
    if (spread > widest) {
      widest = spread;
      splitAxis = axis;
    }
  }
  const sorted = [...entries].sort(
    (first, second) => (first.minimum[splitAxis] + first.maximum[splitAxis]) - (second.minimum[splitAxis] + second.maximum[splitAxis]),
  );
  const middle = sorted.length >> 1;
  const left = buildSubtree(sorted.slice(0, middle));
  const right = buildSubtree(sorted.slice(middle));
  return { left, right, ...mergeEntries(summaryOf(left), summaryOf(right)) };
}

function summaryOf(subtree) {
  return subtree.leaf ?? subtree;
}

// Lays one tree into `nodeWords`: leaf of emitter i at leafBase + i, inner nodes from `nextInnerIndex` on.
function writeSubtree(subtree, parentIndex, state) {
  const summary = summaryOf(subtree);
  let nodeIndex;
  if (subtree.leaf) {
    nodeIndex = state.leafBase + subtree.leaf.emitterIndex;
  } else {
    nodeIndex = state.nextInnerIndex;
    state.nextInnerIndex += 1;
  }
  const base = nodeIndex * NODE_WORDS;
  const { floats, ints, uints } = state;
  floats[base] = summary.minimum[0];
  floats[base + 1] = summary.minimum[1];
  floats[base + 2] = summary.minimum[2];
  floats[base + 3] = summary.energy;
  floats[base + 4] = summary.maximum[0];
  floats[base + 5] = summary.maximum[1];
  floats[base + 6] = summary.maximum[2];
  floats[base + 7] = summary.thetaO;
  floats[base + 8] = summary.axis[0];
  floats[base + 9] = summary.axis[1];
  floats[base + 10] = summary.axis[2];
  floats[base + 11] = summary.thetaE;
  uints[base + 15] = 0xffffffff;
  if (subtree.leaf) {
    ints[base + 12] = -1 - parentIndex;
    uints[base + 13] = subtree.leaf.emitterIndex;
    uints[base + 14] = (1 | state.kindBits) >>> 0;
  } else {
    ints[base + 12] = writeSubtree(subtree.left, nodeIndex, state);
    uints[base + 13] = writeSubtree(subtree.right, nodeIndex, state);
    uints[base + 14] = ((parentIndex & 0xffff) | state.kindBits) >>> 0;
  }
  return nodeIndex;
}

function collectAnalyticEntries(packedLights) {
  const floats = new Float32Array(packedLights.lights.buffer, packedLights.lights.byteOffset, packedLights.lightCount * 32);
  const uints = new Uint32Array(packedLights.lights.buffer, packedLights.lights.byteOffset, packedLights.lightCount * 32);
  const entries = [];
  for (let index = 0; index < packedLights.lightCount; index++) {
    const entry = describeAnalyticLight(floats, uints, index * 32);
    entries.push({ ...entry, emitterIndex: index });
  }
  return entries;
}

function collectEmissiveEntries(packedEmissives) {
  const floats = new Float32Array(
    packedEmissives.emissiveTriangles.buffer,
    packedEmissives.emissiveTriangles.byteOffset,
    packedEmissives.emissiveTriangleCount * 24,
  );
  const entries = [];
  for (let index = 0; index < packedEmissives.emissiveTriangleCount; index++) {
    entries.push({ ...describeEmissiveTriangle(floats, index * 24), emitterIndex: index });
  }
  return entries;
}

// A tree picks an emitter without asking whether the receiver is linked to it, so it needs every receiver to see every emitter:
// all instances keep the default (full) light group mask and no emitter has an empty mask.
function receiversSeeEveryEmitter(instances, instanceCount) {
  const words = new Uint32Array(instances.buffer, instances.byteOffset, instanceCount * INSTANCE_WORDS);
  for (let index = 0; index < instanceCount; index++) {
    const lo = words[index * INSTANCE_WORDS + INSTANCE_MASK_WORD];
    const hi = words[index * INSTANCE_WORDS + INSTANCE_MASK_WORD + 1];
    if (lo !== 0xffffffff || hi !== 0xffffffff) {
      return false;
    }
  }
  return true;
}

function everyMaskIsNonEmpty(buffer, count, strideWords, maskWordOffset) {
  const words = new Uint32Array(buffer.buffer, buffer.byteOffset, count * strideWords);
  for (let index = 0; index < count; index++) {
    if (words[index * strideWords + maskWordOffset] === 0 && words[index * strideWords + maskWordOffset + 1] === 0) {
      return false;
    }
  }
  return true;
}

function lightsCanUseTree(packedLights, wantTree) {
  if (packedLights.lightCount === 0 || packedLights.lightCount > MAX_EMITTERS_PER_TREE || packedLights.hasDistant) {
    return false;
  }
  if (!everyMaskIsNonEmpty(packedLights.lights, packedLights.lightCount, 32, 30)) {
    return false;
  }
  return wantTree ?? packedLights.lightCount > LIGHT_TREE_AUTO_EMITTER_COUNT;
}

function emissivesCanUseTree(packedEmissives, wantTree) {
  const count = packedEmissives.emissiveTriangleCount;
  if (count === 0 || count > MAX_EMITTERS_PER_TREE) {
    return false;
  }
  if (!everyMaskIsNonEmpty(packedEmissives.emissiveTriangles, count, 24, 22)) {
    return false;
  }
  return wantTree ?? count > LIGHT_TREE_AUTO_EMITTER_COUNT;
}

/**
 * Builds the node buffer. `options.useLightTree`: true builds a tree for every kind that can have one, false builds none,
 * undefined (the default) builds one for a kind with more than LIGHT_TREE_AUTO_EMITTER_COUNT emitters.
 * A kind falls back to the cumulative-weight pick when the lights hold a sun, any instance restricts its light group, or the kind has more than 16383 emitters.
 * Returns { lightTreeNodes, lightTreeNodeCount, analyticTree, emissiveTree } (the booleans say which kinds use a tree), or
 * lightTreeNodeCount 0 when neither does.
 */
export function buildLightTreeNodes(packedLights, packedEmissives, packedInstances, options = {}) {
  const wantTree = typeof options.useLightTree === 'boolean' ? options.useLightTree : undefined;
  const receiversOk = wantTree !== false && receiversSeeEveryEmitter(packedInstances.instances, packedInstances.instanceCount);
  const analyticTree = receiversOk && lightsCanUseTree(packedLights, wantTree);
  const emissiveTree = receiversOk && emissivesCanUseTree(packedEmissives, wantTree);
  if (!analyticTree && !emissiveTree) {
    return { lightTreeNodes: new Uint8Array(LIGHT_TREE_NODE_BYTES), lightTreeNodeCount: 0, analyticTree: false, emissiveTree: false };
  }
  const analyticCount = analyticTree ? packedLights.lightCount : 0;
  const emissiveCount = emissiveTree ? packedEmissives.emissiveTriangleCount : 0;
  const nodeCount = 1 + (analyticCount > 0 ? 2 * analyticCount - 1 : 0) + (emissiveCount > 0 ? 2 * emissiveCount - 1 : 0);
  const bytes = new Uint8Array(nodeCount * LIGHT_TREE_NODE_BYTES);
  const state = {
    floats: new Float32Array(bytes.buffer),
    ints: new Int32Array(bytes.buffer),
    uints: new Uint32Array(bytes.buffer),
    leafBase: 0,
    nextInnerIndex: 0,
    kindBits: 0,
  };
  let nextFreeNode = 1;
  let analyticRoot = NO_TREE_ROOT;
  let emissiveRoot = NO_TREE_ROOT;
  let emissiveLeafBase = NO_TREE_ROOT;
  let totalEnergy = 0;
  if (analyticCount > 0) {
    state.leafBase = nextFreeNode;
    state.nextInnerIndex = nextFreeNode + analyticCount;
    state.kindBits = 0;
    const subtree = buildSubtree(collectAnalyticEntries(packedLights));
    analyticRoot = writeSubtree(subtree, 0, state);
    totalEnergy += summaryOf(subtree).energy;
    nextFreeNode += 2 * analyticCount - 1;
  }
  if (emissiveCount > 0) {
    state.leafBase = nextFreeNode;
    state.nextInnerIndex = nextFreeNode + emissiveCount;
    state.kindBits = KIND_EMISSIVE_BIT;
    const subtree = buildSubtree(collectEmissiveEntries(packedEmissives));
    emissiveRoot = writeSubtree(subtree, 0, state);
    emissiveLeafBase = nextFreeNode;
    totalEnergy += summaryOf(subtree).energy;
  }
  state.floats[3] = totalEnergy;
  state.floats[7] = Math.PI;
  state.floats[9] = 1;
  state.floats[11] = Math.PI;
  state.ints[12] = analyticRoot === NO_TREE_ROOT ? -1 : analyticRoot;
  state.uints[13] = emissiveRoot;
  state.uints[14] = 0;
  state.uints[15] = emissiveLeafBase;
  return { lightTreeNodes: bytes, lightTreeNodeCount: nodeCount, analyticTree: analyticCount > 0, emissiveTree: emissiveCount > 0 };
}
