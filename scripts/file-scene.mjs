import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname, join, basename } from 'node:path';

const ASSET_FIELDS = ['glb', 'hdri'];
const MAXIMUM_KEY_FILE_BYTES = 64 * 1024 ** 2;

/** Reads camera keys: { fps, frames: [[eye, target], ...] } or the keys createCameraPath takes. */
export function readCameraKeys(path) {
  const file = resolve(path);
  if (!existsSync(file) || statSync(file).size > MAXIMUM_KEY_FILE_BYTES) throw new Error('The camera keys file is missing or larger than 64 MiB.');
  const keys = JSON.parse(readFileSync(file, 'utf8'));
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
export function prepareFileScene({ configPath, root }) {
  const file = resolve(configPath);
  const description = JSON.parse(readFileSync(file, 'utf8'));
  const configDirectory = dirname(file);
  const assets = [];
  const route = assetPath => {
    if (/^[a-z]+:/i.test(assetPath)) throw new Error(`Remote asset URLs are not allowed: ${assetPath}`);
    const diskPath = resolveAssetPath(assetPath, { configDirectory, root: root ? resolve(root) : null });
    assets.push(diskPath);
    return `/__file/asset/${assets.length - 1}/${encodeURIComponent(basename(diskPath))}`;
  };
  for (const field of ASSET_FIELDS) {
    if (typeof description[field] !== 'string') throw new Error(`scene.json needs a "${field}" path.`);
    description[field] = route(description[field]);
  }
  return { description, assets };
}
