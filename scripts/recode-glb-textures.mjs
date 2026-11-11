// Re-encodes the PNG and JPEG textures of an already prepared GLB (meshopt geometry stays byte for byte) as WebP,
// and shrinks the ones larger than a cap. Used to lighten a showcase world without touching its meshes.
//
//   node scripts/recode-glb-textures.mjs <input.glb> <output.glb> [--webp-quality 80] [--max-texture 4096]
//
// An image is kept as it is when the WebP is not smaller. Nothing is read from the network.
import { readFileSync, writeFileSync } from 'node:fs';
import sharp from 'sharp';

const GLB_MAGIC = 0x46546c67;
const JSON_CHUNK = 0x4e4f534a;
const BINARY_CHUNK = 0x004e4942;

export function parseArguments(argv) {
  const options = { webpQuality: 80, maxTexture: 4096 };
  const positional = [];
  for (let index = 0; index < argv.length; index++) {
    const name = argv[index];
    if (!name.startsWith('--')) {
      positional.push(name);
      continue;
    }
    const value = Number(argv[++index]);
    const key = name.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (!(key in options) || !Number.isFinite(value) || value <= 0) throw new Error(`Unknown or invalid option ${name}.`);
    options[key] = value;
  }
  if (positional.length !== 2) throw new Error('Pass <input.glb> and <output.glb>.');
  return { input: positional[0], output: positional[1], options };
}

export function readGlb(buffer) {
  if (buffer.readUInt32LE(0) !== GLB_MAGIC) throw new Error('Not a GLB file.');
  const jsonLength = buffer.readUInt32LE(12);
  if (buffer.readUInt32LE(16) !== JSON_CHUNK) throw new Error('The GLB has no JSON chunk.');
  const json = JSON.parse(buffer.subarray(20, 20 + jsonLength).toString('utf8'));
  const binaryStart = 20 + jsonLength;
  if (buffer.readUInt32LE(binaryStart + 4) !== BINARY_CHUNK) throw new Error('The GLB has no binary chunk.');
  const binaryLength = buffer.readUInt32LE(binaryStart);
  return { json, binary: buffer.subarray(binaryStart + 8, binaryStart + 8 + binaryLength) };
}

export function writeGlb(json, binary) {
  const jsonBytes = Buffer.from(JSON.stringify(json), 'utf8');
  const jsonPadded = Buffer.concat([jsonBytes, Buffer.alloc((4 - (jsonBytes.length % 4)) % 4, 0x20)]);
  const binaryPadded = Buffer.concat([binary, Buffer.alloc((4 - (binary.length % 4)) % 4)]);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(GLB_MAGIC, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonPadded.length + 8 + binaryPadded.length, 8);
  const jsonHeader = Buffer.alloc(8);
  jsonHeader.writeUInt32LE(jsonPadded.length, 0);
  jsonHeader.writeUInt32LE(JSON_CHUNK, 4);
  const binaryHeader = Buffer.alloc(8);
  binaryHeader.writeUInt32LE(binaryPadded.length, 0);
  binaryHeader.writeUInt32LE(BINARY_CHUNK, 4);
  return Buffer.concat([header, jsonHeader, jsonPadded, binaryHeader, binaryPadded]);
}

async function recodeImage(original, options) {
  const metadata = await sharp(original).metadata();
  const longest = Math.max(metadata.width, metadata.height);
  let pipeline = sharp(original);
  if (longest > options.maxTexture) {
    const scale = options.maxTexture / longest;
    pipeline = pipeline.resize({ width: Math.round(metadata.width * scale), height: Math.round(metadata.height * scale) });
  }
  const converted = await pipeline.webp({ quality: options.webpQuality, effort: 6, alphaQuality: 90 }).toBuffer();
  return converted.length < original.length ? converted : null;
}

// The bytes a buffer view really owns in the first buffer: a meshopt view keeps its data in the extension, not in the view.
function dataRangeOf(view) {
  const meshopt = view.extensions?.EXT_meshopt_compression;
  if (meshopt) return { owner: meshopt, buffer: meshopt.buffer ?? 0 };
  return { owner: view, buffer: view.buffer ?? 0 };
}

// EXT_texture_webp is a texture extension: a texture whose image is WebP points at it through
// textures[i].extensions.EXT_texture_webp.source and, because the extension is required, carries no fallback source.
export function declareWebpTextures(json) {
  const webpImages = new Set();
  (json.images ?? []).forEach((image, index) => {
    if (image.mimeType === 'image/webp') webpImages.add(index);
  });
  if (webpImages.size === 0) return;
  for (const texture of json.textures ?? []) {
    if (!webpImages.has(texture.source)) continue;
    texture.extensions = { ...texture.extensions, EXT_texture_webp: { source: texture.source } };
    delete texture.source;
  }
  json.extensionsUsed = [...new Set([...(json.extensionsUsed ?? []), 'EXT_texture_webp'])];
  json.extensionsRequired = [...new Set([...(json.extensionsRequired ?? []), 'EXT_texture_webp'])];
}

export async function recodeGlbTextures(buffer, options) {
  const { json, binary } = readGlb(buffer);
  const recodedByView = new Map();
  let imageBytesBefore = 0;
  for (const image of json.images ?? []) {
    const view = json.bufferViews[image.bufferView];
    const original = binary.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength);
    imageBytesBefore += original.length;
    if (image.mimeType !== 'image/png' && image.mimeType !== 'image/jpeg') continue;
    const converted = await recodeImage(original, options);
    if (!converted) continue;
    recodedByView.set(image.bufferView, converted);
    image.mimeType = 'image/webp';
  }

  const chunks = [];
  let offset = 0;
  const append = bytes => {
    const start = offset;
    chunks.push(bytes);
    offset += bytes.length;
    const padding = (4 - (offset % 4)) % 4;
    if (padding) {
      chunks.push(Buffer.alloc(padding));
      offset += padding;
    }
    return start;
  };
  let imageBytesAfter = 0;
  json.bufferViews.forEach((view, index) => {
    const { owner, buffer: bufferIndex } = dataRangeOf(view);
    if (bufferIndex !== 0) return;
    const replacement = recodedByView.get(index);
    const bytes = replacement ?? binary.subarray(owner.byteOffset ?? 0, (owner.byteOffset ?? 0) + owner.byteLength);
    if (json.images?.some(image => image.bufferView === index)) imageBytesAfter += bytes.length;
    owner.byteOffset = append(bytes);
    owner.byteLength = bytes.length;
  });

  declareWebpTextures(json);
  const packed = Buffer.concat(chunks);
  json.buffers[0].byteLength = packed.length;
  return { glb: writeGlb(json, packed), imageBytesBefore, imageBytesAfter, inputBytes: buffer.length };
}

async function main() {
  const { input, output, options } = parseArguments(process.argv.slice(2));
  const result = await recodeGlbTextures(readFileSync(input), options);
  writeFileSync(output, result.glb);
  console.log(JSON.stringify({ inputBytes: result.inputBytes, outputBytes: result.glb.length, imageBytesBefore: result.imageBytesBefore, imageBytesAfter: result.imageBytesAfter }));
}

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}`) await main();
