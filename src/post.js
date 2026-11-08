import { registeredFeatureCode, requireFeatureCode } from './shader-registry.js';

export { fullscreenVertex } from './gl-program.js';

function postFragmentSource(definitions, explosionFunction, fogDeclarations, fogFunctions) {
  return `#version 300 es
${definitions}
precision highp float;
in vec2 textureCoordinate;
uniform sampler2D frameTexture;
uniform float transparent;
uniform sampler2D bloomTexture;
uniform float bloomStrength;
uniform float hdrEnabled;
uniform vec3 grade;
uniform float vignette;
uniform float grainAmount;
uniform vec2 resolution;
uniform float monochrome;
uniform float fade;
uniform float cinematic;
uniform float time;
uniform float volumeExplosion;
uniform float explosionProgress;
uniform mat4 inverseViewProjection;
uniform vec3 eye;
uniform sampler2D sceneDepth;
${fogDeclarations}
uniform sampler2D occlusionTexture;
uniform float occlusionStrength;
uniform vec2 occlusionTexel;
out vec4 outputColor;
float luminance(vec3 color) { return dot(color, vec3(0.299, 0.587, 0.114)); }
float hash(vec3 position) { return fract(sin(dot(position, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
float cloudNoise(vec3 position) {
  vec3 cell = floor(position);
  vec3 fraction = fract(position);
  fraction = fraction * fraction * (3.0 - 2.0 * fraction);
  float lower = mix(mix(hash(cell), hash(cell + vec3(1,0,0)), fraction.x), mix(hash(cell + vec3(0,1,0)), hash(cell + vec3(1,1,0)), fraction.x), fraction.y);
  float upper = mix(mix(hash(cell + vec3(0,0,1)), hash(cell + vec3(1,0,1)), fraction.x), mix(hash(cell + vec3(0,1,1)), hash(cell + vec3(1,1,1)), fraction.x), fraction.y);
  return mix(lower, upper, fraction.z);
}
${explosionFunction}
${fogFunctions}
void main() {
  vec2 texel = 1.0 / resolution;
  vec3 center = texture(frameTexture, textureCoordinate).rgb;
  vec3 northwest = texture(frameTexture, textureCoordinate + vec2(-1.0, -1.0) * texel).rgb;
  vec3 northeast = texture(frameTexture, textureCoordinate + vec2(1.0, -1.0) * texel).rgb;
  vec3 southwest = texture(frameTexture, textureCoordinate + vec2(-1.0, 1.0) * texel).rgb;
  vec3 southeast = texture(frameTexture, textureCoordinate + vec2(1.0, 1.0) * texel).rgb;
  float centerLuma = luminance(center);
  float northwestLuma = luminance(northwest);
  float northeastLuma = luminance(northeast);
  float southwestLuma = luminance(southwest);
  float southeastLuma = luminance(southeast);
  float minimumLuma = min(centerLuma, min(min(northwestLuma, northeastLuma), min(southwestLuma, southeastLuma)));
  float maximumLuma = max(centerLuma, max(max(northwestLuma, northeastLuma), max(southwestLuma, southeastLuma)));
  vec2 direction = vec2(-((northwestLuma + northeastLuma) - (southwestLuma + southeastLuma)), (northwestLuma + southwestLuma) - (northeastLuma + southeastLuma));
  float reduction = max((northwestLuma + northeastLuma + southwestLuma + southeastLuma) * 0.03125, 0.0078125);
  direction = clamp(direction / (min(abs(direction.x), abs(direction.y)) + reduction), vec2(-6.0), vec2(6.0)) * texel;
  vec3 first = 0.5 * (texture(frameTexture, textureCoordinate + direction * (-1.0 / 6.0)).rgb + texture(frameTexture, textureCoordinate + direction * (1.0 / 6.0)).rgb);
  vec3 second = first * 0.5 + 0.25 * (texture(frameTexture, textureCoordinate - direction * 0.5).rgb + texture(frameTexture, textureCoordinate + direction * 0.5).rgb);
  float secondLuma = luminance(second);
  vec3 color = secondLuma < minimumLuma || secondLuma > maximumLuma ? first : second;
  if (maximumLuma - minimumLuma < max(0.03, maximumLuma * 0.125)) color = center;
  float coverage = POST_TRANSPARENT ? texture(frameTexture, textureCoordinate).a : 1.0;
  if (POST_TRANSPARENT) color = center / max(coverage, 0.00001);
  if (POST_OCCLUSION) {
    float visibility = 0.0;
    for (int row = -1; row <= 1; row++) {
      for (int column = -1; column <= 1; column++) {
        visibility += texture(occlusionTexture, textureCoordinate + vec2(float(column), float(row)) * occlusionTexel).r;
      }
    }
    // Occlusion belongs to indirect light, so pixels already bright from direct light keep less of it.
    float directShare = 1.0 / (1.0 + 0.4 * luminance(color));
    color *= mix(1.0, visibility / 9.0, occlusionStrength * directShare);
  }
  if (POST_BLOOM) color += texture(bloomTexture, textureCoordinate).rgb * bloomStrength;
  if (POST_VOLUME) color = volumeFog(color);
  if (hdrEnabled > 0.5) {
    color = clamp((color * (2.51 * color + 0.03)) / (color * (2.43 * color + 0.59) + 0.14), 0.0, 1.0);
    color = pow(color, vec3(1.0 / 2.2));
  }
  if (POST_EXPLOSION) color = explosion(color);
  if (POST_FINISH) {
  color = mix(color, vec3(luminance(color)), monochrome);
  if (grade.x != 1.0) color = mix(vec3(luminance(color)), color, grade.x);
  if (grade.y != 1.0) color = (color - 0.5) * grade.y + 0.5;
  if (grade.z != 0.0) color *= vec3(1.0 + grade.z * 0.1, 1.0, 1.0 - grade.z * 0.1);
  vec2 centered = textureCoordinate * 2.0 - 1.0;
  color *= max(0.0, 1.0 - (cinematic * 0.20 + vignette) * dot(centered, centered));
  float grain = fract(sin(dot(gl_FragCoord.xy + floor(time * 24.0), vec2(12.9898, 78.233))) * 43758.5453) - 0.5;
  color += grain * (0.018 * cinematic + grainAmount);
  }
  float alpha = POST_TRANSPARENT ? coverage : 1.0;
  outputColor = vec4(color * (1.0 - fade) * alpha, alpha);
}`;
}

export const skyFragment = `#version 300 es
precision highp float;
in vec2 textureCoordinate;
uniform vec3 skyTop;
uniform vec3 skyBottom;
uniform vec3 sunDirection;
uniform mat4 inverseViewProjection;
uniform vec3 eye;
uniform float time;
uniform float daylight;
uniform float hdrEnabled;
out vec4 outputColor;
float noise(vec2 position) {
  return sin(position.x * 2.1 + sin(position.y * 1.3)) * 0.5 + sin(position.y * 2.8 - position.x * 0.8) * 0.3;
}
void main() {
  vec4 world = inverseViewProjection * vec4(textureCoordinate * 2.0 - 1.0, 1.0, 1.0);
  vec3 direction = normalize(world.xyz / world.w - eye);
  float height = clamp(direction.y * 1.3 + 0.12, 0.0, 1.0);
  vec3 color = mix(skyBottom, skyTop, pow(height, 0.6));
  float sun = max(dot(direction, normalize(sunDirection)), 0.0);
  color += vec3(1.0, 0.72, 0.35) * pow(sun, 300.0) * 0.7 * daylight;
  color += vec3(0.30, 0.22, 0.12) * pow(sun, 8.0) * daylight;
  vec2 cloudPosition = direction.xz / max(0.08, direction.y) * 0.5 + vec2(time * 0.006, 0.0);
  float cloud = smoothstep(0.1, 0.55, noise(cloudPosition) + noise(cloudPosition * 2.4) * 0.25);
  cloud *= smoothstep(0.02, 0.22, direction.y) * (1.0 - smoothstep(0.5, 0.95, direction.y));
  color = mix(color, mix(skyBottom, vec3(0.94, 0.93, 0.85), 0.7), cloud * 0.28 * daylight);
  outputColor = vec4(hdrEnabled > 0.5 ? pow(max(color, vec3(0)), vec3(2.2)) : color, 1.0);
}`;

export const bloomFragment = `#version 300 es
precision highp float;
in vec2 textureCoordinate;
uniform sampler2D sourceTexture;
uniform vec2 texelDirection;
uniform float threshold;
uniform float extract;
out vec4 outputColor;
vec3 sampleBloom(vec2 coordinate) {
  vec3 color = texture(sourceTexture, coordinate).rgb;
  if (extract > 0.5) {
    float peak = max(color.r, max(color.g, color.b));
    color *= max(peak - threshold, 0.0) / max(peak, 0.00001);
  }
  return color;
}
void main() {
  vec3 color = sampleBloom(textureCoordinate) * 0.227027;
  color += sampleBloom(textureCoordinate + texelDirection * 1.384615) * 0.316216;
  color += sampleBloom(textureCoordinate - texelDirection * 1.384615) * 0.316216;
  color += sampleBloom(textureCoordinate + texelDirection * 3.230769) * 0.070270;
  color += sampleBloom(textureCoordinate - texelDirection * 3.230769) * 0.070270;
  outputColor = vec4(color, 1.0);
}`;

// Every optional step of the post pass, with the GLSL condition that turns it on. SwiftShader pays for a step that a
// uniform switches off, so a frame that uses few steps draws with a program that has the others compiled out.
const POST_STEP_CONDITIONS = {
  transparent: ['POST_TRANSPARENT', 'transparent > 0.5'],
  occlusion: ['POST_OCCLUSION', 'occlusionStrength > 0.0'],
  bloom: ['POST_BLOOM', 'bloomStrength > 0.0'],
  volume: ['POST_VOLUME', 'volumeDensity > 0.0'],
  sky: ['POST_SKY', 'true'],
  field: ['POST_FIELD', 'true'],
  detail: ['POST_DETAIL', 'true'],
  lights: ['POST_LIGHTS', 'volumeLightCount > 0'],
  explosion: ['POST_EXPLOSION', 'volumeExplosion > 0.5'],
  finish: ['POST_FINISH', 'true'],
};

// The program with every step is the one a frame draws while a variant builds. It leaves out the steps below: the fog sky grid,
// field and lights exist only inside a fog, and the volume fog and explosion code load from fog-shader.js and explosion-shader.js
// only for a renderer that draws them.
export const POST_STEPS_WITH_OPTIONAL_CODE = Object.freeze(['volume', 'sky', 'field', 'detail', 'lights', 'explosion']);
export const POST_STEPS = Object.freeze(Object.keys(POST_STEP_CONDITIONS).filter(step => !POST_STEPS_WITH_OPTIONAL_CODE.includes(step)));

const EXPLOSION_STUB = 'vec3 explosion(vec3 background) { return background; }';
const VOLUME_FOG_STUB = 'vec3 volumeFog(vec3 background) { return background; }';

function explosionFunctionFor(enabledSteps) {
  if (!enabledSteps.has('explosion')) return EXPLOSION_STUB;
  const code = registeredFeatureCode.get('explosion');
  if (!code) throw new Error("The explosion step needs its shader code: add import './explosion-shader.js' (the film player does).");
  return code.post;
}

function fogCodeFor(enabledSteps) {
  if (!enabledSteps.has('volume')) return { declarations: '', functions: VOLUME_FOG_STUB };
  const code = requireFeatureCode('volumeFog');
  return { declarations: code.postDeclarations, functions: code.postFunctions };
}

/** The post pass with only the listed steps compiled in; every step is switched by its uniform, as before. */
export function createPostFragment(steps = POST_STEPS) {
  const enabled = new Set(steps);
  const definitions = Object.entries(POST_STEP_CONDITIONS)
    .map(([step, [macro, condition]]) => `#define ${macro} ${enabled.has(step) ? `(${condition})` : 'false'}`)
    .join('\n');
  const fogCode = fogCodeFor(enabled);
  return postFragmentSource(definitions, explosionFunctionFor(enabled), fogCode.declarations, fogCode.functions);
}

export const postFragment = createPostFragment();
