// A half-float colour target for the frame's last pass, and a float readback of any framebuffer, so a render job can
// write 16-bit PNG and EXR files from more than the 8 bits the canvas keeps. Needs WebGL 2 and EXT_color_buffer_float.

const FLOAT_EXTENSION = 'EXT_color_buffer_float';

export function requireFloatTargets(context) {
  if (!context.getExtension(FLOAT_EXTENSION)) {
    throw new Error('16-bit PNG and EXR output need EXT_color_buffer_float, which this browser or GPU does not offer. Use format png.');
  }
}

/** One RGBA16F framebuffer of the given size. The frame's post pass draws into it instead of the canvas. */
export function createFloatOutput(context, width, height) {
  requireFloatTargets(context);
  const texture = context.createTexture();
  context.bindTexture(context.TEXTURE_2D, texture);
  context.texImage2D(context.TEXTURE_2D, 0, context.RGBA16F, width, height, 0, context.RGBA, context.HALF_FLOAT, null);
  context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MIN_FILTER, context.NEAREST);
  context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MAG_FILTER, context.NEAREST);
  const framebuffer = context.createFramebuffer();
  context.bindFramebuffer(context.FRAMEBUFFER, framebuffer);
  context.framebufferTexture2D(context.FRAMEBUFFER, context.COLOR_ATTACHMENT0, context.TEXTURE_2D, texture, 0);
  const complete = context.checkFramebufferStatus(context.FRAMEBUFFER) === context.FRAMEBUFFER_COMPLETE;
  context.bindFramebuffer(context.FRAMEBUFFER, null);
  if (!complete) {
    context.deleteFramebuffer(framebuffer);
    context.deleteTexture(texture);
    throw new Error('The float output framebuffer could not be allocated. Use format png.');
  }
  return {
    width,
    height,
    framebuffer,
    dispose() {
      context.deleteFramebuffer(framebuffer);
      context.deleteTexture(texture);
    },
  };
}

/**
 * Reads a region of a framebuffer as RGBA float32, rows bottom to top as WebGL stores them. `region` counts pixels
 * from the top left, like an image, and defaults to the whole frame.
 */
export function readFloatPixels(context, framebuffer, frameWidth, frameHeight, region = { x: 0, y: 0, width: frameWidth, height: frameHeight }) {
  if (region.x < 0 || region.y < 0 || region.width < 1 || region.height < 1 || region.x + region.width > frameWidth || region.y + region.height > frameHeight) {
    throw new RangeError('The region lies outside the rendered frame.');
  }
  const pixels = new Float32Array(region.width * region.height * 4);
  context.bindFramebuffer(context.READ_FRAMEBUFFER, framebuffer);
  context.readPixels(region.x, frameHeight - region.y - region.height, region.width, region.height, context.RGBA, context.FLOAT, pixels);
  context.bindFramebuffer(context.READ_FRAMEBUFFER, null);
  return pixels;
}
