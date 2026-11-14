// The GLSL that every lit program carries to read an environment map, kept apart from the code that builds one so a
// renderer without an environment map does not carry the builder. environment.js registers that code when it loads.

export const equirectangularGlsl = `
vec3 directionFromEquirectangular(vec2 coordinates) {
  float azimuth = (coordinates.x - 0.5) * 6.28318530718;
  float polar = coordinates.y * 3.14159265359;
  return vec3(sin(polar) * sin(azimuth), cos(polar), -sin(polar) * cos(azimuth));
}
vec2 equirectangularFromDirection(vec3 direction) {
  return vec2(atan(direction.x, -direction.z) * 0.15915494309 + 0.5, acos(clamp(direction.y, -1.0, 1.0)) * 0.31830988618);
}
`;

export const environmentLookupGlsl = `
uniform sampler2D environmentSpecular;
uniform vec2 environmentRotation;
uniform float environmentIntensity;
uniform float environmentLevelMax;
${equirectangularGlsl}
vec3 environmentDirection(vec3 direction) {
  return vec3(environmentRotation.x * direction.x - environmentRotation.y * direction.z, direction.y, environmentRotation.y * direction.x + environmentRotation.x * direction.z);
}
vec3 environmentRadiance(vec3 direction, float level) {
  return textureLod(environmentSpecular, equirectangularFromDirection(environmentDirection(direction)), level).rgb * environmentIntensity;
}
`;

// environmentLighting adds back the light a rough microfacet surface bounces a second time, as Cycles' multiscatter GGX does (Fdez-Aguera 2019).
export const environmentShadingGlsl = `
uniform sampler2D environmentBrdf;
uniform float environmentEnabled;
uniform vec3 environmentIrradiance[9];
vec3 environmentDiffuse(vec3 normal) {
  vec3 mapped = environmentDirection(normal);
  // The light shading preset keeps the first four terms (the average and the direction of the light), not the second order ones.
  if (LIGHT_SHADING) {
    vec3 firstOrder = environmentIrradiance[0] + environmentIrradiance[1] * mapped.y + environmentIrradiance[2] * mapped.z + environmentIrradiance[3] * mapped.x;
    return max(firstOrder, vec3(0.0)) * environmentIntensity;
  }
  vec3 result = environmentIrradiance[0]
    + environmentIrradiance[1] * mapped.y
    + environmentIrradiance[2] * mapped.z
    + environmentIrradiance[3] * mapped.x
    + environmentIrradiance[4] * (mapped.x * mapped.y)
    + environmentIrradiance[5] * (mapped.y * mapped.z)
    + environmentIrradiance[6] * (3.0 * mapped.z * mapped.z - 1.0)
    + environmentIrradiance[7] * (mapped.x * mapped.z)
    + environmentIrradiance[8] * (mapped.x * mapped.x - mapped.y * mapped.y);
  return max(result, vec3(0.0)) * environmentIntensity;
}
// Light a rough microfacet loses on its first bounce and gets back on a second one, as a factor on single-scatter specular.
vec3 multipleScatterGain(vec2 lookup, vec3 baseReflectance) {
  float missingEnergy = 1.0 - (lookup.x + lookup.y);
  vec3 averageFresnel = baseReflectance + (1.0 - baseReflectance) / 21.0;
  return 1.0 / (1.0 - missingEnergy * averageFresnel);
}
// specularWeight scales only the reflected sky; leaf cards use less, since their bent normals face the view at grazing angles.
// Analytic fit of the lookup table (Karis 2014), for the light shading preset.
vec2 environmentBrdfFit(float normalView, float roughness) {
  vec4 terms = roughness * vec4(-1.0, -0.0275, -0.572, 0.022) + vec4(1.0, 0.0425, 1.04, -0.04);
  float edge = min(terms.x * terms.x, exp2(-9.28 * normalView)) * terms.x + terms.y;
  return vec2(-1.04, 1.04) * edge + terms.zw;
}
vec3 environmentLighting(vec3 normal, vec3 specularNormal, vec3 baseReflectance, vec3 viewDirection, vec3 reflected, vec3 color, float metallic, float roughness, float occlusion, float ambient, float specularWeight) {
  if (LIGHT_SHADING) {
    // No second bounce, and the sky reflection is the blurred sky of the surface's own normal: one irradiance read serves both.
    vec2 fitted = environmentBrdfFit(clamp(dot(normal, viewDirection), 0.001, 1.0), roughness);
    vec3 fittedColor = (baseReflectance * fitted.x + fitted.y) * specularWeight;
    vec3 irradiance = environmentDiffuse(normal);
    return irradiance * (fittedColor + color * (1.0 - metallic) * (1.0 - fittedColor)) * occlusion * ambient;
  }
  float normalView = clamp(dot(normal, viewDirection), 0.001, 1.0);
  vec2 lookup = texture(environmentBrdf, vec2(normalView, roughness)).rg;
  vec3 singleScatter = baseReflectance * lookup.x + lookup.y;
  vec3 specularColor = singleScatter * multipleScatterGain(lookup, baseReflectance) * specularWeight;
  vec3 specular = environmentRadiance(reflected, roughness * environmentLevelMax) * specularColor;
  vec3 diffuse = environmentDiffuse(normal) * color * (1.0 - metallic) * (1.0 - specularColor);
  return (specular + diffuse) * occlusion * ambient;
}

`;

// environment.js sets the JavaScript half: assertMap, estimateBytes, createResources and the prefilter, BRDF and
// background fragment shaders. The renderer asks for it only when the scene has an environment map.
const environmentSupport = {};

export function registerEnvironmentSupport(functions) {
  Object.assign(environmentSupport, functions);
}

export function requireEnvironmentSupport() {
  if (!environmentSupport.createResources) {
    throw new Error("An environment map needs its code: add import '@codepawlhq/crucible/addons/hdri' or import createEnvironmentMap from the package entry.");
  }
  return environmentSupport;
}
