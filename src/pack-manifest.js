// Data-only packs: a folder with a crucible-pack.json manifest and the files it lists (GLB models, images, .cube looks, .hdr
// environments, material and recipe JSON). The checks here are pure; scripts/agent-packs.mjs reads the folder and applies them.
// A pack never carries code, and nothing in it is fetched: every file is local and listed by a relative path.
import { invalidField } from './field-error.js';

import { currentFormatName, LEGACY_ENGINE_KEY } from './legacy-names.js';
export const PACK_MANIFEST_FILE = 'crucible-pack.json';
export const PACK_FORMAT = 'crucible.pack';
export const PACK_SCHEMA_VERSION = 1;
export const MAXIMUM_PACK_FILES = 256;
export const MAXIMUM_PACK_BYTES = 256 * 1024 * 1024;
export const MAXIMUM_PACK_FILE_BYTES = 64 * 1024 * 1024;
export const MAXIMUM_PACK_JSON_BYTES = 1024 * 1024;
export const MAXIMUM_PACK_ITEMS_PER_KIND = 64;
export const MAXIMUM_INSTALLED_PACKS = 32;

const MAXIMUM_PATH_CHARACTERS = 200;
const MAXIMUM_NAME_CHARACTERS = 64;
const MAXIMUM_RANGE_CHARACTERS = 64;
const MAXIMUM_RANGE_COMPARATORS = 8;
export const MAXIMUM_JSON_DEPTH = 64;

/** The kinds of content a pack lists, with the file extensions each accepts. */
export const PACK_CONTENT_KINDS = Object.freeze({
  assets: Object.freeze(['.glb']),
  images: Object.freeze(['.png', '.jpg', '.jpeg', '.webp']),
  looks: Object.freeze(['.cube']),
  environments: Object.freeze(['.hdr']),
  materials: Object.freeze(['.json']),
  recipes: Object.freeze(['.json']),
});
export const PACK_PREVIEW_EXTENSIONS = Object.freeze(['.png', '.jpg', '.jpeg', '.webp']);

// Anything a browser, shell or loader could run. A pack holding one anywhere is refused whole, listed or not.
const EXECUTABLE_EXTENSIONS = new Set([
  '.js', '.mjs', '.cjs', '.jsx', '.ts', '.mts', '.cts', '.tsx', '.html', '.htm', '.xhtml', '.svg', '.wasm',
  '.exe', '.dll', '.com', '.scr', '.msi', '.sh', '.bash', '.zsh', '.bat', '.cmd', '.ps1', '.psm1', '.vbs', '.wsf',
  '.py', '.pyc', '.rb', '.pl', '.php', '.jar', '.so', '.dylib', '.node', '.lnk', '.app', '.command', '.appimage',
]);

const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
// The running Crucible version may carry a prerelease tag or build metadata ("0.21.0-rc.1", "0.21.0+build"); only its x.y.z is compared.
const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/;
const RUNNING_VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const COMPARATOR_PATTERN = /^(>=|<=|>|<|=|\^|~)?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/;
const PATH_SEGMENT_PATTERN = /^[A-Za-z0-9._-]+$/;
const REMOTE_URL_PATTERN = /(?:^|[\s"'(=])(?:https?|ftp|wss?|file|blob|javascript):/i;
const PROTOCOL_RELATIVE_PATTERN = /^\s*\/\/[^\s/]/;
const REMOTE_HOST_PATTERN = /(?:https?|ftp|wss?):\/\//i;
const IMAGE_DATA_URL_PATTERN = /^data:image\/(?:png|jpeg|webp);base64,/i;

/** True for a file name a pack must never hold, whatever the manifest lists. */
export function isExecutableLookingName(filename) {
  // Windows drops trailing dots and spaces, so "run.js." and "run.js " are run.js there.
  const lower = String(filename).toLowerCase().replace(/[. ]+$/, '');
  const dot = lower.lastIndexOf('.');
  return dot >= 0 && EXECUTABLE_EXTENSIONS.has(lower.slice(dot));
}

const DOCUMENT_NAME_PATTERN = /^(?:license|licence|readme|notice|changelog|authors)(?:\.(?:md|txt))?$/i;

/** True for the text documents a pack may carry without listing them: LICENSE, LICENCE, README, NOTICE, CHANGELOG, AUTHORS, with .md or .txt. */
export function isPackDocumentName(filename) {
  return DOCUMENT_NAME_PATTERN.test(String(filename));
}

export function fileExtension(filename) {
  const lower = String(filename).toLowerCase();
  const dot = lower.lastIndexOf('.');
  return dot >= 0 ? lower.slice(dot) : '';
}

function parseVersion(text, pattern = VERSION_PATTERN) {
  const match = pattern.exec(text);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function compareVersions(left, right) {
  for (let index = 0; index < 3; index++) {
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
  }
  return 0;
}

function comparatorBounds(comparator) {
  const match = COMPARATOR_PATTERN.exec(comparator);
  if (!match) return null;
  const operator = match[1] ?? '=';
  const parts = [match[2], match[3], match[4]];
  const specified = parts.filter(part => part !== undefined).length;
  const base = parts.map(part => Number(part ?? 0));
  const bumpAt = index => base.map((part, position) => (position < index ? part : position === index ? part + 1 : 0));
  switch (operator) {
    case '>=': return { lower: base };
    case '>': return specified === 3 ? { lowerExclusive: base } : { lower: bumpAt(specified - 1) };
    case '<': return { upper: base };
    case '<=': return specified === 3 ? { upperInclusive: base } : { upper: bumpAt(specified - 1) };
    case '=': return specified === 3 ? { lower: base, upperInclusive: base } : { lower: base, upper: bumpAt(specified - 1) };
    case '~': return { lower: base, upper: bumpAt(specified === 1 ? 0 : 1) };
    default: {
      // ^ keeps the left-most non-zero part among those written.
      const firstNonZero = base.slice(0, specified).findIndex(part => part > 0);
      return { lower: base, upper: bumpAt(firstNonZero === -1 ? specified - 1 : firstNonZero) };
    }
  }
}

/**
 * True when `version` ("1.2.3") satisfies `range`: space-separated comparators, all of which must hold. Each is >=, >, <, <=, =,
 * ^ or ~ with 1 to 3 numeric parts, such as ">=0.19.0 <1" or "^0.19". No pre-release tags, no ||.
 * Returns null for a range that cannot be read, so the caller can say what to pass.
 */
export function semverSatisfies(version, range) {
  const current = parseVersion(version, RUNNING_VERSION_PATTERN);
  if (!current || typeof range !== 'string' || range.length === 0 || range.length > MAXIMUM_RANGE_CHARACTERS) return null;
  const comparators = range.trim().split(/\s+/);
  if (comparators.length > MAXIMUM_RANGE_COMPARATORS) return null;
  const allBounds = comparators.map(comparatorBounds);
  if (allBounds.includes(null)) return null;
  return allBounds.every(bounds => (!bounds.lower || compareVersions(current, bounds.lower) >= 0)
    && (!bounds.lowerExclusive || compareVersions(current, bounds.lowerExclusive) > 0)
    && (!bounds.upper || compareVersions(current, bounds.upper) < 0)
    && (!bounds.upperInclusive || compareVersions(current, bounds.upperInclusive) <= 0));
}

function isRemoteString(text) {
  if (/^\s*data:/i.test(text)) return !IMAGE_DATA_URL_PATTERN.test(text.trim());
  return REMOTE_URL_PATTERN.test(text) || PROTOCOL_RELATIVE_PATTERN.test(text) || REMOTE_HOST_PATTERN.test(text);
}

/**
 * The first string or key in parsed JSON that is a remote URL (http, https, ftp, ws, //host, file, blob, javascript, or a data URL that is not an
 * image), as `{ path, value }`; else null. JSON nested more than MAXIMUM_JSON_DEPTH containers deep, arrays included, returns `{ path, value, tooDeep: true }`.
 */
export function findRemoteUrl(value, path = '$', depth = 1) {
  if (typeof value === 'string') return isRemoteString(value) ? { path, value } : null;
  if (!value || typeof value !== 'object') return null;
  if (depth > MAXIMUM_JSON_DEPTH) return { path, value: '(nested too deeply)', tooDeep: true };
  const isList = Array.isArray(value);
  for (const [key, child] of Object.entries(value)) {
    const childPath = isList ? `${path}[${key}]` : `${path}.${key}`;
    if (!isList && isRemoteString(key)) return { path: childPath, value: key };
    const found = findRemoteUrl(child, childPath, depth + 1);
    if (found) return found;
  }
  return null;
}

/** Throws unless `value` is a forward-slash relative path of safe segments inside the pack: no "..", no absolute or drive paths, no backslashes. */
export function assertPackFilePath(value, fieldPath) {
  const expected = 'a relative path inside the pack with forward slashes and only letters, digits, . _ - in each part, such as "models/crate.glb"';
  if (typeof value === 'string' && value.split('/').at(-1).toLowerCase() === PACK_MANIFEST_FILE) throw invalidField(fieldPath, value, 'a content file; the manifest itself cannot be listed');
  if (typeof value !== 'string' || value.length === 0 || value.length > MAXIMUM_PATH_CHARACTERS) throw invalidField(fieldPath, value, expected);
  if (value.startsWith('/') || value.includes('\\') || /^[A-Za-z]:/.test(value)) throw invalidField(fieldPath, value, expected);
  for (const segment of value.split('/')) {
    if (segment === '' || segment === '.' || segment === '..' || !PATH_SEGMENT_PATTERN.test(segment)) throw invalidField(fieldPath, value, expected);
  }
  return value;
}

function assertKnownKeys(object, allowed, fieldPath) {
  if (!object || typeof object !== 'object' || Array.isArray(object)) throw invalidField(fieldPath, object, `an object with only the keys ${allowed.join(', ')}`, TypeError);
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key)) throw invalidField(`${fieldPath}.${key}`, object[key], `no such key; allowed keys are ${allowed.join(', ')}`, TypeError);
  }
}

function assertText(value, fieldPath, maximum, example) {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maximum) throw invalidField(fieldPath, value, `a non-empty string of at most ${maximum} characters, such as ${example}`);
  return value;
}

function assertIdentifier(value, fieldPath) {
  if (typeof value !== 'string' || value.length > MAXIMUM_NAME_CHARACTERS || !NAME_PATTERN.test(value)) throw invalidField(fieldPath, value, 'a kebab-case id of at most 64 characters, such as "rusty-metal"');
  return value;
}

function normalizeItems(kind, items, label, prefix) {
  const fieldPath = `${prefix}.contents.${kind}`;
  if (!Array.isArray(items) || items.length > MAXIMUM_PACK_ITEMS_PER_KIND) throw invalidField(fieldPath, items, `an array of at most ${MAXIMUM_PACK_ITEMS_PER_KIND} items, such as [{ "id": "name", "file": "folder/name${PACK_CONTENT_KINDS[kind][0]}" }]`);
  const seen = new Set();
  return items.map((item, index) => {
    const itemPath = `${fieldPath}[${index}]`;
    assertKnownKeys(item, kind === 'recipes' ? ['id', 'file', 'preview'] : ['id', 'file'], itemPath);
    const id = assertIdentifier(item.id, `${itemPath}.id`);
    if (seen.has(id)) throw invalidField(`${itemPath}.id`, id, `an id used once in contents.${kind}; rename one of the duplicates`);
    seen.add(id);
    const file = assertPackFilePath(item.file, `${itemPath}.file`);
    if (!PACK_CONTENT_KINDS[kind].includes(fileExtension(file))) throw invalidField(`${itemPath}.file`, file, `a file ending in ${PACK_CONTENT_KINDS[kind].join(', ')} for ${kind}`);
    const result = { id, file };
    if (kind === 'recipes' && item.preview !== undefined) {
      result.preview = assertPackFilePath(item.preview, `${itemPath}.preview`);
      if (!PACK_PREVIEW_EXTENSIONS.includes(fileExtension(result.preview))) throw invalidField(`${itemPath}.preview`, result.preview, `an image ending in ${PACK_PREVIEW_EXTENSIONS.join(', ')}`);
    }
    return result;
  });
}

/**
 * Checks a parsed crucible-pack.json and returns a clean copy. `label` names the pack in errors (its folder name) and
 * `packageVersion` is the running Crucible version that engines["crucible"] must admit.
 */
export function validatePackManifest(manifest, { label, packageVersion }) {
  const prefix = `pack "${label}" ${PACK_MANIFEST_FILE}`;
  assertKnownKeys(manifest, ['format', 'schemaVersion', 'name', 'version', 'engines', 'license', 'author', 'description', 'contents'], prefix);
  if (currentFormatName(manifest.format) !== PACK_FORMAT) throw invalidField(`${prefix}.format`, manifest.format, `"${PACK_FORMAT}"`);
  if (manifest.schemaVersion !== PACK_SCHEMA_VERSION) throw invalidField(`${prefix}.schemaVersion`, manifest.schemaVersion, String(PACK_SCHEMA_VERSION));
  const name = assertIdentifier(manifest.name, `${prefix}.name`);
  if (typeof manifest.version !== 'string' || !parseVersion(manifest.version)) throw invalidField(`${prefix}.version`, manifest.version, 'a version of three numbers, such as "1.0.0"');
  assertKnownKeys(manifest.engines, ['crucible', LEGACY_ENGINE_KEY], `${prefix}.engines`);
  const range = manifest.engines['crucible'] ?? manifest.engines[LEGACY_ENGINE_KEY];
  const admitted = semverSatisfies(packageVersion, range);
  if (admitted === null) throw invalidField(`${prefix}.engines.crucible`, range, 'a range of space-separated comparators >=, >, <, <=, =, ^ or ~ with numbers, such as ">=0.19.0"');
  if (!admitted) throw invalidField(`${prefix}.engines.crucible`, range, `a range that admits the installed Crucible ${packageVersion}, such as ">=${packageVersion}"; this pack needs another Crucible version`);
  const license = assertText(manifest.license, `${prefix}.license`, 64, '"CC0-1.0"');
  const author = assertText(manifest.author, `${prefix}.author`, 120, '"Your Name"');
  const description = assertText(manifest.description, `${prefix}.description`, 200, '"Brick and metal materials"');
  assertKnownKeys(manifest.contents, Object.keys(PACK_CONTENT_KINDS), `${prefix}.contents`);
  const contents = {};
  for (const kind of Object.keys(PACK_CONTENT_KINDS)) {
    contents[kind] = manifest.contents[kind] === undefined ? [] : normalizeItems(kind, manifest.contents[kind], label, prefix);
  }
  return { format: PACK_FORMAT, schemaVersion: PACK_SCHEMA_VERSION, name, version: manifest.version, engines: { 'crucible': range }, license, author, description, contents };
}
