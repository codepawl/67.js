import { postStepSupport } from './shader-registry.js';
import { createStage, sharedFragmentHeader } from './camera-effects.js';
import { resolveMask, usesObjectMask, maskShader, bindMask, MASK_UNIFORM_NAMES } from './post-mask.js';

export { usesObjectMask };

// Named post steps for a graded film: color balance (lift, gamma, gain), glare (streaks and fog glow), lens distortion with
// dispersion, and stylize filters (sharpen, kuwahara, posterize, pixelate). Color balance and stylize take a `mask` (post-mask.js)
// that limits them to named parts or a range of distance. They are optional full-frame stages. The core renderer carries none of their code: a recipe that names one
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

function numberInRange(value, fallback, minimum, maximum, name) {
  const result = value ?? fallback;
  if (!Number.isFinite(result) || result < minimum || result > maximum) throw new RangeError(`${name} must be between ${minimum} and ${maximum}.`);
  return result;
}

const NEUTRAL = Object.freeze({ lift: [0, 0, 0], gamma: [1, 1, 1], gain: [1, 1, 1] });

function groupOf(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object.`);
  return value;
}

function onlyKeys(group, allowed, name) {
  for (const key of Object.keys(group)) {
    if (!allowed.includes(key)) throw new TypeError(`Unknown ${name} field "${key}".`);
  }
}

function triple(value, fallback, minimum, maximum, name) {
  const source = value ?? fallback;
  if (!Array.isArray(source) || source.length !== 3) throw new TypeError(`${name} must be three numbers.`);
  return source.map((component, index) => numberInRange(component, fallback[index], minimum, maximum, `${name}[${index}]`));
}

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
  if (effects.colorBalance !== undefined) resolved.colorBalance = resolveColorBalance(effects.colorBalance);
  if (effects.glare !== undefined) resolved.glare = resolveGlare(effects.glare);
  if (effects.lensDistortion !== undefined) resolved.lensDistortion = resolveLensDistortion(effects.lensDistortion);
  if (effects.stylize !== undefined) resolved.stylize = resolveStylize(effects.stylize);
  return resolved;
}

// Registers what the look needs: the field names it accepts and how to resolve them (src/shader-registry.js).
postStepSupport.fields = ['colorBalance', 'glare', 'lensDistortion', 'stylize'];
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

function createColorBalanceStage() {
  return createStage({
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
  });
}

function isStylizeActive(stylize) {
  return Boolean(stylize) && (stylize.sharpen > 0 || stylize.kuwahara > 0 || stylize.posterize > 0 || stylize.pixelate > 0);
}

function createStylizeStage() {
  return createStage({
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
  });
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
 * Adds glare, lens distortion, color balance and the stylize filters to a renderer, after any depth of field and motion blur it has, in that
 * order. Like them it needs `depth: true`. Each stage runs only for a frame whose effects set it. A step with a `mask` by
 * objects reads the object ID pass: install the render passes and draw that pass before the lit frame (`usesObjectMask` says when).
 */
export function installPostSteps(renderer) {
  if (!renderer.postStages.some(stage => stage.name === 'Glare')) {
    renderer.postStages.push(createGlareStage(), createLensDistortionStage(), createColorBalanceStage(), createStylizeStage());
  }
  return renderer;
}
