import { mat4, quat, vec3 } from 'gl-matrix';
import { invalidField } from './field-error.js';
import { SETTLE_LIMITS, settleInstances } from './settle.js';
import { createRandom } from './vegetation-geometry.js';

export { loadPhysicsEngine, physicsEngineLoaded } from './physics.js';

// The settle operation: scattered props fall onto recipe nodes as rigid bodies, then stay where they came to rest as
// ordinary static parts under one group node. A later settle can list that group as a collider and stack on it.

const OPERATION_FIELDS = ['type', 'settle'];
const MAX_MATERIALS = 8;
const GEOMETRY_SHAPES = { box: 'box', sphere: 'ball' };

function requireId(value, path) {
  if (typeof value !== 'string' || !value.trim() || value.length > 100) {
    throw invalidField(path, value, 'an ID of 1 to 100 characters, such as "rubble"', TypeError);
  }
  return value;
}

function worldMatrixOf(node, nodesById) {
  const local = mat4.fromRotationTranslationScale(mat4.create(), node.rotation ?? [0, 0, 0, 1], node.translation ?? [0, 0, 0], node.scale ?? [1, 1, 1]);
  if (node.parent === null || node.parent === undefined) return local;
  return mat4.multiply(local, worldMatrixOf(nodesById.get(node.parent), nodesById), local);
}

function colliderFromNode(node, geometry, nodesById) {
  const matrix = worldMatrixOf(node, nodesById);
  const scale = mat4.getScaling(vec3.create(), matrix);
  const translation = Array.from(mat4.getTranslation(vec3.create(), matrix));
  const rotation = Array.from(mat4.getRotation(quat.create(), matrix));
  if (geometry.type === 'box') return { shape: 'box', translation, rotation, halfExtents: Array.from(scale, edge => edge / 2) };
  if (Math.max(...scale) - Math.min(...scale) > 1e-4 * Math.max(...scale)) {
    throw invalidField(`settle.colliders (${node.id})`, Array.from(scale), 'a sphere with equal scale on all axes, or a box; a stretched sphere is not a ball');
  }
  return { shape: 'ball', translation, rotation: [0, 0, 0, 1], radius: scale[0] };
}

/** The colliders a node list stands for: a mesh node is one, a group node is its mesh descendants (earlier settles). */
function collidersFor(recipe, nodeIds) {
  const nodesById = new Map(recipe.nodes.map(node => [node.id, node]));
  const geometriesById = new Map(recipe.geometries.map(geometry => [geometry.id, geometry]));
  const colliders = [];
  const visit = (node, path) => {
    if (node.geometry !== undefined) {
      const geometry = geometriesById.get(node.geometry);
      if (!GEOMETRY_SHAPES[geometry?.type]) {
        throw invalidField(path, node.id, 'a node whose geometry is a box or a sphere, since those are the shapes a settle can land on; use a box for a wall or floor');
      }
      colliders.push(colliderFromNode(node, geometry, nodesById));
    }
    for (const child of recipe.nodes.filter(candidate => candidate.parent === node.id)) visit(child, path);
  };
  nodeIds.forEach((nodeId, index) => {
    const node = nodesById.get(nodeId);
    if (!node) throw invalidField(`settle.colliders[${index}]`, nodeId, `the ID of a recipe node, one of ${[...nodesById.keys()].slice(0, 5).join(', ') || 'none yet'}`);
    visit(node, `settle.colliders[${index}]`);
  });
  if (colliders.length > SETTLE_LIMITS.maxColliders) {
    throw invalidField('settle.colliders', `${colliders.length} shapes`, `nodes that stand for at most ${SETTLE_LIMITS.maxColliders} boxes and spheres; list fewer nodes, or one wall as a single box`);
  }
  return colliders;
}

function materialsFor(recipe, material) {
  const list = Array.isArray(material) ? material : [material];
  if (!list.length || list.length > MAX_MATERIALS) {
    throw invalidField('settle.material', material, `a material ID or a list of 1 to ${MAX_MATERIALS} IDs, such as "stone"`, TypeError);
  }
  return list.map(id => {
    if (!recipe.materials.some(candidate => candidate.id === id)) {
      throw invalidField('settle.material', id, `the ID of a recipe material, one of ${recipe.materials.slice(0, 5).map(candidate => candidate.id).join(', ') || 'none yet'}`);
    }
    return id;
  });
}

/**
 * Apply one settle operation to a candidate recipe: `{ type: 'settle', settle: { id, geometry, material, colliders: [node IDs],
 * ...settle settings } }`. Adds a group node `id` and one static child `id-<n>` per prop that came to rest. The solver must
 * be loaded (await loadPhysicsEngine()).
 */
export function applySettle(recipe, operation) {
  for (const key of Object.keys(operation)) {
    if (!OPERATION_FIELDS.includes(key)) throw invalidField(key, operation[key], `no such field; put the settle fields inside "settle"`, TypeError);
  }
  const { settle } = operation;
  if (!settle || typeof settle !== 'object' || Array.isArray(settle)) throw invalidField('settle', settle, 'an object, such as { "id": "rubble", "geometry": "block", "material": "stone", "colliders": ["floor"], "area": { "min": [-1, -1], "max": [1, 1] }, "count": 40 }', TypeError);
  const { id, geometry: geometryId, material, colliders: colliderNodeIds, ...settings } = settle;
  requireId(id, 'settle.id');
  const geometry = recipe.geometries.find(candidate => candidate.id === geometryId);
  if (!geometry) throw invalidField('settle.geometry', geometryId, `the ID of a recipe geometry, one of ${recipe.geometries.slice(0, 5).map(candidate => candidate.id).join(', ') || 'none yet'}`);
  const shape = GEOMETRY_SHAPES[geometry.type];
  if (!shape) throw invalidField('settle.geometry', geometryId, 'a box or sphere geometry, such as { "id": "block", "type": "box" }; a settle prop is a box or a ball');
  if (recipe.nodes.some(node => node.id === id || node.id.startsWith(`${id}-`))) {
    throw invalidField('settle.id', id, 'an ID no node or node prefix uses yet; remove the earlier group first, or pick a new ID such as "rubble-2"');
  }
  if (!Array.isArray(colliderNodeIds)) throw invalidField('settle.colliders', colliderNodeIds, 'a list of node IDs to land on, such as ["floor", "wall"]', TypeError);
  const materials = materialsFor(recipe, material);
  const { instances } = settleInstances({ ...settings, shape, colliders: collidersFor(recipe, colliderNodeIds) });
  const pickMaterial = createRandom((settings.seed ?? 1) + 7919);
  recipe.nodes.push({ id, parent: null, translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] });
  instances.forEach((instance, index) => {
    const scale = shape === 'ball' ? instance.size.map(edge => edge / 2) : instance.size;
    recipe.nodes.push({
      id: `${id}-${index}`, parent: id, geometry: geometryId, material: materials[Math.floor(pickMaterial() * materials.length)],
      translation: instance.translation, rotation: instance.rotation, scale,
    });
  });
}
