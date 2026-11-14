// GPU-compressed texture formats that a KTX2 loader can hand over. Only the glTF addon imports this file.
// It hands the renderer a generic image: { width, height, compressed: { levels, bytes, minFilter(filter), upload(context) } }.

const BPTC = 'EXT_texture_compression_bptc';
const S3TC = 'WEBGL_compressed_texture_s3tc';
const S3TC_SRGB = 'WEBGL_compressed_texture_s3tc_srgb';
const ASTC = 'WEBGL_compressed_texture_astc';
const ETC2 = 'WEBGL_compressed_texture_etc';

// Keyed by the linear GL enum, which is what the three.js KTX2 loader reports as the texture format.
const FORMATS = new Map([
  [0x8e8c, { name: 'bc7', extension: BPTC, srgbFormat: 0x8e8d, blockBytes: 16 }],
  [0x83f0, { name: 'bc1-rgb', extension: S3TC, srgbExtension: S3TC_SRGB, srgbFormat: 0x8c4c, blockBytes: 8, strictBlocks: true }],
  [0x83f1, { name: 'bc1-rgba', extension: S3TC, srgbExtension: S3TC_SRGB, srgbFormat: 0x8c4d, blockBytes: 8, strictBlocks: true }],
  [0x83f3, { name: 'bc3', extension: S3TC, srgbExtension: S3TC_SRGB, srgbFormat: 0x8c4f, blockBytes: 16, strictBlocks: true }],
  [0x93b0, { name: 'astc-4x4', extension: ASTC, srgbFormat: 0x93d0, blockBytes: 16 }],
  [0x9274, { name: 'etc2-rgb', extension: ETC2, srgbFormat: 0x9275, blockBytes: 8 }],
  [0x9278, { name: 'etc2-rgba', extension: ETC2, srgbFormat: 0x9279, blockBytes: 16 }],
]);

const BLOCK_SIZE = 4;

function blocksFor(size) {
  return Math.ceil(size / BLOCK_SIZE);
}

function levelBytes(width, height, blockBytes) {
  return blocksFor(width) * blocksFor(height) * blockBytes;
}

function levelCountFor(width, height) {
  return Math.floor(Math.log2(Math.max(width, height))) + 1;
}

/** The format entry for a three.js style compressed texture format enum, or null when Crucible does not take it. */
export function compressedFormatInfo(glFormat) {
  return FORMATS.get(glFormat) ?? null;
}

/**
 * Validate the mip levels of a compressed image and keep the ones a complete chain needs.
 * A partial chain is cut to its first level, because a texture with missing mips is incomplete.
 */
export function describeCompressedImage(glFormat, levels, field, colorSpace) {
  const info = compressedFormatInfo(glFormat);
  if (!info) throw new Error(`${field} decoded to GPU format ${glFormat}, which Crucible does not upload. Use BC7, BC1, BC3, ASTC 4x4 or ETC2, or transcode to RGBA8 (see docs/gltf.md).`);
  if (!Array.isArray(levels) || !levels.length) throw new Error(`${field} compressed texture has no mip levels.`);
  const [base] = levels;
  if (info.strictBlocks && (base.width % BLOCK_SIZE || base.height % BLOCK_SIZE)) {
    throw new Error(`${field} ${info.name} texture must have width and height in multiples of 4.`);
  }
  const usable = levels.length === levelCountFor(base.width, base.height) ? levels : [base];
  for (const level of usable) {
    if (!(level.data instanceof Uint8Array) || level.data.length !== levelBytes(level.width, level.height, info.blockBytes)) {
      throw new Error(`${field} ${info.name} mip level data does not match its size.`);
    }
  }
  const bytes = usable.reduce((sum, level) => sum + level.data.length, 0);
  const srgb = colorSpace !== 'linear';
  const extension = srgb && info.srgbExtension ? info.srgbExtension : info.extension;
  const internalFormat = srgb ? info.srgbFormat : glFormat;
  return { width: base.width, height: base.height, compressed: { name: info.name, levels: usable, bytes, minFilter: minFilterFor(usable.length), upload: context => uploadLevels(context, usable, internalFormat, extension) } };
}

// A single level cannot be mip filtered. Odd filter enums are the linear ones.
function minFilterFor(levelCount) {
  return minFilter => (levelCount === 1 && minFilter >= 9984 ? 9728 + (minFilter & 1) : minFilter);
}

/** Upload every mip level into the bound TEXTURE_2D with immutable storage. */
function uploadLevels(context, levels, internalFormat, extension) {
  if (!context.getExtension(extension)) {
    throw new Error(`This context lacks ${extension}, which the compressed texture needs. Transcode KTX2 for this context with ktx2WorkerConfigFor(context) (see docs/gltf.md).`);
  }
  context.texStorage2D(context.TEXTURE_2D, levels.length, internalFormat, levels[0].width, levels[0].height);
  levels.forEach((level, index) => {
    context.compressedTexSubImage2D(context.TEXTURE_2D, index, 0, 0, level.width, level.height, internalFormat, level.data);
  });
}

/**
 * The KTX2Loader `workerConfig` for a WebGL2 context, so the loader transcodes to a format this context takes.
 * Every field is false where the context lacks the extension, which makes the loader fall back to RGBA8.
 * DXT needs the sRGB extension as well, because one KTX2 file serves color and data maps.
 */
export function ktx2WorkerConfigFor(context) {
  const has = name => Boolean(context.getExtension(name));
  return {
    astcSupported: has(ASTC),
    astcHDRSupported: false,
    etc1Supported: false,
    etc2Supported: has(ETC2),
    dxtSupported: has(S3TC) && has(S3TC_SRGB),
    bptcSupported: has(BPTC),
    pvrtcSupported: false,
  };
}
