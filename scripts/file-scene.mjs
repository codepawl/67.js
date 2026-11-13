import { readFileSync, existsSync, statSync, openSync, fstatSync, closeSync } from 'node:fs';
import { resolve, dirname, join, basename } from 'node:path';
import { LARGE_ASSET_BYTES } from './asset-server.mjs';

const ASSET_FIELDS = ['glb', 'hdri'];
const MAXIMUM_KEY_FILE_BYTES = 64 * 1024 ** 2;

// Opens once and checks the size on the same handle, so the file cannot change between the check and the read.
function readBoundedFile(file) {
  let descriptor;
  try {
    descriptor = openSync(file, 'r');
  } catch {
    throw new Error('The camera keys file is missing or larger than 64 MiB.');
  }
  try {
    if (fstatSync(descriptor).size > MAXIMUM_KEY_FILE_BYTES) throw new Error('The camera keys file is missing or larger than 64 MiB.');
    return readFileSync(descriptor, 'utf8');
  } finally {
    closeSync(descriptor);
  }
}

/** Reads camera keys: { fps, frames: [[eye, target], ...] } or the keys createCameraPath takes. */
export function readCameraKeys(path) {
  const file = resolve(path);
  const keys = JSON.parse(readBoundedFile(file));
  if (Array.isArray(keys.frames)) {
    if (!keys.frames.length) throw new Error('Camera keys need at least one frame.');
    const valid = pose => Array.isArray(pose) && pose.length === 2 && pose.every(vector => Array.isArray(vector) && vector.length === 3 && vector.every(Number.isFinite));
    if (!keys.frames.every(valid)) throw new Error('Every camera frame must be [[eyeX, eyeY, eyeZ], [targetX, targetY, targetZ]].');
    const fps = keys.fps ?? 24;
    if (!Number.isFinite(fps) || fps < 1 || fps > 240) throw new Error('Camera keys fps must be between 1 and 240.');
    return { ...keys, fps, duration: keys.frames.length / fps };
  }
  if (!keys.eye || !Number.isFinite(keys.duration)) throw new Error('Camera keys need either frames or createCameraPath keys (duration, eye, target).');
  return keys;
}

/**
 * Finds a scene.json asset on disk. A path like /showcase/bistro/scene.glb is relative to a served public folder, so it is tried
 * under --root, then under the config's folder, then by file name next to the config.
 */
export function resolveAssetPath(assetPath, { configDirectory, root }) {
  const relative = assetPath.replace(/^\/+/, '');
  const candidates = [root && join(root, relative), join(configDirectory, relative), join(configDirectory, basename(relative))].filter(Boolean);
  const found = candidates.find(candidate => existsSync(candidate) && statSync(candidate).isFile());
  if (!found) throw new Error(`Scene asset ${assetPath} was not found. Looked in: ${candidates.join(', ')}. Use --root to name the folder it is relative to.`);
  return found;
}

/** Reads scene.json and swaps each asset path for a /__file/asset/<n>/<name> URL the export script answers from disk. */
export function prepareFileScene({ configPath, root, largeAssetOrigin, largeAssetBytes = LARGE_ASSET_BYTES }) {
  const file = resolve(configPath);
  const description = JSON.parse(readFileSync(file, 'utf8'));
  const configDirectory = dirname(file);
  const assets = [];
  const route = assetPath => {
    if (/^[a-z]+:/i.test(assetPath)) throw new Error(`Remote asset URLs are not allowed: ${assetPath}`);
    const diskPath = resolveAssetPath(assetPath, { configDirectory, root: root ? resolve(root) : null });
    assets.push(diskPath);
    const name = encodeURIComponent(basename(diskPath));
    const isLarge = largeAssetOrigin && statSync(diskPath).size > largeAssetBytes;
    return isLarge ? `${largeAssetOrigin}/asset/${assets.length - 1}/${name}` : `/__file/asset/${assets.length - 1}/${name}`;
  };
  for (const field of ASSET_FIELDS) {
    if (typeof description[field] !== 'string') throw new Error(`scene.json needs a "${field}" path.`);
    description[field] = route(description[field]);
  }
  routeStagedParts(description, route);
  return { description, assets };
}

// A staged scene lists its other parts in "glbRest", routed like "glb". The first-view fields only speed up the page's first
// frame, so a headless render drops them.
function routeStagedParts(description, route) {
  if (description.glbRest !== undefined) {
    const isPathList = Array.isArray(description.glbRest) && description.glbRest.every(path => typeof path === 'string');
    if (!isPathList) throw new Error('scene.json "glbRest" must be a list of glb paths.');
    description.glbRest = description.glbRest.map(route);
  }
  delete description.hdriPreview;
  delete description.glbFirstView;
}
