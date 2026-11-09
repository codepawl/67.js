import { invalidField } from './field-error.js';

// Checks shared by the recipe sections that bake geometry (cloth, particles, hair).

export function knownKeys(value, fields, path) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) {
    throw invalidField(path, value, 'a plain object, such as {}', TypeError);
  }
  for (const key of Object.keys(value)) {
    if (!fields.includes(key)) {
      throw invalidField(`${path}.${key}`, value[key], `no such field; use one of ${fields.join(', ')}`, TypeError);
    }
  }
}

export function finiteNumber(value, path, minimum, maximum) {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isFinite(Math.fround(value)) || value < minimum || value > maximum) {
    throw invalidField(path, value, `a number from ${minimum} to ${maximum}, such as ${Math.min(Math.max(1, minimum), maximum)}`);
  }
  return value;
}

export function vectorOfThree(value, path, limit) {
  if (!Array.isArray(value) || value.length !== 3) {
    throw invalidField(path, value, 'an array of 3 numbers, such as [0, 1, 0]', TypeError);
  }
  return value.map((component, index) => finiteNumber(component, `${path}[${index}]`, -limit, limit));
}

export function boundedArray(value, maximum, path) {
  if (!Array.isArray(value) || value.length > maximum) {
    throw invalidField(path, Array.isArray(value) ? `${value.length} entries` : value, `an array of at most ${maximum} entries, such as []`, TypeError);
  }
  return value;
}

// `path` names the field that holds the node ID, such as cloth.sheets[0].node.
export function rootNodeWithGeometry(nodeId, recipeNodes, claimedNodes, motionNodeIds, physicsNodeIds, path, system = 'cloth') {
  const node = typeof nodeId === 'string' ? recipeNodes.get(nodeId) : undefined;
  if (!node) {
    throw invalidField(path, nodeId, 'the ID of a node in the recipe, such as "banner"');
  }
  if (node.geometry === undefined) {
    throw invalidField(path, nodeId, 'a node that draws a geometry; this one is a group');
  }
  if (node.parent !== null) {
    throw invalidField(path, nodeId, 'a root node with no parent; reparent it first');
  }
  if (claimedNodes.has(nodeId)) {
    throw invalidField(path, nodeId, `a node that ${system} uses once; this one is used twice`);
  }
  if (motionNodeIds.has(nodeId) || physicsNodeIds.has(nodeId)) {
    throw invalidField(path, nodeId, 'a node that stays where it is, with no translation or rotation track and no physics body');
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
