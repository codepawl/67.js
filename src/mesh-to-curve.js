// Mesh edges to curve splines: a loop or chain of selected edges becomes one poly spline, in walking order.
import { edgeFaces, selectEdges } from './mesh-bevel.js';
import { vertexGroupWeights } from './mesh-data.js';

export const MAX_CURVE_SPLINES = 64;
export const MAX_POINTS_PER_SPLINE = 1024;
export const MAX_TOTAL_CURVE_POINTS = 4096;

// The selection is one of: an edge rule of selectEdges ({ open: true }, { angle: 30 }, ...),
// { group, minWeight } (edges whose two vertices both weigh at least minWeight), or { edges: [edge indices] }.
function selectedEdgeMask(mesh, selection) {
  if (!selection || typeof selection !== 'object' || Array.isArray(selection)) {
    throw new TypeError('selection must be an object such as { "open": true }, { "group": "rim" } or { "edges": [0, 1, 2] }.');
  }
  if (selection.edges !== undefined) return maskFromEdgeList(mesh, selection);
  if (selection.group !== undefined) return maskFromGroup(mesh, selection);
  return selectEdges(mesh, selection, edgeFaces(mesh));
}

function maskFromEdgeList(mesh, selection) {
  const extra = Object.keys(selection).filter(key => key !== 'edges');
  if (extra.length) throw new TypeError(`selection.edges does not take ${extra.join(', ')}.`);
  const list = selection.edges;
  if (!Array.isArray(list) || list.length < 1 || list.length > mesh.edgeCount) {
    throw new RangeError(`selection.edges needs 1 to ${mesh.edgeCount} edge indices, such as [0, 1, 2].`);
  }
  const mask = new Uint8Array(mesh.edgeCount);
  for (const edge of list) {
    if (!Number.isInteger(edge) || edge < 0 || edge >= mesh.edgeCount) {
      throw new RangeError(`selection.edges holds ${JSON.stringify(edge)}; every index must be an integer from 0 to ${mesh.edgeCount - 1}.`);
    }
    mask[edge] = 1;
  }
  return mask;
}

function maskFromGroup(mesh, selection) {
  const extra = Object.keys(selection).filter(key => key !== 'group' && key !== 'minWeight');
  if (extra.length) throw new TypeError(`selection.group does not take ${extra.join(', ')}. Use group and minWeight.`);
  if (typeof selection.group !== 'string') throw new TypeError('selection.group must be a vertex group name such as "rim".');
  const minWeight = selection.minWeight ?? 0.5;
  if (!Number.isFinite(minWeight) || minWeight <= 0 || minWeight > 1) {
    throw new RangeError('selection.minWeight must be a number above 0 and at most 1, such as 0.5.');
  }
  const weights = vertexGroupWeights(mesh, selection.group);
  const mask = new Uint8Array(mesh.edgeCount);
  for (let edge = 0; edge < mesh.edgeCount; edge++) {
    const inGroup = weights[mesh.edgeVertices[edge * 2]] >= minWeight && weights[mesh.edgeVertices[edge * 2 + 1]] >= minWeight;
    mask[edge] = inGroup ? 1 : 0;
  }
  return mask;
}

// Neighbours of each selected vertex as [vertex, edge] pairs, sorted so the walk is the same every run.
function adjacencyOf(mesh, mask) {
  const adjacency = new Map();
  const link = (from, to, edge) => {
    if (!adjacency.has(from)) adjacency.set(from, []);
    adjacency.get(from).push([to, edge]);
  };
  for (let edge = 0; edge < mesh.edgeCount; edge++) {
    if (!mask[edge]) continue;
    const first = mesh.edgeVertices[edge * 2];
    const second = mesh.edgeVertices[edge * 2 + 1];
    link(first, second, edge);
    link(second, first, edge);
  }
  for (const neighbours of adjacency.values()) neighbours.sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  return adjacency;
}

// Follows edges from the start until the path ends, meets a junction (not two edges) or comes back to the start.
function walk(startVertex, firstStep, adjacency, usedEdges) {
  const vertices = [startVertex];
  let [vertex, edge] = firstStep;
  usedEdges.add(edge);
  vertices.push(vertex);
  while (vertex !== startVertex && adjacency.get(vertex).length === 2) {
    const next = adjacency.get(vertex).find(([, candidate]) => !usedEdges.has(candidate));
    if (!next) break;
    [vertex, edge] = next;
    usedEdges.add(edge);
    vertices.push(vertex);
  }
  return vertices;
}

function chainsOf(adjacency) {
  const usedEdges = new Set();
  const chains = [];
  const vertices = [...adjacency.keys()].sort((left, right) => left - right);
  // Open chains first: they start at an end or a junction, any vertex without exactly two edges.
  for (const start of vertices) {
    if (adjacency.get(start).length === 2) continue;
    for (const step of adjacency.get(start)) {
      if (usedEdges.has(step[1])) continue;
      chains.push({ vertices: walk(start, step, adjacency, usedEdges), closed: false });
    }
  }
  // What is left is closed loops; each starts at its lowest vertex.
  for (const start of vertices) {
    const step = adjacency.get(start).find(([, edge]) => !usedEdges.has(edge));
    if (!step) continue;
    chains.push({ vertices: walk(start, step, adjacency, usedEdges).slice(0, -1), closed: true });
  }
  return chains;
}

/**
 * Turns the selected edges of a mesh into poly splines for the `curve` geometry: `[{ kind: 'poly', closed, points }]`.
 * A loop (every vertex has two selected edges) is a closed spline that starts at its lowest vertex and leaves toward
 * its lower neighbour; a chain is an open spline from its end or junction vertex. Splines come in order of their
 * first vertex, so the result is the same on every call. Counts are bounded: at most 64 splines, 1024 points in one
 * and 4096 in all.
 */
export function meshEdgesToSplines(mesh, selection) {
  const mask = selectedEdgeMask(mesh, selection);
  const adjacency = adjacencyOf(mesh, mask);
  if (adjacency.size === 0) {
    throw new RangeError('selection matches no edge of the mesh. Pick edges that exist, for example { "open": true } on a mesh with a hole.');
  }
  const chains = chainsOf(adjacency);
  if (chains.length > MAX_CURVE_SPLINES) {
    throw new RangeError(`The selection makes ${chains.length} splines; at most ${MAX_CURVE_SPLINES}. Select fewer edge loops or chains.`);
  }
  let total = 0;
  const splines = chains.map(chain => {
    if (chain.vertices.length > MAX_POINTS_PER_SPLINE) {
      throw new RangeError(`A selected chain has ${chain.vertices.length} points; at most ${MAX_POINTS_PER_SPLINE} for one spline. Select a shorter chain.`);
    }
    total += chain.vertices.length;
    const points = chain.vertices.map(vertex => Array.from(mesh.positions.subarray(vertex * 3, vertex * 3 + 3)));
    return { kind: 'poly', closed: chain.closed, points };
  });
  if (total > MAX_TOTAL_CURVE_POINTS) {
    throw new RangeError(`The selection makes ${total} points in all; at most ${MAX_TOTAL_CURVE_POINTS}. Select fewer edges.`);
  }
  return splines;
}
