import { applyMeshEdits, normalizeMeshEdits } from './mesh-recipe.js';

// Shape keys of a recipe mesh: named vertex offsets from the evaluated mesh, written as glTF morph targets so the
// existing morph tracks (motion kind "morph", id = key name) animate their weights and a GLB export carries them.
//
//   "shapeKeys": [
//     { "name": "blink", "offsets": [{ "select": { "tag": "lid" }, "offset": [0, -0.1, 0] }] },
//     { "name": "squash", "edits": [{ "op": "simple_deform", "mode": "taper", "axis": "y", "factor": -0.4 }], "value": 0 }
//   ]

export const MAX_SHAPE_KEYS = 16;
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/;
const KEY_FIELDS = ['name', 'edits', 'offsets', 'value'];
const OFFSET_FIELDS = ['select', 'offset', 'falloff'];

function keyError(index, message) {
  return new TypeError(`Shape key ${index} (${message})`);
}

function offsetEdit(entry, keyIndex) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw keyError(keyIndex, 'each offsets entry must be { select, offset, falloff }');
  for (const field of Object.keys(entry)) {
    if (!OFFSET_FIELDS.includes(field)) throw keyError(keyIndex, `offsets entries do not take ${field}; fields: ${OFFSET_FIELDS.join(', ')}`);
  }
  return { op: 'translate', ...entry };
}

/**
 * Validate shape keys and return them with offsets turned into translate edits: [{ name, value, edits }].
 * A key is built from `edits` (mesh edits that only move vertices) or `offsets` ({ select, offset, falloff } moves).
 */
export function normalizeShapeKeys(shapeKeys) {
  if (!Array.isArray(shapeKeys) || shapeKeys.length > MAX_SHAPE_KEYS) {
    throw new RangeError(`shapeKeys must be an array of at most ${MAX_SHAPE_KEYS} keys.`);
  }
  const names = new Set();
  return shapeKeys.map((key, index) => {
    if (!key || typeof key !== 'object' || Array.isArray(key)) throw keyError(index, 'each key must be an object');
    for (const field of Object.keys(key)) {
      if (!KEY_FIELDS.includes(field)) throw keyError(index, `does not take ${field}; fields: ${KEY_FIELDS.join(', ')}`);
    }
    if (typeof key.name !== 'string' || !NAME_PATTERN.test(key.name)) throw keyError(index, 'name must be 1 to 48 letters, digits, dots, dashes or underscores');
    if (names.has(key.name)) throw keyError(index, `name ${key.name} is used twice`);
    names.add(key.name);
    if ((key.edits === undefined) === (key.offsets === undefined)) throw keyError(index, 'give exactly one of edits or offsets');
    const value = key.value ?? 0;
    if (typeof value !== 'number' || !(value >= 0 && value <= 1)) throw keyError(index, 'value is the starting weight, from 0 to 1');
    const edits = key.edits ?? (Array.isArray(key.offsets) ? key.offsets.map(entry => offsetEdit(entry, index)) : null);
    if (!edits) throw keyError(index, 'offsets must be an array');
    normalizeMeshEdits(edits);
    return { name: key.name, value, edits };
  });
}

/**
 * The morph targets of the keys: each key's edits run on the evaluated mesh and the per-vertex difference is gathered into
 * render vertices. A key that adds, removes or reorders vertices is an error, because a morph target is one offset per vertex.
 */
export function shapeKeyTargets(mesh, renderVertexSource, keys, editOptions) {
  return keys.map(key => {
    const shaped = applyMeshEdits(mesh, key.edits, editOptions).mesh;
    if (shaped.vertexCount !== mesh.vertexCount || shaped.faceCount !== mesh.faceCount) {
      throw new RangeError(`Shape key ${key.name} changed the mesh from ${mesh.vertexCount} to ${shaped.vertexCount} vertices. Use edits that only move vertices (translate, set_position, displace, sculpt, shrinkwrap, smooth, simple_deform, lattice, hook, wave) or offsets.`);
    }
    const positions = new Float32Array(renderVertexSource.length * 3);
    for (let renderVertex = 0; renderVertex < renderVertexSource.length; renderVertex++) {
      const vertex = renderVertexSource[renderVertex];
      for (let axis = 0; axis < 3; axis++) {
        positions[renderVertex * 3 + axis] = shaped.positions[vertex * 3 + axis] - mesh.positions[vertex * 3 + axis];
      }
    }
    return { positions };
  });
}
