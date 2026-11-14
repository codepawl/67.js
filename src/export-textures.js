import { encodePng } from './export-png.js';
import { sourceEncodingOf } from './image-source-encoding.js';

export const DEFAULT_MAX_TEXTURE_SIZE = 2048;
const ABSOLUTE_MAX_TEXTURE_SIZE = 16384;
const WRAP_DEFAULT = 10497;
const MIN_FILTER_DEFAULT = 9987;
const MAG_FILTER_DEFAULT = 9729;

function pixelsOf(image, channel) {
  const width = image?.naturalWidth ?? image?.width;
  const height = image?.naturalHeight ?? image?.height;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new TypeError(`GLB ${channel} needs an image with a whole width and height.`);
  }
  if (image?.compressed) throw new TypeError(`GLB ${channel} is a GPU-compressed texture, which export cannot read back. Transcode KTX2 to RGBA8 to export it.`);
  if (image.data) {
    if (image.data.length < width * height * 4) throw new RangeError(`GLB ${channel} image data must hold RGBA8 pixels for every texel.`);
    return { width, height, pixels: image.data };
  }
  // Browser images, bitmaps and canvases: read the pixels back through a canvas.
  const canvas = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(width, height) : globalThis.document?.createElement('canvas');
  if (!canvas) throw new TypeError(`GLB ${channel} needs RGBA pixel data ({ width, height, data }) outside a browser.`);
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  context.drawImage(image, 0, 0);
  return { width, height, pixels: context.getImageData(0, 0, width, height).data };
}

function imageSize(image, channel) {
  const width = image?.naturalWidth ?? image?.width;
  const height = image?.naturalHeight ?? image?.height;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new TypeError(`GLB ${channel} needs an image with a whole width and height.`);
  }
  return { width, height };
}

/**
 * Writes each distinct image once and shares samplers and textures between channels.
 * An image decoded from a JPEG, PNG or WebP file and left unchanged keeps those bytes; any other image is embedded as a PNG.
 */
export function createTextureWriter(writer, maxTextureSize = DEFAULT_MAX_TEXTURE_SIZE) {
  if (!Number.isInteger(maxTextureSize) || maxTextureSize < 1 || maxTextureSize > ABSOLUTE_MAX_TEXTURE_SIZE) {
    throw new RangeError(`maxTextureSize must be a whole number from 1 to ${ABSOLUTE_MAX_TEXTURE_SIZE}.`);
  }
  const { document } = writer;
  document.images = [];
  document.samplers = [];
  document.textures = [];
  const imageIndices = new Map();
  const samplerIndices = new Map();
  const textureIndices = new Map();

  function imageIndex(descriptor, channel) {
    const flipRows = descriptor.flipY === true;
    const known = imageIndices.get(descriptor.image);
    if (known?.has(flipRows)) return known.get(flipRows);
    const sourceEncoding = flipRows ? undefined : sourceEncodingOf(descriptor.image);
    const decoded = sourceEncoding ? undefined : pixelsOf(descriptor.image, channel);
    const { width, height } = decoded ?? imageSize(descriptor.image, channel);
    if (width > maxTextureSize || height > maxTextureSize) {
      throw new RangeError(`GLB ${channel} image is ${width}x${height}, above maxTextureSize ${maxTextureSize}. Resize the image, or pass exportGlb(parts, { maxTextureSize }) up to ${ABSOLUTE_MAX_TEXTURE_SIZE} if the file size is acceptable.`);
    }
    const bytes = sourceEncoding?.bytes ?? encodePng(decoded.pixels, width, height, { flipRows });
    const mimeType = sourceEncoding?.mimeType ?? 'image/png';
    document.images.push({ bufferView: writer.addBufferView(bytes), mimeType });
    const index = document.images.length - 1;
    imageIndices.set(descriptor.image, (known ?? new Map()).set(flipRows, index));
    return index;
  }

  // glTF core reads PNG and JPEG; a WebP image goes through EXT_texture_webp, which readers must support to show it.
  function textureDefinition(sampler, source) {
    if (document.images[source].mimeType !== 'image/webp') return { sampler, source };
    writer.addExtension('EXT_texture_webp', { required: true });
    return { sampler, extensions: { EXT_texture_webp: { source } } };
  }

  function samplerIndex(descriptor) {
    const sampler = {
      magFilter: descriptor.magFilter ?? MAG_FILTER_DEFAULT,
      minFilter: descriptor.minFilter ?? MIN_FILTER_DEFAULT,
      wrapS: descriptor.wrapS ?? WRAP_DEFAULT,
      wrapT: descriptor.wrapT ?? WRAP_DEFAULT,
    };
    const key = JSON.stringify(sampler);
    if (!samplerIndices.has(key)) {
      samplerIndices.set(key, document.samplers.length);
      document.samplers.push(sampler);
    }
    return samplerIndices.get(key);
  }

  return {
    /** Index of the glTF texture for a renderer texture descriptor `{ image, wrapS, ... }`. */
    textureIndex(descriptor, channel) {
      if (![0, 1].includes(descriptor.uvChannel ?? 0)) throw new RangeError(`GLB ${channel} uses UV channel ${descriptor.uvChannel}; only channels 0 and 1 are supported.`);
      const source = imageIndex(descriptor, channel);
      const sampler = samplerIndex(descriptor);
      const key = `${source}:${sampler}`;
      if (!textureIndices.has(key)) {
        textureIndices.set(key, document.textures.length);
        document.textures.push(textureDefinition(sampler, source));
      }
      return textureIndices.get(key);
    },
  };
}
