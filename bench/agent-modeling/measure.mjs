// Measures the object a recipe builds, in world space, for the agent modeling suite: bounds, parts, closure, holes
// (genus), volume, cross-section loops, lines through the object, gear teeth and UV stretch. Shape measures use every
// node's render triangles in world space. Lint, parts and genus come from the engine's own mesh report, the one the
// agent sees: welding render triangles again can invent non-manifold edges that the polygon mesh does not have.
import { readFile } from 'node:fs/promises';
import { createAgentAssetScene } from '../../src/agent-asset.js';
import { createAgentScene, loadAllAgentSceneModules, loadMeshBooleans, needsMeshBooleans, loadPhysicsEngine, needsPhysics } from '../../src/agent-scene.js';
import { parseGltf } from '../../src/gltf.js';
import { GEOMETRY_PROBLEMS } from '../../src/mesh-lint.js';

const WELD_DISTANCE = 1e-5;

function transformPoint(matrix, x, y, z) {
  return [
    matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12],
    matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13],
    matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14],
  ];
}

function boundsOfPositions(positions) {
  const bounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  for (let index = 0; index < positions.length; index++) {
    const axis = index % 3;
    bounds.min[axis] = Math.min(bounds.min[axis], positions[index]);
    bounds.max[axis] = Math.max(bounds.max[axis], positions[index]);
  }
  return bounds;
}

export function worldGeometry(part) {
  const source = part.geometry;
  const positions = new Float32Array(source.positions.length);
  for (let vertex = 0; vertex < source.positions.length / 3; vertex++) {
    const point = transformPoint(part.matrix, source.positions[vertex * 3], source.positions[vertex * 3 + 1], source.positions[vertex * 3 + 2]);
    positions.set(point, vertex * 3);
  }
  // A mirrored matrix flips winding; keep triangles facing out.
  const matrix = part.matrix;
  const determinant = matrix[0] * (matrix[5] * matrix[10] - matrix[6] * matrix[9])
    - matrix[4] * (matrix[1] * matrix[10] - matrix[2] * matrix[9])
    + matrix[8] * (matrix[1] * matrix[6] - matrix[2] * matrix[5]);
  const indices = Uint32Array.from(source.indices);
  if (determinant < 0) {
    for (let triangle = 0; triangle < indices.length; triangle += 3) [indices[triangle + 1], indices[triangle + 2]] = [indices[triangle + 2], indices[triangle + 1]];
  }
  const geometry = { positions, indices };
  if (source.uvs) geometry.uvs = source.uvs;
  return geometry;
}

const triangleArea = (positions, first, second, third) => {
  const ax = positions[second * 3] - positions[first * 3];
  const ay = positions[second * 3 + 1] - positions[first * 3 + 1];
  const az = positions[second * 3 + 2] - positions[first * 3 + 2];
  const bx = positions[third * 3] - positions[first * 3];
  const by = positions[third * 3 + 1] - positions[first * 3 + 1];
  const bz = positions[third * 3 + 2] - positions[first * 3 + 2];
  return Math.hypot(ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx) / 2;
};

export function signedVolume({ positions, indices }) {
  let volume = 0;
  for (let triangle = 0; triangle < indices.length; triangle += 3) {
    const [first, second, third] = [indices[triangle], indices[triangle + 1], indices[triangle + 2]];
    const [ax, ay, az] = [positions[first * 3], positions[first * 3 + 1], positions[first * 3 + 2]];
    const [bx, by, bz] = [positions[second * 3], positions[second * 3 + 1], positions[second * 3 + 2]];
    const [cx, cy, cz] = [positions[third * 3], positions[third * 3 + 1], positions[third * 3 + 2]];
    volume += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
  }
  return volume;
}

/** Area-weighted mean deviation of the UV-to-surface area ratio from its median; 0 means even texel density. */
function uvStretch({ positions, indices, uvs }) {
  const samples = [];
  for (let triangle = 0; triangle < indices.length; triangle += 3) {
    const [first, second, third] = [indices[triangle], indices[triangle + 1], indices[triangle + 2]];
    const area = triangleArea(positions, first, second, third);
    if (area < 1e-12) continue;
    const uvArea = Math.abs((uvs[second * 2] - uvs[first * 2]) * (uvs[third * 2 + 1] - uvs[first * 2 + 1])
      - (uvs[second * 2 + 1] - uvs[first * 2 + 1]) * (uvs[third * 2] - uvs[first * 2])) / 2;
    samples.push({ ratio: uvArea / area, area });
  }
  if (!samples.length) return 0;
  const sorted = samples.map(sample => sample.ratio).sort((left, right) => left - right);
  const median = sorted[Math.floor(sorted.length / 2)];
  if (median === 0) return Infinity;
  let deviation = 0;
  let totalArea = 0;
  for (const sample of samples) {
    deviation += Math.abs(sample.ratio / median - 1) * sample.area;
    totalArea += sample.area;
  }
  return deviation / totalArea;
}

/** Closed loops where the plane `axis = at` cuts the triangles of all parts. */
export function sectionLoops(geometries, axis, at) {
  const axisIndex = { x: 0, y: 1, z: 2 }[axis];
  const keyOf = point => point.map(value => Math.round(value / WELD_DISTANCE)).join(',');
  const parent = new Map();
  const find = key => {
    while (parent.get(key) !== key) {
      parent.set(key, parent.get(parent.get(key)));
      key = parent.get(key);
    }
    return key;
  };
  const union = (first, second) => {
    for (const key of [first, second]) if (!parent.has(key)) parent.set(key, key);
    parent.set(find(first), find(second));
  };
  for (const { positions, indices } of geometries) {
    for (let triangle = 0; triangle < indices.length; triangle += 3) {
      const corners = [indices[triangle], indices[triangle + 1], indices[triangle + 2]].map(vertex => [positions[vertex * 3], positions[vertex * 3 + 1], positions[vertex * 3 + 2]]);
      const crossings = [];
      for (let side = 0; side < 3; side++) {
        const start = corners[side];
        const end = corners[(side + 1) % 3];
        const startOffset = start[axisIndex] - at;
        const endOffset = end[axisIndex] - at;
        if ((startOffset < 0) === (endOffset < 0)) continue;
        const fraction = startOffset / (startOffset - endOffset);
        crossings.push(start.map((value, component) => value + (end[component] - value) * fraction));
      }
      if (crossings.length === 2) union(keyOf(crossings[0]), keyOf(crossings[1]));
    }
  }
  const roots = new Set();
  for (const key of parent.keys()) roots.add(find(key));
  return roots.size;
}

/**
 * Count separate outer tips around the thinnest axis (gear teeth, star points). Vertices near the outer radius are
 * joined when a triangle edge runs between them along the rim, so a wide flat tooth tip still counts once.
 */
export function countTips(geometries, bounds) {
  const extents = [0, 1, 2].map(axis => bounds.max[axis] - bounds.min[axis]);
  const thinAxis = extents.indexOf(Math.min(...extents));
  const [firstAxis, secondAxis] = [0, 1, 2].filter(axis => axis !== thinAxis);
  const center = [0, 1, 2].map(axis => (bounds.max[axis] + bounds.min[axis]) / 2);
  const radiusAt = (first, second) => Math.hypot(first - center[firstAxis], second - center[secondAxis]);
  let outerRadius = 0;
  for (const { positions } of geometries) {
    for (let vertex = 0; vertex < positions.length / 3; vertex++) {
      outerRadius = Math.max(outerRadius, radiusAt(positions[vertex * 3 + firstAxis], positions[vertex * 3 + secondAxis]));
    }
  }
  const tipRadius = outerRadius * 0.97;
  const parent = new Map();
  const find = key => {
    while (parent.get(key) !== key) {
      parent.set(key, parent.get(parent.get(key)));
      key = parent.get(key);
    }
    return key;
  };
  const add = key => {
    if (!parent.has(key)) parent.set(key, key);
  };
  for (const { positions, indices } of geometries) {
    const planeKey = vertex => `${Math.round(positions[vertex * 3 + firstAxis] / WELD_DISTANCE)},${Math.round(positions[vertex * 3 + secondAxis] / WELD_DISTANCE)}`;
    const radiusOf = vertex => radiusAt(positions[vertex * 3 + firstAxis], positions[vertex * 3 + secondAxis]);
    for (let triangle = 0; triangle < indices.length; triangle += 3) {
      for (let side = 0; side < 3; side++) {
        const start = indices[triangle + side];
        const end = indices[triangle + (side + 1) % 3];
        const startIsTip = radiusOf(start) > tipRadius;
        const endIsTip = radiusOf(end) > tipRadius;
        if (startIsTip) add(planeKey(start));
        if (endIsTip) add(planeKey(end));
        if (!startIsTip || !endIsTip) continue;
        const middleFirst = (positions[start * 3 + firstAxis] + positions[end * 3 + firstAxis]) / 2;
        const middleSecond = (positions[start * 3 + secondAxis] + positions[end * 3 + secondAxis]) / 2;
        if (radiusAt(middleFirst, middleSecond) > tipRadius) parent.set(find(planeKey(start)), find(planeKey(end)));
      }
    }
  }
  const roots = new Set();
  for (const key of parent.keys()) roots.add(find(key));
  return roots.size;
}

/** Number of triangles a line along `axis` crosses at the given coordinates of the other two axes, in axis order. */
// Height of the surface under (x, z): the first triangle that covers the point from above, or null over a hole.
function surfaceHeightAt({ positions, indices }, pointX, pointZ) {
  for (let triangle = 0; triangle < indices.length; triangle += 3) {
    const [first, second, third] = [indices[triangle], indices[triangle + 1], indices[triangle + 2]].map(vertex => [positions[vertex * 3], positions[vertex * 3 + 1], positions[vertex * 3 + 2]]);
    const determinant = (second[2] - third[2]) * (first[0] - third[0]) + (third[0] - second[0]) * (first[2] - third[2]);
    if (determinant === 0) continue;
    const weightFirst = ((second[2] - third[2]) * (pointX - third[0]) + (third[0] - second[0]) * (pointZ - third[2])) / determinant;
    const weightSecond = ((third[2] - first[2]) * (pointX - third[0]) + (first[0] - third[0]) * (pointZ - third[2])) / determinant;
    const weightThird = 1 - weightFirst - weightSecond;
    if (weightFirst < -1e-9 || weightSecond < -1e-9 || weightThird < -1e-9) continue;
    return weightFirst * first[1] + weightSecond * second[1] + weightThird * third[1];
  }
  return null;
}

export function lineHits(geometries, axis, point) {
  const axisIndex = { x: 0, y: 1, z: 2 }[axis];
  const [firstAxis, secondAxis] = [0, 1, 2].filter(candidate => candidate !== axisIndex);
  let hits = 0;
  for (const { positions, indices } of geometries) {
    for (let triangle = 0; triangle < indices.length; triangle += 3) {
      const corners = [indices[triangle], indices[triangle + 1], indices[triangle + 2]].map(vertex => [positions[vertex * 3 + firstAxis] - point[0], positions[vertex * 3 + secondAxis] - point[1]]);
      const sides = corners.map((corner, index) => {
        const next = corners[(index + 1) % 3];
        return corner[0] * next[1] - corner[1] * next[0];
      });
      if (sides.every(side => side > 0) || sides.every(side => side < 0)) hits++;
    }
  }
  return hits;
}

async function loadFixtureRobot() {
  const bytes = await readFile(new URL('../../tests/fixtures/RobotExpressive.glb', import.meta.url));
  return parseGltf(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), { maxVertices: 500000 });
}

const LAYER_SAMPLE_TIMES = [0.15, 0.55];

function matricesByPartName(scene, asset) {
  return Object.fromEntries(asset.parts.map((part, index) => [part.name, Array.from(scene.parts[index].matrix)]));
}

/**
 * Pose matrices of every part at fixed times, for the recipe and for each of its layers' clips played alone, so a check can
 * tell which clip each part follows. Null when the recipe has no motion layers.
 */
async function measureLayerPose(recipe, asset) {
  const layers = recipe.motion?.layers;
  if (!layers?.length) return null;
  const clipNames = layers.map(layer => asset.animations[layer.clip]?.name);
  const duration = recipe.motion.duration;
  const poseAt = async motion => {
    const robot = await loadFixtureRobot();
    const scene = createAgentAssetScene(robot, { ...recipe, animation: null, motion });
    return LAYER_SAMPLE_TIMES.map(time => {
      scene.sampleMotion(time);
      return matricesByPartName(scene, robot);
    });
  };
  const alone = {};
  for (const [position, layer] of layers.entries()) {
    // The layer keeps its own speed, offset and loop, so a clip played at another rate is still compared with itself.
    const { mask, ...unmasked } = layer;
    alone[clipNames[position]] = await poseAt({ duration, loop: recipe.motion.loop, layers: [{ ...unmasked, morph: false }] });
  }
  return { clipNames, times: LAYER_SAMPLE_TIMES, combined: await poseAt(recipe.motion), alone };
}

/** Reload an exported recipe for the fixture robot and read which clip and which IK solvers it ended with. */
/** Topology of every imported part the recipe edits: genus, closure, lint, and the volume left after the edits. */
function measureEditedParts(scene, asset, recipe) {
  const labels = new Map(scene.inspect({ limit: 256 }).nodes.map(node => [node.id, node.label]));
  return (recipe.meshEdits ?? []).map(entry => {
    const index = Number(entry.id.slice(5));
    const report = scene.inspectMeshes({ geometries: [entry.id] }).meshes[0];
    const eulerCharacteristic = report.counts.vertices - report.counts.edges + report.counts.faces;
    const originalVolume = signedVolume(asset.parts[index].geometry);
    return {
      id: entry.id, label: labels.get(entry.id), lintOk: report.ok, closedParts: report.parts.closed, partCount: report.parts.count,
      genus: (2 * report.parts.count - eulerCharacteristic) / 2,
      volumeRatio: signedVolume(scene.parts[index].geometry) / originalVolume,
    };
  });
}

export async function measureAssetRecipe(recipe) {
  if (recipe.meshEdits || recipe.physics) {
    await loadAllAgentSceneModules();
  }
  if (recipe.meshEdits) {
    await loadMeshBooleans();
  }
  if (needsPhysics(recipe)) {
    await loadPhysicsEngine();
  }
  const asset = await loadFixtureRobot();
  const scene = createAgentAssetScene(asset, recipe);
  const layerPose = await measureLayerPose(recipe, await loadFixtureRobot());
  const labels = new Map(asset.nodes.map(node => [node.id, node.label]));
  const reports = scene.inspect({ kind: 'hierarchy', limit: 1 }).motionIk ?? [];
  const solvers = recipe.motion?.ik ?? [];
  const endpoints = target => {
    if (Array.isArray(target)) return [target, target];
    const keyframes = target?.keyframes;
    return keyframes ? [keyframes[0].value, keyframes[keyframes.length - 1].value] : [null, null];
  };
  return {
    clipName: recipe.animation ? asset.animations[recipe.animation.clip]?.name : null,
    layerPose,
    ragdoll: recipe.physics?.ragdoll ? { startHeight: recipe.root?.translation?.[1] ?? 0, floor: recipe.physics.floor ?? 0, duration: recipe.physics.duration, ...scene.inspect({}).physics.ragdoll } : null,
    editedParts: measureEditedParts(scene, asset, recipe),
    camera: recipe.camera ?? null,
    reachSolvers: solvers.filter(solver => solver.type === 'two-bone').map(solver => {
      const [firstTarget, lastTarget] = endpoints(solver.target);
      const report = reports[solvers.indexOf(solver)];
      return { endLabel: labels.get(solver.end), firstTarget, lastTarget, reached: report?.reached ?? false, worstError: report?.worstError ?? null };
    }),
  };
}

// Seeking away and back must give the same matrices, whatever the solver did in between.
function seekIsStable(scene, duration) {
  const snapshot = () => scene.parts.map(part => Array.from(part.matrix));
  scene.sampleMotion(duration / 2);
  const first = snapshot();
  scene.sampleMotion(duration);
  scene.sampleMotion(0);
  scene.sampleMotion(duration / 2);
  const second = snapshot();
  scene.sampleMotion(null);
  return JSON.stringify(first) === JSON.stringify(second);
}

const RIG_SAMPLES = 8;

function skinnedDiagonal(part) {
  const { positions, skinIndices, skinWeights } = part.geometry;
  const palette = part.skin.jointMatrices;
  const minimum = [Infinity, Infinity, Infinity];
  const maximum = [-Infinity, -Infinity, -Infinity];
  for (let vertex = 0; vertex < positions.length / 3; vertex++) {
    const blended = [0, 0, 0];
    for (let influence = 0; influence < 4; influence++) {
      const weight = skinWeights[vertex * 4 + influence];
      if (weight === 0) continue;
      const moved = transformPoint(palette.subarray(skinIndices[vertex * 4 + influence] * 16), positions[vertex * 3], positions[vertex * 3 + 1], positions[vertex * 3 + 2]);
      for (let axis = 0; axis < 3; axis++) blended[axis] += moved[axis] * weight;
    }
    const world = transformPoint(part.matrix, ...blended);
    for (let axis = 0; axis < 3; axis++) {
      minimum[axis] = Math.min(minimum[axis], world[axis]);
      maximum[axis] = Math.max(maximum[axis], world[axis]);
    }
  }
  return Math.hypot(...maximum.map((value, axis) => value - minimum[axis]));
}

/** Bones, skinning, and the walk sampled at even times: joint world positions and each skinned part's deformed size. */
function measureRig(scene, duration) {
  const recipe = scene.exportRecipe();
  const inspected = scene.inspect({}).rig;
  const meshNodes = recipe.nodes.filter(node => node.geometry);
  const skinnedParts = () => scene.parts.filter(part => part.skin);
  const samples = Array.from({ length: duration > 0 ? RIG_SAMPLES : 0 }, (_, step) => {
    const time = duration * step / RIG_SAMPLES;
    scene.sampleMotion(time);
    const skin = skinnedParts()[0]?.skin;
    const joints = Object.fromEntries((skin?.joints ?? []).map((joint, index) => [joint.name, Array.from(skin.jointWorldMatrices.subarray(index * 16 + 12, index * 16 + 15))]));
    return { time, joints, diagonals: Object.fromEntries(skinnedParts().map(part => [part.name, skinnedDiagonal(part)])) };
  });
  scene.sampleMotion(null);
  const restDiagonals = Object.fromEntries(skinnedParts().map(part => [part.name, skinnedDiagonal(part)]));
  return {
    bones: recipe.armatures.flatMap(armature => armature.bones.map(bone => `${armature.prefix}${bone.name}`)),
    meshNodes: meshNodes.length, skinnedNodes: meshNodes.filter(node => node.skin).length,
    unweightedVertices: inspected.reduce((total, armature) => total + armature.skinned.reduce((sum, skinned) => sum + skinned.unweightedVertices, 0), 0),
    problems: inspected.flatMap(armature => armature.jointAxisProblems),
    samples, restDiagonals,
  };
}

/** Load the recipe and measure what it builds. Throws if the recipe itself is invalid. */
export async function measureRecipe(recipe) {
  await loadAllAgentSceneModules();
  if (needsMeshBooleans(recipe)) await loadMeshBooleans();
  if (needsPhysics(recipe)) await loadPhysicsEngine();
  const scene = createAgentScene(recipe);
  const physics = scene.inspect({}).physics;
  const physicsSeekStable = physics ? seekIsStable(scene, recipe.physics.duration) : null;
  const geometries = scene.parts.map(worldGeometry);
  const reports = new Map();
  const reportOf = id => {
    if (!reports.has(id)) reports.set(id, scene.inspectMeshes({ geometries: [id] }).meshes[0]);
    return reports.get(id);
  };
  const usedGeometries = scene.exportRecipe().nodes.filter(node => node.geometry).map(node => node.geometry);
  const bounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  let parts = 0;
  let closedParts = 0;
  let eulerCharacteristic = 0;
  let volume = 0;
  let triangles = 0;
  let lintProblems = 0;
  const problemKinds = new Set();
  let uvParts = 0;
  let worstUvStretch = 0;
  let topologyScoreSum = 0;
  const valence = { regular: 0, poles3: 0, poles5: 0, poles6Plus: 0 };
  const quadQuality = { meanAngleError: 0, maxAngleError: 0, maxAspect: 1, maxWarp: 0 };
  for (const geometry of geometries) {
    for (let vertex = 0; vertex < geometry.positions.length / 3; vertex++) {
      for (let axis = 0; axis < 3; axis++) {
        bounds.min[axis] = Math.min(bounds.min[axis], geometry.positions[vertex * 3 + axis]);
        bounds.max[axis] = Math.max(bounds.max[axis], geometry.positions[vertex * 3 + axis]);
      }
    }
    volume += signedVolume(geometry);
    triangles += geometry.indices.length / 3;
    if (geometry.uvs) {
      uvParts++;
      worstUvStretch = Math.max(worstUvStretch, uvStretch(geometry));
    }
  }
  for (const id of usedGeometries) {
    const report = reportOf(id);
    parts += report.parts.count;
    closedParts += report.parts.closed;
    eulerCharacteristic += report.counts.vertices - report.counts.edges + report.counts.faces;
    topologyScoreSum += report.topologyScore;
    valence.regular += report.valence.regular;
    valence.poles3 += report.valence.poles3;
    valence.poles5 += report.valence.poles5;
    valence.poles6Plus += report.valence.poles6Plus;
    quadQuality.meanAngleError += report.quadQuality.meanAngleError;
    quadQuality.maxAngleError = Math.max(quadQuality.maxAngleError, report.quadQuality.maxAngleError);
    quadQuality.maxAspect = Math.max(quadQuality.maxAspect, report.quadQuality.maxAspect);
    quadQuality.maxWarp = Math.max(quadQuality.maxWarp, report.quadQuality.maxWarp);
    // Spatial warnings are advice, not pass or fail: a mug handle is meant to break symmetry.
    const gradedProblems = report.problems.filter(problem => !(problem.kind in GEOMETRY_PROBLEMS));
    for (const problem of gradedProblems) problemKinds.add(problem.kind);
    lintProblems += gradedProblems.length;
  }
  if (usedGeometries.length > 0) {
    quadQuality.meanAngleError = Math.round(quadQuality.meanAngleError / usedGeometries.length * 1e4) / 1e4;
  }
  const topologyScore = usedGeometries.length > 0 ? Math.round(topologyScoreSum / usedGeometries.length * 1e4) / 1e4 : 0;
  const allClosed = closedParts === parts;
  return {
    nodes: geometries.length,
    physics,
    physicsSeekStable,
    spotLights: recipe.environment?.spotLights ?? [],
    rig: recipe.armatures ? measureRig(scene, recipe.motion?.duration ?? 0) : null,
    patternTypes: scene.exportRecipe().materials.filter(material => material.pattern).map(material => material.pattern.type),
    patternMappings: scene.exportRecipe().materials.filter(material => material.pattern).map(material => material.pattern.mapping ?? 'box'),
    parts,
    closedParts,
    holes: allClosed ? (2 * parts - eulerCharacteristic) / 2 : null,
    volume,
    triangles,
    bounds,
    size: [0, 1, 2].map(axis => bounds.max[axis] - bounds.min[axis]),
    lintProblems,
    problemKinds: [...problemKinds],
    valence,
    quadQuality,
    topologyScore,
    uv: { parts: uvParts, of: geometries.length, stretch: worstUvStretch },
    tips: countTips(geometries, bounds),
    section: (axis, at) => sectionLoops(geometries, axis, at),
    nodePosition(name, time) {
      scene.sampleMotion(time);
      const part = scene.parts.find(candidate => candidate.name === name);
      return part ? [part.matrix[12], part.matrix[13], part.matrix[14]] : null;
    },
    surfaceHeight(name, pointX, pointZ) {
      const part = scene.parts.find(candidate => candidate.name === name);
      return part ? surfaceHeightAt(worldGeometry(part), pointX, pointZ) : null;
    },
    nodePositions(name) {
      const part = scene.parts.find(candidate => candidate.name === name);
      return part ? worldGeometry(part).positions : null;
    },
    nodeBounds(name) {
      const part = scene.parts.find(candidate => candidate.name === name);
      return part ? boundsOfPositions(worldGeometry(part).positions) : null;
    },
    lineHits: (axis, point) => lineHits(geometries, axis, point),
  };
}
