import { registerShaderFeatureCode } from './shader-registry.js';
import { resolveLocalVolumes, createLocalVolumeBuffers, packLocalVolumes, LOCAL_VOLUME_KEY_GAIN, LOCAL_VOLUME_SHADOW_STRENGTH, LOCAL_VOLUME_SKY_GAIN, LOCAL_VOLUME_SUN_FLATTEN } from './local-volumes.js';
import { bindLocalVolumeParts } from './local-volume-parts.js';
import { drawMeshVolumes } from './mesh-volume-pass.js';
import { FogFieldTexture, createFogLightBuffers, packFogLights, volumeShadowAmbient, DEFAULT_FLOW_STRENGTH, DEFAULT_FLOW_PERIOD, resolveFogDetail, fogUsesDetail } from './fog-field.js';

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
  bindDetail(context, post, volume);
  context.uniform1f(post.uniforms.orthographic, frame.projection === 'orthographic' ? 1 : 0);
  context.uniform1i(post.uniforms.fogSkyVisibility, 5);
  context.uniform1f(post.uniforms.volumeGridFog, renderer.sceneParts.some(part => part.material?.irradianceGrid) ? 1 : 0);
}

// Detail, layer top and key light controls. The detail ones only act in a program with the detail step compiled in (fogUsesDetail).
function bindDetail(context, post, volume) {
  const detail = resolveFogDetail(volume);
  // The renderer's post uniform list knows only the older fields; these locations are looked up here, once per program.
  const locate = name => (post.uniforms[name] ??= context.getUniformLocation(post.program, name));
  context.uniform1i(locate('volumeDetailOctaves'), detail.detailOctaves);
  context.uniform1f(locate('volumeDetailAmount'), detail.detailAmount);
  context.uniform1f(locate('volumeWarp'), detail.warp);
  context.uniform1f(locate('volumeContrast'), detail.contrast);
  context.uniform1f(locate('volumeProfileStart'), detail.profileSoftness);
  context.uniform1f(locate('volumeKeyScattering'), detail.keyScattering);
  context.uniform1i(locate('volumeScatterOctaves'), detail.scatterOctaves);
  context.uniform1f(locate('volumeMultiScatter'), detail.multiScatter);
  context.uniform1f(locate('volumeMultiExtinction'), detail.multiExtinction);
  context.uniform1f(locate('volumeMultiAnisotropy'), detail.multiAnisotropy);
  context.uniform1f(locate('volumeKeyTransmittance'), detail.keyTransmittance);
  context.uniform1f(locate('volumeSurfaceTransmittance'), detail.surfaceTransmittance);
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

// The local volumes of the frame (environment.localVolumes), checked and packed once before the post program is chosen, so a bad
// field or a renderer without depth or HDR throws before any program is bound. Returns the count packed, or 0 for an empty list.
function prepareLocalVolumes(renderer, input, frame) {
  const resolved = resolveLocalVolumes(input, 'environment.localVolumes');
  if (resolved.length === 0) return 0;
  if (!renderer.depth || !renderer.hdr || renderer.transparent || renderer.benchmark) throw new Error('Local volumes require depth:true, active HDR and an opaque canvas');
  const buffers = (renderer.localVolumeBuffers ??= createLocalVolumeBuffers());
  packLocalVolumes(bindLocalVolumeParts(resolved, renderer.sceneParts), buffers);
  drawMeshVolumes(renderer, frame);
  return buffers.count;
}

// Uploads the packed volumes. Their uniforms exist only in a program with the local step compiled in.
function bindLocalVolumes(renderer, post, frame, environment) {
  const context = renderer.context;
  const buffers = renderer.localVolumeBuffers;
  const locate = name => (post.uniforms[name] ??= context.getUniformLocation(post.program, name));
  bindKeyLight(renderer, locate, environment);
  context.uniform1i(locate('localVolumeCount'), buffers.count);
  context.uniform1f(locate('localOrthographic'), frame.projection === 'orthographic' ? 1 : 0);
  context.uniform4fv(locate('localVolumeCenters[0]'), buffers.centers);
  context.uniform4fv(locate('localVolumeExtents[0]'), buffers.extents);
  context.uniform4fv(locate('localVolumeAbsorption[0]'), buffers.absorption);
  context.uniform4fv(locate('localVolumeEmission[0]'), buffers.emission);
  context.uniform4fv(locate('localVolumeSteps[0]'), buffers.steps);
  context.uniform4fv(locate('localVolumeAxes[0]'), buffers.axes);
  // The sampler always gets a texture of its own type, so the program is valid in a frame with no mesh volume.
  context.activeTexture(context.TEXTURE7);
  context.bindTexture(context.TEXTURE_2D, buffers.meshParts.length > 0 ? renderer.meshVolumePass.target.texture : renderer.whiteTexture);
  context.uniform1i(locate('localMeshVolumes'), 7);
}

// The renderer's own sky gradient when a scene names none; drawSky in renderer.js holds the same two colours.
const DEFAULT_SKY_TOP = [0.20, 0.38, 0.52];
const DEFAULT_SKY_BOTTOM = [0.62, 0.70, 0.67];

// The sky term of a scattering local volume: the mean of the sky gradient times the ambient intensity.
function localSkyAmbient(renderer, environment) {
  const top = environment.skyTop ?? DEFAULT_SKY_TOP;
  const bottom = environment.skyBottom ?? DEFAULT_SKY_BOTTOM;
  return [0, 1, 2].map(channel => 0.5 * (top[channel] + bottom[channel]) * renderer.lighting.ambientIntensity);
}

// The key light's shadow map, direction and colour, and the sky term, for volumes that scatter. The sampler always has the shadow map
// on its unit, so the program is valid in a frame where no volume scatters.
function bindKeyLight(renderer, locate, environment) {
  const context = renderer.context;
  if (renderer.shadowTexture) {
    context.activeTexture(context.TEXTURE3);
    context.bindTexture(context.TEXTURE_2D, renderer.shadowTexture);
  }
  context.uniform1i(locate('volumeShadowMap'), 3);
  context.uniformMatrix4fv(locate('volumeLightProjection'), false, renderer.lightProjection);
  context.uniform3fv(locate('volumeLightDirection'), environment.lightDirection);
  context.uniform3fv(locate('volumeLightColor'), renderer.lighting.keyColor);
  context.uniform3fv(locate('localSkyAmbient'), localSkyAmbient(renderer, environment));
}

const LOCAL_VOLUME_DECLARATIONS = `
uniform int localVolumeCount;
uniform float localOrthographic;
uniform vec4 localVolumeCenters[8];
uniform vec4 localVolumeExtents[8];
uniform vec4 localVolumeAbsorption[8];
uniform vec4 localVolumeEmission[8];
uniform vec4 localVolumeSteps[8];
uniform vec4 localVolumeAxes[24];
uniform vec3 localSkyAmbient;
uniform highp sampler2D localMeshVolumes;
`;

// Each volume is marched on its own between its entry and exit (cut at the first surface) and composited nearest first: the colour
// behind it is dimmed by exp(-absorption * profile * step) and its emission is added, both per colour channel.
const LOCAL_VOLUME_FUNCTIONS = `
// Value noise on a hash of plain multiplies, adds and fract, which rounds the same way on SwiftShader, where it was measured, and is unchecked on hardware GPUs (a sine hash does not: its error
// grows with the argument). local-volume-noise.js repeats it for the CPU path tracer, so keep the two in step.
float localVolumeCellHash(vec3 cell) {
  vec3 scrambled = fract(cell * 0.1031);
  scrambled += dot(scrambled, scrambled.zyx + 31.32);
  return fract((scrambled.x + scrambled.y) * scrambled.z);
}
float localVolumeNoise(vec3 position) {
  vec3 cell = floor(position);
  vec3 fraction = fract(position);
  fraction = fraction * fraction * (3.0 - 2.0 * fraction);
  float lower = mix(mix(localVolumeCellHash(cell), localVolumeCellHash(cell + vec3(1,0,0)), fraction.x), mix(localVolumeCellHash(cell + vec3(0,1,0)), localVolumeCellHash(cell + vec3(1,1,0)), fraction.x), fraction.y);
  float upper = mix(mix(localVolumeCellHash(cell + vec3(0,0,1)), localVolumeCellHash(cell + vec3(1,0,1)), fraction.x), mix(localVolumeCellHash(cell + vec3(0,1,1)), localVolumeCellHash(cell + vec3(1,1,1)), fraction.x), fraction.y);
  return mix(lower, upper, fraction.z);
}
vec3 localVolumeLocal(int index, vec3 vector) {
  return vec3(dot(localVolumeAxes[index * 3].xyz, vector), dot(localVolumeAxes[index * 3 + 1].xyz, vector), dot(localVolumeAxes[index * 3 + 2].xyz, vector));
}
vec2 localVolumeInterval(int index, vec3 origin, vec3 direction) {
  vec3 center = localVolumeCenters[index].xyz;
  vec3 halfSize = localVolumeExtents[index].xyz;
  if (localVolumeCenters[index].w > 0.5) {
    vec3 offset = origin - center;
    float along = dot(offset, direction);
    float discriminant = along * along - (dot(offset, offset) - halfSize.x * halfSize.x);
    if (discriminant <= 0.0) return vec2(0.0);
    float root = sqrt(discriminant);
    return vec2(-along - root, -along + root);
  }
  vec3 localOrigin = localVolumeLocal(index, origin - center);
  vec3 localDirection = localVolumeLocal(index, direction);
  float entry = -1e30;
  float exitDistance = 1e30;
  for (int axis = 0; axis < 3; axis++) {
    float relative = -localOrigin[axis];
    if (localDirection[axis] == 0.0) {
      if (abs(relative) > halfSize[axis]) return vec2(0.0);
    } else {
      float first = (relative - halfSize[axis]) / localDirection[axis];
      float second = (relative + halfSize[axis]) / localDirection[axis];
      entry = max(entry, min(first, second));
      exitDistance = min(exitDistance, max(first, second));
    }
  }
  return vec2(entry, exitDistance);
}
float localVolumeProfile(int index, vec3 position, bool withNoise) {
  vec3 offset = position - localVolumeCenters[index].xyz;
  if (localVolumeCenters[index].w < 0.5) offset = localVolumeLocal(index, offset);
  vec3 halfSize = localVolumeExtents[index].xyz;
  float distanceRatio = localVolumeCenters[index].w > 0.5 ? length(offset) / halfSize.x : max(max(abs(offset.x) / halfSize.x, abs(offset.y) / halfSize.y), abs(offset.z) / halfSize.z);
  float falloff = localVolumeExtents[index].w;
  float profile = falloff > 0.0 ? 1.0 - smoothstep(1.0 - falloff, 1.0, distanceRatio) : 1.0 - step(1.0, distanceRatio);
  float noiseAmount = localVolumeAbsorption[index].w;
  if (withNoise && noiseAmount > 0.0) profile *= mix(1.0, localVolumeNoise(position * localVolumeEmission[index].w) * 2.0, noiseAmount);
  return profile;
}
// The optical depth of a volume between a point inside it and its far side along a direction, from midpoint taps of its profile.
vec3 localVolumeDepth(int index, vec3 position, vec3 direction, int taps) {
  float exitDistance = max(localVolumeInterval(index, position, direction).y, 0.0);
  float profileSum = 0.0;
  for (int tap = 0; tap < 3; tap++) {
    if (tap >= taps) break;
    profileSum += localVolumeProfile(index, position + direction * (exitDistance * (float(tap) + 0.5) / float(taps)), false);
  }
  return localVolumeAbsorption[index].rgb * (profileSum * exitDistance / float(taps));
}
// The sky light a point receives through the volume's own depth: the mean over the up and four side directions of what one tap leaves.
// Without it the sky term is flat, so a thick smoke glows as evenly deep inside as at its edge and hides the key light's side.
vec3 localVolumeSkyLight(int index, vec3 position) {
  vec3 open = exp(-localVolumeDepth(index, position, vec3(0.0, 1.0, 0.0), 1));
  open += exp(-localVolumeDepth(index, position, vec3(1.0, 0.0, 0.0), 1));
  open += exp(-localVolumeDepth(index, position, vec3(-1.0, 0.0, 0.0), 1));
  open += exp(-localVolumeDepth(index, position, vec3(0.0, 0.0, 1.0), 1));
  open += exp(-localVolumeDepth(index, position, vec3(0.0, 0.0, -1.0), 1));
  return localSkyAmbient * (open * ${(0.2 * LOCAL_VOLUME_SKY_GAIN).toFixed(3)});
}
// The light a scattering volume receives at a point: the sky term and the key light through the shadow map, each through the volume's own depth.
vec3 localVolumeInScatter(int index, vec3 position, vec3 direction) {
  vec3 towardSun = normalize(volumeLightDirection);
  float visibility = keyVisibility(position);
  vec3 sunLight = vec3(0.0);
  if (visibility > 0.001) {
    vec3 lightDirection = normalize(vec3(towardSun.x, towardSun.y * ${LOCAL_VOLUME_SUN_FLATTEN.toFixed(3)}, towardSun.z));
    vec3 lightDepth = localVolumeDepth(index, position, lightDirection, 3) * ${LOCAL_VOLUME_SHADOW_STRENGTH.toFixed(3)};
    sunLight = volumeLightColor * (henyeyGreenstein(dot(direction, towardSun), 0.0) * visibility * ${LOCAL_VOLUME_KEY_GAIN.toFixed(3)}) * exp(-lightDepth);
  }
  return localVolumeSkyLight(index, position) + sunLight;
}
vec3 localVolumes(vec3 background) {
  vec2 clipXY = textureCoordinate * 2.0 - 1.0;
  vec4 farPoint = inverseViewProjection * vec4(clipXY, 1.0, 1.0);
  vec4 nearPoint = inverseViewProjection * vec4(clipXY, -1.0, 1.0);
  vec3 origin = localOrthographic > 0.5 ? nearPoint.xyz / nearPoint.w : eye;
  vec3 direction = normalize(farPoint.xyz - origin * farPoint.w);
  float depth = texture(sceneDepth, textureCoordinate).r;
  vec4 surfacePoint = inverseViewProjection * vec4(clipXY, depth * 2.0 - 1.0, 1.0);
  float surfaceDistance = 1e30;
  if (surfacePoint.w > 0.0) surfaceDistance = max(0.0, dot(surfacePoint.xyz - origin * surfacePoint.w, direction) / surfacePoint.w);
  float entries[8];
  float exits[8];
  for (int index = 0; index < 8; index++) {
    entries[index] = 1e30;
    exits[index] = 0.0;
    if (index >= localVolumeCount) continue;
    if (localVolumeCenters[index].w > 1.5) {
      // A closed mesh: the mesh pass stored the length inside this pixel's ray and the nearest entry (see mesh-volume-pass.js).
      vec2 inside = texelFetch(localMeshVolumes, ivec2(gl_FragCoord.xy) + ivec2(0, int(localVolumeSteps[index].y) * int(resolution.y)), 0).rg;
      // A back face past the far plane is clipped and leaves only its front face, a negative sum; that ray ends at the surface.
      float insideLength = inside.x < -1e-5 * surfaceDistance ? inside.x + surfaceDistance : inside.x;
      if (insideLength > 0.0) {
        entries[index] = inside.y < 1e29 ? inside.y : 0.0;
        exits[index] = entries[index] + insideLength;
      }
      continue;
    }
    vec2 span = localVolumeInterval(index, origin, direction);
    float entry = max(span.x, 0.0);
    float exitDistance = min(span.y, surfaceDistance);
    if (exitDistance > entry) {
      entries[index] = entry;
      exits[index] = exitDistance;
    }
  }
  vec3 transmittance = vec3(1.0);
  vec3 radiance = vec3(0.0);
  for (int pass = 0; pass < 8; pass++) {
    int nearest = -1;
    float nearestEntry = 1e29;
    for (int index = 0; index < 8; index++) {
      if (entries[index] < nearestEntry) {
        nearestEntry = entries[index];
        nearest = index;
      }
    }
    if (nearest < 0) break;
    float entry = entries[nearest];
    float exitDistance = exits[nearest];
    entries[nearest] = 1e30;
    if (localVolumeCenters[nearest].w > 1.5) {
      // Uniform density, so the march has a closed form: the light behind is dimmed by exp(-k L) and the emission adds
      // (1 - exp(-k L)) / k, or L where k is 0, wherever the stretches inside lie along the ray.
      float insideLength = exitDistance - entry;
      vec3 absorption = localVolumeAbsorption[nearest].rgb;
      vec3 factor = exp(-absorption * insideLength);
      vec3 gain = mix(vec3(insideLength), (1.0 - factor) / max(absorption, vec3(1e-6)), step(vec3(1e-6), absorption));
      radiance += transmittance * localVolumeEmission[nearest].rgb * gain;
      transmittance *= factor;
      continue;
    }
    int steps = int(localVolumeSteps[nearest].x);
    float stepSize = (exitDistance - entry) / float(steps);
    float jitter = hash(vec3(gl_FragCoord.xy, float(nearest) + 1.0));
    float scatterAlbedo = localVolumeSteps[nearest].z;
    for (int step = 0; step < 32; step++) {
      if (step >= steps) break;
      vec3 position = origin + direction * (entry + (float(step) + jitter) * stepSize);
      float profile = localVolumeProfile(nearest, position, true);
      radiance += transmittance * localVolumeEmission[nearest].rgb * (profile * stepSize);
      vec3 extinction = localVolumeAbsorption[nearest].rgb * (profile * stepSize);
      if (scatterAlbedo > 0.0 && profile > 0.0) radiance += transmittance * (scatterAlbedo * (1.0 - exp(-extinction))) * localVolumeInScatter(nearest, position, direction);
      transmittance *= exp(-extinction);
    }
  }
  return background * transmittance + radiance;
}
`;

// The key light's side of the fog and of a scattering local volume: the shadow map, the light and the phase function. Both steps read these,
// so post.js compiles this block in whenever either is on.
const KEY_LIGHT_DECLARATIONS = `
uniform highp sampler2DShadow volumeShadowMap;
uniform mat4 volumeLightProjection;
uniform vec3 volumeLightDirection;
uniform vec3 volumeLightColor;
`;

const KEY_LIGHT_FUNCTIONS = `
float henyeyGreenstein(float cosine, float anisotropy) {
  return (1.0 - anisotropy * anisotropy) / (12.5663706 * pow(1.0 + anisotropy * anisotropy - 2.0 * anisotropy * cosine, 1.5));
}
// The share of the key light that reaches a point: the shadow map.
float keyVisibility(vec3 position) {
  vec4 lightPosition = volumeLightProjection * vec4(position, 1);
  vec3 shadow = lightPosition.xyz / lightPosition.w * 0.5 + 0.5;
  if (all(greaterThanEqual(shadow, vec3(0))) && all(lessThanEqual(shadow, vec3(1)))) {
    return texture(volumeShadowMap, vec3(shadow.xy, shadow.z - 0.0008));
  }
  return 1.0;
}
`;

function packLights(renderer) {
  renderer.fogLightBuffers ??= createFogLightBuffers();
  packFogLights(renderer.lighting, renderer.fogLightBuffers);
}

registerShaderFeatureCode('volumeFog', {
  // The JavaScript half, which the renderer calls for a frame that draws a volume fog.
  support: { packLights, bindUniforms, usesDetail: fogUsesDetail, prepareLocalVolumes, bindLocalVolumes },
  keyDeclarations: KEY_LIGHT_DECLARATIONS,
  keyFunctions: KEY_LIGHT_FUNCTIONS,
  localDeclarations: LOCAL_VOLUME_DECLARATIONS,
  localFunctions: LOCAL_VOLUME_FUNCTIONS,
  postDeclarations: `
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
uniform int volumeDetailOctaves;
uniform float volumeDetailAmount;
uniform float volumeWarp;
uniform float volumeContrast;
uniform float volumeProfileStart;
uniform float volumeKeyScattering;
uniform int volumeScatterOctaves;
uniform float volumeMultiScatter;
uniform float volumeMultiExtinction;
uniform float volumeMultiAnisotropy;
uniform float volumeKeyTransmittance;
uniform float volumeSurfaceTransmittance;
uniform int volumeLightCount;
uniform vec4 volumeLightPositions[8];
uniform vec4 volumeLightColors[8];
uniform vec4 volumeLightDirections[8];
uniform vec4 volumeLightCones[8];
uniform float orthographic;
uniform highp sampler3D fogSkyVisibility;
`,
  postFunctions: `
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
float flowedNoise(vec3 samplePosition, vec2 velocity, float noiseScale) {
  float firstPhase = fract(time / volumeFlowPeriod);
  float secondPhase = fract(time / volumeFlowPeriod + 0.5);
  vec3 travel = vec3(velocity.x, 0.0, velocity.y) * volumeFlowStrength * volumeFlowPeriod;
  float first = cloudNoise((samplePosition - travel * firstPhase) * noiseScale);
  float second = cloudNoise((samplePosition - travel * secondPhase) * noiseScale);
  return mix(first, second, abs(2.0 * firstPhase - 1.0));
}
float noiseAt(vec3 samplePosition, vec2 velocity, float noiseScale) {
  return POST_FIELD ? flowedNoise(samplePosition, velocity, noiseScale) : cloudNoise(samplePosition * noiseScale);
}
// The density noise in 0..1. With the detail step compiled out this is the single lookup. With it, the position is warped by
// three low-frequency lookups (warp counts noise cells), up to two octaves at 2x and 4x frequency join in (weights 0.5 and 0.25
// times detailAmount, renormalised so the mean stays), and contrast stretches the result around its middle.
float densityNoise(vec3 samplePosition, vec2 velocity) {
  vec3 warped = samplePosition;
  if (POST_DETAIL && volumeWarp > 0.0) {
    vec3 seed = samplePosition * volumeNoiseScale * 0.5;
    vec3 offset = vec3(cloudNoise(seed + 17.0), cloudNoise(seed + 43.0), cloudNoise(seed + 71.0)) - 0.5;
    warped += offset * (2.0 * volumeWarp / volumeNoiseScale);
  }
  float lookup = noiseAt(warped, velocity, volumeNoiseScale);
  if (POST_DETAIL) {
    float total = 1.0;
    float sum = lookup;
    if (volumeDetailOctaves > 1) {
      float weight = 0.5 * volumeDetailAmount;
      sum += weight * noiseAt(warped, velocity, volumeNoiseScale * 2.0);
      total += weight;
    }
    if (volumeDetailOctaves > 2) {
      float weight = 0.25 * volumeDetailAmount;
      sum += weight * noiseAt(warped, velocity, volumeNoiseScale * 4.0);
      total += weight;
    }
    lookup = clamp(0.5 + (sum / total - 0.5) * volumeContrast, 0.0, 1.0);
  }
  return lookup;
}
float layerProfile(float relativeHeight) {
  return volumeProfile > 0.5 ? 1.0 - smoothstep(volumeProfileStart, 1.0, relativeHeight) : exp(-relativeHeight);
}
// The density factor at one point: the noise, times the field's layer profile or the height falloff. Zero where the fog is absent.
float fogDensityFactor(vec3 position) {
  float noise = 1.0;
  vec4 field = POST_FIELD ? texture(volumeField, (position.xz - volumeMinimum.xz) / (volumeMaximum.xz - volumeMinimum.xz)) : vec4(1);
  if (volumeNoiseAmount > 0.0) {
    float lookup = densityNoise(position - volumeDrift * time, field.zw);
    noise = mix(1.0, lookup * 2.0, volumeNoiseAmount);
  }
  if (POST_FIELD) noise *= field.r * layerProfile((position.y - volumeMinimum.y) / max(field.g, 0.0001));
  else if (volumeHeightFalloff > 0.0) noise *= exp((volumeMinimum.y - position.y) / volumeHeightFalloff);
  return noise;
}
// The optical depth of the fog between a point and the sun, from three taps along the light direction up to the box exit.
float sunOpticalDepth(vec3 position, vec3 towardSun) {
  float exitDistance = volumeMaxDistance;
  for (int axis = 0; axis < 3; axis++) {
    if (towardSun[axis] == 0.0) continue;
    float first = (volumeMinimum[axis] - position[axis]) / towardSun[axis];
    float second = (volumeMaximum[axis] - position[axis]) / towardSun[axis];
    exitDistance = min(exitDistance, max(first, second));
  }
  exitDistance = max(exitDistance, 0.0);
  float sum = 0.0;
  for (int tap = 0; tap < 3; tap++) sum += fogDensityFactor(position + towardSun * (exitDistance * (float(tap) + 0.5) / 3.0));
  return volumeDensity * sum * exitDistance / 3.0;
}
// The sun's in-scatter at a point. The octave sum approximates multiple scattering (Wrenninge et al. 2015, "Oz: the great and
// volumetric"): octave n scatters multiScatter^n as much, sees half^n of the extinction and has half^n of the anisotropy.
float keyInScatter(float cosine, float opticalDepth) {
  float total = 0.0;
  float weight = 1.0;
  float extinction = 1.0;
  float anisotropy = volumeAnisotropy;
  for (int octave = 0; octave < 4; octave++) {
    if (octave >= volumeScatterOctaves) break;
    total += weight * henyeyGreenstein(cosine, anisotropy) * exp(-opticalDepth * volumeKeyTransmittance * extinction);
    weight *= volumeMultiScatter;
    extinction *= volumeMultiExtinction;
    anisotropy *= volumeMultiAnisotropy;
  }
  return total;
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
  float boxExit = volumeMaxDistance;
  float entry = 0.0;
  for (int axis = 0; axis < 3; axis++) {
    if (direction[axis] == 0.0) {
      if (origin[axis] < volumeMinimum[axis] || origin[axis] > volumeMaximum[axis]) return background;
    } else {
      float first = (volumeMinimum[axis] - origin[axis]) / direction[axis];
      float second = (volumeMaximum[axis] - origin[axis]) / direction[axis];
      entry = max(entry, min(first, second));
      exitDistance = min(exitDistance, max(first, second));
      boxExit = min(boxExit, max(first, second));
    }
  }
  if (entry >= exitDistance) return background;
  float stepSize = (exitDistance - entry) / float(volumeSteps);
  vec3 lightDirection = normalize(volumeLightDirection);
  float cosine = dot(direction, lightDirection);
  float anisotropy = volumeAnisotropy;
  vec3 towardSun = lightDirection;
  bool sunTransmittance = volumeKeyTransmittance > 0.0 || volumeScatterOctaves > 1;
  float jitter = hash(vec3(gl_FragCoord.xy, 0));
  float transmittance = 1.0;
  vec3 accumulated = vec3(0);
  for (int index = 0; index < 48; index++) {
    if (index >= volumeSteps) break;
    vec3 position = origin + direction * (entry + (float(index) + jitter) * stepSize);
    float noise = fogDensityFactor(position);
    float opacity = 1.0 - exp(-volumeDensity * noise * stepSize);
    float visibility = keyVisibility(position);
    vec4 skyCell = POST_SKY ? texture(fogSkyVisibility, (position - volumeMinimum) / (volumeMaximum - volumeMinimum)) : vec4(0);
    float shadowShare = POST_SKY ? 0.1 + 0.9 * min(1.0, 30.0 * skyCell.r) : volumeShadowAmbient;
    float ambientShare = mix(shadowShare, 1.0, visibility);
    if (volumeGridFog > 0.5) ambientShare = min(1.0, 30.0 * skyCell.r);
    float opticalDepth = 0.0;
    if (sunTransmittance && visibility > 0.001) opticalDepth = sunOpticalDepth(position, towardSun);
    float phase = keyInScatter(cosine, opticalDepth);
    vec3 scattering = volumeColor * (volumeAmbient * ambientShare + 0.6 * skyCell.gba + volumeLightColor * (phase * visibility * volumeKeyScattering));
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
  float surfaceSun = 1.0;
  if (volumeSurfaceTransmittance > 0.0 && surfacePoint.w > 0.0 && surfaceDistance <= boxExit) {
    // A surface inside the box: its sun passes through the fog too. A lit surface takes mostly sun, so the whole colour dims by its share.
    vec3 surfacePosition = origin + direction * surfaceDistance + towardSun * 0.05;
    float surfaceVisibility = keyVisibility(surfacePosition);
    if (surfaceVisibility > 0.001) surfaceSun = mix(1.0, exp(-sunOpticalDepth(surfacePosition, towardSun) * volumeSurfaceTransmittance), surfaceVisibility);
  }
  return accumulated + background * transmittance * surfaceSun;
}
`,
});
