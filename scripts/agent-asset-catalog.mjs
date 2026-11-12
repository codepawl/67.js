import { createHash } from 'node:crypto';
import { open, readdir, realpath, lstat } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, sep } from 'node:path';

import { AGENT_ASSET_LIMITS, assetBytesLimitMessage } from '../src/agent-asset-limits.js';
import { MAXIMUM_CATALOG_LOOK_BYTES } from '../src/look-catalog.js';

const MAXIMUM_ASSETS = AGENT_ASSET_LIMITS.maxAssets;
const MAXIMUM_BYTES = AGENT_ASSET_LIMITS.maxBytes;

const IMAGE_EXTENSIONS = { png: /\.png$/i, jpeg: /\.jpe?g$/i, webp: /\.webp$/i };
/** 'environment' for a Radiance .hdr and 'look' for a .cube file, by extension and a first-bytes check; the preview decodes them. */
function lookFileKind(filename, bytes) {
  if (/\.hdr$/i.test(filename)) {
    if (bytes.toString('latin1', 0, 2) !== '#?') throw new Error('An .hdr catalog file must be a Radiance file starting with #?.');
    return 'environment';
  }
  if (/\.cube$/i.test(filename)) {
    if (bytes.length > MAXIMUM_CATALOG_LOOK_BYTES || !bytes.toString('utf8').includes('LUT_3D_SIZE')) throw new Error('A .cube catalog file must be a 3D look (LUT_3D_SIZE) of at most 4 MiB.');
    return 'look';
  }
  return null;
}

const IMAGE_MIME = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' };

/** 'png', 'jpeg' or 'webp' from the file signature, else null. Catalog images are decoded by the preview, never by the server. */
export function imageKind(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (bytes.length >= 12 && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP' && bytes.readUInt32LE(4) + 8 === bytes.length) return 'webp';
  return null;
}

function selfContainedGlb(bytes) {
  if (bytes.length < 20 || bytes.readUInt32LE(0) !== 0x46546c67 || bytes.readUInt32LE(4) !== 2 || bytes.readUInt32LE(8) !== bytes.length) {
    throw new Error('Asset must be a complete glTF 2.0 binary file.');
  }
  const jsonLength = bytes.readUInt32LE(12);
  if (bytes.readUInt32LE(16) !== 0x4e4f534a || jsonLength % 4 !== 0 || jsonLength > bytes.length - 20) {
    throw new Error('GLB must start with a bounded JSON chunk.');
  }
  const document = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString('utf8'));
  if (document.asset?.version !== '2.0') {
    throw new Error('Asset must declare glTF version 2.0.');
  }
  for (const collection of ['buffers', 'images']) {
    if (document[collection] !== undefined && !Array.isArray(document[collection])) {
      throw new Error(`GLB ${collection} must be an array.`);
    }
    for (const resource of document[collection] ?? []) {
      if (!resource || typeof resource !== 'object' || Object.hasOwn(resource, 'uri')) {
        throw new Error('Catalog GLBs must embed all buffers and images, without resource URIs.');
      }
    }
  }
  return document;
}

/** Explicit local directory catalog. IDs bind bytes, rather than agent-supplied file paths. */
export async function createAgentAssetCatalog(root) {
  if (typeof root !== 'string' || !isAbsolute(root)) {
    throw new TypeError('Asset root must be an explicit absolute directory path.');
  }
  const directory = await realpath(root);
  if (!(await lstat(directory)).isDirectory()) {
    throw new TypeError('Asset root must be a directory.');
  }
  const entries = new Map();

  async function readFile(filename) {
    const path = join(directory, filename);
    const original = await lstat(path);
    if (!original.isFile() || original.isSymbolicLink()) {
      throw new Error('Catalog assets must be regular files, without links.');
    }
    const resolved = await realpath(path);
    const offset = relative(directory, resolved);
    if (offset.startsWith(`..${sep}`) || offset === '..' || isAbsolute(offset) || basename(resolved) !== filename) {
      throw new Error('Asset must remain inside its configured directory.');
    }
    const handle = await open(resolved, 'r');
    try {
      const current = await handle.stat();
      if (current.isFile() && current.size > MAXIMUM_BYTES) {
        throw new RangeError(`${filename}: ${assetBytesLimitMessage(current.size)}`);
      }
      if (!current.isFile() || current.dev !== original.dev || current.ino !== original.ino || current.size < 20) {
        throw new Error('Asset changed during opening or is too small to be a GLB.');
      }
      const bytes = Buffer.alloc(current.size);
      let position = 0;
      while (position < bytes.length) {
        const result = await handle.read(bytes, position, bytes.length - position, position);
        if (result.bytesRead === 0) throw new Error('Asset was truncated during reading.');
        position += result.bytesRead;
      }
      const after = await handle.stat();
      if (after.size !== current.size || after.mtimeMs !== current.mtimeMs || after.ctimeMs !== current.ctimeMs) {
        throw new Error('Asset changed during reading.');
      }
      const lookKind = lookFileKind(filename, bytes);
      const imageFormat = lookKind ? null : imageKind(bytes);
      if (imageFormat && !IMAGE_EXTENSIONS[imageFormat].test(filename)) throw new Error('Image extension must match its PNG, JPEG or WebP content.');
      if (!imageFormat && !lookKind && !/\.glb$/i.test(filename)) throw new Error('Catalog files must be GLB, PNG, JPEG, WebP, HDR or CUBE, with a matching extension.');
      const document = imageFormat || lookKind ? null : selfContainedGlb(bytes);
      const assetId = createHash('sha256').update(bytes).digest('hex');
      return { bytes, document, assetId, imageFormat, lookKind };
    } finally {
      await handle.close();
    }
  }

  const files = (await readdir(directory, { withFileTypes: true }))
    .filter(entry => /\.(glb|png|jpe?g|webp|hdr|cube)$/i.test(entry.name)).sort((left, right) => left.name.localeCompare(right.name));
  if (files.length > MAXIMUM_ASSETS) throw new RangeError(`Asset catalog has ${files.length} files, over its maxAssets ${MAXIMUM_ASSETS}. Remove files from the --assets directory.`);
  for (const file of files) {
    const { bytes, document, assetId, imageFormat, lookKind } = await readFile(file.name);
    if (entries.has(assetId)) continue;
    if (lookKind) {
      entries.set(assetId, { filename: file.name, metadata: Object.freeze({ assetId, name: file.name, bytes: bytes.length, kind: lookKind }) });
      continue;
    }
    if (imageFormat) {
      entries.set(assetId, { filename: file.name, metadata: Object.freeze({ assetId, name: file.name, bytes: bytes.length, kind: 'image', mimeType: IMAGE_MIME[imageFormat] }) });
      continue;
    }
    const animations = document.animations ?? [];
    if (!Array.isArray(animations)) throw new Error('GLB animations must be an array.');
    entries.set(assetId, {
      filename: file.name,
      metadata: Object.freeze({
        assetId, name: file.name, bytes: bytes.length, kind: 'glb',
        meshes: document.meshes?.length ?? 0,
        skins: document.skins?.length ?? 0,
        images: document.images?.length ?? 0,
        animationCount: animations.length,
        animationsTruncated: animations.length > 16,
        animations: animations.slice(0, 16).map((animation, index) => ({ index, name: String(animation?.name ?? `Clip ${index}`).slice(0, 80) })),
      }),
    });
  }
  return Object.freeze({
    list() {
      return { assets: structuredClone([...entries.values()].map(entry => entry.metadata)), maximumBytes: MAXIMUM_BYTES, maximumAssets: MAXIMUM_ASSETS };
    },
    async read(assetId) {
      const entry = entries.get(assetId);
      if (!entry) throw new Error(`Unknown asset ID ${String(assetId).slice(0, 12)}. Call scene_asset_catalog and pass an assetId it lists.`);
      const result = await readFile(entry.filename);
      if (result.assetId !== assetId) throw new Error('Asset bytes changed since catalog creation. Restart the runtime to refresh the catalog.');
      const clipCount = result.document?.animations?.length ?? 0;
      if (clipCount > AGENT_ASSET_LIMITS.maxClips) throw new RangeError(`Asset has ${clipCount} animation clips, over the catalog maxClips ${AGENT_ASSET_LIMITS.maxClips}. Remove clips from the file.`);
      return result.bytes;
    },
  });
}
