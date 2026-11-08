import { registeredFeatureCode } from './shader-registry.js';

export { fullscreenVertex } from './gl-program.js';

function postFragmentSource(definitions, explosionFunction) {
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
uniform highp sampler2DShadow volumeShadowMap;
uniform mat4 volumeLightProjection;
uniform vec3 volumeLightDirection;
uniform vec3 volumeLightColor;
uniform float volumeDensity;
uniform vec3 volumeMinimum;
uniform vec3 volumeMaximum;
uniform vec3 volumeColor;
uniform vec3 volumeAmbient;
uniform vec3 volumeDrift;
uniform int volumeSteps;
uniform float volumeAnisotropy;
uniform float volumeShadowAmbient;
uniform float volumeGridFog; // 1 when an irradiance grid lights the fog: the ambient then stands for the sky only
uniform float volumeNoiseAmount;
uniform float volumeNoiseScale;
uniform float volumeMaxDistance;
uniform float volumeHeightFalloff;
uniform sampler2D volumeField;
uniform float volumeProfile;
uniform float volumeFlowStrength;
uniform float volumeFlowPeriod;
uniform int volumeLightCount;
uniform vec4 volumeLightPositions[8];
uniform vec4 volumeLightColors[8];
uniform vec4 volumeLightDirections[8];
uniform vec4 volumeLightCones[8];
uniform float orthographic;
uniform highp sampler3D fogSkyVisibility;
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
float henyeyGreenstein(float cosine, float anisotropy) {
  return (1.0 - anisotropy * anisotropy) / (12.5663706 * pow(1.0 + anisotropy * anisotropy - 2.0 * anisotropy * cosine, 1.5));
}
float fogLightAttenuation(float distanceSquared, float range, float radius) {
  float cutoff = 1.0;
  if (range > 0.0) {
    float squaredRatio = distanceSquared / (range * range);
    float fade = max(1.0 - squaredRatio * squaredRatio, 0.0);
    cutoff = fade * fade;
  }
  return cutoff / max(distanceSquared, radius * radius);
}
vec3 fogLightScattering(vec3 position, vec3 direction) {
  vec3 total = vec3(0);
  for (int index = 0; index < 8; index++) {
    if (index >= volumeLightCount) break;
    vec3 offset = volumeLightPositions[index].xyz - position;
    float distanceSquared = dot(offset, offset);
    if (distanceSquared < 1e-12) continue;
    vec3 toLight = offset * inversesqrt(distanceSquared);
    float attenuation = fogLightAttenuation(distanceSquared, volumeLightPositions[index].w, volumeLightColors[index].w);
    if (volumeLightCones[index].y > 0.5) attenuation *= smoothstep(volumeLightDirections[index].w, volumeLightCones[index].x, dot(-toLight, volumeLightDirections[index].xyz));
    if (attenuation <= 0.0) continue;
    float denominator = 1.0 + volumeAnisotropy * volumeAnisotropy - 2.0 * volumeAnisotropy * dot(direction, toLight);
    total += volumeLightColors[index].rgb * (attenuation * (1.0 - volumeAnisotropy * volumeAnisotropy) / (12.5663706 * denominator * sqrt(denominator)));
  }
  return total;
}
float flowedNoise(vec3 samplePosition, vec2 velocity) {
  float firstPhase = fract(time / volumeFlowPeriod);
  float secondPhase = fract(time / volumeFlowPeriod + 0.5);
  vec3 travel = vec3(velocity.x, 0.0, velocity.y) * volumeFlowStrength * volumeFlowPeriod;
  float first = cloudNoise((samplePosition - travel * firstPhase) * volumeNoiseScale);
  float second = cloudNoise((samplePosition - travel * secondPhase) * volumeNoiseScale);
  return mix(first, second, abs(2.0 * firstPhase - 1.0));
}
float layerProfile(float relativeHeight) {
  return volumeProfile > 0.5 ? 1.0 - smoothstep(0.5, 1.0, relativeHeight) : exp(-relativeHeight);
}
vec3 volumeFog(vec3 background) {
  vec2 clipXY = textureCoordinate * 2.0 - 1.0;
  vec4 farPoint = inverseViewProjection * vec4(clipXY, 1.0, 1.0);
  vec4 nearPoint = inverseViewProjection * vec4(clipXY, -1.0, 1.0);
  vec3 origin = orthographic > 0.5 ? nearPoint.xyz / nearPoint.w : eye;
  vec3 direction = normalize(farPoint.xyz - origin * farPoint.w);
  float depth = texture(sceneDepth, textureCoordinate).r;
  vec4 surfacePoint = inverseViewProjection * vec4(clipXY, depth * 2.0 - 1.0, 1.0);
  float surfaceDistance = volumeMaxDistance;
  if (surfacePoint.w > 0.0) surfaceDistance = max(0.0, dot(surfacePoint.xyz - origin * surfacePoint.w, direction) / surfacePoint.w);
  float exitDistance = min(volumeMaxDistance, surfaceDistance);
  float entry = 0.0;
  for (int axis = 0; axis < 3; axis++) {
    if (direction[axis] == 0.0) {
      if (origin[axis] < volumeMinimum[axis] || origin[axis] > volumeMaximum[axis]) return background;
    } else {
      float first = (volumeMinimum[axis] - origin[axis]) / direction[axis];
      float second = (volumeMaximum[axis] - origin[axis]) / direction[axis];
      entry = max(entry, min(first, second));
      exitDistance = min(exitDistance, max(first, second));
    }
  }
  if (entry >= exitDistance) return background;
  float stepSize = (exitDistance - entry) / float(volumeSteps);
  vec3 lightDirection = normalize(volumeLightDirection);
  float cosine = dot(direction, lightDirection);
  float anisotropy = volumeAnisotropy;
  float phase = henyeyGreenstein(cosine, anisotropy);
  float jitter = hash(vec3(gl_FragCoord.xy, 0));
  float transmittance = 1.0;
  vec3 accumulated = vec3(0);
  for (int index = 0; index < 48; index++) {
    if (index >= volumeSteps) break;
    vec3 position = origin + direction * (entry + (float(index) + jitter) * stepSize);
    float noise = 1.0;
    vec4 field = POST_FIELD ? texture(volumeField, (position.xz - volumeMinimum.xz) / (volumeMaximum.xz - volumeMinimum.xz)) : vec4(1);
    if (volumeNoiseAmount > 0.0) {
      float lookup = POST_FIELD ? flowedNoise(position - volumeDrift * time, field.zw) : cloudNoise((position - volumeDrift * time) * volumeNoiseScale);
      noise = mix(1.0, lookup * 2.0, volumeNoiseAmount);
    }
    if (POST_FIELD) noise *= field.r * layerProfile((position.y - volumeMinimum.y) / max(field.g, 0.0001));
    else if (volumeHeightFalloff > 0.0) noise *= exp((volumeMinimum.y - position.y) / volumeHeightFalloff);
    float opacity = 1.0 - exp(-volumeDensity * noise * stepSize);
    vec4 lightPosition = volumeLightProjection * vec4(position, 1);
    vec3 shadow = lightPosition.xyz / lightPosition.w * 0.5 + 0.5;
    float visibility = 1.0;
    if (all(greaterThanEqual(shadow, vec3(0))) && all(lessThanEqual(shadow, vec3(1)))) {
      visibility = texture(volumeShadowMap, vec3(shadow.xy, shadow.z - 0.0008));
    }
    vec4 skyCell = POST_SKY ? texture(fogSkyVisibility, (position - volumeMinimum) / (volumeMaximum - volumeMinimum)) : vec4(0);
    float shadowShare = POST_SKY ? 0.1 + 0.9 * min(1.0, 30.0 * skyCell.r) : volumeShadowAmbient;
    float ambientShare = mix(shadowShare, 1.0, visibility);
    if (volumeGridFog > 0.5) ambientShare = min(1.0, 30.0 * skyCell.r);
    vec3 scattering = volumeColor * (volumeAmbient * ambientShare + volumeLightColor * phase * visibility + 0.6 * skyCell.gba);
    if (POST_LIGHTS) scattering += volumeColor * fogLightScattering(position, direction);
    accumulated += transmittance * opacity * scattering;
    transmittance *= 1.0 - opacity;
    if (transmittance < 0.001) break;
  }
  for (int tap = 0; tap < 24; tap++) {
    float index = float(tap) + 0.5;
    float radius = 0.03 + 0.0002 * index * index;
    vec2 offset = vec2(cos(index * 2.4) * resolution.y / resolution.x, sin(index * 2.4)) * radius;
    accumulated += textureLod(frameTexture, textureCoordinate + offset, log2(0.7 * radius * resolution.y)).rgb * volumeColor * (0.009 * (1.0 - transmittance) / (1.0 + 0.04 * index));
  }
  return accumulated + background * transmittance;
}
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
  lights: ['POST_LIGHTS', 'volumeLightCount > 0'],
  explosion: ['POST_EXPLOSION', 'volumeExplosion > 0.5'],
  finish: ['POST_FINISH', 'true'],
};

// The sky, field and lights steps are left out: the program with every step is the one a frame draws while a variant builds,
// and it has no fog sky grid, no fog field and no fog lights.
// The explosion step is left out too, because its code loads from explosion-shader.js only for a renderer that draws it.
export const POST_STEPS = Object.freeze(Object.keys(POST_STEP_CONDITIONS).filter(step => !['sky', 'field', 'lights', 'explosion'].includes(step)));

const EXPLOSION_STUB = 'vec3 explosion(vec3 background) { return background; }';

function explosionFunctionFor(enabledSteps) {
  if (!enabledSteps.has('explosion')) return EXPLOSION_STUB;
  const code = registeredFeatureCode.get('explosion');
  if (!code) throw new Error("The explosion step needs its shader code: add import './explosion-shader.js' (the film player does).");
  return code.post;
}

/** The post pass with only the listed steps compiled in; every step is switched by its uniform, as before. */
export function createPostFragment(steps = POST_STEPS) {
  const enabled = new Set(steps);
  const definitions = Object.entries(POST_STEP_CONDITIONS)
    .map(([step, [macro, condition]]) => `#define ${macro} ${enabled.has(step) ? `(${condition})` : 'false'}`)
    .join('\n');
  return postFragmentSource(definitions, explosionFunctionFor(enabled));
}

export const postFragment = createPostFragment();
