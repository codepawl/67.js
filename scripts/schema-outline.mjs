// Turns a JSON Schema into a compact outline an agent can read: field names, types, ranges, enums and one-line notes
// without the JSON Schema bookkeeping. scene_capabilities serves these outlines by topic, so the tool schemas themselves
// stay short while the full field detail is one call away.

const DESCRIPTION_KEY = '_';

// The Float32 limit on a plain number is not a useful bound to read.
const FLOAT32_LIMIT = 3e38;
const boundOf = value => (Math.abs(value) >= FLOAT32_LIMIT ? undefined : value);

function rangeText(node) {
  const lowest = boundOf(node.minimum);
  const highest = boundOf(node.maximum);
  const minimum = lowest ?? (node.exclusiveMinimum === undefined ? undefined : `>${node.exclusiveMinimum}`);
  const maximum = highest ?? (node.exclusiveMaximum === undefined ? undefined : `<${node.exclusiveMaximum}`);
  if (minimum === undefined && maximum === undefined) return '';
  return `[${minimum ?? ''}..${maximum ?? ''}]`;
}

function lengthText(node) {
  if (node.minItems === undefined && node.maxItems === undefined) return '';
  return `{${node.minItems ?? ''}..${node.maxItems ?? ''}}`;
}

function withNote(text, node) {
  return node.description ? `${text} // ${node.description}` : text;
}

function referenceName(reference) {
  return reference.replace('#/$defs/', '');
}

function literalOf(node) {
  if (node.const !== undefined) return JSON.stringify(node.const);
  if (node.enum) return node.enum.map(value => JSON.stringify(value)).join('|');
  return undefined;
}

function outlineUnion(branches, node, definitions) {
  const literals = branches.map(literalOf);
  if (literals.every(Boolean)) return withNote(literals.join('|'), node);
  const outlined = branches.map(branch => outline(branch, definitions));
  if (outlined.every(entry => typeof entry === 'string')) return withNote(outlined.join(' | '), node);
  return { oneOf: outlined, ...(node.description ? { [DESCRIPTION_KEY]: node.description } : {}) };
}

function outlineObject(node, definitions) {
  const required = new Set(node.required ?? []);
  const result = {};
  if (node.description) result[DESCRIPTION_KEY] = node.description;
  for (const [name, child] of Object.entries(node.properties ?? {})) {
    result[required.has(name) ? name : `${name}?`] = outline(child, definitions);
  }
  if (node.additionalProperties && typeof node.additionalProperties === 'object' && Object.keys(node.additionalProperties).length) {
    result['*'] = outline(node.additionalProperties, definitions);
  }
  return result;
}

function outline(node, definitions) {
  if (node.$ref) return withNote(referenceName(node.$ref), node);
  const literal = literalOf(node);
  if (literal) return withNote(literal, node);
  const branches = node.oneOf ?? node.anyOf;
  if (branches) return outlineUnion(branches, node, definitions);
  if (node.prefixItems) return withNote(`[${node.prefixItems.map(item => outline(item, definitions)).join(', ')}]`, node);
  if (node.type === 'array') {
    const item = node.items ? outline(node.items, definitions) : 'any';
    if (typeof item === 'string') return withNote(`${item}[]${lengthText(node)}`, node);
    return { array: item, ...(lengthText(node) ? { length: lengthText(node) } : {}), ...(node.description ? { [DESCRIPTION_KEY]: node.description } : {}) };
  }
  if (node.type === 'object' || node.properties) return outlineObject(node, definitions);
  if (node.type === 'number' || node.type === 'integer') return withNote(`${node.type === 'integer' ? 'int' : 'number'}${rangeText(node)}`, node);
  if (Array.isArray(node.type)) return withNote(node.type.join('|'), node);
  return withNote(node.type ?? 'any', node);
}

/** Compact outline of a JSON Schema; shared definitions are listed once under $defs. */
export function outlineSchema(jsonSchema) {
  const definitions = jsonSchema.$defs ?? {};
  const result = outline(jsonSchema, definitions);
  const used = JSON.stringify(result);
  const shared = Object.fromEntries(Object.entries(definitions)
    .filter(([name]) => new RegExp(String.raw`\b${name}\b`).test(used))
    .map(([name, definition]) => [name, outline(definition, definitions)]));
  if (typeof result === 'string' || !Object.keys(shared).length) return result;
  return { ...result, $defs: shared };
}

/** The branches of a union keyed by the value of their first literal field, such as op or type. */
export function unionBranches(jsonSchema) {
  const flatten = node => {
    const members = node.oneOf ?? node.anyOf;
    return members ? members.flatMap(flatten) : [node];
  };
  if (!(jsonSchema.oneOf ?? jsonSchema.anyOf)) return undefined;
  const keyed = new Map();
  for (const branch of flatten(jsonSchema)) {
    const properties = Object.values(branch.properties ?? {});
    const discriminator = properties.map(literalOf).find(Boolean);
    if (discriminator) keyed.set(JSON.parse(discriminator.split('|')[0]), branch);
  }
  return keyed.size ? keyed : undefined;
}
