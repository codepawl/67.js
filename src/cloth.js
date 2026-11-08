// Position-based cloth (Muller et al., "Position Based Dynamics", 2007), recorded offline as frames.
// Constraints are solved in a fixed order with no random numbers, so the same input always gives the same frames,
// and playback is an interpolation between two recorded frames: a seek never runs the solver.

export const CLOTH_LIMITS = Object.freeze({
  maxParticles: 5000,
  maxFrameParticles: 3_000_000,
  // About 18 ns an operation measured on the dev machine, so the cap is a bake of roughly three seconds.
  maxWork: 1.5e8,
  substeps: 4,
  iterations: 8,
});

const AIR_DENSITY = 1.2;
const WELD_DIGITS = 5;
const GRAVITY_DEFAULT = Object.freeze([0, -9.81, 0]);

/** Unique particles of a triangle mesh: vertices at the same position share one, so a seam does not tear open. */
export function weldVertices(positions, indices) {
  const particleOfKey = new Map();
  const particleOfVertex = new Uint32Array(positions.length / 3);
  const representatives = [];
  for (let vertex = 0; vertex < particleOfVertex.length; vertex++) {
    const offset = vertex * 3;
    const key = `${positions[offset].toFixed(WELD_DIGITS)},${positions[offset + 1].toFixed(WELD_DIGITS)},${positions[offset + 2].toFixed(WELD_DIGITS)}`;
    let particle = particleOfKey.get(key);
    if (particle === undefined) {
      particle = representatives.length;
      particleOfKey.set(key, particle);
      representatives.push(vertex);
    }
    particleOfVertex[vertex] = particle;
  }
  const triangles = [];
  for (let corner = 0; corner < indices.length; corner += 3) {
    const first = particleOfVertex[indices[corner]];
    const second = particleOfVertex[indices[corner + 1]];
    const third = particleOfVertex[indices[corner + 2]];
    if (first !== second && second !== third && first !== third) {
      triangles.push(first, second, third);
    }
  }
  return { particleOfVertex, representatives, triangles: Uint32Array.from(triangles) };
}

function edgeKey(first, second, particleCount) {
  return first < second ? first * particleCount + second : second * particleCount + first;
}

// Stretch constraints along every edge, bend constraints between the far corners of two triangles sharing an edge.
function buildConstraints(positions, triangles, particleCount, bendStiffness, stretchStiffness) {
  const edgeNeighbours = new Map();
  for (let corner = 0; corner < triangles.length; corner += 3) {
    for (let side = 0; side < 3; side++) {
      const first = triangles[corner + side];
      const second = triangles[corner + (side + 1) % 3];
      const opposite = triangles[corner + (side + 2) % 3];
      const key = edgeKey(first, second, particleCount);
      const entry = edgeNeighbours.get(key) ?? { first: Math.min(first, second), second: Math.max(first, second), opposites: [] };
      entry.opposites.push(opposite);
      edgeNeighbours.set(key, entry);
    }
  }
  const firsts = [];
  const seconds = [];
  const stiffnesses = [];
  const add = (first, second, stiffness) => {
    firsts.push(first);
    seconds.push(second);
    stiffnesses.push(stiffness);
  };
  const orderedEntries = [...edgeNeighbours.entries()].sort((left, right) => left[0] - right[0]);
  for (const [, entry] of orderedEntries) {
    add(entry.first, entry.second, stretchStiffness);
  }
  const stretchCount = firsts.length;
  // The bend constraint across an edge, so tearing the edge can drop it too (-1 where the edge has none).
  const bendOfEdge = new Int32Array(stretchCount).fill(-1);
  if (bendStiffness > 0) {
    orderedEntries.forEach(([, entry], edge) => {
      if (entry.opposites.length === 2 && entry.opposites[0] !== entry.opposites[1]) {
        bendOfEdge[edge] = firsts.length;
        add(entry.opposites[0], entry.opposites[1], bendStiffness);
      }
    });
  }
  const restLengths = new Float64Array(firsts.length);
  for (let constraint = 0; constraint < firsts.length; constraint++) {
    const a = firsts[constraint] * 3;
    const b = seconds[constraint] * 3;
    restLengths[constraint] = Math.hypot(positions[a] - positions[b], positions[a + 1] - positions[b + 1], positions[a + 2] - positions[b + 2]);
  }
  return { count: firsts.length, stretchCount, bendOfEdge, firsts: Uint32Array.from(firsts), seconds: Uint32Array.from(seconds), stiffnesses: Float64Array.from(stiffnesses), restLengths };
}

// Rest area each particle represents (a third of its triangles), used to turn wind pressure into acceleration.
function particleAreas(positions, triangles, particleCount) {
  const areas = new Float64Array(particleCount);
  for (let corner = 0; corner < triangles.length; corner += 3) {
    const area = triangleNormal(positions, triangles[corner], triangles[corner + 1], triangles[corner + 2], [0, 0, 0]) / 2;
    for (let side = 0; side < 3; side++) {
      areas[triangles[corner + side]] += area / 3;
    }
  }
  return areas;
}

// Writes the unit normal into `normal` and returns twice the triangle area.
function triangleNormal(positions, first, second, third, normal) {
  const a = first * 3;
  const b = second * 3;
  const c = third * 3;
  const edgeOne = [positions[b] - positions[a], positions[b + 1] - positions[a + 1], positions[b + 2] - positions[a + 2]];
  const edgeTwo = [positions[c] - positions[a], positions[c + 1] - positions[a + 1], positions[c + 2] - positions[a + 2]];
  const x = edgeOne[1] * edgeTwo[2] - edgeOne[2] * edgeTwo[1];
  const y = edgeOne[2] * edgeTwo[0] - edgeOne[0] * edgeTwo[2];
  const z = edgeOne[0] * edgeTwo[1] - edgeOne[1] * edgeTwo[0];
  const length = Math.sqrt(x * x + y * y + z * z);
  if (length > 0) {
    normal[0] = x / length;
    normal[1] = y / length;
    normal[2] = z / length;
  }
  return length;
}

function applyWind(state, wind, areas, triangles, secondsPerSubstep, density) {
  const { positions, velocities, particleCount } = state;
  const pressures = state.windScratch;
  pressures.fill(0);
  const normal = [0, 0, 0];
  for (let corner = 0; corner < triangles.length; corner += 3) {
    const first = triangles[corner];
    const second = triangles[corner + 1];
    const third = triangles[corner + 2];
    const doubleArea = triangleNormal(positions, first, second, third, normal);
    if (doubleArea === 0) continue;
    let relative = 0;
    for (let axis = 0; axis < 3; axis++) {
      const velocity = (velocities[first * 3 + axis] + velocities[second * 3 + axis] + velocities[third * 3 + axis]) / 3;
      relative += (wind[axis] - velocity) * normal[axis];
    }
    const pressure = 0.5 * AIR_DENSITY * relative * Math.abs(relative);
    const force = pressure * doubleArea / 2 / 3;
    for (const particle of [first, second, third]) {
      for (let axis = 0; axis < 3; axis++) {
        pressures[particle * 3 + axis] += force * normal[axis];
      }
    }
  }
  for (let particle = 0; particle < particleCount; particle++) {
    const mass = Math.max(areas[particle], 1e-9) * density;
    for (let axis = 0; axis < 3; axis++) {
      velocities[particle * 3 + axis] += pressures[particle * 3 + axis] / mass * secondsPerSubstep;
    }
  }
}

// Also adds up what each constraint pushed (impulses, kg m per unit particle mass) and what a pinned particle was pulled
// with (pinImpulses), because a particle with no inverse mass takes no correction but still feels the pull.
function solveDistances(positions, inverseMasses, constraints, impulses, pinImpulses) {
  const { count, firsts, seconds, stiffnesses, restLengths } = constraints;
  for (let constraint = 0; constraint < count; constraint++) {
    if (stiffnesses[constraint] === 0) continue;
    const first = firsts[constraint];
    const second = seconds[constraint];
    const weightSum = inverseMasses[first] + inverseMasses[second];
    if (weightSum === 0) continue;
    const a = first * 3;
    const b = second * 3;
    const dx = positions[b] - positions[a];
    const dy = positions[b + 1] - positions[a + 1];
    const dz = positions[b + 2] - positions[a + 2];
    const length = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (length < 1e-12) continue;
    const impulse = stiffnesses[constraint] * (length - restLengths[constraint]) / weightSum;
    const correction = impulse / length;
    impulses[constraint] += impulse;
    if (inverseMasses[first] === 0) {
      pinImpulses[a] += dx * correction;
      pinImpulses[a + 1] += dy * correction;
      pinImpulses[a + 2] += dz * correction;
    }
    if (inverseMasses[second] === 0) {
      pinImpulses[b] -= dx * correction;
      pinImpulses[b + 1] -= dy * correction;
      pinImpulses[b + 2] -= dz * correction;
    }
    positions[a] += dx * correction * inverseMasses[first];
    positions[a + 1] += dy * correction * inverseMasses[first];
    positions[a + 2] += dz * correction * inverseMasses[first];
    positions[b] -= dx * correction * inverseMasses[second];
    positions[b + 1] -= dy * correction * inverseMasses[second];
    positions[b + 2] -= dz * correction * inverseMasses[second];
  }
}

// Each collider pushes a point to its surface plus `thickness` and reports the outward normal, or null when clear.
function pushOutOfBall(point, ball, thickness, normal) {
  const dx = point[0] - ball.center[0];
  const dy = point[1] - ball.center[1];
  const dz = point[2] - ball.center[2];
  const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const reach = ball.radius + thickness;
  if (distance >= reach) return false;
  if (distance > 1e-12) {
    normal[0] = dx / distance;
    normal[1] = dy / distance;
    normal[2] = dz / distance;
  } else {
    normal[0] = 0;
    normal[1] = 1;
    normal[2] = 0;
  }
  for (let axis = 0; axis < 3; axis++) {
    point[axis] = ball.center[axis] + normal[axis] * reach;
  }
  return true;
}

// A capsule is a ball whose centre slides to the closest point of its axis segment.
const capsuleBall = { center: [0, 0, 0], radius: 0 };

function pushOutOfCapsule(point, capsule, thickness, normal) {
  const { start, end } = capsule;
  const axisX = end[0] - start[0];
  const axisY = end[1] - start[1];
  const axisZ = end[2] - start[2];
  const lengthSquared = axisX * axisX + axisY * axisY + axisZ * axisZ;
  const along = (point[0] - start[0]) * axisX + (point[1] - start[1]) * axisY + (point[2] - start[2]) * axisZ;
  const fraction = lengthSquared > 0 ? Math.min(Math.max(along / lengthSquared, 0), 1) : 0;
  const centerX = start[0] + axisX * fraction;
  const centerY = start[1] + axisY * fraction;
  const centerZ = start[2] + axisZ * fraction;
  const reach = capsule.radius + thickness;
  const offsetX = point[0] - centerX;
  const offsetY = point[1] - centerY;
  const offsetZ = point[2] - centerZ;
  // Most particles are far from most capsules, so leave before the square root and the shared push.
  if (offsetX * offsetX + offsetY * offsetY + offsetZ * offsetZ >= reach * reach) return false;
  capsuleBall.center[0] = centerX;
  capsuleBall.center[1] = centerY;
  capsuleBall.center[2] = centerZ;
  capsuleBall.radius = capsule.radius;
  return pushOutOfBall(point, capsuleBall, thickness, normal);
}

function pushOutOfBox(point, box, thickness, normal) {
  const { center, axes, halfExtents } = box;
  const offset = [point[0] - center[0], point[1] - center[1], point[2] - center[2]];
  const local = axes.map(axis => offset[0] * axis[0] + offset[1] * axis[1] + offset[2] * axis[2]);
  const closest = local.map((value, index) => Math.min(Math.max(value, -halfExtents[index]), halfExtents[index]));
  const delta = local.map((value, index) => value - closest[index]);
  const distance = Math.hypot(...delta);
  const pushed = [...local];
  const localNormal = [0, 0, 0];
  if (distance > 1e-12) {
    if (distance >= thickness) return false;
    for (let index = 0; index < 3; index++) {
      localNormal[index] = delta[index] / distance;
      pushed[index] = closest[index] + localNormal[index] * thickness;
    }
  } else {
    let shallowest = 0;
    for (let index = 1; index < 3; index++) {
      if (halfExtents[index] - Math.abs(local[index]) < halfExtents[shallowest] - Math.abs(local[shallowest])) shallowest = index;
    }
    const sign = local[shallowest] >= 0 ? 1 : -1;
    localNormal[shallowest] = sign;
    pushed[shallowest] = sign * (halfExtents[shallowest] + thickness);
  }
  for (let axis = 0; axis < 3; axis++) {
    normal[axis] = 0;
    point[axis] = center[axis];
    for (let index = 0; index < 3; index++) {
      normal[axis] += axes[index][axis] * localNormal[index];
      point[axis] += axes[index][axis] * pushed[index];
    }
  }
  return true;
}

const PUSH_OUT = { ball: pushOutOfBall, capsule: pushOutOfCapsule, box: pushOutOfBox };

function collide(state, previous, colliders, thickness, friction) {
  const { positions, inverseMasses, particleCount } = state;
  const point = [0, 0, 0];
  const normal = [0, 0, 0];
  for (let particle = 0; particle < particleCount; particle++) {
    if (inverseMasses[particle] === 0) continue;
    const offset = particle * 3;
    point[0] = positions[offset];
    point[1] = positions[offset + 1];
    point[2] = positions[offset + 2];
    for (const collider of colliders) {
      const touched = PUSH_OUT[collider.kind](point, collider, thickness, normal);
      if (!touched) continue;
      // Friction removes part of the sideways travel this substep, so cloth drags over a surface instead of skating.
      const travel = [point[0] - previous[offset], point[1] - previous[offset + 1], point[2] - previous[offset + 2]];
      const along = travel[0] * normal[0] + travel[1] * normal[1] + travel[2] * normal[2];
      for (let axis = 0; axis < 3; axis++) {
        point[axis] -= (travel[axis] - along * normal[axis]) * friction;
      }
    }
    positions[offset] = point[0];
    positions[offset + 1] = point[1];
    positions[offset + 2] = point[2];
  }
}

const MOVING_COLLIDER_NUMBERS = 7;

function movingColliders(track, offset, count) {
  const colliders = [];
  for (let collider = 0; collider < count; collider++) {
    const base = offset + collider * MOVING_COLLIDER_NUMBERS;
    colliders.push({ kind: 'capsule', start: track.subarray(base, base + 3), end: track.subarray(base + 3, base + 6), radius: track[base + 6] });
  }
  return colliders;
}

// Pulls anchored particles toward where their node is now. A weight of 1 holds the particle on the target exactly.
function followAnchors(positions, moving, targets, softOnly) {
  const { anchorParticles, anchorWeights } = moving;
  for (let anchor = 0; anchor < anchorParticles.length; anchor++) {
    const weight = anchorWeights[anchor];
    if (softOnly && weight >= 1) continue;
    for (let axis = 0; axis < 3; axis++) {
      const index = anchorParticles[anchor] * 3 + axis;
      positions[index] += (targets[anchor * 3 + axis] - positions[index]) * weight;
    }
  }
}

function checkWork(particleCount, constraintCount, triangleCount, colliderCount, frameCount) {
  const work = frameCount * CLOTH_LIMITS.substeps * (CLOTH_LIMITS.iterations * constraintCount + triangleCount + particleCount * (colliderCount + 1));
  if (particleCount > CLOTH_LIMITS.maxParticles) {
    throw new RangeError(`Cloth has ${particleCount} particles; the limit is ${CLOTH_LIMITS.maxParticles}. Use a coarser grid.`);
  }
  if (particleCount * frameCount > CLOTH_LIMITS.maxFrameParticles) {
    throw new RangeError(`Cloth would record ${particleCount * frameCount} particle positions; the limit is ${CLOTH_LIMITS.maxFrameParticles}. Use a shorter duration or a coarser grid.`);
  }
  if (work > CLOTH_LIMITS.maxWork) {
    throw new RangeError(`Cloth needs ${Math.round(work)} solver operations; the limit is ${CLOTH_LIMITS.maxWork}. Use a shorter duration or a coarser grid.`);
  }
}

function setParticleInverseMass(cloth, particle) {
  const { inverseMasses, pinned, trackFixed, extraMasses, baseMass } = cloth;
  inverseMasses[particle] = pinned[particle] || trackFixed[particle] ? 0 : baseMass / (baseMass + extraMasses[particle]);
}

// Breaks a stretch constraint and the bend constraint across the same edge; both stop pulling at once.
function breakEdge(cloth, edge) {
  const { constraints, broken } = cloth;
  if (constraints.stiffnesses[edge] === 0) return;
  const bend = constraints.bendOfEdge[edge];
  for (const [constraint, kind] of [[edge, 'stretch'], [bend, 'bend']]) {
    if (constraint < 0 || constraints.stiffnesses[constraint] === 0) continue;
    constraints.stiffnesses[constraint] = 0;
    broken.push(Object.freeze({ constraint, first: constraints.firsts[constraint], second: constraints.seconds[constraint], kind }));
  }
}

function tearOverstretched(cloth, substepSeconds) {
  const { constraints, positions, tearStretch, tearForce, baseMass, impulses } = cloth;
  const { firsts, seconds, stiffnesses, restLengths, stretchCount } = constraints;
  const forceScale = baseMass / (substepSeconds * substepSeconds);
  for (let edge = 0; edge < stretchCount; edge++) {
    if (stiffnesses[edge] === 0) continue;
    const a = firsts[edge] * 3;
    const b = seconds[edge] * 3;
    const length = Math.hypot(positions[b] - positions[a], positions[b + 1] - positions[a + 1], positions[b + 2] - positions[a + 2]);
    if (length > restLengths[edge] * tearStretch || impulses[edge] * forceScale > tearForce) {
      breakEdge(cloth, edge);
    }
  }
}

/**
 * A sheet that steps one frame at a time, so pins, wind and colliders can change while it runs. It is the solver
 * `bakeCloth` records from: the same positions and options step to the same frames. Arguments and options are those of
 * `bakeCloth`, plus:
 * - tearStretch: a stretch constraint breaks when its length passes this multiple of its rest length (default never).
 * - tearForce: a stretch constraint breaks when the tension it carries passes this many newtons (default never).
 * Returns { positions, step(deltaSeconds, { wind, colliders }), pin(index, position), unpin(index), isPinned(index),
 * pinForce(index, out), setExtraMass(index, kilograms), breakConstraint(edge), broken, constraintCount, particleCount,
 * particleMass }. `positions` is a Float32Array of 3 numbers per particle, updated in place by every step.
 */
export function createCloth(positions, triangles, options = {}) {
  const particleCount = positions.length / 3;
  const colliders = options.colliders ?? [];
  const moving = options.moving ?? null;
  for (const collider of colliders) {
    if (!Object.hasOwn(PUSH_OUT, collider?.kind ?? '')) throw new TypeError(`Cloth collider kind must be one of ${Object.keys(PUSH_OUT).join(', ')}.`);
  }
  for (const particle of options.pinned ?? []) {
    if (!Number.isInteger(particle) || particle < 0 || particle >= particleCount) throw new RangeError(`Cloth pinned particle ${particle} does not exist; there are ${particleCount}.`);
  }
  const constraints = buildConstraints(positions, triangles, particleCount, options.bend ?? 0.1, options.stiffness ?? 0.9);
  checkWork(particleCount, constraints.count, triangles.length / 3, colliders.length + (moving?.colliderCount ?? 0), options.frameCount ?? 1);
  const density = options.density ?? 0.2;
  const areas = particleAreas(positions, triangles, particleCount);
  const totalArea = areas.reduce((sum, area) => sum + area, 0);
  const cloth = {
    constraints, baseMass: Math.max(totalArea * density / particleCount, 1e-9),
    inverseMasses: new Float64Array(particleCount).fill(1), extraMasses: new Float64Array(particleCount),
    pinned: new Uint8Array(particleCount), trackFixed: new Uint8Array(particleCount),
    pinTargets: Float64Array.from(positions), pinForces: new Float64Array(positions.length),
    impulses: new Float64Array(constraints.count), broken: [],
    positions: Float64Array.from(positions),
    tearStretch: options.tearStretch ?? Infinity, tearForce: options.tearForce ?? Infinity,
  };
  for (const particle of options.pinned ?? []) {
    cloth.pinned[particle] = 1;
  }
  moving?.anchorParticles.forEach((particle, anchor) => {
    if (moving.anchorWeights[anchor] >= 1) cloth.trackFixed[particle] = 1;
  });
  for (let particle = 0; particle < particleCount; particle++) {
    setParticleInverseMass(cloth, particle);
  }
  const state = {
    particleCount, inverseMasses: cloth.inverseMasses, positions: cloth.positions,
    velocities: new Float64Array(positions.length), windScratch: new Float64Array(positions.length),
  };
  const gravity = options.gravity ?? GRAVITY_DEFAULT;
  const damping = options.damping ?? 0.3;
  const friction = options.friction ?? 0.3;
  const thickness = options.thickness ?? 0.01;
  const previous = new Float64Array(positions.length);
  const stepStart = new Float64Array(positions.length);
  const pinImpulses = new Float64Array(positions.length);
  const publicPositions = Float32Array.from(positions);
  const anchorStride = (moving?.anchorParticles.length ?? 0) * 3;
  const colliderStride = (moving?.colliderCount ?? 0) * MOVING_COLLIDER_NUMBERS;
  let substepsDone = 0;

  function step(deltaSeconds, frame = {}) {
    const wind = frame.wind ?? options.wind ?? [0, 0, 0];
    const hasWind = wind.some(component => component !== 0);
    const stepColliders = frame.colliders ?? colliders;
    const substeps = CLOTH_LIMITS.substeps;
    const substepSeconds = deltaSeconds / substeps;
    const dampingFactor = Math.exp(-damping * substepSeconds);
    const tears = cloth.tearStretch !== Infinity || cloth.tearForce !== Infinity;
    const { inverseMasses, pinned, pinTargets } = cloth;
    stepStart.set(state.positions);
    pinImpulses.fill(0);
    for (let substep = 0; substep < substeps; substep++) {
      if (hasWind) applyWind(state, wind, areas, triangles, substepSeconds, density);
      options.applyFields?.(state.positions, state.velocities, substepsDone * substepSeconds, substepSeconds);
      previous.set(state.positions);
      let activeColliders = stepColliders;
      let anchorTargets = null;
      if (moving) {
        anchorTargets = moving.anchorTrack.subarray(substepsDone * anchorStride, (substepsDone + 1) * anchorStride);
        activeColliders = stepColliders.concat(movingColliders(moving.colliderTrack, substepsDone * colliderStride, moving.colliderCount));
        followAnchors(state.positions, moving, anchorTargets, false);
      }
      // A pin travels to its target in even strides, so a fast gripper drags the cloth instead of teleporting.
      const progress = (substep + 1) / substeps;
      for (let particle = 0; particle < particleCount; particle++) {
        if (pinned[particle]) {
          for (let axis = 0; axis < 3; axis++) {
            const index = particle * 3 + axis;
            state.positions[index] = stepStart[index] + (pinTargets[index] - stepStart[index]) * progress;
          }
        }
        if (inverseMasses[particle] === 0) continue;
        for (let axis = 0; axis < 3; axis++) {
          const index = particle * 3 + axis;
          state.velocities[index] += gravity[axis] * substepSeconds;
          state.positions[index] += state.velocities[index] * substepSeconds;
        }
      }
      for (let iteration = 0; iteration < CLOTH_LIMITS.iterations; iteration++) {
        solveDistances(state.positions, inverseMasses, constraints, cloth.impulses, pinImpulses);
        if (moving) followAnchors(state.positions, moving, anchorTargets, true);
        collide(state, previous, activeColliders, thickness, friction);
      }
      if (tears) tearOverstretched(cloth, substepSeconds);
      cloth.impulses.fill(0);
      for (let index = 0; index < positions.length; index++) {
        state.velocities[index] = (state.positions[index] - previous[index]) / substepSeconds * dampingFactor;
      }
      substepsDone++;
    }
    if (!state.positions.every(Number.isFinite)) {
      throw new RangeError('Cloth became unstable (non-finite positions). Lower the wind, raise density or use a finer grid.');
    }
    // An impulse (kg m) over a substep divided by the substep time is a force; average it over the substeps of this step.
    const forceScale = cloth.baseMass / (substeps * substepSeconds * substepSeconds);
    for (let index = 0; index < positions.length; index++) {
      cloth.pinForces[index] = pinImpulses[index] * forceScale;
    }
    publicPositions.set(state.positions);
  }

  function checkIndex(index) {
    if (!Number.isInteger(index) || index < 0 || index >= particleCount) {
      throw new RangeError(`Cloth particle ${index} does not exist; there are ${particleCount}.`);
    }
  }

  return {
    positions: publicPositions,
    particleCount,
    constraintCount: constraints.count,
    /** Mass of one particle in kilograms (density times area, shared evenly); `setExtraMass` adds to it. */
    particleMass: cloth.baseMass,
    /** Constraints that tore, in the order they broke: { constraint, first, second, kind: 'stretch' | 'bend' }. */
    broken: cloth.broken,
    step,
    /**
     * Hold a particle at `position` (default: where it is now). A pinned particle follows its target in even strides
     * over the next step, and the target can move again before every step.
     */
    pin(index, position) {
      checkIndex(index);
      const source = position ?? [state.positions[index * 3], state.positions[index * 3 + 1], state.positions[index * 3 + 2]];
      cloth.pinTargets[index * 3] = source[0];
      cloth.pinTargets[index * 3 + 1] = source[1];
      cloth.pinTargets[index * 3 + 2] = source[2];
      cloth.pinned[index] = 1;
      setParticleInverseMass(cloth, index);
    },
    /** Let go: the particle keeps the velocity it had and falls with the rest. */
    unpin(index) {
      checkIndex(index);
      cloth.pinned[index] = 0;
      setParticleInverseMass(cloth, index);
    },
    isPinned(index) {
      checkIndex(index);
      return cloth.pinned[index] === 1;
    },
    /**
     * The force the cloth pulls on a pinned particle with during the last step, in newtons, written to `out`
     * (x, y, z). Its length is the load the pin carries; a still sheet hung by its pins puts its weight on them.
     * It is an estimate from the constraint corrections of the solver, not a measurement.
     */
    pinForce(index, out = [0, 0, 0]) {
      checkIndex(index);
      out[0] = cloth.pinForces[index * 3];
      out[1] = cloth.pinForces[index * 3 + 1];
      out[2] = cloth.pinForces[index * 3 + 2];
      return out;
    },
    /** Hang `kilograms` on a particle on top of its own mass (0 removes it). */
    setExtraMass(index, kilograms) {
      checkIndex(index);
      cloth.extraMasses[index] = Math.max(kilograms, 0);
      setParticleInverseMass(cloth, index);
    },
    /** Tear one stretch constraint (and the bend across it) by hand; `constraint` counts from 0 over the edges. */
    breakConstraint(constraint) {
      if (!Number.isInteger(constraint) || constraint < 0 || constraint >= constraints.stretchCount) {
        throw new RangeError(`Cloth stretch constraint ${constraint} does not exist; there are ${constraints.stretchCount}.`);
      }
      breakEdge(cloth, constraint);
    },
  };
}

/**
 * Simulate one sheet. `positions` are world-space rest positions (3 numbers per particle), `triangles` index them.
 * Options: pinned (particle indices that stay put), gravity, wind (m/s), applyFields (see cloth-fields.js), stiffness and bend (0 to 1), density (kg/m2),
 * damping (1/s), friction (0 to 1), thickness (m), colliders ({ kind: 'ball', center, radius },
 * { kind: 'capsule', start, end, radius } or { kind: 'box', center, axes, halfExtents }), frameCount and framesPerSecond.
 * `moving` follows a body that moves with time, sampled ahead as plain numbers so it can cross to a worker. One entry per
 * substep (frame 1 substep 0 first): anchorTrack holds each anchor's target (3 numbers), colliderTrack each moving
 * collider as a capsule (start 3, end 3, radius 1; a ball has start equal to end). A particle in anchorParticles with
 * weight 1 sits on its target; a lower weight pulls it there by that fraction each iteration.
 * { anchorParticles, anchorWeights, anchorTrack, colliderCount, colliderTrack }
 * Returns the recorded frames: Float32Array of frameCount * particleCount * 3.
 */
export function bakeCloth(positions, triangles, options) {
  const cloth = createCloth(positions, triangles, options);
  const framesPerSecond = options.framesPerSecond ?? 60;
  const frames = new Float32Array(options.frameCount * positions.length);
  frames.set(Float32Array.from(positions), 0);
  for (let frame = 1; frame < options.frameCount; frame++) {
    cloth.step(1 / framesPerSecond);
    frames.set(cloth.positions, frame * positions.length);
  }
  return Object.freeze({ particleCount: cloth.particleCount, frameCount: options.frameCount, framesPerSecond, frames, constraintCount: cloth.constraintCount });
}

/** Write the particle positions at `time` into `target`, a linear blend of the two nearest recorded frames. */
export function sampleClothFrames(recording, time, target) {
  const stride = recording.particleCount * 3;
  const position = Math.min(Math.max(time * recording.framesPerSecond, 0), recording.frameCount - 1);
  const lower = Math.floor(position);
  const upper = Math.min(lower + 1, recording.frameCount - 1);
  const blend = position - lower;
  for (let index = 0; index < stride; index++) {
    const before = recording.frames[lower * stride + index];
    const after = recording.frames[upper * stride + index];
    target[index] = before + (after - before) * blend;
  }
  return target;
}
