import { MAX_FIELD_ELEMENTS, registerFieldSource } from './mesh-fields.js';
import { compileNode, constantScalar, isPlainObject, scalarValue } from './expression.js';
import { faceNormals } from './mesh-normals.js';

// Field inputs that read the shape of the mesh, and field operators that need every element at once. Both are
// registered as sources, so each takes one settings object. The topology (edges, neighbours, islands) is built once
// per mesh, in element order, so the same mesh always gives the same bytes. Edge angles are unsigned radians, 0 on a
// border; edge domain fields wait for a later change.
//
//   { "faceArea": {} }                                   area of the face; over points, the mean of the faces around
//   { "edgeAngle": {} }                                  sharpest angle between faces over the element's edges
//   { "island": {} }                                     index of the connected piece, counted by first vertex
//   { "neighbors": { "read": "edges" | "faces" } }       how many edges or faces touch the element
//   { "accumulate": { "value", "group" } }               running total in index order, restarted for each group
//   { "statistic": { "value", "mode", "group" } }        min, max, mean, sum or range over all elements or a group
//   { "blur": { "value", "iterations", "weight" } }      mix a value with the mean of its neighbours
//   { "sampleIndex": { "value", "index" } }              the value of the element another expression names
//   { "rank": { "value", "descending" } }                position of the element when sorted by the value

const MAX_BLUR_ITERATIONS = 32;
const STATISTIC_MODES = Object.freeze(['min', 'max', 'mean', 'sum', 'range']);
const NEIGHBOR_READS = Object.freeze(['edges', 'faces']);

function fieldError(message) {
  return new TypeError(`Field expression: ${message}`);
}

function onlyKeys(settings, allowed, label) {
  for (const key of Object.keys(settings)) {
    if (!allowed.includes(key)) throw fieldError(`${label} does not take ${JSON.stringify(key.slice(0, 24))}; fields: ${allowed.join(', ') || 'none'}.`);
  }
}

function settingsOf(node, name, allowed) {
  const settings = node[name];
  if (!isPlainObject(settings)) throw fieldError(`${name} takes an object${allowed.length ? ` { ${allowed.join(', ')} }` : ', written {}'}.`);
  onlyKeys(settings, allowed, name);
  return settings;
}

// ---------------------------------------------------------------------------------------------------------------
// Topology.

const topologies = new WeakMap();

function sortedUnique(numbers) {
  numbers.sort((left, right) => left - right);
  return numbers.filter((number, position) => position === 0 || number !== numbers[position - 1]);
}

function collectEdges(mesh) {
  const { vertexCount, faceCount, faceOffsets, cornerVertices } = mesh;
  const edgeIds = new Map();
  const edgeEnds = [];
  const edgeFaces = [];
  const cornerEdges = new Int32Array(cornerVertices.length).fill(-1);
  for (let face = 0; face < faceCount; face++) {
    const start = faceOffsets[face];
    const end = faceOffsets[face + 1];
    for (let corner = start; corner < end; corner++) {
      const from = cornerVertices[corner];
      const to = cornerVertices[corner + 1 < end ? corner + 1 : start];
      if (from === to) continue;
      const key = Math.min(from, to) * vertexCount + Math.max(from, to);
      let edge = edgeIds.get(key);
      if (edge === undefined) {
        edge = edgeEnds.length;
        edgeIds.set(key, edge);
        edgeEnds.push([from, to]);
        edgeFaces.push([]);
      }
      cornerEdges[corner] = edge;
      const faces = edgeFaces[edge];
      if (faces[faces.length - 1] !== face) faces.push(face);
    }
  }
  return { edgeEnds, edgeFaces, cornerEdges };
}

function pointNeighborLists(mesh, edgeEnds) {
  const neighbors = Array.from({ length: mesh.vertexCount }, () => []);
  for (const [from, to] of edgeEnds) {
    neighbors[from].push(to);
    neighbors[to].push(from);
  }
  return neighbors;
}

// Faces that share an edge. An edge with more than two faces joins them in face order, a chain, so the work stays linear.
function faceNeighborLists(mesh, edgeFaces) {
  const neighbors = Array.from({ length: mesh.faceCount }, () => []);
  for (const faces of edgeFaces) {
    for (let position = 1; position < faces.length; position++) {
      neighbors[faces[position - 1]].push(faces[position]);
      neighbors[faces[position]].push(faces[position - 1]);
    }
  }
  return neighbors.map(sortedUnique);
}

function incidentFaceCounts(mesh) {
  const counts = new Float64Array(mesh.vertexCount);
  const lastFace = new Int32Array(mesh.vertexCount).fill(-1);
  for (let face = 0; face < mesh.faceCount; face++) {
    for (let corner = mesh.faceOffsets[face]; corner < mesh.faceOffsets[face + 1]; corner++) {
      const vertex = mesh.cornerVertices[corner];
      if (lastFace[vertex] === face) continue;
      lastFace[vertex] = face;
      counts[vertex]++;
    }
  }
  return counts;
}

function edgeAngles(mesh, topology) {
  const { normals } = faceNormals(mesh);
  const pointAngles = new Float64Array(mesh.vertexCount);
  const edgeAngleValues = new Float64Array(topology.edgeEnds.length);
  topology.edgeFaces.forEach((faces, edge) => {
    if (faces.length !== 2) return;
    const [first, second] = faces;
    const cosine = normals[first * 3] * normals[second * 3] + normals[first * 3 + 1] * normals[second * 3 + 1] + normals[first * 3 + 2] * normals[second * 3 + 2];
    const angle = Math.acos(Math.min(1, Math.max(-1, cosine)));
    edgeAngleValues[edge] = angle;
    for (const vertex of topology.edgeEnds[edge]) pointAngles[vertex] = Math.max(pointAngles[vertex], angle);
  });
  const faceAngles = new Float64Array(mesh.faceCount);
  for (let face = 0; face < mesh.faceCount; face++) {
    for (let corner = mesh.faceOffsets[face]; corner < mesh.faceOffsets[face + 1]; corner++) {
      const edge = topology.cornerEdges[corner];
      if (edge >= 0) faceAngles[face] = Math.max(faceAngles[face], edgeAngleValues[edge]);
    }
  }
  return { point: pointAngles, face: faceAngles };
}

function findRoot(parents, vertex) {
  let root = vertex;
  while (parents[root] !== root) root = parents[root];
  let walker = vertex;
  while (parents[walker] !== root) {
    const next = parents[walker];
    parents[walker] = root;
    walker = next;
  }
  return root;
}

// Roots are always the smallest vertex of a piece, so the labels depend only on the mesh.
function islandIndices(mesh) {
  const parents = Uint32Array.from({ length: mesh.vertexCount }, (_, vertex) => vertex);
  for (let face = 0; face < mesh.faceCount; face++) {
    const start = mesh.faceOffsets[face];
    const end = mesh.faceOffsets[face + 1];
    for (let corner = start; corner < end; corner++) {
      const rootA = findRoot(parents, mesh.cornerVertices[corner]);
      const rootB = findRoot(parents, mesh.cornerVertices[corner + 1 < end ? corner + 1 : start]);
      if (rootA === rootB) continue;
      parents[Math.max(rootA, rootB)] = Math.min(rootA, rootB);
    }
  }
  return labelIslands(mesh, parents);
}

function labelIslands(mesh, parents) {
  const labels = new Map();
  const point = new Float64Array(mesh.vertexCount);
  for (let vertex = 0; vertex < mesh.vertexCount; vertex++) {
    const root = findRoot(parents, vertex);
    if (!labels.has(root)) labels.set(root, labels.size);
    point[vertex] = labels.get(root);
  }
  const face = new Float64Array(mesh.faceCount);
  for (let faceIndex = 0; faceIndex < mesh.faceCount; faceIndex++) {
    face[faceIndex] = point[mesh.cornerVertices[mesh.faceOffsets[faceIndex]]];
  }
  return { point, face };
}

function topologyOf(mesh) {
  if (!topologies.has(mesh)) {
    const topology = collectEdges(mesh);
    topology.pointNeighbors = pointNeighborLists(mesh, topology.edgeEnds);
    topology.faceNeighbors = faceNeighborLists(mesh, topology.edgeFaces);
    topologies.set(mesh, topology);
  }
  return topologies.get(mesh);
}

// The mesh and domain a context stands for; null while only validating. Point sets have no faces or edges.
function meshOf(context, label) {
  if (context.validationOnly) return null;
  if (!context.mesh) throw fieldError(`${label} reads the faces and edges of a mesh, which a point set does not have. Use it in a mesh edit, a face selection or an instance rule over a mesh.`);
  return context;
}

// ---------------------------------------------------------------------------------------------------------------
// Inputs.

function faceAreaValues(mesh, domain) {
  const { areas } = faceNormals(mesh);
  if (domain === 'face') return areas;
  const sums = new Float64Array(mesh.vertexCount);
  const counts = incidentFaceCounts(mesh);
  for (let face = 0; face < mesh.faceCount; face++) {
    for (let corner = mesh.faceOffsets[face]; corner < mesh.faceOffsets[face + 1]; corner++) sums[mesh.cornerVertices[corner]] += areas[face];
  }
  return sums.map((sum, vertex) => (counts[vertex] ? sum / counts[vertex] : 0));
}

function neighborValues(mesh, domain, read) {
  const topology = topologyOf(mesh);
  if (domain === 'point') {
    return read === 'edges' ? Float64Array.from(topology.pointNeighbors, list => list.length) : incidentFaceCounts(mesh);
  }
  if (read === 'faces') return Float64Array.from(topology.faceNeighbors, list => list.length);
  return Float64Array.from({ length: mesh.faceCount }, (_, face) => mesh.faceOffsets[face + 1] - mesh.faceOffsets[face]);
}

function meshInput(name, allowed, computeValues) {
  return (node, state) => {
    const settings = settingsOf(node, name, allowed);
    const context = meshOf(state.context, name);
    if (!context) return constantScalar(0);
    const values = computeValues(context.mesh, context.domain, settings);
    return scalarValue(index => values[index]);
  };
}

function compileNeighbors(node, state) {
  const settings = settingsOf(node, 'neighbors', ['read']);
  const read = settings.read ?? 'edges';
  if (!NEIGHBOR_READS.includes(read)) throw fieldError(`neighbors read must be one of ${NEIGHBOR_READS.join(', ')}.`);
  const context = meshOf(state.context, 'neighbors');
  if (!context) return constantScalar(0);
  const values = neighborValues(context.mesh, context.domain, read);
  return scalarValue(index => values[index]);
}

// ---------------------------------------------------------------------------------------------------------------
// Operators over every element.

function elementCount(context, label) {
  if (context.count > MAX_FIELD_ELEMENTS) throw new RangeError(`Field expression: ${context.count} elements is over the limit of ${MAX_FIELD_ELEMENTS}, so ${label} cannot run. Select fewer elements.`);
  return context.count;
}

function evaluateEverywhere(settings, key, state, depth, label, { optional = false } = {}) {
  if (settings[key] === undefined) {
    if (optional) return null;
    throw fieldError(`${label} needs "${key}": a number expression, such as {"attr":"index"}.`);
  }
  const compiled = compileNode(settings[key], state, depth + 1);
  if (compiled.kind !== 'scalar') throw fieldError(`${label} "${key}" needs a number, not a vector; read one component with x, y or z.`);
  const count = elementCount(state.context, label);
  const values = new Float64Array(count);
  for (let index = 0; index < count; index++) {
    const value = compiled.evaluate(index);
    values[index] = Number.isFinite(value) ? value : 0;
  }
  return values;
}

function groupKeys(groupValues, count) {
  return groupValues ? Array.from({ length: count }, (_, index) => Math.round(groupValues[index])) : new Array(count).fill(0);
}

function compileAccumulate(node, state, depth) {
  const settings = settingsOf(node, 'accumulate', ['value', 'group']);
  const values = evaluateEverywhere(settings, 'value', state, depth, 'accumulate');
  const keys = groupKeys(evaluateEverywhere(settings, 'group', state, depth, 'accumulate', { optional: true }), values.length);
  const totals = new Map();
  const running = new Float64Array(values.length);
  for (let index = 0; index < values.length; index++) {
    const total = (totals.get(keys[index]) ?? 0) + values[index];
    totals.set(keys[index], total);
    running[index] = total;
  }
  return scalarValue(index => running[index]);
}

function summarize(mode, group) {
  if (mode === 'mean') return group.sum / group.count;
  if (mode === 'range') return group.max - group.min;
  return group[mode];
}

function compileStatistic(node, state, depth) {
  const settings = settingsOf(node, 'statistic', ['value', 'mode', 'group']);
  const mode = settings.mode ?? 'mean';
  if (!STATISTIC_MODES.includes(mode)) throw fieldError(`statistic mode must be one of ${STATISTIC_MODES.join(', ')}.`);
  const values = evaluateEverywhere(settings, 'value', state, depth, 'statistic');
  const keys = groupKeys(evaluateEverywhere(settings, 'group', state, depth, 'statistic', { optional: true }), values.length);
  const groups = new Map();
  for (let index = 0; index < values.length; index++) {
    const group = groups.get(keys[index]) ?? { min: Infinity, max: -Infinity, sum: 0, count: 0 };
    group.min = Math.min(group.min, values[index]);
    group.max = Math.max(group.max, values[index]);
    group.sum += values[index];
    group.count++;
    groups.set(keys[index], group);
  }
  const results = Float64Array.from(keys, key => summarize(mode, groups.get(key)));
  return scalarValue(index => results[index]);
}

function compileBlur(node, state, depth) {
  const settings = settingsOf(node, 'blur', ['value', 'iterations', 'weight']);
  const iterations = settings.iterations ?? 1;
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > MAX_BLUR_ITERATIONS) throw fieldError(`blur iterations must be an integer from 1 to ${MAX_BLUR_ITERATIONS}.`);
  const weight = settings.weight ?? 1;
  if (typeof weight !== 'number' || !(weight >= 0 && weight <= 1)) throw fieldError('blur weight must be a number from 0 to 1.');
  let current = evaluateEverywhere(settings, 'value', state, depth, 'blur');
  const context = meshOf(state.context, 'blur');
  if (!context) return constantScalar(0);
  const topology = topologyOf(context.mesh);
  const neighbors = context.domain === 'point' ? topology.pointNeighbors : topology.faceNeighbors;
  for (let iteration = 0; iteration < iterations; iteration++) {
    const next = new Float64Array(current.length);
    for (let index = 0; index < current.length; index++) {
      const around = neighbors[index];
      let sum = 0;
      for (const neighbor of around) sum += current[neighbor];
      next[index] = around.length ? current[index] + (sum / around.length - current[index]) * weight : current[index];
    }
    current = next;
  }
  const blurred = current;
  return scalarValue(index => blurred[index]);
}

function compileSampleIndex(node, state, depth) {
  const settings = settingsOf(node, 'sampleIndex', ['value', 'index']);
  const values = evaluateEverywhere(settings, 'value', state, depth, 'sampleIndex');
  const indices = evaluateEverywhere(settings, 'index', state, depth, 'sampleIndex');
  const last = values.length - 1;
  return scalarValue(index => (last < 0 ? 0 : values[Math.min(last, Math.max(0, Math.round(indices[index])))]));
}

function compileRank(node, state, depth) {
  const settings = settingsOf(node, 'rank', ['value', 'descending']);
  if (settings.descending !== undefined && typeof settings.descending !== 'boolean') throw fieldError('rank descending must be true or false.');
  const values = evaluateEverywhere(settings, 'value', state, depth, 'rank');
  const direction = settings.descending ? -1 : 1;
  const order = Array.from({ length: values.length }, (_, index) => index);
  order.sort((left, right) => direction * (values[left] - values[right]) || left - right);
  const ranks = new Float64Array(values.length);
  order.forEach((element, position) => {
    ranks[element] = position;
  });
  return scalarValue(index => ranks[index]);
}

registerFieldSource('faceArea', meshInput('faceArea', [], faceAreaValues));
registerFieldSource('edgeAngle', meshInput('edgeAngle', [], (mesh, domain) => edgeAngles(mesh, topologyOf(mesh))[domain]));
registerFieldSource('island', meshInput('island', [], (mesh, domain) => islandIndices(mesh)[domain]));
registerFieldSource('neighbors', compileNeighbors);
registerFieldSource('accumulate', compileAccumulate);
registerFieldSource('statistic', compileStatistic);
registerFieldSource('blur', compileBlur);
registerFieldSource('sampleIndex', compileSampleIndex);
registerFieldSource('rank', compileRank);
