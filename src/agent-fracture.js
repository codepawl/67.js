import { invalidField } from './field-error.js';
import { knownKeys } from './motion-validation.js';
import { fractureMesh, MAX_FRACTURE_CELLS, MIN_FRACTURE_CELLS } from './fracture.js';
import { AGENT_SCENE_CAPABILITIES } from './agent-scene-capabilities.js';

// Recipe side of fracture: the `fragment` geometry type (one Voronoi piece of a source geometry) and the
// `fracture-node` operation that swaps a node for its pieces, bodies and breakable glue.

const DEFAULT_PHYSICS_DURATION = 3;
const FRACTURE_CACHE_SIZE = 4;
const UNSUPPORTED_NODE_FIELDS = ['instances', 'asset', 'vegetation', 'relations'];
const FRACTURE_NODE_FIELDS = ['type', 'node', 'cells', 'strength', 'seed', 'impact', 'impactRadius', 'density', 'friction'];

const fractureCache = new Map();

/** The fracture of one source and option set, kept for the few most recent so the pieces of a part share one computation. */
function cachedFracture(key, compute) {
  if (fractureCache.has(key)) return fractureCache.get(key);
  const fracture = compute();
  fractureCache.set(key, fracture);
  if (fractureCache.size > FRACTURE_CACHE_SIZE) fractureCache.delete(fractureCache.keys().next().value);
  return fracture;
}

function fractureOptions(definition) {
  return { seed: definition.seed ?? 1, cells: definition.cells, impact: definition.impact, impactRadius: definition.impactRadius };
}

/**
 * Render geometry of piece `definition.index`, in the source geometry's local space.
 * `sourceSignature` is the cache identity of the source record, so editing the source changes the pieces.
 */
export function fragmentGeometry(definition, sourceSignature, generateSource) {
  const options = fractureOptions(definition);
  const key = JSON.stringify([sourceSignature, options.seed, options.cells, options.impact ?? null, options.impactRadius ?? null]);
  const fracture = cachedFracture(key, () => fractureMesh(generateSource(), options));
  const fragment = fracture.fragments[definition.index];
  return {
    positions: fragment.positions.slice(),
    normals: fragment.normals.slice(),
    indices: fragment.indices.slice(),
  };
}

function validatedOperation(operation) {
  knownKeys(operation, FRACTURE_NODE_FIELDS, 'operation');
  if (typeof operation.node !== 'string') {
    throw invalidField('node', operation.node, 'the ID of a node to fracture, such as "wall"', TypeError);
  }
  if (!Number.isInteger(operation.cells) || operation.cells < MIN_FRACTURE_CELLS || operation.cells > MAX_FRACTURE_CELLS) {
    throw invalidField('cells', operation.cells, `a whole number of pieces from ${MIN_FRACTURE_CELLS} to ${MAX_FRACTURE_CELLS}, such as 24`);
  }
  if (!(Number.isFinite(operation.strength) && operation.strength > 0)) {
    throw invalidField('strength', operation.strength, 'the glue strength as an impulse above 0 in N s, such as 5; a body hit by more than this in one 1/60 s step breaks its glue');
  }
  for (const field of ['density', 'friction']) {
    if (operation[field] !== undefined && !(Number.isFinite(operation[field]) && operation[field] > 0)) {
      throw invalidField(field, operation[field], `a number above 0, such as ${field === 'density' ? 1 : 0.6}`);
    }
  }
  return operation;
}

function fracturableNode(candidate, nodeId) {
  const node = candidate.nodes.find(entry => entry.id === nodeId);
  if (!node) {
    throw invalidField('node', nodeId, `the ID of an existing node, one of ${candidate.nodes.slice(0, 8).map(entry => entry.id).join(', ') || 'none yet'}`);
  }
  if (node.geometry === undefined) {
    throw invalidField('node', nodeId, 'a node with a geometry to break; pick a mesh node such as "wall"');
  }
  const unsupported = UNSUPPORTED_NODE_FIELDS.find(field => node[field] !== undefined);
  if (unsupported) {
    throw invalidField('node', nodeId, `a plain mesh node; ${nodeId} uses ${unsupported}, so fracture a node without it`);
  }
  if (node.parent !== null && node.parent !== undefined) {
    throw invalidField('node', nodeId, 'a root node, with no parent, since every piece is a physics body; reparent it first with set-node');
  }
  if (candidate.nodes.some(entry => entry.parent === nodeId)) {
    throw invalidField('node', nodeId, 'a node without children; move the children to another parent with set-node first');
  }
  if ((candidate.motion?.tracks ?? []).some(track => track.id === nodeId)) {
    throw invalidField('node', nodeId, 'a node without motion tracks; the pieces are moved by physics, so remove its tracks first');
  }
  return node;
}

function claimPieceIds(candidate, nodeId, cells) {
  const ids = Array.from({ length: cells }, (_, index) => `${nodeId}-frag-${index}`);
  const taken = ids.find(id => candidate.nodes.some(entry => entry.id === id) || candidate.geometries.some(entry => entry.id === id));
  if (taken) {
    throw invalidField('node', nodeId, `a node whose piece IDs are free; ${taken} already exists, so rename it or remove it first`);
  }
  return ids;
}

function physicsWithRoom(candidate, bodiesNeeded, jointsNeeded) {
  const physics = candidate.physics ?? { duration: DEFAULT_PHYSICS_DURATION, bodies: [] };
  const { maxBodies, maxJoints } = AGENT_SCENE_CAPABILITIES.physics.limits;
  const bodyCount = physics.bodies.length + bodiesNeeded;
  const jointCount = (physics.joints?.length ?? 0) + jointsNeeded;
  if (bodyCount > maxBodies) {
    throw invalidField('cells', bodiesNeeded, `at most ${maxBodies - physics.bodies.length} pieces, since physics holds ${maxBodies} bodies and ${physics.bodies.length} are in use; use fewer cells`);
  }
  if (jointCount > maxJoints) {
    throw invalidField('cells', bodiesNeeded, `fewer pieces: ${jointsNeeded} glue joints would pass the ${maxJoints} joints physics holds (${physics.joints?.length ?? 0} in use); use fewer cells`);
  }
  return physics;
}

/**
 * The fracture-node operation. Replaces `operation.node` by `cells` piece nodes with the same transform and material,
 * adds a convex dynamic body per piece and one fixed joint with `breakImpulse: strength` per neighbouring pair. Set a
 * physics section with the ball and floor first (set-physics replaces the section), or let this create one of 3 seconds.
 */
export function fractureNode(candidate, rawOperation, generateSource) {
  const operation = validatedOperation(rawOperation);
  const node = fracturableNode(candidate, operation.node);
  const definition = { seed: operation.seed ?? 1, cells: operation.cells, impact: operation.impact, impactRadius: operation.impactRadius };
  const fracture = fractureMesh(generateSource(node.geometry), fractureOptions(definition));
  const ids = claimPieceIds(candidate, node.id, operation.cells);
  const physics = physicsWithRoom(candidate, operation.cells, fracture.glue.length);
  const scale = node.scale ?? [1, 1, 1];
  const { id: removedId, geometry: sourceGeometry, ...shared } = node;
  const pieces = ids.map(id => ({ ...structuredClone(shared), id, geometry: id }));
  candidate.geometries.push(...ids.map((id, index) => ({
    id, type: 'fragment', source: sourceGeometry, index, cells: operation.cells, seed: definition.seed,
    ...(operation.impact === undefined ? {} : { impact: operation.impact }),
    ...(operation.impactRadius === undefined ? {} : { impactRadius: operation.impactRadius }),
  })));
  const position = candidate.nodes.findIndex(entry => entry.id === removedId);
  candidate.nodes.splice(position, 1, ...pieces);
  physics.bodies.push(...ids.map(id => ({
    node: id, type: 'dynamic', shape: 'convex', density: operation.density ?? 1,
    ...(operation.friction === undefined ? {} : { friction: operation.friction }),
  })));
  physics.joints = [...(physics.joints ?? []), ...fracture.glue.map(({ a, b, anchor }) => {
    const scaledAnchor = anchor.map((value, axis) => value * scale[axis]);
    return {
      name: `${removedId}-glue-${a}-${b}`, type: 'fixed', bodyA: ids[a], bodyB: ids[b],
      anchorA: scaledAnchor, anchorB: scaledAnchor, breakImpulse: operation.strength,
    };
  })];
  candidate.physics = physics;
}
