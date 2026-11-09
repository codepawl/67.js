const MAXIMUM_SHOWN_CHARACTERS = 40;

// A short, safe rendering of a rejected value for an error message: JSON for plain data, cut to a fixed length.
export function describeReceived(value) {
  let text;
  if (value === undefined) {
    text = 'undefined';
  } else if (typeof value === 'number' || typeof value === 'bigint') {
    text = String(value);
  } else if (typeof value === 'function' || typeof value === 'symbol') {
    text = typeof value;
  } else {
    try {
      text = JSON.stringify(value) ?? String(value);
    } catch {
      text = Object.prototype.toString.call(value);
    }
  }
  return text.length > MAXIMUM_SHOWN_CHARACTERS ? `${text.slice(0, MAXIMUM_SHOWN_CHARACTERS - 3)}...` : text;
}

// Builds the validation error an agent-facing check throws: the field path, the value received and what is accepted,
// with an example or a range. withFieldPrefix turns the path into a full recipe path for entries of a list.
export function invalidField(path, value, expected, ErrorType = RangeError) {
  const error = new ErrorType(`${path}: got ${describeReceived(value)}; expected ${expected}.`);
  error.fieldPath = path;
  return error;
}

// Runs a check on one entry of a list and puts the list position in front of the field path of any field error it
// raises, so "emissiveColor: ..." becomes "materials[2].emissiveColor: ...".
export function withFieldPrefix(prefix, check) {
  try {
    return check();
  } catch (error) {
    if (typeof error?.fieldPath === 'string' && error.message.startsWith(error.fieldPath)) {
      error.message = `${prefix}.${error.message}`;
      error.fieldPath = `${prefix}.${error.fieldPath}`;
    }
    throw error;
  }
}
