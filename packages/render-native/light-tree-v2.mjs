// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2011-2022 Blender Foundation
//
// Host-side light tree for the Cycles-parity native kernel. A translation of the build half of Blender Cycles 5.3
// `scene/light_tree.cpp` and `light_tree.h`: a bounding volume tree over analytic lights and emissive triangles whose
// nodes hold a bounding box, a bounding cone (axis, theta_o, theta_e) and an energy, split with the surface area
// orientation heuristic (12 centroid buckets, at most 8 emitters per leaf). Distant lights (the sun) form one leaf
// outside the local tree, as in Cycles, and the environment is not an emitter of this tree.
// Pure typed arrays, no Node-only imports. The buffer layout is documented in FORMAT-v2.md section 7.

export const LIGHT_TREE_REVISION = 1;
export const LIGHT_TREE_NODE_BYTES = 64;
export const LIGHT_TREE_EMITTER_BYTES = 32;
export const LIGHT_TREE_MAX_LEAF_EMITTERS = 8;
// The kernel reads at most this many emitters of one leaf (`LTR_MAX_LEAF_EMITTERS` in light_tree.wgsl); only the distant leaf can hold more than 8.
export const LIGHT_TREE_KERNEL_MAX_LEAF_EMITTERS = 32;
export const LIGHT_TREE_MAX_EMITTERS = 4194304;
export const LIGHT_TREE_BUCKET_COUNT = 12;
export const LIGHT_TREE_MAX_DEPTH = 63;

// Node `emitter_count_and_kind` bits.
export const LIGHT_TREE_NODE_COUNT_MASK = 0xffff;
export const LIGHT_TREE_NODE_HAS_TRIANGLE = 1 << 16;
export const LIGHT_TREE_NODE_DISTANT = 1 << 17;
export const LIGHT_TREE_NODE_HAS_LIGHT = 1 << 18;

// Emitter `kind_and_depth` bits: bit 0 triangle, bit 1 distant, bits 8..15 depth.
export const LIGHT_TREE_EMITTER_TRIANGLE = 1;
export const LIGHT_TREE_EMITTER_DISTANT = 2;
export const LIGHT_TREE_EMITTER_DEPTH_SHIFT = 8;

const LIGHT_BYTES = 128;
const EMISSIVE_TRIANGLE_BYTES = 96;
const LIGHT_TYPE_POINT = 0;
const LIGHT_TYPE_SPOT = 1;
const LIGHT_TYPE_AREA_RECT = 2;
const LIGHT_TYPE_AREA_DISK = 3;
const LIGHT_TYPE_SUN = 4;
const LIGHT_TREE_LEAF_MARKER = -1;
const LEAF_FORCED_BALANCE_DEPTH = 24;
const NO_LEAF_INDEX = 0xffffffff;
const ANGLE_EPSILON = 5e-4;

const HALF_PI = Math.PI / 2;

function vectorLength(vector) {
  return Math.hypot(vector[0], vector[1], vector[2]);
}

function dotProduct(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function normalizeOrZero(vector) {
  const length = vectorLength(vector);
  if (!(length > 1e-20)) {
    return [0, 0, 0];
  }
  return [vector[0] / length, vector[1] / length, vector[2] / length];
}

function safeArccosine(value) {
  return Math.acos(Math.min(1, Math.max(-1, value)));
}

function perpendicularTo(axis) {
  const helper = Math.abs(axis[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const projected = [
    helper[0] - axis[0] * dotProduct(helper, axis),
    helper[1] - axis[1] * dotProduct(helper, axis),
    helper[2] - axis[2] * dotProduct(helper, axis),
  ];
  return normalizeOrZero(projected);
}

// ---- Orientation cone (Cycles OrientationBounds) --------------------------------------------------------------

function emptyCone() {
  return { axis: [0, 0, 0], thetaO: 0, thetaE: 0 };
}

function isEmptyCone(cone) {
  return cone.axis[0] === 0 && cone.axis[1] === 0 && cone.axis[2] === 0;
}

export function coneMeasure(cone) {
  if (isEmptyCone(cone)) {
    return 0;
  }
  const thetaW = Math.min(Math.PI, cone.thetaO + cone.thetaE);
  const cosThetaO = Math.cos(cone.thetaO);
  const sinThetaO = Math.sin(cone.thetaO);
  return (
    2 * Math.PI * (1 - cosThetaO) +
    HALF_PI *
      (2 * thetaW * sinThetaO - Math.cos(cone.thetaO - 2 * thetaW) - 2 * cone.thetaO * sinThetaO + cosThetaO)
  );
}

export function mergeCones(coneA, coneB) {
  if (isEmptyCone(coneA)) {
    return coneB;
  }
  if (isEmptyCone(coneB)) {
    return coneA;
  }
  const [wider, narrower] = coneB.thetaO > coneA.thetaO ? [coneB, coneA] : [coneA, coneB];
  const cosBetween = dotProduct(wider.axis, narrower.axis);
  const thetaD = safeArccosine(cosBetween);
  const thetaE = Math.max(wider.thetaE, narrower.thetaE);

  if (wider.thetaO + ANGLE_EPSILON >= Math.min(Math.PI, thetaD + narrower.thetaO)) {
    return { axis: wider.axis, thetaO: wider.thetaO, thetaE };
  }
  const oppositeAxes = cosBetween < -0.9995;
  // Cycles keeps the midpoint theta_o for opposite axes, but an orthogonal axis then misses part of the wider cone.
  // A quarter turn plus the larger theta_o (the narrower one pushed out by its offset from exactly opposite)
  // contains both, so the node cone stays a true bound.
  const thetaO = oppositeAxes
    ? Math.max(
        (thetaD + wider.thetaO + narrower.thetaO) * 0.5,
        HALF_PI + Math.max(wider.thetaO, narrower.thetaO + Math.PI - thetaD)
      )
    : (thetaD + wider.thetaO + narrower.thetaO) * 0.5;
  if (thetaO >= Math.PI) {
    return { axis: wider.axis, thetaO: Math.PI, thetaE };
  }
  let axis;
  if (oppositeAxes) {
    axis = perpendicularTo(wider.axis);
  } else {
    const thetaR = thetaO - wider.thetaO;
    const ortho = normalizeOrZero([
      narrower.axis[0] - wider.axis[0] * cosBetween,
      narrower.axis[1] - wider.axis[1] * cosBetween,
      narrower.axis[2] - wider.axis[2] * cosBetween,
    ]);
    const cosR = Math.cos(thetaR);
    const sinR = Math.sin(thetaR);
    axis = [
      wider.axis[0] * cosR + ortho[0] * sinR,
      wider.axis[1] * cosR + ortho[1] * sinR,
      wider.axis[2] * cosR + ortho[2] * sinR,
    ];
  }
  return { axis, thetaO, thetaE };
}

// ---- Measure: bounding box, cone and energy (Cycles LightTreeMeasure) ----------------------------------------

function emptyMeasure() {
  return {
    boxMin: [Infinity, Infinity, Infinity],
    boxMax: [-Infinity, -Infinity, -Infinity],
    cone: emptyCone(),
    energy: 0,
  };
}

function addMeasure(target, other) {
  if (other.energy === 0) {
    return;
  }
  for (let axis = 0; axis < 3; axis++) {
    target.boxMin[axis] = Math.min(target.boxMin[axis], other.boxMin[axis]);
    target.boxMax[axis] = Math.max(target.boxMax[axis], other.boxMax[axis]);
  }
  target.cone = mergeCones(target.cone, other.cone);
  target.energy += other.energy;
}

function copyMeasure(measure) {
  return {
    boxMin: measure.boxMin.slice(),
    boxMax: measure.boxMax.slice(),
    cone: measure.cone,
    energy: measure.energy,
  };
}

function sumMeasures(a, b) {
  const sum = copyMeasure(a);
  addMeasure(sum, b);
  return sum;
}

// energy * box area * cone measure, Eq. 2 of the many-light paper.
export function measureCost(measure) {
  if (measure.energy === 0) {
    return 0;
  }
  const sizeX = measure.boxMax[0] - measure.boxMin[0];
  const sizeY = measure.boxMax[1] - measure.boxMin[1];
  const sizeZ = measure.boxMax[2] - measure.boxMin[2];
  const area = 2 * (sizeX * sizeY + sizeY * sizeZ + sizeZ * sizeX);
  const areaMeasure = area === 0 ? Math.hypot(sizeX, sizeY, sizeZ) : area;
  return measure.energy * areaMeasure * coneMeasure(measure.cone);
}

// ---- Emitters read from the packed FORMAT-v2 tables ----------------------------------------------------------

function assertFiniteNumbers(values, label, index) {
  for (const value of values) {
    if (!Number.isFinite(value)) {
      throw new Error(`buildLightTree: ${label} ${index} has a non-finite value; pass finite positions, sizes and radiance.`);
    }
  }
}

function averageAbsolute(red, green, blue) {
  return (Math.abs(red) + Math.abs(green) + Math.abs(blue)) / 3;
}

function lightEmitter(view, index, unifiedIndex) {
  const floats = new Float32Array(view.buffer, view.byteOffset + index * LIGHT_BYTES, LIGHT_BYTES / 4);
  const words = new Uint32Array(view.buffer, view.byteOffset + index * LIGHT_BYTES, LIGHT_BYTES / 4);
  // Words 3 and 7 are integers, 26 and 27 hold an index and a leaf; only the float fields can be non-finite.
  assertFiniteNumbers(
    [...floats.subarray(0, 3), ...floats.subarray(4, 7), ...floats.subarray(8, 26)],
    'analytic light',
    index
  );
  const lightType = words[3];
  const position = [floats[0], floats[1], floats[2]];
  const direction = normalizeOrZero([floats[8], floats[9], floats[10]]);
  const radius = floats[11];
  const averageRadiance = averageAbsolute(floats[4], floats[5], floats[6]);
  const areaOrSolidAngle = floats[24];
  const emitter = {
    unifiedIndex,
    isTriangle: false,
    recordIndex: index,
    isDistant: lightType === LIGHT_TYPE_SUN,
    maskLow: words[30],
    boxMin: [0, 0, 0],
    boxMax: [0, 0, 0],
    centroid: position,
    cone: emptyCone(),
    energy: 0,
  };
  const axis = direction[0] === 0 && direction[1] === 0 && direction[2] === 0 ? [0, 0, -1] : direction;
  if (lightType === LIGHT_TYPE_POINT || lightType === LIGHT_TYPE_SPOT) {
    const extent = Math.max(0, radius);
    emitter.boxMin = position.map((value) => value - extent);
    emitter.boxMax = position.map((value) => value + extent);
    emitter.energy = radius > 0 ? averageRadiance * Math.PI * radius * radius : averageRadiance;
    if (lightType === LIGHT_TYPE_POINT) {
      emitter.cone = { axis, thetaO: Math.PI, thetaE: HALF_PI };
    } else {
      emitter.cone = { axis, thetaO: 0, thetaE: Math.min(HALF_PI, safeArccosine(floats[20])) };
    }
  } else if (lightType === LIGHT_TYPE_AREA_RECT || lightType === LIGHT_TYPE_AREA_DISK) {
    const halfU = [0.5 * floats[15] * floats[12], 0.5 * floats[15] * floats[13], 0.5 * floats[15] * floats[14]];
    const halfV = [0.5 * floats[19] * floats[16], 0.5 * floats[19] * floats[17], 0.5 * floats[19] * floats[18]];
    for (let axisIndex = 0; axisIndex < 3; axisIndex++) {
      const spread = Math.abs(halfU[axisIndex]) + Math.abs(halfV[axisIndex]);
      emitter.boxMin[axisIndex] = position[axisIndex] - spread;
      emitter.boxMax[axisIndex] = position[axisIndex] + spread;
    }
    emitter.energy = averageRadiance * areaOrSolidAngle;
    const tanHalfSpread = floats[22];
    const thetaE = tanHalfSpread > 0 ? Math.min(HALF_PI, Math.atan(tanHalfSpread)) : HALF_PI;
    emitter.cone = { axis, thetaO: 0, thetaE };
  } else if (lightType === LIGHT_TYPE_SUN) {
    emitter.energy = averageRadiance * areaOrSolidAngle;
    emitter.cone = { axis, thetaO: 0, thetaE: safeArccosine(floats[20]) };
  } else {
    throw new Error(`buildLightTree: analytic light ${index} has unknown light_type ${lightType}; pass 0 to 4.`);
  }
  return emitter;
}

// The kernel samples emissive triangles on both sides (abs of the cosine), so the cone is the double-sided
// one of Cycles: any vector in the triangle plane with theta_o = pi/2.
function triangleEmitter(view, index, unifiedIndex) {
  const floats = new Float32Array(view.buffer, view.byteOffset + index * EMISSIVE_TRIANGLE_BYTES, EMISSIVE_TRIANGLE_BYTES / 4);
  const words = new Uint32Array(view.buffer, view.byteOffset + index * EMISSIVE_TRIANGLE_BYTES, EMISSIVE_TRIANGLE_BYTES / 4);
  // Words 7, 11 and 15 are u32 indices; only the float fields are checked.
  assertFiniteNumbers([...floats.subarray(0, 7), ...floats.subarray(8, 11), ...floats.subarray(12, 15), ...floats.subarray(16, 20)], 'emissive triangle', index);
  const origin = [floats[0], floats[1], floats[2]];
  const edgeOne = [floats[4], floats[5], floats[6]];
  const edgeTwo = [floats[8], floats[9], floats[10]];
  const vertices = [
    origin,
    origin.map((value, axis) => value + edgeOne[axis]),
    origin.map((value, axis) => value + edgeTwo[axis]),
  ];
  const emitter = {
    unifiedIndex,
    isTriangle: true,
    recordIndex: index,
    isDistant: false,
    maskLow: words[22],
    boxMin: [0, 1, 2].map((axis) => Math.min(vertices[0][axis], vertices[1][axis], vertices[2][axis])),
    boxMax: [0, 1, 2].map((axis) => Math.max(vertices[0][axis], vertices[1][axis], vertices[2][axis])),
    centroid: [0, 1, 2].map((axis) => (vertices[0][axis] + vertices[1][axis] + vertices[2][axis]) / 3),
    cone: emptyCone(),
    energy: floats[3] * averageAbsolute(floats[16], floats[17], floats[18]),
  };
  const inPlane = normalizeOrZero(edgeOne.map((value) => -value));
  const axis = inPlane[0] === 0 && inPlane[1] === 0 && inPlane[2] === 0 ? [1, 0, 0] : inPlane;
  emitter.cone = { axis, thetaO: HALF_PI, thetaE: HALF_PI };
  return emitter;
}

function emitterMeasure(emitter) {
  return {
    boxMin: emitter.boxMin.slice(),
    boxMax: emitter.boxMax.slice(),
    cone: emitter.cone,
    energy: emitter.energy,
  };
}

// ---- Build (Cycles LightTree::recursive_build and should_split) ----------------------------------------------

function createBuckets() {
  return Array.from({ length: LIGHT_TREE_BUCKET_COUNT }, () => ({ measure: emptyMeasure(), count: 0, maskOr: 0 }));
}

function addToBucket(bucket, emitter) {
  addMeasure(bucket.measure, emitterMeasure(emitter));
  bucket.count += 1;
  bucket.maskOr = (bucket.maskOr | emitter.maskLow) >>> 0;
}

function sumBuckets(a, b) {
  return {
    measure: sumMeasures(a.measure, b.measure),
    count: a.count + b.count,
    maskOr: (a.maskOr | b.maskOr) >>> 0,
  };
}

function fillBuckets(order, start, end, dimension, centroidMin, centroidSize) {
  const buckets = createBuckets();
  if (centroidSize[dimension] === 0) {
    for (let position = start; position < end; position++) {
      addToBucket(buckets[0], order[position]);
    }
    return buckets;
  }
  const inverseExtent = 1 / centroidSize[dimension];
  for (let position = start; position < end; position++) {
    const emitter = order[position];
    const rawIndex = Math.floor(
      LIGHT_TREE_BUCKET_COUNT * (emitter.centroid[dimension] - centroidMin[dimension]) * inverseExtent
    );
    const bucketIndex = Math.min(LIGHT_TREE_BUCKET_COUNT - 1, Math.max(0, rawIndex));
    addToBucket(buckets[bucketIndex], emitter);
  }
  return buckets;
}

function cumulativeFromLeft(buckets) {
  const result = [buckets[0]];
  for (let index = 1; index < LIGHT_TREE_BUCKET_COUNT - 1; index++) {
    result.push(sumBuckets(result[index - 1], buckets[index]));
  }
  return result;
}

function cumulativeFromRight(buckets) {
  const result = new Array(LIGHT_TREE_BUCKET_COUNT - 1);
  result[LIGHT_TREE_BUCKET_COUNT - 2] = buckets[LIGHT_TREE_BUCKET_COUNT - 1];
  for (let index = LIGHT_TREE_BUCKET_COUNT - 3; index >= 0; index--) {
    result[index] = sumBuckets(result[index + 1], buckets[index + 1]);
  }
  return result;
}

function centroidBounds(order, start, end) {
  const centroidMin = [Infinity, Infinity, Infinity];
  const centroidMax = [-Infinity, -Infinity, -Infinity];
  for (let position = start; position < end; position++) {
    for (let axis = 0; axis < 3; axis++) {
      centroidMin[axis] = Math.min(centroidMin[axis], order[position].centroid[axis]);
      centroidMax[axis] = Math.max(centroidMax[axis], order[position].centroid[axis]);
    }
  }
  return { centroidMin, centroidSize: centroidMax.map((value, axis) => value - centroidMin[axis]) };
}

// Returns { shouldSplit, middle, splitDimension, measure, maskOr }. Mirrors the quirks of the Cycles loop: the node
// measure is summed from the buckets of dimension 0, and the total cost is only set when the centroid box has an
// extent along x, so a set of emitters on one x plane only splits by count once it has more than a leaf's worth.
function chooseSplit(order, start, end) {
  const emitterCount = end - start;
  if (emitterCount < 2) {
    const only = order[start];
    return {
      shouldSplit: false,
      middle: start,
      splitDimension: -1,
      measure: emitterMeasure(only),
      maskOr: only.maskLow,
    };
  }
  let middle = (start + end) >> 1;
  const { centroidMin, centroidSize } = centroidBounds(order, start, end);
  const maxExtent = Math.max(centroidSize[0], centroidSize[1], centroidSize[2], 0);
  const allExtentsZero = centroidSize[0] === 0 && centroidSize[1] === 0 && centroidSize[2] === 0;

  let totalCost = 0;
  let minimumCost = Number.MAX_VALUE;
  let splitDimension = -1;
  let nodeMeasure = emptyMeasure();
  let nodeMaskOr = 0;

  for (let dimension = 0; dimension < 3; dimension++) {
    if (centroidSize[dimension] === 0 && dimension !== 0) {
      continue;
    }
    const buckets = fillBuckets(order, start, end, dimension, centroidMin, centroidSize);
    const leftBuckets = cumulativeFromLeft(buckets);
    if (dimension === 0) {
      const whole = sumBuckets(leftBuckets[LIGHT_TREE_BUCKET_COUNT - 2], buckets[LIGHT_TREE_BUCKET_COUNT - 1]);
      nodeMeasure = whole.measure;
      nodeMaskOr = whole.maskOr;
      if (allExtentsZero) {
        break;
      }
      if (centroidSize[0] === 0) {
        continue;
      }
      totalCost = measureCost(nodeMeasure);
      if (totalCost === 0) {
        break;
      }
    }
    const rightBuckets = cumulativeFromRight(buckets);
    const inverseExtent = centroidSize[dimension] === 0 ? Number.MAX_VALUE : 1 / centroidSize[dimension];
    const regularization = maxExtent * inverseExtent;
    for (let split = 0; split < LIGHT_TREE_BUCKET_COUNT - 1; split++) {
      const cost = regularization * (measureCost(leftBuckets[split].measure) + measureCost(rightBuckets[split].measure));
      if (cost < totalCost && cost < minimumCost) {
        minimumCost = cost;
        splitDimension = dimension;
        middle = start + leftBuckets[split].count;
      }
    }
  }
  return {
    shouldSplit: minimumCost < totalCost || emitterCount > LIGHT_TREE_MAX_LEAF_EMITTERS,
    middle,
    splitDimension,
    measure: nodeMeasure,
    maskOr: nodeMaskOr,
  };
}

function partitionByCentroid(order, start, end, dimension) {
  const slice = order.slice(start, end);
  slice.sort((a, b) => a.centroid[dimension] - b.centroid[dimension] || a.unifiedIndex - b.unifiedIndex);
  for (let offset = 0; offset < slice.length; offset++) {
    order[start + offset] = slice[offset];
  }
}

function sortLeafByIndex(order, start, end) {
  const slice = order.slice(start, end);
  slice.sort((a, b) => a.unifiedIndex - b.unifiedIndex);
  for (let offset = 0; offset < slice.length; offset++) {
    order[start + offset] = slice[offset];
  }
}

function trailBit(depth, trailLow, trailHigh) {
  if (depth < 32) {
    return [(trailLow | (1 << depth)) >>> 0, trailHigh];
  }
  return [trailLow, (trailHigh | (1 << (depth - 32))) >>> 0];
}

function summarizeLeafFlags(order, start, end) {
  let flags = 0;
  for (let position = start; position < end; position++) {
    flags |= order[position].isTriangle ? LIGHT_TREE_NODE_HAS_TRIANGLE : LIGHT_TREE_NODE_HAS_LIGHT;
  }
  return flags;
}

function buildSubtree(state, start, end, depth, trailLow, trailHigh) {
  const nodeIndex = state.nodes.length;
  const node = { measure: null, leftChild: LIGHT_TREE_LEAF_MARKER, rightOrFirst: 0, countAndKind: 0, maskOr: 0 };
  state.nodes.push(node);

  const decision = chooseSplit(state.order, start, end);
  node.measure = decision.measure;
  node.maskOr = decision.maskOr;

  const forceBalance = depth >= LEAF_FORCED_BALANCE_DEPTH && end - start >= 2;
  let shouldSplit = decision.shouldSplit || (forceBalance && end - start > LIGHT_TREE_MAX_LEAF_EMITTERS);
  let middle = decision.middle;
  if (shouldSplit && forceBalance) {
    middle = (start + end) >> 1;
  } else if (shouldSplit && decision.splitDimension !== -1) {
    partitionByCentroid(state.order, start, end, decision.splitDimension);
  }
  if (shouldSplit && (middle <= start || middle >= end)) {
    middle = (start + end) >> 1;
  }
  if (depth > LIGHT_TREE_MAX_DEPTH) {
    shouldSplit = false;
  }

  if (!shouldSplit) {
    sortLeafByIndex(state.order, start, end);
    const leafCount = end - start;
    if (leafCount > LIGHT_TREE_NODE_COUNT_MASK) {
      throw new Error(`buildLightTree: a leaf holds ${leafCount} emitters, more than ${LIGHT_TREE_NODE_COUNT_MASK}.`);
    }
    node.rightOrFirst = start;
    node.countAndKind = (leafCount | summarizeLeafFlags(state.order, start, end)) >>> 0;
    for (let position = start; position < end; position++) {
      const emitter = state.order[position];
      emitter.leafIndex = nodeIndex;
      emitter.depth = depth;
      emitter.trailLow = trailLow;
      emitter.trailHigh = trailHigh;
    }
    return nodeIndex;
  }

  const leftIndex = buildSubtree(state, start, middle, depth + 1, trailLow, trailHigh);
  const [rightLow, rightHigh] = trailBit(depth, trailLow, trailHigh);
  const rightIndex = buildSubtree(state, middle, end, depth + 1, rightLow, rightHigh);
  node.leftChild = leftIndex;
  node.rightOrFirst = rightIndex;
  node.countAndKind = (state.nodes[leftIndex].countAndKind | state.nodes[rightIndex].countAndKind) & ~LIGHT_TREE_NODE_COUNT_MASK;
  node.countAndKind >>>= 0;
  node.measure = sumMeasures(state.nodes[leftIndex].measure, state.nodes[rightIndex].measure);
  node.maskOr = (state.nodes[leftIndex].maskOr | state.nodes[rightIndex].maskOr) >>> 0;
  return nodeIndex;
}

function buildDistantLeaf(state, start, end, depth, trailLow, trailHigh) {
  const nodeIndex = state.nodes.length;
  const measure = emptyMeasure();
  let maskOr = 0;
  for (let position = start; position < end; position++) {
    addMeasure(measure, emitterMeasure(state.order[position]));
    maskOr = (maskOr | state.order[position].maskLow) >>> 0;
  }
  sortLeafByIndex(state.order, start, end);
  for (let position = start; position < end; position++) {
    const emitter = state.order[position];
    emitter.leafIndex = nodeIndex;
    emitter.depth = depth;
    emitter.trailLow = trailLow;
    emitter.trailHigh = trailHigh;
  }
  const count = end - start;
  if (count > LIGHT_TREE_KERNEL_MAX_LEAF_EMITTERS) {
    throw new Error(
      `buildLightTree: ${count} distant lights exceed the ${LIGHT_TREE_KERNEL_MAX_LEAF_EMITTERS} the kernel reads from one leaf. ` +
        `Pass at most ${LIGHT_TREE_KERNEL_MAX_LEAF_EMITTERS} sun or distant lights, or merge some of them.`
    );
  }
  state.nodes.push({
    measure,
    leftChild: LIGHT_TREE_LEAF_MARKER,
    rightOrFirst: start,
    countAndKind: (count | LIGHT_TREE_NODE_DISTANT | LIGHT_TREE_NODE_HAS_LIGHT) >>> 0,
    maskOr,
  });
  return nodeIndex;
}

// ---- Serialization ------------------------------------------------------------------------------------------

function writeNode(floats, words, ints, node) {
  const { measure } = node;
  const hasBox = measure.energy > 0 && measure.boxMin[0] <= measure.boxMax[0];
  const boxMin = hasBox ? measure.boxMin : [0, 0, 0];
  const boxMax = hasBox ? measure.boxMax : [0, 0, 0];
  const cone = measure.energy > 0 ? measure.cone : emptyCone();
  floats[0] = boxMin[0];
  floats[1] = boxMin[1];
  floats[2] = boxMin[2];
  floats[3] = measure.energy;
  floats[4] = boxMax[0];
  floats[5] = boxMax[1];
  floats[6] = boxMax[2];
  floats[7] = cone.thetaO;
  floats[8] = cone.axis[0];
  floats[9] = cone.axis[1];
  floats[10] = cone.axis[2];
  floats[11] = cone.thetaE;
  ints[12] = node.leftChild;
  words[13] = node.rightOrFirst;
  words[14] = node.countAndKind;
  words[15] = node.maskOr;
}

function serializeNodes(nodes) {
  const bytes = new Uint8Array(Math.max(1, nodes.length) * LIGHT_TREE_NODE_BYTES);
  for (let index = 0; index < nodes.length; index++) {
    const offset = index * LIGHT_TREE_NODE_BYTES;
    writeNode(
      new Float32Array(bytes.buffer, offset, 16),
      new Uint32Array(bytes.buffer, offset, 16),
      new Int32Array(bytes.buffer, offset, 16),
      nodes[index]
    );
  }
  return bytes;
}

function serializeEmitters(order) {
  const bytes = new Uint8Array(Math.max(1, order.length) * LIGHT_TREE_EMITTER_BYTES);
  for (let slot = 0; slot < order.length; slot++) {
    const emitter = order[slot];
    const offset = slot * LIGHT_TREE_EMITTER_BYTES;
    const floats = new Float32Array(bytes.buffer, offset, 8);
    const words = new Uint32Array(bytes.buffer, offset, 8);
    floats[0] = emitter.energy;
    floats[1] = emitter.cone.thetaO;
    floats[2] = emitter.cone.thetaE;
    words[3] =
      ((emitter.isTriangle ? LIGHT_TREE_EMITTER_TRIANGLE : 0) |
        (emitter.isDistant ? LIGHT_TREE_EMITTER_DISTANT : 0) |
        (emitter.depth << LIGHT_TREE_EMITTER_DEPTH_SHIFT)) >>>
      0;
    words[4] = emitter.recordIndex;
    words[5] = emitter.leafIndex;
    words[6] = emitter.trailLow;
    words[7] = emitter.trailHigh;
  }
  return bytes;
}

function assertCount(label, count) {
  if (!Number.isInteger(count) || count < 0) {
    throw new Error(`buildLightTree: ${label} count must be a non-negative integer, got ${count}.`);
  }
}

function validateRecordTable(label, bytes, count, stride) {
  if (!(bytes instanceof Uint8Array)) {
    throw new Error(`buildLightTree: ${label} must be a Uint8Array of FORMAT-v2 records.`);
  }
  if (bytes.byteLength < count * stride) {
    throw new Error(`buildLightTree: ${label} holds ${bytes.byteLength} bytes, fewer than ${count} records of ${stride} bytes.`);
  }
}

/**
 * Builds the light tree over the packed analytic lights and emissive triangles.
 *
 * @param {Uint8Array} lights packed `LightRecord` table (FORMAT-v2 section 6)
 * @param {number} lightCount number of analytic lights
 * @param {Uint8Array} emissiveTriangles packed `EmissiveTriangleRecord` table (section 5)
 * @param {number} emissiveTriangleCount number of emissive triangles
 * @returns {{nodes: Uint8Array, nodeCount: number, emitters: Uint8Array, emitterCount: number,
 *   lightToTree: Uint32Array, lightLeafIndices: Uint32Array}} `lightToTree[i]` is the emitter slot of unified
 *   emitter `i` (analytic lights first, then emissive triangles); `lightLeafIndices[i]` the leaf node of light `i`.
 */
export function buildLightTree(lights, lightCount, emissiveTriangles, emissiveTriangleCount) {
  assertCount('lights', lightCount);
  assertCount('emissiveTriangles', emissiveTriangleCount);
  const totalEmitters = lightCount + emissiveTriangleCount;
  if (totalEmitters > LIGHT_TREE_MAX_EMITTERS) {
    throw new Error(
      `buildLightTree: ${totalEmitters} emitters exceed the limit of ${LIGHT_TREE_MAX_EMITTERS}; merge emissive triangles or drop lights.`
    );
  }
  validateRecordTable('lights', lights, lightCount, LIGHT_BYTES);
  validateRecordTable('emissiveTriangles', emissiveTriangles, emissiveTriangleCount, EMISSIVE_TRIANGLE_BYTES);
  if (totalEmitters === 0) {
    return {
      nodes: new Uint8Array(LIGHT_TREE_NODE_BYTES),
      nodeCount: 0,
      emitters: new Uint8Array(LIGHT_TREE_EMITTER_BYTES),
      emitterCount: 0,
      lightToTree: new Uint32Array(1),
      lightLeafIndices: new Uint32Array(0),
    };
  }

  const localEmitters = [];
  const distantEmitters = [];
  for (let index = 0; index < lightCount; index++) {
    const emitter = lightEmitter(lights, index, index);
    (emitter.isDistant ? distantEmitters : localEmitters).push(emitter);
  }
  for (let index = 0; index < emissiveTriangleCount; index++) {
    localEmitters.push(triangleEmitter(emissiveTriangles, index, lightCount + index));
  }

  const state = { nodes: [], order: localEmitters.concat(distantEmitters) };
  const localCount = localEmitters.length;
  if (distantEmitters.length === 0) {
    buildSubtree(state, 0, localCount, 0, 0, 0);
  } else if (localCount === 0) {
    buildDistantLeaf(state, 0, distantEmitters.length, 0, 0, 0);
  } else {
    const rootIndex = state.nodes.length;
    const root = { measure: null, leftChild: 0, rightOrFirst: 0, countAndKind: 0, maskOr: 0 };
    state.nodes.push(root);
    const leftIndex = buildSubtree(state, 0, localCount, 1, 0, 0);
    const rightIndex = buildDistantLeaf(state, localCount, state.order.length, 1, 1, 0);
    root.leftChild = leftIndex;
    root.rightOrFirst = rightIndex;
    root.measure = sumMeasures(state.nodes[leftIndex].measure, state.nodes[rightIndex].measure);
    root.countAndKind =
      ((state.nodes[leftIndex].countAndKind | state.nodes[rightIndex].countAndKind) & ~LIGHT_TREE_NODE_COUNT_MASK) >>> 0;
    root.maskOr = (state.nodes[leftIndex].maskOr | state.nodes[rightIndex].maskOr) >>> 0;
    if (rootIndex !== 0) {
      throw new Error('buildLightTree: the root node must be node 0.');
    }
  }

  const lightToTree = new Uint32Array(totalEmitters);
  const lightLeafIndices = new Uint32Array(lightCount).fill(NO_LEAF_INDEX);
  for (let slot = 0; slot < state.order.length; slot++) {
    const emitter = state.order[slot];
    lightToTree[emitter.unifiedIndex] = slot;
    if (!emitter.isTriangle) {
      lightLeafIndices[emitter.recordIndex] = emitter.leafIndex;
    }
  }
  return {
    nodes: serializeNodes(state.nodes),
    nodeCount: state.nodes.length,
    emitters: serializeEmitters(state.order),
    emitterCount: state.order.length,
    lightToTree,
    lightLeafIndices,
  };
}
