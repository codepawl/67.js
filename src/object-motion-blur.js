import { mat4 } from 'gl-matrix';
import {
  createStage, previousViewProjectionOf, sharedFragmentHeader, MOTION_BLUR_SAMPLES, MAXIMUM_STREAK,
} from './camera-effects.js';

// Per-object motion blur: a fast prop or part smears along its own screen motion while the still background stays sharp.
// It is opt-in (`effects.motionBlur.objects` above zero) and loads on demand, so a scene without it pays nothing.
//
// The caller draws the object ID pass first (frame.objectMotion carries the parts' transforms at the shutter's start and
// end). Each part's delta matrix carries a point from where it is now to where it was one shutter ago; the stage reads the
// part number of each pixel, moves the pixel's world point by that delta and projects it with the earlier camera. The
// difference on screen is the velocity, and it holds the camera's own motion too, so this stage replaces camera motion
// blur on such a frame. Parts are rigid here: a skinned or morphed part blurs only by its node transform.

const MATRICES_PER_ROW = 256;
const TEXTURE_WIDTH = MATRICES_PER_ROW * 4;
const STAGE_NAME = 'Object motion blur';

export const objectMotionBlurFragment = `${sharedFragmentHeader}
uniform sampler2D objectIds;
uniform sampler2D objectDeltas;
uniform mat4 previousViewProjection;
uniform float objectAmount;
uniform int objectCount;
vec2 screenPointOf(vec3 world) {
  vec4 previousClip = previousViewProjection * vec4(world, 1.0);
  if (previousClip.w <= 0.0) return textureCoordinate;
  return previousClip.xy / previousClip.w * 0.5 + 0.5;
}
mat4 deltaOf(int identifier) {
  int row = (identifier - 1) / ${MATRICES_PER_ROW};
  int column = ((identifier - 1) - row * ${MATRICES_PER_ROW}) * 4;
  return mat4(texelFetch(objectDeltas, ivec2(column, row), 0), texelFetch(objectDeltas, ivec2(column + 1, row), 0),
    texelFetch(objectDeltas, ivec2(column + 2, row), 0), texelFetch(objectDeltas, ivec2(column + 3, row), 0));
}
void main() {
  vec3 idBytes = floor(texelFetch(objectIds, ivec2(gl_FragCoord.xy), 0).rgb * 255.0 + 0.5);
  int identifier = int(idBytes.r + idBytes.g * 256.0 + idBytes.b * 65536.0);
  vec3 world = worldPointAt(textureCoordinate);
  vec2 velocity = screenPointOf(world) - textureCoordinate;
  if (identifier > 0 && identifier <= objectCount) {
    vec2 objectVelocity = screenPointOf((deltaOf(identifier) * vec4(world, 1.0)).xyz) - textureCoordinate;
    velocity += (objectVelocity - velocity) * objectAmount;
  }
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

/** The world matrix of every part, by name, at this instant. Matrices are copied, so a later seek does not change them. */
export function sampleWorldMatrices(parts) {
  return new Map(parts.map(part => [part.name, mat4.clone(part.matrix)]));
}

/**
 * Packs one delta matrix per object ID, in the order the object ID pass numbers parts (draw order, grouped by geometry).
 * A part with no matrix in `previous` or one that did not move keeps the identity, and so does a pixel of no object.
 */
export function packObjectMotion(renderer, current, previous) {
  const identifiers = renderer.batches.filter(batch => renderer.drawsInOpaqueLoop(batch)).flatMap(batch => batch.parts.map(part => part.name));
  const rows = Math.max(1, Math.ceil(identifiers.length / MATRICES_PER_ROW));
  const matrices = new Float32Array(TEXTURE_WIDTH * rows * 4);
  const inverse = mat4.create();
  const delta = mat4.create();
  identifiers.forEach((name, index) => {
    const slot = matrices.subarray(index * 16, index * 16 + 16);
    const now = current.get(name);
    const before = previous.get(name);
    // The texture upload is row-major with 256 matrices per row, so the matrix of ID n + 1 starts at float 16 * n.
    if (now && before && mat4.invert(inverse, now)) {
      mat4.multiply(delta, before, inverse);
      slot.set(delta);
    } else {
      slot.set(mat4.create());
    }
  });
  for (let index = identifiers.length; index < MATRICES_PER_ROW * rows; index++) matrices.set(mat4.create(), index * 16);
  return { matrices, rows, count: identifiers.length };
}

function createObjectMotionStage() {
  let deltaTexture = null;
  const stage = createStage({
    name: STAGE_NAME,
    fragment: objectMotionBlurFragment,
    uniformNames: ['objectIds', 'objectDeltas', 'previousViewProjection', 'objectAmount', 'objectCount'],
    isActive: (effects, frame) => effects.motionBlur.shutter > 0 && effects.motionBlur.objects > 0 && Boolean(frame.objectMotion),
    setUniforms(context, uniforms, renderer, frame, effects) {
      const { matrices, rows, count } = frame.objectMotion;
      deltaTexture ??= context.createTexture();
      context.activeTexture(context.TEXTURE3);
      context.bindTexture(context.TEXTURE_2D, deltaTexture);
      context.texImage2D(context.TEXTURE_2D, 0, context.RGBA32F, TEXTURE_WIDTH, rows, 0, context.RGBA, context.FLOAT, matrices);
      context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MIN_FILTER, context.NEAREST);
      context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MAG_FILTER, context.NEAREST);
      context.uniform1i(uniforms.objectDeltas, 3);
      context.activeTexture(context.TEXTURE2);
      context.bindTexture(context.TEXTURE_2D, renderer.passSupport.texture);
      context.uniform1i(uniforms.objectIds, 2);
      context.uniform1i(uniforms.objectCount, count);
      context.uniform1f(uniforms.objectAmount, effects.motionBlur.objects);
      const viewProjection = frame.previousCamera ? previousViewProjectionOf(renderer, frame) : renderer.viewProjection;
      context.uniformMatrix4fv(uniforms.previousViewProjection, false, viewProjection);
      context.activeTexture(context.TEXTURE1);
    },
  });
  function release(context) {
    if (deltaTexture) context.deleteTexture(deltaTexture);
    deltaTexture = null;
  }
  return {
    ...stage,
    releaseTargets(context) {
      stage.releaseTargets(context);
      release(context);
    },
    dispose(context) {
      stage.dispose(context);
      release(context);
    },
  };
}

/**
 * Adds object motion blur to a renderer that has the camera effects and render passes installed. Draw the object ID pass
 * first and pass `frame.objectMotion` (from packObjectMotion); the stage runs only for such a frame with
 * `effects.motionBlur.shutter` and `effects.motionBlur.objects` above zero.
 */
export function installObjectMotionBlur(renderer) {
  if (!renderer.passSupport) throw new Error('Object motion blur needs installRenderPasses(renderer).');
  if (!renderer.postStages.some(stage => stage.name === STAGE_NAME)) renderer.postStages.push(createObjectMotionStage());
  return renderer;
}
