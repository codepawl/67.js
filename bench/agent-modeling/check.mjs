// Grades an exported recipe against a task's checks. CLI: node bench/agent-modeling/check.mjs <task-id> <recipe.json>
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { measureAssetRecipe, measureRecipe } from './measure.mjs';
import { taskById } from './tasks.mjs';
import { checkSceneState, isSceneCheck } from './scene-checks.mjs';
import { REQUIRED_HUMANOID_BONES } from '../../src/retarget.js';

const AXES = { x: 0, y: 1, z: 2 };
const SIZE_TOLERANCE = 0.03;
const SIZE_FLOOR = 0.003;
const TOUCH_TOLERANCE = 0.003;
const GROUND_TOLERANCE = 0.005;

const round = value => Number(value.toPrecision(4));

const forwardOf = point => point[2];

// A walk moves both feet far, in opposite phase, bends knees forward and elbows back, and no limb part collapses or stretches.
function checkWalk(rig, check) {
  if (!rig?.samples.length) return { pass: false, detail: 'no armature or no motion' };
  const problems = [];
  for (const foot of ['leftFoot', 'rightFoot']) {
    const travel = rig.samples.map(sample => forwardOf(sample.joints[foot] ?? [0, 0, 0]));
    if (Math.max(...travel) - Math.min(...travel) < check.footTravel) problems.push(`${foot} moves ${round(Math.max(...travel) - Math.min(...travel))} m`);
  }
  const first = rig.samples[0];
  const half = rig.samples[rig.samples.length / 2];
  if (!first.joints.leftFoot || !half.joints.leftFoot || (forwardOf(first.joints.leftFoot) - forwardOf(first.joints.rightFoot)) * (forwardOf(half.joints.leftFoot) - forwardOf(half.joints.rightFoot)) >= 0) problems.push('the feet do not alternate');
  const bends = [['LowerLeg', 'UpperLeg', 'Foot', 1], ['LowerArm', 'UpperArm', 'Hand', -1]];
  for (const sample of rig.samples) {
    for (const side of ['left', 'right']) {
      for (const [middle, root, end, direction] of bends) {
        const [rootZ, middleZ, endZ] = [root, middle, end].map(name => forwardOf(sample.joints[`${side}${name}`] ?? [0, 0, 0]));
        if ((middleZ - (rootZ + endZ) / 2) * direction < -0.005) problems.push(`${side}${middle} bends the wrong way at t=${round(sample.time)}`);
      }
    }
  }
  for (const sample of rig.samples) {
    for (const [name, diagonal] of Object.entries(sample.diagonals)) {
      const ratio = diagonal / rig.restDiagonals[name];
      if (ratio < 0.7 || ratio > 1.4) problems.push(`${name} is ${round(ratio)}x its size at t=${round(sample.time)}`);
    }
  }
  return { pass: problems.length === 0, detail: [...new Set(problems)].slice(0, 4).join('; ') || `${rig.samples.length} samples: feet alternate, knees forward, elbows back, parts keep their size` };
}

const WALK_SAMPLES = 41;

// A walker leaves one point to reach another, stays on the ground surface and keeps clear of a round opening.
/** A node moves along one axis from a start to a target, passes the target and peaks within a range, then settles on it. */
function checkOvershoot(check, measures) {
  const axis = AXES[check.axis];
  const heights = [];
  for (let sample = 0; sample < WALK_SAMPLES; sample++) {
    const position = measures.nodePosition(check.node, check.duration * sample / (WALK_SAMPLES - 1));
    if (!position) return { pass: false, detail: `no drawn node ${check.node}` };
    heights.push(position[axis]);
  }
  const peak = Math.max(...heights);
  const problems = [];
  if (Math.abs(heights[0] - check.from) > 0.02) problems.push(`starts at ${round(heights[0])}`);
  if (Math.abs(heights.at(-1) - check.to) > 0.02) problems.push(`ends at ${round(heights.at(-1))}`);
  if (peak < check.peak[0] || peak > check.peak[1]) problems.push(`peaks at ${round(peak)}`);
  const peakIndex = heights.indexOf(peak);
  if (peakIndex >= heights.length - 2) problems.push('never settles back from its peak');
  return { pass: problems.length === 0, detail: problems.join('; ') || `peaks at ${round(peak)}, settles on ${check.to}` };
}

function checkWalkPath(check, measures) {
  const problems = [];
  const planarDistance = (position, target) => Math.hypot(position[0] - target[0], position[2] - target[1]);
  for (let sample = 0; sample < WALK_SAMPLES; sample++) {
    const time = check.duration * sample / (WALK_SAMPLES - 1);
    const position = measures.nodePosition(check.node, time);
    if (!position) return { pass: false, detail: `no drawn node ${check.node}` };
    if (sample === 0 && planarDistance(position, check.from) > 0.75) problems.push(`starts ${round(planarDistance(position, check.from))} m from the start point`);
    if (sample === WALK_SAMPLES - 1 && planarDistance(position, check.to) > 0.75) problems.push(`ends ${round(planarDistance(position, check.to))} m from the end point`);
    for (const opening of [].concat(check.avoid)) {
      const fromOpening = planarDistance(position, opening.center) - opening.radius;
      if (fromOpening < check.margin) problems.push(`${round(fromOpening)} m from the opening edge at t=${round(time)}`);
    }
    for (const nodeName of check.avoidNodes ?? []) {
      const bounds = measures.nodeBounds(nodeName);
      if (!bounds) return { pass: false, detail: `no drawn node ${nodeName}` };
      const outsideX = Math.max(bounds.min[0] - position[0], 0, position[0] - bounds.max[0]);
      const outsideZ = Math.max(bounds.min[2] - position[2], 0, position[2] - bounds.max[2]);
      const fromNode = Math.hypot(outsideX, outsideZ);
      if (fromNode < check.margin) problems.push(`${round(fromNode)} m from ${nodeName} at t=${round(time)}`);
    }
    const groundHeight = measures.surfaceHeight(check.ground, position[0], position[2]);
    if (groundHeight === null) problems.push(`no ground under it at t=${round(time)}`);
    else if (Math.abs(position[1] - groundHeight) > check.heightTolerance) problems.push(`${round(position[1] - groundHeight)} m off the ground at t=${round(time)}`);
  }
  return { pass: problems.length === 0, detail: [...new Set(problems)].slice(0, 3).join('; ') || `${WALK_SAMPLES} samples around the opening, on the ground` };
}

/** Every vertex of a node lies between two distances of a point, and the node spreads over a minimum extent. */
function checkShell(check, measures) {
  const positions = measures.nodePositions(check.node);
  if (!positions) return { pass: false, detail: `no drawn node ${check.node}` };
  const low = [Infinity, Infinity, Infinity];
  const high = [-Infinity, -Infinity, -Infinity];
  let nearest = Infinity;
  let farthest = 0;
  for (let offset = 0; offset < positions.length; offset += 3) {
    const distance = Math.hypot(positions[offset] - check.centre[0], positions[offset + 1] - check.centre[1], positions[offset + 2] - check.centre[2]);
    nearest = Math.min(nearest, distance);
    farthest = Math.max(farthest, distance);
    for (let axis = 0; axis < 3; axis++) {
      low[axis] = Math.min(low[axis], positions[offset + axis]);
      high[axis] = Math.max(high[axis], positions[offset + axis]);
    }
  }
  const problems = [];
  if (nearest < check.min) problems.push(`a vertex is ${round(nearest)} m from the centre, under ${check.min}`);
  if (farthest > check.max) problems.push(`a vertex is ${round(farthest)} m from the centre, over ${check.max}`);
  check.spread.forEach((minimum, axis) => {
    if (high[axis] - low[axis] < minimum) problems.push(`${'xyz'[axis]} spreads ${round(high[axis] - low[axis])} m, under ${minimum}`);
  });
  return { pass: problems.length === 0, detail: problems.join('; ') || `${check.node} between ${round(nearest)} and ${round(farthest)} m of the centre` };
}

const PAINTING_SAMPLES_ACROSS = 41;
const PAINTING_SAMPLES_UP = 21;
const AIM_TOLERANCE = 0.05;
const POSITION_TOLERANCE = 0.05;

/** Whether the straight segment between two points passes through an axis-aligned box (slab test). */
function segmentHitsBox(from, to, boxMin, boxMax) {
  let enter = 0;
  let leave = 1;
  for (let axis = 0; axis < 3; axis++) {
    const travel = to[axis] - from[axis];
    if (Math.abs(travel) < 1e-9) {
      if (from[axis] < boxMin[axis] || from[axis] > boxMax[axis]) return false;
      continue;
    }
    const near = (boxMin[axis] - from[axis]) / travel;
    const far = (boxMax[axis] - from[axis]) / travel;
    enter = Math.max(enter, Math.min(near, far));
    leave = Math.min(leave, Math.max(near, far));
    if (enter > leave) return false;
  }
  return true;
}

const angleBetween = (first, second) => {
  const dot = first.reduce((total, value, axis) => total + value * second[axis], 0);
  return Math.acos(Math.min(1, dot / (Math.hypot(...first) * Math.hypot(...second))));
};

// The one spotlight must sit at an offered place, aim at the painting with a cone that reaches all of it and cast
// shadows. With `blocker` (one node) no ray from it to the front face of the painting may meet that node. With
// `blockers` (several nodes) and `least: true`, the share of painting points in shadow at the chosen place must be the
// smallest over all offered places, which only a render or a long trace tells.
function shadowedPoints(position, painting, blockerBounds) {
  const frontZ = painting.max[2];
  let shadowed = 0;
  let total = 0;
  for (let across = 0; across < PAINTING_SAMPLES_ACROSS; across++) {
    for (let up = 0; up < PAINTING_SAMPLES_UP; up++) {
      const point = [
        painting.min[0] + (painting.max[0] - painting.min[0]) * across / (PAINTING_SAMPLES_ACROSS - 1),
        painting.min[1] + (painting.max[1] - painting.min[1]) * up / (PAINTING_SAMPLES_UP - 1),
        frontZ,
      ];
      total++;
      if (blockerBounds.some(blocker => segmentHitsBox(position, point, blocker.min, blocker.max))) shadowed++;
    }
  }
  return { shadowed, total };
}

function checkLitPainting(check, measures) {
  const painting = measures.nodeBounds(check.painting);
  const blockerIds = check.blockers ?? [check.blocker];
  const blockerBounds = blockerIds.map(id => measures.nodeBounds(id));
  if (!painting || blockerBounds.some(bounds => !bounds)) return { pass: false, detail: `no drawn node ${check.painting} or ${blockerIds.join(', ')}` };
  const lights = measures.spotLights;
  if (lights.length !== 1) return { pass: false, detail: `${lights.length} spot lights, need exactly 1` };
  const [light] = lights;
  const placeIndex = check.positions.findIndex(place => Math.hypot(...place.map((value, axis) => value - light.position[axis])) <= POSITION_TOLERANCE);
  if (placeIndex < 0) return { pass: false, detail: `light at ${light.position.map(round).join(', ')} is not an offered place` };
  const frontZ = painting.max[2];
  const centre = [(painting.min[0] + painting.max[0]) / 2, (painting.min[1] + painting.max[1]) / 2, frontZ];
  const towardCentre = centre.map((value, axis) => value - light.position[axis]);
  const aimError = angleBetween(light.direction, towardCentre);
  const corners = [painting.min, painting.max].flatMap(low => [painting.min, painting.max].map(high => [low[0], high[1], frontZ]));
  const reach = Math.max(...corners.map(corner => angleBetween(towardCentre, corner.map((value, axis) => value - light.position[axis]))));
  const problems = [];
  if (aimError > AIM_TOLERANCE) problems.push(`aimed ${round(aimError)} rad off the centre`);
  if (light.angle < reach || light.angle > check.maxAngle) problems.push(`cone ${round(light.angle)} rad, needs ${round(reach)} to ${check.maxAngle}`);
  if (light.castShadow !== true) problems.push('shadows are off');
  const { shadowed, total } = shadowedPoints(light.position, painting, blockerBounds);
  if (check.least) {
    const shares = check.positions.map(place => shadowedPoints(place, painting, blockerBounds).shadowed);
    if (shadowed > Math.min(...shares)) problems.push(`place ${placeIndex + 1} shades ${shadowed} of ${total} points, place ${shares.indexOf(Math.min(...shares)) + 1} shades ${Math.min(...shares)}`);
  } else if (shadowed > 0) {
    problems.push(`${shadowed} of ${total} painting points are in shadow`);
  }
  return { pass: problems.length === 0, detail: problems.join('; ') || `place ${placeIndex + 1}, ${shadowed} of ${total} points in shadow` };
}

export function checkOne(check, measures) {
  switch (check.kind) {
    case 'lint':
      return { pass: measures.lintProblems === 0 && measures.closedParts === measures.parts, detail: measures.lintProblems ? measures.problemKinds.join(', ') : `${measures.closedParts}/${measures.parts} parts closed` };
    case 'parts':
      return { pass: measures.parts <= (check.max ?? Infinity) && measures.parts >= (check.min ?? 0), detail: `${measures.parts} parts` };
    case 'size': {
      const failures = [];
      check.expected.forEach((expected, axis) => {
        if (expected === null) return;
        const allowed = Math.max(expected * SIZE_TOLERANCE, SIZE_FLOOR);
        if (Math.abs(measures.size[axis] - expected) > allowed) failures.push(`${'xyz'[axis]} ${round(measures.size[axis])} vs ${expected}`);
      });
      return { pass: failures.length === 0, detail: failures.join('; ') || measures.size.map(round).join(' x ') };
    }
    case 'extent': {
      const values = check.axes.map(axis => measures.size[AXES[axis]]);
      return { pass: values.every(value => value >= check.min && value <= check.max), detail: values.map(round).join(', ') };
    }
    case 'ground': {
      const centreX = (measures.bounds.min[0] + measures.bounds.max[0]) / 2;
      const centreZ = (measures.bounds.min[2] + measures.bounds.max[2]) / 2;
      const footprint = Math.max(measures.size[0], measures.size[2]);
      // The mug's handle moves its bounds off centre, so that task checks only the ground.
      const centred = check.centred === false || Math.abs(centreX) <= Math.max(0.05 * footprint, SIZE_FLOOR) && Math.abs(centreZ) <= Math.max(0.05 * footprint, SIZE_FLOOR);
      return { pass: Math.abs(measures.bounds.min[1]) <= GROUND_TOLERANCE && centred, detail: `min y ${round(measures.bounds.min[1])}, centre ${round(centreX)}, ${round(centreZ)}` };
    }
    case 'holes':
      return { pass: measures.holes === check.equals, detail: measures.holes === null ? 'not closed' : `${measures.holes} through holes` };
    case 'volume':
      return { pass: measures.volume >= check.min && measures.volume <= check.max, detail: `${round(measures.volume)} m3` };
    case 'section': {
      const loops = measures.section(check.axis, check.at);
      return { pass: loops === check.equals, detail: `${loops} loops at ${check.axis} = ${check.at}` };
    }
    case 'through': {
      const blockedOpen = check.open.filter(point => measures.lineHits(check.axis, point) > 0);
      const missing = check.solid.filter(point => measures.lineHits(check.axis, point) === 0);
      const problems = [...blockedOpen.map(point => `blocked at ${point}`), ...missing.map(point => `missing at ${point}`)];
      return { pass: problems.length === 0, detail: problems.join('; ') || `${check.open.length} open, ${check.solid.length} solid along ${check.axis}` };
    }
    case 'pattern': {
      const found = measures.patternTypes.filter(type => check.types.includes(type));
      return { pass: found.length > 0, detail: measures.patternTypes.join(', ') || 'no material pattern' };
    }
    case 'uvPattern': {
      // A graph material that follows the geometry UVs, and every part that wears it has them.
      const followsUvs = measures.patternTypes.some((type, index) => type === 'graph' && measures.patternMappings[index] === 'uv');
      const everyPart = measures.uv.parts === measures.uv.of;
      return { pass: followsUvs && everyPart && measures.uv.stretch <= check.maxStretch, detail: followsUvs ? `graph on UVs, stretch ${round(measures.uv.stretch)}, ${measures.uv.parts}/${measures.uv.of} parts with UVs` : 'no graph material with mapping uv' };
    }
    case 'touches': {
      const node = measures.nodeBounds(check.node);
      const against = measures.nodeBounds(check.against);
      if (!node || !against) return { pass: false, detail: `no drawn node ${check.node} or ${check.against}` };
      const axis = AXES[check.side[1]];
      const gap = check.side[0] === '+' ? node.min[axis] - against.max[axis] : against.min[axis] - node.max[axis];
      const otherAxes = [0, 1, 2].filter(other => other !== axis);
      const overlaps = otherAxes.every(other => node.min[other] < against.max[other] && node.max[other] > against.min[other]);
      return { pass: Math.abs(gap) <= TOUCH_TOLERANCE && overlaps, detail: `${check.node} is ${round(gap)} m from ${check.against}${overlaps ? '' : ' and does not overlap it'}` };
    }
    case 'centreAt': {
      const bounds = measures.nodeBounds(check.node);
      if (!bounds) return { pass: false, detail: `no drawn node ${check.node}` };
      const centre = bounds.min.map((minimum, axis) => (minimum + bounds.max[axis]) / 2);
      const distance = Math.hypot(...centre.map((value, axis) => value - check.position[axis]));
      return { pass: distance <= 0.01, detail: `${check.node} centre is ${round(distance)} m from where it belongs` };
    }
    case 'nodeAt': {
      const position = measures.nodePosition(check.node, check.time);
      if (!position) return { pass: false, detail: `no drawn node ${check.node}` };
      const distance = Math.hypot(...position.map((value, axis) => value - check.position[axis]));
      return { pass: distance <= 0.01, detail: `${check.node} is ${round(distance)} m away at t=${check.time}` };
    }
    case 'nodeDistance': {
      const from = measures.nodePosition(check.from, check.time);
      const to = measures.nodePosition(check.to, check.time);
      if (!from || !to) return { pass: false, detail: `no drawn node ${check.from} or ${check.to}` };
      const distance = Math.hypot(...from.map((value, axis) => value - to[axis]));
      return { pass: Math.abs(distance - check.distance) <= 0.01, detail: `${round(distance)} m apart at t=${check.time}` };
    }
    case 'groundRelief': {
      const bounds = measures.nodeBounds(check.node);
      if (!bounds) return { pass: false, detail: `no drawn node ${check.node}` };
      const relief = bounds.max[1] - bounds.min[1];
      return { pass: relief >= check.min && relief <= check.max, detail: `${check.node} spans ${round(relief)} m in height` };
    }
    case 'overshoot':
      return checkOvershoot(check, measures);
    case 'walkPath':
      return checkWalkPath(check, measures);
    case 'renderedLook': {
      const look = measures.renderedLook;
      if (!look || look.drawError) return { pass: false, detail: `the recipe could not be drawn${look?.drawError ? `: ${look.drawError}` : ''}` };
      const [lowest, highest] = check.brightness;
      const problems = [];
      if (look.meanBrightness < lowest) problems.push('too dim');
      if (look.meanBrightness > highest) problems.push('too pale');
      if (look.clippedShare > check.maxClipped) problems.push('blown-out whites');
      if (look.crushedShare > check.maxCrushed) problems.push('crushed blacks');
      const numbers = `mean brightness ${round(look.meanBrightness)}, ${round(look.clippedShare * 100)}% clipped, ${round(look.crushedShare * 100)}% crushed`;
      return { pass: problems.length === 0, detail: problems.length ? `${numbers}: ${problems.join(', ')}` : numbers };
    }
    case 'litPainting':
      return checkLitPainting(check, measures);
    case 'shell':
      return checkShell(check, measures);
    case 'bendsToward': {
      const root = measures.nodePosition(check.from, check.time);
      const middle = measures.nodePosition(check.node, check.time);
      const end = measures.nodePosition(check.to, check.time);
      if (!root || !middle || !end) return { pass: false, detail: `no drawn node ${check.from}, ${check.node} or ${check.to}` };
      const offset = middle.map((value, axis) => value - (root[axis] + end[axis]) / 2);
      const along = offset.reduce((total, value, axis) => total + value * check.direction[axis], 0);
      return { pass: along >= check.minOffset, detail: `${check.node} sits ${round(along)} m toward ${JSON.stringify(check.direction)} at t=${check.time}` };
    }
    case 'assetHole': {
      const target = measures.editedParts.find(part => part.label === check.part);
      if (!target) return { pass: false, detail: `no mesh edits on the part ${check.part}; edited parts: ${measures.editedParts.map(part => part.label).join(', ') || 'none'}` };
      const others = measures.editedParts.filter(part => part !== target).map(part => part.label);
      const volumeKept = target.volumeRatio >= check.volumeKept[0] && target.volumeRatio <= check.volumeKept[1];
      const pass = target.genus === check.genus && target.closedParts === 1 && target.partCount === 1 && target.lintOk && volumeKept && others.length === 0;
      return { pass, detail: `${check.part}: genus ${target.genus}, ${target.partCount} part(s), lint ${target.lintOk}, ${round(target.volumeRatio)} of the volume kept, other edited parts ${others.join(', ') || 'none'}` };
    }
    case 'assetRagdoll': {
      const ragdoll = measures.ragdoll;
      if (!ragdoll) return { pass: false, detail: 'the recipe has no physics ragdoll' };
      const liftedAboveFloor = ragdoll.startHeight - ragdoll.floor >= check.minimumDrop;
      const lyingOnFloor = ragdoll.lowestY <= check.floorTolerance && ragdoll.highestY <= check.maximumHeight;
      return { pass: liftedAboveFloor && lyingOnFloor && ragdoll.duration >= check.minimumDuration,
        detail: `root ${ragdoll.startHeight} over floor ${ragdoll.floor}, ${ragdoll.duration} s, ends between y ${ragdoll.lowestY} and ${ragdoll.highestY}` };
    }
    case 'assetClip': {
      return { pass: measures.clipName === check.name, detail: `clip ${measures.clipName ?? 'none'}` };
    }
    case 'assetWalkAndWave': {
      const pose = measures.layerPose;
      if (!pose) return { pass: false, detail: 'no motion layers in the recipe' };
      const walking = pose.alone[check.walk];
      const waving = pose.alone[check.wave];
      if (!walking || !waving) return { pass: false, detail: `layers play ${pose.clipNames.join(', ')}; need ${check.walk} and ${check.wave}` };
      const distance = (first, second) => Math.max(...first.map((value, index) => Math.abs(value - second[index])));
      const legsFollowWalk = pose.combined.every((sample, time) => check.legs.every(part => distance(sample[part], walking[time][part]) < 1e-3));
      const legsMove = check.legs.every(part => distance(pose.combined[0][part], pose.combined[1][part]) > 0.1);
      const armLeavesWalk = pose.combined.some((sample, time) => distance(sample[check.arm], walking[time][check.arm]) > 1);
      const otherArmWalks = pose.combined.every((sample, time) => distance(sample[check.otherArm], walking[time][check.otherArm]) < 1e-3);
      return {
        pass: legsFollowWalk && legsMove && armLeavesWalk && otherArmWalks,
        detail: `legs follow ${check.walk} ${legsFollowWalk}, legs move ${legsMove}, ${check.arm} waves ${armLeavesWalk}, ${check.otherArm} keeps walking ${otherArmWalks}`,
      };
    }
    case 'assetReach': {
      const solver = measures.reachSolvers.find(candidate => candidate.endLabel === check.endLabel);
      if (!solver) return { pass: false, detail: `no two-bone solver ending at ${check.endLabel}` };
      const close = (first, second) => first && Math.hypot(first[0] - second[0], first[1] - second[1], first[2] - second[2]) <= 0.02;
      const onPath = close(solver.firstTarget, check.from) && close(solver.lastTarget, check.to);
      return { pass: onPath && solver.reached, detail: `targets ${JSON.stringify(solver.firstTarget)} to ${JSON.stringify(solver.lastTarget)}, reached ${solver.reached}, worst ${solver.worstError}` };
    }
    case 'shot': {
      const { camera } = measures;
      if (!camera) return { pass: false, detail: 'no camera in the recipe' };
      const offset = camera.eye.map((value, axis) => value - camera.target[axis]);
      const distance = Math.hypot(...offset);
      const sideOn = offset[0] >= check.minSideOffset && Math.abs(offset[2]) <= check.maxDepthOffset;
      const framed = camera.target[1] >= check.targetHeight[0] && camera.target[1] <= check.targetHeight[1] && distance >= check.distance[0] && distance <= check.distance[1];
      return { pass: sideOn && framed, detail: `eye offset ${offset.map(round).join(', ')}, target height ${round(camera.target[1])}` };
    }
    case 'rigBones': {
      const missing = REQUIRED_HUMANOID_BONES.filter(bone => !measures.rig?.bones.includes(bone));
      return { pass: Boolean(measures.rig) && missing.length === 0, detail: measures.rig ? (missing.length ? `missing bones ${missing.join(', ')}` : `${measures.rig.bones.length} bones, all humanoid bones present`) : 'no armature' };
    }
    case 'rigSkinned': {
      const rig = measures.rig;
      const problems = [];
      if (!rig) problems.push('no armature');
      else {
        if (rig.skinnedNodes !== rig.meshNodes) problems.push(`${rig.meshNodes - rig.skinnedNodes} of ${rig.meshNodes} mesh nodes have no skin`);
        if (rig.unweightedVertices > 0) problems.push(`${rig.unweightedVertices} unweighted vertices`);
      }
      return { pass: problems.length === 0, detail: problems.join('; ') || `${rig.skinnedNodes} mesh nodes skinned, no unweighted vertices` };
    }
    case 'rigWalk':
      return checkWalk(measures.rig, check);
    case 'physicsBody': {
      const body = measures.physics?.bodies.find(candidate => candidate.node === check.node);
      return { pass: body?.type === check.type && body?.shape === check.shape, detail: body ? `${body.node} is ${body.type} ${body.shape}` : `no physics body on ${check.node}` };
    }
    case 'physicsRest': {
      const problems = check.nodes.flatMap(node => {
        const body = measures.physics?.bodies.find(candidate => candidate.node === node);
        if (!body) return [`${node} has no physics body`];
        const [x, y, z] = body.finalPosition;
        const touching = measures.physics.contacts.some(contact => [contact.a, contact.b].includes(node) && [contact.a, contact.b].includes(check.touching) && contact.touchingAtEnd);
        const found = [];
        if (body.restsAtTime === null || body.restsAtTime === undefined) found.push(`${node} is still moving`);
        if (y < check.height[0] || y > check.height[1]) found.push(`${node} ends at height ${round(y)}`);
        if (Math.abs(x) > check.within || Math.abs(z) > check.within) found.push(`${node} ends outside the pocket at ${round(x)}, ${round(z)}`);
        if (!touching) found.push(`${node} does not touch ${check.touching}`);
        return found;
      });
      return { pass: problems.length === 0, detail: problems.join('; ') || `${check.nodes.length} balls at rest` };
    }
    case 'physicsSeek':
      return { pass: measures.physicsSeekStable === true, detail: measures.physicsSeekStable ? 'identical matrices' : 'no physics, or a seek back differs' };
    case 'tips':
      return { pass: measures.tips === check.equals, detail: `${measures.tips} tips` };
    case 'triangles':
      return { pass: measures.triangles >= check.min, detail: `${measures.triangles} triangles` };
    case 'uv': {
      const everyPart = measures.uv.parts === measures.uv.of;
      return { pass: everyPart && measures.uv.stretch <= check.maxStretch, detail: everyPart ? `stretch ${round(measures.uv.stretch)}` : `${measures.uv.parts}/${measures.uv.of} nodes have UVs` };
    }
    default:
      if (isSceneCheck(check.kind)) return checkSceneState(check, measures.recipe);
      throw new TypeError(`Unknown check kind ${check.kind}.`);
  }
}

/** What a recipe was built from, to see which tools agents actually reach for: geometry types and mesh operations. */
export function recipeFeatures(recipe) {
  const geometries = recipe.geometries ?? [];
  const operations = geometries.flatMap(geometry => [...(geometry.edits ?? []), ...(geometry.stack ?? [])].map(edit => edit.op));
  return {
    geometryTypes: [...new Set(geometries.map(geometry => geometry.type))],
    meshOperations: [...new Set(operations)],
    motionIk: (recipe.motion?.ik ?? []).map(solver => solver.type),
    motionTracks: recipe.motion?.tracks?.length ?? 0,
  };
}

/** Grade a recipe: { pass, passed, total, results: [{ kind, label, pass, detail }] }. An invalid recipe fails every check. */
export async function gradeRecipe(task, recipe) {
  let measures;
  try {
    measures = recipe.format === '67js.asset' ? await measureAssetRecipe(recipe) : await measureRecipe(recipe);
  } catch (error) {
    const results = task.checks.map(check => ({ kind: check.kind, label: check.label, pass: false, detail: `recipe failed: ${error.message}` }));
    return { pass: false, passed: 0, total: results.length, results };
  }
  if (task.checks.some(check => check.kind === 'renderedLook')) {
    const { measureRenderedLook } = await import('./look.mjs');
    // Keep the reason: a browser or page error must show in the check's detail, not read as a dim picture.
    measures.renderedLook = await measureRenderedLook(recipe).catch(error => ({ drawError: error.message }));
  }
  measures.recipe = recipe;
  const results = task.checks.map(check => ({ kind: check.kind, ...(check.label ? { label: check.label } : {}), ...checkOne(check, measures) }));
  const passed = results.filter(result => result.pass).length;
  return { pass: passed === results.length, passed, total: results.length, results };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [taskId, recipePath] = process.argv.slice(2);
  const grade = await gradeRecipe(taskById(taskId), JSON.parse(await readFile(recipePath, 'utf8')));
  console.log(JSON.stringify(grade, null, 2));
  process.exitCode = grade.pass ? 0 : 1;
}
