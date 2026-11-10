import { selectEdges, edgeFaces } from './mesh-bevel.js';
import { selectFaces, countSelected } from './mesh-select.js';
import { invalidField } from './field-error.js';
import { editField, editRuleObject } from './mesh-edit-field.js';
import { EDGE_RULE_HINT } from './mesh-cut-edits.js';
import { pokeFaces, dualMesh, trisToQuads, symmetrizeMesh, scaleElements, extrudeEdges } from './mesh-reshape.js';

// The reshaping edits as recipe operations: validation of their fields and running them on MeshData. The geometry
// lives in mesh-reshape.js; this file only connects it to the edit log.

export const RESHAPE_OPERATIONS = Object.freeze(['poke', 'dual', 'tris_to_quads', 'symmetrize', 'scale_elements', 'extrude_edges']);

const SYMMETRIZE_SIDES = Object.freeze(['positive', 'negative']);
const MAX_SCALE = 1000;

/** Fill in `normalized` for a reshaping edit, throwing a TypeError that names the edit when a field is wrong. */
export function normalizeReshapeEdit(edit, normalized, index, { finiteNumber, vector }) {
  switch (edit.op) {
    case 'poke':
      normalized.offset = edit.offset === undefined ? 0 : finiteNumber(edit.offset, index, 'offset');
      if (edit.relative !== undefined && typeof edit.relative !== 'boolean') throw editField(index, 'relative', edit.relative, 'true or false');
      normalized.relative = edit.relative ?? false;
      break;
    case 'tris_to_quads':
      normalized.angle = edit.angle === undefined ? 40 : finiteNumber(edit.angle, index, 'angle', { minimum: 0, maximum: 180 });
      break;
    case 'symmetrize':
      if (edit.axis !== undefined && !['x', 'y', 'z'].includes(edit.axis)) throw editField(index, 'axis', edit.axis, 'one of "x", "y", "z"');
      normalized.axis = edit.axis ?? 'x';
      if (edit.keep !== undefined && !SYMMETRIZE_SIDES.includes(edit.keep)) throw editField(index, 'keep', edit.keep, `one of ${SYMMETRIZE_SIDES.map(side => `"${side}"`).join(', ')}`);
      normalized.keep = edit.keep ?? 'positive';
      normalized.distance = edit.distance === undefined ? 1e-4 : finiteNumber(edit.distance, index, 'distance', { minimum: 0, maximum: 1 });
      break;
    case 'scale_elements':
      normalized.scale = finiteNumber(edit.scale, index, 'scale', { minimum: 0, maximum: MAX_SCALE, exclusiveMinimum: true });
      break;
    case 'extrude_edges':
      normalized.edges = editRuleObject(edit.edges, index, 'edges', EDGE_RULE_HINT);
      normalized.offset = vector(edit.offset, index, 'offset');
      break;
  }
}

/** Refuse an extrude_edges that would grow past the limits, before it allocates anything. */
export function checkReshapeBudget(mesh, edit, limits, index) {
  if (edit.op === 'poke') {
    const mask = selectFaces(mesh, edit.select);
    let corners = 0;
    for (let face = 0; face < mesh.faceCount; face++) {
      if (mask[face]) corners += mesh.faceOffsets[face + 1] - mesh.faceOffsets[face];
    }
    const faces = mesh.faceCount - countSelected(mask) + corners;
    if (faces > limits.maxFaces) {
      throw editField(index, 'select', edit.select, `a rule that keeps the mesh within ${limits.maxFaces} faces (this edit would make ${faces}), such as { "tag": "top" }`, RangeError);
    }
  }
  if (edit.op === 'extrude_edges') {
    const edges = countSelected(selectEdges(mesh, edit.edges, edgeFaces(mesh)));
    if (mesh.faceCount + edges > limits.maxFaces || mesh.vertexCount + edges * 2 > limits.maxVertices) {
      throw editField(index, 'edges', edit.edges, `a rule that keeps the mesh within ${limits.maxVertices} vertices and ${limits.maxFaces} faces (this edit would add up to ${edges * 2} vertices and ${edges} faces), such as { "open": true }`, RangeError);
    }
  }
}

function faceMaskOf(mesh, rule) {
  const mask = selectFaces(mesh, rule);
  if (countSelected(mask) === 0) throw invalidField('select', rule, 'a rule that matches at least one face, such as { "all": true } (check tags and counts with mesh_inspect)');
  return mask;
}

/** Run a reshaping edit. Returns { mesh, result } where result holds the counts to report. */
export function runReshapeEdit(mesh, edit) {
  switch (edit.op) {
    case 'poke': {
      const outcome = pokeFaces(mesh, faceMaskOf(mesh, edit.select), { offset: edit.offset, relative: edit.relative, name: edit.name });
      return { mesh: outcome.mesh, result: { pokedFaces: outcome.pokedFaces } };
    }
    case 'dual': {
      const outcome = dualMesh(mesh, { name: edit.name });
      return { mesh: outcome.mesh, result: { dualVertices: outcome.dualVertices, dualFaces: outcome.dualFaces } };
    }
    case 'tris_to_quads': {
      const outcome = trisToQuads(mesh, faceMaskOf(mesh, edit.select), { angle: edit.angle, name: edit.name });
      return { mesh: outcome.mesh, result: { joinedPairs: outcome.joinedPairs } };
    }
    case 'symmetrize': {
      const outcome = symmetrizeMesh(mesh, { axis: edit.axis, keep: edit.keep, distance: edit.distance, name: edit.name });
      return { mesh: outcome.mesh, result: { removedFaces: outcome.removedFaces } };
    }
    case 'scale_elements': {
      const outcome = scaleElements(mesh, faceMaskOf(mesh, edit.select), { scale: edit.scale });
      return { mesh: outcome.mesh, result: { movedVertices: outcome.movedVertices, islands: outcome.islands } };
    }
    case 'extrude_edges': {
      const outcome = extrudeEdges(mesh, selectEdges(mesh, edit.edges, edgeFaces(mesh)), { offset: edit.offset, name: edit.name });
      return { mesh: outcome.mesh, result: { extrudedEdges: outcome.extrudedEdges } };
    }
  }
  throw new TypeError(`Not a reshaping edit: ${edit.op}`);
}
