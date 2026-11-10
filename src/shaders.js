import { MAX_POINT_LIGHTS, MAX_SPOT_LIGHTS, MAX_AREA_LIGHTS } from './light-limits.js';
import { registeredFeatureCode, requireFeatureCode, registerShaderFeatureCode, registerSplatSupport, requireSplatSupport, layerTextureSupport, viewTransformShader, SPLAT_UNITS } from './shader-registry.js';

export { registerShaderFeatureCode, registerSplatSupport, requireSplatSupport, layerTextureSupport, viewTransformShader, SPLAT_UNITS };

// The GPU crowd path (src/crowd-skinning.js) replaces this stub with its own code when that addon is imported, so the core pays for two lines.
const CROWD_SHADER_STUB = 'uniform float crowdEnabled;\nmat4 crowdTransform() { return mat4(1.0); }';
let crowdShaderCode = CROWD_SHADER_STUB;

/** Installs the vertex code that skins a crowd batch from a baked joint-matrix texture. Called by the crowd addon on import. */
export function installCrowdShader(code) {
  crowdShaderCode = code;
}

// The skin and morph GLSL registers from skinning.js and morph.js. A vertex shader for a renderer without those parts gets these stubs,
// which keep the depth and benchmark shaders (they call the functions unconditionally) compiling.
const SKIN_STUB = 'mat4 skinTransform() { return mat4(1.0); }';
const MORPH_STUB = 'vec3 morphedPosition(vec3 base) { return base; }\nvec3 morphedNormal(vec3 base) { return base; }';

function requireDeformationCode(feature, file) {
  const code = registeredFeatureCode.get(feature);
  if (!code) throw new Error(`The ${feature} feature needs its shader code: import ${file} (any module that makes a ${feature} pose, such as the glTF loader, does).`);
  return code;
}

// The crowd path reads the joint palette that the skin code declares, so a crowd renderer carries it too.
function skinningShader(features) {
  const enabled = new Set(features);
  if (!enabled.has('skin') && !enabled.has('crowd')) return `${CROWD_SHADER_STUB}
${SKIN_STUB}`;
  const { vertexHead, vertexTail } = requireDeformationCode('skin', 'skinning.js');
  return `${vertexHead}${crowdShaderCode}
${vertexTail}`;
}

function morphingShader(features) {
  return new Set(features).has('morph') ? requireDeformationCode('morph', 'morph.js').vertex : MORPH_STUB;
}

// Wind lives in world-material-shader.js; a vertex shader without wind parts gets this stub.
const WIND_STUB = `
vec3 windOffset(vec3 localPosition, vec3 worldPoint, vec2 leafUv, float surfaceTag, float seconds, float strength) { return vec3(0.0); }
`;

// Wind for the foliage and grass tags: shared by the colour and shadow vertex shaders so both get the same code.
function windShader(features) {
  const enabled = new Set(features);
  return enabled.has('foliage') || enabled.has('grass') ? requireFeatureCode('worldMaterials').worldVertexWind : WIND_STUB;
}

function vertexShaderSource(definitions, features) {
  return `#version 300 es
${definitions}
precision highp float;
layout(location=0) in vec3 position;
layout(location=1) in vec3 normal;
layout(location=2) in mat4 instanceMatrix;
layout(location=6) in mat3 instanceNormal;
layout(location=9) in vec3 instanceColor;
layout(location=10) in vec4 instanceSurface;
layout(location=11) in vec3 assemblyOffset;
layout(location=12) in vec3 assemblyDetailOffset;
layout(location=13) in vec4 uvSets;
layout(location=14) in vec4 vertexColor;
layout(location=15) in vec4 instanceEmissive;
uniform mat4 viewProjection;
uniform mat4 lightProjection;
uniform vec3 flushBias;
uniform vec4 clipPerMetre;
uniform float time;
uniform float wind;
uniform float explosionProgress;
uniform vec3 explosionCenter;
uniform float assemblyAmount;
out vec3 worldPosition, worldNormal;
#ifdef INSTANCED
flat out vec3 baseColor;
flat out vec4 surface;
flat out vec4 instanceEmission;
flat out float instanceOpacity;
flat out mat3 boxNormalMatrix;
#endif
#ifdef VERTEX_COLORS
out vec3 vertexTint;
out float vertexSkyVisibility;
#endif
out vec4 shadowPosition;
out vec2 textureUV, lightmapUV;
out vec3 boxPosition, boxNormal;
${skinningShader(features)}
${morphingShader(features)}
${windShader(features)}
void main() {
  // A crowd batch reads its joints and weights from the colour attribute, which then carries no tint.
  vec2 uv = uvSets.xy;
  mat4 deformation = USES_CROWD ? crowdTransform() : (USES_SKIN ? skinTransform() : mat4(1.0));
  vec4 world = instanceMatrix * deformation * vec4(USES_MORPH ? morphedPosition(position) : position, 1.0);
  world.xyz += USES_CROWD ? vec3(0.0) : assemblyOffset * assemblyAmount + assemblyDetailOffset * smoothstep(0.3, 1.0, assemblyAmount);
  if (USES_WIND) world.xyz += windOffset(position, world.xyz, uv, instanceSurface.w, time, wind);
  if (USES_WAVES && instanceSurface.w == 3.0) {
    world.y += sin(world.x * 1.4 + time * 0.8) * 0.025 + sin(world.z * 1.8 - time) * 0.02;
  }
  if (USES_EXPLOSION && (instanceSurface.w == 8.0 || instanceSurface.w == 9.0)) {
    world.xyz = mix(explosionCenter, world.xyz, 0.03 + explosionProgress * 0.97);
  }
  worldPosition = world.xyz;
  vec3 localNormal = USES_MORPH ? morphedNormal(normal) : normal;
  vec3 deformedNormal = (USES_SKIN || USES_CROWD) ? transpose(inverse(mat3(deformation))) * localNormal : localNormal;
  worldNormal = normalize(instanceNormal * deformedNormal);
  // Metres along the object's own axes: a pattern follows its node and ignores scale.
  if (${new Set(features).has('boxMapScale')}) {
  boxPosition = (USES_MORPH ? morphedPosition(position) : position) * vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
  boxNormal = deformedNormal;
#ifdef INSTANCED
  boxNormalMatrix = instanceNormal;
#endif
  }
  textureUV = uv;
  lightmapUV = uvSets.zw;
#ifdef INSTANCED
  baseColor = instanceColor;
  instanceEmission = vec4(instanceEmissive.rgb, gl_InstanceID);
  instanceOpacity = instanceEmissive.w;
  surface = instanceSurface;
#endif
#ifdef VERTEX_COLORS
  vertexTint = USES_CROWD ? vec3(1.0) : vertexColor.rgb;
  vertexSkyVisibility = USES_CROWD ? 1.0 : vertexColor.a;
#endif
  shadowPosition = lightProjection * world;
  gl_Position = viewProjection * world;
  // A depth rank (renderer applyDepthRank): the depth of this point moved toward the eye by flushBias.x metres plus
  // flushBias.y of its distance, at the same place on screen, so ranked faces never crack or slide.
  if (flushBias != vec3(0.0)) {
    vec4 lifted = gl_Position - (flushBias.x + flushBias.y * gl_Position.w) * clipPerMetre;
    gl_Position.z = (lifted.z / lifted.w + flushBias.z) * gl_Position.w;
  }
}`;
}

// Built when a renderer starts, so the crowd addon can install its skinning code first.
// A feature may rewrite the shadow shaders (the material snippet hook discards there too).
export function withDepthCode(source, features) {
  return [...features].reduce((text, feature) => registeredFeatureCode.get(feature)?.depth?.(text) ?? text, source);
}

export function createDepthVertexShader(features = []) {
  return withDepthCode(`#version 300 es
${vertexDefinitions(new Set(features))}
precision highp float;
layout(location=0) in vec3 position;
layout(location=2) in mat4 instanceMatrix;
layout(location=10) in vec4 instanceSurface;
layout(location=11) in vec3 assemblyOffset;
layout(location=12) in vec3 assemblyDetailOffset;
layout(location=13) in vec4 uvSets;
layout(location=14) in vec4 vertexColor;
uniform mat4 lightProjection;
uniform float assemblyAmount;
uniform float time;
uniform float wind;
out vec2 textureUV;
${skinningShader(features)}
${morphingShader(features)}
${windShader(features)}
void main() {
  vec2 uv = uvSets.xy;
  vec4 world = instanceMatrix * (USES_CROWD ? crowdTransform() : skinTransform()) * vec4(morphedPosition(position), 1.0);
  world.xyz += USES_CROWD ? vec3(0.0) : assemblyOffset * assemblyAmount + assemblyDetailOffset * smoothstep(0.3, 1.0, assemblyAmount);
  // Same displacement as the colour pass, so shadows follow the swaying leaves.
  world.xyz += windOffset(position, world.xyz, uv, instanceSurface.w, time, wind);
  textureUV = uv;
  gl_Position = lightProjection * world;
}`, features);
}

export const depthVertexShader = createDepthVertexShader();

// Only masked batches sample the base map, so shadows follow the cutout.
export const depthFragmentShader = `#version 300 es
precision highp float;
in vec2 textureUV;
uniform float alphaMasked;
uniform float alphaCutoff;
uniform float materialOpacity;
uniform float hasBaseMap;
uniform sampler2D baseMap;
void main() {
  if (alphaMasked < 0.5) return;
  float alpha = materialOpacity;
  if (hasBaseMap > 0.5) alpha *= texture(baseMap, textureUV).a;
  if (alpha < alphaCutoff) discard;
}
`;

export const benchmarkVertexShader = `#version 300 es
precision highp float;
layout(location=0) in vec3 position;
layout(location=2) in mat4 instanceMatrix;
layout(location=9) in vec3 instanceColor;
uniform mat4 viewProjection;
out vec3 color;
${skinningShader([])}
${morphingShader([])}
void main() {
  color = instanceColor;
  gl_Position = viewProjection * instanceMatrix * skinTransform() * vec4(morphedPosition(position), 1.0);
}`;

export const benchmarkFragmentShader = `#version 300 es
precision highp float;
in vec3 color;
out vec4 outputColor;
void main() { outputColor = vec4(color, 1.0); }
`;

function buildFragmentShader(featureDefines, featureCode) {
  return `#version 300 es
${featureDefines}
precision highp float;
in vec3 worldPosition, worldNormal;
#ifdef INSTANCED
flat in vec3 baseColor;
flat in vec4 surface;
flat in vec4 instanceEmission;
flat in float instanceOpacity;
flat in mat3 boxNormalMatrix;
#else
uniform vec3 baseColor;
uniform vec4 surface;
uniform vec4 instanceEmission;
uniform float instanceOpacity;
uniform mat3 boxNormalMatrix;
#endif
#ifdef VERTEX_COLORS
in vec3 vertexTint;
in float vertexSkyVisibility;
#else
const vec3 vertexTint = vec3(1.0);
const float vertexSkyVisibility = 1.0;
#endif
in vec4 shadowPosition;
in vec2 textureUV, lightmapUV;
uniform sampler2D lightMap;
uniform float lightMapScale;
uniform float hasLightMap;
uniform vec3 eye;
uniform float renderPassMode;
uniform float renderPassDepthRange;
uniform float renderPassObjectBase;
uniform vec3 armorColor;
uniform vec2 armorSurface;
uniform float exposure;
uniform float inspection;
uniform float worldMode;
uniform float time;
uniform float daylight;
uniform vec3 lightDirection;
uniform int pointLightCount;
uniform vec4 pointLightPositions[${MAX_POINT_LIGHTS}];
uniform vec4 pointLightColors[${MAX_POINT_LIGHTS}];
uniform float pointLightRadii[${MAX_POINT_LIGHTS}];
uniform float pointLightShadowTiles[${MAX_POINT_LIGHTS}];
uniform int spotLightCount;
uniform vec4 spotLightPositions[${MAX_SPOT_LIGHTS}];
uniform vec4 spotLightColors[${MAX_SPOT_LIGHTS}];
uniform vec4 spotLightDirections[${MAX_SPOT_LIGHTS}];
uniform vec4 spotLightParameters[${MAX_SPOT_LIGHTS}];
uniform int areaLightCount;
uniform vec4 areaLightPositions[${MAX_AREA_LIGHTS}];
uniform vec4 areaLightColors[${MAX_AREA_LIGHTS}];
uniform vec4 areaLightNormals[${MAX_AREA_LIGHTS}];
uniform vec4 areaLightTangents[${MAX_AREA_LIGHTS}];
uniform sampler2D localShadowAtlas;
uniform mat4 localShadowMatrices[24];
uniform float localShadowTexelAngles[24];
uniform vec3 keyColor;
uniform float fillIntensity;
uniform float ambientIntensity;
uniform float specularAntiAliasing;
const float MAXIMUM_SPECULAR_WIDENING = 0.25;
uniform vec3 fogColor;
uniform float fogDensity;
uniform vec3 waterRipple;
uniform float rippleTime;
uniform float explosionProgress;
uniform highp sampler2DShadow shadowMap;
uniform float shadowBiasPerSlope;
uniform sampler2D baseMap;
uniform float hasBaseMap;
uniform sampler2D normalMap;
uniform sampler2D metallicRoughnessMap;
uniform sampler2D occlusionMap;
uniform sampler2D emissiveMap;
uniform float hasNormalMap;
uniform float hasMetallicRoughnessMap;
uniform float hasOcclusionMap;
uniform float hasEmissiveMap;
uniform vec2 normalScale;
uniform float occlusionStrength;
in vec3 boxPosition, boxNormal;
uniform float boxMapScale;
uniform int boxMapAxis;
// Dielectric reflectance at normal incidence, clear coat (strength, roughness) and sheen (colour, roughness)
uniform vec3 materialDielectric;
uniform vec2 materialCoat;
uniform vec4 materialSheen;
uniform vec4 materialMoss;
uniform float hdrEnabled;
uniform float alphaMode;
uniform float alphaCutoff;
uniform float materialOpacity;
uniform float alphaToCoverage;
uniform float doubleSided;
uniform float shadowBlind;
uniform float compositeMode;
out vec4 outputColor;
const float PI = 3.14159265359;

${featureCode("worldFunctions")}
vec3 fresnel(float cosine, vec3 reflectance) {
  // The light shading preset uses the spherical Gaussian fit of Schlick's power, which needs no logarithm.
  float weight = LIGHT_SHADING ? exp2((-5.55473 * cosine - 6.98316) * cosine) : pow(1.0 - cosine, 5.0);
  return reflectance + (1.0 - reflectance) * weight;
}

float shadowVisibility(vec3 normal) {
  vec3 projected = shadowPosition.xyz / shadowPosition.w * 0.5 + 0.5;
  if (projected.z > 1.0 || projected.z < 0.0 || any(lessThan(projected.xy, vec2(0.0))) || any(greaterThan(projected.xy, vec2(1.0)))) return 1.0;
  float cosine = max(dot(normal, normalize(lightDirection)), 0.05);
  float bias = shadowBiasPerSlope * clamp(sqrt(1.0 - cosine * cosine) / cosine, 0.25, 4.0);
  // The light shading preset reads one comparison fetch, which is already filtered over 2 by 2 texels.
  const int radius = LIGHT_SHADING ? 0 : 1;
  float visibility = 0.0;
  vec2 texel = 1.0 / vec2(textureSize(shadowMap, 0));
  for (int row = -radius; row <= radius; row++) {
    for (int column = -radius; column <= radius; column++) {
      // The sampler compares in hardware and filters the four texels bilinearly: one fetch instead of four.
      visibility += texture(shadowMap, vec3(projected.xy + vec2(column, row) * texel * 2.5, projected.z - bias));
    }
  }
  return visibility / float((2 * radius + 1) * (2 * radius + 1));
}

// Atlas tiles are 512 texels square on a 4 x 4 grid. The receiver is pushed off its surface by about two shadow texels,
// which removes acne without a depth bias that grows with distance.
float localShadowVisibility(float tile, vec3 position, vec3 normal, float lightDistance) {
  int tileIndex = int(tile);
  vec3 shifted = position + normal * (lightDistance * localShadowTexelAngles[tileIndex] * 2.0);
  vec4 clip = localShadowMatrices[tileIndex] * vec4(shifted, 1.0);
  if (clip.w <= 0.0) return 1.0;
  vec3 projected = clip.xyz / clip.w * 0.5 + 0.5;
  if (projected.z > 1.0 || any(lessThan(projected.xy, vec2(0.0))) || any(greaterThan(projected.xy, vec2(1.0)))) return 1.0;
  ivec2 tileOrigin = ivec2(tileIndex % 4, tileIndex / 4) * 512;
  vec2 pixel = projected.xy * 512.0 - 0.5;
  ivec2 corner = ivec2(floor(pixel));
  vec2 blend = fract(pixel);
  float receiverDepth = projected.z - 0.00002;
  float lit[4];
  for (int tap = 0; tap < 4; tap++) {
    ivec2 texel = clamp(corner + ivec2(tap & 1, tap >> 1), ivec2(0), ivec2(511));
    lit[tap] = step(receiverDepth, texelFetch(localShadowAtlas, tileOrigin + texel, 0).r);
  }
  return mix(mix(lit[0], lit[1], blend.x), mix(lit[2], lit[3], blend.x), blend.y);
}

// Cube face of a point light's shadow, in the order +X, -X, +Y, -Y, +Z, -Z.
float pointShadowFace(vec3 fromLight) {
  vec3 magnitude = abs(fromLight);
  if (magnitude.x >= magnitude.y && magnitude.x >= magnitude.z) return fromLight.x < 0.0 ? 1.0 : 0.0;
  if (magnitude.y >= magnitude.z) return fromLight.y < 0.0 ? 3.0 : 2.0;
  return fromLight.z < 0.0 ? 5.0 : 4.0;
}

float localAttenuation(float distanceSquared, float range, float radius) {
  float cutoff = 1.0;
  if (range > 0.0) {
    float squaredRatio = distanceSquared / (range * range);
    float fade = max(1.0 - squaredRatio * squaredRatio, 0.0);
    cutoff = fade * fade;
  }
  return cutoff / max(distanceSquared, radius * radius);
}

vec3 studio(vec3 direction, float roughness) {
  vec3 color = mix(vec3(0.025, 0.035, 0.045), vec3(0.22, 0.25, 0.27), smoothstep(-0.3, 0.8, direction.y));
  float blur = roughness * 0.35;
  float key = smoothstep(0.80 - blur, 0.87, dot(direction, normalize(vec3(-3.0, 5.0, 4.0))));
  float rim = smoothstep(0.90 - blur, 0.97, dot(direction, normalize(vec3(4.0, 2.0, -3.0))));
  float strip = exp(-pow((direction.x + 0.6) / (0.035 + blur), 2.0)) * smoothstep(-0.1, 0.6, direction.y);
  return color + key * vec3(2.8, 2.2, 1.6) + rim * vec3(0.5, 1.6, 1.5) + strip * vec3(0.7);
}
${featureCode("environmentShading")}
// Set once per fragment from the environment's BRDF table; every light's specular scales by it.
vec3 directSpecularGain = vec3(1.0);

${featureCode("declarations")}vec3 illuminate(vec3 normal, vec3 viewDirection, vec3 lightDirection, vec3 radiance, vec3 color, float metallic, float roughness) {
  float normalLight = max(dot(normal, lightDirection), 0.0);
  if (normalLight == 0.0) return vec3(0);
  vec3 halfway = normalize(viewDirection + lightDirection);
  float normalView = max(dot(normal, viewDirection), 0.001);
  float normalHalf = max(dot(normal, halfway), 0.0);
  float alpha = roughness * roughness;
  float denominator = normalHalf * normalHalf * (alpha * alpha - 1.0) + 1.0;
  float distribution = alpha * alpha / max(PI * denominator * denominator, 0.00001);
  float geometry;
  float visibilityDenominator;
  if (LIGHT_SHADING) {
    // The Kelemen visibility replaces the Smith terms: one product, no divisions by roughness.
    geometry = 1.0;
    float lightHalf = max(dot(lightDirection, halfway), 0.001);
    visibilityDenominator = 4.0 * lightHalf * lightHalf;
  } else {
    float masking = pow(roughness + 1.0, 2.0) / 8.0;
    geometry = normalView / (normalView * (1.0 - masking) + masking);
    geometry *= normalLight / (normalLight * (1.0 - masking) + masking);
    visibilityDenominator = max(4.0 * normalView * normalLight, 0.001);
  }
  vec3 baseReflectance = mix(materialDielectric, color, metallic);
${featureCode("illuminateReflectance")}  vec3 reflectance = fresnel(max(dot(halfway, viewDirection), 0.0), baseReflectance);
  vec3 specular = distribution * geometry * reflectance / visibilityDenominator;
  specular *= directSpecularGain;
${featureCode("illuminateSpecular")}  vec3 diffuse = (1.0 - reflectance) * (1.0 - metallic) * color / PI;
  return (diffuse + specular) * radiance * normalLight;
}

vec3 toneMap(vec3 color) {
  return clamp((color * (2.51 * color + 0.03)) / (color * (2.43 * color + 0.59) + 0.14), 0.0, 1.0);
}

// Box projection: three texture lookups along the object axes, blended by the normal, so a surface needs no UVs.
// Swapping two axes makes the texture's V direction, and with it a grain, run along the chosen axis.
vec3 boxAxisSwap(vec3 value) {
  if (boxMapAxis == 0) return value.yxz;
  if (boxMapAxis == 2) return value.xzy;
  return value;
}

vec3 boxWeights(vec3 direction) {
  vec3 weights = pow(abs(direction), vec3(8.0));
  return weights / max(weights.x + weights.y + weights.z, 1e-5);
}

vec4 sampleBox(sampler2D source) {
  vec3 coordinates = boxAxisSwap(boxPosition) * boxMapScale;
  vec3 weights = boxWeights(boxAxisSwap(normalize(boxNormal)));
  return texture(source, coordinates.zy) * weights.x + texture(source, coordinates.xz) * weights.y + texture(source, coordinates.xy) * weights.z;
}

// Whiteout blend of the three tangent-space normals, done in object space and then moved to world space.
vec3 boxMappedNormal(vec3 normal) {
  vec3 coordinates = boxAxisSwap(boxPosition) * boxMapScale;
  vec3 objectNormal = boxAxisSwap(normalize(boxNormal));
  vec3 weights = boxWeights(objectNormal);
  vec3 sampleX = texture(normalMap, coordinates.zy).xyz * 2.0 - 1.0;
  vec3 sampleY = texture(normalMap, coordinates.xz).xyz * 2.0 - 1.0;
  vec3 sampleZ = texture(normalMap, coordinates.xy).xyz * 2.0 - 1.0;
  vec3 blendX = vec3(sampleX.xy * normalScale + objectNormal.zy, abs(sampleX.z) * objectNormal.x);
  vec3 blendY = vec3(sampleY.xy * normalScale + objectNormal.xz, abs(sampleY.z) * objectNormal.y);
  vec3 blendZ = vec3(sampleZ.xy * normalScale + objectNormal.xy, abs(sampleZ.z) * objectNormal.z);
  vec3 blended = blendX.zyx * weights.x + blendY.xzy * weights.y + blendZ * weights.z;
  vec3 world = normalize(boxNormalMatrix * boxAxisSwap(blended));
  return dot(world, normal) < 0.0 ? -world : world;
}

vec2 mapUV(float flag) {
  return flag > 1.5 ? lightmapUV : textureUV;
}

// Toksvig variance: a normal map mip averages texels that disagree, so the filtered normal is shorter than 1.
// The shortfall is the detail the pixel can no longer resolve, and it widens the highlight instead of sparkling.
float normalMapVariance = 0.0;

vec3 mappedNormal(vec3 normal) {
  vec3 positionX = dFdx(worldPosition);
  vec3 positionY = dFdy(worldPosition);
  vec2 uvX = dFdx(textureUV);
  vec2 uvY = dFdy(textureUV);
  float uvScale = max(max(abs(uvX.x), abs(uvX.y)), max(abs(uvY.x), abs(uvY.y)));
  if (uvScale == 0.0) return normal;
  uvX /= uvScale;
  uvY /= uvScale;
  float determinant = uvX.x * uvY.y - uvX.y * uvY.x;
  // Degenerate UVs have no tangent basis and retain the geometric normal.
  if (abs(determinant) < 1e-7) return normal;
  vec3 tangent = (positionX * uvY.y - positionY * uvX.y) / determinant;
  vec3 bitangent = (positionY * uvX.x - positionX * uvY.x) / determinant;
  tangent -= normal * dot(normal, tangent);
  float tangentScale = max(max(abs(tangent.x), abs(tangent.y)), abs(tangent.z));
  if (tangentScale == 0.0) return normal;
  tangent /= tangentScale;
  tangent = normalize(tangent);
  float handedness = dot(cross(normal, tangent), bitangent) < 0.0 ? -1.0 : 1.0;
  bitangent = normalize(cross(normal, tangent)) * handedness;
  vec3 sampled = texture(normalMap, textureUV${featureCode("normalUv")}).xyz * 2.0 - 1.0;
  float filteredLength = clamp(length(sampled), 0.05, 1.0);
  normalMapVariance = (1.0 - filteredLength) / filteredLength;
  sampled.xy *= normalScale;
  vec3 mapped = mat3(tangent, bitangent, normal) * sampled;
  return dot(mapped, mapped) > 1e-12 ? normalize(mapped) : normal;
}

${featureCode("libraries")}

${featureCode("worldMossFunction")}// Opaque draws 1, mask resolves to a cutout (smooth coverage with MSAA), blend and add keep the fraction (per instance opacity times the batch one).
float surfaceAlpha(float textureAlpha) {
  if (!USES_ALPHA_MODE) return 1.0;
  float alpha = materialOpacity * instanceOpacity * textureAlpha;
  if (alphaMode > 1.5) return alpha;
  if (alphaToCoverage > 0.5) {
    float softness = max(fwidth(alpha), 0.0001);
    alpha = clamp((alpha - alphaCutoff) / softness + 0.5, 0.0, 1.0);
    if (alpha <= 0.0) discard;
    return alpha;
  }
  if (alpha < alphaCutoff) discard;
  return 1.0;
}

vec3 surroundingsColor(vec3 direction, float roughness) {
  if (ENVIRONMENT_ENABLED) return environmentRadiance(direction, roughness * environmentLevelMax);
  if (worldMode > 0.5) return mix(fogColor * 0.8, vec3(0.20, 0.38, 0.52) * 1.6, smoothstep(-0.15, 0.7, direction.y)) * 0.5 * daylight;
  return studio(direction, roughness);
}

// Clear coat: a second dielectric specular lobe over the base. Light that reflects off it never reaches the base.
// Passing 0.04 as the colour of a fully metallic surface gives the lobe's own reflectance and no diffuse part.
vec3 clearCoatLayer(vec3 baseRadiance, vec3 normal, vec3 viewDirection, float visibility) {
  float roughness = clamp(materialCoat.y, 0.075, 1.0);
${featureCode("coatReset")}  float coatFresnel = fresnel(max(dot(normal, viewDirection), 0.001), vec3(0.04)).x * materialCoat.x;
  vec3 mirror = surroundingsColor(reflect(-viewDirection, normal), roughness) * coatFresnel * ambientIntensity;
  vec3 highlight = illuminate(normal, viewDirection, normalize(lightDirection), keyColor * visibility, vec3(0.04), 1.0, roughness);
  return baseRadiance * (1.0 - coatFresnel) + mirror + highlight * materialCoat.x;
}

// Sheen: the Charlie distribution with the Neubelt visibility term (KHR_materials_sheen), plus a rim of ambient light.
vec3 sheenLayer(vec3 baseRadiance, vec3 normal, vec3 viewDirection, float visibility) {
  float roughness = clamp(materialSheen.w, 0.07, 1.0);
  float inverseAlpha = 1.0 / (roughness * roughness);
  vec3 lightVector = normalize(lightDirection);
  vec3 halfway = normalize(viewDirection + lightVector);
  float normalLight = max(dot(normal, lightVector), 0.0);
  float normalView = max(dot(normal, viewDirection), 0.001);
  float sine = sqrt(max(1.0 - pow(max(dot(normal, halfway), 0.0), 2.0), 0.0));
  float distribution = (2.0 + inverseAlpha) * pow(sine, inverseAlpha) / (2.0 * PI);
  float visibilityTerm = 1.0 / (4.0 * (normalLight + normalView - normalLight * normalView));
  vec3 keyTerm = materialSheen.rgb * distribution * visibilityTerm * normalLight * keyColor * visibility;
  vec3 ambientTerm = ENVIRONMENT_ENABLED ? environmentDiffuse(normal) : mix(vec3(0.16, 0.20, 0.22), vec3(0.19, 0.25, 0.30) * max(daylight, 0.08), worldMode);
  vec3 rimTerm = materialSheen.rgb * ambientTerm * pow(1.0 - normalView, 3.0) * ambientIntensity;
  float shadowedBase = 1.0 - 0.2 * max(materialSheen.r, max(materialSheen.g, materialSheen.b));
  return baseRadiance * shadowedBase + keyTerm + rimTerm;
}

// Raw data for a render pass: modes are 1 albedo, 2 normal, 3 emission, 4 depth, 5 object ID. Depth packs 16 bits
// into red and green, object IDs pack 24 bits into red, green and blue. Nothing here is tone mapped or graded.
vec3 renderPassValue(vec3 color, vec3 normal, vec3 emission) {
  if (renderPassMode < 1.5) return clamp(color, 0.0, 1.0);
  if (renderPassMode < 2.5) return normal * 0.5 + 0.5;
  if (renderPassMode < 3.5) return clamp(emission, 0.0, 1.0);
  if (renderPassMode < 4.5) {
    float steps = floor(clamp(length(worldPosition - eye) / renderPassDepthRange, 0.0, 1.0) * 65535.0 + 0.5);
    float high = floor(steps / 256.0);
    return vec3(high, steps - high * 256.0, 0.0) / 255.0;
  }
  float identifier = renderPassObjectBase + instanceEmission.w + 1.0;
  float high = floor(identifier / 65536.0);
  float middle = floor((identifier - high * 65536.0) / 256.0);
  return vec3(identifier - high * 65536.0 - middle * 256.0, middle, high) / 255.0;
}

void main() {
  vec3 normal = normalize(worldNormal);
  // Foliage and grass cards are single-sided geometry whose shading normal already leans toward the
  // canopy, so the back face keeps it instead of flipping to point into the crown.
  bool canopyShaded = CANOPY_TAG;
  if (doubleSided > 0.5 && !gl_FrontFacing && !canopyShaded) normal = -normal;
  vec3 geometricNormal = normal;
  if (USES_NORMAL_MAP) normal = BOX_MAPPED ? boxMappedNormal(normal) : mappedNormal(normal);
  vec3 viewDirection = normalize(eye - worldPosition);
  vec3 color = mix(baseColor, armorColor, step(0.5, surface.w) * (1.0 - step(1.5, surface.w)));
  if (!USES_SPLAT) color *= vertexTint;
  float textureAlpha = 1.0;
  if (USES_BASE_MAP) {
    vec4 sampledBase = BOX_MAPPED ? sampleBox(baseMap) : texture(baseMap, textureUV);
    color *= sampledBase.rgb;
    textureAlpha = sampledBase.a;
  }
${featureCode("surfaceHook")}  float alpha = surfaceAlpha(textureAlpha);
  vec3 emission = instanceEmission.rgb * surface.z;
  if (USES_EMISSIVE_MAP) emission *= (BOX_MAPPED ? sampleBox(emissiveMap) : texture(emissiveMap, mapUV(hasEmissiveMap))).rgb;
  if (USES_RENDER_PASS) {
    outputColor = vec4(renderPassValue(color, normal, emission), 1.0);
    return;
  }
  if (TAG_UNLIT) {
    vec3 radiance = color * exposure + emission;
    outputColor = vec4(hdrEnabled > 0.5 ? radiance : pow(max(radiance, vec3(0)), vec3(1.0 / 2.2)), alpha);
    return;
  }
  float metallic = surface.x;
  float roughness = clamp(surface.y, 0.075, 1.0);
  if (surface.w > 0.5 && surface.w < 1.5) {
    metallic = armorSurface.x;
    roughness = armorSurface.y;
  }
  if (USES_METALLIC_ROUGHNESS_MAP) {
    vec4 sampled = BOX_MAPPED ? sampleBox(metallicRoughnessMap) : texture(metallicRoughnessMap, mapUV(hasMetallicRoughnessMap));
    metallic *= sampled.b;
    roughness *= sampled.g;
  }
  float splatCavity = 1.0;
  if (USES_SPLAT) applySplat(color, normal, roughness, splatCavity);
  roughness = clamp(roughness, 0.075, 1.0);
  if (specularAntiAliasing > 0.0) {
    // Kaplanyan-Hoffman: the variance of the shading normal across the pixel footprint, clamped by a kernel threshold,
    // plus the Toksvig variance of the normal map. Both add to the squared roughness.
    vec3 normalX = dFdx(normal);
    vec3 normalY = dFdy(normal);
    float screenVariance = 0.25 * (dot(normalX, normalX) + dot(normalY, normalY));
    float widening = min(2.0 * screenVariance + 0.5 * normalMapVariance, MAXIMUM_SPECULAR_WIDENING);
    roughness = clamp(sqrt(roughness * roughness + specularAntiAliasing * widening), 0.075, 1.0);
  }
  float mossCover = 0.0;
  vec3 mossTone = vec3(0.0);
${featureCode("worldSurface")}  vec3 specularNormal = normal;
  vec3 baseReflectance = mix(materialDielectric, color, metallic);
${featureCode("mainSetup")}  if (ENVIRONMENT_ENABLED && !LIGHT_SHADING) {
    vec2 brdfLookup = texture(environmentBrdf, vec2(clamp(dot(normal, viewDirection), 0.001, 1.0), roughness)).rg;
    directSpecularGain = multipleScatterGain(brdfLookup, baseReflectance);
  }
  float visibility = shadowBlind > 0.5 ? 1.0 : shadowVisibility(normal);
${featureCode("worldVisibility")}  vec3 radiance = illuminate(normal, viewDirection, normalize(lightDirection), keyColor * visibility${featureCode("linkSun")}, color, metallic, roughness);
  if (FILL_ON) {
  radiance += illuminate(normal, viewDirection, normalize(vec3(4.0, 2.0, -3.0)), mix(vec3(0.8, 2.0, 1.8), vec3(0.12, 0.17, 0.20) * daylight, worldMode) * fillIntensity * mix(1.0, vertexSkyVisibility, worldMode), color, metallic, roughness);
  radiance += illuminate(normal, viewDirection, normalize(vec3(1.0, 2.0, 5.0)), vec3(0.6, 0.7, 0.8) * mix(1.0, 0.25 * daylight, worldMode) * fillIntensity * mix(1.0, vertexSkyVisibility, worldMode), color, metallic, roughness);
  }
  for (int index = 0; index < ${MAX_POINT_LIGHTS}; index++) {
    if (index >= pointLightCount) break;
    vec3 offset = pointLightPositions[index].xyz - worldPosition;
    float distanceSquared = dot(offset, offset);
    if (distanceSquared < 1e-12 || pointLightColors[index].w == 0.0) continue;
    float attenuation = localAttenuation(distanceSquared, pointLightPositions[index].w, pointLightRadii[index]);
    if (attenuation == 0.0) continue;
${featureCode("linkPoint")}    vec3 lightRadiance = pointLightColors[index].rgb * pointLightColors[index].w * attenuation;
    if (USES_LOCAL_SHADOWS && pointLightShadowTiles[index] >= 0.0) {
      float tile = pointLightShadowTiles[index] + pointShadowFace(-offset);
      lightRadiance *= shadowBlind > 0.5 ? 1.0 : localShadowVisibility(tile, worldPosition, normal, sqrt(distanceSquared));
    }
    radiance += illuminate(normal, viewDirection, offset * inversesqrt(distanceSquared), lightRadiance, color, metallic, roughness);
  }
  if (USES_SPOT_LIGHTS) {
    for (int index = 0; index < ${MAX_SPOT_LIGHTS}; index++) {
      if (index >= spotLightCount) break;
      vec3 offset = spotLightPositions[index].xyz - worldPosition;
      float distanceSquared = dot(offset, offset);
      if (distanceSquared < 1e-12 || spotLightColors[index].w == 0.0) continue;
      vec3 toLight = offset * inversesqrt(distanceSquared);
      float coneCosine = dot(-toLight, spotLightDirections[index].xyz);
      // The same cone mask as Blender: smoothstep between the outer and inner cosines.
      float cone = smoothstep(spotLightDirections[index].w, spotLightParameters[index].y, coneCosine);
      float attenuation = localAttenuation(distanceSquared, spotLightPositions[index].w, spotLightParameters[index].x) * cone;
      if (attenuation == 0.0) continue;
${featureCode("linkSpot")}      vec3 lightRadiance = spotLightColors[index].rgb * spotLightColors[index].w * attenuation;
      if (USES_LOCAL_SHADOWS && spotLightParameters[index].z >= 0.0) {
        lightRadiance *= shadowBlind > 0.5 ? 1.0 : localShadowVisibility(spotLightParameters[index].z, worldPosition, normal, sqrt(distanceSquared));
      }
      radiance += illuminate(normal, viewDirection, toLight, lightRadiance, color, metallic, roughness);
    }
  }
  if (USES_AREA_LIGHTS) {
    for (int index = 0; index < ${MAX_AREA_LIGHTS}; index++) {
      if (index >= areaLightCount) break;
${featureCode("linkArea")}      vec3 lightNormal = areaLightNormals[index].xyz;
      vec3 widthAxis = areaLightTangents[index].xyz;
      vec3 heightAxis = cross(lightNormal, widthAxis);
      vec2 halfSize = vec2(areaLightNormals[index].w, areaLightTangents[index].w) * 0.5;
      vec3 fromCenter = worldPosition - areaLightPositions[index].xyz;
      // Representative point: the closest point of the rectangle stands in for the whole source.
      vec3 closest = areaLightPositions[index].xyz
        + widthAxis * clamp(dot(fromCenter, widthAxis), -halfSize.x, halfSize.x)
        + heightAxis * clamp(dot(fromCenter, heightAxis), -halfSize.y, halfSize.y);
      vec3 offset = closest - worldPosition;
      float distanceSquared = dot(offset, offset);
      vec3 toLight = offset * inversesqrt(max(distanceSquared, 1e-12));
      float emission = max(dot(-toLight, lightNormal), 0.0);
      float area = 4.0 * halfSize.x * halfSize.y;
      // Adding area / pi keeps the term finite at the surface and matches a disc source on its axis.
      float attenuation = emission / (distanceSquared + area / PI);
      vec3 lightRadiance = areaLightColors[index].rgb * areaLightColors[index].w * attenuation;
${featureCode("areaRadiance")}      radiance += illuminate(normal, viewDirection, toLight, lightRadiance, color, metallic, roughness);
    }
  }
  vec3 reflectance = fresnel(max(dot(normal, viewDirection), 0.0), baseReflectance);
  float occlusion = 1.0;
  if (USES_OCCLUSION_MAP) occlusion = mix(1.0, texture(occlusionMap, mapUV(hasOcclusionMap)).r, occlusionStrength);
  // Trees and terrain bake how much sky each vertex sees; everything else carries 1.
  occlusion *= splatCavity * vertexSkyVisibility;
  // Squared: Cycles also drops the sky lobe below the surface, so a tilt reads darker than the linear share.
  if (USES_NORMAL_MAP) occlusion *= pow(0.5 + 0.5 * dot(normal, geometricNormal), 2.0);
  if (ENVIRONMENT_ENABLED) {
    float room = 1.0 - smoothstep(0.01, 0.06, dot(environmentDiffuse(vec3(0, 1, 0)), vec3(1)) / max(dot(keyColor, vec3(1)), 0.003));
    occlusion *= mix(1.0, mix(0.25, 1.0, visibility), room * (1.0 - metallic));
  }
  // Leaf and grass cards keep a faint sheen; full sky reflection washed grazing cards grey-blue.
  float skyReflection = canopyShaded ? 0.3 : 1.0;
  vec3 reflected = reflect(-viewDirection, specularNormal);
${featureCode("probeReflection")}${featureCode("irradianceGridOcclusion")}  if (ENVIRONMENT_ENABLED) {
    radiance += environmentLighting(normal, specularNormal, baseReflectance, viewDirection, reflected, color, metallic, roughness, occlusion, ambientIntensity, skyReflection);
  } else {
    // Outdoors the surroundings are sky and haze; reflecting the studio softboxes there lit grazing leaves white and cyan.
    vec3 surroundings = worldMode > 0.5 ? mix(fogColor * 0.8, vec3(0.20, 0.38, 0.52) * 1.6, smoothstep(-0.15, 0.7, reflected.y)) : studio(reflected, roughness);
${featureCode("probeSurroundings")}    radiance += surroundings * reflectance * skyReflection * (1.0 - roughness * 0.55) * mix(1.0, 0.5 * daylight, worldMode) * occlusion * ambientIntensity;
    radiance += color * (1.0 - metallic) * mix(vec3(0.16, 0.20, 0.22), vec3(0.19, 0.25, 0.30) * max(daylight, 0.08), worldMode) * (0.45 + 0.55 * max(normal.y, 0.0)) * occlusion * ambientIntensity;
  }
  // Baked bounced light arrives as irradiance, so the surface colour (pattern and texture included) tints it here.
  if (USES_LIGHT_MAP) radiance += color * (1.0 - metallic) * texture(lightMap, lightmapUV).rgb * lightMapScale;
${featureCode("irradianceGrid")}  vec3 keyResponse = keyColor / mix(vec3(5.2, 4.7, 4.1), vec3(3.7, 3.4, 2.9), worldMode);
  keyResponse *= mix(daylight, 1.0, worldMode);
${featureCode("worldLight")}  if (USES_SHEEN) radiance = sheenLayer(radiance, normal, viewDirection, visibility);
  if (USES_CLEARCOAT) radiance = clearCoatLayer(radiance, normal, viewDirection, visibility);
  radiance += emission;
${featureCode("afterEmission")}${featureCode("worldAfterEmission")}  if (TAG_FLOOR) {
    float contact = 1.0 - 0.45 * exp(-dot(worldPosition.xz, worldPosition.xz) * 1.4);
    radiance = vec3(0.034, 0.041, 0.046) * (0.4 + visibility * 0.6) * contact;
    float fog = 1.0 - exp(-length(worldPosition.xz) * 0.05);
    radiance = mix(radiance, vec3(0.018, 0.022, 0.026), fog);
  }
${featureCode("worldFinal")}  float fog = 1.0 - exp(-length(worldPosition - eye) * fogDensity);
  // Additive light fades to black through fog; mixing it toward the fog colour would add a glow of fog.
  radiance = alphaMode > 2.5 ? radiance * (1.0 - fog * worldMode) : mix(radiance, fogColor, fog * worldMode);
  if (inspection > 0.5) radiance = normal * 0.5 + 0.5;
  outputColor = vec4(hdrEnabled > 0.5 ? clamp(radiance * exposure, vec3(0), vec3(65504.0)) : pow(toneMap(radiance * exposure), vec3(1.0 / 2.2)), alpha);
  if (TAG_FLOOR && inspection < 0.5) {
    float distanceFade = exp(-length(worldPosition.xz) * 0.08);
    float contact = 1.0 - 0.1 * exp(-dot(worldPosition.xz, worldPosition.xz) * 1.4);
    vec3 floorColor = mix(vec3(0.145, 0.162, 0.177), vec3(0.17, 0.19, 0.205), distanceFade);
    vec3 result = floorColor * (0.72 + 0.28 * visibility) * contact;
    outputColor = vec4(hdrEnabled > 0.5 ? pow(result, vec3(2.2)) : result, 1.0);
  }
  // Holdout: nothing, not even alpha. Shadow catcher: black with the shadow it receives as premultiplied alpha.
  if (compositeMode > 0.5) outputColor = compositeMode < 1.5 ? vec4(0.0) : vec4(0.0, 0.0, 0.0, 1.0 - visibility);
}`;
}

// Every feature the main fragment shader can leave out, with the GLSL condition that turns it on. A feature that a scene
// never uses becomes the constant `false`, so the driver drops its code instead of compiling and branching over it.
const SHADER_FEATURE_CONDITIONS = {
  normalMap: ['USES_NORMAL_MAP', 'hasNormalMap > 0.5'],
  baseMap: ['USES_BASE_MAP', 'hasBaseMap > 0.5'],
  metallicRoughnessMap: ['USES_METALLIC_ROUGHNESS_MAP', 'hasMetallicRoughnessMap > 0.5'],
  occlusionMap: ['USES_OCCLUSION_MAP', 'hasOcclusionMap > 0.5'],
  emissiveMap: ['USES_EMISSIVE_MAP', 'hasEmissiveMap > 0.5'],
  lightMap: ['USES_LIGHT_MAP', 'hasLightMap > 0.5'],
  boxMapScale: ['BOX_MAPPED', 'boxMapScale > 0.0'],
  splat: ['USES_SPLAT', 'splatEnabled > 0.5'],
  moss: ['USES_MOSS', 'materialMoss.x > 0.0'],
  alphaMode: ['USES_ALPHA_MODE', 'alphaMode > 0.5'],
  floor: ['TAG_FLOOR', 'surface.w == 2.0'],
  water: ['TAG_WATER', 'surface.w == 3.0'],
  foliage: ['TAG_FOLIAGE', 'surface.w == 4.0'],
  terrain: ['TAG_TERRAIN', 'surface.w == 5.0'],
  grass: ['TAG_GRASS', 'surface.w == 7.0'],
  fire: ['TAG_FIRE', 'surface.w == 8.0'],
  smoke: ['TAG_SMOKE', 'surface.w == 9.0'],
  unlit: ['TAG_UNLIT', 'surface.w == 10.0'],
  spotLights: ['USES_SPOT_LIGHTS', 'spotLightCount > 0'],
  areaLights: ['USES_AREA_LIGHTS', 'areaLightCount > 0'],
  localShadows: ['USES_LOCAL_SHADOWS', 'true'],
  fill: ['FILL_ON', 'true'],
  renderPass: ['USES_RENDER_PASS', 'renderPassMode > 0.5 && renderPassMode < 5.5'],
  sheen: ['USES_SHEEN', 'materialSheen.rgb != vec3(0.0)'],
  clearcoat: ['USES_CLEARCOAT', 'materialCoat.x > 0.0'],
};

// Lighting from an environment map and the built-in studio lighting are two code paths, and a frame takes one of them.
// SwiftShader runs both sides of a choice between them for every pixel, so a renderer that only ever draws one of the two
// compiles the other out: ENVIRONMENT_ENABLED is true, false, or the uniform when both are listed.
export const LIGHT_SHADING_FEATURE = 'lightShading';
/** Renderer option values: 'full' is the default picture, 'light' leaves out costly terms for weak machines. */
export const SHADING_MODES = Object.freeze(['full', 'light']);
/** The light preset resolves at most this many MSAA samples (on SwiftShader 2 cost a third of 4 in the blend heavy scene). */
export const LIGHT_SHADING_MAXIMUM_SAMPLES = 2;
export const ENVIRONMENT_FEATURES =Object.freeze(['environmentMap', 'studioLighting']);

// Features that only the vertex shader reads: a part with a skeleton or morph targets.
const VERTEX_ONLY_FEATURES = Object.freeze(['skin', 'morph', 'crowd', 'vertexColors', 'instanced']);

function environmentCondition(enabled) {
  const hasMap = enabled.has('environmentMap');
  const hasStudio = enabled.has('studioLighting');
  if (hasMap && !hasStudio) return 'true';
  if (hasStudio && !hasMap) return 'false';
  return '(environmentEnabled > 0.5)';
}

// Features that main still names, because a macro guards the call, but whose GLSL is in an addon module. A renderer
// without the feature gets the stub, which keeps the program compiling; a renderer with it needs the module imported.
// The environment map code is also optional, but a shader never throws without it: the renderer asks for the map's own
// code first, and a shader built without it (studio lighting only) gets this stub, which the compiler drops as dead code.
const ENVIRONMENT_STUB = {
  environmentShading: `
uniform sampler2D environmentBrdf;
uniform float environmentEnabled;
uniform float environmentLevelMax;
vec3 environmentRadiance(vec3 direction, float level) { return vec3(0.0); }
vec3 environmentDiffuse(vec3 normal) { return vec3(0.0); }
vec3 multipleScatterGain(vec2 lookup, vec3 baseReflectance) { return vec3(1.0); }
vec3 environmentLighting(vec3 normal, vec3 specularNormal, vec3 baseReflectance, vec3 viewDirection, vec3 reflected, vec3 color, float metallic, float roughness, float occlusion, float ambient, float specularWeight) { return vec3(0.0); }
`,
};

// The world materials share one block of code in world-material-shader.js. A shader that draws none of them gets empty slots.
const WORLD_MATERIAL_FEATURES = Object.freeze(['water', 'foliage', 'grass', 'terrain', 'moss', 'fire', 'smoke']);

const MODULE_FEATURES = {
  splat: {
    stub: { libraries: 'void applySplat(inout vec3 color, inout vec3 normal, inout float roughness, inout float cavity) {}\n' },
  },
};

/** The fragment shader of the liquid and foam pass. It throws until liquid-shader.js is imported. */
export function liquidFragmentSource() {
  return requireFeatureCode('liquid').fragment;
}

/** The function that draws the liquid and foam pass for a renderer. It throws until liquid-shader.js is imported. */
export function liquidPassDrawer() {
  return requireFeatureCode('liquid').draw;
}

function hasSeparateCode(feature) {
  if (feature in MODULE_FEATURES) return true;
  if (feature in SHADER_FEATURE_CONDITIONS || feature === LIGHT_SHADING_FEATURE) return false;
  return !ENVIRONMENT_FEATURES.includes(feature) && !VERTEX_ONLY_FEATURES.includes(feature);
}

function featureCodeSplicer(features) {
  const enabled = new Set(features);
  const codes = features.filter(hasSeparateCode).map(requireFeatureCode);
  for (const [feature, { stub }] of Object.entries(MODULE_FEATURES)) {
    if (!enabled.has(feature)) codes.push(stub);
  }
  if (WORLD_MATERIAL_FEATURES.some(feature => enabled.has(feature))) codes.push(requireFeatureCode('worldMaterials'));
  codes.push(enabled.has('environmentMap') ? registeredFeatureCode.get('environmentMap') ?? ENVIRONMENT_STUB : ENVIRONMENT_STUB);
  return slot => codes.map(code => code[slot] ?? '').join('');
}

export const SHADER_FEATURES = Object.freeze([...Object.keys(SHADER_FEATURE_CONDITIONS), ...ENVIRONMENT_FEATURES, ...VERTEX_ONLY_FEATURES].filter(feature => !(feature in MODULE_FEATURES) && !WORLD_MATERIAL_FEATURES.includes(feature)));

// The vertex shader pays on every vertex for skinning, morphing, wind, waves and the explosion, and SwiftShader runs a
// choice between them whether or not the uniform picks it, so a renderer without those parts compiles them out.
// The varyings that both shaders carry: per-vertex colours, and the per-instance values that a draw of one instance sets as uniforms.
function interpolantDefines(enabled) {
  return [['vertexColors', 'VERTEX_COLORS'], ['instanced', 'INSTANCED']].filter(([feature]) => enabled.has(feature)).map(([, macro]) => `#define ${macro}`);
}

function vertexDefinitions(enabled) {
  const condition = (active, expression) => (active ? `(${expression})` : 'false');
  return [
    `#define USES_SKIN ${condition(enabled.has('skin'), 'skinEnabled > 0.5')}`,
    `#define USES_CROWD ${condition(enabled.has('crowd'), 'crowdEnabled > 0.5')}`,
    `#define USES_MORPH ${condition(enabled.has('morph'), 'morphEnabled > 0.5')}`,
    `#define USES_WIND ${condition(enabled.has('foliage') || enabled.has('grass'), 'true')}`,
    `#define USES_WAVES ${condition(enabled.has('water'), 'true')}`,
    `#define USES_EXPLOSION ${condition(enabled.has('fire') || enabled.has('smoke'), 'true')}`,
    ...interpolantDefines(enabled),
  ].join('\n');
}

/** The vertex shader for a set of features, listed as for createFragmentShader. */
export function createVertexShader(features = SHADER_FEATURES) {
  return vertexShaderSource(vertexDefinitions(new Set(features)), features);
}

// Without skin and morph, which need their modules; the liquid pass draws rigid parts only.
export const vertexShader = createVertexShader(SHADER_FEATURES.filter(feature => !['crowd', 'skin', 'morph'].includes(feature)));

/** The fragment shader for a set of features. A feature with separate code throws until its module is imported. */
export function createFragmentShader(features = SHADER_FEATURES) {
  const enabled = new Set(features);
  const lines = Object.entries(SHADER_FEATURE_CONDITIONS).map(([feature, [macro, condition]]) => `#define ${macro} ${enabled.has(feature) ? `(${condition})` : 'false'}`);
  lines.push('#define CANOPY_TAG (TAG_FOLIAGE || TAG_GRASS)', ...interpolantDefines(enabled));
  lines.push(`#define ENVIRONMENT_ENABLED ${environmentCondition(enabled)}`);
  // Not in SHADER_FEATURES: the preset is chosen by the renderer, so a shader built from every feature keeps the full look.
  lines.push(`#define LIGHT_SHADING ${enabled.has(LIGHT_SHADING_FEATURE) ? 'true' : 'false'}`);
  return buildFragmentShader(lines.join('\n'), featureCodeSplicer([...enabled]));
}

export const fragmentShader = createFragmentShader();
