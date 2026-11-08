import { mat4 } from 'gl-matrix';
import { applyProjection } from './camera.js';
import { compileProgram, fullscreenVertex } from './gl-program.js';

// Depth of field and camera motion blur as optional full-frame stages. The core renderer carries no shader text for
// them: installCameraEffects adds the stages, and each one compiles and allocates only when a frame turns it on.
//
// Both are deterministic. They read only the resolved frame, its depth and the camera of this frame (plus the camera
// of an earlier instant that the caller samples from time, never from render history). Sample patterns are fixed and
// the per-pixel rotation comes from the pixel position, so a seek to a frame repeats the same pixels.

const DEPTH_OF_FIELD_SAMPLES = 32;
const MOTION_BLUR_SAMPLES = 16;
// Largest blur circle as a fraction of image height at full blur; the blur setting scales it from zero.
const MAXIMUM_BLUR_HEIGHT_FRACTION = 0.05;
// Longest motion streak as a fraction of the frame, so a camera cut cannot smear the whole image.
const MAXIMUM_STREAK = 0.1;

export const sharedFragmentHeader = `#version 300 es
precision highp float;
in vec2 textureCoordinate;
uniform sampler2D sourceTexture;
uniform sampler2D sceneDepth;
uniform mat4 inverseViewProjection;
uniform vec2 resolution;
out vec4 outputColor;
float pixelRotation() {
  return 6.2831853 * fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
}
vec3 worldPointAt(vec2 coordinate) {
  float depth = texture(sceneDepth, coordinate).r;
  vec4 point = inverseViewProjection * vec4(coordinate * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
  return point.xyz / point.w;
}
`;

export const depthOfFieldFragment = `${sharedFragmentHeader}
uniform vec3 eye;
uniform vec3 forward;
uniform float focusDistance;
uniform float blurPixels;
float blurRadius(vec2 coordinate) {
  float distanceAlongView = max(dot(worldPointAt(coordinate) - eye, forward), 0.001);
  // Thin-lens shape: zero at the focus plane, rising toward one for very near and very far surfaces.
  return blurPixels * clamp(abs(distanceAlongView - focusDistance) / distanceAlongView, 0.0, 1.0);
}
void main() {
  float centerRadius = blurRadius(textureCoordinate);
  vec4 center = texture(sourceTexture, textureCoordinate);
  if (centerRadius < 0.5) {
    outputColor = center;
    return;
  }
  float rotation = pixelRotation();
  vec4 sum = center;
  float weightSum = 1.0;
  for (int index = 0; index < ${DEPTH_OF_FIELD_SAMPLES}; index++) {
    float ring = sqrt((float(index) + 0.5) / ${DEPTH_OF_FIELD_SAMPLES}.0);
    float angle = float(index) * 2.3999632 + rotation;
    vec2 offsetPixels = vec2(cos(angle), sin(angle)) * ring * centerRadius;
    vec2 coordinate = textureCoordinate + offsetPixels / resolution;
    // A sample only spreads onto this pixel when its own circle reaches it, so sharp foreground does not bleed.
    float reach = clamp(blurRadius(coordinate) - length(offsetPixels) + 1.0, 0.0, 1.0);
    sum += texture(sourceTexture, coordinate) * reach;
    weightSum += reach;
  }
  outputColor = sum / weightSum;
}`;

export const motionBlurFragment = `${sharedFragmentHeader}
uniform mat4 previousViewProjection;
void main() {
  vec3 world = worldPointAt(textureCoordinate);
  vec4 previousClip = previousViewProjection * vec4(world, 1.0);
  vec2 velocity = vec2(0.0);
  if (previousClip.w > 0.0) velocity = (previousClip.xy / previousClip.w * 0.5 + 0.5) - textureCoordinate;
  float streak = length(velocity);
  if (streak > ${MAXIMUM_STREAK}) velocity *= ${MAXIMUM_STREAK} / streak;
  if (length(velocity * resolution) < 0.5) {
    outputColor = texture(sourceTexture, textureCoordinate);
    return;
  }
  float jitter = pixelRotation() / 6.2831853;
  vec4 sum = vec4(0.0);
  for (int index = 0; index < ${MOTION_BLUR_SAMPLES}; index++) {
    float along = (float(index) + jitter) / ${MOTION_BLUR_SAMPLES}.0;
    sum += texture(sourceTexture, textureCoordinate + velocity * along);
  }
  outputColor = sum / ${MOTION_BLUR_SAMPLES}.0;
}`;

function createTarget(renderer) {
  const context = renderer.context;
  const { width, height } = renderer.canvas;
  const texture = context.createTexture();
  context.bindTexture(context.TEXTURE_2D, texture);
  context.texImage2D(context.TEXTURE_2D, 0, renderer.hdr ? context.RGBA16F : context.RGBA8, width, height, 0, context.RGBA,
    renderer.hdr ? context.HALF_FLOAT : context.UNSIGNED_BYTE, null);
  context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MIN_FILTER, context.LINEAR);
  context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MAG_FILTER, context.LINEAR);
  context.texParameteri(context.TEXTURE_2D, context.TEXTURE_WRAP_S, context.CLAMP_TO_EDGE);
  context.texParameteri(context.TEXTURE_2D, context.TEXTURE_WRAP_T, context.CLAMP_TO_EDGE);
  const framebuffer = context.createFramebuffer();
  context.bindFramebuffer(context.FRAMEBUFFER, framebuffer);
  context.framebufferTexture2D(context.FRAMEBUFFER, context.COLOR_ATTACHMENT0, context.TEXTURE_2D, texture, 0);
  if (context.checkFramebufferStatus(context.FRAMEBUFFER) !== context.FRAMEBUFFER_COMPLETE) {
    throw new Error('Camera effect framebuffer allocation failed. Choose a lower quality preset.');
  }
  return { texture, framebuffer };
}

/**
 * One full-frame stage. `isActive` decides from the resolved effects whether it runs, and `setUniforms` fills the
 * values that are specific to the effect.
 */
export function createStage({ name, fragment, uniformNames, isActive, setUniforms }) {
  let program = null;
  let uniforms = null;
  let target = null;

  function releaseTargets(context) {
    if (!target) return;
    context.deleteTexture(target.texture);
    context.deleteFramebuffer(target.framebuffer);
    target = null;
  }

  function apply(renderer, frame, effects, sourceTexture) {
    if (!isActive(effects, frame)) return null;
    if (!renderer.depthTexture) throw new Error(`${name} requires depth:true on the renderer.`);
    const context = renderer.context;
    if (!program) {
      program = compileProgram(context, fullscreenVertex, fragment);
      const names = ['sourceTexture', 'sceneDepth', 'inverseViewProjection', 'resolution', ...uniformNames];
      uniforms = Object.fromEntries(names.map(uniformName => [uniformName, context.getUniformLocation(program, uniformName)]));
    }
    target ??= createTarget(renderer);
    context.bindFramebuffer(context.FRAMEBUFFER, target.framebuffer);
    context.viewport(0, 0, renderer.canvas.width, renderer.canvas.height);
    context.disable(context.DEPTH_TEST);
    context.disable(context.CULL_FACE);
    context.bindVertexArray(null);
    context.useProgram(program);
    context.activeTexture(context.TEXTURE0);
    context.bindTexture(context.TEXTURE_2D, sourceTexture);
    context.uniform1i(uniforms.sourceTexture, 0);
    context.activeTexture(context.TEXTURE1);
    context.bindTexture(context.TEXTURE_2D, renderer.depthTexture);
    context.uniform1i(uniforms.sceneDepth, 1);
    context.uniformMatrix4fv(uniforms.inverseViewProjection, false, renderer.inverseViewProjection);
    context.uniform2f(uniforms.resolution, renderer.canvas.width, renderer.canvas.height);
    setUniforms(context, uniforms, renderer, frame, effects);
    context.drawArrays(context.TRIANGLES, 0, 3);
    return target.texture;
  }

  function dispose(context) {
    releaseTargets(context);
    if (program) context.deleteProgram(program);
    program = null;
  }

  return { name, apply, releaseTargets, dispose };
}

function createDepthOfFieldStage() {
  return createStage({
    name: 'Depth of field',
    fragment: depthOfFieldFragment,
    uniformNames: ['eye', 'forward', 'focusDistance', 'blurPixels'],
    isActive: effects => effects.depthOfField.blur > 0,
    setUniforms(context, uniforms, renderer, frame, effects) {
      context.uniform3fv(uniforms.eye, frame.eye);
      context.uniform3fv(uniforms.forward, renderer.viewForward);
      context.uniform1f(uniforms.focusDistance, effects.depthOfField.focusDistance);
      context.uniform1f(uniforms.blurPixels, effects.depthOfField.blur * MAXIMUM_BLUR_HEIGHT_FRACTION * renderer.canvas.height);
    },
  });
}

function createMotionBlurStage() {
  return createStage({
    name: 'Motion blur',
    fragment: motionBlurFragment,
    uniformNames: ['previousViewProjection'],
    // Without a previous camera there is no known motion, so the frame passes through untouched.
    isActive: (effects, frame) => effects.motionBlur.shutter > 0 && Boolean(frame.previousCamera),
    setUniforms(context, uniforms, renderer, frame) {
      context.uniformMatrix4fv(uniforms.previousViewProjection, false, previousViewProjectionOf(renderer, frame));
    },
  });
}

// The previous camera only replaces what it names (eye, target, up, lens), so a partial camera works.
function previousViewProjectionOf(renderer, frame) {
  const previous = { ...frame, ...frame.previousCamera };
  const aspect = renderer.canvas.width / renderer.canvas.height;
  const projection = applyProjection(mat4.create(), previous, aspect, { world: renderer.world });
  const view = mat4.lookAt(mat4.create(), previous.eye, previous.target ?? [0, 1.2, 0], previous.up ?? [0, 1, 0]);
  return mat4.multiply(mat4.create(), projection, view);
}

/**
 * Adds depth of field and camera motion blur to a renderer. Both need `depth: true`. Motion blur reads
 * `frame.previousCamera`, the camera at the start of the shutter interval; derive it from the frame time.
 */
export function installCameraEffects(renderer) {
  if (!renderer.postStages.some(stage => stage.name === 'Depth of field')) {
    renderer.postStages.push(createDepthOfFieldStage(), createMotionBlurStage());
  }
  return renderer;
}

// A lens at this f-stop or wider (smaller number) gets the full blur setting; narrower stops scale it down in proportion.
const FULL_BLUR_F_STOP = 1.4;

/**
 * The effects of one frame when the camera carries an f-stop: depth of field with the blur that stop gives (1.4 / fStop, at most
 * 1), focused on the camera's target. Effects with their own blur (a timeline shot's) are left as they are.
 */
export function effectsWithFStop(effects, camera) {
  if (camera.fStop === undefined || effects.depthOfField.blur > 0) return effects;
  const focusDistance = Math.max(0.01, Math.hypot(...camera.target.map((component, axis) => component - camera.eye[axis])));
  return { ...effects, depthOfField: { blur: Math.min(1, FULL_BLUR_F_STOP / camera.fStop), focusDistance } };
}
