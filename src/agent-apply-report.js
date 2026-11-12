// A short answer for scene_apply and mesh_edit: one entry per operation (what it did, or a warning that it did nothing)
// and a compact diff of the node, material and geometry IDs the batch added, removed and changed. Pure recipe data in,
// plain JSON out, so a library user gets the same answer as an MCP client.

export const APPLY_REPORT_LIMITS = Object.freeze({ maxEntries: 20, maxDiffIds: 8, maxText: 48 });

const COLLECTIONS = Object.freeze({ node: 'nodes', material: 'materials', geometry: 'geometries' });
const LOOK_SECTIONS = Object.freeze({ 'set-environment': 'environment', 'set-effects': 'effects', 'set-shadow': 'shadow' });
export const OWN_SECTIONS = Object.freeze({
  'set-motion': 'motion', 'set-physics': 'physics', 'set-timeline': 'timeline', 'set-cloth': 'cloth',
  'set-bake': 'bake', 'set-particles': 'particles', 'set-post-passes': 'postPasses', 'set-armatures': 'armatures', 'set-game': 'game',
});

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sameValue(left, right) {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((item, index) => sameValue(item, right[index]));
  }
  if (isPlainObject(left) && isPlainObject(right)) {
    const keys = Object.keys(left);
    return keys.length === Object.keys(right).length && keys.every(key => Object.hasOwn(right, key) && sameValue(left[key], right[key]));
  }
  return false;
}

// True when every field of the patch already holds in the current value (nested patches merge, arrays compare whole).
function patchHolds(current, patch) {
  if (!isPlainObject(patch) || !isPlainObject(current)) {
    return sameValue(current, patch);
  }
  return Object.keys(patch).every(key => patchHolds(current[key], patch[key]));
}

function mergePatch(current, patch) {
  if (!isPlainObject(patch) || !isPlainObject(current)) {
    return structuredClone(patch);
  }
  const merged = { ...current };
  for (const key of Object.keys(patch)) {
    merged[key] = mergePatch(current[key], patch[key]);
  }
  return merged;
}

function fieldNames(operation, skipped) {
  return Object.keys(operation).filter(key => !skipped.includes(key));
}

function shortList(names, maxText) {
  const text = names.join(', ');
  return text.length > maxText ? `${text.slice(0, maxText - 1)}…` : text;
}

function targetOf(operation) {
  const direct = operation.id ?? operation.geometry;
  if (typeof direct === 'string') return direct;
  for (const field of ['node', 'material', 'geometry']) {
    if (typeof operation[field]?.id === 'string') return operation[field].id;
  }
  if (Object.hasOwn(LOOK_SECTIONS, operation.type)) return LOOK_SECTIONS[operation.type];
  return operation.type === 'set-camera' ? 'camera' : undefined;
}

// Applies one operation to the working copy and says what it changed. Fields it cannot judge count as changed.
function describeOperation(working, operation, maxText) {
  const { type } = operation;
  const add = /^add-(node|material|geometry)$/.exec(type);
  if (add) {
    const [, kind] = add;
    working[COLLECTIONS[kind]].push(structuredClone(operation[kind]));
    return { changed: `added ${kind}` };
  }
  const remove = /^remove-(node|material|geometry)$/.exec(type);
  if (remove) {
    const [, kind] = remove;
    const collection = working[COLLECTIONS[kind]];
    const index = collection.findIndex(record => record.id === operation.id);
    if (index >= 0) collection.splice(index, 1);
    return { changed: `removed ${kind}` };
  }
  const section = LOOK_SECTIONS[type] ?? (type === 'set-camera' ? 'camera' : null);
  if (section) {
    const patch = type === 'set-camera' ? Object.fromEntries(fieldNames(operation, ['type']).map(key => [key, operation[key]])) : operation[section];
    if (patchHolds(working[section], patch)) return { warning: 'no change, values already set' };
    const names = Object.keys(patch).filter(key => !patchHolds(working[section]?.[key], patch[key]));
    working[section] = mergePatch(working[section] ?? {}, patch);
    return { changed: shortList(names, maxText) };
  }
  if (type === 'set-node' || type === 'set-material') {
    const collection = working[type === 'set-node' ? 'nodes' : 'materials'];
    const target = collection.find(record => record.id === operation.id);
    const names = fieldNames(operation, ['type', 'id']);
    if (!target) return { changed: shortList(names, maxText) };
    const differing = names.filter(name => !sameValue(target[name], operation[name]));
    if (differing.length === 0) return { warning: 'no change, values already set' };
    for (const name of differing) target[name] = structuredClone(operation[name]);
    return { changed: shortList(differing, maxText) };
  }
  if (Object.hasOwn(OWN_SECTIONS, type)) {
    const name = OWN_SECTIONS[type];
    const next = operation[name] === null ? undefined : operation[name];
    if (sameValue(working[name], next)) return { warning: 'no change, section already set' };
    if (next === undefined) delete working[name];
    else working[name] = structuredClone(next);
    return { changed: operation[name] === null ? `cleared ${name}` : `set ${name}` };
  }
  if (type === 'fracture-node') {
    return { changed: `fractured ${operation.node} into ${operation.cells} pieces with glue` };
  }
  if (type === 'settle') {
    return { changed: `settled props under ${operation.settle?.id}; scene_inspect lists them` };
  }
  if (type === 'bake-motion') {
    return { changed: `baked ${shortList(operation.nodes ?? [], maxText)} to keys` };
  }
  if (type === 'edit-mesh') {
    const count = Array.isArray(operation.edits) ? operation.edits.length : 0;
    if (count === 0 && !operation.replace) return { warning: 'no change, no edits given' };
    return { changed: `${operation.replace ? 'replaced the log with' : 'appended'} ${count} edit${count === 1 ? '' : 's'}` };
  }
  return { changed: shortList(fieldNames(operation, ['type', 'id']), maxText) || 'applied' };
}

function idDiff(before, after, cap) {
  const beforeById = new Map(before.map(record => [record.id, record]));
  const afterIds = new Set(after.map(record => record.id));
  const added = after.filter(record => !beforeById.has(record.id)).map(record => record.id);
  const removed = before.filter(record => !afterIds.has(record.id)).map(record => record.id);
  const changed = after.filter(record => beforeById.has(record.id) && !sameValue(beforeById.get(record.id), record)).map(record => record.id);
  const result = {};
  for (const [name, ids] of [['added', added], ['removed', removed], ['changed', changed]]) {
    if (ids.length > 0) {
      result[name] = ids.length > cap ? [...ids.slice(0, cap), `+${ids.length - cap} more`] : ids;
    }
  }
  return result;
}

/**
 * @param {object} before The recipe before the batch (exportRecipe).
 * @param {object} after The recipe after it.
 * @param {object[]} operations The operations that were applied, in order.
 * @returns {{ results: object[], omittedResults?: number, omittedWarnings?: number, diff: object }}
 */
export function describeApplication(before, after, operations, limits = APPLY_REPORT_LIMITS) {
  const working = structuredClone(before);
  for (const collection of Object.values(COLLECTIONS)) working[collection] ??= [];
  const entries = operations.map((operation, index) => {
    const outcome = describeOperation(working, operation, limits.maxText);
    const target = targetOf(operation);
    return { i: index, op: operation.type, ...(target === undefined ? {} : { target }), ...outcome };
  });
  const omitted = entries.slice(limits.maxEntries);
  const omittedWarnings = omitted.filter(entry => entry.warning).length;
  const diff = {};
  for (const collection of Object.values(COLLECTIONS)) {
    const part = idDiff(before[collection] ?? [], after[collection] ?? [], limits.maxDiffIds);
    if (Object.keys(part).length > 0) diff[collection] = part;
  }
  return {
    results: entries.slice(0, limits.maxEntries),
    ...(omitted.length > 0 ? { omittedResults: omitted.length } : {}),
    ...(omittedWarnings > 0 ? { omittedWarnings } : {}),
    diff,
  };
}
