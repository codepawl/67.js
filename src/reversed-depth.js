// Reversed-Z depth (issue #310): with EXT_clip_control the depth range is zero to one, the projection maps the near plane to 1 and
// the far plane to 0, and the buffer is cleared to 0 and tested with GREATER. Floating point numbers are densest near 0, which is
// where the far surfaces land, so a 32-bit float buffer keeps its precision at distance instead of losing it as 1 / z does.
//
// The renderer constructor installs it (issue #751): `installReversedDepth(renderer)` wraps a few renderer steps and switches on at
// once wherever EXT_clip_control exists, at any far / near ratio. `false` opts out, and a browser without the extension keeps the
// standard path with a 24-bit buffer and a fitted near plane (near-plane-fit.js).
import { mat4 } from 'gl-matrix';
import { compileProgram, fullscreenVertex } from './gl-program.js';
import { shaderTransforms } from './shader-registry.js';

const ZERO_VECTOR = new Float32Array(4);

/**
 * Turns a projection that maps depth to -1..1 into one that maps it to 1..0 (the clip control range is 0..1).
 * Only the third row changes: the new z is (w - z) / 2, so it works for perspective, orthographic and oblique matrices.
 */
export function reverseProjectionDepth(out, projection) {
  for (let column = 0; column < 4; column++) {
    const depthIndex = column * 4 + 2;
    const clipDepth = projection[depthIndex];
    const clipW = projection[depthIndex + 1];
    out[column * 4] = projection[column * 4];
    out[column * 4 + 1] = projection[column * 4 + 1];
    out[depthIndex] = (clipW - clipDepth) / 2;
    out[depthIndex + 1] = clipW;
  }
  return out;
}

// Camera-relative vertex transform. The main vertex shader multiplies viewProjection by the world position, which is a sum of terms
// as large as the distance to the eye, so at 500 m a float32 step of 0.03 mm already hides a 0.1 mm gap. The patched line subtracts
// the eye first and sends w = 0 through the matrix (its linear part only), then adds the projection's own translation. The matrix
// stays whole for the passes that read the eye out of it, and with both uniforms at zero the line is the old product.
const WORLD_CLIP_LINE = 'gl_Position = viewProjection * world;';
const CAMERA_RELATIVE_LINE = 'gl_Position = viewProjection * vec4(world.xyz - cameraOffset.xyz, 1.0 - cameraOffset.w) + cameraShift;';
const CAMERA_UNIFORMS = 'uniform mat4 lightProjection;\nuniform vec4 cameraOffset;\nuniform vec4 cameraShift;';
let patchingMainProgram = false;
let transformInstalled = false;

function makeVertexCameraRelative(source) {
  if (!patchingMainProgram || !source.includes(WORLD_CLIP_LINE)) return source;
  return source.replace('uniform mat4 lightProjection;', CAMERA_UNIFORMS).replace(WORLD_CLIP_LINE, CAMERA_RELATIVE_LINE);
}

// The depth texture the other passes read holds standard depth (1 at the far plane), so a stage right after the resolve turns the
// reversed depth back, through a copy, with gl_FragDepth. Ambient occlusion, depth of field, fog and line art then need no change.
const STANDARD_DEPTH_FRAGMENT = `#version 300 es
precision highp float;
uniform highp sampler2D reversedDepth;
void main() {
  gl_FragDepth = 1.0 - texelFetch(reversedDepth, ivec2(gl_FragCoord.xy), 0).r;
}`;

function createDepthConversionStage() {
  let program = null;
  let uniform = null;
  let copy = null;

  function releaseTargets(context) {
    if (!copy) return;
    context.deleteTexture(copy.texture);
    context.deleteFramebuffer(copy.framebuffer);
    copy = null;
  }

  function createCopy(context, width, height) {
    const texture = context.createTexture();
    context.bindTexture(context.TEXTURE_2D, texture);
    context.texImage2D(context.TEXTURE_2D, 0, context.DEPTH_COMPONENT32F, width, height, 0, context.DEPTH_COMPONENT, context.FLOAT, null);
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MIN_FILTER, context.NEAREST);
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MAG_FILTER, context.NEAREST);
    const framebuffer = context.createFramebuffer();
    context.bindFramebuffer(context.FRAMEBUFFER, framebuffer);
    context.framebufferTexture2D(context.FRAMEBUFFER, context.DEPTH_ATTACHMENT, context.TEXTURE_2D, texture, 0);
    return { texture, framebuffer, width, height };
  }

  function apply(renderer) {
    if (!renderer.depthTexture) return null;
    const context = renderer.context;
    const { width, height } = renderer.canvas;
    if (!program) {
      program = compileProgram(context, fullscreenVertex, STANDARD_DEPTH_FRAGMENT);
      uniform = context.getUniformLocation(program, 'reversedDepth');
    }
    if (copy && (copy.width !== width || copy.height !== height)) releaseTargets(context);
    copy ??= createCopy(context, width, height);
    context.bindFramebuffer(context.READ_FRAMEBUFFER, renderer.resolveFramebuffer);
    context.bindFramebuffer(context.DRAW_FRAMEBUFFER, copy.framebuffer);
    context.blitFramebuffer(0, 0, width, height, 0, 0, width, height, context.DEPTH_BUFFER_BIT, context.NEAREST);
    context.bindFramebuffer(context.FRAMEBUFFER, renderer.resolveFramebuffer);
    context.viewport(0, 0, width, height);
    context.useProgram(program);
    context.activeTexture(context.TEXTURE0);
    context.bindTexture(context.TEXTURE_2D, copy.texture);
    context.uniform1i(uniform, 0);
    context.enable(context.DEPTH_TEST);
    context.depthFunc(context.ALWAYS);
    context.colorMask(false, false, false, false);
    context.disable(context.CULL_FACE);
    context.bindVertexArray(null);
    context.drawArrays(context.TRIANGLES, 0, 3);
    context.colorMask(true, true, true, true);
    context.depthFunc(context.LESS);
    context.disable(context.DEPTH_TEST);
    return null;
  }

  function dispose(context) {
    releaseTargets(context);
    if (program) context.deleteProgram(program);
    program = null;
  }

  return { name: 'Reversed depth', apply, releaseTargets, dispose };
}

// The frame targets are allocated with 24-bit depth by the core; this respecifies the two depth stores as 32-bit float.
function useFloatDepthTargets(renderer) {
  const context = renderer.context;
  if (!renderer.multisampleFramebuffer) return;
  const { width, height } = renderer.canvas;
  context.bindRenderbuffer(context.RENDERBUFFER, renderer.multisampleDepth);
  context.renderbufferStorageMultisample(context.RENDERBUFFER, renderer.multisampleSamples, context.DEPTH_COMPONENT32F, width, height);
  renderer.renderTargets?.record('multisampleDepth', { width, height, format: 'DEPTH_COMPONENT32F', samples: renderer.multisampleSamples });
  if (renderer.depthTexture) {
    context.bindTexture(context.TEXTURE_2D, renderer.depthTexture);
    context.texImage2D(context.TEXTURE_2D, 0, context.DEPTH_COMPONENT32F, width, height, 0, context.DEPTH_COMPONENT, context.FLOAT, null);
    renderer.renderTargets?.record('sceneDepth', { width, height, format: 'DEPTH_COMPONENT32F' });
  }
  for (const framebuffer of [renderer.multisampleFramebuffer, renderer.resolveFramebuffer]) {
    context.bindFramebuffer(context.FRAMEBUFFER, framebuffer);
    if (context.checkFramebufferStatus(context.FRAMEBUFFER) !== context.FRAMEBUFFER_COMPLETE) throw new Error('Reversed depth targets failed to allocate. Pass reversedDepth: false to the install.');
  }
  context.bindFramebuffer(context.FRAMEBUFFER, null);
}

/**
 * Makes the renderer's main vertex shader camera-relative from its first compile. The constructor calls this before it compiles, so
 * switching reversed depth on does not compile the main program a second time.
 */
export function prepareCameraRelativeProgram(renderer) {
  if (renderer.cameraRelativeMainProgram) return;
  if (!transformInstalled) {
    shaderTransforms.push(makeVertexCameraRelative);
    transformInstalled = true;
  }
  const startMainProgram = renderer.startMainProgram;
  renderer.startMainProgram = function startCameraRelativeMainProgram() {
    patchingMainProgram = true;
    try {
      return startMainProgram.call(this);
    } finally {
      patchingMainProgram = false;
    }
  };
  renderer.cameraRelativeMainProgram = true;
}

/**
 * Wraps the renderer so its colour pass draws with reversed-Z and a float depth buffer. Returns the renderer.
 * `mode` is `false` to opt out; anything else switches it on. `renderer.reversedDepth` is true once it is on. A browser without
 * EXT_clip_control, or a benchmark renderer, stays standard.
 */
export function installReversedDepth(renderer, mode = 'auto') {
  if (mode === false) renderer.reversedDepth ??= false;
  if (mode === false || renderer.reversedDepth !== undefined) return renderer;
  const context = renderer.context;
  const original = {
    render: renderer.render,
    applyEnvironmentUniforms: renderer.applyEnvironmentUniforms,
    applyDepthRank: renderer.applyDepthRank,
    resolveFrame: renderer.resolveFrame,
    allocateFrameTargets: renderer.allocateFrameTargets,
  };
  const rasterProjection = mat4.create();
  const rasterViewProjection = mat4.create();
  const cameraOffset = new Float32Array([0, 0, 0, 1]);
  const cameraShift = new Float32Array(4);
  let clipControl = null;
  let inFrame = false;
  let reversed = false;
  let frameEye = null;
  let cameraRelativeProgram = null;

  // Back to the standard range before the backgrounds, the post passes and the shadow maps draw.
  function endReversed() {
    if (!reversed || clipControl.active === false) return;
    clipControl.extension.clipControlEXT(clipControl.extension.LOWER_LEFT_EXT, clipControl.extension.NEGATIVE_ONE_TO_ONE_EXT);
    context.depthFunc(context.LESS);
    clipControl.active = false;
  }

  // The main program is in use. A program that a new shader feature builds starts with both uniforms at zero.
  function setCameraRelative(offset, shift) {
    context.uniform4fv(context.getUniformLocation(renderer.program, 'cameraOffset'), offset);
    context.uniform4fv(context.getUniformLocation(renderer.program, 'cameraShift'), shift);
    cameraRelativeProgram = renderer.program;
  }

  // The next frame, or a pass that draws with the standard matrix, expects the camera offset to be off.
  function clearCameraRelative() {
    if (cameraRelativeProgram !== renderer.program) return;
    context.useProgram(renderer.program);
    setCameraRelative(ZERO_VECTOR, ZERO_VECTOR);
    cameraRelativeProgram = null;
  }

  // Called with the main program in use, after its standard matrix is set: swap in the reversed one and clear to the far value.
  function beginReversed() {
    reverseProjectionDepth(rasterProjection, renderer.projection);
    mat4.multiply(rasterViewProjection, rasterProjection, renderer.view);
    context.uniformMatrix4fv(renderer.uniforms.viewProjection, false, rasterViewProjection);
    renderer.setFlushProjection(rasterViewProjection);
    cameraOffset.set(frameEye);
    cameraShift.set(rasterProjection.subarray(12, 16));
    setCameraRelative(cameraOffset, cameraShift);
    context.clearDepth(0);
    context.clear(context.DEPTH_BUFFER_BIT);
    context.clearDepth(1);
    clipControl.extension.clipControlEXT(clipControl.extension.LOWER_LEFT_EXT, clipControl.extension.ZERO_TO_ONE_EXT);
    context.depthFunc(context.GREATER);
    clipControl.active = true;
  }

  // The program was compiled with the patched line (prepareCameraRelativeProgram) or is compiled again now, and again whenever a
  // new shader feature rebuilds it.
  function useCameraRelativeProgram() {
    if (!renderer.shaderFeatures) return;
    if (renderer.cameraRelativeMainProgram) return;
    prepareCameraRelativeProgram(renderer);
    renderer.rebuildMainProgram();
  }

  function enable() {
    const extension = renderer.benchmark ? null : context.getExtension?.('EXT_clip_control');
    if (!extension) {
      renderer.reversedDepth = false;
      return false;
    }
    clipControl = { extension, active: false };
    reversed = true;
    renderer.reversedDepth = true;
    renderer.rasterProjection = rasterProjection;
    renderer.rasterViewProjection = rasterViewProjection;
    if (renderer.capabilities) renderer.capabilities.reversedDepth = true;
    renderer.applyEnvironmentUniforms = function applyEnvironmentUniformsReversed(map, uniforms) {
      original.applyEnvironmentUniforms.call(this, map, uniforms);
      if (inFrame && !clipControl.active && uniforms === undefined) beginReversed();
    };
    // Reversed depth grows toward the eye, so a depth rank pulls the other way there.
    renderer.applyDepthRank = function applyDepthRankReversed(rank) {
      original.applyDepthRank.call(this, rank, clipControl.active ? 1 : -1);
    };
    // The depth prepass rasterises with the same matrix and camera offset as the colour pass.
    renderer.prepassViewProjection = function prepassViewProjectionReversed() {
      return clipControl.active ? rasterViewProjection : this.viewProjection;
    };
    renderer.bindPrepassCameraRelative = function bindPrepassCameraRelativeReversed(uniforms) {
      context.uniform4fv(uniforms.cameraOffset, clipControl.active ? cameraOffset : ZERO_VECTOR);
      context.uniform4fv(uniforms.cameraShift, clipControl.active ? cameraShift : ZERO_VECTOR);
    };
    // The prepass writes depth with the colour pass's own test, and the colour pass then keeps what is at that depth.
    renderer.prepassDepthFunctions = function prepassDepthFunctionsReversed() {
      return clipControl.active ? { fill: context.GREATER, shade: context.GEQUAL } : { fill: context.LESS, shade: context.LEQUAL };
    };
    renderer.resolveFrame = function resolveFrameStandard(...parameters) {
      endReversed();
      return original.resolveFrame.apply(this, parameters);
    };
    renderer.allocateFrameTargets = function allocateFloatDepthTargets(width, height) {
      original.allocateFrameTargets.call(this, width, height);
      useFloatDepthTargets(this);
    };
    renderer.postStages.unshift(createDepthConversionStage());
    useFloatDepthTargets(renderer);
    useCameraRelativeProgram();
    return true;
  }

  renderer.render = function renderReversed(frame) {
    const outerEye = frameEye;
    frameEye = frame.eye;
    inFrame = true;
    try {
      return original.render.call(this, frame);
    } finally {
      inFrame = false;
      frameEye = outerEye;
      endReversed();
      clearCameraRelative();
    }
  };
  enable();
  return renderer;
}
