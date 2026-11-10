// An NPC that walks a path through an animation graph: it steers along waypoints (a navmesh route or any list of points), eases its
// speed for corners and the arrival, writes that speed to a graph parameter so idle, walk and run blend, and moves by the graph's
// root motion so the feet do not slide. Pure arithmetic, no clock and no random source: the same steps give the same walk.

export const NPC_FOLLOWER_LIMITS = Object.freeze({ maximumWaypoints: 256, maximumSpeed: 100 });

const DEFAULTS = Object.freeze({
  parameter: 'speed',
  cruiseSpeed: 2.2,
  acceleration: 6,
  turnRate: 6,
  arrivalRadius: 0.1,
  slowRadius: 1,
  cornerRadius: 0.2,
  cornerSlowDistance: 1.5,
  minimumSpeed: 0.3,
});
const BLOCKED_PROBE_EPSILON = 1e-9;

function describe(value) {
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `an array of ${value.length}`;
  return value === null ? 'null' : typeof value === 'object' ? 'an object' : String(value);
}

function positive(value, fallback, label, maximum = Infinity) {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved <= 0 || resolved > maximum) {
    throw new RangeError(`createPathFollower ${label} must be a number above 0${maximum < Infinity ? ` and at most ${maximum}` : ''}, got ${describe(value)}.`);
  }
  return resolved;
}

function readPoint(value, index) {
  const valid = Array.isArray(value) && (value.length === 2 || value.length === 3) && value.every(Number.isFinite);
  if (!valid) throw new TypeError(`follower path point ${index} must be [x, z] or [x, y, z] in metres, got ${describe(value)}.`);
  return value.length === 2 ? [value[0], null, value[1]] : [value[0], value[1], value[2]];
}

function readPath(path) {
  const points = Array.isArray(path) ? path : path?.points;
  if (!Array.isArray(points) || points.length < 1 || points.length > NPC_FOLLOWER_LIMITS.maximumWaypoints) {
    throw new RangeError(`follower.follow needs a list of 1 to ${NPC_FOLLOWER_LIMITS.maximumWaypoints} points, or the { points } of navmesh.findPath, got ${describe(path)}.`);
  }
  return points.map(readPoint);
}

function wrapAngle(angle) {
  return Math.atan2(Math.sin(angle), Math.cos(angle));
}

function clamp(value, minimum, maximum) {
  return Math.min(Math.max(value, minimum), maximum);
}

/**
 * Options: `graph` (an animation graph made with the `rootMotion` option), `parameter` ('speed', a number parameter of the graph),
 * `position` ([x, y, z]), `yaw` (radians, the player's convention: 0 faces -Z), `cruiseSpeed` (in parameter units, 2.2),
 * `acceleration` (6 per second), `turnRate` (6 rad/s), `arrivalRadius` (0.1 m), `slowRadius` (1 m, where it eases in to the goal),
 * `cornerRadius` (0.2 m, how close a corner counts as reached), `cornerSlowDistance` (1.5 m), `minimumSpeed` (0.3), `navmesh`
 * (keeps the NPC on walkable ground, gives its height and enables `goTo`).
 */
export function createPathFollower(options = {}) {
  const { graph, navmesh } = options;
  if (!graph || typeof graph.set !== 'function' || !('rootMotion' in graph)) {
    throw new TypeError('createPathFollower graph must be an animation graph from createAnimationGraph, such as createPathFollower({ graph, position: [0, 0, 0] }).');
  }
  const position = options.position ?? [0, 0, 0];
  if (!Array.isArray(position) || position.length !== 3 || !position.every(Number.isFinite)) {
    throw new TypeError(`createPathFollower position must be [x, y, z] in metres, got ${describe(position)}.`);
  }
  if (options.yaw !== undefined && !Number.isFinite(options.yaw)) throw new TypeError(`createPathFollower yaw must be a number in radians, got ${describe(options.yaw)}.`);
  if (navmesh !== undefined && (typeof navmesh?.isWalkable !== 'function' || typeof navmesh.findPath !== 'function')) {
    throw new TypeError('createPathFollower navmesh must come from createNavmesh (it needs isWalkable, heightAt and findPath).');
  }
  const settings = {
    parameter: options.parameter ?? DEFAULTS.parameter,
    cruiseSpeed: positive(options.cruiseSpeed, DEFAULTS.cruiseSpeed, 'cruiseSpeed', NPC_FOLLOWER_LIMITS.maximumSpeed),
    acceleration: positive(options.acceleration, DEFAULTS.acceleration, 'acceleration'),
    turnRate: positive(options.turnRate, DEFAULTS.turnRate, 'turnRate'),
    arrivalRadius: positive(options.arrivalRadius, DEFAULTS.arrivalRadius, 'arrivalRadius'),
    slowRadius: positive(options.slowRadius, DEFAULTS.slowRadius, 'slowRadius'),
    cornerRadius: positive(options.cornerRadius, DEFAULTS.cornerRadius, 'cornerRadius'),
    cornerSlowDistance: positive(options.cornerSlowDistance, DEFAULTS.cornerSlowDistance, 'cornerSlowDistance'),
    minimumSpeed: positive(options.minimumSpeed, DEFAULTS.minimumSpeed, 'minimumSpeed'),
  };
  if (settings.minimumSpeed > settings.cruiseSpeed) throw new RangeError('createPathFollower minimumSpeed must not exceed cruiseSpeed.');
  graph.rootMotion; // Throws and says how to enable it when the graph has no rootMotion option.
  graph.get(settings.parameter); // Throws with the parameter names when the graph has no such parameter.

  const state = {
    position: [...position],
    yaw: options.yaw ?? 0,
    speed: 0,
    status: 'idle', // 'idle' | 'moving' | 'arrived'
    waypointIndex: 0,
    blockedSteps: 0,
    lastMove: 0, // Metres moved in the last step.
  };
  let waypoints = [];

  function groundHeight(x, z, fallback) {
    return navmesh?.heightAt?.(x, z) ?? fallback;
  }

  function distanceTo(point) {
    return Math.hypot(point[0] - state.position[0], point[2] - state.position[2]);
  }

  function turnAngleAt(index) {
    if (index + 1 >= waypoints.length) return 0;
    const before = waypoints[index - 1];
    const here = waypoints[index];
    const after = waypoints[index + 1];
    const incoming = Math.atan2(here[0] - before[0], here[2] - before[2]);
    const outgoing = Math.atan2(after[0] - here[0], after[2] - here[2]);
    return Math.abs(wrapAngle(outgoing - incoming));
  }

  // Faster on the straight, slower toward a sharp corner, slowest into the goal.
  function speedLimit(headingError) {
    const index = state.waypointIndex;
    const isLast = index === waypoints.length - 1;
    let limit = settings.cruiseSpeed;
    if (isLast) {
      limit = Math.min(limit, settings.cruiseSpeed * distanceTo(waypoints[index]) / settings.slowRadius);
    } else {
      const sharpness = turnAngleAt(index) / Math.PI;
      const cornerSpeed = settings.cruiseSpeed * (1 - sharpness);
      const nearness = clamp(distanceTo(waypoints[index]) / settings.cornerSlowDistance, 0, 1);
      limit = Math.min(limit, cornerSpeed + (settings.cruiseSpeed - cornerSpeed) * nearness);
    }
    limit = Math.max(limit, settings.minimumSpeed);
    return limit * clamp(Math.cos(headingError), 0, 1);
  }

  function arrive() {
    state.status = 'arrived';
    state.speed = 0;
    graph.set(settings.parameter, 0);
  }

  function hasPassed(index) {
    const before = waypoints[index - 1];
    const target = waypoints[index];
    const alongX = target[0] - before[0];
    const alongZ = target[2] - before[2];
    return (target[0] - state.position[0]) * alongX + (target[2] - state.position[2]) * alongZ <= 0;
  }

  function advanceWaypoint() {
    while (state.waypointIndex < waypoints.length) {
      const target = waypoints[state.waypointIndex];
      const isLast = state.waypointIndex === waypoints.length - 1;
      if (isLast) {
        if (distanceTo(target) > settings.arrivalRadius) return true;
        arrive();
        return false;
      }
      // A corner counts as reached when close enough or already passed, so the NPC rounds it on the outside and not through the obstacle.
      if (distanceTo(target) > settings.cornerRadius && !hasPassed(state.waypointIndex)) return true;
      state.waypointIndex += 1;
    }
    return false;
  }

  function steer(stepSeconds) {
    const target = waypoints[state.waypointIndex];
    const wantedYaw = Math.atan2(target[0] - state.position[0], -(target[2] - state.position[2]));
    const headingError = wrapAngle(wantedYaw - state.yaw);
    const turn = settings.turnRate * stepSeconds;
    state.yaw = wrapAngle(state.yaw + clamp(headingError, -turn, turn));
    const wantedSpeed = speedLimit(wrapAngle(wantedYaw - state.yaw));
    const change = settings.acceleration * stepSeconds;
    state.speed += clamp(wantedSpeed - state.speed, -change, change);
    graph.set(settings.parameter, state.speed);
  }

  // The graph's travel of the last step (x right, negative z forward) turned into the world by the NPC's yaw, as the player does.
  function moveByRootMotion() {
    const travel = graph.rootMotion.delta;
    const forwardX = Math.sin(state.yaw);
    const forwardZ = -Math.cos(state.yaw);
    const rightX = Math.cos(state.yaw);
    const rightZ = Math.sin(state.yaw);
    const moveX = rightX * travel[0] - forwardX * travel[1];
    const moveZ = rightZ * travel[0] - forwardZ * travel[1];
    const [currentX, currentY, currentZ] = state.position;
    const attempts = [[moveX, moveZ], [moveX, 0], [0, moveZ]];
    state.lastMove = 0;
    for (const [attemptX, attemptZ] of attempts) {
      const nextX = currentX + attemptX;
      const nextZ = currentZ + attemptZ;
      const walkable = navmesh ? navmesh.isWalkable(nextX, nextZ) : true;
      if (!walkable || Math.hypot(attemptX, attemptZ) < BLOCKED_PROBE_EPSILON) continue;
      state.position = [nextX, groundHeight(nextX, nextZ, currentY), nextZ];
      state.lastMove = Math.hypot(attemptX, attemptZ);
      if (attemptX !== moveX || attemptZ !== moveZ) state.blockedSteps += 1;
      return;
    }
    if (Math.hypot(moveX, moveZ) >= BLOCKED_PROBE_EPSILON) state.blockedSteps += 1;
  }

  const follower = {
    state,

    // Starts walking a list of [x, z] or [x, y, z] points, or the result of navmesh.findPath. The first point is where it stands.
    follow(path) {
      // The route starts where the NPC stands, so every waypoint after it has a segment behind it.
      const points = readPath(path).map(point => [point[0], point[1] ?? state.position[1], point[2]]);
      waypoints = [[...state.position], ...points];
      state.waypointIndex = 1;
      state.status = 'moving';
      state.blockedSteps = 0;
      return follower;
    },

    // Finds a route over the navmesh to [x, z] and follows it.
    goTo(goal) {
      if (!navmesh) throw new TypeError('follower.goTo needs the navmesh option, such as createPathFollower({ graph, navmesh }). Use follower.follow(points) for any other path.');
      const route = navmesh.findPath([state.position[0], state.position[2]], goal, { spacing: 1e6 });
      return follower.follow(route);
    },

    // Stops at once: the speed parameter goes to 0 and the graph blends back to idle.
    stop() {
      waypoints = [];
      state.status = 'idle';
      state.speed = 0;
      graph.set(settings.parameter, 0);
      return follower;
    },

    // One step: move by the root motion of the last graph step, then pick the heading and the speed for the next one.
    // Put it before graph.system() so the graph advances with the new speed.
    step(stepSeconds) {
      if (!Number.isFinite(stepSeconds) || stepSeconds <= 0) throw new RangeError(`follower.step stepSeconds must be a number above 0, got ${describe(stepSeconds)}.`);
      state.lastMove = 0;
      if (state.status !== 'moving') return follower;
      moveByRootMotion();
      if (advanceWaypoint()) steer(stepSeconds);
      return follower;
    },

    system({ name = 'npc-follower' } = {}) {
      return {
        name,
        fixedUpdate(stepSeconds) {
          follower.step(stepSeconds);
        },
        update(deltaSeconds, context) {
          if (context.mode === 'variable') follower.step(deltaSeconds);
        },
      };
    },
  };
  return follower;
}
