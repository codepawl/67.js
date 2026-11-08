// Where the optional GLSL and JavaScript of the renderer's features is registered. Addon modules import this small
// module, not shaders.js, so an addon that only registers its code does not carry the renderer's whole shader text.

// A feature that is not in the list above has its GLSL in another module, so a scene that never uses it does not carry
// it. That module calls registerShaderFeatureCode on import, with blocks of GLSL that createFragmentShader splices in:
// declarations, illuminateReflectance, illuminateSpecular, coatReset and mainSetup, each ending in a newline, normalUv
// (a suffix on the normal map's UV, as in `textureUV * scale + offset`), and the
// one-line linkSun (a factor on the sun) with linkPoint, linkSpot and linkArea (statements that skip a light for a part).
// A feature that replaces the sun shadow defines shadowVisibility as a macro in its declarations.
export const registeredFeatureCode = new Map();

// material-layer-shaders.js sets bind(renderer, layerMaps): it binds the textures of material.layerMaps for one batch.
export const layerTextureSupport = {};

// view-transform-shader.js sets apply(source, kind, viewTransform, hasLook), bindLook(renderer, program) and dispose(renderer).
export const viewTransformShader = {};

// texture-update.js sets update(renderer, descriptor, update): the body of renderer.updateTexture.
export const textureUpdateSupport = {};

// replace-textured-parts.js sets begin(renderer) for replaceParts; it returns settle(previousBatches, nextBatches), which rolls back when called with no arguments.
export const texturedReplaceSupport = {};

// splat-shader.js sets the JavaScript half of the splat ground material: validate, textureBytes, resolveSize,
// packParameters and buildPixels. The renderer calls them only for a material with layers.
const splatSupport = {};

/** The texture units of the splat samplers. */
export const SPLAT_UNITS = Object.freeze({ splatColor: 11, splatNormal: 12, splatPacked: 13, splatMask: 14 });

export function registerSplatSupport(functions) {
  Object.assign(splatSupport, functions);
}

export function requireSplatSupport() {
  if (!splatSupport.validate) {
    throw new Error("Splat layers need their code: add import '@codepawlhq/67js/addons/splat-shader'.");
  }
  return splatSupport;
}

/** Register the GLSL of an optional feature. Called by the module that holds it, on import. */
export function registerShaderFeatureCode(feature, slots) {
  registeredFeatureCode.set(feature, slots);
}

// The addon that registers each feature's code; a feature not listed here is registered by material-layer-shaders.
const FEATURE_ADDONS = { splat: 'splat-shader', liquid: 'liquid-shader', worldMaterials: 'world-material-shader', subsurface: 'subsurface-shader' };

export function requireFeatureCode(feature) {
  const slots = registeredFeatureCode.get(feature);
  if (!slots) {
    const addon = FEATURE_ADDONS[feature] ?? 'material-layer-shaders';
    throw new Error(`The ${feature} feature needs its shader code: add import '@codepawlhq/67js/addons/${addon}' (a recipe: await loadAgentSceneModules(recipe)).`);
  }
  return slots;
}


/** Value of `material.tag` in the instance data; the vegetation addon adds `impostor`. */
export const materialTags = { armor: 1, floor: 2, water: 3, foliage: 4, terrain: 5, grass: 7, fire: 8, smoke: 9, unlit: 10, liquid: 11, foam: 12 };

// Functions from source to source that startProgram applies to every shader before compiling it; the vegetation addon adds its card code here.
export const shaderTransforms = [];

/** The most morph targets one geometry carries; the morph shader's weight array has this length. */
export const MAX_MORPH_TARGETS = 64;

// skinning.js and morph.js set the JavaScript half of skinned and morphed parts: validation, texture layout and packing.
// The renderer calls them only for a part with a skin or morph targets, so a renderer without those parts never carries them.
export const deformationSupport = {};

export function registerDeformationSupport(functions) {
  Object.assign(deformationSupport, functions);
}

export function requireDeformationSupport(requiredFunction, file) {
  if (!deformationSupport[requiredFunction]) {
    throw new Error(`Skinned and morphed parts need their code: import ${file}, or a module that makes the pose (createSkinPose, createMorphPose, the glTF loader).`);
  }
  return deformationSupport;
}
