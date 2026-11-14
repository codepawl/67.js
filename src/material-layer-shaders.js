import { layerTextureSupport, registerShaderFeatureCode } from './shader-registry.js';

// Shader code for the anisotropy and iridescence material layers. It lives outside shaders.js so that a scene that
// uses neither layer never downloads it: the renderer asks for it only when a part uses a layer, and importing this
// module (or loading it through loadAgentSceneModules or the glTF loader) registers it.
// The GLSL has no comments, because comments ship to every page:
// - anisotropyStrength, anisotropyTangent, anisotropyBitangent, iridescenceWeight and iridescentReflectance are the
//   per-pixel state main sets once and every light reads; clearCoatLayer zeroes it because the coat is plain.
// - anisotropicSpecular is anisotropic GGX with height-correlated visibility as in KHR_materials_anisotropy (rougher
//   along the tangent), including the 1 / (4 N.L N.V) term. setAnisotropyFrame takes the UV tangent, or rings the
//   world up axis without UVs, and turns it about the normal. Image-based light is looked up along a normal bent
//   toward the grain (Filament).
// - filmReflectance is thin-film interference after Belcour and Barla 2017, as three.js uses it for
//   KHR_materials_iridescence; filmReflectanceAtNormal turns the film's Fresnel at this view angle back into the
//   reflectance at normal incidence that a Schlick curve needs.

const ANISOTROPY_DECLARATIONS = `#ifndef ANISOTROPY_DECLARED
#define ANISOTROPY_DECLARED
uniform vec2 materialAnisotropy;
float anisotropyStrength = 0.0;
vec3 anisotropyTangent = vec3(1.0, 0.0, 0.0);
vec3 anisotropyBitangent = vec3(0.0, 0.0, 1.0);
vec3 anisotropyFrameTangent = vec3(1.0, 0.0, 0.0);
vec3 anisotropyFrameBitangent = vec3(0.0, 0.0, 1.0);
float anisotropicSpecular(vec3 normal, vec3 viewDirection, vec3 lightDirection, vec3 halfway, float alpha) {
  float alphaTangent = mix(alpha, 1.0, anisotropyStrength * anisotropyStrength);
  float alphaBitangent = alpha;
  float normalLight = max(dot(normal, lightDirection), 0.0001);
  float normalView = max(dot(normal, viewDirection), 0.001);
  float normalHalf = max(dot(normal, halfway), 0.0);
  float tangentHalf = dot(anisotropyTangent, halfway) / alphaTangent;
  float bitangentHalf = dot(anisotropyBitangent, halfway) / alphaBitangent;
  float shape = tangentHalf * tangentHalf + bitangentHalf * bitangentHalf + normalHalf * normalHalf;
  float distribution = 1.0 / (PI * alphaTangent * alphaBitangent * shape * shape);
  vec3 viewScaled = vec3(alphaTangent * dot(anisotropyTangent, viewDirection), alphaBitangent * dot(anisotropyBitangent, viewDirection), normalView);
  vec3 lightScaled = vec3(alphaTangent * dot(anisotropyTangent, lightDirection), alphaBitangent * dot(anisotropyBitangent, lightDirection), normalLight);
  float visibility = 0.5 / max(normalLight * length(viewScaled) + normalView * length(lightScaled), 0.00001);
  return distribution * visibility;
}

void setAnisotropyFrame(vec3 normal) {
  vec3 tangent = vec3(0.0);
  vec2 uvX = dFdx(textureUV);
  vec2 uvY = dFdy(textureUV);
  float uvScale = max(max(abs(uvX.x), abs(uvX.y)), max(abs(uvY.x), abs(uvY.y)));
  if (uvScale > 0.0) {
    uvX /= uvScale;
    uvY /= uvScale;
    float determinant = uvX.x * uvY.y - uvX.y * uvY.x;
    if (determinant != 0.0) tangent = (dFdx(worldPosition) * uvY.y - dFdy(worldPosition) * uvX.y) / determinant;
  }
  tangent -= normal * dot(normal, tangent);
  float tangentScale = max(max(abs(tangent.x), abs(tangent.y)), abs(tangent.z));
  if (tangentScale == 0.0) {
    vec3 ringAxis = abs(normal.y) > 0.99 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0);
    tangent = cross(ringAxis, normal);
    tangentScale = 1.0;
  }
  tangent = normalize(tangent / tangentScale);
  vec3 bitangent = cross(normal, tangent);
  anisotropyFrameTangent = tangent;
  anisotropyFrameBitangent = bitangent;
  anisotropyTangent = tangent * cos(materialAnisotropy.y) + bitangent * sin(materialAnisotropy.y);
  anisotropyBitangent = cross(normal, anisotropyTangent);
}
#endif

`;

const ANISOTROPY_ILLUMINATE_SPECULAR = `  if (anisotropyStrength > 0.0) specular = anisotropicSpecular(normal, viewDirection, lightDirection, halfway, max(alpha, 0.002)) * reflectance;
`;

const ANISOTROPY_COAT_RESET = `  anisotropyStrength = 0.0;
`;

const ANISOTROPY_MAIN_SETUP = `  if (materialAnisotropy.x > 0.0) {
    anisotropyStrength = materialAnisotropy.x;
    setAnisotropyFrame(normal);
#ifdef ANISOTROPY_TEXTURE
    if (anisotropyTextureOn > 0.5) applyAnisotropyTexture(normal);
#endif
    vec3 grainSide = cross(anisotropyBitangent, viewDirection);
    vec3 grainNormal = cross(grainSide, anisotropyBitangent);
    specularNormal = normalize(mix(normal, grainNormal, anisotropyStrength * clamp(5.0 * roughness, 0.0, 1.0)));
  }
`;

// A material graph's fresnel factor of emission (material-graph.js): Schlick's curve for the IOR in materialEmissionFresnel,
// the same curve as fresnelSchlick in material-layers.js, which the CPU path tracer uses.
registerShaderFeatureCode('emissionFresnel', Object.freeze({
  declarations: 'uniform float materialEmissionFresnel;\n',
  emissionHook: `  float emissionNormalIncidence = (materialEmissionFresnel - 1.0) / (materialEmissionFresnel + 1.0);
  emissionNormalIncidence *= emissionNormalIncidence;
  emission *= emissionNormalIncidence + (1.0 - emissionNormalIncidence) * pow(1.0 - clamp(dot(normal, viewDirection), 0.0, 1.0), 5.0);
`,
}));

// An emission mask (material-layers.js): a smoothstep ramp along one axis of the part's own space in metres, the boxPosition
// varying that the vertex shader fills for this feature. Axis -1 means this part has no mask.
registerShaderFeatureCode('emissionMask', Object.freeze({
  declarations: 'uniform vec3 materialEmissionMask;\n',
  emissionHook: `  if (materialEmissionMask.x > -0.5) {
    float maskCoordinate = materialEmissionMask.x < 0.5 ? boxPosition.x : (materialEmissionMask.x < 1.5 ? boxPosition.y : boxPosition.z);
    float maskRamp = clamp((maskCoordinate - materialEmissionMask.y) / (materialEmissionMask.z - materialEmissionMask.y), 0.0, 1.0);
    emission *= maskRamp * maskRamp * (3.0 - 2.0 * maskRamp);
  }
`,
}));

registerShaderFeatureCode('anisotropy', Object.freeze({
  declarations: ANISOTROPY_DECLARATIONS,
  illuminateSpecular: ANISOTROPY_ILLUMINATE_SPECULAR,
  coatReset: ANISOTROPY_COAT_RESET,
  mainSetup: ANISOTROPY_MAIN_SETUP,
}));

const IRIDESCENCE_DECLARATIONS = `uniform vec3 materialIridescence;
float iridescenceWeight = 0.0;
vec3 iridescentReflectance = vec3(0.04);

vec3 filmSensitivity(float pathDifference, vec3 phaseShift) {
  float phase = 2.0 * PI * pathDifference * 1.0e-9;
  vec3 amplitude = vec3(5.4856e-13, 4.4201e-13, 5.2481e-13);
  vec3 position = vec3(1.6810e+06, 1.7953e+06, 2.2084e+06);
  vec3 variance = vec3(4.3278e+09, 9.3046e+09, 6.6121e+09);
  vec3 xyz = amplitude * sqrt(2.0 * PI * variance) * cos(position * phase + phaseShift) * exp(-phase * phase * variance);
  xyz.x += 9.7470e-14 * sqrt(2.0 * PI * 4.5282e+09) * cos(2.2399e+06 * phase + phaseShift.x) * exp(-4.5282e+09 * phase * phase);
  xyz /= 1.0685e-7;
  mat3 xyzToLinearRgb = mat3(3.2404542, -0.9692660, 0.0556434, -1.5371385, 1.8760108, -0.2040259, -0.4985314, 0.0415560, 1.0572252);
  return xyzToLinearRgb * xyz;
}

vec3 filmReflectance(float filmIor, float cosineView, float thickness, vec3 baseReflectance) {
  float outsideIor = 1.0;
  float filmIndex = mix(outsideIor, filmIor, smoothstep(0.0, 0.03, thickness));
  float sineFilmSquared = pow(outsideIor / filmIndex, 2.0) * (1.0 - cosineView * cosineView);
  if (sineFilmSquared > 1.0) return vec3(1.0);
  float cosineFilm = sqrt(1.0 - sineFilmSquared);
  float topNormal = pow((filmIndex - outsideIor) / (filmIndex + outsideIor), 2.0);
  float topFresnel = topNormal + (1.0 - topNormal) * pow(1.0 - cosineView, 5.0);
  float topTransmission = 1.0 - topFresnel;
  float topPhase = filmIndex < outsideIor ? PI : 0.0;
  vec3 clampedBase = clamp(baseReflectance, 0.0, 0.9999);
  vec3 baseIor = (1.0 + sqrt(clampedBase)) / (1.0 - sqrt(clampedBase));
  vec3 bottomNormal = pow((baseIor - filmIndex) / (baseIor + filmIndex), vec3(2.0));
  vec3 bottomFresnel = bottomNormal + (1.0 - bottomNormal) * pow(1.0 - cosineFilm, 5.0);
  vec3 bottomPhase = vec3(baseIor.x < filmIndex ? PI : 0.0, baseIor.y < filmIndex ? PI : 0.0, baseIor.z < filmIndex ? PI : 0.0);
  float pathDifference = 2.0 * filmIndex * thickness * cosineFilm;
  vec3 phase = vec3(PI - topPhase) + bottomPhase;
  vec3 roundTrip = clamp(topFresnel * bottomFresnel, 1e-5, 0.9999);
  vec3 roundTripRoot = sqrt(roundTrip);
  vec3 multiple = topTransmission * topTransmission * bottomFresnel / (vec3(1.0) - roundTrip);
  vec3 total = topFresnel + multiple;
  vec3 term = multiple - topTransmission;
  for (int order = 1; order <= 2; order++) {
    term *= roundTripRoot;
    total += term * 2.0 * filmSensitivity(float(order) * pathDifference, float(order) * phase);
  }
  return max(total, vec3(0.0));
}

vec3 filmReflectanceAtNormal(vec3 filmFresnel, float cosineView) {
  float power = clamp(pow(1.0 - cosineView, 5.0), 0.0, 0.9999);
  return clamp((filmFresnel - power) / (1.0 - power), 0.0, 1.0);
}

`;

const IRIDESCENCE_ILLUMINATE_REFLECTANCE = `  baseReflectance = mix(baseReflectance, iridescentReflectance, iridescenceWeight);
`;

const IRIDESCENCE_COAT_RESET = `  iridescenceWeight = 0.0;
`;

const IRIDESCENCE_MAIN_SETUP = `  if (materialIridescence.x > 0.0) {
    float cosineView = clamp(dot(normal, viewDirection), 0.001, 1.0);
    vec3 filmFresnel = filmReflectance(materialIridescence.y, cosineView, materialIridescence.z, baseReflectance);
    iridescentReflectance = filmReflectanceAtNormal(filmFresnel, cosineView);
    iridescenceWeight = materialIridescence.x;
    baseReflectance = mix(baseReflectance, iridescentReflectance, iridescenceWeight);
  }
`;

registerShaderFeatureCode('iridescence', Object.freeze({
  declarations: IRIDESCENCE_DECLARATIONS,
  illuminateReflectance: IRIDESCENCE_ILLUMINATE_REFLECTANCE,
  coatReset: IRIDESCENCE_COAT_RESET,
  mainSetup: IRIDESCENCE_MAIN_SETUP,
}));

// Layer textures. The renderer adds the feature named as the glTF property (clearcoatTexture and so on) when a material
// has that texture in material.layerMaps, binds the sampler, and sets the NameOn flag to 1 for batches that own it.
// A feature may be spliced beside another that shares state, so shared GLSL sits in blocks guarded with #ifndef.
// - The clear coat and sheen read their strength from the uniforms materialCoat and materialSheen. Their state blocks
//   rename those to coatState and sheenState, which main sets per pixel from the uniform times the texture, so the core
//   shader needs no texture code. coatUniform and sheenUniform are declared first, while the name still means the uniform.
// - A coat normal texture replaces the coat's normal, built from the geometric normal as the base normal map is.
// - An anisotropy texture holds the grain direction in red and green and a strength factor in blue (KHR_materials_anisotropy).
//   Only the anisotropy feature reads it, from its own main setup, so the order the features are spliced in does not matter.

const COAT_STATE_DECLARATIONS = `#ifndef COAT_STATE
#define COAT_STATE
vec2 coatState = vec2(0.0);
vec2 coatUniform() {
  return materialCoat;
}
#define materialCoat coatState
#endif
`;

const COAT_STATE_SETUP = `#ifndef COAT_STATE_SET
#define COAT_STATE_SET
  coatState = coatUniform();
#endif
`;

const SHEEN_STATE_DECLARATIONS = `#ifndef SHEEN_STATE
#define SHEEN_STATE
vec4 sheenState = vec4(0.0);
vec4 sheenUniform() {
  return materialSheen;
}
#define materialSheen sheenState
#endif
`;

const SHEEN_STATE_SETUP = `#ifndef SHEEN_STATE_SET
#define SHEEN_STATE_SET
  sheenState = sheenUniform();
#endif
`;

function textureUniforms(name) {
  return `uniform sampler2D ${name};
uniform float ${name}On;
`;
}

registerShaderFeatureCode('clearcoatTexture', Object.freeze({
  declarations: textureUniforms('clearcoatTexture') + COAT_STATE_DECLARATIONS,
  mainSetup: COAT_STATE_SETUP + `  if (clearcoatTextureOn > 0.5) coatState.x *= (BOX_MAPPED ? sampleBox(clearcoatTexture) : texture(clearcoatTexture, textureUV)).r;
`,
}));

registerShaderFeatureCode('clearcoatRoughnessTexture', Object.freeze({
  declarations: textureUniforms('clearcoatRoughnessTexture') + COAT_STATE_DECLARATIONS,
  mainSetup: COAT_STATE_SETUP + `  if (clearcoatRoughnessTextureOn > 0.5) coatState.y *= texture(clearcoatRoughnessTexture, textureUV).g;
`,
}));

registerShaderFeatureCode('clearcoatNormalTexture', Object.freeze({
  declarations: textureUniforms('clearcoatNormalTexture') + `vec3 coatMappedNormal() {
  vec3 normal = normalize(worldNormal);
  if (doubleSided > 0.5 && !gl_FrontFacing) normal = -normal;
  vec3 positionX = dFdx(worldPosition);
  vec3 positionY = dFdy(worldPosition);
  vec2 uvX = dFdx(textureUV);
  vec2 uvY = dFdy(textureUV);
  float uvScale = max(max(abs(uvX.x), abs(uvX.y)), max(abs(uvY.x), abs(uvY.y)));
  if (uvScale == 0.0) return normal;
  uvX /= uvScale;
  uvY /= uvScale;
  float determinant = uvX.x * uvY.y - uvX.y * uvY.x;
  if (abs(determinant) < 1e-7) return normal;
  vec3 tangent = (positionX * uvY.y - positionY * uvX.y) / determinant;
  vec3 bitangent = (positionY * uvX.x - positionX * uvY.x) / determinant;
  tangent -= normal * dot(normal, tangent);
  float tangentScale = max(max(abs(tangent.x), abs(tangent.y)), abs(tangent.z));
  if (tangentScale == 0.0) return normal;
  tangent = normalize(tangent / tangentScale);
  float handedness = dot(cross(normal, tangent), bitangent) < 0.0 ? -1.0 : 1.0;
  bitangent = normalize(cross(normal, tangent)) * handedness;
  vec3 mapped = mat3(tangent, bitangent, normal) * (texture(clearcoatNormalTexture, textureUV).xyz * 2.0 - 1.0);
  return dot(mapped, mapped) > 1e-12 ? normalize(mapped) : normal;
}
`,
  coatReset: `  if (clearcoatNormalTextureOn > 0.5) normal = coatMappedNormal();
`,
}));

registerShaderFeatureCode('sheenColorTexture', Object.freeze({
  declarations: textureUniforms('sheenColorTexture') + SHEEN_STATE_DECLARATIONS,
  mainSetup: SHEEN_STATE_SETUP + `  if (sheenColorTextureOn > 0.5) sheenState.rgb *= texture(sheenColorTexture, textureUV).rgb;
`,
}));

registerShaderFeatureCode('sheenRoughnessTexture', Object.freeze({
  declarations: textureUniforms('sheenRoughnessTexture') + SHEEN_STATE_DECLARATIONS,
  mainSetup: SHEEN_STATE_SETUP + `  if (sheenRoughnessTextureOn > 0.5) sheenState.w *= texture(sheenRoughnessTexture, textureUV).a;
`,
}));

registerShaderFeatureCode('anisotropyTexture', Object.freeze({
  declarations: ANISOTROPY_DECLARATIONS + textureUniforms('anisotropyTexture') + `#define ANISOTROPY_TEXTURE
void applyAnisotropyTexture(vec3 normal) {
  vec3 sampled = texture(anisotropyTexture, textureUV).rgb;
  vec2 direction = sampled.rg * 2.0 - 1.0;
  float cosine = cos(materialAnisotropy.y);
  float sine = sin(materialAnisotropy.y);
  vec2 rotated = vec2(cosine * direction.x - sine * direction.y, sine * direction.x + cosine * direction.y);
  anisotropyStrength = materialAnisotropy.x * sampled.b;
  if (dot(rotated, rotated) > 1e-8) {
    anisotropyTangent = normalize(anisotropyFrameTangent * rotated.x + anisotropyFrameBitangent * rotated.y);
    anisotropyBitangent = cross(normal, anisotropyTangent);
  }
}
`,
}));

// Layer textures share the units 11 to 13 with the splat arrays, so one renderer draws at most three different ones and
// none beside splat layers. A batch without a texture gets the white texture and a NameOn flag of 0.
const LAYER_TEXTURE_UNIT = 11;
const MAX_LAYER_TEXTURES = 3;

function layerTextureNamesOf(renderer) {
  if (renderer.layerTextureNamesFor?.size !== renderer.shaderFeatures.size) {
    const names = [...renderer.shaderFeatures].filter(feature => feature.endsWith('Texture'));
    if (names.length > MAX_LAYER_TEXTURES || renderer.shaderFeatures.has('splat')) {
      throw new Error(`A renderer draws at most ${MAX_LAYER_TEXTURES} layer textures and none beside splat layers, got ${names.join(', ')}.`);
    }
    renderer.layerTextureNames = names;
    renderer.layerTextureNamesFor = { size: renderer.shaderFeatures.size };
  }
  return renderer.layerTextureNames;
}

function uniformOf(renderer, name) {
  renderer.uniforms[name] ??= renderer.context.getUniformLocation(renderer.program, name);
  return renderer.uniforms[name];
}

// A normal map whose KHR_texture_transform differs from the other maps of its material: the importer bakes the shared
// transform into the UVs and leaves the normal map's remainder (scale and offset) in descriptor.uvTransform.
registerShaderFeatureCode('normalMapTransform', Object.freeze({
  declarations: `uniform vec4 normalMapTransform;
`,
  normalUv: ' * normalMapTransform.xy + normalMapTransform.zw',
}));

const IDENTITY_NORMAL_MAP_TRANSFORM = [1, 1, 0, 0];
const MAP_STATE_NORMAL_MAP = 1;
const MAP_STATE_LAYER_MAPS = 18;

// Other optional features (reflection probes) also bind per batch, so this keeps whatever was registered first.
const previousBind = layerTextureSupport.bind;
layerTextureSupport.bind = (renderer, mapState, layerState, batch) => {
  previousBind?.(renderer, mapState, layerState, batch);
  if (!renderer.shaderFeatures) return;
  const context = renderer.context;
  const layerMaps = mapState[MAP_STATE_LAYER_MAPS];
  if (renderer.shaderFeatures.has('normalMapTransform')) {
    const transform = mapState[MAP_STATE_NORMAL_MAP]?.uvTransform ?? IDENTITY_NORMAL_MAP_TRANSFORM;
    context.uniform4f(uniformOf(renderer, 'normalMapTransform'), ...transform);
  }
  layerTextureNamesOf(renderer).forEach((name, index) => {
    const descriptor = layerMaps?.[name];
    context.activeTexture(context.TEXTURE0 + LAYER_TEXTURE_UNIT + index);
    context.bindTexture(context.TEXTURE_2D, descriptor ? renderer.createTexture(descriptor) : renderer.whiteTexture);
    context.uniform1i(uniformOf(renderer, name), LAYER_TEXTURE_UNIT + index);
    context.uniform1f(uniformOf(renderer, `${name}On`), descriptor ? 1 : 0);
  });
};
