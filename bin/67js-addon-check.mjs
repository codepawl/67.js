#!/usr/bin/env node
// Checks a folder against the 67js third-party addon contract (docs/addons.md).
// Usage: npx 67js-addon-check <addon-folder> [--version <67js version>]
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ADDON_KEYWORD = '67js-addon';
export const CORE_PACKAGE = '@codepawlhq/67js';
export const EXTENSION_POINTS = Object.freeze({
  registerController: 'registerController(kind, factory) from 67js/addons/player',
  registerCameraRig: 'registerCameraRig(kind, factory) from 67js/addons/player',
  userPass: 'a user GLSL pass given to renderer.userPasses.set (67js/addons/user-pass)',
  streamingLoader: 'registerLoader(format, loader) on a streaming instance (67js/addons/streaming)',
  runtimeSystem: 'runtime.addSystem(system) on a runtime (67js/addons/runtime)',
});

const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/;
const COMPARATOR_PATTERN = /^(>=|<=|>|<|=|\^)?(\d+\.\d+\.\d+)$/;
const POINT_NAMES = Object.keys(EXTENSION_POINTS).join(', ');

function parseVersion(text) {
  const match = VERSION_PATTERN.exec(text);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
  }
  return 0;
}

function caretUpperBound([major, minor, patch]) {
  if (major > 0) return [major + 1, 0, 0];
  if (minor > 0) return [0, minor + 1, 0];
  return [0, 0, patch + 1];
}

// Parses a range such as ">=0.19.0 <1.0.0" or "^0.19.0" into [operator, version] pairs, or null when it is not one.
export function parseRange(range) {
  if (typeof range !== 'string' || range.trim() === '') return null;
  const comparators = [];
  for (const part of range.trim().split(/\s+/)) {
    const match = COMPARATOR_PATTERN.exec(part);
    if (!match) return null;
    const version = parseVersion(match[2]);
    if (match[1] === '^') {
      comparators.push(['>=', version], ['<', caretUpperBound(version)]);
    } else {
      comparators.push([match[1] ?? '=', version]);
    }
  }
  return comparators;
}

export function rangeAllows(range, version) {
  const comparators = parseRange(range);
  const parsed = parseVersion(version);
  if (!comparators || !parsed) return false;
  return comparators.every(([operator, bound]) => {
    const order = compareVersions(parsed, bound);
    return { '>=': order >= 0, '<=': order <= 0, '>': order > 0, '<': order < 0, '=': order === 0 }[operator];
  });
}

function readPackage(folder, errors) {
  const path = join(folder, 'package.json');
  if (!existsSync(path)) {
    errors.push(`No package.json in ${folder}. Run the check on the addon package folder.`);
    return null;
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    errors.push(`package.json is not valid JSON (${error.message}). Fix the syntax.`);
    return null;
  }
}

function checkManifest(manifest, errors) {
  if (manifest === undefined || manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    errors.push('package.json has no "67js" field. Add "67js": { "range": ">=0.19.0 <1.0.0", "extensionPoints": ["registerController"], "bundleBytes": 2048 }.');
    return;
  }
  if (!parseRange(manifest.range)) {
    errors.push(`"67js".range must be a version range such as ">=0.19.0 <1.0.0" or "^0.19.0", got ${JSON.stringify(manifest.range)}.`);
  }
  const points = manifest.extensionPoints;
  if (!Array.isArray(points) || points.length === 0) {
    errors.push(`"67js".extensionPoints must list at least one of: ${POINT_NAMES}.`);
  } else {
    for (const point of points) {
      if (!Object.hasOwn(EXTENSION_POINTS, point)) {
        errors.push(`"67js".extensionPoints names unknown point ${JSON.stringify(point)}. Use one of: ${POINT_NAMES}.`);
      }
    }
  }
  if (!Number.isInteger(manifest.bundleBytes) || manifest.bundleBytes <= 0) {
    errors.push(`"67js".bundleBytes must be a positive whole number of bytes for the entry file, got ${JSON.stringify(manifest.bundleBytes)}.`);
  }
}

function checkEntrySize(folder, pack, errors) {
  const manifest = pack['67js'];
  const entry = typeof pack.main === 'string' ? pack.main : typeof pack.exports === 'string' ? pack.exports : null;
  if (entry === null || !Number.isInteger(manifest?.bundleBytes)) return;
  const path = resolve(folder, entry);
  if (!existsSync(path)) {
    errors.push(`The entry file ${entry} does not exist. Point "main" or "exports" at a file that is published.`);
    return;
  }
  const actual = statSync(path).size;
  if (actual > manifest.bundleBytes) {
    errors.push(`${entry} is ${actual} bytes but "67js".bundleBytes says ${manifest.bundleBytes}. Raise bundleBytes to at least ${actual}.`);
  }
}

function checkPeer(pack, errors, warnings) {
  const peerRange = pack.peerDependencies?.[CORE_PACKAGE];
  if (peerRange === undefined) {
    errors.push(`package.json "peerDependencies" must list ${CORE_PACKAGE} so the addon shares the host's copy. Add "${CORE_PACKAGE}": ">=0.19.0 <1.0.0".`);
  } else if (!parseRange(peerRange)) {
    errors.push(`peerDependencies.${CORE_PACKAGE} must be a version range such as ">=0.19.0 <1.0.0", got ${JSON.stringify(peerRange)}.`);
  }
  if (pack.dependencies?.[CORE_PACKAGE] !== undefined) {
    warnings.push(`${CORE_PACKAGE} is in dependencies. Move it to peerDependencies so hosts do not get two copies.`);
  }
}

// Returns { errors, warnings } for the addon package in `folder`. `version` is a 67js version the declared range must allow.
export function checkAddon(folder, { version } = {}) {
  const errors = [];
  const warnings = [];
  const pack = readPackage(folder, errors);
  if (pack === null) return { errors, warnings };
  if (typeof pack.name !== 'string' || pack.name === '') errors.push('package.json needs a "name".');
  if (!Array.isArray(pack.keywords) || !pack.keywords.includes(ADDON_KEYWORD)) {
    errors.push(`package.json "keywords" must include "${ADDON_KEYWORD}" so the listing finds the addon. Add it.`);
  }
  checkPeer(pack, errors, warnings);
  if (typeof pack.license !== 'string' || pack.license === '') {
    errors.push('package.json "license" must be an SPDX identifier such as "MIT".');
  }
  checkManifest(pack['67js'], errors);
  checkEntrySize(folder, pack, errors);
  const declaredRange = pack['67js']?.range;
  if (version && parseRange(declaredRange) && !rangeAllows(declaredRange, version)) {
    errors.push(`"67js".range ${declaredRange} does not allow 67js ${version}. Widen the range or test the addon against ${version}.`);
  }
  return { errors, warnings };
}

function main(argumentsList) {
  const versionIndex = argumentsList.indexOf('--version');
  const version = versionIndex >= 0 ? argumentsList[versionIndex + 1] : undefined;
  const valueIndex = versionIndex >= 0 ? versionIndex + 1 : -1;
  const folder = argumentsList.find((value, index) => !value.startsWith('--') && index !== valueIndex);
  if (!folder) {
    console.error('Pass the addon package folder: npx 67js-addon-check <addon-folder> [--version <67js version>]');
    return 2;
  }
  const { errors, warnings } = checkAddon(resolve(folder), { version });
  for (const warning of warnings) console.warn(`warning: ${warning}`);
  for (const error of errors) console.error(`error: ${error}`);
  console.log(errors.length === 0 ? 'addon contract: ok' : `addon contract: ${errors.length} problem(s)`);
  return errors.length === 0 ? 0 : 1;
}

// npm links bin entries through a symlink or shim, so compare real paths to know this file is the program.
if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) process.exitCode = main(process.argv.slice(2));
