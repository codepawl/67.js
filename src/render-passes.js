import { compileProgram, fullscreenVertex } from './gl-program.js';

// Render passes draw raw material data (albedo, normal, emission, depth, object ID) instead of the lit image.
// The shader branch lives in the main fragment shader behind the `renderPass` feature, which compiles on the first
// pass request; this addon owns the rest: the target, the copy to the canvas and the object ID table.

/** The shader's `renderPassMode` for each pass name. agent-scene-capabilities.js lists the same names. */
export const RENDER_PASS_MODES = Object.freeze({ albedo: 1, normal: 2, emission: 3, depth: 4, objectId: 5 });
// Background pixels: depth reads as the far limit; every other pass reads zero, and object ID zero means no object.
const PASS_BACKGROUNDS = Object.freeze({ depth: [1, 1, 0, 1] });
const DEFAULT_BACKGROUND = Object.freeze([0, 0, 0, 1]);

// Copies a pass texture to the canvas byte for byte: one texel per pixel, no filtering, no grading.
const passCopyFragment = `#version 300 es
precision highp float;
uniform sampler2D sourceTexture;
out vec4 outputColor;
void main() { outputColor = vec4(texelFetch(sourceTexture, ivec2(gl_FragCoord.xy), 0).rgb, 1.0); }`;

// A float target keeps the pass values as half floats (frame.passFloat) for 16-bit PNG and EXR output; the shader writes the same values.
function createPassTarget(context, width, height, float = false) {
  if (float && !context.getExtension('EXT_color_buffer_float')) throw new Error('16-bit PNG and EXR output need EXT_color_buffer_float. Use format png.');
  const texture = context.createTexture();
  context.bindTexture(context.TEXTURE_2D, texture);
  if (float) context.texImage2D(context.TEXTURE_2D, 0, context.RGBA16F, width, height, 0, context.RGBA, context.HALF_FLOAT, null);
  else context.texImage2D(context.TEXTURE_2D, 0, context.RGBA8, width, height, 0, context.RGBA, context.UNSIGNED_BYTE, null);
  context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MIN_FILTER, context.NEAREST);
  context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MAG_FILTER, context.NEAREST);
  const depth = context.createRenderbuffer();
  context.bindRenderbuffer(context.RENDERBUFFER, depth);
  context.renderbufferStorage(context.RENDERBUFFER, context.DEPTH_COMPONENT24, width, height);
  const framebuffer = context.createFramebuffer();
  context.bindFramebuffer(context.FRAMEBUFFER, framebuffer);
  context.framebufferTexture2D(context.FRAMEBUFFER, context.COLOR_ATTACHMENT0, context.TEXTURE_2D, texture, 0);
  context.framebufferRenderbuffer(context.FRAMEBUFFER, context.DEPTH_ATTACHMENT, context.RENDERBUFFER, depth);
  if (context.checkFramebufferStatus(context.FRAMEBUFFER) !== context.FRAMEBUFFER_COMPLETE) {
    throw new Error('Render pass framebuffer allocation failed. Choose a lower quality preset.');
  }
  return { texture, depth, framebuffer, float };
}

/**
 * Lets `renderer.render({ ...camera, pass })` draw one pass. Passes draw without multisampling into their own target,
 * so object IDs and normals stay exact at silhouettes. Only opaque and cutout parts appear. `passDepthRange` is the
 * number of metres that depth values 0 to 65535 span (default 100).
 */
export function installRenderPasses(renderer) {
  if (renderer.passSupport) return renderer;
  let target = null;
  let copyProgram = null;
  let copyTextureUniform = null;

  function releaseTargets(context) {
    if (!target) return;
    context.deleteTexture(target.texture);
    context.deleteRenderbuffer(target.depth);
    context.deleteFramebuffer(target.framebuffer);
    renderer.renderTargets.release('passColor', 'passDepth');
    target = null;
  }

  function dispose(context) {
    releaseTargets(context);
    if (copyProgram) context.deleteProgram(copyProgram);
    copyProgram = null;
  }

  function prepare(frame) {
    const mode = RENDER_PASS_MODES[frame.pass];
    if (!mode) throw new RangeError(`Unknown render pass: ${frame.pass}. Use ${Object.keys(RENDER_PASS_MODES).join(', ')}.`);
    if (renderer.benchmark) throw new Error('Render passes are unavailable in benchmark mode.');
    const depthRange = frame.passDepthRange ?? 1;
    if (!Number.isFinite(depthRange) || depthRange <= 0) throw new RangeError('Pass depth range must be positive and finite.');
    const context = renderer.context;
    renderer.requireFeatureNames(['renderPass']);
    if (!copyProgram) {
      copyProgram = compileProgram(context, fullscreenVertex, passCopyFragment);
      copyTextureUniform = context.getUniformLocation(copyProgram, 'sourceTexture');
    }
    const float = frame.passFloat === true;
    if (target && target.float !== float) releaseTargets(context);
    if (!target) {
      const { width, height } = renderer.canvas;
      target = createPassTarget(context, width, height, float);
      renderer.renderTargets.record('passColor', { width, height, format: float ? 'RGBA16F' : 'RGBA8' });
      renderer.renderTargets.record('passDepth', { width, height, format: 'DEPTH_COMPONENT24' });
    }
    return mode;
  }

  function copyToCanvas() {
    const context = renderer.context;
    context.bindFramebuffer(context.FRAMEBUFFER, null);
    context.viewport(0, 0, renderer.canvas.width, renderer.canvas.height);
    context.disable(context.DEPTH_TEST);
    context.disable(context.CULL_FACE);
    context.bindVertexArray(null);
    context.useProgram(copyProgram);
    context.activeTexture(context.TEXTURE0);
    context.bindTexture(context.TEXTURE_2D, target.texture);
    context.uniform1i(copyTextureUniform, 0);
    context.drawArrays(context.TRIANGLES, 0, 3);
  }

  // Part names by object ID minus one, in the order the object ID pass numbers them (draw order, grouped by geometry).
  function objectNames() {
    return renderer.batches.filter(batch => renderer.drawsInOpaqueLoop(batch)).flatMap(batch => batch.parts.map(part => part.name));
  }

  renderer.passSupport = {
    prepare,
    get framebuffer() { return target.framebuffer; },
    // The pass colour of the last pass frame; object motion blur reads the object IDs from it.
    get texture() { return target.texture; },
    background: pass => PASS_BACKGROUNDS[pass] ?? DEFAULT_BACKGROUND,
    copyToCanvas,
    objectNames,
    releaseTargets,
    dispose,
  };
  return renderer;
}
