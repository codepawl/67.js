import { postStepSupport } from './shader-registry.js';
import { createStage, sharedFragmentHeader } from './camera-effects.js';
import { numberInRange, groupOf, onlyKeys, triple } from './post-fields.js';
import { resolveDistortion, resolveFlash, createDistortionStage, createFlashStage } from './post-air.js';
import { resolveMask, usesObjectMask, maskShader, bindMask, unbindMask, MASK_UNIFORM_NAMES } from './post-mask.js';

export { usesObjectMask };
export { placeAirSteps, checkAirStepNodes } from './post-air.js';

// Named post steps for a graded film: color balance (lift, gamma, gain), glare (streaks and fog glow), lens distortion with
// dispersion, stylize filters (sharpen, kuwahara, posterize, pixelate) and composite (a chroma or luma key over a background).
// Color balance, stylize and composite take a `mask` (post-mask.js) that limits them to named parts or a range of distance. They are optional full-frame stages. The core renderer carries none of their code: a recipe that names one
// loads this module (agent-scene-modules.js), and each stage compiles only on the first frame that turns it on. Defocus from
// depth is the `depthOfField` group of camera-effects.js, which is the same step under its older name.
//
// All of them are deterministic: fixed sample patterns and no history, so a seek repeats the same pixels.

const MAXIMUM_STREAK_ARMS = 8;
const STREAK_STEPS = 24;
const FOG_SAMPLES = 32;
const MAXIMUM_KUWAHARA_RADIUS = 8;
// Longest lateral color offset at the image corner at full dispersion, as a fraction of the distance from the center.
const MAXIMUM_DISPERSION = 0.03;

const NEUTRAL = Object.freeze({ lift: [0, 0, 0], gamma: [1, 1, 1], gain: [1, 1, 1] });

function resolveColorBalance(input) {
  const group = groupOf(input, 'colorBalance');
  onlyKeys(group, ['lift', 'gamma', 'gain', 'mask'], 'colorBalance');
  return {
    lift: triple(group.lift, NEUTRAL.lift, -1, 1, 'colorBalance.lift'),
    gamma: triple(group.gamma, NEUTRAL.gamma, 0.1, 4, 'colorBalance.gamma'),
    gain: triple(group.gain, NEUTRAL.gain, 0, 4, 'colorBalance.gain'),
    ...(group.mask === undefined ? {} : { mask: resolveMask(group.mask, 'colorBalance.mask') }),
  };
}

function wholeNumberInRange(value, minimum, maximum, name) {
  const result = numberInRange(value, undefined, minimum, maximum, name);
  if (!Number.isInteger(result)) throw new RangeError(`${name} must be a whole number.`);
  return result;
}

// Each filter is off until named; a filter named with a number turns on.
function resolveStylize(input) {
  const group = groupOf(input, 'stylize');
  onlyKeys(group, ['sharpen', 'kuwahara', 'posterize', 'pixelate', 'mask'], 'stylize');
  const resolved = {};
  if (group.sharpen !== undefined) resolved.sharpen = numberInRange(group.sharpen, undefined, 0, 2, 'stylize.sharpen');
  if (group.kuwahara !== undefined) resolved.kuwahara = wholeNumberInRange(group.kuwahara, 0, MAXIMUM_KUWAHARA_RADIUS, 'stylize.kuwahara');
  if (group.posterize !== undefined) resolved.posterize = wholeNumberInRange(group.posterize, 0, 256, 'stylize.posterize');
  if (group.pixelate !== undefined) resolved.pixelate = wholeNumberInRange(group.pixelate, 0, 64, 'stylize.pixelate');
  if (group.mask !== undefined) resolved.mask = resolveMask(group.mask, 'stylize.mask');
  return resolved;
}

const MAXIMUM_LIGHT = 64;
const CHROMA_DISTANCE_SCALE = 0.7;

function backgroundColor(value, name) {
  if (!Array.isArray(value) || value.length !== 3) throw new TypeError(`${name} must be three numbers.`);
  return triple(value, [0, 0, 0], 0, MAXIMUM_LIGHT, name);
}

function resolveBackground(input) {
  const group = groupOf(input, 'composite.background');
  onlyKeys(group, ['color', 'top', 'bottom'], 'composite.background');
  if (group.color !== undefined) {
    if (group.top !== undefined || group.bottom !== undefined) throw new TypeError('composite.background takes color, or top and bottom, not both. Fix: pass one of them.');
    return { color: backgroundColor(group.color, 'composite.background.color') };
  }
  if (group.top === undefined || group.bottom === undefined) {
    throw new TypeError('composite.background needs color, or both top and bottom. Fix: { "color": [0.1, 0.3, 0.8] } or { "top": [..], "bottom": [..] }.');
  }
  return { top: backgroundColor(group.top, 'composite.background.top'), bottom: backgroundColor(group.bottom, 'composite.background.bottom') };
}

function resolveKey(input) {
  const group = groupOf(input, 'composite.key');
  onlyKeys(group, ['chroma', 'luma'], 'composite.key');
  if ((group.chroma === undefined) === (group.luma === undefined)) {
    throw new TypeError('composite.key needs exactly one of chroma ({ color, tolerance, softness }) or luma ({ low, high, invert }).');
  }
  if (group.chroma !== undefined) {
    const chroma = groupOf(group.chroma, 'composite.key.chroma');
    onlyKeys(chroma, ['color', 'tolerance', 'softness'], 'composite.key.chroma');
    return {
      chroma: {
        color: backgroundColor(chroma.color, 'composite.key.chroma.color'),
        tolerance: numberInRange(chroma.tolerance, 0.3, 0, 1, 'composite.key.chroma.tolerance'),
        softness: numberInRange(chroma.softness, 0.1, 0, 1, 'composite.key.chroma.softness'),
      },
    };
  }
  const luma = groupOf(group.luma, 'composite.key.luma');
  onlyKeys(luma, ['low', 'high', 'invert'], 'composite.key.luma');
  const low = numberInRange(luma.low, 0, 0, 10, 'composite.key.luma.low');
  const high = numberInRange(luma.high, 1, 0, 10, 'composite.key.luma.high');
  if (high <= low) throw new RangeError('composite.key.luma.high must be greater than low. Fix: luma is linear scene light, 0.18 is middle grey.');
  if (luma.invert !== undefined && typeof luma.invert !== 'boolean') throw new TypeError('composite.key.luma.invert must be true or false.');
  return { luma: { low, high, invert: luma.invert === true } };
}

// A key turns pixels transparent; the background is what shows through, so a key without one has nothing to show.
function resolveComposite(input) {
  const group = groupOf(input, 'composite');
  onlyKeys(group, ['background', 'key', 'mask'], 'composite');
  const resolved = {};
  if (group.background !== undefined) resolved.background = resolveBackground(group.background);
  if (group.key !== undefined) resolved.key = resolveKey(group.key);
  if (group.mask !== undefined) resolved.mask = resolveMask(group.mask, 'composite.mask');
  if (resolved.key && !resolved.background) throw new TypeError('composite.key needs composite.background to show through the keyed pixels. Fix: add background { color } or { top, bottom }.');
  if (resolved.mask && !resolved.key) throw new TypeError('composite.mask limits the key, so it needs composite.key. Fix: add a key, or remove the mask.');
  return resolved;
}

function resolveGlare(input) {
  const group = groupOf(input, 'glare');
  onlyKeys(group, ['streaks', 'count', 'angle', 'fogGlow', 'threshold', 'size'], 'glare');
  const count = numberInRange(group.count, 4, 1, MAXIMUM_STREAK_ARMS, 'glare.count');
  if (!Number.isInteger(count)) throw new RangeError('glare.count must be a whole number.');
  return {
    streaks: numberInRange(group.streaks, 0, 0, 1, 'glare.streaks'),
    count,
    angle: numberInRange(group.angle, 0, -360, 360, 'glare.angle'),
    fogGlow: numberInRange(group.fogGlow, 0, 0, 1, 'glare.fogGlow'),
    threshold: numberInRange(group.threshold, 1, 0, 10, 'glare.threshold'),
    size: numberInRange(group.size, 0.15, 0.01, 1, 'glare.size'),
  };
}

function resolveLensDistortion(input) {
  const group = groupOf(input, 'lensDistortion');
  onlyKeys(group, ['distortion', 'dispersion'], 'lensDistortion');
  return {
    distortion: numberInRange(group.distortion, 0, -1, 1, 'lensDistortion.distortion'),
    dispersion: numberInRange(group.dispersion, 0, 0, 1, 'lensDistortion.dispersion'),
  };
}

/** The named steps an effects input sets, resolved with their defaults. A step the input leaves out stays out of the result. */
export function resolvePostSteps(effects) {
  const resolved = {};
  if (effects.distortion !== undefined) resolved.distortion = resolveDistortion(effects.distortion);
  if (effects.flash !== undefined) resolved.flash = resolveFlash(effects.flash);
  if (effects.colorBalance !== undefined) resolved.colorBalance = resolveColorBalance(effects.colorBalance);
  if (effects.glare !== undefined) resolved.glare = resolveGlare(effects.glare);
  if (effects.lensDistortion !== undefined) resolved.lensDistortion = resolveLensDistortion(effects.lensDistortion);
  if (effects.stylize !== undefined) resolved.stylize = resolveStylize(effects.stylize);
  if (effects.composite !== undefined) resolved.composite = resolveComposite(effects.composite);
  refuseMaskWithLensDistortion(resolved);
  return resolved;
}

// A mask reads the object ID pass and the depth, which are in undistorted screen space; lens distortion warps the colour image
// before the masked stages run, so the mask would sit in the wrong place, more so toward the corners and with dispersion.
function refuseMaskWithLensDistortion(resolved) {
  const lens = resolved.lensDistortion;
  const lensIsOn = Boolean(lens) && (lens.distortion !== 0 || lens.dispersion > 0);
  const airIsOn = resolved.distortion?.length > 0;
  const maskedStep = ['colorBalance', 'stylize', 'composite'].find(name => resolved[name]?.mask);
  if (airIsOn && maskedStep) {
    throw new TypeError(`${maskedStep}.mask cannot be combined with distortion: the mask is in undistorted screen space and would not line up with the bent picture. Fix: remove the mask, or remove the distortion step.`);
  }
  if (lensIsOn && maskedStep) {
    throw new TypeError(`${maskedStep}.mask cannot be combined with lensDistortion: the mask is in undistorted screen space and would not line up with the warped image. Fix: remove the mask, or set lensDistortion.distortion and dispersion to 0.`);
  }
}

// Registers what the look needs: the field names it accepts and how to resolve them (src/shader-registry.js).
postStepSupport.fields = ['distortion', 'flash', 'colorBalance', 'glare', 'lensDistortion', 'stylize', 'composite'];
postStepSupport.resolve = resolvePostSteps;

export const colorBalanceFragment = `${sharedFragmentHeader}
${maskShader}
uniform vec3 lift;
uniform vec3 inverseGamma;
uniform vec3 gain;
void main() {
  vec4 source = texture(sourceTexture, textureCoordinate);
  // Lift raises the shadows and fades out toward white, gain scales the highlights, gamma bends the midtones.
  vec3 graded = source.rgb * gain + lift * (1.0 - clamp(source.rgb, 0.0, 1.0));
  graded = pow(max(graded, vec3(0.0)), inverseGamma);
  float mask = maskAt(textureCoordinate);
  outputColor = vec4(mask < 1.0 ? mix(source.rgb, graded, mask) : graded, source.a);
}`;

export const stylizeFragment = `${sharedFragmentHeader}
${maskShader}
uniform float sharpenAmount;
uniform int kuwaharaRadius;
uniform float posterizeLevels;
uniform float pixelateSize;
vec2 snapped(vec2 coordinate) {
  if (pixelateSize < 1.0) return coordinate;
  return (floor(coordinate * resolution / pixelateSize) + 0.5) * pixelateSize / resolution;
}
vec4 sourceAt(vec2 coordinate) {
  return texture(sourceTexture, snapped(coordinate));
}
// Kuwahara: the mean of whichever of the four quadrants around the pixel varies least, so flat areas stay flat and edges stay sharp.
vec3 kuwahara(vec2 coordinate) {
  vec3 bestMean = vec3(0.0);
  float bestVariance = 1e30;
  for (int quadrant = 0; quadrant < 4; quadrant++) {
    vec2 direction = vec2(quadrant == 1 || quadrant == 3 ? -1.0 : 1.0, quadrant >= 2 ? -1.0 : 1.0);
    vec3 sum = vec3(0.0);
    float lumaSum = 0.0;
    float lumaSquareSum = 0.0;
    float count = 0.0;
    for (int row = 0; row <= ${MAXIMUM_KUWAHARA_RADIUS}; row++) {
      if (row > kuwaharaRadius) break;
      for (int column = 0; column <= ${MAXIMUM_KUWAHARA_RADIUS}; column++) {
        if (column > kuwaharaRadius) break;
        vec3 color = sourceAt(coordinate + direction * vec2(float(column), float(row)) / resolution).rgb;
        float luma = dot(color, vec3(0.299, 0.587, 0.114));
        sum += color;
        lumaSum += luma;
        lumaSquareSum += luma * luma;
        count += 1.0;
      }
    }
    float variance = lumaSquareSum / count - (lumaSum / count) * (lumaSum / count);
    if (variance < bestVariance) {
      bestVariance = variance;
      bestMean = sum / count;
    }
  }
  return bestMean;
}
void main() {
  vec4 source = texture(sourceTexture, textureCoordinate);
  vec4 center = sourceAt(textureCoordinate);
  vec3 color = kuwaharaRadius > 0 ? kuwahara(textureCoordinate) : center.rgb;
  if (sharpenAmount > 0.0) {
    vec2 texel = 1.0 / resolution;
    vec3 around = sourceAt(textureCoordinate + vec2(texel.x, 0.0)).rgb + sourceAt(textureCoordinate - vec2(texel.x, 0.0)).rgb
      + sourceAt(textureCoordinate + vec2(0.0, texel.y)).rgb + sourceAt(textureCoordinate - vec2(0.0, texel.y)).rgb;
    color = max(color + sharpenAmount * (center.rgb * 4.0 - around), vec3(0.0));
  }
  if (posterizeLevels > 0.0) color = floor(color * posterizeLevels + 0.5) / posterizeLevels;
  float mask = maskAt(textureCoordinate);
  outputColor = vec4(mask < 1.0 ? mix(source.rgb, color, mask) : color, source.a);
}`;

export const compositeFragment = `${sharedFragmentHeader}
${maskShader}
uniform float keyMode;
uniform vec3 keyColor;
uniform vec3 keyRange;
uniform float keyInvert;
uniform vec3 backgroundTop;
uniform vec3 backgroundBottom;
vec2 chromaOf(vec3 color) {
  vec3 normalized = color / max(max(color.r, max(color.g, color.b)), 0.0001);
  return vec2(dot(normalized, vec3(-0.169, -0.331, 0.5)), dot(normalized, vec3(0.5, -0.419, -0.081)));
}
// 1 keeps the pixel, 0 shows the background. Chroma: distance between the pixel's and the key's chroma, so brightness does not matter.
float keepAmount(vec3 color) {
  if (keyMode > 1.5) {
    float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));
    float keep = smoothstep(keyRange.x, keyRange.y, luma);
    return mix(keep, 1.0 - keep, keyInvert);
  }
  float distanceToKey = distance(chromaOf(color), chromaOf(keyColor));
  return smoothstep(keyRange.x, keyRange.x + keyRange.y, distanceToKey);
}
void main() {
  vec4 source = texture(sourceTexture, textureCoordinate);
  float keep = 1.0;
  if (keyMode > 0.5) keep = mix(1.0, keepAmount(source.rgb), maskAt(textureCoordinate));
  vec3 background = mix(backgroundBottom, backgroundTop, textureCoordinate.y);
  outputColor = vec4(mix(background, source.rgb, keep * source.a), 1.0);
}`;

export const glareFragment = `${sharedFragmentHeader}
uniform float streakAmount;
uniform int streakCount;
uniform float streakAngle;
uniform float fogAmount;
uniform float threshold;
uniform float sizePixels;
uniform float fogLod;
vec3 brightPart(vec2 coordinate, float lod) {
  vec3 color = textureLod(sourceTexture, coordinate, lod).rgb;
  float peak = max(color.r, max(color.g, color.b));
  return color * max(peak - threshold, 0.0) / max(peak, 0.00001);
}
void main() {
  vec4 source = texture(sourceTexture, textureCoordinate);
  vec3 glow = vec3(0.0);
  float jitter = pixelRotation() / 6.2831853;
  if (streakAmount > 0.0) {
    vec3 streaks = vec3(0.0);
    // Each arm is one thin line of taps from the pixel outward, evenly spaced around the circle; a pair of arms is one streak.
    // Weights fall off cubically, so a streak is bright at its core and thins to nothing at its tip.
    for (int arm = 0; arm < ${MAXIMUM_STREAK_ARMS}; arm++) {
      if (arm >= streakCount) break;
      float angle = streakAngle + float(arm) * 6.2831853 / float(streakCount);
      vec2 step = vec2(cos(angle), sin(angle)) * sizePixels / ${STREAK_STEPS}.0 / resolution;
      for (int index = 1; index <= ${STREAK_STEPS}; index++) {
        float along = float(index) - jitter;
        float weight = 1.0 - along / (${STREAK_STEPS}.0 + 1.0);
        streaks += brightPart(textureCoordinate + step * along, 0.0) * weight * weight * weight;
      }
    }
    glow += streaks * streakAmount * 4.0 / ${STREAK_STEPS}.0;
  }
  if (fogAmount > 0.0) {
    // Taps read a blurred level of the frame, so the fixed spiral of taps merges into one smooth halo with no per-pixel noise.
    vec3 fog = vec3(0.0);
    float weightSum = 0.0;
    for (int index = 0; index < ${FOG_SAMPLES}; index++) {
      float ring = sqrt((float(index) + 0.5) / ${FOG_SAMPLES}.0);
      float angle = float(index) * 2.3999632;
      float weight = 1.0 - ring * ring;
      fog += brightPart(textureCoordinate + vec2(cos(angle), sin(angle)) * ring * sizePixels / resolution, fogLod) * weight;
      weightSum += weight;
    }
    glow += fog / weightSum * fogAmount;
  }
  outputColor = vec4(source.rgb + glow, source.a);
}`;

export const lensDistortionFragment = `${sharedFragmentHeader}
uniform float distortion;
uniform float dispersion;
void main() {
  float aspect = resolution.x / resolution.y;
  vec2 centered = (textureCoordinate - 0.5) * 2.0;
  centered.x *= aspect;
  // Positive distortion is barrel: the edges sample from further out, so they bunch toward the center. Each channel
  // takes a slightly different scale, so a line off center splits into color fringes that grow with the distance.
  float bend = 1.0 + distortion * 0.25 * dot(centered, centered);
  vec3 spread = 1.0 + dispersion * ${MAXIMUM_DISPERSION} * vec3(1.0, 0.0, -1.0);
  // Barrel samples from beyond the frame at the corners, so the picture is scaled to fill: the corner maps onto the corner for every channel.
  float cornerBend = max(1.0 + distortion * 0.25 * (aspect * aspect + 1.0), 1.0);
  vec3 scales = bend * spread / (cornerBend * (1.0 + dispersion * ${MAXIMUM_DISPERSION}));
  vec2 red = centered * scales.r;
  vec2 green = centered * scales.g;
  vec2 blue = centered * scales.b;
  vec4 center = texture(sourceTexture, green / vec2(aspect, 1.0) * 0.5 + 0.5);
  outputColor = vec4(texture(sourceTexture, red / vec2(aspect, 1.0) * 0.5 + 0.5).r, center.g,
    texture(sourceTexture, blue / vec2(aspect, 1.0) * 0.5 + 0.5).b, center.a);
}`;

// The renderer resolves only the core effects, so a stage reads its group from the frame's own effects.
function stepsOf(frame) {
  return resolvePostSteps(frame.effects ?? {});
}

function isColorBalanceActive(colorBalance) {
  return Boolean(colorBalance) && ['lift', 'gamma', 'gain'].some(name => colorBalance[name].some((component, index) => component !== NEUTRAL[name][index]));
}

// The object ID texture is the colour attachment of the pass framebuffer, which the next frame draws into. Leaving it bound on
// unit 2 would risk a feedback loop, so the unit is cleared after the masked draw.
function withMaskUnbound(stage) {
  return {
    ...stage,
    apply(renderer, frame, effects, sourceTexture) {
      const result = stage.apply(renderer, frame, effects, sourceTexture);
      if (result) unbindMask(renderer.context);
      return result;
    },
  };
}

function createColorBalanceStage() {
  return withMaskUnbound(createStage({
    name: 'Color balance',
    fragment: colorBalanceFragment,
    uniformNames: ['lift', 'inverseGamma', 'gain', ...MASK_UNIFORM_NAMES],
    isActive: (effects, frame) => isColorBalanceActive(stepsOf(frame).colorBalance),
    setUniforms(context, uniforms, renderer, frame) {
      const { colorBalance } = stepsOf(frame);
      context.uniform3fv(uniforms.lift, colorBalance.lift);
      context.uniform3fv(uniforms.inverseGamma, colorBalance.gamma.map(gamma => 1 / gamma));
      context.uniform3fv(uniforms.gain, colorBalance.gain);
      bindMask(context, uniforms, renderer, frame, colorBalance.mask);
    },
  }));
}

function isStylizeActive(stylize) {
  return Boolean(stylize) && (stylize.sharpen > 0 || stylize.kuwahara > 0 || stylize.posterize > 0 || stylize.pixelate > 0);
}

function createStylizeStage() {
  return withMaskUnbound(createStage({
    name: 'Stylize',
    fragment: stylizeFragment,
    uniformNames: ['sharpenAmount', 'kuwaharaRadius', 'posterizeLevels', 'pixelateSize', ...MASK_UNIFORM_NAMES],
    isActive: (effects, frame) => isStylizeActive(stepsOf(frame).stylize),
    setUniforms(context, uniforms, renderer, frame) {
      const { stylize } = stepsOf(frame);
      context.uniform1f(uniforms.sharpenAmount, stylize.sharpen ?? 0);
      context.uniform1i(uniforms.kuwaharaRadius, stylize.kuwahara ?? 0);
      context.uniform1f(uniforms.posterizeLevels, stylize.posterize ?? 0);
      context.uniform1f(uniforms.pixelateSize, stylize.pixelate ?? 0);
      bindMask(context, uniforms, renderer, frame, stylize.mask);
    },
  }));
}

function createCompositeStage() {
  return withMaskUnbound(createStage({
    name: 'Composite',
    fragment: compositeFragment,
    uniformNames: ['keyMode', 'keyColor', 'keyRange', 'keyInvert', 'backgroundTop', 'backgroundBottom', ...MASK_UNIFORM_NAMES],
    isActive: (effects, frame) => Boolean(stepsOf(frame).composite?.background),
    setUniforms(context, uniforms, renderer, frame) {
      const { composite } = stepsOf(frame);
      const { background, key } = composite;
      context.uniform3fv(uniforms.backgroundTop, background.color ?? background.top);
      context.uniform3fv(uniforms.backgroundBottom, background.color ?? background.bottom);
      const chroma = key?.chroma;
      const luma = key?.luma;
      context.uniform1f(uniforms.keyMode, chroma ? 1 : luma ? 2 : 0);
      context.uniform3fv(uniforms.keyColor, chroma?.color ?? [0, 0, 0]);
      const range = chroma
        ? [chroma.tolerance * CHROMA_DISTANCE_SCALE, Math.max(chroma.softness * CHROMA_DISTANCE_SCALE, 0.0001), 0]
        : [luma?.low ?? 0, luma?.high ?? 1, 0];
      context.uniform3fv(uniforms.keyRange, range);
      context.uniform1f(uniforms.keyInvert, luma?.invert ? 1 : 0);
      bindMask(context, uniforms, renderer, frame, composite.mask);
    },
  }));
}

function createGlareStage() {
  const stage = createStage({
    name: 'Glare',
    fragment: glareFragment,
    uniformNames: ['streakAmount', 'streakCount', 'streakAngle', 'fogAmount', 'threshold', 'sizePixels', 'fogLod'],
    isActive: (effects, frame) => {
      const { glare } = stepsOf(frame);
      return Boolean(glare) && (glare.streaks > 0 || glare.fogGlow > 0);
    },
    setUniforms(context, uniforms, renderer, frame) {
      const { glare } = stepsOf(frame);
      context.uniform1f(uniforms.streakAmount, glare.streaks);
      context.uniform1i(uniforms.streakCount, glare.count);
      context.uniform1f(uniforms.streakAngle, glare.angle * Math.PI / 180);
      context.uniform1f(uniforms.fogAmount, glare.fogGlow);
      context.uniform1f(uniforms.threshold, glare.threshold);
      const sizePixels = glare.size * renderer.canvas.height;
      context.uniform1f(uniforms.sizePixels, sizePixels);
      // The halo blurs at about two thirds of its radius: coarse enough to hide the tap spacing, fine enough to keep its shape.
      context.uniform1f(uniforms.fogLod, Math.max(0, Math.log2(sizePixels / 1.5)));
    },
  });
  // The halo reads blurred levels of the frame, so the frame gets a mip chain for this draw and goes back to one level after it.
  return {
    ...stage,
    apply(renderer, frame, effects, sourceTexture) {
      const context = renderer.context;
      const fogOn = stepsOf(frame).glare?.fogGlow > 0;
      if (fogOn) {
        context.activeTexture(context.TEXTURE0);
        context.bindTexture(context.TEXTURE_2D, sourceTexture);
        context.generateMipmap(context.TEXTURE_2D);
        context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MIN_FILTER, context.LINEAR_MIPMAP_LINEAR);
      }
      const result = stage.apply(renderer, frame, effects, sourceTexture);
      if (fogOn) {
        context.activeTexture(context.TEXTURE0);
        context.bindTexture(context.TEXTURE_2D, sourceTexture);
        context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MIN_FILTER, context.LINEAR);
      }
      return result;
    },
  };
}

function createLensDistortionStage() {
  return createStage({
    name: 'Lens distortion',
    fragment: lensDistortionFragment,
    uniformNames: ['distortion', 'dispersion'],
    isActive: (effects, frame) => {
      const { lensDistortion } = stepsOf(frame);
      return Boolean(lensDistortion) && (lensDistortion.distortion !== 0 || lensDistortion.dispersion > 0);
    },
    setUniforms(context, uniforms, renderer, frame) {
      const { lensDistortion } = stepsOf(frame);
      context.uniform1f(uniforms.distortion, lensDistortion.distortion);
      context.uniform1f(uniforms.dispersion, lensDistortion.dispersion);
    },
  });
}

/**
 * Adds the air distortion and flash steps (post-air.js), glare, lens distortion, color balance, the stylize filters and the composite key to a renderer, after any depth of field and motion blur it has, in that
 * order. Like them it needs `depth: true`. Each stage runs only for a frame whose effects set it. A step with a `mask` by
 * objects reads the object ID pass: install the render passes and draw that pass before the lit frame (`usesObjectMask` says when).
 */
export function installPostSteps(renderer) {
  if (!renderer.postStages.some(stage => stage.name === 'Glare')) {
    renderer.postStages.push(createDistortionStage(stepsOf), createFlashStage(stepsOf), createGlareStage(), createLensDistortionStage(), createColorBalanceStage(), createStylizeStage(), createCompositeStage());
  }
  return renderer;
}
