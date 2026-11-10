import { createMeshData, GROUP_PREFIX, vertexGroupNames, vertexGroupWeights } from './mesh-data.js';
import { MASK_MEASURES, MASK_LIMITS, checkOcclusionWork, measureVertexMask } from './mesh-masks.js';
import { evaluateField, meshFieldContext } from './mesh-fields.js';
import { selectedVertices } from './mesh-field-edits.js';
import { selectFaces } from './mesh-select.js';
import { editField } from './mesh-edit-field.js';

// Vertex colors (the corner attribute "color", three floats in 0 to 1) and vertex groups (the point attributes
// "group:<name>", one weight in 0 to 1 per vertex). Both are set by one value, a field expression or a gradient along
// an axis, on the faces a rule selects. Modifiers and cloth read a group by name.

export const GRADIENT_AXES = Object.freeze(['x', 'y', 'z']);
export const MAX_VERTEX_GROUPS = 32;
const COLOR_ATTRIBUTE = 'color';
const AXIS_OFFSETS = Object.freeze({ x: 0, y: 1, z: 2 });

function unitNumber(value, index, label, finiteNumber) {
  return finiteNumber(value, index, label, { minimum: 0, maximum: 1 });
}

function normalizeGroupGradient(gradient, normalized, index, readValue) {
  for (const key of Object.keys(gradient)) {
    if (!['group', 'colors'].includes(key)) throw editField(index, `gradient.${key}`, gradient[key], `one of the group gradient fields group, colors; remove "${key}"`);
  }
  if (typeof gradient.group !== 'string' || gradient.group === '') throw editField(index, 'gradient.group', gradient.group, 'the name of a vertex group, such as "wear"');
  if (!Array.isArray(gradient.colors) || gradient.colors.length < 2 || gradient.colors.length > 3) {
    throw editField(index, 'gradient.colors', gradient.colors, 'two colors (weight 0 then 1) or three (weight 0, 0.5 then 1), such as [[0.1, 0.1, 0.1], [0.8, 0.1, 0.1], [0.8, 0.8, 0.8]]');
  }
  normalized.gradient = { group: gradient.group, colors: gradient.colors.map((value, stop) => readValue(value, `gradient.colors[${stop}]`)) };
}

function normalizeGradient(gradient, normalized, index, { finiteNumber, valuesKey, readValue }) {
  const example = valuesKey === 'weights' ? '[0, 1]' : '[[1, 0, 0], [0, 0, 1]]';
  if (!gradient || typeof gradient !== 'object' || Array.isArray(gradient)) {
    throw editField(index, 'gradient', gradient, `an object such as { "axis": "z", "range": [0, 1], "${valuesKey}": ${example} }`);
  }
  if (gradient.group !== undefined && valuesKey === 'colors') return normalizeGroupGradient(gradient, normalized, index, readValue);
  for (const key of Object.keys(gradient)) {
    if (!['axis', 'range', valuesKey].includes(key)) throw editField(index, `gradient.${key}`, gradient[key], `one of the gradient fields axis, range, ${valuesKey}; remove "${key}"`);
  }
  if (!GRADIENT_AXES.includes(gradient.axis)) throw editField(index, 'gradient.axis', gradient.axis, `one of ${GRADIENT_AXES.join(', ')}`);
  if (!Array.isArray(gradient.range) || gradient.range.length !== 2) throw editField(index, 'gradient.range', gradient.range, 'an array of two numbers, low then high, such as [0, 1]');
  const range = gradient.range.map(value => finiteNumber(value, index, 'gradient.range'));
  if (!(range[0] < range[1])) throw editField(index, 'gradient.range', range, 'two numbers with low below high, such as [0, 1]');
  if (!Array.isArray(gradient[valuesKey]) || gradient[valuesKey].length !== 2) {
    throw editField(index, `gradient.${valuesKey}`, gradient[valuesKey], `an array of two entries, the value at the low end then at the high end, such as ${example}`);
  }
  normalized.gradient = { axis: gradient.axis, range, [valuesKey]: gradient[valuesKey].map((value, side) => readValue(value, `gradient.${valuesKey}[${side}]`)) };
}

function rejectSecondSource(edit, index, sources) {
  const given = sources.filter(source => edit[source] !== undefined);
  if (given.length > 1) throw editField(index, given[1], edit[given[1]], `left out, because only one of ${sources.join(', ')} is allowed, such as keeping ${given[0]}`);
  return given[0];
}

const MEASURE_SETTINGS = Object.freeze({ curvature: ['gain'], edge: ['angle'], occlusion: ['rays', 'distance', 'seed'] });

function normalizeMeasure(edit, normalized, index, finiteNumber) {
  if (!MASK_MEASURES.includes(edit.measure)) throw editField(index, 'measure', edit.measure, `one of ${MASK_MEASURES.join(', ')}`);
  normalized.measure = edit.measure;
  const allowed = MEASURE_SETTINGS[edit.measure];
  for (const setting of Object.keys(MASK_LIMITS).filter(name => Array.isArray(MASK_LIMITS[name])).concat('distance')) {
    if (edit[setting] === undefined) continue;
    if (!allowed.includes(setting)) throw editField(index, setting, edit[setting], `left out, because measure "${edit.measure}" takes ${allowed.join(', ')}`);
    if (setting === 'distance') {
      normalized.distance = finiteNumber(edit.distance, index, 'distance', { minimum: 0, exclusiveMinimum: true });
    } else if (setting === 'rays' || setting === 'seed') {
      const [minimum, maximum] = MASK_LIMITS[setting];
      if (!Number.isInteger(edit[setting]) || edit[setting] < minimum || edit[setting] > maximum) {
        throw editField(index, setting, edit[setting], `a whole number from ${minimum} to ${maximum}`);
      }
      normalized[setting] = edit[setting];
    } else {
      const [minimum, maximum] = MASK_LIMITS[setting];
      normalized[setting] = finiteNumber(edit[setting], index, setting, { minimum, maximum });
    }
  }
}

/** Validate a vertex_group edit: a required name and at most one of weight, field or gradient (default weight 1). */
export function normalizeVertexGroupEdit(edit, normalized, index, { finiteNumber, checkedField }) {
  const source = rejectSecondSource(edit, index, ['weight', 'field', 'gradient', 'measure']);
  if (source === 'measure') {
    normalizeMeasure(edit, normalized, index, finiteNumber);
  } else if (source === 'field') {
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
    if (!Array.isArray(value) || value.length !== 3) throw editField(index, label, value, 'an array of three numbers from 0 to 1, such as [1, 0.5, 0]');
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

// Colors along the weights of a vertex group: two stops sit at weight 0 and 1, three at 0, 0.5 and 1.
function groupStops(mesh, { group, colors }) {
  const weights = vertexGroupWeights(mesh, group);
  const lastStop = colors.length - 1;
  return (vertex, channel) => {
    const position = Math.min(1, Math.max(0, weights[vertex])) * lastStop;
    const lower = Math.min(lastStop - 1, Math.floor(position));
    return colors[lower][channel] + (colors[lower + 1][channel] - colors[lower][channel]) * (position - lower);
  };
}

/** Set the weight of a named group for the vertices of the selected faces; other vertices keep their weight (0 in a new group). */
export function setVertexGroup(mesh, { select, name, weight, field, gradient, measure, ...measureSettings }, loadSurface) {
  const attributeName = GROUP_PREFIX + name;
  const existing = mesh.attributes.point[attributeName];
  if (!existing && vertexGroupNames(mesh).length >= MAX_VERTEX_GROUPS) {
    throw new RangeError(`A mesh holds at most ${MAX_VERTEX_GROUPS} vertex groups.`);
  }
  const weights = existing ? Float32Array.from(existing.data) : new Float32Array(mesh.vertexCount);
  const flags = selectedVertices(mesh, select);
  const fieldValues = field === undefined ? null : evaluateField(field, meshFieldContext(mesh, 'point', loadSurface), { kind: 'scalar' }).values;
  const fractions = gradient?.axis ? gradientFractions(mesh, gradient) : null;
  if (measure === 'occlusion') checkOcclusionWork(flags.reduce((count, flag) => count + (flag ? 1 : 0), 0), measureSettings.rays ?? 32);
  const measured = measure ? measureVertexMask(mesh, measure, measureSettings, flags) : null;
  let assignedVertices = 0;
  for (let vertex = 0; vertex < mesh.vertexCount; vertex++) {
    if (!flags[vertex]) continue;
    assignedVertices++;
    let value = weight;
    if (fieldValues) value = fieldValues[vertex];
    if (measured) value = measured[vertex];
    if (fractions) value = gradient.weights[0] + (gradient.weights[1] - gradient.weights[0]) * fractions[vertex];
    weights[vertex] = Math.min(1, Math.max(0, value));
  }
  return { mesh: withAttribute(mesh, 'point', attributeName, { data: weights, size: 1 }), assignedVertices };
}

/** Set the corner colors of the selected faces; corners of other faces keep their color (white when the mesh had none). */
export function setVertexColor(mesh, { select, color, field, gradient }, loadSurface) {
  const existing = mesh.attributes.corner[COLOR_ATTRIBUTE];
  const colors = existing?.size === 3 ? Float32Array.from(existing.data) : new Float32Array(mesh.cornerCount * 3).fill(1);
  const faceMask = select ? selectFaces(mesh, select) : null;
  const fieldValues = field === undefined ? null : evaluateField(field, meshFieldContext(mesh, 'point', loadSurface), { kind: 'vector' }).values;
  const fractions = gradient?.axis ? gradientFractions(mesh, gradient) : null;
  const stopped = gradient?.group === undefined ? null : groupStops(mesh, gradient);
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
        if (stopped) value = stopped(vertex, channel);
        colors[corner * 3 + channel] = Math.min(1, Math.max(0, value));
      }
    }
  }
  return { mesh: withAttribute(mesh, 'corner', COLOR_ATTRIBUTE, { data: colors, size: 3 }), assignedCorners };
}
