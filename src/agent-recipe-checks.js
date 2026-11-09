// Checks shared by the recipe sections that bake geometry (cloth, particles, hair).
import { invalidField } from './field-error.js';

export function knownKeys(value, fields, label) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) {
    throw invalidField(label, value, 'an object, such as {}', TypeError);
  }
  for (const key of Object.keys(value)) {
    if (!fields.includes(key)) {
      throw invalidField(`${label}.${key}`, value[key], `one of the fields ${fields.join(', ')}; remove ${key}`, TypeError);
    }
  }
}

export function finiteNumber(value, label, minimum, maximum) {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isFinite(Math.fround(value)) || value < minimum || value > maximum) {
    throw invalidField(label, value, `a finite number from ${minimum} to ${maximum}, such as ${Math.min(Math.max(1, minimum), maximum)}`);
  }
  return value;
}

export function vectorOfThree(value, label, limit) {
  if (!Array.isArray(value) || value.length !== 3) {
    throw invalidField(label, value, 'three numbers, such as [0, 1, 0]', TypeError);
  }
  return value.map(component => finiteNumber(component, label, -limit, limit));
}

export function boundedArray(value, maximum, label) {
  if (!Array.isArray(value) || value.length > maximum) {
    throw invalidField(label, value, `an array of at most ${maximum} entries, such as []`, TypeError);
  }
  return value;
}

export function rootNodeWithGeometry(nodeId, recipeNodes, claimedNodes, motionNodeIds, physicsNodeIds, label, system = 'cloth') {
  const node = typeof nodeId === 'string' ? recipeNodes.get(nodeId) : undefined;
  if (!node) {
    throw invalidField(`${label} node`, nodeId, 'the ID of a node in nodes, such as one scene_inspect lists');
  }
  if (node.geometry === undefined) {
    throw invalidField(`${label} node`, nodeId, 'a node with a geometry; give it geometry and material');
  }
  if (node.parent !== null) {
    throw invalidField(`${label} node`, nodeId, 'a root node without a parent; reparent it first');
  }
  if (claimedNodes.has(nodeId)) {
    throw invalidField(`${label} node`, nodeId, `a node used once in ${system}; pick another node`);
  }
  if (motionNodeIds.has(nodeId) || physicsNodeIds.has(nodeId)) {
    throw invalidField(`${label} node`, nodeId, 'a node that stays where it is, with no motion translation or rotation track and no physics body');
  }
  claimedNodes.add(nodeId);
}

const NODES_OF_SECTION = {
  cloth: section => [...section.sheets, ...(section.colliders ?? [])].map(entry => entry.node),
  particles: section => section.systems.map(system => system.node),
};

/**
 * What a baking section needs to check its nodes. Nodes already used by the sections named in `earlierSections`
 * (validated before this one) are claimed, so one node never serves two sections.
 */
export function bakingContext(recipe, earlierSections = []) {
  const claimedNodes = new Set();
  for (const name of earlierSections) {
    if (recipe[name]) {
      NODES_OF_SECTION[name](recipe[name]).forEach(nodeId => claimedNodes.add(nodeId));
    }
  }
  return {
    recipeNodes: new Map(recipe.nodes.map(node => [node.id, node])),
    claimedNodes,
    motionNodeIds: new Set((recipe.motion?.tracks ?? [])
      .filter(track => track.kind === 'node' && (track.property === 'translation' || track.property === 'rotation'))
      .map(track => track.id)),
    physicsNodeIds: new Set((recipe.physics?.bodies ?? []).map(body => body.node)),
  };
}
