// Stateless particles: every particle is a closed-form function of its own seeded launch values and the time.
// There is no stepping, so the state at time t never depends on which times were visited before. A seek backwards
// repeats exactly, and the same seed gives the same bytes. Force fields have no closed form, so a particle under
// fields is integrated from its own birth with a fixed step each time it is asked: still a pure function of time.

import { addFieldAcceleration } from './force-fields.js';

export const PARTICLE_LIMITS = Object.freeze({
  maxSystems: 4,
  maxParticlesPerSystem: 2000,
  maxParticles: 4000,
  maxVertices: 100000,
  maxLifetime: 60,
  landingIterations: 32,
  fieldStepSeconds: 1 / 120,
});

const NO_DRAG_THRESHOLD = 1e-6;
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

/**
 * Launch values of every particle. Each particle draws from its own generator in a fixed order, so changing `count`
 * never changes the particles that were already there.
 */
export function createParticleLaunches(settings) {
  const { count, seed, emitter, lifetime, speed, direction, spreadRadians, size, rate, forces } = settings;
  const axis = normalized(direction);
  const birth = new Float64Array(count);
  const life = new Float64Array(count);
  const origin = new Float64Array(count * 3);
  const velocity = new Float64Array(count * 3);
  const particleSize = new Float64Array(count);
  for (let index = 0; index < count; index++) {
    const random = createGenerator(seed, index);
    random();
    const point = pointInEmitter(emitter, [random(), random(), random()]);
    const launch = directionInCone(axis, spreadRadians, random(), random());
    const launchSpeed = between(speed, random());
    for (let component = 0; component < 3; component++) {
      origin[index * 3 + component] = emitter.position[component] + point[component];
      velocity[index * 3 + component] = launch[component] * launchSpeed;
    }
    life[index] = between(lifetime, random());
    particleSize[index] = between(size, random());
    birth[index] = rate ? index / rate : 0;
  }
  const launches = { count, birth, life, origin, velocity, size: particleSize, landing: new Float64Array(count).fill(Infinity) };
  const hasFields = Boolean(forces.fields?.length);
  for (let index = 0; index < count; index++) {
    // Under fields the floor is met while integrating, not by the closed form.
    launches.landing[index] = hasFields ? Infinity : landingAge(launches, index, forces);
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

// Integrates one particle under gravity, drag toward the wind and every force field, from launch to `age`.
// Semi-implicit Euler at a fixed step; a particle that reaches the floor stays there.
function integrateUnderFields(launches, index, forces, age, target) {
  const position = [launches.origin[index * 3], launches.origin[index * 3 + 1], launches.origin[index * 3 + 2]];
  const velocity = [launches.velocity[index * 3], launches.velocity[index * 3 + 1], launches.velocity[index * 3 + 2]];
  const acceleration = [0, 0, 0];
  let elapsed = 0;
  while (elapsed < age) {
    const step = Math.min(PARTICLE_LIMITS.fieldStepSeconds, age - elapsed);
    for (let axis = 0; axis < 3; axis++) {
      acceleration[axis] = forces.gravity[axis] + forces.drag * (forces.wind[axis] - velocity[axis]);
    }
    for (const field of forces.fields) {
      addFieldAcceleration(field, position, velocity, launches.birth[index] + elapsed, acceleration);
    }
    for (let axis = 0; axis < 3; axis++) {
      velocity[axis] += acceleration[axis] * step;
      position[axis] += velocity[axis] * step;
    }
    elapsed += step;
    if (forces.floor !== undefined && position[1] <= forces.floor) {
      position[1] = forces.floor;
      break;
    }
  }
  for (let axis = 0; axis < 3; axis++) target.position[axis] = position[axis];
}

function scaleAtLife(mode, lifeFraction) {
  if (mode === 'shrink') return 1 - lifeFraction;
  if (mode === 'grow') return lifeFraction;
  return 1;
}

/**
 * World position and scale of one particle at a time. A particle that is not born yet or already dead has scale 0.
 * A particle that reaches the floor stays where it landed until it dies.
 */
export function particleStateAt(launches, index, forces, scaleMode, time, target) {
  const age = time - launches.birth[index];
  const lifetime = launches.life[index];
  if (age < 0 || age >= lifetime) {
    target.scale = 0;
    for (let component = 0; component < 3; component++) target.position[component] = launches.origin[index * 3 + component];
    return target;
  }
  if (forces.fields?.length) {
    integrateUnderFields(launches, index, forces, age, target);
    target.scale = launches.size[index] * scaleAtLife(scaleMode, age / lifetime);
    return target;
  }
  const landed = launches.landing[index];
  const effectiveAge = Math.min(age, landed);
  for (let component = 0; component < 3; component++) {
    target.position[component] = launches.origin[index * 3 + component] +
      displacement(launches.velocity[index * 3 + component], forces.gravity[component], forces.wind[component], forces.drag, effectiveAge);
  }
  if (landed <= age) {
    target.position[1] = forces.floor;
  }
  target.scale = launches.size[index] * scaleAtLife(scaleMode, age / lifetime);
  return target;
}

/** Copies a template mesh once per particle, scaled and moved to the particle's world position. */
export function buildParticleMesh(template, launches, forces, scaleMode, time) {
  const vertexCount = template.positions.length / 3;
  const indexCount = template.indices.length;
  const positions = new Float32Array(vertexCount * launches.count * 3);
  const normals = new Float32Array(vertexCount * launches.count * 3);
  const indices = new Uint32Array(indexCount * launches.count);
  const uvs = template.uvs ? new Float32Array(vertexCount * launches.count * 2) : undefined;
  const state = { position: [0, 0, 0], scale: 0 };
  for (let index = 0; index < launches.count; index++) {
    particleStateAt(launches, index, forces, scaleMode, time, state);
    const vertexBase = index * vertexCount;
    for (let vertex = 0; vertex < vertexCount; vertex++) {
      for (let component = 0; component < 3; component++) {
        positions[(vertexBase + vertex) * 3 + component] = state.position[component] + template.positions[vertex * 3 + component] * state.scale;
      }
    }
    normals.set(template.normals, vertexBase * 3);
    uvs?.set(template.uvs, vertexBase * 2);
    for (let corner = 0; corner < indexCount; corner++) {
      indices[index * indexCount + corner] = template.indices[corner] + vertexBase;
    }
  }
  return { ...template, positions, normals, indices, ...(uvs ? { uvs } : {}) };
}
