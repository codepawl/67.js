// Branches are named variants of the scene an agent is editing. A branch records the operations that made it and the
// recipe they produce. Recipes are stored once per distinct content, so three branches that end in the same recipe cost
// one snapshot. This module holds plain data only: it must stay free of engine imports so the MCP server can share it.

import { invalidField } from './field-error.js';

export const BRANCH_LIMITS = Object.freeze({ maximumBranches: 8, maximumNameLength: 24, maximumLabels: 24 });

export const BRANCH_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,23}$/;

export function validateBranchName(name) {
  if (typeof name !== 'string' || !BRANCH_NAME_PATTERN.test(name)) {
    throw invalidField('branch', name, 'a name that starts with a lowercase letter and has at most 24 lowercase letters, digits, underscores or hyphens, such as "alt-1"', TypeError);
  }
  return name;
}

/** Keep only printable text that fits a drawn label, so a hostile node ID cannot break the overlay. */
export function printableLabel(text, maximumLength = 32) {
  return String(text).replace(/[^\x20-\x7e]/g, '?').slice(0, maximumLength);
}

export function createBranchStore() {
  const snapshots = new Map();
  const branches = new Map();

  function referencedKeys() {
    return new Set([...branches.values()].map(branch => branch.recipeKey));
  }

  function pruneSnapshots() {
    const referenced = referencedKeys();
    for (const key of snapshots.keys()) {
      if (!referenced.has(key)) snapshots.delete(key);
    }
  }

  return {
    /** Store a branch. Returns whether its recipe was already held by another branch. */
    fork(name, { recipe, baseRecipe, operations, baseRevision }) {
      validateBranchName(name);
      if (!branches.has(name) && branches.size >= BRANCH_LIMITS.maximumBranches) {
        throw invalidField('branch', name, `a name that is already a branch, since at most ${BRANCH_LIMITS.maximumBranches} branches can exist; reuse one to replace it, such as "${[...branches.keys()][0]}"`);
      }
      const recipeKey = JSON.stringify(recipe);
      const shared = [...branches.entries()].some(([otherName, other]) => otherName !== name && other.recipeKey === recipeKey);
      branches.set(name, { recipeKey, baseKey: JSON.stringify(baseRecipe), operations: structuredClone(operations), baseRevision });
      if (!snapshots.has(recipeKey)) snapshots.set(recipeKey, recipe);
      pruneSnapshots();
      return { shared };
    },
    get(name) {
      validateBranchName(name);
      const branch = branches.get(name);
      if (!branch) {
        throw invalidField('branch', name, `one of the known branches: ${[...branches.keys()].join(', ') || 'none yet, so fork one first'}`);
      }
      return { recipe: structuredClone(snapshots.get(branch.recipeKey)), baseKey: branch.baseKey,
        operations: structuredClone(branch.operations), baseRevision: branch.baseRevision };
    },
    names() {
      return [...branches.keys()];
    },
    snapshotCount() {
      return snapshots.size;
    },
    clear() {
      branches.clear();
      snapshots.clear();
    },
  };
}
