// Checks shared by the motion normalizers: agent input is untrusted plain data, so every field is named and bounded.
import { invalidField } from './field-error.js';

export function knownKeys(value, fields, label) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${label} must be a plain object.`);
  }
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !fields.includes(key) || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new TypeError(`Unknown or unsupported ${label} field: ${String(key)}. Allowed fields: ${fields.join(", ")}.`);
    }
  }
}

export function finite(value, label) {
  if (!Number.isFinite(value) || !Number.isFinite(Math.fround(value))) {
    throw invalidField(label, value, 'a finite number that fits Float32, such as 0.5');
  }
  return value;
}

export function bounded(value, minimum, maximum, label) {
  finite(value, label);
  if (value < minimum || value > maximum) {
    throw invalidField(label, value, `a number from ${minimum} to ${maximum}, such as ${minimum > 0 ? minimum : Math.min(maximum, 1)}`);
  }
  return value;
}

export function denseArray(value, maximum, label) {
  if (!Array.isArray(value) || value.length > maximum || Object.keys(value).length !== value.length ||
      Reflect.ownKeys(value).length !== value.length + 1 || Object.keys(value).some((key, index) => key !== String(index))) {
    throw new TypeError(`${label} must be a bounded dense array.`);
  }
  for (let index = 0; index < value.length; index++) {
    if (!Object.hasOwn(Object.getOwnPropertyDescriptor(value, index), 'value')) {
      throw new TypeError(`${label} cannot contain accessors.`);
    }
  }
  return value;
}

export function valueFrom(value, size, label) {
  if (size === 1) {
    return finite(value, label);
  }
  denseArray(value, size, label);
  if (value.length !== size) {
    throw invalidField(label, value, `an array of ${size} numbers, such as [${Array(size).fill(0).join(', ')}]`, TypeError);
  }
  return value.map(component => finite(component, label));
}
