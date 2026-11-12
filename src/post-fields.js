// Field checks shared by the named post steps (post-steps.js, post-air.js). Each throws an error that names the field.

export function numberInRange(value, fallback, minimum, maximum, name) {
  const result = value ?? fallback;
  if (!Number.isFinite(result) || result < minimum || result > maximum) throw new RangeError(`${name} must be between ${minimum} and ${maximum}.`);
  return result;
}

export function groupOf(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object.`);
  return value;
}

export function onlyKeys(group, allowed, name) {
  for (const key of Object.keys(group)) {
    if (!allowed.includes(key)) throw new TypeError(`Unknown ${name} field "${key}".`);
  }
}

export function triple(value, fallback, minimum, maximum, name) {
  const source = value ?? fallback;
  if (!Array.isArray(source) || source.length !== 3) throw new TypeError(`${name} must be three numbers.`);
  return source.map((component, index) => numberInRange(component, fallback[index], minimum, maximum, `${name}[${index}]`));
}
