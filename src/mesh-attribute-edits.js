import { createMeshData, GROUP_PREFIX, vertexGroupNames } from './mesh-data.js';
import { evaluateField, meshFieldContext } from './mesh-fields.js';
import { selectedVertices } from './mesh-field-edits.js';
import { selectFaces } from './mesh-select.js';

// Vertex colors (the corner attribute "color", three floats in 0 to 1) and vertex groups (the point attributes
// "group:<name>", one weight in 0 to 1 per vertex). Both are set by one value, a field expression or a gradient along
// an axis, on the faces a rule selects. Modifiers and cloth read a group by name.

export const GRADIENT_AXES = Object.freeze(['x', 'y', 'z']);
export const MAX_VERTEX_GROUPS = 32;
const COLOR_ATTRIBUTE = 'color';
const AXIS_OFFSETS = Object.freeze({ x: 0, y: 1, z: 2 });

function editError(index, message) {
  return new TypeError(`Mesh edit ${index} (${message})`);
}

function unitNumber(value, index, label, finiteNumber) {
  return finiteNumber(value, index, label, { minimum: 0, maximum: 1 });
}

function normalizeGradient(gradient, normalized, index, { finiteNumber, valuesKey, readValue }) {
  if (!gradient || typeof gradient !== 'object' || Array.isArray(gradient)) {
    throw editError(index, `gradient must be { axis, range: [low, high], ${valuesKey}: [atLow, atHigh] }`);
  }
  for (const key of Object.keys(gradient)) {
    if (!['axis', 'range', valuesKey].includes(key)) throw editError(index, `gradient does not take ${key}; fields: axis, range, ${valuesKey}`);
  }
  if (!GRADIENT_AXES.includes(gradient.axis)) throw editError(index, `gradient.axis must be one of ${GRADIENT_AXES.join(', ')}`);
  if (!Array.isArray(gradient.range) || gradient.range.length !== 2) throw editError(index, 'gradient.range needs two numbers, low then high');
  const range = gradient.range.map(value => finiteNumber(value, index, 'gradient.range'));
  if (!(range[0] < range[1])) throw editError(index, 'gradient.range must have low below high');
  if (!Array.isArray(gradient[valuesKey]) || gradient[valuesKey].length !== 2) {
    throw editError(index, `gradient.${valuesKey} needs two entries, the value at the low end then at the high end`);
  }
  normalized.gradient = { axis: gradient.axis, range, [valuesKey]: gradient[valuesKey].map((value, side) => readValue(value, `gradient.${valuesKey}[${side}]`)) };
}

function rejectSecondSource(edit, index, sources) {
  const given = sources.filter(source => edit[source] !== undefined);
  if (given.length > 1) throw editError(index, `give only one of ${sources.join(', ')}`);
  return given[0];
}

/** Validate a vertex_group edit: a required name and at most one of weight, field or gradient (default weight 1). */
export function normalizeVertexGroupEdit(edit, normalized, index, { finiteNumber, checkedField }) {
  const source = rejectSecondSource(edit, index, ['weight', 'field', 'gradient']);
  if (source === 'field') {
    normalized.field = checkedField(edit.field, index, 'field', 'scalar');
  } else if (source === 'gradient') {
    normalizeGradient(edit.gradient, normalized, index, {
      finiteNumber, valuesKey: 'weights', readValue: (value, label) => unitNumber(value, index, label, finiteNumber),
    });
  } else {
    normalized.weight = edit.weight === undefined ? 1 : unitNumber(edit.weight, index, 'weight', finiteNumber);
  }
}

/** Validate a vertex_color edit: color [r, g, b], a vector field or a two-color gradient (default white). */
export function normalizeVertexColorEdit(edit, normalized, index, { finiteNumber, checkedField }) {
  const readColor = (value, label) => {
    if (!Array.isArray(value) || value.length !== 3) throw editError(index, `${label} needs three numbers from 0 to 1`);
    return value.map(channel => unitNumber(channel, index, label, finiteNumber));
  };
  const source = rejectSecondSource(edit, index, ['color', 'field', 'gradient']);
  if (source === 'field') {
    normalized.field = checkedField(edit.field, index, 'field', 'vector');
  } else if (source === 'gradient') {
    normalizeGradient(edit.gradient, normalized, index, { finiteNumber, valuesKey: 'colors', readValue: readColor });
  } else {
    normalized.color = edit.color === undefined ? [1, 1, 1] : readColor(edit.color, 'color');
  }
}

function withAttribute(mesh, domain, name, attribute) {
  const attributes = { point: { ...mesh.attributes.point }, edge: { ...mesh.attributes.edge }, face: { ...mesh.attributes.face }, corner: { ...mesh.attributes.corner } };
  attributes[domain][name] = attribute;
  return createMeshData({
    positions: mesh.positions, faceOffsets: mesh.faceOffsets, cornerVertices: mesh.cornerVertices,
    edgeVertices: mesh.edgeVertices, cornerEdges: mesh.cornerEdges, attributes,
  });
}

// Where each vertex sits along the gradient axis, 0 at range low and 1 at range high.
function gradientFractions(mesh, gradient) {
  const offset = AXIS_OFFSETS[gradient.axis];
  const [low, high] = gradient.range;
  const fractions = new Float64Array(mesh.vertexCount);
  for (let vertex = 0; vertex < mesh.vertexCount; vertex++) {
    const fraction = (mesh.positions[vertex * 3 + offset] - low) / (high - low);
    fractions[vertex] = Math.min(1, Math.max(0, fraction));
  }
  return fractions;
}

/** Set the weight of a named group for the vertices of the selected faces; other vertices keep their weight (0 in a new group). */
export function setVertexGroup(mesh, { select, name, weight, field, gradient }) {
  const attributeName = GROUP_PREFIX + name;
  const existing = mesh.attributes.point[attributeName];
  if (!existing && vertexGroupNames(mesh).length >= MAX_VERTEX_GROUPS) {
    throw new RangeError(`A mesh holds at most ${MAX_VERTEX_GROUPS} vertex groups.`);
  }
  const weights = existing ? Float32Array.from(existing.data) : new Float32Array(mesh.vertexCount);
  const flags = selectedVertices(mesh, select);
  const fieldValues = field === undefined ? null : evaluateField(field, meshFieldContext(mesh, 'point'), { kind: 'scalar' }).values;
  const fractions = gradient ? gradientFractions(mesh, gradient) : null;
  let assignedVertices = 0;
  for (let vertex = 0; vertex < mesh.vertexCount; vertex++) {
    if (!flags[vertex]) continue;
    assignedVertices++;
    let value = weight;
    if (fieldValues) value = fieldValues[vertex];
    if (fractions) value = gradient.weights[0] + (gradient.weights[1] - gradient.weights[0]) * fractions[vertex];
    weights[vertex] = Math.min(1, Math.max(0, value));
  }
  return { mesh: withAttribute(mesh, 'point', attributeName, { data: weights, size: 1 }), assignedVertices };
}

/** Set the corner colors of the selected faces; corners of other faces keep their color (white when the mesh had none). */
export function setVertexColor(mesh, { select, color, field, gradient }) {
  const existing = mesh.attributes.corner[COLOR_ATTRIBUTE];
  const colors = existing?.size === 3 ? Float32Array.from(existing.data) : new Float32Array(mesh.cornerCount * 3).fill(1);
  const faceMask = select ? selectFaces(mesh, select) : null;
  const fieldValues = field === undefined ? null : evaluateField(field, meshFieldContext(mesh, 'point'), { kind: 'vector' }).values;
  const fractions = gradient ? gradientFractions(mesh, gradient) : null;
  let assignedCorners = 0;
  for (let face = 0; face < mesh.faceCount; face++) {
    if (faceMask && !faceMask[face]) continue;
    for (let corner = mesh.faceOffsets[face]; corner < mesh.faceOffsets[face + 1]; corner++) {
      const vertex = mesh.cornerVertices[corner];
      assignedCorners++;
      for (let channel = 0; channel < 3; channel++) {
        let value = color?.[channel];
        if (fieldValues) value = fieldValues[vertex * 3 + channel];
        if (fractions) value = gradient.colors[0][channel] + (gradient.colors[1][channel] - gradient.colors[0][channel]) * fractions[vertex];
        colors[corner * 3 + channel] = Math.min(1, Math.max(0, value));
      }
    }
  }
  return { mesh: withAttribute(mesh, 'corner', COLOR_ATTRIBUTE, { data: colors, size: 3 }), assignedCorners };
}
