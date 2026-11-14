import { configureTexture, textureDescriptorInfo } from './renderer.js';
import { createSlicer } from './cooperative.js';

// Uploads a large texture a band of rows at a time, so no single texImage2D hands the driver the whole image at once.
// The plan needs no GL context, so tests can reach it directly.

/** Largest band of texture data one texSubImage2D call carries. */
export const TEXTURE_SLICE_BYTES = 1 << 20;

/**
 * Splits `height` rows of `bytesPerRow` into bands of at most `maximumBytes` (at least one row each).
 * Returns [{ firstRow, rowCount }] that cover every row once, in order.
 */
export function planRowSlices(height, bytesPerRow, maximumBytes = TEXTURE_SLICE_BYTES) {
  if (!Number.isInteger(height) || height <= 0) throw new RangeError('planRowSlices height must be a positive integer.');
  if (!(bytesPerRow > 0) || !(maximumBytes > 0)) throw new RangeError('planRowSlices bytesPerRow and maximumBytes must be positive.');
  const rowsPerSlice = Math.max(1, Math.floor(maximumBytes / bytesPerRow));
  const slices = [];
  for (let firstRow = 0; firstRow < height; firstRow += rowsPerSlice) {
    slices.push({ firstRow, rowCount: Math.min(rowsPerSlice, height - firstRow) });
  }
  return slices;
}

/**
 * The texture row a band lands on. WebGL flips a sub-rectangle inside itself when UNPACK_FLIP_Y_WEBGL is on, so with
 * `flipY` the band goes to the mirrored rows and the whole image comes out as one flipped upload would make it.
 */
export function sliceDestinationRow(slice, height, flipY) {
  return flipY ? height - slice.firstRow - slice.rowCount : slice.firstRow;
}

/** A band of an image source, cut without changing its pixels. RGBA bytes ({ width, height, data }) are viewed in place. */
async function bandOf(image, width, slice, flipY) {
  if (image.data) return image.data.subarray(slice.firstRow * width * 4, (slice.firstRow + slice.rowCount) * width * 4);
  return createImageBitmap(image, 0, slice.firstRow, width, slice.rowCount, {
    premultiplyAlpha: 'none',
    colorSpaceConversion: 'none',
    imageOrientation: flipY ? 'flipY' : 'none',
  });
}

/** WebGL ignores UNPACK_FLIP_Y_WEBGL for an ImageBitmap, whose orientation was fixed when it was made. */
const ignoresFlip = image => typeof ImageBitmap === 'function' && image instanceof ImageBitmap;

/**
 * Fills level 0 of `texture` (RGBA, UNSIGNED_BYTE) from `image` in bands of at most `maximumBytes`, calling `checkpoint()`
 * after each so the page can draw. The caller sets the texture parameters and mipmaps afterwards. `image` is an image
 * source or { width, height, data } of RGBA bytes. Each band sets and restores the pixel store and binding it touches,
 * because the page draws between bands.
 */
export async function uploadTextureInSlices(context, texture, internalFormat, image, { flipY: requestedFlipY = false, maximumBytes = TEXTURE_SLICE_BYTES, checkpoint = async () => {} } = {}) {
  const width = image.naturalWidth ?? image.width;
  const height = image.naturalHeight ?? image.height;
  const flipY = requestedFlipY && !ignoresFlip(image);
  const target = context.TEXTURE_2D;
  const previousAllocationBinding = context.getParameter(context.TEXTURE_BINDING_2D);
  context.bindTexture(target, texture);
  context.texImage2D(target, 0, internalFormat, width, height, 0, context.RGBA, context.UNSIGNED_BYTE, null);
  context.bindTexture(target, previousAllocationBinding);
  for (const slice of planRowSlices(height, width * 4, maximumBytes)) {
    const band = await bandOf(image, width, slice, flipY);
    const previousBinding = context.getParameter(context.TEXTURE_BINDING_2D);
    const previousFlip = context.getParameter(context.UNPACK_FLIP_Y_WEBGL);
    const previousPremultiply = context.getParameter(context.UNPACK_PREMULTIPLY_ALPHA_WEBGL);
    const previousColorSpace = context.getParameter(context.UNPACK_COLORSPACE_CONVERSION_WEBGL);
    try {
      context.bindTexture(target, texture);
      context.pixelStorei(context.UNPACK_FLIP_Y_WEBGL, flipY);
      context.pixelStorei(context.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      context.pixelStorei(context.UNPACK_COLORSPACE_CONVERSION_WEBGL, context.NONE);
      context.texSubImage2D(target, 0, 0, sliceDestinationRow(slice, height, flipY), width, slice.rowCount, context.RGBA, context.UNSIGNED_BYTE, band);
    } finally {
      context.pixelStorei(context.UNPACK_FLIP_Y_WEBGL, previousFlip);
      context.pixelStorei(context.UNPACK_PREMULTIPLY_ALPHA_WEBGL, previousPremultiply);
      context.pixelStorei(context.UNPACK_COLORSPACE_CONVERSION_WEBGL, previousColorSpace);
      context.bindTexture(target, previousBinding);
      band.close?.();
    }
    await checkpoint();
  }
}

/** CrucibleRenderer.preloadTextures: uploads each descriptor larger than maximumBytes in bands, then records it where createTexture looks. */
export async function preloadRendererTextures(renderer, descriptors, { maximumBytes = TEXTURE_SLICE_BYTES, checkpoint = createSlicer() } = {}) {
  const context = renderer.context;
  const maximumSize = context.getParameter(context.MAX_TEXTURE_SIZE);
  for (const map of new Set(descriptors)) {
    if (!map || renderer.textures.has(map) || map.image?.compressed) continue;
    const info = textureDescriptorInfo(map, maximumSize);
    if (info.width * info.height * 4 <= maximumBytes) continue;
    const texture = context.createTexture();
    try {
      await uploadTextureInSlices(context, texture, map.colorSpace === 'linear' ? context.RGBA8 : context.SRGB8_ALPHA8, map.image, { flipY: map.flipY ?? false, maximumBytes, checkpoint });
      // Another call may have uploaded the same descriptor while this one yielded.
      if (renderer.textures.has(map)) {
        context.deleteTexture(texture);
        continue;
      }
      const previousBinding = context.getParameter(context.TEXTURE_BINDING_2D);
      context.bindTexture(context.TEXTURE_2D, texture);
      configureTexture(renderer, info);
      context.bindTexture(context.TEXTURE_2D, previousBinding);
      renderer.textures.set(map, texture);
    } catch (error) {
      context.deleteTexture(texture);
      throw error;
    }
  }
}
