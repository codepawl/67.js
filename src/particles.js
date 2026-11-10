// Stateless particles: every particle is a closed-form function of its own seeded launch values and the time.
// There is no stepping, so the state at time t never depends on which times were visited before. A seek backwards
// repeats exactly, and the same seed gives the same bytes. Force fields have no closed form, so a particle under
// fields is integrated from its own birth with a fixed step each time it is asked: still a pure function of time.

import { addFieldAcceleration } from './force-fields.js';
import { findFirstCollision } from './particle-collision.js';

export const PARTICLE_LIMITS = Object.freeze({
  maxSystems: 4,
  maxParticlesPerSystem: 2000,
  maxParticles: 4000,
  maxVertices: 100000,
  maxLifetime: 60,
  landingIterations: 32,
  fieldStepSeconds: 1 / 120,
  maxColliders: 8,
  maxColliderTriangles: 4096,
  maxEmitterTriangles: 8192,
  maxInstances: 8,
});

const NO_DRAG_THRESHOLD = 1e-6;
// A bounce slower than this (m/s) is not a bounce: the particle slides along the surface, or settles when it is slow too.
const REST_SPEED = 0.4;
// How strongly a sliding contact pulls the spin down, per second and unit of friction.
const SPIN_COUPLING = 20;
const CONTACT_OFFSET = 1e-4;
const SEED_MIXER = 0x9e3779b1;

export function createGenerator(seed, index) {
  let state = (Math.imul(index + 1, SEED_MIXER) ^ Math.floor(seed)) >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ state >>> 15, state | 1);
    mixed ^= mixed + Math.imul(mixed ^ mixed >>> 7, mixed | 61);
    return ((mixed ^ mixed >>> 14) >>> 0) / 4294967296;
  };
}

function between(range, fraction) {
  return range[0] + (range[1] - range[0]) * fraction;
}

export function normalized(vector) {
  const length = Math.hypot(vector[0], vector[1], vector[2]) || 1;
  return [vector[0] / length, vector[1] / length, vector[2] / length];
}

export function cross(first, second) {
  return [
    first[1] * second[2] - first[2] * second[1],
    first[2] * second[0] - first[0] * second[2],
    first[0] * second[1] - first[1] * second[0],
  ];
}

// A direction inside a cone around `axis`, uniform over the cone's solid angle.
function directionInCone(axis, spreadRadians, firstFraction, secondFraction) {
  const cosine = 1 - firstFraction * (1 - Math.cos(spreadRadians));
  const sine = Math.sqrt(Math.max(0, 1 - cosine * cosine));
  const angle = secondFraction * Math.PI * 2;
  const helper = Math.abs(axis[1]) < 0.99 ? [0, 1, 0] : [1, 0, 0];
  const side = normalized(cross(axis, helper));
  const up = cross(axis, side);
  return [0, 1, 2].map(component => axis[component] * cosine + (side[component] * Math.cos(angle) + up[component] * Math.sin(angle)) * sine);
}

function pointInEmitter(emitter, fractions) {
  const [first, second, third] = fractions;
  if (emitter.shape === 'box') {
    return emitter.halfExtents.map((half, axis) => (fractions[axis] * 2 - 1) * half);
  }
  if (emitter.shape === 'sphere') {
    const radius = emitter.radius * Math.cbrt(first);
    const cosine = second * 2 - 1;
    const sine = Math.sqrt(1 - cosine * cosine);
    return [radius * sine * Math.cos(third * Math.PI * 2), radius * cosine, radius * sine * Math.sin(third * Math.PI * 2)];
  }
  if (emitter.shape === 'disc') {
    const radius = emitter.radius * Math.sqrt(first);
    return [radius * Math.cos(second * Math.PI * 2), 0, radius * Math.sin(second * Math.PI * 2)];
  }
  return [0, 0, 0];
}

// Rotation (row major) that turns +Y onto the unit `normal`.
function rotationFromUp(normal, matrix) {
  const cosine = normal[1];
  if (cosine < -0.9999) {
    matrix.set([1, 0, 0, 0, -1, 0, 0, 0, -1]);
    return;
  }
  const [x, y, z] = [normal[2], 0, -normal[0]];
  const k = 1 / (1 + cosine);
  matrix[0] = cosine + k * x * x;
  matrix[1] = -z + k * x * y;
  matrix[2] = y + k * x * z;
  matrix[3] = z + k * x * y;
  matrix[4] = cosine + k * y * y;
  matrix[5] = -x + k * y * z;
  matrix[6] = -y + k * x * z;
  matrix[7] = x + k * y * z;
  matrix[8] = cosine + k * z * z;
}

/**
 * Launch values of every particle. Each particle draws from its own generator in a fixed order, so changing `count`
 * never changes the particles that were already there.
 */
export function createParticleLaunches(settings) {
  const { count, seed, emitter, lifetime, speed, direction, spreadRadians, size, rate, forces } = settings;
  const instanceCount = settings.instanceCount ?? 1;
  const orient = settings.orient ?? 'none';
  const normalSpeed = emitter.normalSpeed ?? 0;
  const spin = settings.spin ?? [0, 0];
  const axis = normalized(direction);
  const birth = new Float64Array(count);
  const life = new Float64Array(count);
  const origin = new Float64Array(count * 3);
  const velocity = new Float64Array(count * 3);
  const particleSize = new Float64Array(count);
  const spinAxis = new Float64Array(count * 3);
  const spinRate = new Float64Array(count);
  const spinStart = new Float64Array(count);
  const orientation = orient === 'none' ? undefined : new Float64Array(count * 9);
  const instancePick = instanceCount > 1 ? new Uint8Array(count) : undefined;
  for (let index = 0; index < count; index++) {
    const random = createGenerator(seed, index);
    random();
    const emission = emitter.shape === 'mesh' ? emitter.source.sample(random) : { point: pointInEmitter(emitter, [random(), random(), random()]), normal: null };
    const launch = directionInCone(axis, spreadRadians, random(), random());
    const launchSpeed = between(speed, random());
    for (let component = 0; component < 3; component++) {
      origin[index * 3 + component] = emitter.position[component] + emission.point[component];
      velocity[index * 3 + component] = launch[component] * launchSpeed + (emission.normal ? emission.normal[component] * normalSpeed : 0);
    }
    life[index] = between(lifetime, random());
    particleSize[index] = between(size, random());
    birth[index] = rate ? index / rate : 0;
    // Drawn last, so adding spin never changes the launch of a particle that existed before.
    const spinDirection = directionInCone([0, 1, 0], Math.PI, random(), random());
    spinAxis.set(spinDirection, index * 3);
    spinRate[index] = between(spin, random()) * Math.PI / 180;
    spinStart[index] = random() * Math.PI * 2;
    // Drawn after the spin, so choosing instances or an orientation never changes an earlier launch value.
    if (instancePick) instancePick[index] = Math.min(Math.floor(random() * instanceCount), instanceCount - 1);
    if (orient === 'random') {
      const turnAxis = directionInCone([0, 1, 0], Math.PI, random(), random());
      rotationMatrix(turnAxis, random() * Math.PI * 2, orientation.subarray(index * 9, index * 9 + 9));
    } else if (orient === 'normal') {
      rotationFromUp(emission.normal, orientation.subarray(index * 9, index * 9 + 9));
    }
  }
  const launches = {
    count, birth, life, origin, velocity, size: particleSize, spinAxis, spinRate, spinStart, orientation, instancePick,
    hasSpin: spin[0] !== 0 || spin[1] !== 0,
    // Age at which a particle stops moving: its landing, or where it came to rest.
    landing: new Float64Array(count).fill(Infinity),
  };
  // Fields, colliders and bounce have no closed form: the particle is stepped from its birth (see trackedState).
  const integrated = Boolean(forces.fields?.length || forces.colliders || forces.bounce > 0);
  if (integrated) {
    launches.track = {
      position: Float64Array.from(origin),
      velocity: Float64Array.from(velocity),
      steps: new Int32Array(count),
      resting: new Uint8Array(count),
      // Angle and rate of the spin: damped by contact, so it is stepped with the position.
      spin: Float64Array.from({ length: count * 2 }, (unused, slot) => slot % 2 ? spinRate[slot >> 1] : spinStart[slot >> 1]),
    };
    return launches;
  }
  for (let index = 0; index < count; index++) {
    launches.landing[index] = landingAge(launches, index, forces);
  }
  return launches;
}

// Displacement after `age` seconds along one axis. Drag pulls the velocity toward the wind plus the terminal fall.
function displacement(velocityAxis, accelerationAxis, windAxis, drag, age) {
  if (drag < NO_DRAG_THRESHOLD) {
    return velocityAxis * age + 0.5 * accelerationAxis * age * age;
  }
  const settled = windAxis + accelerationAxis / drag;
  return settled * age + (velocityAxis - settled) * (1 - Math.exp(-drag * age)) / drag;
}

function heightAt(launches, index, forces, age) {
  return launches.origin[index * 3 + 1] + displacement(launches.velocity[index * 3 + 1], forces.gravity[1], forces.wind[1], forces.drag, age);
}

// The age at which the vertical path turns around, or Infinity when it never does.
function turningAge(velocityAxis, accelerationAxis, windAxis, drag) {
  if (drag < NO_DRAG_THRESHOLD) {
    const turning = accelerationAxis === 0 ? Infinity : -velocityAxis / accelerationAxis;
    return turning > 0 ? turning : Infinity;
  }
  const settled = windAxis + accelerationAxis / drag;
  const ratio = settled / (settled - velocityAxis);
  return ratio > 0 && ratio < 1 ? -Math.log(ratio) / drag : Infinity;
}

// First age at which the particle reaches the floor within its life, or Infinity. The vertical path turns at most once,
// so a crossing is found by bisection between the start and whichever of the end of life and the turning point is below
// the floor. It depends on the launch only, never on the time asked, so every seek lands at the same age.
function landingAge(launches, index, forces) {
  const age = launches.life[index];
  const floorHeight = forces.floor;
  if (floorHeight === undefined || heightAt(launches, index, forces, 0) < floorHeight) {
    return Infinity;
  }
  const turning = turningAge(launches.velocity[index * 3 + 1], forces.gravity[1], forces.wind[1], forces.drag);
  let high = age;
  if (heightAt(launches, index, forces, age) > floorHeight) {
    if (!(turning < age) || heightAt(launches, index, forces, turning) > floorHeight) {
      return Infinity;
    }
    high = turning;
  }
  let low = 0;
  for (let iteration = 0; iteration < PARTICLE_LIMITS.landingIterations; iteration++) {
    const middle = (low + high) / 2;
    if (heightAt(launches, index, forces, middle) > floorHeight) {
      low = middle;
    } else {
      high = middle;
    }
  }
  return high;
}

const scratchFrom = [0, 0, 0];
const scratchTo = [0, 0, 0];
const scratchAcceleration = [0, 0, 0];
const contact = { fraction: Infinity, normal: [0, 1, 0], onFloor: false };

// The earliest surface the path from `from` to `to` crosses: the floor plane or a collider triangle.
function earliestContact(forces, from, to) {
  contact.fraction = Infinity;
  if (forces.floor !== undefined && to[1] <= forces.floor) {
    contact.fraction = from[1] > forces.floor ? (from[1] - forces.floor) / (from[1] - to[1]) : 0;
    contact.normal[0] = 0;
    contact.normal[1] = 1;
    contact.normal[2] = 0;
    contact.onFloor = true;
  }
  if (forces.colliders) {
    findFirstCollision(forces.colliders, from, to, contact);
  }
  return contact.fraction <= 1;
}

// Handles a contact. Without bounce the particle sticks where it touched. With bounce the normal speed is reflected and
// scaled by `bounce`. Coulomb friction removes `friction` times the normal impulse from the speed along the surface
// (a particle resting under gravity loses friction * g per second, so a slider slows and stops, never glides). The spin
// is damped by the same contact. Returns true when the particle has come to rest.
function resolveContact(forces, position, velocity, from, to, spin, step) {
  for (let axis = 0; axis < 3; axis++) {
    position[axis] = from[axis] + (to[axis] - from[axis]) * contact.fraction;
  }
  if (contact.onFloor) position[1] = forces.floor;
  if (!(forces.bounce > 0)) {
    spin[1] = 0;
    return true;
  }
  const normal = contact.normal;
  const inward = velocity[0] * normal[0] + velocity[1] * normal[1] + velocity[2] * normal[2];
  const rebound = inward < 0 ? -inward * forces.bounce : 0;
  const outward = rebound < REST_SPEED ? 0 : rebound;
  const tangent = [0, 0, 0];
  let tangentSpeed = 0;
  for (let axis = 0; axis < 3; axis++) {
    tangent[axis] = velocity[axis] - normal[axis] * inward;
    tangentSpeed += tangent[axis] * tangent[axis];
  }
  tangentSpeed = Math.sqrt(tangentSpeed);
  const impulse = Math.abs(Math.min(inward, 0)) + outward;
  const keep = tangentSpeed > 0 ? Math.max(0, 1 - forces.friction * impulse / tangentSpeed) : 0;
  let sliding = 0;
  for (let axis = 0; axis < 3; axis++) {
    const along = tangent[axis] * keep;
    velocity[axis] = along + normal[axis] * outward;
    position[axis] += normal[axis] * CONTACT_OFFSET;
    sliding += along * along;
  }
  // A bounce cuts the spin by friction at once; rolling contact keeps pulling it down while it slides.
  spin[1] *= outward > 0 ? 1 - forces.friction : Math.max(0, 1 - forces.friction * SPIN_COUPLING * step);
  const atRest = outward === 0 && Math.sqrt(sliding) < REST_SPEED;
  if (atRest) spin[1] = 0;
  if (!atRest) {
    // The rest of the step is spent moving along the response velocity, so a slider keeps its distance.
    for (let axis = 0; axis < 3; axis++) position[axis] += velocity[axis] * step * (1 - contact.fraction);
  }
  return atRest;
}

// One semi-implicit Euler step under gravity, drag toward the wind and every force field. Returns true at rest.
function stepParticle(forces, position, velocity, spin, step, fieldTime) {
  spin[0] += spin[1] * step;
  for (let axis = 0; axis < 3; axis++) {
    scratchAcceleration[axis] = forces.gravity[axis] + forces.drag * (forces.wind[axis] - velocity[axis]);
  }
  for (const field of forces.fields) {
    addFieldAcceleration(field, position, velocity, fieldTime, scratchAcceleration);
  }
  for (let axis = 0; axis < 3; axis++) {
    velocity[axis] += scratchAcceleration[axis] * step;
    scratchFrom[axis] = position[axis];
    scratchTo[axis] = position[axis] + velocity[axis] * step;
  }
  if (earliestContact(forces, scratchFrom, scratchTo)) {
    return resolveContact(forces, position, velocity, scratchFrom, scratchTo, spin, step);
  }
  for (let axis = 0; axis < 3; axis++) position[axis] = scratchTo[axis];
  return false;
}

// Integrates one particle from launch to `age` at the fixed step. Whole steps are remembered per particle, so playing
// forward continues where the last frame stopped and costs one frame of steps; a seek to an earlier age starts again
// from birth. Both reach the same bytes, because the remembered state only ever sits on a whole step.
function trackedState(launches, index, forces, age, target) {
  const track = launches.track;
  const stepSeconds = PARTICLE_LIMITS.fieldStepSeconds;
  const wholeSteps = Math.floor(age / stepSeconds);
  if (track.steps[index] > wholeSteps) {
    for (let axis = 0; axis < 3; axis++) {
      track.position[index * 3 + axis] = launches.origin[index * 3 + axis];
      track.velocity[index * 3 + axis] = launches.velocity[index * 3 + axis];
    }
    track.steps[index] = 0;
    track.resting[index] = 0;
    track.spin[index * 2] = launches.spinStart[index];
    track.spin[index * 2 + 1] = launches.spinRate[index];
  }
  const position = track.position.subarray(index * 3, index * 3 + 3);
  const velocity = track.velocity.subarray(index * 3, index * 3 + 3);
  const spin = track.spin.subarray(index * 2, index * 2 + 2);
  while (track.steps[index] < wholeSteps && !track.resting[index]) {
    const fieldTime = launches.birth[index] + track.steps[index] * stepSeconds;
    if (stepParticle(forces, position, velocity, spin, stepSeconds, fieldTime)) {
      track.resting[index] = 1;
      launches.landing[index] = (track.steps[index] + 1) * stepSeconds;
    }
    track.steps[index]++;
  }
  if (track.resting[index]) {
    track.steps[index] = wholeSteps;
    for (let axis = 0; axis < 3; axis++) target.position[axis] = position[axis];
    target.angle = spin[0];
    return;
  }
  // The last partial step is not remembered.
  const partialPosition = [position[0], position[1], position[2]];
  const partialVelocity = [velocity[0], velocity[1], velocity[2]];
  const partialSpin = [spin[0], spin[1]];
  const remainder = age - wholeSteps * stepSeconds;
  if (remainder > 1e-9) {
    stepParticle(forces, partialPosition, partialVelocity, partialSpin, remainder, launches.birth[index] + wholeSteps * stepSeconds);
  }
  for (let axis = 0; axis < 3; axis++) target.position[axis] = partialPosition[axis];
  target.angle = partialSpin[0];
}

function scaleAtLife(mode, lifeFraction) {
  if (mode === 'shrink') return 1 - lifeFraction;
  if (mode === 'grow') return lifeFraction;
  return 1;
}

/**
 * World position and scale of one particle at a time. A particle that is not born yet or already dead has scale 0.
 * A particle that reaches the floor or a collider without bounce stays where it landed until it dies.
 * `target.fraction` is the share of its life used and `target.motionAge` the age it has moved for (it stops at rest).
 */
export function particleStateAt(launches, index, forces, scaleMode, time, target) {
  const age = time - launches.birth[index];
  const lifetime = launches.life[index];
  target.fraction = Math.min(Math.max(age / lifetime, 0), 1);
  if (age < 0 || age >= lifetime) {
    target.scale = 0;
    target.motionAge = 0;
    for (let component = 0; component < 3; component++) target.position[component] = launches.origin[index * 3 + component];
    return target;
  }
  target.scale = launches.size[index] * scaleAtLife(scaleMode, age / lifetime);
  if (launches.track) {
    trackedState(launches, index, forces, age, target);
    target.motionAge = Math.min(age, launches.landing[index]);
    return target;
  }
  const landed = launches.landing[index];
  const effectiveAge = Math.min(age, landed);
  target.motionAge = effectiveAge;
  target.angle = launches.hasSpin ? launches.spinStart[index] + launches.spinRate[index] * effectiveAge : 0;
  for (let component = 0; component < 3; component++) {
    target.position[component] = launches.origin[index * 3 + component] +
      displacement(launches.velocity[index * 3 + component], forces.gravity[component], forces.wind[component], forces.drag, effectiveAge);
  }
  if (landed <= age) {
    target.position[1] = forces.floor;
  }
  return target;
}

// Rotation matrix (row major) for `angle` radians around the unit `axis`.
function rotationMatrix(axis, angle, matrix) {
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  const [x, y, z] = axis;
  const rest = 1 - cosine;
  matrix[0] = cosine + x * x * rest;
  matrix[1] = x * y * rest - z * sine;
  matrix[2] = x * z * rest + y * sine;
  matrix[3] = y * x * rest + z * sine;
  matrix[4] = cosine + y * y * rest;
  matrix[5] = y * z * rest - x * sine;
  matrix[6] = z * x * rest - y * sine;
  matrix[7] = z * y * rest + x * sine;
  matrix[8] = cosine + z * z * rest;
}

function rotatedInto(matrix, source, sourceOffset, destination, destinationOffset, scale) {
  for (let row = 0; row < 3; row++) {
    destination[destinationOffset + row] = (matrix[row * 3] * source[sourceOffset] + matrix[row * 3 + 1] * source[sourceOffset + 1] + matrix[row * 3 + 2] * source[sourceOffset + 2]) * scale;
  }
}

const IDENTITY = Object.freeze([1, 0, 0, 0, 1, 0, 0, 0, 1]);

function multiplyMatrices(first, second, result) {
  for (let row = 0; row < 3; row++) {
    for (let column = 0; column < 3; column++) {
      result[row * 3 + column] = first[row * 3] * second[column] + first[row * 3 + 1] * second[3 + column] + first[row * 3 + 2] * second[6 + column];
    }
  }
}

/**
 * Copies a template mesh once per particle, scaled, spun and moved to the particle's world position. `template` is one
 * mesh or a list; with a list each particle draws the one `launches.instancePick` names. `look` may hold
 * `color` ([start, end] RGB) and `alpha` ([start, end]) over life; they become vertex colors, and alpha multiplies the
 * color, so a particle fades toward black (the renderer has no per-vertex alpha).
 */
export function buildParticleMesh(template, launches, forces, scaleMode, time, look = {}) {
  const templates = Array.isArray(template) ? template : [template];
  const pickOf = index => launches.instancePick ? launches.instancePick[index] : 0;
  let totalVertices = 0;
  let totalIndices = 0;
  for (let index = 0; index < launches.count; index++) {
    const picked = templates[pickOf(index)];
    totalVertices += picked.positions.length / 3;
    totalIndices += picked.indices.length;
  }
  const positions = new Float32Array(totalVertices * 3);
  const normals = new Float32Array(totalVertices * 3);
  const indices = new Uint32Array(totalIndices);
  const hasUvs = templates.every(entry => entry.uvs);
  const uvs = hasUvs ? new Float32Array(totalVertices * 2) : undefined;
  const colors = look.color || look.alpha ? new Float32Array(totalVertices * 3) : undefined;
  const state = { position: [0, 0, 0], scale: 0 };
  const spinMatrix = new Float64Array(9);
  const matrix = new Float64Array(9);
  const tint = [1, 1, 1];
  const transformed = launches.hasSpin || Boolean(launches.orientation);
  let vertexBase = 0;
  let indexBase = 0;
  for (let index = 0; index < launches.count; index++) {
    const picked = templates[pickOf(index)];
    const vertexCount = picked.positions.length / 3;
    particleStateAt(launches, index, forces, scaleMode, time, state);
    if (transformed) {
      if (launches.hasSpin) rotationMatrix(launches.spinAxis.subarray(index * 3, index * 3 + 3), state.angle, spinMatrix);
      const base = launches.orientation ? launches.orientation.subarray(index * 9, index * 9 + 9) : IDENTITY;
      if (launches.hasSpin) multiplyMatrices(spinMatrix, base, matrix);
      else matrix.set(base);
    }
    if (colors) {
      const alpha = look.alpha ? look.alpha[0] + (look.alpha[1] - look.alpha[0]) * state.fraction : 1;
      for (let channel = 0; channel < 3; channel++) {
        const start = look.color ? look.color[0][channel] : 1;
        const end = look.color ? look.color[1][channel] : 1;
        tint[channel] = (start + (end - start) * state.fraction) * alpha;
      }
    }
    for (let vertex = 0; vertex < vertexCount; vertex++) {
      const offset = (vertexBase + vertex) * 3;
      if (transformed) {
        rotatedInto(matrix, picked.positions, vertex * 3, positions, offset, state.scale);
        rotatedInto(matrix, picked.normals, vertex * 3, normals, offset, 1);
      }
      for (let component = 0; component < 3; component++) {
        positions[offset + component] = state.position[component] + (transformed ? positions[offset + component] : picked.positions[vertex * 3 + component] * state.scale);
        if (colors) colors[offset + component] = tint[component] * (picked.colors ? picked.colors[vertex * 3 + component] : 1);
      }
    }
    if (!transformed) normals.set(picked.normals, vertexBase * 3);
    uvs?.set(picked.uvs, vertexBase * 2);
    for (let corner = 0; corner < picked.indices.length; corner++) {
      indices[indexBase + corner] = picked.indices[corner] + vertexBase;
    }
    vertexBase += vertexCount;
    indexBase += picked.indices.length;
  }
  const result = { ...templates[0], positions, normals, indices };
  if (templates.length > 1) {
    delete result.uvs;
    delete result.colors;
  }
  if (uvs) result.uvs = uvs;
  if (colors) result.colors = colors;
  return result;
}
