import { invalidField } from './field-error.js';

// Shared validation errors for the fields of one mesh edit. The path is edits[index].field, which the recipe and the
// edit-mesh operation both extend to a full path when the edit sits inside a geometry.

export function editField(index, field, value, expected, ErrorType = TypeError) {
  return invalidField(`edits[${index}].${field}`, value, expected, ErrorType);
}

export function editInteger(value, index, label, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw editField(index, label, value, `a whole number from ${minimum} to ${maximum}, such as ${Math.min(Math.max(1, minimum), maximum)}`);
  }
  return value;
}

export function editBoolean(value, index, label) {
  if (value !== undefined && typeof value !== 'boolean') throw editField(index, label, value, 'true or false');
  return value;
}

const AXES = ['x', 'y', 'z'];

export function editAxis(value, index, label = 'axis') {
  if (!AXES.includes(value)) throw editField(index, label, value, 'one of "x", "y", "z"');
  return value;
}

export function editRuleObject(value, index, label, hint) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw editField(index, label, value, hint);
  return value;
}
