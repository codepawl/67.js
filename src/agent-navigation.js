// The path query of scene_inspect: a route over a ground node that goes around holes and obstacles, returned as
// keyframes that can go straight into a node translation track. It loads on demand, so the scene entry does not carry it.
import { createNavmesh } from './navmesh.js';
import { invalidField } from './field-error.js';

export const NAVIGATION_FIELDS = ['ground', 'from', 'to', 'avoid', 'radius', 'maxSlope', 'cellSize', 'seconds', 'speed', 'lift', 'spacing'];

const DEFAULT_WALKING_SPEED = 1.4;
const MAXIMUM_LIFT = 100;

function rounded(value) {
  return Math.round(value * 1000) / 1000;
}

function numberOption(value, label, minimum, maximum) {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw invalidField(`path.${label}`, value, `a number from ${minimum} to ${maximum}, such as ${Math.min(Math.max(1, minimum), maximum)}`);
  }
  return value;
}

/**
 * `query` is the path option of scene_inspect. `ground` is { positions, indices } in world space and `avoidBounds`
 * the world bounds ({ min, max }) of the nodes to walk around; the scene resolves node IDs into both.
 */
export function queryAgentPath(query, ground, avoidBounds) {
  const seconds = numberOption(query.seconds, 'seconds', 0.1, 600);
  const speed = numberOption(query.speed, 'speed', 0.01, 100);
  if (seconds !== undefined && speed !== undefined) throw invalidField('path.speed', speed, 'speed or seconds, not both; leave speed out when seconds is set, such as { "seconds": 4 }');
  const lift = numberOption(query.lift, 'lift', -MAXIMUM_LIFT, MAXIMUM_LIFT) ?? 0;
  const navmesh = createNavmesh({
    positions: ground.positions,
    indices: ground.indices,
    agentRadius: numberOption(query.radius, 'radius', 0.01, 100),
    maxSlopeDegrees: numberOption(query.maxSlope, 'maxSlope', 1, 89),
    cellSize: numberOption(query.cellSize, 'cellSize', 0.05, 100),
    obstacles: avoidBounds.map(bounds => ({ min: [bounds.min[0], bounds.min[2]], max: [bounds.max[0], bounds.max[2]] })),
  });
  const route = navmesh.findPath(query.from, query.to, { spacing: numberOption(query.spacing, 'spacing', 0.1, 100) });
  const duration = seconds ?? route.length / (speed ?? DEFAULT_WALKING_SPEED);
  let travelled = 0;
  const keyframes = route.points.map((point, index) => {
    if (index > 0) travelled += Math.hypot(point[0] - route.points[index - 1][0], point[2] - route.points[index - 1][2]);
    const fraction = route.length > 0 ? travelled / route.length : 0;
    return { time: rounded(duration * fraction), value: [rounded(point[0]), rounded(point[1] + lift), rounded(point[2])] };
  });
  return {
    length: rounded(route.length),
    seconds: rounded(duration),
    cellSize: navmesh.cellSize,
    agentRadius: navmesh.agentRadius,
    searchNodes: route.searchNodes,
    keyframes,
  };
}

/** The path option of scene_inspect: checks the query, resolves the ground and avoided node IDs through `nodeGeometry` and finds the route. */
export function resolvePathQuery(query, nodeGeometry, boundsFor) {
  if (query === null || typeof query !== 'object' || Array.isArray(query)) throw invalidField('path', query, 'an object such as { "ground": "floor", "from": [0, 0, 0], "to": [5, 0, 5] }', TypeError);
  for (const key of Object.keys(query)) {
    if (!NAVIGATION_FIELDS.includes(key)) throw invalidField(`path.${key}`, query[key], `a known field, one of ${NAVIGATION_FIELDS.join(', ')}`, TypeError);
  }
  if (query.avoid !== undefined && (!Array.isArray(query.avoid) || query.avoid.length > 64)) throw invalidField('path.avoid', query.avoid, 'a list of at most 64 node IDs, such as ["wall"]');
  const { geometry, worldMatrix } = nodeGeometry(query.ground, 'ground');
  const positions = new Float32Array(geometry.positions.length);
  for (let offset = 0; offset < positions.length; offset += 3) {
    for (let axis = 0; axis < 3; axis++) {
      positions[offset + axis] = worldMatrix[axis] * geometry.positions[offset] + worldMatrix[4 + axis] * geometry.positions[offset + 1]
        + worldMatrix[8 + axis] * geometry.positions[offset + 2] + worldMatrix[12 + axis];
    }
  }
  const avoidBounds = (query.avoid ?? []).map(id => {
    const avoided = nodeGeometry(id, 'avoid');
    return boundsFor(avoided.geometry, avoided.worldMatrix);
  });
  return queryAgentPath(query, { positions, indices: geometry.indices }, avoidBounds);
}
