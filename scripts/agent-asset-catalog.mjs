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

const JSON_CHUNK = 0x4e4f534a;
const BINARY_CHUNK = 0x004e4942;

function glbDocument(bytes) {
  if (bytes.length < 20 || bytes.readUInt32LE(0) !== 0x46546c67 || bytes.readUInt32LE(4) !== 2 || bytes.readUInt32LE(8) !== bytes.length) {
    throw new Error('Asset must be a complete glTF 2.0 binary file.');
  }
  const jsonLength = bytes.readUInt32LE(12);
  if (bytes.readUInt32LE(16) !== JSON_CHUNK || jsonLength % 4 !== 0 || jsonLength > bytes.length - 20) {
    throw new Error('GLB must start with a bounded JSON chunk.');
  }
  const document = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString('utf8'));
  if (document.asset?.version !== '2.0') {
    throw new Error('Asset must declare glTF version 2.0.');
  }
  return { document, jsonLength };
}

/** A GLB whose buffers are embedded. Image `uri` fields are allowed here; embedSiblingImages turns them into embedded images. */
function selfContainedGlb(bytes) {
  const parsed = glbDocument(bytes);
  for (const collection of ['buffers', 'images']) {
    const resources = parsed.document[collection];
    if (resources !== undefined && !Array.isArray(resources)) {
      throw new Error(`GLB ${collection} must be an array.`);
    }
    for (const resource of resources ?? []) {
      if (!resource || typeof resource !== 'object') {
        throw new Error(`GLB ${collection} entries must be objects.`);
      }
      if (collection === 'buffers' && Object.hasOwn(resource, 'uri')) {
        throw new Error('Catalog GLBs must embed all buffers; a .bin file next to the GLB is not loaded. Re-export the model as a single .glb.');
      }
    }
  }
  return parsed;
}

/** The path segments of an image beside the GLB, or an error that names the GLB, the URI and what to pass instead. */
function siblingImageSegments(filename, uri) {
  const prefix = `${filename}: image uri "${uri}"`;
  if (typeof uri !== 'string' || !uri || uri.length > 512) {
    throw new Error(`${prefix} must be a relative file path of at most 512 characters, such as "Textures/colormap.png".`);
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(uri)) {
    throw new Error(`${prefix} is a remote or embedded address, which the catalog does not fetch. Put the image file next to the GLB and use a relative path, such as "colormap.png", or embed the image in the GLB.`);
  }
  let decoded;
  try {
    decoded = decodeURIComponent(uri);
  } catch {
    throw new Error(`${prefix} is not valid percent-encoding. Use a plain relative path, such as "Textures/colormap.png".`);
  }
  const segments = decoded.split(/[\\/]/);
  if (decoded.startsWith('/') || decoded.startsWith('\\') || /^[a-z]:/i.test(decoded) || segments.includes('..')) {
    throw new Error(`${prefix} leaves the GLB's folder. Copy the image into the folder (or a folder below it) and use a relative path, such as "colormap.png".`);
  }
  return segments.filter(segment => segment && segment !== '.');
}

function padded(buffer, fill) {
  const padding = (4 - (buffer.length % 4)) % 4;
  return padding ? Buffer.concat([buffer, Buffer.alloc(padding, fill)]) : buffer;
}

/** Rebuilds the GLB with every image `uri` read from the GLB's folder and stored in the binary chunk, so the stored asset is self-contained. */
async function embedSiblingImages(bytes, parsed, filename, readSibling) {
  const { document, jsonLength } = parsed;
  const binaryStart = 20 + jsonLength;
  const hasBinary = bytes.length >= binaryStart + 8 && bytes.readUInt32LE(binaryStart + 4) === BINARY_CHUNK;
  if (!hasBinary || !Array.isArray(document.buffers) || document.buffers.length === 0) {
    throw new Error(`${filename}: a GLB that points at image files needs a binary chunk to hold them. Re-export it with its mesh data embedded.`);
  }
  const binaryLength = bytes.readUInt32LE(binaryStart);
  const chunks = [padded(bytes.subarray(binaryStart + 8, binaryStart + 8 + binaryLength), 0)];
  let size = chunks[0].length;
  if (!Array.isArray(document.bufferViews)) document.bufferViews = [];
  const embeddedByPath = new Map();
  for (const image of document.images) {
    if (image.uri === undefined) continue;
    const segments = siblingImageSegments(filename, image.uri);
    const key = segments.join('/');
    if (!embeddedByPath.has(key)) {
      const { imageBytes, format } = await readSibling(filename, image.uri, segments);
      const imageChunk = padded(imageBytes, 0);
      const total = bytes.length + (size - binaryLength) + imageChunk.length;
      if (total > MAXIMUM_BYTES) throw new RangeError(`${filename}: with its images next to it the asset reaches ${total} bytes. ${assetBytesLimitMessage(total)}`);
      document.bufferViews.push({ buffer: 0, byteOffset: size, byteLength: imageBytes.length });
      embeddedByPath.set(key, { view: document.bufferViews.length - 1, mimeType: IMAGE_MIME[format] });
      chunks.push(imageChunk);
      size += imageChunk.length;
    }
    const embedded = embeddedByPath.get(key);
    delete image.uri;
    image.bufferView = embedded.view;
    image.mimeType = embedded.mimeType;
  }
  document.buffers[0].byteLength = size;
  const binary = Buffer.concat(chunks);
  const json = padded(Buffer.from(JSON.stringify(document)), 0x20);
  const total = 12 + 8 + json.length + 8 + binary.length;
  const result = Buffer.alloc(total);
  result.writeUInt32LE(0x46546c67, 0);
  result.writeUInt32LE(2, 4);
  result.writeUInt32LE(total, 8);
  result.writeUInt32LE(json.length, 12);
  result.writeUInt32LE(JSON_CHUNK, 16);
  json.copy(result, 20);
  const binaryOffset = 20 + json.length;
  result.writeUInt32LE(binary.length, binaryOffset);
  result.writeUInt32LE(BINARY_CHUNK, binaryOffset + 4);
  binary.copy(result, binaryOffset + 8);
  return result;
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

  /** One image file below the catalog folder: a regular file, not a link, inside the folder, a real PNG, JPEG or WebP, within the byte bound. */
  async function readSibling(glbName, uri, segments) {
    const label = `${glbName}: image "${uri}"`;
    const path = join(directory, ...segments);
    let original;
    try {
      original = await lstat(path);
    } catch {
      throw new Error(`${label} was not found next to the GLB. Copy that file into the --assets folder at the same relative path.`);
    }
    if (!original.isFile() || original.isSymbolicLink()) throw new Error(`${label} must be a regular file, without links.`);
    const resolved = await realpath(path);
    const offset = relative(directory, resolved);
    if (offset.startsWith(`..${sep}`) || offset === '..' || isAbsolute(offset)) throw new Error(`${label} leaves the GLB's folder. Copy the image into the folder and use a relative path.`);
    if (original.size > MAXIMUM_BYTES) throw new RangeError(`${label}: ${assetBytesLimitMessage(original.size)}`);
    const handle = await open(resolved, 'r');
    try {
      const imageBytes = Buffer.alloc(original.size);
      let position = 0;
      while (position < imageBytes.length) {
        const result = await handle.read(imageBytes, position, imageBytes.length - position, position);
        if (result.bytesRead === 0) throw new Error(`${label} was truncated during reading.`);
        position += result.bytesRead;
      }
      const format = imageKind(imageBytes);
      if (!format) throw new Error(`${label} is not a PNG, JPEG or WebP file. Convert it to one of those.`);
      return { imageBytes, format };
    } finally {
      await handle.close();
    }
  }

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
      let bytes = Buffer.alloc(current.size);
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
      let document = null;
      if (!imageFormat && !lookKind) {
        const parsed = selfContainedGlb(bytes);
        document = parsed.document;
        if (document.images?.some(image => Object.hasOwn(image, 'uri'))) {
          bytes = await embedSiblingImages(bytes, parsed, filename, readSibling);
          document = glbDocument(bytes).document;
        }
      }
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
