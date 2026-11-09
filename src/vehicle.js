import { mat4, vec3 } from 'gl-matrix';
import { invalidField } from './field-error.js';

// Local vehicle frame: x is left, y is up, z is forward, origin on the ground under the wheel centroid.
const FORWARD_AXES = Object.freeze({
  '+x': [1, 0, 0],
  '-x': [-1, 0, 0],
  '+z': [0, 0, 1],
  '-z': [0, 0, -1],
});
const UP_AXIS = Object.freeze([0, 1, 0]);
const DEFAULT_MAX_STEER_ANGLE = 35 * Math.PI / 180;
const MAX_BODY_ANGLE = 0.35;
const SIMULATION_STEP_SECONDS = 1 / 240;
const SETTLE_SECONDS = 2;
const PATH_SPACING_METRES = 0.1;
const MAX_PATH_SAMPLES = 20000;
const MINIMUM_SPEED_LIMIT = 0.5;

const WHEEL_WORDS = new Map([
  ['wheel', 'wheel'], ['wheels', 'wheel'],
  ['tire', 'tire'], ['tires', 'tire'], ['tyre', 'tire'], ['tyres', 'tire'],
  ['rim', 'rim'], ['rims', 'rim'], ['hub', 'rim'], ['hubcap', 'rim'], ['hubcaps', 'rim'],
]);
const NON_ROLLING_WORDS = new Set([
  'steering', 'spare', 'fender', 'fenders', 'mudguard', 'arch', 'arches', 'well', 'wells',
  'guard', 'brake', 'brakes', 'caliper', 'rotor', 'disc', 'housing', 'cover', 'shield',
]);
const CORNER_WORDS = new Map([
  ['fl', ['front', 'left']], ['fr', ['front', 'right']], ['rl', ['rear', 'left']], ['rr', ['rear', 'right']],
  ['bl', ['rear', 'left']], ['br', ['rear', 'right']], ['lf', ['front', 'left']], ['rf', ['front', 'right']],
  ['lr', ['rear', 'left']], ['lb', ['rear', 'left']], ['rb', ['rear', 'right']],
]);
const AXLE_WORDS = new Map([['front', 'front'], ['rear', 'rear'], ['back', 'rear']]);
const SIDE_WORDS = new Map([['left', 'left'], ['l', 'left'], ['right', 'right'], ['r', 'right']]);

function createMatrix() {
  return mat4.identity(new Float64Array(16));
}

function assertFinitePositive(value, path, example = '1') {
  if (!Number.isFinite(value) || value <= 0) throw invalidField(path, value, `a finite number above 0, such as ${example}`);
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function nameTokens(name) {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function cornerFromTokens(tokens) {
  let axle = null;
  let side = null;
  for (const token of tokens) {
    const corner = CORNER_WORDS.get(token);
    if (corner) {
      axle ??= corner[0];
      side ??= corner[1];
    }
    axle ??= AXLE_WORDS.get(token) ?? null;
    side ??= SIDE_WORDS.get(token) ?? null;
  }
  return { axle, side };
}

/**
 * Reports which names look like rolling wheels and which wheel-like names were rejected, so an agent can confirm.
 * Each match carries `kind` (wheel, tire or rim), `side` and `axle` when the name states them.
 */
export function findWheelCandidates(names) {
  if (!Array.isArray(names) || names.some(name => typeof name !== 'string')) {
    throw new TypeError('findWheelCandidates needs an array of name strings.');
  }
  const wheels = [];
  const rejected = [];
  names.forEach((name, index) => {
    const tokens = nameTokens(name);
    const wheelToken = tokens.find(token => WHEEL_WORDS.has(token));
    if (!wheelToken) return;
    const blocker = tokens.find(token => NON_ROLLING_WORDS.has(token));
    if (blocker) {
      rejected.push({ index, name, reason: `contains "${blocker}", which does not roll with the wheel` });
      return;
    }
    const { axle, side } = cornerFromTokens(tokens);
    const corner = axle && side ? `${axle}-${side}` : null;
    wheels.push({ index, name, kind: WHEEL_WORDS.get(wheelToken), axle, side, corner });
  });
  return { wheels, rejected };
}

function createPartsSource(parts) {
  if (!Array.isArray(parts) || parts.length === 0) {
    throw new TypeError('parts must be a non-empty array of parts with a 16-value matrix.');
  }
  const entries = parts.map((part, index) => {
    if (!part || !part.matrix || part.matrix.length !== 16) {
      throw new TypeError(`Part ${index} needs a 16-value matrix.`);
    }
    const restWorld = Float64Array.from(part.matrix);
    return {
      key: part,
      label: String(part.name ?? `part-${index}`),
      parentKey: null,
      restWorld,
      meshes: part.geometry ? [{ geometry: part.geometry, matrix: restWorld }] : [],
    };
  });
  return finishSource('parts', entries);
}

function createGraphSource(graph) {
  if (!graph || !graph.nodes || graph.nodes.length === 0) {
    throw new TypeError('graph must be a scene graph with nodes.');
  }
  const entries = Array.from(graph.nodes, node => {
    const restWorld = Float64Array.from(node.worldMatrix);
    return {
      key: node.name,
      label: node.name,
      parentKey: node.parent,
      restWorld,
      pivot: node.pivot,
      meshes: node.geometry ? [{ geometry: node.geometry, matrix: restWorld }] : [],
    };
  });
  return finishSource('graph', entries);
}

function composeNodeMatrix(metadata) {
  const matrix = createMatrix();
  mat4.fromRotationTranslationScale(matrix, metadata.rotation, metadata.translation, metadata.scale);
  return matrix;
}

function createAssetSource(asset) {
  if (!asset || !asset.nodes || !asset.parts || typeof asset.stagePose !== 'function') {
    throw new TypeError('asset must be a loadGltf result with nodes, parts and stagePose.');
  }
  const metadataById = new Map(asset.nodes.map(metadata => [metadata.id, metadata]));
  const worlds = new Map();
  function worldOf(id) {
    if (worlds.has(id)) return worlds.get(id);
    const metadata = metadataById.get(id);
    const local = composeNodeMatrix(metadata);
    const world = metadata.parent === null ? local : mat4.multiply(createMatrix(), worldOf(metadata.parent), local);
    worlds.set(id, world);
    return world;
  }
  const entries = asset.nodes.map(metadata => ({
    key: metadata.id,
    label: metadata.label,
    parentKey: metadata.parent,
    restWorld: worldOf(metadata.id),
    editable: metadata.editable,
    meshes: (metadata.meshIds ?? []).map(meshId => {
      const part = asset.parts[Number(meshId.slice(5))];
      return { geometry: part.geometry, matrix: Float64Array.from(part.matrix) };
    }),
  }));
  return finishSource('asset', entries);
}

function finishSource(kind, entries) {
  const byKey = new Map(entries.map(entry => [entry.key, entry]));
  for (const entry of entries) entry.childKeys = [];
  for (const entry of entries) {
    if (entry.parentKey !== null && byKey.has(entry.parentKey)) byKey.get(entry.parentKey).childKeys.push(entry.key);
  }
  return { kind, entries, byKey };
}

function createSource({ parts, graph, asset }) {
  const supplied = [parts, graph, asset].filter(value => value !== undefined);
  if (supplied.length !== 1) {
    throw new TypeError('createVehicleRig needs exactly one of parts, graph or asset.');
  }
  if (parts !== undefined) return createPartsSource(parts);
  if (graph !== undefined) return createGraphSource(graph);
  return createAssetSource(asset);
}

function resolveEntry(source, reference, path = 'target') {
  if (source.byKey.has(reference)) return source.byKey.get(reference);
  if (Number.isInteger(reference) && source.kind === 'parts' && source.entries[reference]) return source.entries[reference];
  if (typeof reference === 'string') {
    const matches = source.entries.filter(entry => entry.label === reference);
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) throw invalidField(path, reference, `a ${source.kind} name that is used once; this name matches ${matches.length}, such as an id from scene_inspect`);
  }
  throw invalidField(path, reference?.name ?? reference, `the name of a ${source.kind === 'parts' ? 'part' : 'node'} in the asset, such as one scene_inspect lists`);
}

function collectMeshes(source, entry, meshes = []) {
  meshes.push(...entry.meshes);
  for (const childKey of entry.childKeys) collectMeshes(source, source.byKey.get(childKey), meshes);
  return meshes;
}

function meshBounds(meshes) {
  const minimum = [Infinity, Infinity, Infinity];
  const maximum = [-Infinity, -Infinity, -Infinity];
  const point = vec3.create();
  for (const { geometry, matrix } of meshes) {
    const positions = geometry.positions;
    for (let offset = 0; offset + 2 < positions.length; offset += 3) {
      vec3.set(point, positions[offset], positions[offset + 1], positions[offset + 2]);
      vec3.transformMat4(point, point, matrix);
      for (let axis = 0; axis < 3; axis++) {
        minimum[axis] = Math.min(minimum[axis], point[axis]);
        maximum[axis] = Math.max(maximum[axis], point[axis]);
      }
    }
  }
  return Number.isFinite(minimum[0]) ? { minimum, maximum } : null;
}

function extentAlong(bounds, axisVector) {
  let extent = 0;
  for (let axis = 0; axis < 3; axis++) {
    extent += Math.abs(axisVector[axis]) * (bounds.maximum[axis] - bounds.minimum[axis]);
  }
  return extent;
}

function measureWheel(bounds, forward) {
  const center = bounds.minimum.map((value, axis) => (value + bounds.maximum[axis]) / 2);
  const radius = Math.max(extentAlong(bounds, UP_AXIS), extentAlong(bounds, forward)) / 2;
  return { center, radius };
}

function isDescendantOfAny(source, entry, keys) {
  let parentKey = entry.parentKey;
  while (parentKey !== null && source.byKey.has(parentKey)) {
    if (keys.has(parentKey)) return true;
    parentKey = source.byKey.get(parentKey).parentKey;
  }
  return false;
}

function detectWheelGroups(source, forward) {
  const labels = source.entries.map(entry => entry.label);
  const { wheels: candidates, rejected } = findWheelCandidates(labels);
  const candidateKeys = new Set(candidates.map(candidate => source.entries[candidate.index].key));
  const independent = candidates.filter(candidate => !isDescendantOfAny(source, source.entries[candidate.index], candidateKeys));
  const groups = new Map();
  const loose = [];
  for (const candidate of independent) {
    if (candidate.corner) {
      const group = groups.get(candidate.corner) ?? { id: candidate.corner, axle: candidate.axle, side: candidate.side, entries: [] };
      group.entries.push(source.entries[candidate.index]);
      groups.set(candidate.corner, group);
    } else {
      loose.push(source.entries[candidate.index]);
    }
  }
  const measured = entry => {
    const bounds = meshBounds(collectMeshes(source, entry));
    return bounds ? { entry, ...measureWheel(bounds, forward) } : { entry, center: null, radius: 0 };
  };
  const clusters = Array.from(groups.values()).map(group => {
    const largest = group.entries.map(measured).sort((first, second) => second.radius - first.radius)[0];
    return { ...group, center: largest.center, radius: largest.radius };
  });
  for (const item of loose.map(measured).sort((first, second) => second.radius - first.radius)) {
    const home = item.center && clusters.find(cluster => cluster.center && vec3.distance(cluster.center, item.center) < cluster.radius * 0.6);
    if (home) {
      home.entries.push(item.entry);
    } else {
      clusters.push({ id: `wheel-${clusters.length}`, axle: null, side: null, entries: [item.entry], center: item.center, radius: item.radius });
    }
  }
  return { groups: clusters, rejected };
}

function normalizeWheelSpec(source, spec, index) {
  const path = `wheels[${index}]`;
  const references = spec.targets ?? spec.parts ?? spec.nodes ?? [spec.target ?? spec.part ?? spec.node];
  if (!Array.isArray(references) || references.length === 0 || references.includes(undefined)) {
    throw invalidField(`${path}.node`, spec.node, 'a node, part or targets list, such as "wheel-0"', TypeError);
  }
  const entries = references.map(reference => resolveEntry(source, reference, `${path}.node`));
  return { id: spec.id ?? entries[0].label, index, entries, axle: spec.axle, side: spec.side, spec };
}

function describeWheels(source, wheelOption, forward) {
  if (wheelOption === undefined || wheelOption === 'auto') {
    const { groups, rejected } = detectWheelGroups(source, forward);
    return { described: groups.map((group, index) => ({ id: group.id, index, entries: group.entries, axle: group.axle, side: group.side, spec: {} })), rejected };
  }
  if (!Array.isArray(wheelOption)) throw invalidField('wheels', wheelOption, `"auto", or an array of wheel descriptions, such as "auto"`, TypeError);
  return { described: wheelOption.map((spec, index) => normalizeWheelSpec(source, spec, index)), rejected: [] };
}

function measureDescribedWheel(source, described, forward) {
  const bounds = meshBounds(described.entries.flatMap(entry => collectMeshes(source, entry)));
  const measured = bounds ? measureWheel(bounds, forward) : null;
  const center = described.spec.center ?? measured?.center;
  const radius = described.spec.radius ?? measured?.radius;
  if (!center || radius === undefined) {
    throw invalidField(`wheels[${described.index}].radius`, radius, 'a radius with a center, or geometry to measure them from, such as 0.35');
  }
  if (center.length !== 3 || !Array.from(center).every(Number.isFinite)) {
    throw invalidField(`wheels[${described.index}].center`, center, 'an array of 3 finite numbers, such as [0.8, 0.35, 1.2]');
  }
  assertFinitePositive(radius, `wheels[${described.index}].radius`, '0.35');
  return { ...described, center: Array.from(center), radius };
}

function createRestFrame(left, forward, anchor) {
  const frame = createMatrix();
  frame.set([...left, 0, ...UP_AXIS, 0, ...forward, 0, ...anchor, 1]);
  return frame;
}

function mean(values) {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function resolveWheelLayout(measuredWheels, forward) {
  const left = vec3.cross(vec3.create(), UP_AXIS, forward);
  const centroid = [0, 1, 2].map(axis => mean(measuredWheels.map(wheel => wheel.center[axis])));
  const anchor = vec3.scaleAndAdd(vec3.create(), centroid, UP_AXIS, -mean(measuredWheels.map(wheel => wheel.radius)));
  const restFrame = createRestFrame(left, forward, anchor);
  const inverseRestFrame = mat4.invert(createMatrix(), restFrame);
  const wheels = measuredWheels.map((wheel, index) => {
    const centerLocal = vec3.transformMat4(vec3.create(), wheel.center, inverseRestFrame);
    const side = wheel.side ?? (Math.abs(centerLocal[0]) < 1e-4 ? 'center' : centerLocal[0] > 0 ? 'left' : 'right');
    const axle = wheel.axle ?? (centerLocal[2] >= 0 ? 'front' : 'rear');
    if (!['left', 'right', 'center'].includes(side)) throw invalidField(`wheels[${wheel.index}].side`, side, 'one of left, right, center');
    if (!['front', 'rear'].includes(axle)) throw invalidField(`wheels[${wheel.index}].axle`, axle, 'one of front, rear');
    const spinSign = wheel.spec.spinSign ?? 1;
    if (spinSign !== 1 && spinSign !== -1) throw invalidField(`wheels[${wheel.index}].spinSign`, spinSign, 'one of 1, -1');
    return {
      id: wheel.id || `wheel-${index}`,
      entries: wheel.entries,
      side,
      axle,
      radius: wheel.radius,
      steerable: wheel.spec.steerable ?? axle === 'front',
      spinSign,
      centerLocal: Array.from(centerLocal),
    };
  });
  return { wheels, restFrame, inverseRestFrame };
}

function resolveWheelbase(wheels, wheelbaseOption) {
  if (wheelbaseOption !== undefined) {
    assertFinitePositive(wheelbaseOption, 'wheelbase', '2.7');
    return wheelbaseOption;
  }
  const front = wheels.filter(wheel => wheel.axle === 'front');
  const rear = wheels.filter(wheel => wheel.axle === 'rear');
  if (front.length && rear.length) {
    const distance = mean(front.map(wheel => wheel.centerLocal[2])) - mean(rear.map(wheel => wheel.centerLocal[2]));
    if (distance > 1e-6) return distance;
  }
  if (wheels.some(wheel => wheel.steerable)) {
    throw invalidField('wheelbase', undefined, 'a wheelbase in metres, such as 2.7, or wheels marked with axle front and rear so it can be measured');
  }
  return 0;
}

function resolveBodyEntries(source, bodyOption, wheels) {
  if (bodyOption !== undefined) {
    if (!Array.isArray(bodyOption) || bodyOption.length === 0) throw invalidField('body', bodyOption, 'a non-empty array of parts or nodes, such as ["body"]', TypeError);
    return bodyOption.map((reference, index) => resolveEntry(source, reference, `body[${index}]`));
  }
  const wheelKeys = new Set(wheels.flatMap(wheel => wheel.entries.map(entry => entry.key)));
  const bodyEntries = source.entries.filter(entry => !wheelKeys.has(entry.key) && !isDescendantOfAny(source, entry, wheelKeys) &&
    (source.kind === 'parts' || entry.parentKey === null));
  if (bodyEntries.length === 0) throw invalidField('body', undefined, 'a list of the body nodes, such as ["body"], since no body parts remain after removing the wheels');
  return bodyEntries;
}

function assertNoPivot(entries) {
  for (const entry of entries) {
    if (entry.pivot && entry.pivot.some(component => component !== 0)) {
      throw invalidField('body', entry.label, 'nodes with a zero pivot, since vehicle poses do not support a nonzero one; pick another node');
    }
  }
}

function transformDirection(matrix, origin, direction) {
  const tip = vec3.transformMat4(vec3.create(), vec3.add(vec3.create(), origin, direction), matrix);
  const base = vec3.transformMat4(vec3.create(), origin, matrix);
  return vec3.normalize(tip, vec3.subtract(tip, tip, base));
}

function assertVector3(value, path) {
  if (!value || value.length !== 3 || !Array.from(value).every(Number.isFinite)) throw invalidField(path, value, 'an array of 3 finite numbers, such as [0.5, 0.6, 2]', TypeError);
}

/**
 * `lights.headlights`: `[{ id, position, direction }]` in model space (direction defaults to forward).
 * `lights.tailLights`: `[{ id, part|node|targets, signal: 'brake' | 'reverse', off, on }]`, emission strengths of the lamp material.
 */
function resolveLights(source, lights = {}, inverseRestFrame, forward) {
  const headlights = (lights.headlights ?? []).map((light, index) => {
    assertVector3(light.position, `lights.headlights[${index}].position`);
    const direction = light.direction ?? forward;
    assertVector3(direction, `lights.headlights[${index}].direction`);
    const position = vec3.transformMat4(vec3.create(), light.position, inverseRestFrame);
    return {
      id: light.id ?? `headlight-${index}`,
      positionLocal: Array.from(position),
      directionLocal: Array.from(transformDirection(inverseRestFrame, light.position, direction)),
    };
  });
  const tailLights = (lights.tailLights ?? []).map((light, index) => {
    if (light.signal !== 'brake' && light.signal !== 'reverse') throw invalidField(`lights.tailLights[${index}].signal`, light.signal, 'one of brake, reverse');
    const references = light.targets ?? light.parts ?? light.nodes ?? [light.target ?? light.part ?? light.node];
    if (!Array.isArray(references) || references.length === 0 || references.includes(undefined)) {
      throw invalidField(`lights.tailLights[${index}].node`, light.node, 'a node, part or targets list, such as "tail"', TypeError);
    }
    const { off = 0, on = 4 } = light;
    if (!Number.isFinite(off) || !Number.isFinite(on) || off < 0 || on < 0) throw invalidField(`lights.tailLights[${index}].${Number.isFinite(off) && off >= 0 ? 'on' : 'off'}`, Number.isFinite(off) && off >= 0 ? on : off, 'a number of 0 or more, such as 4');
    const entries = references.map(reference => resolveEntry(source, reference, `lights.tailLights[${index}].node`));
    return { id: light.id ?? entries[0].label, signal: light.signal, entries, off, on };
  });
  return { headlights: Object.freeze(headlights), tailLights: Object.freeze(tailLights) };
}

/**
 * Describes a vehicle: a rigid body plus wheels, found in `parts`, a scene `graph` or a loaded glTF `asset`.
 * `wheels` is an array of `{ id, part|node|targets, side, axle, radius, center, steerable, spinSign }` or 'auto'.
 * `lights` adds headlight positions and tail-light parts (see `resolveLights`).
 */
export function createVehicleRig({ parts, graph, asset, body, wheels = 'auto', forwardAxis = '+z', wheelbase, maxSteerAngle = DEFAULT_MAX_STEER_ANGLE, lights } = {}) {
  const forward = FORWARD_AXES[forwardAxis];
  if (!forward) throw invalidField('forwardAxis', forwardAxis, 'one of +x, -x, +z, -z');
  assertFinitePositive(maxSteerAngle, 'maxSteerAngle', '0.6');
  const source = createSource({ parts, graph, asset });
  const { described, rejected } = describeWheels(source, wheels, forward);
  if (described.length < 2) {
    throw invalidField('wheels', described.length, 'at least 2 wheels, such as "auto" on a car with 4 wheel nodes, or a list of wheel nodes');
  }
  const measuredWheels = described.map(item => measureDescribedWheel(source, item, forward));
  const layout = resolveWheelLayout(measuredWheels, forward);
  const bodyEntries = resolveBodyEntries(source, body, layout.wheels);
  assertNoPivot([...bodyEntries, ...layout.wheels.flatMap(wheel => wheel.entries)]);
  const resolvedWheelbase = resolveWheelbase(layout.wheels, wheelbase);
  const referenceWheels = layout.wheels.some(wheel => wheel.axle === 'front') ? layout.wheels.filter(wheel => wheel.axle === 'front') : layout.wheels;
  const lateralOffsets = referenceWheels.map(wheel => wheel.centerLocal[0]);
  return Object.freeze({
    kind: source.kind,
    source,
    forwardAxis,
    wheelbase: resolvedWheelbase,
    trackWidth: Math.max(...lateralOffsets) - Math.min(...lateralOffsets),
    rearAxleZ: mean(referenceWheels.map(wheel => wheel.centerLocal[2])) - resolvedWheelbase,
    ...resolveLights(source, lights, layout.inverseRestFrame, forward),
    maxSteerAngle,
    restFrame: layout.restFrame,
    inverseRestFrame: layout.inverseRestFrame,
    bodyEntries,
    wheels: Object.freeze(layout.wheels),
    rejectedNames: rejected,
  });
}

function validatePoint(point, index) {
  if ((!Array.isArray(point) && !ArrayBuffer.isView(point)) || point.length !== 3 || !Array.from(point).every(Number.isFinite)) {
    throw invalidField(`path[${index}]`, point, 'an array of 3 finite numbers, such as [0, 0, 10]', TypeError);
  }
}

function pointsFromPath(path, pathSamples) {
  if (Array.isArray(path)) return path.map(point => Array.from(point));
  if (path && typeof path.sample === 'function' && Number.isFinite(path.duration) && path.duration > 0) {
    const points = [];
    for (let index = 0; index <= pathSamples; index++) {
      points.push(Array.from(path.sample(path.duration * index / pathSamples).eye));
    }
    return points;
  }
  throw invalidField('path', path, 'an array of [x, y, z] points, such as [[0, 0, 0], [0, 0, 10]], or a camera path with duration and sample(time)', TypeError);
}

function removeRepeatedPoints(points) {
  return points.filter((point, index) => index === 0 || vec3.distance(point, points[index - 1]) > 1e-6);
}

function centripetalPoint(points, parameters, time) {
  const blend = (first, second, firstTime, secondTime) => {
    const span = secondTime - firstTime;
    return first.map((value, axis) => (secondTime - time) / span * value + (time - firstTime) / span * second[axis]);
  };
  const [point0, point1, point2, point3] = points;
  const [time0, time1, time2, time3] = parameters;
  const first = blend(point0, point1, time0, time1);
  const second = blend(point1, point2, time1, time2);
  const third = blend(point2, point3, time2, time3);
  return blend(blend(first, second, time0, time2), blend(second, third, time1, time3), time1, time2);
}

function splinePolyline(points) {
  if (points.length === 2) return points;
  const reflected = (inner, outer) => inner.map((value, axis) => 2 * value - outer[axis]);
  const padded = [reflected(points[0], points[1]), ...points, reflected(points.at(-1), points.at(-2))];
  const polyline = [points[0]];
  for (let segment = 1; segment < padded.length - 2; segment++) {
    const control = padded.slice(segment - 1, segment + 3);
    const parameters = [0];
    for (let index = 1; index < 4; index++) {
      parameters.push(parameters[index - 1] + Math.sqrt(vec3.distance(control[index - 1], control[index])));
    }
    const count = clamp(Math.ceil(vec3.distance(control[1], control[2]) / 0.05), 8, 2000);
    for (let step = 1; step <= count; step++) {
      polyline.push(centripetalPoint(control, parameters, parameters[1] + (parameters[2] - parameters[1]) * step / count));
    }
  }
  return polyline;
}

function resampleUniformly(polyline) {
  const lengths = [0];
  for (let index = 1; index < polyline.length; index++) {
    lengths.push(lengths[index - 1] + vec3.distance(polyline[index - 1], polyline[index]));
  }
  const total = lengths.at(-1);
  if (!(total > 1e-6)) throw invalidField('path', 'a path of zero length', 'points that are not all the same, such as [[0, 0, 0], [0, 0, 10]]');
  const intervals = Math.max(2, Math.ceil(total / Math.max(PATH_SPACING_METRES, total / MAX_PATH_SAMPLES)));
  const spacing = total / intervals;
  const positions = [];
  let segment = 0;
  for (let index = 0; index <= intervals; index++) {
    const distance = index * spacing;
    while (segment < polyline.length - 2 && lengths[segment + 1] < distance) segment++;
    const span = lengths[segment + 1] - lengths[segment];
    const fraction = span > 0 ? clamp((distance - lengths[segment]) / span, 0, 1) : 0;
    positions.push(polyline[segment].map((value, axis) => value + (polyline[segment + 1][axis] - value) * fraction));
  }
  return { positions, spacing, length: total };
}

function smoothed(values, radius) {
  return values.map((_, index) => {
    const first = Math.max(0, index - radius);
    const last = Math.min(values.length - 1, index + radius);
    let total = 0;
    for (let neighbour = first; neighbour <= last; neighbour++) total += values[neighbour];
    return total / (last - first + 1);
  });
}

function buildPathTable(path, pathSamples) {
  const points = pointsFromPath(path, pathSamples);
  points.forEach((point, index) => validatePoint(point, index));
  const distinct = removeRepeatedPoints(points);
  if (distinct.length < 2) throw invalidField('path', `${distinct.length} distinct point`, 'at least 2 distinct points, such as [[0, 0, 0], [0, 0, 10]]');
  const { positions, spacing, length } = resampleUniformly(splinePolyline(distinct));
  const headings = [];
  const slopes = [];
  positions.forEach((_, index) => {
    const before = positions[Math.max(0, index - 1)];
    const after = positions[Math.min(positions.length - 1, index + 1)];
    const horizontal = Math.hypot(after[0] - before[0], after[2] - before[2]);
    let heading = horizontal > 1e-9 ? Math.atan2(after[0] - before[0], after[2] - before[2]) : (headings.at(-1) ?? 0);
    if (index > 0) heading += Math.round((headings[index - 1] - heading) / (2 * Math.PI)) * 2 * Math.PI;
    headings.push(heading);
    slopes.push(horizontal > 1e-9 ? Math.atan2(after[1] - before[1], horizontal) : 0);
  });
  const rawCurvature = headings.map((heading, index) => {
    const before = Math.max(0, index - 1);
    const after = Math.min(headings.length - 1, index + 1);
    return (headings[after] - headings[before]) / ((after - before) * spacing);
  });
  return { positions, headings, slopes, curvature: smoothed(rawCurvature, 5), spacing, length };
}

function createSpeedProfile(table, options) {
  const { cruiseSpeed, acceleration, braking, startSpeed, endSpeed, maxLateralAcceleration } = options;
  const count = table.positions.length;
  const limitSquared = table.curvature.map(curvature => {
    const lateralLimit = maxLateralAcceleration / Math.max(Math.abs(curvature), 1e-9);
    return Math.min(cruiseSpeed ** 2, Math.max(lateralLimit, MINIMUM_SPEED_LIMIT ** 2));
  });
  const speedSquared = Float64Array.from(limitSquared);
  speedSquared[0] = Math.min(startSpeed ** 2, limitSquared[0]);
  for (let index = 1; index < count; index++) {
    speedSquared[index] = Math.min(speedSquared[index], speedSquared[index - 1] + 2 * acceleration * table.spacing);
  }
  speedSquared[count - 1] = Math.min(speedSquared[count - 1], endSpeed ** 2);
  for (let index = count - 2; index >= 0; index--) {
    speedSquared[index] = Math.min(speedSquared[index], speedSquared[index + 1] + 2 * braking * table.spacing);
  }
  const speeds = speedSquared.map(Math.sqrt);
  const times = new Float64Array(count);
  for (let index = 1; index < count; index++) {
    const meanSpeed = (speeds[index - 1] + speeds[index]) / 2;
    if (meanSpeed < 1e-9) throw invalidField('acceleration', 'a speed profile that never leaves rest', 'a higher acceleration or startSpeed, such as acceleration 3');
    times[index] = times[index - 1] + table.spacing / meanSpeed;
  }
  return { speeds, times, duration: times[count - 1] };
}

function findInterval(times, time) {
  let low = 0;
  let high = times.length - 1;
  while (high - low > 1) {
    const middle = (low + high) >> 1;
    if (times[middle] <= time) low = middle;
    else high = middle;
  }
  return low;
}

function createMotion(table, options) {
  const startTime = options.startTime;
  if (options.speed !== undefined) {
    const duration = table.length / options.speed;
    return {
      duration: startTime + duration,
      distanceAt: time => clamp((time - startTime) * options.speed, 0, table.length),
      speedAt: time => (time > startTime && time < startTime + duration ? options.speed : 0),
      accelerationAt: () => 0,
    };
  }
  const profile = createSpeedProfile(table, options);
  const spacing = table.spacing;
  function intervalAt(time) {
    const index = findInterval(profile.times, time);
    const startSpeedSquared = profile.speeds[index] ** 2;
    const endSpeedSquared = profile.speeds[index + 1] ** 2;
    return { index, elapsed: time - profile.times[index], acceleration: (endSpeedSquared - startSpeedSquared) / (2 * spacing) };
  }
  return {
    duration: startTime + profile.duration,
    distanceAt(time) {
      const local = time - startTime;
      if (local <= 0) return 0;
      if (local >= profile.duration) return table.length;
      const { index, elapsed, acceleration } = intervalAt(local);
      return index * spacing + profile.speeds[index] * elapsed + 0.5 * acceleration * elapsed ** 2;
    },
    speedAt(time) {
      const local = time - startTime;
      if (local <= 0 || local >= profile.duration) return 0;
      const { index, elapsed, acceleration } = intervalAt(local);
      return Math.max(0, profile.speeds[index] + acceleration * elapsed);
    },
    accelerationAt(time) {
      const local = time - startTime;
      if (local <= 0 || local >= profile.duration) return 0;
      return intervalAt(local).acceleration;
    },
  };
}

function interpolateTable(values, spacing, distance) {
  const position = clamp(distance / spacing, 0, values.length - 1);
  const index = Math.min(Math.floor(position), values.length - 2);
  const fraction = position - index;
  const first = values[index];
  const second = values[index + 1];
  return Array.isArray(first) ? first.map((value, axis) => value + (second[axis] - value) * fraction) : first + (second - first) * fraction;
}

// The timeline gives the signed forward speed and the curvature per metre driven forward at any time.
function integrateBodyMotion(timeline, options) {
  const steps = Math.ceil((timeline.duration + SETTLE_SECONDS) / SIMULATION_STEP_SECONDS) + 1;
  const pitches = new Float64Array(steps);
  const rolls = new Float64Array(steps);
  const omega = 2 * Math.PI * options.bounceFrequency;
  const damping = 2 * options.dampingRatio * omega;
  let pitch = 0;
  let roll = 0;
  let pitchRate = 0;
  let rollRate = 0;
  for (let step = 0; step < steps; step++) {
    const time = step * SIMULATION_STEP_SECONDS;
    const speed = timeline.signedSpeedAt(time);
    const longitudinal = (timeline.signedSpeedAt(time + SIMULATION_STEP_SECONDS) - timeline.signedSpeedAt(time - SIMULATION_STEP_SECONDS)) / (2 * SIMULATION_STEP_SECONDS);
    const curvature = timeline.curvatureAt(time);
    const pitchTarget = clamp(options.pitchGain * longitudinal, -MAX_BODY_ANGLE, MAX_BODY_ANGLE);
    const rollTarget = clamp(options.rollGain * speed * speed * curvature, -MAX_BODY_ANGLE, MAX_BODY_ANGLE);
    pitchRate += (omega ** 2 * (pitchTarget - pitch) - damping * pitchRate) * SIMULATION_STEP_SECONDS;
    rollRate += (omega ** 2 * (rollTarget - roll) - damping * rollRate) * SIMULATION_STEP_SECONDS;
    pitch += pitchRate * SIMULATION_STEP_SECONDS;
    roll += rollRate * SIMULATION_STEP_SECONDS;
    pitches[step] = pitch;
    rolls[step] = roll;
  }
  return { pitches, rolls };
}

function groundPlane(rig, position, heading, groundHeight) {
  const cosine = Math.cos(heading);
  const sine = Math.sin(heading);
  const samples = rig.wheels.map(wheel => {
    const [left, , forward] = wheel.centerLocal;
    const x = position[0] + left * cosine + forward * sine;
    const z = position[2] - left * sine + forward * cosine;
    return { left, forward, height: readGroundHeight(groundHeight, x, z) };
  });
  const meanLeft = mean(samples.map(sample => sample.left));
  const meanForward = mean(samples.map(sample => sample.forward));
  const meanHeight = mean(samples.map(sample => sample.height));
  let leftLeft = 0;
  let forwardForward = 0;
  let leftForward = 0;
  let leftHeight = 0;
  let forwardHeight = 0;
  for (const sample of samples) {
    const left = sample.left - meanLeft;
    const forward = sample.forward - meanForward;
    const height = sample.height - meanHeight;
    leftLeft += left * left;
    forwardForward += forward * forward;
    leftForward += left * forward;
    leftHeight += left * height;
    forwardHeight += forward * height;
  }
  const determinant = leftLeft * forwardForward - leftForward ** 2;
  const wellPosed = determinant > 1e-9 * Math.max(1, leftLeft * forwardForward);
  const leftSlope = wellPosed ? (leftHeight * forwardForward - forwardHeight * leftForward) / determinant : 0;
  const forwardSlope = wellPosed ? (forwardHeight * leftLeft - leftHeight * leftForward) / determinant : 0;
  return {
    height: meanHeight - leftSlope * meanLeft - forwardSlope * meanForward,
    pitch: Math.atan(forwardSlope),
    roll: Math.atan(leftSlope),
  };
}

function readGroundHeight(groundHeight, x, z) {
  const height = groundHeight(x, z);
  if (!Number.isFinite(height)) throw new TypeError('groundHeight must return a finite number.');
  return height;
}

function bodyWorldMatrix(position, heading, pitch, roll) {
  const matrix = mat4.fromTranslation(createMatrix(), position);
  mat4.rotateY(matrix, matrix, heading);
  mat4.rotateX(matrix, matrix, -pitch);
  mat4.rotateZ(matrix, matrix, roll);
  return matrix;
}

function suspensionOffsets(rig, bodyMatrix, groundHeight, travel) {
  const point = vec3.create();
  const uprightness = Math.max(0.5, bodyMatrix[5]);
  return rig.wheels.map(wheel => {
    if (!groundHeight) return 0;
    vec3.transformMat4(point, wheel.centerLocal, bodyMatrix);
    const wanted = readGroundHeight(groundHeight, point[0], point[2]) + wheel.radius;
    return clamp((wanted - point[1]) / uprightness, -travel, travel);
  });
}

/**
 * Builds a deterministic drive along a path. `sample(seconds)` returns the same pose for the same time.
 * Speed is `speed` (constant, m/s) or a profile: `cruiseSpeed`, `acceleration`, `braking`, `startSpeed`, `endSpeed`,
 * `maxLateralAcceleration`. The vehicle holds the path end once it arrives.
 */
export function driveAlongPath(rig, path, options = {}) {
  return driveAlongLegs(rig, [{ path }], options);
}

function buildLegs(legDescriptions, settings) {
  const legs = [];
  legDescriptions.forEach((description, index) => {
    const { path, direction = 'forward', pause = 0 } = description ?? {};
    if (direction !== 'forward' && direction !== 'reverse') throw invalidField(`legs[${index}].direction`, direction, 'one of forward, reverse');
    if (!Number.isFinite(pause) || pause < 0) throw invalidField(`legs[${index}].pause`, pause, 'seconds of 0 or more, such as 2');
    const previous = legs.at(-1);
    const sign = direction === 'reverse' ? -1 : 1;
    const startTime = previous ? previous.endTime + pause : settings.startTime;
    const table = buildPathTable(path, settings.pathSamples);
    // Every leg stops at both ends except the outer ones, which keep startSpeed and endSpeed.
    const motion = createMotion(table, {
      ...settings,
      startTime,
      startSpeed: previous ? 0 : settings.startSpeed,
      endSpeed: index === legDescriptions.length - 1 ? settings.endSpeed : 0,
    });
    // A reversing car faces away from its direction of travel. The shift also keeps the heading continuous at a cusp.
    let headingShift = direction === 'reverse' ? Math.PI : 0;
    if (previous) {
      const previousEnd = previous.headingShift + previous.table.headings.at(-1);
      headingShift += Math.round((previousEnd - table.headings[0] - headingShift) / (2 * Math.PI)) * 2 * Math.PI;
    }
    legs.push({
      table,
      motion,
      sign,
      startTime,
      endTime: motion.duration,
      headingShift,
      startForwardDistance: previous ? previous.startForwardDistance + previous.sign * previous.table.length : 0,
      startHeadingChange: previous ? previous.startHeadingChange + previous.table.headings.at(-1) - previous.table.headings[0] : 0,
    });
  });
  return legs;
}

/**
 * Like `driveAlongPath` for a list of legs `[{ path, direction: 'forward' | 'reverse', pause }]` driven in order.
 * The vehicle stops at the end of every leg. A reverse leg's path is the way the car travels; the car keeps facing the other way.
 * `pose.distance` and `pose.speed` are signed along the car's forward axis, so they fall while reversing.
 */
export function driveAlongLegs(rig, legDescriptions, options = {}) {
  if (!rig || !rig.wheels || !rig.restFrame) throw new TypeError('driveAlongPath needs a rig from createVehicleRig.');
  if (!Array.isArray(legDescriptions) || legDescriptions.length === 0) throw invalidField('legs', legDescriptions, 'a non-empty array of { path, direction, pause }, such as [{ "path": [[0, 0, 0], [0, 0, 10]] }]', TypeError);
  const settings = resolveDriveOptions(rig, options);
  const legs = buildLegs(legDescriptions, settings);
  const duration = legs.at(-1).endTime;
  const length = legs.reduce((total, leg) => total + leg.table.length, 0);
  const legAt = time => legs.findLast(leg => leg.startTime <= time) ?? legs[0];
  const timeline = {
    duration,
    signedSpeedAt(time) {
      const leg = legAt(time);
      return leg.sign * leg.motion.speedAt(time);
    },
    curvatureAt(time) {
      const leg = legAt(time);
      return leg.sign * interpolateTable(leg.table.curvature, leg.table.spacing, leg.motion.distanceAt(time));
    },
  };
  const dynamics = integrateBodyMotion(timeline, settings);
  const maxSteer = settings.maxSteerAngle;

  function sample(seconds) {
    if (!Number.isFinite(seconds)) throw new RangeError('Sample time must be finite.');
    const leg = legAt(seconds);
    const { table, motion, sign } = leg;
    const legDistance = motion.distanceAt(seconds);
    const distance = leg.startForwardDistance + sign * legDistance;
    const tableHeading = interpolateTable(table.headings, table.spacing, legDistance);
    const heading = tableHeading + leg.headingShift;
    const curvature = sign * interpolateTable(table.curvature, table.spacing, legDistance);
    const headingChange = leg.startHeadingChange + tableHeading - table.headings[0];
    const dynamicIndex = clamp(seconds, 0, (dynamics.pitches.length - 1) * SIMULATION_STEP_SECONDS) / SIMULATION_STEP_SECONDS;
    const lower = Math.min(Math.floor(dynamicIndex), dynamics.pitches.length - 2);
    const blend = dynamicIndex - lower;
    const dynamicPitch = dynamics.pitches[lower] + (dynamics.pitches[lower + 1] - dynamics.pitches[lower]) * blend;
    const dynamicRoll = dynamics.rolls[lower] + (dynamics.rolls[lower + 1] - dynamics.rolls[lower]) * blend;
    const position = interpolateTable(table.positions, table.spacing, legDistance);
    let slopePitch = sign * interpolateTable(table.slopes, table.spacing, legDistance);
    let slopeRoll = 0;
    if (settings.groundHeight) {
      const plane = groundPlane(rig, position, heading, settings.groundHeight);
      position[1] = plane.height;
      slopePitch = plane.pitch;
      slopeRoll = plane.roll;
    }
    const pitch = slopePitch + dynamicPitch;
    const roll = slopeRoll + dynamicRoll;
    const bodyMatrix = bodyWorldMatrix(position, heading, pitch, roll);
    const offsets = suspensionOffsets(rig, bodyMatrix, settings.groundHeight, settings.suspensionTravel);
    const steerAngle = clamp(Math.atan(rig.wheelbase * curvature), -maxSteer, maxSteer);
    const wheelSteerAngles = settings.steering === 'ackermann' ? ackermannSteerAngles(rig, steerAngle) : null;
    const speed = sign * motion.speedAt(seconds);
    return {
      time: seconds,
      distance,
      speed,
      direction: sign,
      position,
      heading,
      pitch,
      roll,
      steerAngle,
      wheels: rig.wheels.map((wheel, index) => ({
        id: wheel.id,
        spinAngle: wheel.spinSign * (distance - wheel.centerLocal[0] * headingChange) / wheel.radius,
        steerAngle: wheelSteerAngles ? wheelSteerAngles[index] : wheel.steerable ? steerAngle : 0,
        suspensionOffset: offsets[index],
      })),
      lights: computeLightSignals(rig, bodyMatrix, {
        braking: Math.max(0, -motion.accelerationAt(seconds)) / settings.fullBrakeDeceleration,
        reversing: sign < 0 && speed !== 0,
      }),
    };
  }

  return Object.freeze({ rig, length, duration, sample });
}

function resolveDriveOptions(rig, options) {
  const {
    speed, cruiseSpeed, acceleration = 3, braking = 4, startSpeed = 0, endSpeed = 0, maxLateralAcceleration = Infinity,
    startTime = 0, groundHeight, maxSteerAngle = rig.maxSteerAngle, rollGain = 0.012, pitchGain = 0.012,
    bounceFrequency = 1.6, dampingRatio = 0.45, suspensionTravel = 0.2, pathSamples = 400,
    steering = 'ackermann', fullBrakeDeceleration = braking,
  } = options;
  if (steering !== 'ackermann' && steering !== 'shared') throw invalidField('steering', steering, 'one of ackermann, shared');
  assertFinitePositive(fullBrakeDeceleration, 'fullBrakeDeceleration', '4');
  if ((speed === undefined) === (cruiseSpeed === undefined)) {
    throw invalidField(speed === undefined ? 'speed' : 'cruiseSpeed', speed ?? cruiseSpeed, 'exactly one of speed (constant) or cruiseSpeed (with acceleration and braking), such as speed 8', TypeError);
  }
  if (speed !== undefined) assertFinitePositive(speed, 'speed', '8');
  if (cruiseSpeed !== undefined) {
    assertFinitePositive(cruiseSpeed, 'cruiseSpeed', '8');
    assertFinitePositive(acceleration, 'acceleration', '3');
    assertFinitePositive(braking, 'braking', '4');
  }
  if (!Number.isFinite(startTime) || startTime < 0) throw invalidField('startTime', startTime, 'seconds of 0 or more, such as 0');
  if (groundHeight !== undefined && typeof groundHeight !== 'function') throw new TypeError('groundHeight must be a function (x, z) => height.');
  assertFinitePositive(maxSteerAngle, 'maxSteerAngle', '0.6');
  assertFinitePositive(bounceFrequency, 'bounceFrequency', '1.6');
  assertFinitePositive(dampingRatio, 'dampingRatio', '0.45');
  if (!Number.isFinite(startSpeed) || startSpeed < 0 || !Number.isFinite(endSpeed) || endSpeed < 0) {
    const badSpeedField = !Number.isFinite(startSpeed) || startSpeed < 0 ? 'startSpeed' : 'endSpeed';
    throw invalidField(badSpeedField, badSpeedField === 'startSpeed' ? startSpeed : endSpeed, 'a speed of 0 or more, such as 0');
  }
  if (!(maxLateralAcceleration > 0)) throw invalidField('maxLateralAcceleration', maxLateralAcceleration, 'a number above 0, such as 6');
  if (!Number.isInteger(pathSamples) || pathSamples < 8) throw invalidField('pathSamples', pathSamples, 'a whole number of 8 or more, such as 400');
  return {
    speed, cruiseSpeed, acceleration, braking, startSpeed, endSpeed, maxLateralAcceleration, startTime, groundHeight,
    maxSteerAngle, rollGain, pitchGain, bounceFrequency, dampingRatio, suspensionTravel, pathSamples, steering, fullBrakeDeceleration,
  };
}

// Each steerable wheel turns about the one centre the body turns about: tan(angle) = ahead / (turning radius - sideways).
function ackermannSteerAngles(rig, centerAngle) {
  const tangent = Math.tan(centerAngle);
  return rig.wheels.map(wheel => {
    if (!wheel.steerable) return 0;
    const ahead = wheel.centerLocal[2] - rig.rearAxleZ;
    return Math.atan2(ahead * tangent, rig.wheelbase - wheel.centerLocal[0] * tangent);
  });
}

function computeLightSignals(rig, bodyMatrix, { braking, reversing }) {
  return {
    brake: clamp(braking, 0, 1),
    reverse: reversing ? 1 : 0,
    headlights: rig.headlights.map(light => ({
      id: light.id,
      position: Array.from(vec3.transformMat4(vec3.create(), light.positionLocal, bodyMatrix)),
      direction: Array.from(transformDirection(bodyMatrix, light.positionLocal, light.directionLocal)),
    })),
  };
}

/** Emission strength per tail light for a pose: `off` plus `(on - off)` times the brake or reverse signal. */
export function computeVehicleLightEmissions(rig, pose) {
  if (!pose || !pose.lights) throw new TypeError('pose must come from drive.sample for this rig.');
  return rig.tailLights.map(light => ({
    id: light.id,
    emission: light.off + (light.on - light.off) * pose.lights[light.signal],
    entries: light.entries,
  }));
}

/**
 * Sets `material.emission` on the parts of every tail light for a rig built from `parts`. Give each lamp its own material:
 * parts that share one material share the glow. Call `renderer.updateParts` afterwards. Returns the parts changed.
 */
export function applyVehicleLightsToParts(rig, pose) {
  assertKind(rig, 'parts');
  const changed = [];
  for (const { id, emission, entries } of computeVehicleLightEmissions(rig, pose)) {
    for (const { key: part } of entries) {
      if (!part.material) throw new TypeError(`Tail light ${id} part needs a material to set emission on.`);
      part.material.emission = emission;
      changed.push(part);
    }
  }
  return changed;
}

function wheelMotionMatrix(wheel, wheelPose) {
  const matrix = mat4.fromTranslation(createMatrix(), [0, wheelPose.suspensionOffset, 0]);
  mat4.translate(matrix, matrix, wheel.centerLocal);
  mat4.rotateY(matrix, matrix, wheelPose.steerAngle);
  mat4.rotateX(matrix, matrix, wheelPose.spinAngle);
  mat4.translate(matrix, matrix, wheel.centerLocal.map(value => -value));
  return matrix;
}

/** World matrices for every moved entry, keyed by the entry key (part object, node name or glTF node id). */
function computeTargetWorlds(rig, pose) {
  if (!pose || !Array.isArray(pose.wheels) || pose.wheels.length !== rig.wheels.length) {
    throw new TypeError('pose must come from drive.sample for this rig.');
  }
  const bodyMatrix = bodyWorldMatrix(pose.position, pose.heading, pose.pitch, pose.roll);
  const bodyFromModel = mat4.multiply(createMatrix(), bodyMatrix, rig.inverseRestFrame);
  const worlds = new Map();
  for (const entry of rig.bodyEntries) {
    worlds.set(entry.key, mat4.multiply(createMatrix(), bodyFromModel, entry.restWorld));
  }
  rig.wheels.forEach((wheel, index) => {
    const wheelFromModel = mat4.multiply(createMatrix(), bodyMatrix, wheelMotionMatrix(wheel, pose.wheels[index]));
    mat4.multiply(wheelFromModel, wheelFromModel, rig.inverseRestFrame);
    for (const entry of wheel.entries) {
      worlds.set(entry.key, mat4.multiply(createMatrix(), wheelFromModel, entry.restWorld));
    }
  });
  return worlds;
}

function assertKind(rig, kind) {
  if (rig.kind !== kind) throw new TypeError(`This rig was built from ${rig.kind}, not ${kind}.`);
}

/** Writes sampled world matrices into the part.matrix of a rig built from `parts`. Returns the moved parts. */
export function applyVehiclePoseToParts(rig, pose) {
  assertKind(rig, 'parts');
  const worlds = computeTargetWorlds(rig, pose);
  const moved = [];
  for (const [part, world] of worlds) {
    part.matrix.set(world);
    moved.push(part);
  }
  return moved;
}

function createLocalMatrixResolver(rig, worlds) {
  const { byKey } = rig.source;
  const memo = new Map();
  function newWorld(key) {
    if (worlds.has(key)) return worlds.get(key);
    if (memo.has(key)) return memo.get(key);
    const entry = byKey.get(key);
    let world = entry.restWorld;
    if (entry.parentKey !== null && byKey.has(entry.parentKey)) {
      const parentRest = byKey.get(entry.parentKey).restWorld;
      const restLocal = mat4.multiply(createMatrix(), mat4.invert(createMatrix(), parentRest), entry.restWorld);
      world = mat4.multiply(createMatrix(), newWorld(entry.parentKey), restLocal);
    }
    memo.set(key, world);
    return world;
  }
  return function localMatrix(entry, world) {
    if (entry.parentKey === null || !byKey.has(entry.parentKey)) return Float64Array.from(world);
    const inverseParent = mat4.invert(createMatrix(), newWorld(entry.parentKey));
    return mat4.multiply(createMatrix(), inverseParent, world);
  };
}

/** Writes sampled poses into the localMatrix of scene-graph nodes and calls graph.update(). Returns graph.parts. */
export function applyVehiclePoseToSceneGraph(rig, pose, graph) {
  assertKind(rig, 'graph');
  const worlds = computeTargetWorlds(rig, pose);
  const localMatrix = createLocalMatrixResolver(rig, worlds);
  for (const [name, world] of worlds) {
    graph.getNode(name).localMatrix.set(localMatrix(rig.source.byKey.get(name), world));
  }
  return graph.update();
}

/** Node overrides for `asset.stagePose({ nodeOverrides })` on a rig built from a loadGltf asset. */
export function createVehicleNodeOverrides(rig, pose) {
  assertKind(rig, 'asset');
  const worlds = computeTargetWorlds(rig, pose);
  const localMatrix = createLocalMatrixResolver(rig, worlds);
  const overrides = [];
  for (const [id, world] of worlds) {
    const entry = rig.source.byKey.get(id);
    if (entry.editable === false) throw new RangeError(`Imported node ${entry.label} has an authored pose that cannot be overridden.`);
    const local = localMatrix(entry, world);
    overrides.push({
      id,
      translation: Array.from(mat4.getTranslation(vec3.create(), local)),
      rotation: Array.from(mat4.getRotation(new Float64Array(4), local)),
      scale: Array.from(mat4.getScaling(vec3.create(), local)),
    });
  }
  return overrides;
}

/** Stages and commits the sampled pose on a loadGltf asset, then returns what `commit()` returned. */
export function applyVehiclePoseToAsset(rig, pose, asset) {
  const staged = asset.stagePose({ nodeOverrides: createVehicleNodeOverrides(rig, pose) });
  return staged.commit();
}
