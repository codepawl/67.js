import { agentSceneModule } from './agent-scene-modules.js';
import { invalidField, withFieldPrefix } from './field-error.js';
import { generateCutterGeometry } from './agent-scene.js';
import { IMPORTED_MESH_EDIT_LIMITS } from './mesh-operations.js';
import { MESH_SMOOTH_ANGLE_DEFAULT } from './agent-scene-capabilities.js';
import { validateSkinGeometry } from './skinning.js';
import { validateMorphGeometry } from './morph.js';

// Mesh edits on the parts of an imported asset. The recipe keeps `meshEdits: [{ id: 'mesh-1', edits: [...] }]`, the
// same edit log a recipe mesh has, so a checkpoint or an exported recipe replays them on the decoded asset. The edited
// geometry is built when the recipe is published and cached by its edit log, so a pose change never rebuilds it.

const MAX_EDITED_VERTICES = 250_000;

function partIdList(records) {
  return records.map(record => record.id).join(', ');
}

/** Validate and copy the `meshEdits` of a recipe. Entries with no edits are dropped. */
export function normalizeMeshEditEntries(input, records) {
  if (input === undefined) return [];
  if (!Array.isArray(input) || input.length > IMPORTED_MESH_EDIT_LIMITS.maxEditedParts) {
    throw invalidField('meshEdits', Array.isArray(input) ? input.length : input, `an array of at most ${IMPORTED_MESH_EDIT_LIMITS.maxEditedParts} parts, such as [{ "id": "mesh-0", "edits": [] }]`);
  }
  const seen = new Set();
  const entries = [];
  for (const [index, entry] of input.entries()) {
    const unknownKey = Object.keys(entry ?? {}).find(key => key !== 'id' && key !== 'edits');
    if (!entry || typeof entry !== 'object' || unknownKey || !Array.isArray(entry.edits)) {
      throw invalidField(`meshEdits[${index}]${unknownKey ? `.${unknownKey}` : ''}`, unknownKey ? entry[unknownKey] : entry, 'an object with only id and edits, such as { "id": "mesh-0", "edits": [] }', TypeError);
    }
    if (!records.some(record => record.id === entry.id) || seen.has(entry.id)) {
      throw invalidField(`meshEdits[${index}].id`, entry.id, `an imported mesh ID used once, such as ${partIdList(records.slice(0, 3))}; scene_inspect lists them`);
    }
    seen.add(entry.id);
    withFieldPrefix(`meshEdits[${index}]`, () => agentSceneModule('mesh').normalizeMeshEdits(entry.edits));
    if (entry.edits.length) entries.push({ id: entry.id, edits: structuredClone(entry.edits) });
  }
  return entries;
}

/** The recipe's meshEdits after one `edit-mesh` operation: edits append to the part's log, or replace it. */
export function meshEditEntriesAfter(entries, operation, records) {
  if (!records.some(record => record.id === operation.geometry)) {
    throw invalidField('geometry', operation.geometry, `an imported mesh ID such as ${partIdList(records.slice(0, 3))}; scene_inspect lists them`);
  }
  if (typeof operation.replace !== 'undefined' && typeof operation.replace !== 'boolean') {
    throw invalidField('replace', operation.replace, 'true or false', TypeError);
  }
  if (!Array.isArray(operation.edits)) {
    throw invalidField('edits', operation.edits, 'an array of edits, such as [{ "op": "subdivide", "levels": 1 }]', TypeError);
  }
  const existing = entries.find(entry => entry.id === operation.geometry);
  const edits = operation.replace || !existing ? operation.edits : [...existing.edits, ...operation.edits];
  const others = entries.filter(entry => entry.id !== operation.geometry);
  return [...others, { id: operation.geometry, edits }];
}

function failureMessage(record, error) {
  const kind = record.source.skin ? 'skin weights' : 'morph targets';
  return `${record.id} cannot keep its ${kind} after this edit: ${error.message} Undo with scene_restore or replace the edit log, and cut within the existing surface.`;
}

function buildEntry(record, key, edits, describe) {
  const source = record.source.geometry;
  const result = agentSceneModule('mesh').editImportedGeometry(source, edits, {
    maxVertices: MAX_EDITED_VERTICES, smoothAngle: MESH_SMOOTH_ANGLE_DEFAULT, materialTag: record.material.id,
    resolveCutter: cutter => generateCutterGeometry(cutter, MAX_EDITED_VERTICES),
  });
  let morphMetadata;
  try {
    validateSkinGeometry(result.geometry, record.source.skin);
    morphMetadata = validateMorphGeometry(result.geometry, record.source.morph);
  } catch (error) {
    throw new RangeError(failureMessage(record, error));
  }
  agentSceneModule('mesh').registerEditedMesh(result.geometry, result.mesh, result.results);
  return { key, geometry: result.geometry, info: describe(result.geometry), morphMetadata, results: result.results, transfer: result.transfer };
}

/** Edited geometry by part ID for the given entries, reusing entries of `previous` whose edit log is unchanged. */
export function realizeMeshEdits(entries, records, previous, describe) {
  const realized = new Map();
  for (const entry of entries) {
    const key = JSON.stringify(entry.edits);
    const record = records.find(candidate => candidate.id === entry.id);
    const kept = previous.get(entry.id);
    try {
      realized.set(entry.id, kept?.key === key ? kept : buildEntry(record, key, entry.edits, describe));
    } catch (error) {
      if (error.message.startsWith(entry.id)) throw error;
      throw new RangeError(`${entry.id}: ${error.message}`);
    }
  }
  return realized;
}

/** Part IDs and edit log signature, so the scene can tell when the renderer geometry must be rebuilt. */
export function meshEditSignature(realized) {
  return [...realized].map(([id, entry]) => `${id}:${entry.key}`).sort().join('|');
}
