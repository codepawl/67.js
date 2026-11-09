import { mat4, vec3 } from 'gl-matrix';
import { invalidField } from './field-error.js';

// Relations place a part against another part's bounds, so a resized body keeps its handle where it belongs.
// A node lists relations; each one fixes the node's world bounds on one or more axes from the bounds of another
// mesh node (or from the faces that carry one of its tags). Relations are solved after geometry exists, in
// dependency order, and again on every edit. The same recipe always solves to the same translations.

export const RELATION_KINDS = Object.freeze(['attach', 'flush', 'align', 'centered', 'gap']);
export const RELATION_SIDES = Object.freeze(['+x', '-x', '+y', '-y', '+z', '-z']);
export const RELATION_LIMITS = Object.freeze({ maxPerNode: 8, maxNodes: 256, maxOffset: 1e6 });

const AXES = Object.freeze(['x', 'y', 'z']);
const ANCHORS = Object.freeze(['min', 'center', 'max']);
const KIND_FIELDS = Object.freeze({
  attach: ['side', 'offset'],
  gap: ['side', 'offset'],
  flush: ['side', 'offset'],
  align: ['axis', 'at', 'offset'],
  centered: ['axes'],
});

function axisIndex(axis) {
  return AXES.indexOf(axis);
}

function sideAxis(side) {
  return axisIndex(side[1]);
}

function relationPath(nodeIndex, index) {
  return `nodes[${nodeIndex}].relations[${index}]`;
}

function normalizeRelation(nodeIndex, index, relation) {
  const path = relationPath(nodeIndex, index);
  if (!relation || typeof relation !== 'object' || Array.isArray(relation)) {
    throw invalidField(path, relation, 'an object such as { "kind": "attach", "to": "body", "side": "+x" }', TypeError);
  }
  if (!RELATION_KINDS.includes(relation.kind)) {
    throw invalidField(`${path}.kind`, relation.kind, `one of ${RELATION_KINDS.join(', ')}`, TypeError);
  }
  const allowed = ['kind', 'to', 'region', ...(KIND_FIELDS[relation.kind] ?? [])];
  for (const key of Object.keys(relation)) {
    if (!allowed.includes(key)) {
      throw invalidField(`${path}.${key.slice(0, 48)}`, relation[key], `a field a ${relation.kind} relation takes: ${allowed.join(', ')}`, TypeError);
    }
  }
  if (typeof relation.to !== 'string' || !relation.to) {
    throw invalidField(`${path}.to`, relation.to, 'the ID of the part it is placed against, such as "body"', TypeError);
  }
  if (relation.region !== undefined && (typeof relation.region !== 'string' || !relation.region || relation.region.length > 128)) {
    throw invalidField(`${path}.region`, relation.region, 'a mesh tag name of 1 to 128 characters, such as "top"', TypeError);
  }
  const offset = relation.offset ?? 0;
  if (!Number.isFinite(offset) || Math.abs(offset) > RELATION_LIMITS.maxOffset) {
    throw invalidField(`${path}.offset`, relation.offset, `a finite number of metres within +-${RELATION_LIMITS.maxOffset}, such as 0.1`);
  }
  const result = { kind: relation.kind, to: relation.to };
  if (relation.region !== undefined) {
    result.region = relation.region;
  }
  if (offset !== 0) {
    result.offset = offset;
  }
  if (KIND_FIELDS[relation.kind].includes('side')) {
    if (!RELATION_SIDES.includes(relation.side)) {
      throw invalidField(`${path}.side`, relation.side, `one of ${RELATION_SIDES.join(', ')}, the face of "${relation.to}" it sits against`, TypeError);
    }
    result.side = relation.side;
  }
  if (relation.kind === 'align') {
    if (!AXES.includes(relation.axis) || !ANCHORS.includes(relation.at)) {
      throw invalidField(AXES.includes(relation.axis) ? `${path}.at` : `${path}.axis`, AXES.includes(relation.axis) ? relation.at : relation.axis, AXES.includes(relation.axis) ? `one of ${ANCHORS.join(', ')}` : 'x, y or z', TypeError);
    }
    result.axis = relation.axis;
    result.at = relation.at;
  }
  if (relation.kind === 'centered') {
    const axes = relation.axes ?? AXES;
    if (!Array.isArray(axes) || axes.length === 0 || axes.length > 3 || axes.some(axis => !AXES.includes(axis)) || new Set(axes).size !== axes.length) {
      throw invalidField(`${path}.axes`, relation.axes, 'a list of x, y, z with each at most once, such as ["x", "z"], or left out for all three', TypeError);
    }
    result.axes = [...axes].sort();
  }
  return result;
}

/** The world axes a normalized relation decides: indices 0 to 2. */
export function relationAxes(relation) {
  switch (relation.kind) {
    case 'attach':
      return [0, 1, 2];
    case 'gap':
    case 'flush':
      return [sideAxis(relation.side)];
    case 'align':
      return [axisIndex(relation.axis)];
    default:
      return relation.axes.map(axisIndex);
  }
}

// Depth-first walk over the things a node's world position waits for: its relation targets and its parent chain.
function dependencyOrder(nodesById, relatedIds) {
  const order = [];
  const finished = new Set();
  const path = [];
  function visit(nodeId) {
    if (finished.has(nodeId)) {
      return;
    }
    const position = path.indexOf(nodeId);
    if (position !== -1) {
      const cycle = [...path.slice(position), nodeId].map(id => id.slice(0, 48));
      throw invalidField(`nodes[${[...nodesById.keys()].indexOf(nodeId)}].relations`, cycle, 'relations that form no loop, since each part waits for the next in the list, parents included; remove one relation in the loop with set-node relations, or place one part with translation');
    }
    path.push(nodeId);
    const node = nodesById.get(nodeId);
    if (node.parent !== null && nodesById.has(node.parent)) {
      visit(node.parent);
    }
    for (const relation of node.relations ?? []) {
      visit(relation.to);
    }
    path.pop();
    finished.add(nodeId);
    if (relatedIds.has(nodeId)) {
      order.push(nodeId);
    }
  }
  for (const nodeId of relatedIds) {
    visit(nodeId);
  }
  return order;
}

function indexNodes(nodes) {
  return new Map(nodes.map(node => [node.id, node]));
}

/**
 * Validate the relations of a list of normalized nodes and return the nodes with each relations list normalized
 * (an empty list is dropped). Throws on unknown fields, unknown or non-mesh targets, two relations deciding the same
 * axis, and cycles. Every message names what to change.
 */
export function normalizeRelations(nodes) {
  const related = nodes.filter(node => node.relations !== undefined);
  if (related.length === 0) {
    return nodes;
  }
  const nodesById = indexNodes(nodes);
  const result = nodes.map(node => ({ ...node }));
  const resultById = indexNodes(result);
  let relatedCount = 0;
  for (const node of related) {
    const nodeIndex = nodes.indexOf(node);
    if (!Array.isArray(node.relations) || node.relations.length > RELATION_LIMITS.maxPerNode) {
      throw invalidField(`nodes[${nodeIndex}].relations`, node.relations, `an array of at most ${RELATION_LIMITS.maxPerNode} relations; merge or drop some`);
    }
    const normalized = node.relations.map((relation, index) => normalizeRelation(nodeIndex, index, relation));
    const target = resultById.get(node.id);
    if (normalized.length === 0) {
      delete target.relations;
      continue;
    }
    relatedCount++;
    if (relatedCount > RELATION_LIMITS.maxNodes) {
      throw invalidField(`nodes[${nodeIndex}].relations`, node.relations, `relations on at most ${RELATION_LIMITS.maxNodes} nodes; group repeated parts or place the rest with translation`);
    }
    if (node.geometry === undefined) {
      throw invalidField(`nodes[${nodeIndex}].relations`, node.relations, 'relations on a mesh node, since this node is a group; put them on a mesh node inside the group', TypeError);
    }
    const decided = new Map();
    normalized.forEach((relation, index) => {
      const referenced = nodesById.get(relation.to);
      if (relation.to === node.id) {
        throw invalidField(`${relationPath(nodeIndex, index)}.to`, relation.to, 'the ID of another part, such as "body", not its own node');
      }
      if (!referenced) {
        throw invalidField(`${relationPath(nodeIndex, index)}.to`, relation.to, 'the ID of a node in this recipe; list them with scene_inspect, or drop the relation');
      }
      if (referenced.geometry === undefined) {
        throw invalidField(`${relationPath(nodeIndex, index)}.to`, relation.to, 'the ID of a mesh node, such as a box, since this one is a group with no geometry');
      }
      for (const axis of relationAxes(relation)) {
        if (decided.has(axis)) {
          throw invalidField(`${relationPath(nodeIndex, index)}.kind`, relation.kind, `a relation that leaves the ${AXES[axis]} axis to relation ${decided.get(axis)}, which already decides it; keep one relation per axis`);
        }
        decided.set(axis, index);
      }
    });
    target.relations = normalized;
  }
  dependencyOrder(resultById, new Set(related.filter(node => resultById.get(node.id).relations).map(node => node.id)));
  return result;
}

function worldMatrixOf(nodeId, nodesById, cache) {
  const cached = cache.get(nodeId);
  if (cached) {
    return cached;
  }
  const node = nodesById.get(nodeId);
  const local = mat4.fromRotationTranslationScale(mat4.create(), node.rotation, node.translation, node.scale);
  const world = node.parent !== null && nodesById.has(node.parent)
    ? mat4.multiply(local, worldMatrixOf(node.parent, nodesById, cache), local)
    : local;
  cache.set(nodeId, world);
  return world;
}

function targetValue(bounds, axis, anchor) {
  if (anchor === 'min') {
    return bounds.min[axis];
  }
  if (anchor === 'max') {
    return bounds.max[axis];
  }
  return (bounds.min[axis] + bounds.max[axis]) / 2;
}

// Each constraint says: this part's `anchor` on `axis` should sit at `value`.
function constraintsFor(relation, selfBounds, targetBounds) {
  const offset = relation.offset ?? 0;
  const wanted = [];
  const sideAnchors = side => {
    const axis = sideAxis(side);
    const outward = side[0] === '+';
    return { axis, outward };
  };
  if (relation.kind === 'gap' || relation.kind === 'attach') {
    const { axis, outward } = sideAnchors(relation.side);
    wanted.push(outward
      ? { axis, anchor: 'min', value: targetBounds.max[axis] + offset }
      : { axis, anchor: 'max', value: targetBounds.min[axis] - offset });
  }
  if (relation.kind === 'attach') {
    const { axis: sideAxisIndex } = sideAnchors(relation.side);
    for (const axis of [0, 1, 2].filter(candidate => candidate !== sideAxisIndex)) {
      wanted.push({ axis, anchor: 'center', value: targetValue(targetBounds, axis, 'center') });
    }
  }
  if (relation.kind === 'flush') {
    const { axis, outward } = sideAnchors(relation.side);
    const anchor = outward ? 'max' : 'min';
    wanted.push({ axis, anchor, value: targetValue(targetBounds, axis, anchor) + offset });
  }
  if (relation.kind === 'align') {
    const axis = axisIndex(relation.axis);
    wanted.push({ axis, anchor: relation.at, value: targetValue(targetBounds, axis, relation.at) + offset });
  }
  if (relation.kind === 'centered') {
    for (const axis of relation.axes.map(axisIndex)) {
      wanted.push({ axis, anchor: 'center', value: targetValue(targetBounds, axis, 'center') });
    }
  }
  return wanted.map(constraint => ({ ...constraint, delta: constraint.value - targetValue(selfBounds, constraint.axis, constraint.anchor) }));
}

/**
 * Solve every relation and return nodes whose translations satisfy them (unrelated nodes are returned as is).
 * `worldBounds(node, worldMatrix, region)` returns the axis-aligned world bounds `{ min, max }` of a mesh node, or of
 * the faces carrying the tag `region`, and throws a message that names the tag when it does not exist.
 */
export function solveRelations(nodes, worldBounds) {
  const related = nodes.filter(node => node.relations?.length);
  if (related.length === 0) {
    return nodes;
  }
  const result = nodes.map(node => ({ ...node }));
  const nodesById = indexNodes(result);
  const cache = new Map();
  for (const nodeId of dependencyOrder(nodesById, new Set(related.map(node => node.id)))) {
    const node = nodesById.get(nodeId);
    const nodeIndex = nodes.findIndex(candidate => candidate.id === nodeId);
    const delta = [0, 0, 0];
    const selfBounds = worldBounds(node, worldMatrixOf(nodeId, nodesById, cache), undefined);
    node.relations.forEach((relation, index) => {
      const target = nodesById.get(relation.to);
      let targetBounds;
      try {
        targetBounds = worldBounds(target, worldMatrixOf(target.id, nodesById, cache), relation.region);
      } catch (error) {
        throw invalidField(`${relationPath(nodeIndex, index)}.${relation.region === undefined ? 'to' : 'region'}`, relation.region ?? relation.to, `a target that can be measured (${error.message})`);
      }
      for (const constraint of constraintsFor(relation, selfBounds, targetBounds)) {
        delta[constraint.axis] = constraint.delta;
      }
    });
    const parentWorld = node.parent !== null && nodesById.has(node.parent) ? worldMatrixOf(node.parent, nodesById, cache) : mat4.create();
    const inverse = mat4.invert(mat4.create(), parentWorld);
    if (!inverse) {
      throw invalidField(`nodes[${nodes.findIndex(candidate => candidate.id === node.parent)}].scale`, nodesById.get(node.parent).scale, `a scale with no zero axis, since the relations of nodes[${nodeIndex}] cannot be solved under it, such as [1, 1, 1]`);
    }
    const local = vec3.transformMat4(vec3.create(), delta, inverse);
    const origin = vec3.transformMat4(vec3.create(), [0, 0, 0], inverse);
    node.translation = node.translation.map((value, axis) => value + local[axis] - origin[axis]);
    if (!node.translation.every(Number.isFinite)) {
      throw invalidField(`nodes[${nodeIndex}].translation`, node.translation, 'finite numbers, but its relations produce a translation outside the number range; reduce offsets or part sizes');
    }
    cache.clear();
  }
  return result;
}
