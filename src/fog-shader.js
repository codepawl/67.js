import { registerShaderFeatureCode } from './shader-registry.js';
import { FogFieldTexture, createFogLightBuffers, packFogLights, volumeShadowAmbient, DEFAULT_FLOW_STRENGTH, DEFAULT_FLOW_PERIOD } from './fog-field.js';

// The volume fog step of the post pass: its uniforms and the march that scatters light through the fog box. Only a renderer that
// draws a frame with environment.volumeFog needs this module; post.js gives every other post program a stub. It reads hash and
// cloudNoise from the post shader. Recipes and the film load it by themselves.

function bindUniforms(renderer, post, volume, environment, frame) {
  const context = renderer.context;
  context.activeTexture(context.TEXTURE3);
  context.bindTexture(context.TEXTURE_2D, renderer.shadowTexture);
  context.uniform1i(post.uniforms.volumeShadowMap, 3);
  context.uniformMatrix4fv(post.uniforms.volumeLightProjection, false, renderer.lightProjection);
  context.uniform3fv(post.uniforms.volumeLightDirection, environment.lightDirection);
  context.uniform3fv(post.uniforms.volumeLightColor, renderer.lighting.keyColor);
  context.uniform1f(post.uniforms.volumeDensity, volume.density);
  context.uniform3fv(post.uniforms.volumeMinimum, volume.minimum);
  context.uniform3fv(post.uniforms.volumeMaximum, volume.maximum);
  context.uniform3fv(post.uniforms.volumeColor, volume.color);
  context.uniform3fv(post.uniforms.volumeAmbient, volume.ambient);
  context.uniform3fv(post.uniforms.volumeDrift, volume.drift);
  context.uniform1i(post.uniforms.volumeSteps, volume.steps);
  context.uniform1f(post.uniforms.volumeAnisotropy, volume.anisotropy);
  context.uniform1f(post.uniforms.volumeShadowAmbient, volumeShadowAmbient(volume, renderer.sceneParts, renderer.skyOpenness));
  context.uniform1f(post.uniforms.volumeNoiseAmount, volume.noiseAmount);
  context.uniform1f(post.uniforms.volumeNoiseScale, volume.noiseScale);
  context.uniform1f(post.uniforms.volumeMaxDistance, volume.maxDistance);
  context.uniform1f(post.uniforms.volumeHeightFalloff, volume.heightFalloff);
  bindFieldAndLights(renderer, post, volume);
  context.uniform1f(post.uniforms.orthographic, frame.projection === 'orthographic' ? 1 : 0);
  context.uniform1i(post.uniforms.fogSkyVisibility, 5);
  context.uniform1f(post.uniforms.volumeGridFog, renderer.sceneParts.some(part => part.material?.irradianceGrid) ? 1 : 0);
}

// The fog's field texture and light buffers; a program without those steps has no such uniforms, and a null location is ignored.
function bindFieldAndLights(renderer, post, volume) {
  const context = renderer.context;
  if (volume.field) {
    renderer.fogFieldTexture ??= new FogFieldTexture(context);
    context.activeTexture(context.TEXTURE6);
    renderer.fogFieldTexture.upload(volume.field);
    context.uniform1i(post.uniforms.volumeField, 6);
    context.uniform1f(post.uniforms.volumeProfile, volume.profile === 'smoothstep' ? 1 : 0);
    context.uniform1f(post.uniforms.volumeFlowStrength, volume.flowStrength ?? DEFAULT_FLOW_STRENGTH);
    context.uniform1f(post.uniforms.volumeFlowPeriod, volume.flowPeriod ?? DEFAULT_FLOW_PERIOD);
  }
  const lights = renderer.fogLightBuffers;
  context.uniform1i(post.uniforms.volumeLightCount, lights.count);
  if (lights.count === 0) return;
  context.uniform4fv(post.uniforms['volumeLightPositions[0]'], lights.positions);
  context.uniform4fv(post.uniforms['volumeLightColors[0]'], lights.colors);
  context.uniform4fv(post.uniforms['volumeLightDirections[0]'], lights.directions);
  context.uniform4fv(post.uniforms['volumeLightCones[0]'], lights.cones);
}

function packLights(renderer) {
  renderer.fogLightBuffers ??= createFogLightBuffers();
  packFogLights(renderer.lighting, renderer.fogLightBuffers);
}

registerShaderFeatureCode('volumeFog', {
  // The JavaScript half, which the renderer calls for a frame that draws a volume fog.
  support: { packLights, bindUniforms },
  postDeclarations: `
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
`,
  postFunctions: `
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
`,
});
