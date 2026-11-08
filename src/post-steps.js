import { postStepSupport } from './shader-registry.js';
import { createStage, sharedFragmentHeader } from './camera-effects.js';

// Named post steps for a graded film: color balance (lift, gamma, gain), glare (streaks and fog glow), lens distortion with
// dispersion. They are optional full-frame stages. The core renderer carries none of their code: a recipe that names one
// loads this module (agent-scene-modules.js), and each stage compiles only on the first frame that turns it on. Defocus from
// depth is the `depthOfField` group of camera-effects.js, which is the same step under its older name.
//
// All three are deterministic: fixed sample patterns and no history, so a seek repeats the same pixels.

const STREAK_DIRECTIONS = 4;
const STREAK_STEPS = 12;
const FOG_SAMPLES = 32;
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
  onlyKeys(group, ['lift', 'gamma', 'gain'], 'colorBalance');
  return {
    lift: triple(group.lift, NEUTRAL.lift, -1, 1, 'colorBalance.lift'),
    gamma: triple(group.gamma, NEUTRAL.gamma, 0.1, 4, 'colorBalance.gamma'),
    gain: triple(group.gain, NEUTRAL.gain, 0, 4, 'colorBalance.gain'),
  };
}

function resolveGlare(input) {
  const group = groupOf(input, 'glare');
  onlyKeys(group, ['streaks', 'fogGlow', 'threshold', 'size'], 'glare');
  return {
    streaks: numberInRange(group.streaks, 0, 0, 1, 'glare.streaks'),
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
  return resolved;
}

// Registers what the look needs: the field names it accepts and how to resolve them (src/shader-registry.js).
postStepSupport.fields = ['colorBalance', 'glare', 'lensDistortion'];
postStepSupport.resolve = resolvePostSteps;

export const colorBalanceFragment = `${sharedFragmentHeader}
uniform vec3 lift;
uniform vec3 inverseGamma;
uniform vec3 gain;
void main() {
  vec4 source = texture(sourceTexture, textureCoordinate);
  // Lift raises the shadows and fades out toward white, gain scales the highlights, gamma bends the midtones.
  vec3 graded = source.rgb * gain + lift * (1.0 - clamp(source.rgb, 0.0, 1.0));
  outputColor = vec4(pow(max(graded, vec3(0.0)), inverseGamma), source.a);
}`;

export const glareFragment = `${sharedFragmentHeader}
uniform float streakAmount;
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
    for (int direction = 0; direction < ${STREAK_DIRECTIONS}; direction++) {
      float angle = 0.7853982 + float(direction) * 1.5707963;
      vec2 step = vec2(cos(angle), sin(angle)) * sizePixels / ${STREAK_STEPS}.0 / resolution;
      for (int index = 1; index <= ${STREAK_STEPS}; index++) {
        float along = float(index) - jitter;
        float weight = 1.0 - along / (${STREAK_STEPS}.0 + 1.0);
        streaks += (brightPart(textureCoordinate + step * along, 0.0) + brightPart(textureCoordinate - step * along, 0.0)) * weight * weight;
      }
    }
    glow += streaks * streakAmount / ${STREAK_STEPS}.0;
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
    uniformNames: ['lift', 'inverseGamma', 'gain'],
    isActive: (effects, frame) => isColorBalanceActive(stepsOf(frame).colorBalance),
    setUniforms(context, uniforms, renderer, frame) {
      const { colorBalance } = stepsOf(frame);
      context.uniform3fv(uniforms.lift, colorBalance.lift);
      context.uniform3fv(uniforms.inverseGamma, colorBalance.gamma.map(gamma => 1 / gamma));
      context.uniform3fv(uniforms.gain, colorBalance.gain);
    },
  });
}

function createGlareStage() {
  const stage = createStage({
    name: 'Glare',
    fragment: glareFragment,
    uniformNames: ['streakAmount', 'fogAmount', 'threshold', 'sizePixels', 'fogLod'],
    isActive: (effects, frame) => {
      const { glare } = stepsOf(frame);
      return Boolean(glare) && (glare.streaks > 0 || glare.fogGlow > 0);
    },
    setUniforms(context, uniforms, renderer, frame) {
      const { glare } = stepsOf(frame);
      context.uniform1f(uniforms.streakAmount, glare.streaks);
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
 * Adds glare, lens distortion and color balance to a renderer, after any depth of field and motion blur it has, in that
 * order. Like them it needs `depth: true`. Each stage runs only for a frame whose effects set it.
 */
export function installPostSteps(renderer) {
  if (!renderer.postStages.some(stage => stage.name === 'Glare')) {
    renderer.postStages.push(createGlareStage(), createLensDistortionStage(), createColorBalanceStage());
  }
  return renderer;
}
