// Live physics as a runtime system. One small interface (bodies, colliders, joints, forces, ray, shape and overlap
// queries, contact and sensor events) sits over a physics engine adapter, and the system steps it in fixedUpdate and
// writes the body poses to scene parts. The Rapier adapter wraps the world builder the recorded bake in physics.js uses,
// so the bake path and the live path share one adapter. Another engine plugs in as an object with the same shape as
// `rapierAdapter`; see docs/physics-runtime.md. Nothing here touches the film path.
import { mat4, quat } from 'gl-matrix';
import { applyForceFieldImpulses, createRapierWorld, loadPhysicsEngine, prepareLivePhysics, requireRapier } from './physics.js';

export const PHYSICS_RUNTIME_LIMITS = Object.freeze({
  maximumListeners: 64,
  maximumBindings: 4096,
  maximumOverlaps: 1024,
  maximumQueryDistance: 1e6,
});

const SHAPE_TYPES = ['ball', 'cuboid', 'capsule'];
const MAX_GROUP_BITS = 0xffff;
const STEP_TOLERANCE = 1e-9;
const POSE_STRIDE = 7;

function describe(value) {
  return value === null ? 'null' : typeof value;
}

function finiteVector(value, length, label) {
  if (!(Array.isArray(value) || ArrayBuffer.isView(value)) || value.length !== length || !Array.from(value).every(Number.isFinite)) {
    throw new TypeError(`${label} must be an array of ${length} finite numbers, got ${Array.isArray(value) ? JSON.stringify(value) : describe(value)}.`);
  }
  return Array.from(value);
}

function unitDirection(value, label) {
  const direction = finiteVector(value, 3, label);
  const length = Math.hypot(...direction);
  if (!(length > 0)) throw new RangeError(`${label} must not be the zero vector; pass a direction such as [0, -1, 0].`);
  return direction.map(component => component / length);
}

function queryDistance(value, label) {
  if (typeof value !== 'number' || !(value > 0) || value > PHYSICS_RUNTIME_LIMITS.maximumQueryDistance) {
    throw new RangeError(`${label} must be a number above 0 and up to ${PHYSICS_RUNTIME_LIMITS.maximumQueryDistance}, got ${String(value)}.`);
  }
  return value;
}

function positiveNumber(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${label} must be a number above 0, got ${String(value)}.`);
  }
  return value;
}

function validateShape(shape, label) {
  if (shape === null || typeof shape !== 'object' || !SHAPE_TYPES.includes(shape.type)) {
    const got = shape === null || typeof shape !== 'object' ? describe(shape) : String(shape.type);
    throw new TypeError(`${label} must be { type: ${SHAPE_TYPES.map(type => `"${type}"`).join(' | ')}, ... }, got ${got}.`);
  }
  if (shape.type === 'ball') return { type: 'ball', radius: positiveNumber(shape.radius, `${label}.radius`) };
  if (shape.type === 'capsule') {
    return { type: 'capsule', halfHeight: positiveNumber(shape.halfHeight, `${label}.halfHeight`), radius: positiveNumber(shape.radius, `${label}.radius`) };
  }
  const halfExtents = finiteVector(shape.halfExtents, 3, `${label}.halfExtents`);
  halfExtents.forEach((extent, axis) => positiveNumber(extent, `${label}.halfExtents[${axis}]`));
  return { type: 'cuboid', halfExtents };
}

function validateRotation(value, label) {
  if (value === undefined) return [0, 0, 0, 1];
  const rotation = finiteVector(value, 4, label);
  const length = Math.hypot(...rotation);
  if (!(length > 0)) throw new RangeError(`${label} must not be the zero quaternion; pass [x, y, z, w] such as [0, 0, 0, 1].`);
  return rotation.map(component => component / length);
}

const xyz = array => ({ x: array[0], y: array[1], z: array[2] });
const xyzw = array => ({ ...xyz(array), w: array[3] });

/** The Rapier adapter: a world built by the same function the recorded bake uses. */
export const rapierAdapter = Object.freeze({
  name: 'rapier',
  load: loadPhysicsEngine,
  createWorld(prepared) {
    const rapier = requireRapier();
    const { world, bodies, colliderIndices } = createRapierWorld(rapier, prepared);
    const eventQueue = new rapier.EventQueue(true);

    function queryFilter(filter) {
      const flags = filter.includeSensors ? undefined : rapier.QueryFilterFlags.EXCLUDE_SENSORS;
      const groups = ((MAX_GROUP_BITS << 16) | filter.mask) >>> 0;
      const excludedBody = filter.excludeBody === undefined ? undefined : bodies[filter.excludeBody];
      return [flags, groups, undefined, excludedBody];
    }

    function rapierShape(shape) {
      if (shape.type === 'ball') return new rapier.Ball(shape.radius);
      if (shape.type === 'capsule') return new rapier.Capsule(shape.halfHeight, shape.radius);
      return new rapier.Cuboid(...shape.halfExtents);
    }

    return {
      step(stepSeconds, elapsedSeconds) {
        world.timestep = stepSeconds;
        if (prepared.fields.length) applyForceFieldImpulses({ ...prepared, timestep: stepSeconds }, bodies, elapsedSeconds);
        world.step(eventQueue);
      },
      readPose(bodyIndex, output) {
        const position = bodies[bodyIndex].translation();
        const rotation = bodies[bodyIndex].rotation();
        output[0] = position.x;
        output[1] = position.y;
        output[2] = position.z;
        output[3] = rotation.x;
        output[4] = rotation.y;
        output[5] = rotation.z;
        output[6] = rotation.w;
      },
      setKinematicPose(bodyIndex, translation, rotation) {
        if (translation) bodies[bodyIndex].setNextKinematicTranslation(xyz(translation));
        if (rotation) bodies[bodyIndex].setNextKinematicRotation(xyzw(rotation));
      },
      setLinearVelocity(bodyIndex, velocity) {
        bodies[bodyIndex].setLinvel(xyz(velocity), true);
      },
      applyImpulse(bodyIndex, impulse, point) {
        if (point) bodies[bodyIndex].applyImpulseAtPoint(xyz(impulse), xyz(point), true);
        else bodies[bodyIndex].applyImpulse(xyz(impulse), true);
      },
      drainEvents(callback) {
        eventQueue.drainCollisionEvents((firstHandle, secondHandle, started) => {
          callback(colliderIndices.get(firstHandle), colliderIndices.get(secondHandle), started);
        });
      },
      raycast(origin, direction, maxDistance, filter) {
        const ray = new rapier.Ray(xyz(origin), xyz(direction));
        const hit = world.castRayAndGetNormal(ray, maxDistance, true, ...queryFilter(filter));
        if (!hit) return null;
        return { collider: colliderIndices.get(hit.collider.handle), distance: hit.timeOfImpact, normal: [hit.normal.x, hit.normal.y, hit.normal.z] };
      },
      shapeCast(shape, translation, rotation, direction, maxDistance, filter) {
        const hit = world.castShape(xyz(translation), xyzw(rotation), xyz(direction), rapierShape(shape), 0, maxDistance, true, ...queryFilter(filter));
        if (!hit) return null;
        return { collider: colliderIndices.get(hit.collider.handle), distance: hit.time_of_impact, normal: [hit.normal1.x, hit.normal1.y, hit.normal1.z] };
      },
      overlap(shape, translation, rotation, filter) {
        const found = [];
        world.intersectionsWithShape(xyz(translation), xyzw(rotation), rapierShape(shape), collider => {
          found.push(colliderIndices.get(collider.handle));
          return found.length < PHYSICS_RUNTIME_LIMITS.maximumOverlaps;
        }, ...queryFilter(filter));
        return found;
      },
      free() {
        eventQueue.free();
        world.free();
      },
    };
  },
});

function validateAdapter(adapter) {
  if (adapter === null || typeof adapter !== 'object' || typeof adapter.createWorld !== 'function' || typeof adapter.name !== 'string') {
    throw new TypeError('createPhysicsSystem adapter must be an object like { name, load?(), createWorld(prepared) }, such as rapierAdapter.');
  }
  return adapter;
}

function validateFilter(filter, bodyIndices) {
  if (filter === null || typeof filter !== 'object') throw new TypeError('A physics query options value must be an object like { mask, excludeBody, includeSensors } or left out.');
  const mask = filter.mask ?? MAX_GROUP_BITS;
  if (!Number.isInteger(mask) || mask < 0 || mask > MAX_GROUP_BITS) {
    throw new RangeError(`A physics query mask must be an integer from 0 to ${MAX_GROUP_BITS}, got ${String(filter.mask)}.`);
  }
  let excludeBody;
  if (filter.excludeBody !== undefined) {
    excludeBody = bodyIndices.get(filter.excludeBody);
    if (excludeBody === undefined) throw new RangeError(`A physics query excludeBody names no body: "${String(filter.excludeBody)}". Present: ${[...bodyIndices.keys()].join(', ')}.`);
  }
  return { mask, excludeBody, includeSensors: filter.includeSensors === true };
}

function partScale(matrix) {
  return [Math.hypot(matrix[0], matrix[1], matrix[2]), Math.hypot(matrix[4], matrix[5], matrix[6]), Math.hypot(matrix[8], matrix[9], matrix[10])];
}

/**
 * Build a live physics system for a runtime. Await it: the adapter may load a wasm engine first.
 * `definition` is the recorded-physics definition without tick events (docs/physics.md). Options: adapter (default
 * rapierAdapter), timestep (default 1/60; give the runtime the same fixedStepSeconds), name, bindings, solverIterations.
 */
export async function createPhysicsSystem(definition, options = {}) {
  if (options === null || typeof options !== 'object') throw new TypeError('createPhysicsSystem options must be an object or left out.');
  const { adapter: requestedAdapter, name, bindings: initialBindings, ...engineOptions } = options;
  const adapter = validateAdapter(requestedAdapter ?? rapierAdapter);
  const timestep = engineOptions.timestep ?? 1 / 60;
  const prepared = prepareLivePhysics(definition, { ...engineOptions, timestep });
  await adapter.load?.();
  const world = adapter.createWorld(prepared);

  const bodyNames = Object.freeze(prepared.bodies.map(body => body.name));
  const bodyIndices = new Map(bodyNames.map((bodyName, index) => [bodyName, index]));
  let previousPoses = new Float32Array(bodyNames.length * POSE_STRIDE);
  let currentPoses = new Float32Array(bodyNames.length * POSE_STRIDE);
  const bindings = [];
  const listeners = { contact: new Set(), sensor: new Set() };
  let stepEvents = [];
  let eventsTruncated = false;
  let stepCount = 0;
  let disposed = false;

  function readPoses() {
    for (let bodyIndex = 0; bodyIndex < bodyNames.length; bodyIndex++) {
      world.readPose(bodyIndex, currentPoses.subarray(bodyIndex * POSE_STRIDE, (bodyIndex + 1) * POSE_STRIDE));
    }
  }
  // The wasm world is only freed by dispose(), so a setup that throws before the system exists must free it here.
  function freeWorldOnFailure(action) {
    try {
      return action();
    } catch (error) {
      world.free();
      throw error;
    }
  }

  // The bake rejects non-finite poses and non-unit quaternions after each step; the live step does the same.
  function assertPosesSound() {
    for (let bodyIndex = 0; bodyIndex < bodyNames.length; bodyIndex++) {
      const offset = bodyIndex * POSE_STRIDE;
      let quaternionLengthSquared = 0;
      for (let component = 0; component < POSE_STRIDE; component++) {
        const value = currentPoses[offset + component];
        if (!Number.isFinite(value)) {
          throw new RangeError(`Body "${bodyNames[bodyIndex]}" has a non-finite pose at step ${stepCount}. Apply smaller velocities and impulses.`);
        }
        if (component >= 3) quaternionLengthSquared += value * value;
      }
      if (Math.abs(Math.sqrt(quaternionLengthSquared) - 1) > 1e-3) {
        throw new RangeError(`Body "${bodyNames[bodyIndex]}" has a non-unit rotation at step ${stepCount}. Apply smaller velocities and impulses.`);
      }
    }
  }

  freeWorldOnFailure(() => {
    readPoses();
    assertPosesSound();
    previousPoses.set(currentPoses);
  });

  function assertAlive() {
    if (disposed) throw new Error('This physics system was disposed. Call createPhysicsSystem again.');
  }

  function bodyIndexOf(bodyName, action) {
    const index = bodyIndices.get(bodyName);
    if (index === undefined) throw new RangeError(`${action} names no body: "${String(bodyName)}". Present: ${bodyNames.join(', ')}.`);
    return index;
  }

  function requireBodyType(bodyName, action, type) {
    const index = bodyIndexOf(bodyName, action);
    const actual = prepared.bodies[index].type;
    if (actual !== type) throw new TypeError(`${action} needs a ${type} body; "${bodyName}" is ${actual}.`);
    return index;
  }

  const colliderBodyName = colliderIndex => bodyNames[prepared.colliders[colliderIndex].body];

  function describeHit(hit, origin, unit) {
    return {
      body: colliderBodyName(hit.collider),
      collider: prepared.colliders[hit.collider].name,
      distance: hit.distance,
      point: origin.map((component, axis) => component + unit[axis] * hit.distance),
      normal: hit.normal,
    };
  }

  function collectEvents() {
    const collected = [];
    eventsTruncated = false;
    world.drainEvents((first, second, started) => {
      if (collected.length >= prepared.maxContactEvents) {
        eventsTruncated = true;
        return;
      }
      const [colliderA, colliderB] = first < second ? [first, second] : [second, first];
      const sensor = prepared.colliders[colliderA].sensor || prepared.colliders[colliderB].sensor;
      collected.push(Object.freeze({
        step: stepCount,
        kind: sensor ? 'sensor' : 'contact',
        started,
        colliderA,
        colliderB,
        bodyA: colliderBodyName(colliderA),
        bodyB: colliderBodyName(colliderB),
      }));
    });
    // Engines report events in their own order; sorting makes every adapter fire the same sequence.
    collected.sort((first, second) => first.colliderA - second.colliderA || first.colliderB - second.colliderB || Number(second.started) - Number(first.started));
    return collected;
  }

  function writeBindings(alpha) {
    for (const binding of bindings) {
      const offset = binding.index * POSE_STRIDE;
      for (let axis = 0; axis < 3; axis++) {
        binding.position[axis] = previousPoses[offset + axis] + (currentPoses[offset + axis] - previousPoses[offset + axis]) * alpha;
      }
      for (let component = 0; component < 4; component++) {
        binding.start[component] = previousPoses[offset + 3 + component];
        binding.end[component] = currentPoses[offset + 3 + component];
      }
      quat.slerp(binding.rotation, binding.start, binding.end, alpha);
      mat4.fromRotationTranslationScale(binding.part.matrix, binding.rotation, binding.position, binding.scale);
    }
  }

  function bind(bodyName, part) {
    assertAlive();
    const index = bodyIndexOf(bodyName, 'bind');
    const matrix = part?.matrix;
    if (!(matrix instanceof Float32Array) || matrix.length !== 16) {
      throw new TypeError(`bind("${bodyName}") needs a part with a retained Float32Array(16) matrix, got ${describe(matrix)}.`);
    }
    if (bindings.length >= PHYSICS_RUNTIME_LIMITS.maximumBindings) {
      throw new RangeError(`A physics system binds at most ${PHYSICS_RUNTIME_LIMITS.maximumBindings} parts.`);
    }
    if (bindings.some(binding => binding.part.matrix === matrix)) throw new RangeError(`bind("${bodyName}") got a part whose matrix is already bound.`);
    const scale = partScale(matrix);
    if (!scale.every(size => size > 0 && Number.isFinite(size))) {
      throw new RangeError(`bind("${bodyName}") needs a part matrix with a positive scale, such as the identity matrix.`);
    }
    bindings.push({ part, index, scale, position: new Float32Array(3), rotation: quat.create(), start: quat.create(), end: quat.create() });
    writeBindings(1);
    return system;
  }

  function on(kind, listener) {
    assertAlive();
    if (!(kind in listeners)) throw new RangeError(`on() kind must be "contact" or "sensor", got ${String(kind)}.`);
    if (typeof listener !== 'function') throw new TypeError(`on("${kind}") needs a listener function, got ${describe(listener)}.`);
    if (listeners[kind].size >= PHYSICS_RUNTIME_LIMITS.maximumListeners) {
      throw new RangeError(`A physics system holds at most ${PHYSICS_RUNTIME_LIMITS.maximumListeners} listeners per kind.`);
    }
    listeners[kind].add(listener);
    return () => listeners[kind].delete(listener);
  }

  const system = {
    name: name ?? 'physics',
    adapter: adapter.name,
    timestep,
    bodyNames,
    get stepCount() { return stepCount; },
    /** The contact and sensor events of the last step, sorted by collider pair. */
    get events() { return stepEvents; },
    get eventsTruncated() { return eventsTruncated; },
    on,
    bind,

    // Runtime hooks.
    fixedUpdate(stepSeconds, context) {
      assertAlive();
      if (Math.abs(stepSeconds - timestep) > STEP_TOLERANCE * Math.max(1, timestep)) {
        throw new RangeError(`The runtime fixed step is ${stepSeconds} s but this physics system was built with timestep ${timestep} s. Create the runtime with fixedStepSeconds: physics.timestep, or pass timestep: ${stepSeconds} to createPhysicsSystem.`);
      }
      world.step(stepSeconds, stepCount * stepSeconds);
      stepCount += 1;
      [previousPoses, currentPoses] = [currentPoses, previousPoses];
      readPoses();
      assertPosesSound();
      stepEvents = collectEvents();
      // In 'both' mode update() writes the interpolated pose; otherwise this step is the only writer.
      if (context?.mode !== 'both') writeBindings(1);
      for (const event of stepEvents) {
        for (const listener of listeners[event.kind]) listener(event);
      }
    },
    update(_delta, context) {
      if (context?.mode === 'both') writeBindings(context.alpha);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      world.free();
      bindings.length = 0;
    },

    // Control. Kinematic bodies are driven by code; dynamic bodies take impulses and velocities.
    setKinematicPose(bodyName, pose) {
      assertAlive();
      const index = requireBodyType(bodyName, 'setKinematicPose', 'kinematic');
      if (pose === null || typeof pose !== 'object' || (pose.translation === undefined && pose.rotation === undefined)) {
        throw new TypeError('setKinematicPose needs { translation, rotation } with at least one of them.');
      }
      const translation = pose.translation === undefined ? undefined : finiteVector(pose.translation, 3, 'setKinematicPose translation');
      const rotation = pose.rotation === undefined ? undefined : validateRotation(pose.rotation, 'setKinematicPose rotation');
      world.setKinematicPose(index, translation, rotation);
      return system;
    },
    setLinearVelocity(bodyName, velocity) {
      assertAlive();
      const index = requireBodyType(bodyName, 'setLinearVelocity', 'dynamic');
      world.setLinearVelocity(index, finiteVector(velocity, 3, 'setLinearVelocity velocity'));
      return system;
    },
    applyImpulse(bodyName, impulse, point) {
      assertAlive();
      const index = requireBodyType(bodyName, 'applyImpulse', 'dynamic');
      world.applyImpulse(index, finiteVector(impulse, 3, 'applyImpulse impulse'), point === undefined ? undefined : finiteVector(point, 3, 'applyImpulse point'));
      return system;
    },
    /** Pose of a body after the last step: { translation, rotation }. */
    getPose(bodyName) {
      assertAlive();
      const offset = bodyIndexOf(bodyName, 'getPose') * POSE_STRIDE;
      return { translation: Array.from(currentPoses.subarray(offset, offset + 3)), rotation: Array.from(currentPoses.subarray(offset + 3, offset + POSE_STRIDE)) };
    },

    // Queries read the world as the last step left it.
    /** First hit along a ray, or null: { body, collider, distance, point, normal }. */
    raycast(origin, direction, queryOptions = {}) {
      assertAlive();
      const start = finiteVector(origin, 3, 'raycast origin');
      const unit = unitDirection(direction, 'raycast direction');
      const maximumDistance = queryDistance(queryOptions.maxDistance ?? 1000, 'raycast maxDistance');
      const hit = world.raycast(start, unit, maximumDistance, validateFilter(queryOptions, bodyIndices));
      return hit ? describeHit(hit, start, unit) : null;
    },
    /** Sweep a ball, cuboid or capsule along a direction and return the first hit, or null: { body, collider, distance, point, normal }. */
    shapeCast(shape, translation, direction, queryOptions = {}) {
      assertAlive();
      const validShape = validateShape(shape, 'shapeCast shape');
      const start = finiteVector(translation, 3, 'shapeCast translation');
      const unit = unitDirection(direction, 'shapeCast direction');
      const maximumDistance = queryDistance(queryOptions.maxDistance ?? 1000, 'shapeCast maxDistance');
      const rotation = validateRotation(queryOptions.rotation, 'shapeCast rotation');
      const hit = world.shapeCast(validShape, start, rotation, unit, maximumDistance, validateFilter(queryOptions, bodyIndices));
      return hit ? describeHit(hit, start, unit) : null;
    },
    /** Names of the bodies whose colliders touch a ball, cuboid or capsule placed in the world, sorted. */
    overlap(shape, translation, queryOptions = {}) {
      assertAlive();
      const validShape = validateShape(shape, 'overlap shape');
      const start = finiteVector(translation, 3, 'overlap translation');
      const rotation = validateRotation(queryOptions.rotation, 'overlap rotation');
      const found = world.overlap(validShape, start, rotation, validateFilter(queryOptions, bodyIndices));
      return [...new Set(found.map(colliderBodyName))].sort();
    },
  };
  freeWorldOnFailure(() => {
    for (const binding of initialBindings ?? []) bind(binding.body, binding.part);
  });
  return system;
}
