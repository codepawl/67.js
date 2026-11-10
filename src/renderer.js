import { materialTags } from './shader-registry.js';
import { mat4, mat3 } from 'gl-matrix';
import { SPLAT_UNITS, requireSplatSupport, layerTextureSupport, LIGHT_SHADING_FEATURE, SHADING_MODES, LIGHT_SHADING_MAXIMUM_SAMPLES, createVertexShader, vertexShader, liquidFragmentSource, createFragmentShader, liquidPassDrawer, createDepthFragmentShader, benchmarkVertexShader, benchmarkFragmentShader, viewTransformShader, createDepthVertexShader } from './shaders.js';
import { postFragment, createPostFragment, POST_STEPS, POST_STEPS_WITH_OPTIONAL_CODE, skyFragment, bloomFragment } from './post.js';
import { fullscreenVertex, startProgram, finishProgram, compileProgram, ProgramNotReady, isLinkComplete, setPreparing } from './gl-program.js';
import { ambientOcclusionFragment } from './ambient-occlusion.js';
import { planRenderSize, estimateTextureBytes, estimateFrameBytes, memoryBudgetError } from './budget.js';
import { applyProjection } from './camera.js';
import { fittedNearPlane, sceneBoundsOfParts } from './near-plane-fit.js';
import { installReversedDepth, prepareCameraRelativeProgram } from './reversed-depth.js';
import { resolveEffects } from './effects.js';
import { frameDiagnostics } from './frame-diagnostics.js';
import { depthLayerOf, flushOrderOf, RANKS_PER_LAYER } from './depth-layer.js';
import { createLightingState, updateLightingState } from './lighting.js';
import { RenderTargetLedger } from './render-target-ledger.js';
import { SHADOW_ATLAS_WIDTH, SHADOW_TILE_SIZE, SHADOW_TILES_PER_ROW, tileViewport, writeShadowTile } from './local-shadows.js';
import { resolveVolumeFog, validateFogField } from './volumetric.js';
import { requireEnvironmentSupport } from './environment-shading.js';
import { materialLayerState, materialLayerValue } from './material-layers.js';
import { MaterialSnapshot } from './material-snapshot.js';
import { fittedFogDensity } from './fog-fit.js';
import { InstanceSelection, extractFrustumPlanes, geometryBoundingSphere, selectInstances } from './render-culling.js';
import { resolveShadowLight, shadowBiasPerSlope } from './shadow-light.js';
import { requireFeatureCode, deformationSupport, requireDeformationSupport, texturedReplaceSupport, textureUpdateSupport } from './shader-registry.js';

const SHADOW_MAP_SIZE = 2048;
// Liquid and foam see the resolved opaque scene, so they draw in their own pass after it.
const TRANSLUCENT_TAGS = new Set(['liquid', 'foam']);
// The 42nd float is the opacity of a blend or add part, so parts that differ only in opacity share a batch.
const INSTANCE_STRIDE = 42;
const OPACITY_OFFSET = 41;
// Shaders get this in place of an infinite attenuation distance, which is not a safe uniform value.
const MAX_FINITE_DISTANCE = 3e38;
const ALPHA_MODES = { opaque: 0, mask: 1, blend: 2, add: 3 };

/** Blend and add draw after the opaque loop, sorted, without writing depth. */
function isTranslucentMode(alphaMode) {
  return alphaMode === 'blend' || alphaMode === 'add';
}
const ZERO_VECTOR = Object.freeze([0, 0, 0]);
const MATERIAL_MAPS = ['map', 'normalMap', 'metallicRoughnessMap', 'occlusionMap', 'emissiveMap'];
const MAP_UNIFORMS = ['baseMap', 'normalMap', 'metallicRoughnessMap', 'occlusionMap', 'emissiveMap'];
const MAP_FLAGS = ['hasBaseMap', 'hasNormalMap', 'hasMetallicRoughnessMap', 'hasOcclusionMap', 'hasEmissiveMap'];
const DEFAULT_NORMAL_SCALE = [1, 1];
// The most texture taps a mipmapped texture may take along a grazing axis (16 is the usual hardware ceiling, 8 costs less).
const MAX_TEXTURE_ANISOTROPY = 8;
const PROCEDURAL_MATERIAL_TAGS = new Set(['water', 'foliage', 'grass', 'terrain', 'floor', 'fire', 'smoke', 'liquid', 'foam']);

// Tags whose vertices sway in the wind; the shadow pass must be redrawn when time moves.
const SWAYING_TAGS = new Set(['foliage', 'grass']);
// One depth rank (applyDepthRank): 0.1 mm, plus 2^-19 of the distance (2 mm at 1 km), plus a quarter of a subpixel of
// slope. On the 24-bit fallback a rank also moves two depth steps, since that buffer cannot hold the metric step far away.
const FLUSH_STEP = 1e-4;
const FLUSH_RELATIVE_STEP = 2 ** -19;
const FLUSH_CLIP_STEP = 2 ** -22;
const FLUSH_SLOPE_STEP = 4 / 256;
const clipPerMetreScratch = new Float32Array(4);
// Tags whose vertex shader moves vertices away from the instance matrix, so a bounding sphere would not hold.
const DEFORMING_TAGS = new Set(['foliage', 'grass', 'water', 'fire', 'smoke']);
// The farthest a vertex of a swaying tag moves in the world, per unit of wind strength (windOffset in shaders.js): foliage
// reaches 0.1 * 2.5 * 1.9 + 0.08 = 0.555 and grass 0.42 + 0.05 + 0.04 = 0.51. Their bounds grow by this much times the
// strength, so they can be culled and given levels like rigid parts.
const SWAY_REACH_PER_STRENGTH = 0.56;

const POST_UNIFORMS = ['transparent', 'frameTexture', 'bloomTexture', 'bloomStrength', 'hdrEnabled', 'grade', 'vignette', 'grainAmount', 'resolution', 'monochrome', 'fade', 'cinematic', 'time', 'volumeExplosion', 'explosionProgress', 'inverseViewProjection', 'eye', 'sceneDepth', 'volumeShadowMap', 'volumeLightProjection', 'volumeLightDirection', 'volumeLightColor', 'volumeDensity', 'volumeMinimum', 'volumeMaximum', 'volumeColor', 'volumeAmbient', 'volumeDrift', 'volumeSteps', 'volumeAnisotropy', 'volumeShadowAmbient', 'volumeGridFog', 'volumeNoiseAmount', 'volumeNoiseScale', 'volumeHeightFalloff', 'volumeMaxDistance', 'volumeField', 'volumeProfile', 'volumeFlowStrength', 'volumeFlowPeriod', 'volumeLightCount', 'volumeLightPositions[0]', 'volumeLightColors[0]', 'volumeLightDirections[0]', 'volumeLightCones[0]', 'fogSkyVisibility', 'orthographic', 'occlusionTexture', 'occlusionStrength', 'occlusionTexel'];

function postUniformLocations(context, program) {
  return Object.fromEntries(POST_UNIFORMS.map(name => [name, context.getUniformLocation(program, name)]));
}

const MAP_SHADER_FEATURES = ['baseMap', 'normalMap', 'metallicRoughnessMap', 'occlusionMap', 'emissiveMap'];
// Part or material fields that name their shader feature and switch it on when set.
const PRESENT_SHADER_FEATURES = ['skin', 'crowd', 'morph', 'lightMap', 'waterReflection'];
// Material fields that name their shader feature and switch it on above zero.
const POSITIVE_SHADER_FEATURES = ['moss', 'anisotropy', 'iridescence', 'toon', 'boxMapScale'];
// Tags whose look the main fragment shader draws with code that other tags never reach.
const TAG_SHADER_FEATURES = new Set(['floor', 'water', 'foliage', 'terrain', 'grass', 'fire', 'smoke', 'unlit']);

function shaderFeaturesOfLighting(lighting) {
  const features = [];
  if (lighting.spotCount > 0) features.push('spotLights');
  if (lighting.areaCount > 0) features.push('areaLights');
  if (lighting.shadowCasters.length > 0) features.push('localShadows');
  if (lighting.extraFeatures) features.push(...lighting.extraFeatures);
  if (lighting.fillIntensity > 0) features.push('fill');
  return features;
}

/**
 * A few parts that need the same shader features as all of `parts`, plus one instanced pair when any geometry repeats.
 * A renderer built on these compiles the program the whole scene needs; replaceParts then adds the rest without a recompile.
 */
export function shaderFeatureRepresentatives(parts) {
  const covered = new Set();
  const representatives = [];
  const firstOfGeometry = new Map();
  let instancedPair = null;
  for (const part of parts) {
    const features = shaderFeaturesOfParts([part]);
    if ([...features].some(feature => !covered.has(feature))) {
      features.forEach(feature => covered.add(feature));
      representatives.push(part);
    }
    if (!instancedPair && firstOfGeometry.has(part.geometry)) instancedPair = [firstOfGeometry.get(part.geometry), part];
    else if (!firstOfGeometry.has(part.geometry)) firstOfGeometry.set(part.geometry, part);
  }
  if (instancedPair) for (const part of instancedPair) if (!representatives.includes(part)) representatives.push(part);
  return representatives.length > 0 ? representatives : parts.slice(0, 1);
}

function shaderFeaturesOfParts(parts) {
  const features = new Set();
  for (const part of parts) {
    const { material } = part;
    for (const name of PRESENT_SHADER_FEATURES) {
      if (part[name] || material[name]) features.add(name);
    }
    MATERIAL_MAPS.forEach((field, index) => {
      if (material[field]) features.add(MAP_SHADER_FEATURES[index]);
    });
    if (castsTintedShadow(part)) features.add('tintedShadows');
    if (material.environmentProbe) features.add('probe');
    if (material.irradianceGrid) features.add('irradianceGrid');
    if (material.normalMap?.uvTransform) features.add('normalMapTransform');
    Object.keys(material.layerMaps ?? {}).forEach(name => features.add(name));
    if (material.layers) features.add('splat');
    for (const name of POSITIVE_SHADER_FEATURES) {
      if (material[name] > 0) features.add(name);
    }
    if (material.lightMask !== undefined) features.add('lightLinking');
    if ((material.alphaMode ?? 'opaque') !== 'opaque') features.add('alphaMode');
    if (material.subsurface?.weight > 0) features.add('subsurface');
    if (material.snippet) features.add(material.snippet.feature);
    if (materialLayerValue(material, 'clearcoat') > 0) features.add('clearcoat');
    if (materialLayerValue(material, 'sheenColor').some(channel => channel !== 0)) features.add('sheen');
    if (TAG_SHADER_FEATURES.has(material.tag)) features.add(material.tag);
    // Without vertex colours the tint and sky visibility are the constants of the unbound attribute, so no varying carries them.
    if ([part.geometry, ...(part.lods ?? []).map(level => level.geometry)].some(geometry => geometry.colors || geometry.skyVisibility)) features.add('vertexColors');
  }
  return features;
}

function renderPass(material) {
  if (material.transmission > 0) return 'liquid';
  return TRANSLUCENT_TAGS.has(material.tag) ? material.tag : 'opaque';
}

// Regrouping parts that already draw (a mirrored sign change) reuses their cached textures, so it needs no texture bookkeeping.
function partNeedsFullUpload(part, texturesReplaceable = Boolean(texturedReplaceSupport.begin)) {
  return Boolean(part.skin || part.morph || part.geometry.morphTargets || part.geometry.skinIndices || hasMaterialMap(part.material) && !texturesReplaceable);
}

function batchPass(batch) {
  return batch.pass ?? 'opaque';
}

const SKIN_UNIFORMS = ['skinEnabled', 'skinInfluences', 'jointPalette', 'crowdEnabled'];
const ALPHA_UNIFORMS = ['alphaMode', 'alphaCutoff', 'materialOpacity', 'alphaToCoverage', 'doubleSided'];
const DEPTH_ALPHA_UNIFORMS = ['alphaMasked', 'alphaCutoff', 'materialOpacity', 'hasBaseMap', 'baseMap', 'tintPass', 'tintTransmission', 'tintMapSize', 'tintBias', 'opaqueShadow'];
const MORPH_UNIFORMS = ['morphEnabled', 'morphVertexCount', 'morphTargetCount', 'morphWeights[0]', 'morphTargets'];
const ENVIRONMENT_LOOKUP_UNIFORMS = ['environmentSpecular', 'environmentEnabled', 'environmentIntensity', 'environmentRotation', 'environmentLevelMax'];
const ENVIRONMENT_UNIFORMS = [...ENVIRONMENT_LOOKUP_UNIFORMS, 'environmentBrdf', 'environmentIrradiance[0]'];
// Shares a unit with the skin influence texture, which no light-mapped (rigid) batch binds.
const LIGHT_MAP_UNIT = 6;
const ENVIRONMENT_SPECULAR_UNIT = 9;
const ENVIRONMENT_BRDF_UNIT = 10;
const LOCAL_SHADOW_UNIT = 15;
// Tinted shadows: one half float map holds the colour of the light that blended and transmissive casters let through (rgb)
// and the depth of the nearest one (alpha). Units 0 to 15 are all taken somewhere, and 13 is the one only a part with three
// layer textures or splat layers also reads, so those parts are blind to the tint (batch.tintBlind).
const TINT_UNIT = 13;
const TINT_MAP_SIZE = 1024;
// The shadow program's opaqueShadow sampler reads the sun map on this unit in the tint draw. Unit 0 would read the map while
// the opaque pass renders into it, a feedback loop that drops every opaque shadow caster.
const OPAQUE_SHADOW_UNIT = 2;
const LIGHT_UNIFORMS = ['pointLightCount', 'pointLightPositions[0]', 'pointLightColors[0]', 'pointLightRadii[0]', 'pointLightShadowTiles[0]',
  'spotLightCount', 'spotLightPositions[0]', 'spotLightColors[0]', 'spotLightDirections[0]', 'spotLightParameters[0]',
  'areaLightCount', 'areaLightPositions[0]', 'areaLightColors[0]', 'areaLightNormals[0]', 'areaLightTangents[0]',
  'localShadowAtlas', 'localShadowMatrices[0]', 'localShadowTexelAngles[0]', 'keyColor', 'fillIntensity', 'ambientIntensity', 'specularAntiAliasing'];
const SPLAT_UNIFORMS = ['splatEnabled', 'splatColor', 'splatNormal', 'splatPacked', 'splatMask', 'splatLayer[0]', 'splatTint[0]', 'splatSlope[0]', 'splatHeightRange[0]', 'splatMaskChannel[0]', 'splatMaskInvert[0]', 'splatBlend', 'splatOptions', 'splatMaskBounds', 'splatVariation'];

function validateMaterialMaps(material) {
  if (PROCEDURAL_MATERIAL_TAGS.has(material.tag)) {
    for (let index = 1; index < MATERIAL_MAPS.length; index++) {
      // Scanned leaf cards carry a normal map; the swaying tags apply it on top of their canopy normal.
      const leafNormalMap = MATERIAL_MAPS[index] === 'normalMap' && SWAYING_TAGS.has(material.tag);
      if (material[MATERIAL_MAPS[index]] && !leafNormalMap) throw new Error('Material maps require a standard PBR material tag. Procedural tags accept only a base map, and foliage and grass also a normal map.');
    }
  }
  if (material.tag === 'unlit' && (material.normalMap || material.metallicRoughnessMap || material.occlusionMap)) {
    throw new Error('Unlit materials support only base and emissive maps.');
  }
  const normalScale = material.normalScale ?? DEFAULT_NORMAL_SCALE;
  if (normalScale.length !== 2 || !Number.isFinite(normalScale[0]) || !Number.isFinite(normalScale[1]) || !Number.isFinite(Math.fround(normalScale[0])) || !Number.isFinite(Math.fround(normalScale[1]))) throw new Error('normalScale must contain two finite floats.');
  const occlusionStrength = material.occlusionStrength ?? 1;
  if (!Number.isFinite(occlusionStrength) || occlusionStrength < 0 || occlusionStrength > 1) throw new Error('occlusionStrength must be within zero and one.');
  validateMoss(material);
}

const DEFAULT_MOSS_COLOR = Object.freeze([0.05, 0.085, 0.02]);

function validateMoss(material) {
  if (material.moss === undefined) return;
  if (typeof material.moss !== 'number' || !(material.moss >= 0 && material.moss <= 1)) throw new Error('moss must be within zero and one.');
  if (material.moss > 0 && PROCEDURAL_MATERIAL_TAGS.has(material.tag)) throw new Error('Moss needs a standard PBR material tag.');
  const color = material.mossColor ?? DEFAULT_MOSS_COLOR;
  if (!Array.isArray(color) || color.length !== 3 || !color.every(Number.isFinite)) throw new Error('mossColor must be three linear RGB numbers.');
}

/** Moss amount and linear colour, as the shader's materialMoss uniform. */
function mossState(material) {
  return [material.moss ?? 0, ...(material.mossColor ?? DEFAULT_MOSS_COLOR)];
}

function materialMapState(material) {
  validateMaterialMaps(material);
  const normalScale = material.normalScale ?? DEFAULT_NORMAL_SCALE;
  const occlusionStrength = material.occlusionStrength ?? 1;
  if (material.layers || material.splat) requireSplatSupport().validate(material);
  if (material.layers && PROCEDURAL_MATERIAL_TAGS.has(material.tag)) throw new Error('Splat layers require a standard PBR material tag.');
  return [...MATERIAL_MAPS.map(field => material[field] ?? null), normalScale[0], normalScale[1], occlusionStrength, ...mossState(material), material.boxMapScale ?? 0, material.boxMapAxis ?? 1, ...lightMapState(material), material.layers ?? null, material.splat ?? null, material.layerMaps ?? null, material.environmentProbe ?? null, material.waterReflection ?? null, material.irradianceGrid ?? null];
}

// A baked light map reads the second UV set, so it is only drawn for parts that cannot be skinned or morphed.
function lightMapState(material) {
  if (!material.lightMap) return [null, 0];
  const scale = material.lightMapScale ?? 1;
  if (!Number.isFinite(scale) || scale < 0) throw new RangeError('lightMapScale must be a nonnegative number.');
  if ((material.lightMap.colorSpace ?? 'srgb') !== 'srgb') throw new Error('lightMap requires an srgb texture descriptor.');
  return [material.lightMap, scale];
}

function validateAlphaMaterial(material) {
  const alphaMode = material.alphaMode ?? 'opaque';
  if (!Object.hasOwn(ALPHA_MODES, alphaMode)) throw new Error("alphaMode must be 'opaque', 'mask', 'blend' or 'add'.");
  for (const field of ['alphaCutoff', 'opacity']) {
    const value = material[field] ?? 1;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${field} must be a number within zero and one.`);
  }
  if (material.doubleSided !== undefined && typeof material.doubleSided !== 'boolean') throw new TypeError('doubleSided must be a boolean');
}

/** Opacity of one instance: blend and add parts carry it per instance, so it never splits a batch. */
function instanceOpacity(material) {
  const alphaMode = material.alphaMode ?? 'opaque';
  return isTranslucentMode(alphaMode) ? (material.opacity ?? 1) + (material.opacityBias ?? 0) : 1;
}

/** Alpha settings that every instance of one draw call must share. Fields that a mode ignores, and the per-instance opacity, are normalized away. */
function materialAlphaState(material) {
  validateAlphaMaterial(material);
  const alphaMode = material.alphaMode ?? 'opaque';
  const alphaCutoff = alphaMode === 'mask' ? material.alphaCutoff ?? 0.5 : 0;
  const opacity = alphaMode === 'mask' ? (material.opacity ?? 1) + (material.opacityBias ?? 0) : 1;
  return [alphaMode, alphaCutoff, opacity, material.doubleSided === true];
}

// A decal or depth layer draws with a scoped polygon offset so it wins against the surface it lies on (z-fighting).
// Larger layers win over smaller ones; geometry never moves.

// Additive light is not a shadow caster unless the part asks for it. A blended part lying on a surface (a decal) would shade
// the surface it covers, so it casts only when asked too. A shadow catcher only shows the shadow it receives, so it never
// casts one unless the part asks for it. Other blended parts cast a shadow weighted by their opacity.
function castsShadow(part) {
  const alphaMode = part.material.alphaMode ?? 'opaque';
  const decal = alphaMode === 'blend' && depthLayerOf(part) > 0;
  return part.castShadow ?? !(part.shadowCatcher === true || alphaMode === 'add' || decal);
}

/** A caster whose shadow is weighted by opacity or tinted by its colour: blended and transmissive parts. */
function castsTintedShadow(part) {
  return castsShadow(part) && part.material.tag !== 'floor' && ((part.material.alphaMode ?? 'opaque') === 'blend' || part.material.transmission > 0);
}

const receivesShadow = part => part.receiveShadow !== false;

// Uniform value of a batch: 0 draws normally, 1 is a holdout (zero colour, zero alpha), 2 is a shadow catcher (black, alpha = shadow).
const compositeModeOf = part => (part.holdout === true ? 1 : part.shadowCatcher === true ? 2 : 0);

const BOOLEAN_PART_FLAGS = ['castShadow', 'receiveShadow', 'holdout', 'shadowCatcher', 'visible'];

function validatePartFlags(part) {
  for (const flag of BOOLEAN_PART_FLAGS) {
    if (part[flag] !== undefined && typeof part[flag] !== 'boolean') throw new TypeError(`${flag} must be a boolean`);
  }
  if (part.holdout === true && part.shadowCatcher === true) throw new Error(`A part is a holdout or a shadow catcher, not both: ${part.name}`);
}

/** A hidden part keeps its slot in the batch but draws and casts nothing: its instance matrices are packed as zeros. */
const isHidden = part => part.visible === false || part.visibility?.visible === false;

function hasMaterialMap(material) {
  return MATERIAL_MAPS.some(field => material[field]);
}

// Math.fround turns a double of 2^128 - 2^103 or more into Infinity, so that is the first value that is not a finite float.
const FLOAT_OVERFLOW = 2 ** 128 - 2 ** 103;

function finiteFloat(value) {
  return typeof value === 'number' && value > -FLOAT_OVERFLOW && value < FLOAT_OVERFLOW;
}

function finiteVector(value, size) {
  if (value?.length !== size) return false;
  if (value instanceof Float32Array) {
    // Every float is already in range, so it is finite exactly when 0 * value is 0 and not NaN. This runs without a branch per element.
    let zeroSum = 0;
    for (let index = 0; index < size; index++) zeroSum += value[index] * 0;
    return zeroSum === 0;
  }
  for (let index = 0; index < size; index++) if (!finiteFloat(value[index])) return false;
  return true;
}

function validateTransform(part, normalMatrix = mat3.create()) {
  if (!finiteVector(part.matrix, 16)) throw new Error(`Invalid transform: ${part.name}`);
  if (!mat3.normalFromMat4(normalMatrix, part.matrix) || !finiteVector(normalMatrix, 9)) throw new Error(`Singular transform: ${part.name}`);
  // An absent emissive colour or assembly offset packs as the base colour or zero, which need no second check.
  const material = part.material;
  const assembly = part.assembly;
  if (!finiteVector(material.color, 3) || (material.emissiveColor !== undefined && !finiteVector(material.emissiveColor, 3)) ||
      (assembly && (!finiteVector(assembly.offset ?? ZERO_VECTOR, 3) || !finiteVector(assembly.detailOffset ?? ZERO_VECTOR, 3)))) {
    throw new Error(`Invalid instance vector: ${part.name}`);
  }
  if (!finiteFloat(part.material.metallic) || !finiteFloat(part.material.roughness) || !finiteFloat(part.material.emission ?? 0)) throw new Error(`Invalid material: ${part.name}`);
  return normalMatrix;
}

// TypedArray.set costs more per call than three stores, and a loop shared by every vector length reads its source through a slow polymorphic path.
function copyVector3(target, offset, source) {
  target[offset] = source[0];
  target[offset + 1] = source[1];
  target[offset + 2] = source[2];
}

/**
 * True when the matrix reflects space (negative determinant of its upper 3x3, column major), which reverses the screen
 * winding of every triangle. The renderer owns this: it groups such parts apart and draws them with clockwise front faces.
 */
export function isMirroredMatrix(matrix) {
  const determinant = matrix[0] * (matrix[5] * matrix[10] - matrix[6] * matrix[9])
    - matrix[4] * (matrix[1] * matrix[10] - matrix[2] * matrix[9])
    + matrix[8] * (matrix[1] * matrix[6] - matrix[2] * matrix[5]);
  return determinant < 0;
}

function packInstance(data, index, part, normalMatrix) {
  const offset = index * INSTANCE_STRIDE;
  const material = part.material;
  if (isHidden(part)) {
    data.fill(0, offset, offset + 25);
  } else {
    data.set(part.matrix, offset);
    data.set(normalMatrix, offset + 16);
  }
  copyVector3(data, offset + 25, material.color);
  data[offset + 28] = material.metallic;
  data[offset + 29] = material.roughness;
  data[offset + 30] = material.emission ?? 0;
  data[offset + 31] = materialTags[material.tag] ?? 0;
  copyVector3(data, offset + 32, part.assembly?.offset ?? ZERO_VECTOR);
  copyVector3(data, offset + 35, part.assembly?.detailOffset ?? ZERO_VECTOR);
  copyVector3(data, offset + 38, material.emissiveColor ?? material.color);
  data[offset + OPACITY_OFFSET] = instanceOpacity(material);
}

// The objectId mode of RENDER_PASS_MODES in render-passes.js.
const OBJECT_ID_PASS_MODE = 5;

function isCullable(parts) {
  const first = parts[0];
  if (first.skin || first.morph) return false;
  if (DEFORMING_TAGS.has(first.material.tag) && !SWAYING_TAGS.has(first.material.tag)) return false;
  if (renderPass(first.material) !== 'opaque' || isTranslucentMode(materialAlphaState(first.material)[0])) return false;
  return parts.every(part => !part.assembly || part.crowd);
}

function validateLods(part, levels) {
  if (!Array.isArray(levels) || levels.length < 2 || levels[0].geometry !== part.geometry) {
    throw new TypeError(`lods must list level 0 (the own geometry of the part) and at least one coarser level: ${part.name}`);
  }
  levels.forEach((level, index) => {
    if (!level.geometry?.positions || !level.geometry.indices) throw new TypeError(`Every lods entry needs a geometry: ${part.name}`);
    if (!Number.isFinite(level.error) || level.error < 0 || (index > 0 && level.error < levels[index - 1].error)) {
      throw new RangeError(`lods errors must be finite and not decrease from level to level: ${part.name}`);
    }
  });
}

/** Every geometry a part can draw: its own, the levels of `lods` and the levels of `shadowLods`. */
function partGeometries(part) {
  const drawn = [part.geometry, ...(part.lods ?? []).map(level => level.geometry), ...(part.shadowLods ?? []).map(level => level.geometry)];
  // A part with hidden flush faces cut away draws its cut geometry, which lives and is released like any other.
  const clipped = flushOrderOf(part)?.geometry;
  if (clipped) drawn.push(clipped);
  return drawn;
}

/** The state of one list of levels: errors, geometries, the draw of each level once it is first needed, and a selection. */
function createLevelSet(levels, instanceCount) {
  return { levelErrors: levels.map(level => level.error), levelGeometries: levels.map(level => level.geometry), levelDraws: [], selection: new InstanceSelection(instanceCount, levels.length) };
}

/**
 * The studio floor sits at y 0.019. When that would hide more than a tenth of the scene's height (a pencil, a hand that
 * hangs below y 0), it sits 2% up from the scene's lowest point instead, so small objects are not buried (issue #468).
 * Scenes a metre or more tall resting on y 0, and large scenes that dip below it, keep the floor where it was.
 */
export function studioFloorHeight(parts) {
  let bottom = Infinity;
  let top = -Infinity;
  for (const { geometry, matrix } of parts) {
    if (!geometry?.positions?.length || !matrix) continue;
    // The world heights of the part's local box: each axis adds its row-one term at the box's lower or upper end.
    const { minimum, maximum } = geometryBoundingSphere(geometry);
    let low = matrix[13];
    let spread = 0;
    for (let axis = 0; axis < 3; axis++) {
      const scale = matrix[1 + axis * 4];
      low += Math.min(scale * minimum[axis], scale * maximum[axis]);
      spread += Math.abs(scale) * (maximum[axis] - minimum[axis]);
    }
    bottom = Math.min(bottom, low);
    top = Math.max(top, low + spread);
  }
  const height = top - bottom;
  return 0.019 - bottom > height * 0.1 ? bottom + height * 0.02 : 0.019;
}

function groundPart(height = 0.019) {
  return {
    name: 'Studio floor',
    geometry: {
      positions: new Float32Array([-100, height, -100, -100, height, 100, 100, height, 100, 100, height, -100]),
      normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]),
      indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
    },
    matrix: mat4.create(),
    material: { color: [0.04, 0.05, 0.06], metallic: 0, roughness: 1, emission: 0, tag: 'floor' },
  };
}

// The skin and morph code loads with skinning.js and morph.js (any module that makes a pose imports them), so a part without
// a skin or morph targets never reaches it.
const skinSupport = () => requireDeformationSupport('validateSkinGeometry', 'skinning.js');
const morphSupport = () => requireDeformationSupport('validateMorphGeometry', 'morph.js');
const hasSkinData = part => Boolean(part.skin || part.geometry.skinIndices || part.geometry.skinWeights);
const hasMorphData = part => Boolean(part.morph || part.geometry.morphTargets !== undefined);

export function groupParts(parts, batching = true) {
  const groups = new Map();
  const batches = [];
  const morphInfos = new Map();
  const materialKeyValues = new Map();
  const materialKeyTails = new Map();
  for (const part of parts) {
    validateTransform(part);
    validatePartFlags(part);
    if (hasSkinData(part)) {
      const { validateSkinGeometry, validateSkinPose } = skinSupport();
      validateSkinGeometry(part.geometry, part.skin);
      if (part.skin) validateSkinPose(part.skin, part.geometry, part.matrix);
    }
    if (part.skin && PROCEDURAL_MATERIAL_TAGS.has(part.material.tag)) throw new Error('Skinned parts require a standard material tag.');
    if (hasMorphData(part)) {
      const { validateMorphGeometry, validateMorphPose, validateMorphTransform } = morphSupport();
      if (!morphInfos.has(part.geometry)) morphInfos.set(part.geometry, validateMorphGeometry(part.geometry, part.morph));
      else validateMorphPose(part.morph, morphInfos.get(part.geometry));
      if (part.morph) validateMorphTransform(part.morph, morphInfos.get(part.geometry), part.matrix, part.skin);
    }
    if (part.morph && PROCEDURAL_MATERIAL_TAGS.has(part.material.tag)) throw new Error('Morphed parts require a standard material tag.');
    const key = batching ? part.geometry : part;
    if (!groups.has(key)) groups.set(key, new Map());
    let maps = groups.get(key);
    // Thousands of parts share a few materials, so the material half of the key is built once per material.
    let materialValues = materialKeyValues.get(part.material);
    if (!materialValues) {
      materialValues = [...materialMapState(part.material), ...materialLayerState(part.material)];
      materialKeyValues.set(part.material, materialValues);
    }
    let materialTail = materialKeyTails.get(part.material);
    if (!materialTail) {
      materialTail = [renderPass(part.material), ...materialAlphaState(part.material), part.material.aovMap ?? null, part.material.transmissionMap ?? null, ...(part.material.aov ?? ZERO_VECTOR)];
      materialKeyTails.set(part.material, materialTail);
    }
    for (const value of [...materialValues, part.skin ?? null, part.material.snippet, part.crowd ?? null, part.morph ?? null, castsShadow(part), receivesShadow(part), compositeModeOf(part), depthLayerOf(part), flushOrderOf(part), part.lods ?? null, part.shadowLods ?? null, isMirroredMatrix(part.matrix), ...materialTail]) {
      if (!maps.has(value)) maps.set(value, new Map());
      maps = maps.get(value);
    }
    if (!maps.has('parts')) {
      const batch = [];
      maps.set('parts', batch);
      batches.push(batch);
    }
    maps.get('parts').push(part);
  }
  return batches;
}

export function textureDescriptorInfo(map, maximumSize = Infinity) {
  const width = map.image?.naturalWidth ?? map.image?.width;
  const height = map.image?.naturalHeight ?? map.image?.height;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 || width > maximumSize || height > maximumSize) throw new Error('Texture image dimensions are invalid or exceed MAX_TEXTURE_SIZE.');
  if (![0, 1].includes(map.uvChannel ?? 0)) throw new Error('Only texture UV channels 0 and 1 are supported.');
  if (map.transform || map.offset || map.repeat || map.rotation !== undefined || map.extensions && Object.keys(map.extensions).length) throw new Error('Texture transforms and extensions are unsupported. Bake them into UV channel 0.');
  if (map.colorSpace && !['srgb', 'linear'].includes(map.colorSpace)) throw new Error('Texture color space must be srgb or linear.');
  const wrapS = map.wrapS ?? 10497;
  const wrapT = map.wrapT ?? 10497;
  const minFilter = map.minFilter ?? 9987;
  const magFilter = map.magFilter ?? 9729;
  if (![10497, 33071, 33648].includes(wrapS) || ![10497, 33071, 33648].includes(wrapT)) throw new Error('Unsupported texture wrap mode.');
  if (![9728, 9729, 9984, 9985, 9986, 9987].includes(minFilter) || ![9728, 9729].includes(magFilter)) throw new Error('Unsupported texture filtering mode.');
  const compressed = map.image.compressed;
  // Precompressed mips come with the image and are never generated. The image supplies its own filter and byte count.
  if (compressed) return { width, height, wrapS, wrapT, minFilter: compressed.minFilter(minFilter), magFilter, mipmaps: false, bytes: compressed.bytes };
  const mipmaps = minFilter >= 9984;
  return { width, height, wrapS, wrapT, minFilter, magFilter, mipmaps, bytes: estimateTextureBytes(width, height, { mipmaps }) };
}

function sampleCount(context, format, requested) {
  const colorCounts = Array.from(context.getInternalformatParameter(context.RENDERBUFFER, format, context.SAMPLES));
  const depthCounts = Array.from(context.getInternalformatParameter(context.RENDERBUFFER, context.DEPTH_COMPONENT24, context.SAMPLES));
  return Math.max(0, ...colorCounts.filter(count => count <= requested && depthCounts.includes(count)));
}

// Light-mapped geometry uploads its two UV sets as one four-wide attribute (zeros where channel 0 is absent).
function uvBufferBytes(geometry) {
  if (!geometry.lightUvs) return geometry.uvs?.byteLength ?? 0;
  return geometry.lightUvs.byteLength * 2;
}

function interleaveUvSets(geometry) {
  const vertexCount = geometry.lightUvs.length / 2;
  const combined = new Float32Array(vertexCount * 4);
  for (let vertex = 0; vertex < vertexCount; vertex++) {
    combined[vertex * 4] = geometry.uvs?.[vertex * 2] ?? 0;
    combined[vertex * 4 + 1] = geometry.uvs?.[vertex * 2 + 1] ?? 0;
    combined[vertex * 4 + 2] = geometry.lightUvs[vertex * 2];
    combined[vertex * 4 + 3] = geometry.lightUvs[vertex * 2 + 1];
  }
  return combined;
}

// Sky visibility rides in the fourth component of the vertex colour attribute, so the attribute layout stays the same.
function interleaveColorsWithSkyVisibility(geometry) {
  const vertexCount = geometry.skyVisibility.length;
  const combined = new Float32Array(vertexCount * 4);
  for (let vertex = 0; vertex < vertexCount; vertex++) {
    for (let channel = 0; channel < 3; channel++) {
      combined[vertex * 4 + channel] = geometry.colors ? geometry.colors[vertex * 3 + channel] : 1;
    }
    combined[vertex * 4 + 3] = geometry.skyVisibility[vertex];
  }
  return combined;
}

function geometryBufferBytes(geometry) {
  const plainBytes = ['positions', 'normals', 'colors', 'indices'].reduce((total, field) => total + (geometry[field]?.byteLength ?? 0), uvBufferBytes(geometry));
  if (!geometry.skyVisibility) return plainBytes;
  return plainBytes - (geometry.colors?.byteLength ?? 0) + geometry.skyVisibility.length * 16;
}

function validateReplacementGeometry(geometry) {
  const vertexCount = geometry.positions?.length / 3;
  if (!(geometry.positions instanceof Float32Array) || !Number.isInteger(vertexCount) || vertexCount < 1 ||
      !(geometry.normals instanceof Float32Array) || geometry.normals.length !== vertexCount * 3 ||
      !(geometry.indices instanceof Uint32Array) || geometry.indices.length < 3 || geometry.indices.length % 3 !== 0) {
    throw new TypeError('Replacement geometry needs matching Float32 positions/normals and Uint32 triangles.');
  }
  // Plain loops: replaceParts runs this every frame for streamed meshes, where callback-based
  // `every` cost about ten times more than the upload itself.
  for (const [field, count] of [['positions', 3], ['normals', 3], ['uvs', 2], ['colors', 3]]) {
    const values = geometry[field];
    if (!values && ['uvs', 'colors'].includes(field)) continue;
    if (!(values instanceof Float32Array) || values.length !== vertexCount * count || !allFinite(values)) {
      throw new TypeError(`Replacement ${field} must contain finite matching Float32 data.`);
    }
  }
  const indices = geometry.indices;
  for (let index = 0; index < indices.length; index++) {
    if (indices[index] >= vertexCount) throw new RangeError('Replacement triangle indices must address existing vertices.');
  }
}

function allFinite(values) {
  for (let index = 0; index < values.length; index++) {
    const value = values[index];
    // NaN fails both comparisons; infinities fail one.
    if (!(value > -Infinity && value < Infinity)) return false;
  }
  return true;
}

export class Renderer67 {
  constructor(canvas, parts, { batching = true, pixelRatio = 1.5, benchmark = false, world = false, ground = true, transparent = false, samples = 4, hdr = false, depth = false, memoryBudgetMiB, environment = {}, shadowBounds = {}, shadowCascades = null, culling = true, lodPixelError = 1, createGpuTimer = null, skyOpenness = null, fogSkyVisibility = null, shading = 'full', viewTransform = 'aces', look = null, resolveCoplanar = false, reversedDepth = 'auto', deferProgramLink = false, deferEnvironmentPrefilter = false } = {}) {
    this.canvas = canvas;
    this.sceneParts = parts;
    // `skyOpenness` from closed-room.js is passed in, which keeps the ray code out of scenes without volume fog.
    this.skyOpenness = skyOpenness;
    // `fogSkyVisibility` from fog-sky-visibility.js is passed in for the same reason; without it the post shader has no grid.
    this.fogSkyVisibility = fogSkyVisibility;
    this.fogFieldOverride = null;
    this.fogFieldTexture = null;
    // fog-shader.js creates the light buffers on the first frame that draws a volume fog.
    this.fogLightBuffers = null;
    // `createGpuTimer` from adaptive-quality.js is passed in, which keeps the timer code out of scenes that do not time frames.
    this.createGpuTimer = createGpuTimer;
    this.gpuTimer = undefined;
    /** Milliseconds the GPU took for a recent frame, when `createGpuTimer` is given. */
    this.gpuMilliseconds = null;
    this.culling = culling;
    this.lodPixelError = lodPixelError;
    this.frustumPlanes = new Float32Array(24);
    if (!Number.isInteger(samples) || samples < 1) throw new Error('MSAA sample count must be a positive integer.');
    if (!SHADING_MODES.includes(shading)) throw new Error(`shading must be one of ${SHADING_MODES.join(', ')}.`);
    this.shading = shading;
    if (new Set(parts).size !== parts.length) throw new Error('Scene parts must have distinct object identities for animation.');
    this.lighting = createLightingState();
    updateLightingState(this.lighting, environment, { world });
    const volume = resolveVolumeFog(environment.volumeFog);
    if (volume.density > 0 && (!depth || benchmark || transparent || !hdr)) throw new Error('Volume fog requires depth:true, hdr:true, an opaque canvas and normal rendering');
    this.context = canvas.getContext('webgl2', { antialias: true, alpha: Boolean(transparent), premultipliedAlpha: true, powerPreference: 'high-performance' });
    if (!this.context) throw new Error('WebGL2 is unavailable. Enable hardware acceleration or use a supported browser.');
    this.transparent = Boolean(transparent);
    this.pixelRatio = pixelRatio;
    this.benchmark = benchmark;
    this.depth = Boolean(depth && !benchmark);
    this.world = world;
    this.environment = environment;
    this.fittedFogDensity = world ? fittedFogDensity(parts) : undefined;
    this.shadowBounds = shadowBounds;
    /** Set by installCoplanarDiagnostics (coplanar-overlap.js): called with the batches, returns coplanar-overlap warnings. */
    this.coplanarDiagnostics = null;
    /** `false` keeps the standard depth buffer; the default draws every colour pass with reversed-Z and a 32-bit float depth buffer where EXT_clip_control exists. */
    this.reversedDepthMode = reversedDepth;
    const reversedDepthWanted = reversedDepth !== false && !benchmark && Boolean(this.context.getExtension?.('EXT_clip_control'));
    /** Warnings about the last frame drawn, in the shape of `agent-diagnostics.js`; see `frame-diagnostics.js`. */
    this.diagnostics = [];
    this.activeLightDirection = environment.lightDirection ?? [-3, 6, 4];
    this.shadowCascades = shadowCascades;
    this.renderTargets = new RenderTargetLedger();
    // The constructor options are the default; a frame's environment (a recipe's viewTransform and look) overrides them.
    this.defaultViewTransform = viewTransform;
    this.defaultLook = look;
    this.viewTransform = 'aces';
    this.look = null;
    this.lookSource = null;
    this.selectViewTransform(viewTransform, look);
    this.hdr = Boolean(hdr && !benchmark && this.context.getExtension('EXT_color_buffer_float'));
    if (volume.density > 0 && !this.hdr) throw new Error('Volume fog requires EXT_color_buffer_float for HDR rendering');
    this.multisampleSamples = benchmark ? 0 : sampleCount(this.context, this.hdr ? this.context.RGBA16F : this.context.RGBA8, Math.min(shading === 'light' ? Math.min(samples, LIGHT_SHADING_MAXIMUM_SAMPLES) : samples, this.context.getParameter(this.context.MAX_SAMPLES)));
    this.capabilities = { hdr: this.hdr, hdrRequested: Boolean(hdr), hdrFallbackReason: hdr && !this.hdr ? benchmark ? 'HDR is disabled in benchmark mode' : 'EXT_color_buffer_float is unavailable' : null, samples: this.multisampleSamples };
    this.geometryBytes = 0;
    this.geometryBuffers = new Map();
    this.batching = batching;
    this.groundPart = ground === true ? groundPart(studioFloorHeight(parts)) : ground || null;
    this.buffers = [];
    this.batches = [];
    this.partLocations = new Map();
    this.updateBatches = new Set();
    // Addons plug in here: full-frame effects (camera-effects.js) run between the resolve and the post pass, and
    // render-passes.js sets passSupport. None by default.
    this.postStages = [];
    this.passSupport = null;
    this.updateSkins = new Set();
    this.updateMorphs = new Set();
    this.skinTextures = new Map();
    this.influenceTextures = new Map();
    this.morphTextures = new Map();
    this.textures = new Map();
    this.splatResources = new Map();
    this.textureBytes = 4;
    this.shadowsDirty = true;
    this.windState = { time: 0, strength: 0.3 };
    // The shadow map the constructor draws uses no assembly, so a first frame with none does not draw it again.
    this.assemblyAmount = 0;
    // `resolveCoplanar` is resolveFlushParts from the coplanar-overlap addon, passed in so the search stays out of the core bundle.
    // It ranks near-coplanar triangles (flushOrderOf in depth-layer.js) before the parts are grouped into batches.
    if (resolveCoplanar && typeof resolveCoplanar !== 'function') throw new TypeError('resolveCoplanar is resolveFlushParts from 67js/addons/coplanar-overlap.');
    if (resolveCoplanar && !benchmark) resolveCoplanar(parts);
    this.fitParts = this.groundPart ? [...parts, this.groundPart] : parts;
    const groups = groupParts(this.fitParts, batching);
    const textureLimit = this.context.getParameter(this.context.MAX_TEXTURE_SIZE);
    this.hasSkins = groups.some(group => group[0].skin || group[0].crowd);
    this.hasMorphs = groups.some(group => group[0].morph);
    if (this.hasSkins && (this.context.getParameter(this.context.MAX_VERTEX_TEXTURE_IMAGE_UNITS) < 2 || this.context.getParameter(this.context.MAX_COMBINED_TEXTURE_IMAGE_UNITS) < 8)) throw new Error('GPU skinning requires two vertex texture units and eight combined texture units.');
    if (this.hasMorphs && (this.context.getParameter(this.context.MAX_VERTEX_TEXTURE_IMAGE_UNITS) < (this.hasSkins ? 3 : 1) || this.context.getParameter(this.context.MAX_COMBINED_TEXTURE_IMAGE_UNITS) < 9)) throw new Error('GPU morphing requires one additional vertex texture unit and nine combined texture units.');
    const morphGeometries = new Set();
    for (const group of groups) {
      const part = group[0];
      if (!part.morph || morphGeometries.has(part.geometry)) continue;
      const texelCount = part.geometry.positions.length / 3 * part.geometry.morphTargets.length * 2;
      this.textureBytes += morphSupport().skinTextureLayout(texelCount, textureLimit, 2).bytes;
      morphGeometries.add(part.geometry);
    }
    const poses = new Set();
    const skinGeometries = new Set();
    for (const group of groups) {
      const part = group[0];
      if (part.crowd && !poses.has(part.crowd)) {
        this.textureBytes += skinSupport().skinTextureLayout(part.crowd.data.length / 4, textureLimit, 4).bytes;
        poses.add(part.crowd);
      }
      if (!part.skin) continue;
      if (!poses.has(part.skin)) this.textureBytes += skinSupport().skinTextureLayout(part.skin.jointMatrices.length / 4, textureLimit, 4).bytes;
      if (!skinGeometries.has(part.geometry)) this.textureBytes += skinSupport().skinTextureLayout(part.geometry.positions.length / 3 * 2, textureLimit, 2).bytes;
      poses.add(part.skin);
      skinGeometries.add(part.geometry);
    }
    const maps = new Set();
    for (const group of groups) {
      const material = group[0].material;
      for (const [field, map] of [...MATERIAL_MAPS, 'lightMap'].map(name => [name, material[name]]).concat(Object.entries(material.layerMaps ?? {}))) {
        if (!map) continue;
        const info = textureDescriptorInfo(map, textureLimit);
        if (['normalMap', 'metallicRoughnessMap', 'occlusionMap'].includes(field) && map.colorSpace !== 'linear') throw new Error(`${field} requires a linear texture descriptor.`);
        if (field === 'emissiveMap' && (map.colorSpace ?? 'srgb') !== 'srgb') throw new Error('emissiveMap requires an srgb texture descriptor.');
        if (!maps.has(map)) this.textureBytes += info.bytes;
        maps.add(map);
      }
    }
    this.splatBytes = 0;
    const splatLayerSets = new Set();
    for (const group of groups) {
      const material = group[0].material;
      if (!material.layers || splatLayerSets.has(material.layers)) continue;
      splatLayerSets.add(material.layers);
      this.splatBytes += requireSplatSupport().textureBytes(requireSplatSupport().resolveSize(material, textureLimit), material.layers.length) + (material.splat?.maskMap ? textureDescriptorInfo(material.splat.maskMap, textureLimit).bytes : 0);
    }
    this.textureBytes += this.splatBytes;
    this.capabilities.maximumTextureSize = textureLimit;
    this.environmentResources = null;
    this.environmentBackgroundProgram = null;
    this.environmentBytes = !benchmark && environment.map ? requireEnvironmentSupport().estimateBytes(environment.map, textureLimit) : 0;
    this.textureBytes += this.environmentBytes;
    for (const group of groups) {
      const geometry = group[0].geometry;
      if (geometry.uvs && geometry.uvs.length !== geometry.positions.length / 3 * 2) throw new Error('Geometry UV count must match the vertex count.');
      if (hasMaterialMap(group[0].material) && !geometry.uvs && !geometry.lightUvs && !group[0].material.boxMapScale) throw new Error('Textured geometry requires UV channel 0.');
      for (const coordinate of geometry.uvs ?? []) {
        if (!Number.isFinite(coordinate)) throw new Error('Geometry UVs must be finite.');
      }
      if (geometry.colors && geometry.colors.length !== geometry.positions.length) throw new Error('Geometry colors must contain RGB for every vertex.');
    }
    const expectedGeometryBytes = groups.reduce((total, group) => total + geometryBufferBytes(group[0].geometry) + group.length * INSTANCE_STRIDE * 4, 0);
    this.memoryBudgetMiB = planRenderSize({ width: Math.max(1, canvas.clientWidth), height: Math.max(1, canvas.clientHeight), pixelRatio, samples: this.samples, memoryBudgetMiB, geometryBytes: expectedGeometryBytes, textureBytes: this.textureBytes, hdr: this.hdr, bloom: !benchmark, depth: this.depth, maximumSize: textureLimit }).memoryBudgetMiB;
    this.view = mat4.create();
    this.projection = mat4.create();
    this.viewProjection = mat4.create();
    this.lightProjection = mat4.create();
    this.shadowBiasPerSlope = 0;
    this.inverseViewProjection = mat4.create();
    this.shaderFeatures = shaderFeaturesOfParts(groups.flat());
    if (groups.some(group => group.length > 1)) this.shaderFeatures.add('instanced');
    this.shaderFeatures.add(environment.map ? 'environmentMap' : 'studioLighting');
    shaderFeaturesOfLighting(this.lighting).forEach(feature => this.shaderFeatures.add(feature));
    if (shading === 'light') this.shaderFeatures.add(LIGHT_SHADING_FEATURE);
    if (shadowCascades) this.shaderFeatures.add(shadowCascades.shaderFeature);
    // Cascades replace the single map the tint is cut against, and the tint map is a half float render target.
    if (this.shaderFeatures.has('tintedShadows') && (shadowCascades || !this.context.getExtension('EXT_color_buffer_float'))) this.shaderFeatures.delete('tintedShadows');
    this.tintedShadowsActive = this.shaderFeatures.has('tintedShadows');
    // The camera-relative vertex line is part of the first compile, so reversed depth does not compile the main program twice.
    if (reversedDepthWanted) prepareCameraRelativeProgram(this);
    const pending = {
      main: this.startMainProgram(),
      depth: startProgram(this.context, createDepthVertexShader(this.shaderFeatures), createDepthFragmentShader(this.shaderFeatures)),
    };
    if (!benchmark) {
      pending.post = startProgram(this.context, fullscreenVertex, this.withViewTransform(postFragment, 'post'));
      pending.sky = startProgram(this.context, fullscreenVertex, skyFragment);
      pending.bloom = startProgram(this.context, fullscreenVertex, bloomFragment);
      if (environment.map) this.startEnvironmentPrograms();
    }
    // The driver links the programs on its own threads while the textures and buffers upload; only then is the link result read.
    groups.forEach((group) => this.batches.push(this.uploadBatch(group)));
    this.pendingConstruction = { pending, parts, environment };
    this.deferEnvironmentPrefilter = deferEnvironmentPrefilter;
    if (!deferProgramLink) this.finishConstruction();
  }

  // The second half of construction, which reads the link results. Reading a result waits for the driver, so a page that
  // builds a heavy renderer passes deferProgramLink and awaits programsReady() instead of freezing for the whole compile.
  finishConstruction() {
    const { pending, parts, environment } = this.pendingConstruction;
    this.pendingConstruction = null;
    const benchmark = this.benchmark;
    this.finishMainProgram(pending.main);
    this.depthProgram = finishProgram(this.context, pending.depth);
    this.depthSkinUniforms = Object.fromEntries(SKIN_UNIFORMS.map(name => [name, this.context.getUniformLocation(this.depthProgram, name)]));
    this.depthMorphUniforms = Object.fromEntries(MORPH_UNIFORMS.map(name => [name, this.context.getUniformLocation(this.depthProgram, name)]));
    if (!benchmark) {
      this.postProgram = finishProgram(this.context, pending.post);
      this.skyProgram = finishProgram(this.context, pending.sky);
      this.postUniforms = postUniformLocations(this.context, this.postProgram);
      this.postVariants = new Map();
      this.bloomProgram = finishProgram(this.context, pending.bloom);
      this.bloomUniforms = Object.fromEntries(['sourceTexture', 'texelDirection', 'threshold', 'extract'].map(name => [name, this.context.getUniformLocation(this.bloomProgram, name)]));
      this.skyUniforms = Object.fromEntries(['skyTop', 'skyBottom', 'sunDirection', 'inverseViewProjection', 'eye', 'time', 'daylight', 'hdrEnabled'].map((name) => [name, this.context.getUniformLocation(this.skyProgram, name)]));
    }
    this.depthAlphaUniforms = Object.fromEntries(DEPTH_ALPHA_UNIFORMS.map(name => [name, this.context.getUniformLocation(this.depthProgram, name)]));
    this.depthUniform = this.context.getUniformLocation(this.depthProgram, 'lightProjection');
    this.depthAssemblyUniform = this.context.getUniformLocation(this.depthProgram, 'assemblyAmount');
    this.depthWindUniforms = { time: this.context.getUniformLocation(this.depthProgram, 'time'), wind: this.context.getUniformLocation(this.depthProgram, 'wind') };
    this.partCount = parts.length;
    this.triangles = parts.reduce((total, part) => total + part.geometry.indices.length / 3, 0);
    this.whiteTexture = this.createTexture(null);
    // Disabled skin samplers still need distinct units from the depth sampler.
    for (const [program, uniforms] of [[this.program, this.uniforms], [this.depthProgram, this.depthSkinUniforms]]) {
      this.context.useProgram(program);
      this.context.uniform1i(uniforms.skinInfluences, 6);
      this.context.uniform1i(uniforms.jointPalette, 7);
    }
    for (const [program, uniforms] of [[this.program, this.uniforms], [this.depthProgram, this.depthMorphUniforms]]) {
      this.context.useProgram(program);
      this.context.uniform1i(uniforms.morphTargets, 8);
    }
    for (const unit of [6, 7, 8]) {
      this.context.activeTexture(this.context.TEXTURE0 + unit);
      this.context.bindTexture(this.context.TEXTURE_2D, this.whiteTexture);
    }
    if (this.shaderFeatures.has('splat')) requireSplatSupport().initializePlaceholders(this);
    this.initializeEnvironment(environment.map);
    this.createShadowMap();
    if (this.reversedDepthMode !== false && !benchmark) installReversedDepth(this, this.reversedDepthMode);
    this.resize();
    if (!this.benchmark && !this.multisampleFramebuffer) this.allocateFrameTargets(this.canvas.width, this.canvas.height);
  }

  /** Resolves once every program started by the constructor has linked, polling without blocking the main thread, then finishes construction. Needs deferProgramLink. */
  async programsReady() {
    if (!this.pendingConstruction) return;
    const context = this.context;
    const parallelCompile = context.getExtension('KHR_parallel_shader_compile');
    const { pending } = this.pendingConstruction;
    const programs = [...Object.values(pending), ...(this.pendingEnvironmentPrograms?.values() ?? [])].map(started => started.program);
    while (parallelCompile && programs.some(program => !context.getProgramParameter(program, parallelCompile.COMPLETION_STATUS_KHR))) {
      await new Promise(resolve => setTimeout(resolve, 8));
    }
    this.finishConstruction();
  }

  /**
   * Draws `frame` once the way a real frame is drawn, but without freezing the page for programs the driver has not finished
   * building (the post pass of a fog or sky frame, liquids, ambient occlusion, a reversed-depth copy). Each draw that meets one
   * stops there; the driver's thread keeps building while this waits in short timers, then the draw runs again. The last
   * draw is complete and leaves every program, target and texture that frame uses ready, so the next frame costs no more than
   * any other. Call it while the canvas is hidden or another world is on screen. Past `timeoutMilliseconds` it draws the
   * frame at once and resolves true when it never had to, false otherwise.
   */
  async prepareFrame(frame, { timeoutMilliseconds = 6000 } = {}) {
    await this.programsReady();
    const context = this.context;
    const deadline = performance.now() + timeoutMilliseconds;
    setPreparing(context, true);
    try {
      for (;;) {
        try {
          this.render(frame);
          return true;
        } catch (error) {
          if (!(error instanceof ProgramNotReady)) throw error;
          while (!isLinkComplete(context, error.program) && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 8));
          if (performance.now() >= deadline) break;
        }
      }
    } finally {
      setPreparing(context, false);
    }
    this.render(frame);
    return false;
  }

  selectViewTransform(viewTransform, lookSource) {
    if ((viewTransform !== 'aces' || lookSource) && !viewTransformShader.apply) throw new Error("viewTransform and look need their shader code: add import '@codepawlhq/67js/addons/view-transform-shader' (a recipe: await loadAgentSceneModules(recipe)).");
    this.viewTransform = viewTransform;
    this.lookSource = lookSource;
    this.look = lookSource ? viewTransformShader.resolveLook(lookSource) : null;
  }

  // A recipe's environment.viewTransform and environment.look reach the renderer in each frame; a change recompiles the
  // programs that carry the display curve (main, liquid, environment background, post) before the frame is drawn.
  syncViewTransform(environment) {
    const viewTransform = environment.viewTransform ?? this.defaultViewTransform;
    const lookSource = environment.look ?? this.defaultLook;
    if (viewTransform === this.viewTransform && lookSource === this.lookSource) return;
    viewTransformShader.dispose?.(this);
    this.selectViewTransform(viewTransform, lookSource);
    if (this.benchmark) return;
    const context = this.context;
    this.rebuildMainProgram();
    for (const variant of this.postVariants.values()) context.deleteProgram(variant.pending ? finishProgram(context, variant.pending) : variant.program);
    this.postVariants.clear();
    context.deleteProgram(this.postProgram);
    this.postProgram = finishProgram(context, startProgram(context, fullscreenVertex, this.withViewTransform(postFragment, 'post')));
    this.postUniforms = postUniformLocations(context, this.postProgram);
    // The liquid pass builds its program on its next draw, with the new curve (liquid-renderer.js).
    if (this.liquidProgram) context.deleteProgram(this.liquidProgram);
    this.liquidProgram = null;
    if (this.environmentBackgroundProgram) context.deleteProgram(this.environmentBackgroundProgram);
    this.environmentBackgroundProgram = null;
  }

  // The display curve and look of this renderer, spliced into one of its programs (view-transform-shader.js); the default curve changes nothing.
  withViewTransform(source, kind) {
    if (this.viewTransform === 'aces' && !this.look) return source;
    return viewTransformShader.apply(source, kind, this.viewTransform, Boolean(this.look));
  }

  // Compiles the main program with only the shader features that this renderer's parts use, and finds its uniforms.
  startMainProgram() {
    const benchmark = this.benchmark;
    const fragmentSource = benchmark ? benchmarkFragmentShader : this.withViewTransform(createFragmentShader(this.shaderFeatures), 'main');
    return startProgram(this.context, benchmark ? benchmarkVertexShader : createVertexShader(this.shaderFeatures), fragmentSource);
  }

  buildMainProgram() {
    this.finishMainProgram(this.startMainProgram());
  }

  finishMainProgram(pendingProgram) {
    this.program = finishProgram(this.context, pendingProgram);
    this.uniforms = Object.fromEntries(['materialDielectric', 'materialCoat', 'materialSheen', 'materialAnisotropy', 'materialIridescence', 'lightLinkMask', 'boxMapScale', 'boxMapAxis', 'lightMap', 'lightMapScale', 'hasLightMap', 'viewProjection', 'flushBias', 'clipPerMetre', 'lightProjection', 'eye', 'armorColor', 'armorSurface', 'exposure', 'inspection', 'shadowMap', 'shadowBiasPerSlope', ...MAP_UNIFORMS, ...MAP_FLAGS, ...SKIN_UNIFORMS, ...MORPH_UNIFORMS, 'normalScale', 'occlusionStrength', 'materialMoss', ...SPLAT_UNIFORMS, 'hdrEnabled', 'time', 'wind', 'worldMode', 'daylight', 'fogColor', 'lightDirection', 'fogDensity', 'waterRipple', 'rippleTime', 'explosionProgress', 'explosionCenter', 'assemblyAmount', 'renderPassMode', 'renderPassDepthRange', 'renderPassObjectBase', 'baseColor', 'surface', 'instanceEmission', 'instanceOpacity', 'boxNormalMatrix', 'shadowBlind', 'compositeMode', 'tintShadowMap', 'tintBlind', ...ALPHA_UNIFORMS].map((name) => [name, this.context.getUniformLocation(this.program, name)]));
    for (const name of LIGHT_UNIFORMS) {
      this.uniforms[name] = this.context.getUniformLocation(this.program, name);
    }
    for (const name of ENVIRONMENT_UNIFORMS) this.uniforms[name] = this.context.getUniformLocation(this.program, name);
    this.keepSamplerTypesApart();
  }

  // A sampler nobody has set reads texture unit 0, which holds the shadow map as a comparison sampler. One unit may not serve
  // two sampler types, so every 2D sampler starts on unit 1 until a draw sets it.
  keepSamplerTypesApart() {
    const context = this.context;
    context.useProgram(this.program);
    const count = context.getProgramParameter(this.program, context.ACTIVE_UNIFORMS);
    for (let index = 0; index < count; index++) {
      const uniform = context.getActiveUniform(this.program, index);
      if (uniform.type === context.SAMPLER_2D) context.uniform1iv(context.getUniformLocation(this.program, uniform.name), new Int32Array(uniform.size).fill(1));
    }
  }

  get samples() {
    return Math.max(1, this.multisampleSamples);
  }

  uploadBuffer(target, data, usage = this.context.STATIC_DRAW) {
    const buffer = this.context.createBuffer();
    this.buffers.push(buffer);
    this.context.bindBuffer(target, buffer);
    this.context.bufferData(target, data, usage);
    this.geometryBytes += data.byteLength;
    return buffer;
  }

  // Without anisotropic filtering a mipmapped texture seen at a grazing angle (a floor, a road, an apron) falls to a
  // blurred level long before its detail is gone. Applies to the texture bound to `target`.
  applyAnisotropy(target) {
    const context = this.context;
    const extension = context.getExtension('EXT_texture_filter_anisotropic');
    if (!extension) return;
    const supported = context.getParameter(extension.MAX_TEXTURE_MAX_ANISOTROPY_EXT);
    context.texParameterf(target, extension.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(MAX_TEXTURE_ANISOTROPY, supported));
  }

  createTexture(map) {
    if (this.textures.has(map)) return this.textures.get(map);
    const context = this.context;
    const texture = context.createTexture();
    context.bindTexture(context.TEXTURE_2D, texture);
    const previousFlip = context.getParameter(context.UNPACK_FLIP_Y_WEBGL);
    const previousColorSpace = context.getParameter(context.UNPACK_COLORSPACE_CONVERSION_WEBGL);
    try {
      context.pixelStorei(context.UNPACK_FLIP_Y_WEBGL, map?.flipY ?? false);
      context.pixelStorei(context.UNPACK_COLORSPACE_CONVERSION_WEBGL, context.NONE);
      if (map) {
        const info = textureDescriptorInfo(map, context.getParameter(context.MAX_TEXTURE_SIZE));
        if (map.image.compressed) map.image.compressed.upload(context);
        else context.texImage2D(context.TEXTURE_2D, 0, map.colorSpace === 'linear' ? context.RGBA8 : context.SRGB8_ALPHA8, context.RGBA, context.UNSIGNED_BYTE, map.image);
        context.texParameteri(context.TEXTURE_2D, context.TEXTURE_WRAP_S, info.wrapS);
        context.texParameteri(context.TEXTURE_2D, context.TEXTURE_WRAP_T, info.wrapT);
        context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MIN_FILTER, info.minFilter);
        context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MAG_FILTER, info.magFilter);
        if (info.mipmaps) {
          context.generateMipmap(context.TEXTURE_2D);
          this.applyAnisotropy(context.TEXTURE_2D);
        }
      } else {
        context.texImage2D(context.TEXTURE_2D, 0, context.RGBA8, 1, 1, 0, context.RGBA, context.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));
        context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MIN_FILTER, context.LINEAR);
        context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MAG_FILTER, context.LINEAR);
      }
    } catch (error) {
      context.deleteTexture(texture);
      throw error;
    } finally {
      context.pixelStorei(context.UNPACK_FLIP_Y_WEBGL, previousFlip);
      context.pixelStorei(context.UNPACK_COLORSPACE_CONVERSION_WEBGL, previousColorSpace);
    }
    this.textures.set(map, texture);
    return texture;
  }

  // Re-uploads a descriptor's pixels: the whole image (update.image, or the descriptor image again) or update.region {x, y, width, height, data}.
  // The code is in the texture-update addon, so a scene that never updates a texture does not carry it.
  updateTexture(descriptor, update = {}) {
    if (!textureUpdateSupport.update) throw new Error("updateTexture needs its code: add import '@codepawlhq/67js/addons/texture-update'.");
    textureUpdateSupport.update(this, descriptor, update);
  }

  // Parts can arrive after construction (replaceParts) or change their tag (updateParts). When one needs a shader feature
  // that the program left out, the program is compiled again with that feature added.
  requireShaderFeatures(parts) {
    this.requireFeatureNames([...shaderFeaturesOfParts(parts), ...(parts.length > 1 ? ['instanced'] : [])]);
  }

  requireFeatureNames(features) {
    if (this.benchmark || !this.shaderFeatures) return;
    const missing = features.filter(feature => !this.shaderFeatures.has(feature));
    if (missing.length === 0) return;
    missing.forEach(feature => this.shaderFeatures.add(feature));
    this.rebuildMainProgram();
  }

  rebuildMainProgram() {
    const context = this.context;
    const previousProgram = this.program;
    this.buildMainProgram();
    context.deleteProgram(previousProgram);
    context.useProgram(this.program);
    for (const [name, unit] of [['skinInfluences', 6], ['jointPalette', 7], ['morphTargets', 8], ...Object.entries(SPLAT_UNITS), ['environmentSpecular', ENVIRONMENT_SPECULAR_UNIT], ['environmentBrdf', ENVIRONMENT_BRDF_UNIT]]) {
      context.uniform1i(this.uniforms[name], unit);
    }
    context.uniform1f(this.uniforms.splatEnabled, 0);
    if (this.shaderFeatures.has('splat') && !this.splatPlaceholder) requireSplatSupport().initializePlaceholders(this);
  }

  uploadBatch(parts) {
    this.requireShaderFeatures(parts);
    const context = this.context;
    const vertexArray = context.createVertexArray();
    try {
      return this.uploadBatchData(parts, vertexArray);
    } catch (error) {
      context.bindVertexArray(null);
      context.deleteVertexArray(vertexArray);
      throw error;
    }
  }

  /** Binds the geometry's vertex buffers and attributes into the bound vertex array. */
  bindGeometryAttributes(geometry, material) {
    const context = this.context;
    let geometryBuffers = this.geometryBuffers.get(geometry);
    if (!geometryBuffers) {
      geometryBuffers = new Map();
      for (const field of ['positions', 'normals', 'uvs', 'colors', 'indices', 'crowdPacked']) {
        if (geometry[field]) {
          const target = field === 'indices' ? context.ELEMENT_ARRAY_BUFFER : context.ARRAY_BUFFER;
          const values = field === 'uvs' && geometry.lightUvs ? interleaveUvSets(geometry) : geometry[field];
          geometryBuffers.set(field, this.uploadBuffer(target, field === 'colors' && geometry.skyVisibility ? interleaveColorsWithSkyVisibility(geometry) : values));
        }
      }
      if (geometry.skyVisibility && !geometry.colors) geometryBuffers.set('colors', this.uploadBuffer(context.ARRAY_BUFFER, interleaveColorsWithSkyVisibility(geometry)));
      if (geometry.lightUvs && !geometry.uvs) geometryBuffers.set('uvs', this.uploadBuffer(context.ARRAY_BUFFER, interleaveUvSets(geometry)));
      this.geometryBuffers.set(geometry, geometryBuffers);
    }
    for (const [location, field] of [[0, 'positions'], [1, 'normals']]) {
      context.bindBuffer(context.ARRAY_BUFFER, geometryBuffers.get(field));
      context.enableVertexAttribArray(location);
      context.vertexAttribPointer(location, 3, context.FLOAT, false, 0, 0);
    }
    if (geometry.lightUvs && geometry.lightUvs.length !== geometry.positions.length / 3 * 2) throw new Error('Geometry lightUvs count must match the vertex count.');
    if (geometry.uvs || geometry.lightUvs) {
      if (geometry.uvs && geometry.uvs.length !== geometry.positions.length / 3 * 2) throw new Error('Geometry UV count must match the vertex count.');
      context.bindBuffer(context.ARRAY_BUFFER, geometryBuffers.get('uvs'));
      context.enableVertexAttribArray(13);
      context.vertexAttribPointer(13, geometry.lightUvs ? 4 : 2, context.FLOAT, false, 0, 0);
    } else {
      if (hasMaterialMap(material) && !material.boxMapScale) throw new Error('Textured geometry requires UV channel 0.');
      context.disableVertexAttribArray(13);
      // (-1, -1) marks "no UVs": grass wind then bends by local height instead of by blade position.
      context.vertexAttrib2f(13, -1, -1);
    }
    if (geometry.colors && geometry.colors.length !== geometry.positions.length) throw new Error('Geometry colors must contain RGB for every vertex.');
    if (geometry.skyVisibility && geometry.skyVisibility.length !== geometry.positions.length / 3) throw new Error('Geometry skyVisibility must hold one value for every vertex.');
    if (geometry.colors || geometry.skyVisibility) {
      context.bindBuffer(context.ARRAY_BUFFER, geometryBuffers.get('colors'));
      context.enableVertexAttribArray(14);
      context.vertexAttribPointer(14, geometry.skyVisibility ? 4 : 3, context.FLOAT, false, 0, 0);
    } else {
      context.disableVertexAttribArray(14);
      context.vertexAttrib3f(14, 1, 1, 1);
    }
    // A crowd geometry packs four joint ids and weights into the colour attribute; its UVs stay free for maps.
    if (geometry.crowdPacked) {
      context.bindBuffer(context.ARRAY_BUFFER, geometryBuffers.get('crowdPacked'));
      context.enableVertexAttribArray(14);
      context.vertexAttribPointer(14, 4, context.FLOAT, false, 0, 0);
    }
    context.bindBuffer(context.ELEMENT_ARRAY_BUFFER, geometryBuffers.get('indices'));
  }

  /** Points the instance attributes of the bound vertex array at the bound array buffer. */
  pointInstanceAttributes() {
    const stride = INSTANCE_STRIDE;
    for (let column = 0; column < 4; column++) this.attribute(2 + column, 4, stride * 4, column * 16);
    for (let column = 0; column < 3; column++) this.attribute(6 + column, 3, stride * 4, 64 + column * 12);
    this.attribute(9, 3, stride * 4, 100);
    this.attribute(10, 4, stride * 4, 112);
    this.attribute(11, 3, stride * 4, 128);
    this.attribute(12, 3, stride * 4, 140);
    this.attribute(15, 4, stride * 4, 152);
  }

  createCullingState(parts) {
    const first = parts[0];
    const cullable = isCullable(parts);
    if (first.lods) {
      validateLods(first, first.lods);
      if (!cullable) throw new RangeError(`lods need rigid or swaying, opaque parts without assembly motion: ${first.name}`);
    }
    if (first.shadowLods) {
      validateLods(first, first.shadowLods);
      if (!cullable) throw new RangeError(`shadowLods need rigid or swaying, opaque parts without assembly motion: ${first.name}`);
    }
    const levels = first.lods ?? [{ geometry: first.geometry, error: 0 }];
    const sphere = first.crowd?.bounds ?? geometryBoundingSphere(first.geometry);
    const bounds = { center: sphere.center, radius: sphere.radius + Math.max(...levels.map(level => level.error)) };
    const shadowLevels = first.shadowLods ? createLevelSet(first.shadowLods, parts.length) : null;
    const swayReach = SWAYING_TAGS.has(first.material.tag) ? SWAY_REACH_PER_STRENGTH : 0;
    return { cullable, bounds, swayReach, ...createLevelSet(levels, parts.length), shadowLevels };
  }

  /** The vertex array and instance buffer that draw one level of a batch (or of its `shadowLevels`) from the instances selected for it. */
  levelDraw(batch, level, levelSet = batch) {
    if (levelSet.levelDraws[level]) return levelSet.levelDraws[level];
    const context = this.context;
    const ranked = levelSet === batch && level === 0;
    const geometry = (ranked && batch.flushOrder?.geometry) || levelSet.levelGeometries[level];
    const vertexArray = context.createVertexArray();
    context.bindVertexArray(vertexArray);
    this.bindGeometryAttributes(geometry, batch.parts[0].material);
    if (batch.flushIndexBuffer && ranked) context.bindBuffer(context.ELEMENT_ARRAY_BUFFER, batch.flushIndexBuffer);
    const instanceBuffer = context.createBuffer();
    this.buffers.push(instanceBuffer);
    context.bindBuffer(context.ARRAY_BUFFER, instanceBuffer);
    context.bufferData(context.ARRAY_BUFFER, batch.instanceData.byteLength, context.DYNAMIC_DRAW);
    this.pointInstanceAttributes();
    context.bindVertexArray(null);
    levelSet.levelDraws[level] = { vertexArray, instanceBuffer, indexCount: geometry.indices.length };
    return levelSet.levelDraws[level];
  }

  releaseLevelDraws(batch, releasedBuffers) {
    for (const levelSet of [batch, batch.shadowLevels]) {
      if (!levelSet) continue;
      for (const draw of levelSet.levelDraws) {
        if (!draw) continue;
        this.context.deleteVertexArray(draw.vertexArray);
        releasedBuffers?.add(draw.instanceBuffer);
      }
      levelSet.levelDraws = [];
    }
  }

  /** The instances of a batch that the camera can see, split by level; null when the whole batch draws as it is. */
  selectBatchInstances(batch) {
    if (!this.culling || !batch.cullable) return null;
    return selectInstances(batch.selection, {
      instanceData: batch.instanceData, instanceCount: batch.instanceCount, stride: INSTANCE_STRIDE, bounds: batch.bounds, margin: batch.swayReach * Math.abs(this.windState.strength),
      levelErrors: batch.levelErrors, planes: this.frustumPlanes, viewProjection: this.viewProjection,
      pixelsPerUnit: this.canvas.height / 2 * this.projection[5], pixelError: this.lodPixelError * (this.mirrorCulling?.lodScale ?? 1),
      belowHeight: this.mirrorCulling?.belowHeight, minimumPixelRadius: this.mirrorCulling?.minimumPixelRadius,
    });
  }

  drawSelectedLevels(batch, selection, levelSet = batch, flushRanges = null) {
    const context = this.context;
    const stride = INSTANCE_STRIDE;
    for (let level = 0; level < selection.counts.length; level++) {
      const count = selection.counts[level];
      if (count === 0) continue;
      const draw = this.levelDraw(batch, level, levelSet);
      if (!(this.selectionScratch?.length >= count * stride)) this.selectionScratch = new Float32Array(count * stride);
      for (let slot = 0; slot < count; slot++) {
        const instance = selection.indices[level][slot];
        this.selectionScratch.set(batch.instanceData.subarray(instance * stride, (instance + 1) * stride), slot * stride);
      }
      context.bindBuffer(context.ARRAY_BUFFER, draw.instanceBuffer);
      context.bufferSubData(context.ARRAY_BUFFER, 0, this.selectionScratch, 0, count * stride);
      context.bindVertexArray(draw.vertexArray);
      // Only level 0 holds the ranked index order; the simpler levels draw far away, as one range.
      if (flushRanges && level === 0) this.drawFlushRanges(batch, flushRanges, count);
      else context.drawElementsInstanced(context.TRIANGLES, draw.indexCount, context.UNSIGNED_INT, 0, count);
    }
  }

  /** Draws a batch rank by rank from its ranked index order (flush-resolve.js), each rank a little closer in depth. */
  drawFlushRanges(batch, ranges, instanceCount) {
    const context = this.context;
    const base = (batch.depthLayer ?? 0) * RANKS_PER_LAYER;
    for (const range of ranges) {
      this.applyDepthRank(base + range.rank);
      context.drawElementsInstanced(context.TRIANGLES, range.count, context.UNSIGNED_INT, range.start * 4, instanceCount);
    }
    this.applyDepthRank(base);
  }

  uploadBatchData(parts, vertexArray) {
    const context = this.context;
    const geometry = parts[0].geometry;
    context.bindVertexArray(vertexArray);
    const flushOrder = flushOrderOf(parts[0]);
    // A cut geometry carries the ranked order as its own indices. Without cuts the ranked order replaces the geometry's
    // index buffer in this vertex array only; the vertex buffers stay shared.
    this.bindGeometryAttributes(flushOrder?.geometry ?? geometry, parts[0].material);
    const flushIndexBuffer = flushOrder && !flushOrder.geometry ? this.uploadBuffer(context.ELEMENT_ARRAY_BUFFER, flushOrder.indices) : null;
    const stride = INSTANCE_STRIDE;
    const instanceData = new Float32Array(parts.length * stride);
    const normalMatrix = mat3.create();
    parts.forEach((part, index) => {
      mat3.normalFromMat4(normalMatrix, part.matrix);
      packInstance(instanceData, index, part, normalMatrix);
    });
    const instanceBuffer = this.uploadBuffer(context.ARRAY_BUFFER, instanceData, context.DYNAMIC_DRAW);
    this.pointInstanceAttributes();
    context.bindVertexArray(null);
    const map = parts[0].material.map ?? null;
    const mapState = materialMapState(parts[0].material);
    const textures = mapState.slice(0, 5).map(descriptor => this.createTexture(descriptor));
    const splat = parts[0].material.layers ? requireSplatSupport().createResources(this, parts[0].material, requireSplatSupport()) : null;
    const lightMapTexture = mapState[14] ? this.createTexture(mapState[14]) : null;
    if (lightMapTexture && (parts[0].skin || parts[0].morph || !geometry.lightUvs)) throw new Error('A light map needs lightUvs on rigid geometry, with no skin or morph.');
    const skin = parts[0].skin ?? null;
    const skinTexture = skin ? this.createSkinTexture(this.skinTextures, skin, skin.jointMatrices, 4) : null;
    const influenceTexture = skin ? this.createSkinTexture(this.influenceTextures, geometry, null, 2) : null;
    const crowd = parts[0].crowd ?? null;
    const crowdTexture = crowd ? this.createSkinTexture(this.skinTextures, crowd, crowd.data, 4) : null;
    const morph = parts[0].morph ?? null;
    const morphTexture = morph ? this.createMorphTexture(geometry, morph) : null;
    const morphWeights = morph ? new Float32Array(morph.weights) : null;
    const [alphaMode, alphaCutoff, opacity, doubleSided] = materialAlphaState(parts[0].material);
    const layerState = materialLayerState(parts[0].material);
    const culling = this.createCullingState(parts);
    const batch = { ...culling, alphaMode, alphaCutoff, opacity, doubleSided, mirrored: isMirroredMatrix(parts[0].matrix), layerState, parts: [...parts], vertexArray, instanceBuffer, instanceData, textures, mapState, splat, lightMapTexture, texture: textures[0], map, skin, skinTexture, influenceTexture, crowd, crowdTexture, morph, morphTexture, morphWeights, indexCount: flushOrder?.indices.length ?? geometry.indices.length, instanceCount: parts.length, floor: parts[0].material.tag === 'floor', castShadow: castsShadow(parts[0]), tintedShadow: castsTintedShadow(parts[0]), tintBlind: Boolean(splat) || Object.keys(parts[0].material.layerMaps ?? {}).length >= 3, receivesShadow: receivesShadow(parts[0]), compositeMode: compositeModeOf(parts[0]), depthLayer: depthLayerOf(parts[0]), flushOrder, flushIndexBuffer, pass: renderPass(parts[0].material) };
    if (parts[0].lods) culling.levelGeometries.forEach((geometryOfLevel, level) => this.levelDraw(batch, level));
    culling.shadowLevels?.levelGeometries.forEach((geometryOfLevel, level) => this.levelDraw(batch, level, batch.shadowLevels));
    parts.forEach((part, index) => this.partLocations.set(part, { batch, index, geometry: part.geometry, map, mapState, layerState, skin, jointMatrices: skin?.jointMatrices, skinIndices: geometry.skinIndices, skinWeights: geometry.skinWeights, morph, morphWeights: morph?.weights, morphTargets: geometry.morphTargets, normalMatrix: mat3.create(), committedMatrix: batch.instanceData.subarray(index * INSTANCE_STRIDE, index * INSTANCE_STRIDE + 16) }));
    return batch;
  }

  /** Reconcile immutable rigid, untextured geometry without rebuilding programs or render targets. `retainedUnchanged` skips the re-sync of parts in kept batches, for a world that grows in slices. */
  replaceParts(parts, { regroupOnly = false, retainedUnchanged = false } = {}) {
    if (!Array.isArray(parts) || new Set(parts).size !== parts.length) {
      throw new TypeError('Scene parts must be an array with distinct object identities.');
    }
    const renderParts = this.groundPart ? [...parts, this.groundPart] : parts;
    this.fitParts = renderParts;
    this.fitBounds = undefined;
    const groups = groupParts(renderParts, this.batching);
    const geometries = new Set(renderParts.flatMap(partGeometries));
    // Uploaded geometry was validated when it arrived; rechecking a large static scene every frame dominated streamed playback.
    for (const geometry of geometries) {
      if (!this.geometryBuffers.has(geometry)) validateReplacementGeometry(geometry);
    }
    const retained = new Set();
    const replacements = groups.map(group => {
      const first = group[0];
      const location = this.partLocations.get(first);
      const batch = location?.batch;
      const mapState = materialMapState(first.material);
      const sameParts = batch?.parts.length === group.length && batch.parts.every((part, index) => part === group[index]);
      const alphaState = materialAlphaState(first.material);
      const sameState = location?.geometry === first.geometry && batch?.castShadow === castsShadow(first) && batch.receivesShadow === receivesShadow(first) && batch.compositeMode === compositeModeOf(first) && (batch.depthLayer ?? 0) === depthLayerOf(first) && (batch.flushOrder ?? null) === flushOrderOf(first) &&
        batch.floor === (first.material.tag === 'floor') && batchPass(batch) === renderPass(first.material) &&
        [batch.alphaMode, batch.alphaCutoff, batch.opacity, batch.doubleSided].every((value, index) => value === alphaState[index]) &&
        batch.mapState.every((value, index) => value === mapState[index]) &&
        batch.layerState.every((value, index) => value === materialLayerState(first.material)[index]);
      if (sameParts && sameState) {
        retained.add(batch);
        return { group, batch };
      }
      return { group, batch: null };
    });
    // Skinned and morphed batches stay valid only while retained unchanged. Textured ones need the replace-textured-parts addon to be added or dropped.
    for (const item of replacements) {
      if (!item.batch && item.group.some(part => partNeedsFullUpload(part, regroupOnly || Boolean(texturedReplaceSupport.begin)))) {
        throw new Error('replaceParts can add or change only rigid, untextured parts. Keep textured, skinned and morphed parts unchanged, or import replace-textured-parts to add textured ones.');
      }
    }
    for (const [part, location] of this.partLocations) {
      if (retained.has(location.batch)) continue;
      if (location.skin || location.morph || location.morphTargets || location.skinIndices || (location.mapState.slice(0, 5).some(Boolean) && !texturedReplaceSupport.begin && !regroupOnly)) {
        throw new Error(`replaceParts can remove or regroup only existing rigid, untextured parts; ${part.name} is textured, skinned or morphed and needs a new renderer.`);
      }
    }
    const newGeometryBytes = [...geometries].filter(geometry => !this.geometryBuffers.has(geometry)).reduce((total, geometry) => total + geometryBufferBytes(geometry), 0);
    const newInstanceBytes = replacements.filter(item => !item.batch).reduce((total, item) => total + item.group.length * INSTANCE_STRIDE * 4, 0);
    const frameBytes = estimateFrameBytes(this.canvas.width, this.canvas.height, this.samples, 2048, { hdr: this.hdr, bloom: !this.benchmark, depth: this.depth });
    const peakBytes = frameBytes + this.textureBytes + this.geometryBytes + newGeometryBytes + newInstanceBytes;
    if (peakBytes > this.memoryBudgetMiB * 1024 * 1024) {
      throw memoryBudgetError(this.geometryBytes + newGeometryBytes + newInstanceBytes, this.textureBytes, frameBytes, this.memoryBudgetMiB);
    }
    const previousLocations = this.partLocations;
    const previousBuffers = [...this.buffers];
    const previousGeometryBytes = this.geometryBytes;
    const previousGeometryBuffers = new Map(this.geometryBuffers);
    const settleTextures = texturedReplaceSupport.begin?.(this);
    const stagedLocations = new Map();
    const stagedBatches = [];
    this.partLocations = stagedLocations;
    try {
      for (const item of replacements) {
        if (item.batch) {
          stagedBatches.push(item.batch);
          for (const part of item.group) {
            stagedLocations.set(part, previousLocations.get(part));
          }
        } else {
          stagedBatches.push(this.uploadBatch(item.group));
        }
      }
      const error = this.context.getError();
      if (error !== 0) {
        throw new Error(`WebGL replacement allocation failed with error ${error}.`);
      }
    } catch (error) {
      for (const batch of stagedBatches) {
        if (!retained.has(batch)) {
          this.context.deleteVertexArray(batch.vertexArray);
          this.releaseLevelDraws(batch);
        }
      }
      for (const buffer of this.buffers.slice(previousBuffers.length)) {
        this.context.deleteBuffer(buffer);
      }
      this.context.bindVertexArray(null);
      this.buffers = previousBuffers;
      this.geometryBytes = previousGeometryBytes;
      this.geometryBuffers = previousGeometryBuffers;
      settleTextures?.();
      this.partLocations = previousLocations;
      throw error;
    }
    const releasedBuffers = new Set();
    for (const batch of this.batches) {
      if (!retained.has(batch)) {
        this.context.deleteVertexArray(batch.vertexArray);
        releasedBuffers.add(batch.instanceBuffer);
        if (batch.flushIndexBuffer) releasedBuffers.add(batch.flushIndexBuffer);
        this.releaseLevelDraws(batch, releasedBuffers);
      }
    }
    for (const [geometry, buffers] of this.geometryBuffers) {
      if (!geometries.has(geometry)) {
        for (const buffer of buffers.values()) releasedBuffers.add(buffer);
        this.geometryBuffers.delete(geometry);
      }
    }
    for (const buffer of releasedBuffers) this.context.deleteBuffer(buffer);
    this.buffers = this.buffers.filter(buffer => !releasedBuffers.has(buffer));
    settleTextures?.(this.batches, stagedBatches);
    this.geometryBytes = [...geometries].reduce((total, geometry) => total + geometryBufferBytes(geometry), 0) + renderParts.length * INSTANCE_STRIDE * 4;
    this.batches = stagedBatches;
    this.partCount = parts.length;
    this.triangles = parts.reduce((total, part) => total + part.geometry.indices.length / 3, 0);
    this.updateBatches.clear();
    this.shadowsDirty = true;
    // With retainedUnchanged the caller promises that parts of kept batches did not move, so only the new batches are re-synced.
    this.updateParts(retainedUnchanged ? renderParts.filter(part => !retained.has(this.partLocations.get(part)?.batch)) : renderParts);
    return parts.length;
  }

  createSkinTexture(cache, identity, matrices, groupSize) {
    if (cache.has(identity)) return cache.get(identity);
    const context = this.context;
    const texelCount = matrices ? matrices.length / 4 : identity.positions.length / 3 * 2;
    const layout = skinSupport().skinTextureLayout(texelCount, context.getParameter(context.MAX_TEXTURE_SIZE), groupSize);
    const data = matrices ? new Float32Array(layout.width * layout.height * 4) : skinSupport().packSkinInfluences(identity, layout);
    if (matrices) data.set(matrices);
    const record = this.createPackedTexture(layout, data);
    record.pose = matrices ? identity : null;
    cache.set(identity, record);
    return record;
  }

  createMorphTexture(geometry, pose) {
    if (this.morphTextures.has(geometry)) return this.morphTextures.get(geometry);
    const info = morphSupport().validateMorphGeometry(geometry, pose);
    const layout = morphSupport().skinTextureLayout(info.vertexCount * info.targetCount * 2, this.context.getParameter(this.context.MAX_TEXTURE_SIZE), 2);
    const record = this.createPackedTexture(layout, morphSupport().packMorphTargets(geometry, layout));
    record.info = info;
    this.morphTextures.set(geometry, record);
    return record;
  }

  createPackedTexture(layout, data) {
    const context = this.context;
    const texture = context.createTexture();
    context.bindTexture(context.TEXTURE_2D, texture);
    try {
      context.texImage2D(context.TEXTURE_2D, 0, context.RGBA32F, layout.width, layout.height, 0, context.RGBA, context.FLOAT, data);
      context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MIN_FILTER, context.NEAREST);
      context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MAG_FILTER, context.NEAREST);
      context.texParameteri(context.TEXTURE_2D, context.TEXTURE_WRAP_S, context.CLAMP_TO_EDGE);
      context.texParameteri(context.TEXTURE_2D, context.TEXTURE_WRAP_T, context.CLAMP_TO_EDGE);
    } catch (error) {
      context.deleteTexture(texture);
      throw error;
    }
    return { ...layout, texture, data };
  }

  /**
   * Upload changed parts. `checks: false` skips the per-frame pose checks (finite, non-singular, unmirrored skin and
   * morph transforms) for poses already checked where they were made, such as `applyAnimation(time, clip, { checks: false })`.
   * Identity, material and transform rules still apply.
   */
  updateParts(parts, { shadows = true, checks = true } = {}) {
    if (typeof checks !== "boolean") throw new TypeError("updateParts checks must be a boolean.");
    this.updatePartIdentities ??= new Set();
    this.updatePartIdentities.clear();
    this.updateSkins.clear();
    this.updateMorphs ??= new Set();
    this.updateMorphs.clear();
    this.updateBatches.clear();
    const locations = this.updateLocations ??= [];
    locations.length = parts.length;
    let mirrorChanged = false;
    // Preflight every part before touching packed data or submitting GPU writes.
    for (let partIndex = 0; partIndex < parts.length; partIndex++) {
      const part = parts[partIndex];
      const location = this.partLocations.get(part);
      if (!location) throw new Error(`Unknown part identity: ${part.name}`);
      locations[partIndex] = location;
      if (part.skin || part.morph) this.updatePartIdentities.add(part);
      validatePartFlags(part);
      if (castsShadow(part) !== location.batch.castShadow) throw new Error(`Shadow casting changes require a new renderer: ${part.name}`);
      if (receivesShadow(part) !== location.batch.receivesShadow || compositeModeOf(part) !== location.batch.compositeMode) throw new Error(`receiveShadow, holdout and shadowCatcher changes require replaceParts: ${part.name}`);
      if (depthLayerOf(part) !== (location.batch.depthLayer ?? 0)) throw new Error(`depthLayer changes require replaceParts: ${part.name}`);
      // A material whose fields still equal the ones that passed the full checks below needs none of them again.
      const materialUnchanged = location.materialSnapshot?.matches(part.material) === true;
      if (!materialUnchanged) {
        const alphaState = materialAlphaState(part.material);
        const batchAlphaState = [location.batch.alphaMode, location.batch.alphaCutoff, location.batch.opacity, location.batch.doubleSided];
        if (alphaState.some((value, index) => value !== batchAlphaState[index])) throw new Error(`Alpha mode, cutoff, double-sided and mask opacity changes require a new renderer (blend and add opacity may change): ${part.name}`);
      }
      if (part.geometry !== location.geometry) throw new Error(`Geometry changes require a new renderer: ${part.name}`);
      if (isMirroredMatrix(part.matrix) !== Boolean(location.batch.mirrored)) mirrorChanged = true;
      if (!materialUnchanged && renderPass(part.material) !== batchPass(location.batch)) throw new Error(`Moving a part into or out of the liquid or foam pass requires replaceParts: ${part.name}`);
      if ((part.skin ?? null) !== location.skin || part.skin?.jointMatrices !== location.jointMatrices || part.geometry.skinIndices !== location.skinIndices || part.geometry.skinWeights !== location.skinWeights) throw new Error(`Skin identity changes require a new renderer: ${part.name}`);
      if (part.skin) {
        if (PROCEDURAL_MATERIAL_TAGS.has(part.material.tag)) throw new Error('Skinned parts require a standard material tag.');
        if (checks) skinSupport().validateSkinPose(part.skin, part.geometry, part.matrix);
        this.updateSkins.add(location.batch.skinTexture);
      }
      if ((part.morph ?? null) !== (location.morph ?? null) || part.morph?.weights !== location.morphWeights || part.geometry.morphTargets !== location.morphTargets) throw new Error(`Morph identity changes require a new renderer: ${part.name}`);
      if (part.morph) {
        if (PROCEDURAL_MATERIAL_TAGS.has(part.material.tag)) throw new Error('Morphed parts require a standard material tag.');
        if (checks) morphSupport().validateMorphTransform(part.morph, location.batch.morphTexture.info, part.matrix, part.skin);
        this.updateMorphs.add(part.morph);
      }
      if (materialUnchanged) {
        validateTransform(part, location.normalMatrix);
        continue;
      }
      if ((part.material.map ?? null) !== location.map) throw new Error(`Texture map changes require a new renderer: ${part.name}`);
      validateMaterialMaps(part.material);
      const normalScale = part.material.normalScale ?? DEFAULT_NORMAL_SCALE;
      const mapState = location.mapState;
      for (let index = 0; index < MATERIAL_MAPS.length; index++) {
        if ((part.material[MATERIAL_MAPS[index]] ?? null) !== mapState[index]) throw new Error(`Material map or scale changes require a new renderer: ${part.name}`);
      }
      const [lightMapDescriptor, lightMapScale] = lightMapState(part.material);
      if (lightMapDescriptor !== (mapState[14] ?? null) || lightMapScale !== (mapState[15] ?? 0) || (part.material.layerMaps ?? null) !== (mapState[18] ?? null)) throw new Error(`Light map and layer texture changes require a new renderer: ${part.name}`);
      if (normalScale[0] !== mapState[5] || normalScale[1] !== mapState[6] || (part.material.occlusionStrength ?? 1) !== mapState[7] || mossState(part.material).some((value, index) => value !== mapState[8 + index]) || materialLayerState(part.material).some((value, index) => value !== location.layerState[index])) throw new Error(`Material map or scale changes require a new renderer: ${part.name}`);
      validateTransform(part, location.normalMatrix);
      location.materialSnapshot = MaterialSnapshot.of(part.material);
    }
    // A part that crossed a mirror (a flip animation, a toggled billboard) belongs to the other winding batch: regroup every part once.
    // replaceParts packs all parts again, so the rest of this update is done.
    if (mirrorChanged) {
      this.replaceParts([...this.partLocations.keys()].filter(part => part !== this.groundPart), { regroupOnly: true });
      return parts.length;
    }
    // A palette upload also changes consumers absent from the submitted part list.
    if (checks && this.updateSkins.size) {
      for (const [part, location] of this.partLocations) {
        if (!location.skin || !this.updateSkins.has(location.batch.skinTexture) || this.updatePartIdentities.has(part)) continue;
        const committedMatrix = location.committedMatrix ?? location.batch.instanceData.subarray(location.index * INSTANCE_STRIDE, location.index * INSTANCE_STRIDE + 16);
        skinSupport().validateSkinPose(location.skin, location.geometry, committedMatrix);
      }
    }
    // Shared weights also affect batches absent from the submitted part list.
    // Nothing is shared when the update carries no morph and no skin.
    if (checks && (this.updateMorphs.size || this.updateSkins.size)) {
      for (const [part, location] of this.partLocations) {
        if (!location.morph || this.updatePartIdentities.has(part)) continue;
        if (!this.updateMorphs.has(location.morph) && !this.updateSkins.has(location.batch.skinTexture)) continue;
        const committedMatrix = location.committedMatrix ?? location.batch.instanceData.subarray(location.index * INSTANCE_STRIDE, location.index * INSTANCE_STRIDE + 16);
        morphSupport().validateMorphTransform(location.morph, location.batch.morphTexture.info, committedMatrix, location.skin);
      }
    }
    this.updateBatches.clear();
    for (let partIndex = 0; partIndex < parts.length; partIndex++) {
      const part = parts[partIndex];
      const location = locations[partIndex];
      // A tag can change between frames without a new batch, so its shader code may not be compiled yet.
      if (TAG_SHADER_FEATURES.has(part.material.tag) && !this.shaderFeatures?.has(part.material.tag)) this.requireShaderFeatures([part]);
      packInstance(location.batch.instanceData, location.index, part, location.normalMatrix);
      this.updateBatches.add(location.batch);
    }
    for (const batch of this.updateBatches) {
      this.context.bindBuffer(this.context.ARRAY_BUFFER, batch.instanceBuffer);
      this.context.bufferSubData(this.context.ARRAY_BUFFER, 0, batch.instanceData);
    }
    for (const record of this.updateSkins) {
      // Each texture record belongs to one pose and keeps its padded upload buffer.
      const pose = record.pose;
      record.data.set(pose.jointMatrices);
      this.context.bindTexture(this.context.TEXTURE_2D, record.texture);
      this.context.texSubImage2D(this.context.TEXTURE_2D, 0, 0, 0, record.width, record.height, this.context.RGBA, this.context.FLOAT, record.data);
    }
    for (const batch of this.batches ?? []) {
      if (batch.morph && this.updateMorphs.has(batch.morph)) batch.morphWeights.set(batch.morph.weights);
    }
    if (shadows && parts.length > 0) this.shadowsDirty = true;
    return parts.length;
  }

  attribute(location, size, stride, offset) {
    this.context.enableVertexAttribArray(location);
    this.context.vertexAttribPointer(location, size, this.context.FLOAT, false, stride, offset);
    this.context.vertexAttribDivisor(location, 1);
  }

  // A one texel map stays cleared to the far depth, so every point reads as lit. That is exact when nothing casts, and when
  // cascades replace the main shader's lookup and nothing else (volume fog, subsurface thickness) still reads this map.
  shadowMapSizeWanted() {
    const casts = this.batches.some(batch => !batch.floor && batch.castShadow && !this.tintsShadow(batch));
    return casts && !this.shadowCascades?.replacesSingleMap(this) ? SHADOW_MAP_SIZE : 1;
  }

  createShadowMap() {
    const context = this.context;
    const mapSize = this.shadowMapSizeWanted();
    this.shadowTexture ??= context.createTexture();
    context.activeTexture(context.TEXTURE0);
    context.bindTexture(context.TEXTURE_2D, this.shadowTexture);
    if (mapSize !== this.shadowMapSize) {
      this.shadowMapSize = mapSize;
      context.texImage2D(context.TEXTURE_2D, 0, context.DEPTH_COMPONENT24, mapSize, mapSize, 0, context.DEPTH_COMPONENT, context.UNSIGNED_INT, null);
      this.renderTargets.record('shadowMap', { width: mapSize, height: mapSize, format: 'DEPTH_COMPONENT24' });
    }
    // Compare on fetch (the default function is LEQUAL) with linear filtering gives a 2 x 2 percentage-closer result from one fetch.
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MIN_FILTER, context.LINEAR);
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MAG_FILTER, context.LINEAR);
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_COMPARE_MODE, context.COMPARE_REF_TO_TEXTURE);
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_WRAP_S, context.CLAMP_TO_EDGE);
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_WRAP_T, context.CLAMP_TO_EDGE);
    if (!this.shadowFramebuffer) this.shadowFramebuffer = context.createFramebuffer();
    context.bindFramebuffer(context.FRAMEBUFFER, this.shadowFramebuffer);
    context.framebufferTexture2D(context.FRAMEBUFFER, context.DEPTH_ATTACHMENT, context.TEXTURE_2D, this.shadowTexture, 0);
    context.drawBuffers([context.NONE]);
    context.readBuffer(context.NONE);
    if (context.checkFramebufferStatus(context.FRAMEBUFFER) !== context.FRAMEBUFFER_COMPLETE) throw new Error('Shadow framebuffer is incomplete.');
    const light = resolveShadowLight(this.world, this.activeLightDirection, this.shadowBounds);
    const lightView = mat4.lookAt(mat4.create(), light.eye, light.target, light.up ?? [0, 1, 0]);
    mat4.ortho(this.lightProjection, -light.extent, light.extent, -light.extent, light.extent, light.near, light.far);
    mat4.multiply(this.lightProjection, this.lightProjection, lightView);
    context.viewport(0, 0, mapSize, mapSize);
    context.enable(context.DEPTH_TEST);
    context.enable(context.CULL_FACE);
    context.clear(context.DEPTH_BUFFER_BIT);
    this.shadowBiasPerSlope = shadowBiasPerSlope(light, SHADOW_MAP_SIZE);
    this.drawShadowCasters(this.lightProjection, mapSize, true);
    this.drawTintedShadows();
    context.bindFramebuffer(context.FRAMEBUFFER, null);
    this.shadowsDirty = false;
  }

  /** True when the batch casts into the tint map instead of the depth map of the sun. */
  tintsShadow(batch) {
    return Boolean(this.tintedShadowsActive && batch.tintedShadow);
  }

  // The shadow program's opaqueShadow sampler is a comparison sampler, so while a depth map renders it needs a comparison-capable
  // depth texture on its unit that is not the render target: a 2D map left there, or the sun map itself, fails the draw.
  bindPlaceholderOpaqueShadow() {
    const context = this.context;
    context.activeTexture(context.TEXTURE0 + OPAQUE_SHADOW_UNIT);
    if (!this.placeholderShadowTexture) {
      this.placeholderShadowTexture = context.createTexture();
      context.bindTexture(context.TEXTURE_2D, this.placeholderShadowTexture);
      context.texImage2D(context.TEXTURE_2D, 0, context.DEPTH_COMPONENT24, 1, 1, 0, context.DEPTH_COMPONENT, context.UNSIGNED_INT, null);
      context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MIN_FILTER, context.NEAREST);
      context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MAG_FILTER, context.NEAREST);
      context.texParameteri(context.TEXTURE_2D, context.TEXTURE_COMPARE_MODE, context.COMPARE_REF_TO_TEXTURE);
    }
    context.bindTexture(context.TEXTURE_2D, this.placeholderShadowTexture);
    context.activeTexture(context.TEXTURE0);
  }

  allocateTintTarget() {
    const context = this.context;
    this.tintTexture = context.createTexture();
    context.activeTexture(context.TEXTURE0 + TINT_UNIT);
    context.bindTexture(context.TEXTURE_2D, this.tintTexture);
    context.texImage2D(context.TEXTURE_2D, 0, context.RGBA16F, TINT_MAP_SIZE, TINT_MAP_SIZE, 0, context.RGBA, context.HALF_FLOAT, null);
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MIN_FILTER, context.LINEAR);
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MAG_FILTER, context.LINEAR);
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_WRAP_S, context.CLAMP_TO_EDGE);
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_WRAP_T, context.CLAMP_TO_EDGE);
    this.renderTargets.record('tintShadow', { width: TINT_MAP_SIZE, height: TINT_MAP_SIZE, format: 'RGBA16F' });
    this.tintFramebuffer = context.createFramebuffer();
    context.bindFramebuffer(context.FRAMEBUFFER, this.tintFramebuffer);
    context.framebufferTexture2D(context.FRAMEBUFFER, context.COLOR_ATTACHMENT0, context.TEXTURE_2D, this.tintTexture, 0);
    context.drawBuffers([context.COLOR_ATTACHMENT0]);
    if (context.checkFramebufferStatus(context.FRAMEBUFFER) !== context.FRAMEBUFFER_COMPLETE) throw new Error('Tinted shadow framebuffer is incomplete.');
  }

  /**
   * Draws the light that blended and transmissive casters let through, as seen from the sun, in one draw of those casters:
   * the colour map starts white and each caster multiplies its transmittance into rgb while alpha keeps the nearest depth
   * (blend equation MIN). Does nothing, and allocates nothing, when no caster of that kind exists.
   */
  drawTintedShadows() {
    const tinting = this.batches.filter(batch => !batch.floor && batch.castShadow && this.tintsShadow(batch));
    if (tinting.length === 0) return;
    const context = this.context;
    if (!this.tintFramebuffer) this.allocateTintTarget();
    context.bindFramebuffer(context.FRAMEBUFFER, this.tintFramebuffer);
    context.viewport(0, 0, TINT_MAP_SIZE, TINT_MAP_SIZE);
    context.activeTexture(context.TEXTURE0 + OPAQUE_SHADOW_UNIT);
    context.bindTexture(context.TEXTURE_2D, this.shadowTexture);
    context.activeTexture(context.TEXTURE0);
    context.useProgram(this.depthProgram);
    const uniforms = this.depthAlphaUniforms;
    context.uniform1f(uniforms.tintMapSize, TINT_MAP_SIZE);
    context.uniform1f(uniforms.tintBias, this.shadowBiasPerSlope * 2);
    context.uniform1f(uniforms.tintPass, 1);
    context.disable(context.DEPTH_TEST);
    context.enable(context.BLEND);
    context.blendEquationSeparate(context.FUNC_ADD, context.MIN);
    context.blendFuncSeparate(context.DST_COLOR, context.ZERO, context.ONE, context.ONE);
    context.clearColor(1, 1, 1, 1);
    context.clear(context.COLOR_BUFFER_BIT);
    context.enable(context.POLYGON_OFFSET_FILL);
    context.polygonOffset(1, 1);
    for (const batch of tinting) {
      this.applyAlphaState(batch, false);
      context.uniform1f(uniforms.tintTransmission, batch.layerState[9]);
      this.drawBatch(batch, false, this.selectShadowInstances(batch, batch, this.lightProjection, TINT_MAP_SIZE), batch);
    }
    context.disable(context.POLYGON_OFFSET_FILL);
    context.enable(context.CULL_FACE);
    context.disable(context.BLEND);
    context.blendEquation(context.FUNC_ADD);
    context.enable(context.DEPTH_TEST);
    context.uniform1f(uniforms.tintPass, 0);
  }

  bindTintedShadows() {
    if (!this.tintedShadowsActive || !this.tintTexture) return;
    const context = this.context;
    context.activeTexture(context.TEXTURE0 + TINT_UNIT);
    context.bindTexture(context.TEXTURE_2D, this.tintTexture);
    context.uniform1i(this.uniforms.tintShadowMap, TINT_UNIT);
    context.activeTexture(context.TEXTURE0);
  }

  /**
   * The instances of a batch that can land in a shadow map, split by level. An instance outside the light's frustum
   * writes nothing. With an orthographic light and a known map size, the level follows the world size of one texel,
   * so a tree far smaller than a texel uses its coarsest level. Null when the whole batch draws as it is.
   */
  selectShadowInstances(batch, levelSet, lightMatrix, resolution) {
    if (!this.culling || !batch.cullable) return null;
    const planes = extractFrustumPlanes(lightMatrix, this.shadowFrustumPlanes ??= new Float32Array(24));
    const isOrthographic = lightMatrix[3] === 0 && lightMatrix[7] === 0 && lightMatrix[11] === 0 && lightMatrix[15] === 1;
    const selectsLevels = Boolean(resolution) && isOrthographic && levelSet.levelErrors.length > 1;
    // Texels per world unit along the map's x axis; an orthographic matrix has depth 1 everywhere.
    const texelsPerUnit = selectsLevels ? Math.hypot(lightMatrix[0], lightMatrix[4], lightMatrix[8]) * resolution / 2 : 0;
    return selectInstances(levelSet.selection, {
      instanceData: batch.instanceData, instanceCount: batch.instanceCount, stride: INSTANCE_STRIDE, bounds: batch.bounds, margin: batch.swayReach * Math.abs(this.windState.strength),
      levelErrors: selectsLevels ? levelSet.levelErrors : [0], planes, viewProjection: lightMatrix,
      pixelsPerUnit: texelsPerUnit, pixelError: this.lodPixelError,
    });
  }

  // `mainMap` is true for the sun's map, where blended and transmissive casters draw into the tint map instead. Elsewhere
  // (cascades, point and spot tiles) they draw as opaque casters, except a blended part that did not ask to cast.
  drawShadowCasters(lightMatrix = this.lightProjection, resolution = null, mainMap = false) {
    const context = this.context;
    context.useProgram(this.depthProgram);
    context.uniformMatrix4fv(this.depthUniform, false, lightMatrix);
    context.uniform1f(this.depthAssemblyUniform, this.assemblyAmount ?? 0);
    context.uniform1f(this.depthWindUniforms.time, this.windState.time);
    context.uniform1f(this.depthWindUniforms.wind, this.windState.strength);
    // The base map sampler must not alias the shadow texture on unit 0 while that texture is the render target.
    context.uniform1i(this.depthAlphaUniforms.baseMap, 1);
    if (this.tintedShadowsActive) {
      context.uniform1f(this.depthAlphaUniforms.tintPass, 0);
      context.uniform1i(this.depthAlphaUniforms.opaqueShadow, OPAQUE_SHADOW_UNIT);
      this.bindPlaceholderOpaqueShadow();
    }
    context.enable(context.POLYGON_OFFSET_FILL);
    context.polygonOffset(1, 1);
    for (const batch of this.batches) {
      if (batch.floor || !batch.castShadow) continue;
      if (batch.tintedShadow && (mainMap && this.tintedShadowsActive || batch.alphaMode === 'blend' && batch.parts[0].castShadow !== true)) continue;
      const levelSet = batch.shadowLevels ?? batch;
      const selection = this.selectShadowInstances(batch, levelSet, lightMatrix, resolution);
      if (selection?.visibleCount === 0) continue;
      this.applyAlphaState(batch, false);
      this.drawBatch(batch, false, selection, levelSet);
    }
    context.disable(context.POLYGON_OFFSET_FILL);
    context.enable(context.CULL_FACE);
  }

  // The atlas has one row of tiles per four shadow tiles in use. The shader fetches by texel, so the height is free.
  allocateLocalShadowAtlas(tileCount) {
    const context = this.context;
    if (this.localShadowTexture) context.deleteTexture(this.localShadowTexture);
    if (this.localShadowFramebuffer) context.deleteFramebuffer(this.localShadowFramebuffer);
    this.localShadowAtlasHeight = Math.ceil(tileCount / SHADOW_TILES_PER_ROW) * SHADOW_TILE_SIZE;
    this.localShadowTexture = context.createTexture();
    context.activeTexture(context.TEXTURE0 + LOCAL_SHADOW_UNIT);
    context.bindTexture(context.TEXTURE_2D, this.localShadowTexture);
    context.texImage2D(context.TEXTURE_2D, 0, context.DEPTH_COMPONENT24, SHADOW_ATLAS_WIDTH, this.localShadowAtlasHeight, 0, context.DEPTH_COMPONENT, context.UNSIGNED_INT, null);
    this.renderTargets.record('localShadowAtlas', { width: SHADOW_ATLAS_WIDTH, height: this.localShadowAtlasHeight, format: 'DEPTH_COMPONENT24' });
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MIN_FILTER, context.NEAREST);
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MAG_FILTER, context.NEAREST);
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_WRAP_S, context.CLAMP_TO_EDGE);
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_WRAP_T, context.CLAMP_TO_EDGE);
    this.localShadowFramebuffer = context.createFramebuffer();
    context.bindFramebuffer(context.FRAMEBUFFER, this.localShadowFramebuffer);
    context.framebufferTexture2D(context.FRAMEBUFFER, context.DEPTH_ATTACHMENT, context.TEXTURE_2D, this.localShadowTexture, 0);
    context.drawBuffers([context.NONE]);
    context.readBuffer(context.NONE);
    if (context.checkFramebufferStatus(context.FRAMEBUFFER) !== context.FRAMEBUFFER_COMPLETE) throw new Error('Local shadow framebuffer is incomplete.');
    context.activeTexture(context.TEXTURE0);
  }

  // Builds the view of each atlas tile, and draws the atlas again only when a light moved or the casters changed.
  updateLocalShadows(casterChanged) {
    const casters = this.lighting.shadowCasters;
    if (casters.length === 0 || this.benchmark) return;
    const matrices = this.localShadowMatrices ??= new Float32Array(24 * 16);
    const texelAngles = this.localShadowTexelAngles ??= new Float32Array(24);
    const previous = this.localShadowPreviousMatrices ??= new Float32Array(24 * 16);
    const tileMatrix = new Float32Array(16);
    casters.forEach((caster, tile) => {
      texelAngles[tile] = writeShadowTile(caster, tileMatrix);
      matrices.set(tileMatrix, tile * 16);
    });
    const moved = casters.length !== this.localShadowTileCount || matrices.some((value, index) => value !== previous[index]);
    if (!moved && !casterChanged && this.localShadowTexture) return;
    previous.set(matrices);
    this.localShadowTileCount = casters.length;
    const context = this.context;
    if (!this.localShadowTexture || Math.ceil(casters.length / SHADOW_TILES_PER_ROW) * SHADOW_TILE_SIZE > this.localShadowAtlasHeight) this.allocateLocalShadowAtlas(casters.length);
    context.bindFramebuffer(context.FRAMEBUFFER, this.localShadowFramebuffer);
    context.viewport(0, 0, SHADOW_ATLAS_WIDTH, this.localShadowAtlasHeight);
    context.enable(context.DEPTH_TEST);
    context.clear(context.DEPTH_BUFFER_BIT);
    for (let tile = 0; tile < casters.length; tile++) {
      context.viewport(...tileViewport(tile));
      this.drawShadowCasters(matrices.subarray(tile * 16, tile * 16 + 16));
    }
    context.bindFramebuffer(context.FRAMEBUFFER, null);
  }

  /** Stores the wind time and strength the shadow pass must use; true when swaying batches need a new shadow map. */
  updateWindState(frame) {
    const next = { time: frame.time ?? 0, strength: frame.wind ?? 0.3 };
    const previous = this.windState;
    this.windState = next;
    if (previous.time === next.time && previous.strength === next.strength) return false;
    return this.batches.some(batch => batch.castShadow && SWAYING_TAGS.has(batch.parts[0].material.tag));
  }

  resize() {
    const plan = planRenderSize({ width: Math.max(1, this.canvas.clientWidth), height: Math.max(1, this.canvas.clientHeight), pixelRatio: this.pixelRatio, samples: this.samples, memoryBudgetMiB: this.memoryBudgetMiB, geometryBytes: this.geometryBytes, textureBytes: this.textureBytes, hdr: this.hdr, bloom: !this.benchmark, depth: this.depth, maximumSize: Math.min(this.context.getParameter(this.context.MAX_RENDERBUFFER_SIZE), this.context.getParameter(this.context.MAX_TEXTURE_SIZE)) });
    const { width, height } = plan;
    this.memoryPlan = plan;
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
      if (!this.benchmark) this.allocateFrameTargets(width, height);
    }
    mat4.perspective(this.projection, this.world ? Math.PI / 4 : Math.PI / 5.5, width / height, 0.1, this.world ? 600 : 100);
  }

  /**
   * Without reversed depth the 24-bit buffer needs a tight near plane: a camera that left near unset gets one just in front of the
   * nearest scene bounds (near-plane-fit.js). A frame with its own near, an orthographic lens or a scene that can move out of its
   * bounds keeps the frame as it is.
   */
  withFittedNear(frame) {
    if (this.reversedDepth || frame.near !== undefined || frame.projection === 'orthographic') return frame;
    if (this.fitBounds === undefined) this.fitBounds = sceneBoundsOfParts(this.fitParts);
    if (!this.fitBounds) return frame;
    const far = frame.far ?? (this.world ? 600 : 100);
    const near = fittedNearPlane(this.fitBounds, this.view, far);
    return near === 0.1 ? frame : { ...frame, near };
  }

  /** Every GPU render target this renderer holds: name, size, format, samples and bytes, largest first, with the total. */
  memoryReport() {
    return this.renderTargets.report();
  }

  releaseFrameTargets() {
    const context = this.context;
    if (this.multisampleFramebuffer) context.deleteFramebuffer(this.multisampleFramebuffer);
    if (this.resolveFramebuffer) context.deleteFramebuffer(this.resolveFramebuffer);
    if (this.multisampleColor) context.deleteRenderbuffer(this.multisampleColor);
    if (this.multisampleDepth) context.deleteRenderbuffer(this.multisampleDepth);
    if (this.frameTexture) context.deleteTexture(this.frameTexture);
    if (this.depthTexture) context.deleteTexture(this.depthTexture);
    for (const target of this.bloomTargets ?? []) {
      context.deleteTexture(target.texture);
      context.deleteFramebuffer(target.framebuffer);
    }
    this.bloomTargets = [];
    this.renderTargets.release('multisampleColor', 'multisampleDepth', 'frameColor', 'sceneDepth', 'bloomA', 'bloomB');
    this.releaseOcclusionTarget();
    this.passSupport?.releaseTargets(context);
    for (const stage of this.postStages ?? []) stage.releaseTargets(context);
    this.multisampleFramebuffer = null;
    this.resolveFramebuffer = null;
    this.multisampleColor = null;
    this.multisampleDepth = null;
    this.frameTexture = null;
    this.depthTexture = null;
  }

  releaseOcclusionTarget() {
    if (!this.occlusionTarget) return;
    this.context.deleteTexture(this.occlusionTarget.texture);
    this.context.deleteFramebuffer(this.occlusionTarget.framebuffer);
    this.renderTargets.release('ambientOcclusion');
    this.occlusionTarget = null;
  }

  /** Whether a batch is drawn by the opaque loop, and so by render passes. Its parts take object IDs in this order. */
  drawsInOpaqueLoop(batch) {
    return batchPass(batch) === 'opaque' && !isTranslucentMode(batch.alphaMode);
  }

  // Compiled and allocated on first use, so scenes without occlusion pay nothing.
  ensureOcclusionTarget() {
    const context = this.context;
    if (!this.occlusionProgram) {
      this.occlusionProgram = compileProgram(context, fullscreenVertex, ambientOcclusionFragment);
      const names = ['sceneDepth', 'inverseViewProjection', 'radius', 'projectionScale', 'aspect', 'orthographic'];
      this.occlusionUniforms = Object.fromEntries(names.map(name => [name, context.getUniformLocation(this.occlusionProgram, name)]));
    }
    if (this.occlusionTarget) return;
    const width = Math.max(1, Math.ceil(this.canvas.width / 2));
    const height = Math.max(1, Math.ceil(this.canvas.height / 2));
    const texture = context.createTexture();
    context.bindTexture(context.TEXTURE_2D, texture);
    context.texImage2D(context.TEXTURE_2D, 0, context.R8, width, height, 0, context.RED, context.UNSIGNED_BYTE, null);
    this.renderTargets.record('ambientOcclusion', { width, height, format: 'R8' });
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MIN_FILTER, context.LINEAR);
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MAG_FILTER, context.LINEAR);
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_WRAP_S, context.CLAMP_TO_EDGE);
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_WRAP_T, context.CLAMP_TO_EDGE);
    const framebuffer = context.createFramebuffer();
    context.bindFramebuffer(context.FRAMEBUFFER, framebuffer);
    context.framebufferTexture2D(context.FRAMEBUFFER, context.COLOR_ATTACHMENT0, context.TEXTURE_2D, texture, 0);
    this.occlusionTarget = { texture, framebuffer, width, height };
  }

  drawAmbientOcclusion(frame, effects) {
    const context = this.context;
    this.ensureOcclusionTarget();
    const uniforms = this.occlusionUniforms;
    context.bindFramebuffer(context.FRAMEBUFFER, this.occlusionTarget.framebuffer);
    context.viewport(0, 0, this.occlusionTarget.width, this.occlusionTarget.height);
    context.disable(context.DEPTH_TEST);
    context.disable(context.CULL_FACE);
    context.bindVertexArray(null);
    context.useProgram(this.occlusionProgram);
    context.activeTexture(context.TEXTURE1);
    context.bindTexture(context.TEXTURE_2D, this.depthTexture);
    context.uniform1i(uniforms.sceneDepth, 1);
    context.uniformMatrix4fv(uniforms.inverseViewProjection, false, mat4.invert([], this.projection));
    context.uniform1f(uniforms.radius, effects.ambientOcclusionRadius);
    context.uniform1f(uniforms.projectionScale, 0.5 * this.projection[5]);
    context.uniform1f(uniforms.aspect, this.canvas.width / this.canvas.height);
    context.uniform1f(uniforms.orthographic, frame.projection === 'orthographic' ? 1 : 0);
    context.drawArrays(context.TRIANGLES, 0, 3);
  }

  allocateFrameTargets(width, height) {
    const context = this.context;
    this.releaseFrameTargets();
    this.multisampleFramebuffer = context.createFramebuffer();
    context.bindFramebuffer(context.FRAMEBUFFER, this.multisampleFramebuffer);
    this.multisampleColor = context.createRenderbuffer();
    context.bindRenderbuffer(context.RENDERBUFFER, this.multisampleColor);
    context.renderbufferStorageMultisample(context.RENDERBUFFER, this.multisampleSamples, this.hdr ? context.RGBA16F : context.RGBA8, width, height);
    context.framebufferRenderbuffer(context.FRAMEBUFFER, context.COLOR_ATTACHMENT0, context.RENDERBUFFER, this.multisampleColor);
    this.multisampleDepth = context.createRenderbuffer();
    context.bindRenderbuffer(context.RENDERBUFFER, this.multisampleDepth);
    // 24 bits at least (issue #751): 16 bits is one step per 1.5 cm at 10 m. Reversed depth respecifies this store as 32-bit float.
    const depthFormat = 'DEPTH_COMPONENT24';
    context.renderbufferStorageMultisample(context.RENDERBUFFER, this.multisampleSamples, context[depthFormat], width, height);
    context.framebufferRenderbuffer(context.FRAMEBUFFER, context.DEPTH_ATTACHMENT, context.RENDERBUFFER, this.multisampleDepth);
    if (context.checkFramebufferStatus(context.FRAMEBUFFER) !== context.FRAMEBUFFER_COMPLETE) throw new Error('Multisample framebuffer allocation failed. Choose a lower quality preset.');
    this.renderTargets.record('multisampleColor', { width, height, format: this.hdr ? 'RGBA16F' : 'RGBA8', samples: this.multisampleSamples });
    this.renderTargets.record('multisampleDepth', { width, height, format: depthFormat, samples: this.multisampleSamples });
    this.renderTargets.record('frameColor', { width, height, format: this.hdr ? 'RGBA16F' : 'RGBA8' });
    this.frameTexture = context.createTexture();
    context.bindTexture(context.TEXTURE_2D, this.frameTexture);
    context.texImage2D(context.TEXTURE_2D, 0, this.hdr ? context.RGBA16F : context.RGBA8, width, height, 0, context.RGBA, this.hdr ? context.HALF_FLOAT : context.UNSIGNED_BYTE, null);
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MIN_FILTER, context.LINEAR);
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MAG_FILTER, context.LINEAR);
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_WRAP_S, context.CLAMP_TO_EDGE);
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_WRAP_T, context.CLAMP_TO_EDGE);
    this.resolveFramebuffer = context.createFramebuffer();
    context.bindFramebuffer(context.FRAMEBUFFER, this.resolveFramebuffer);
    context.framebufferTexture2D(context.FRAMEBUFFER, context.COLOR_ATTACHMENT0, context.TEXTURE_2D, this.frameTexture, 0);
    if (this.depth) {
      this.depthTexture = context.createTexture();
      context.bindTexture(context.TEXTURE_2D, this.depthTexture);
      context.texImage2D(context.TEXTURE_2D, 0, context.DEPTH_COMPONENT24, width, height, 0, context.DEPTH_COMPONENT, context.UNSIGNED_INT, null);
      context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MIN_FILTER, context.NEAREST);
      context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MAG_FILTER, context.NEAREST);
      context.texParameteri(context.TEXTURE_2D, context.TEXTURE_WRAP_S, context.CLAMP_TO_EDGE);
      context.texParameteri(context.TEXTURE_2D, context.TEXTURE_WRAP_T, context.CLAMP_TO_EDGE);
      context.framebufferTexture2D(context.FRAMEBUFFER, context.DEPTH_ATTACHMENT, context.TEXTURE_2D, this.depthTexture, 0);
      this.renderTargets.record('sceneDepth', { width, height, format: 'DEPTH_COMPONENT24' });
    }
    if (context.checkFramebufferStatus(context.FRAMEBUFFER) !== context.FRAMEBUFFER_COMPLETE) throw new Error('Resolve framebuffer allocation failed. Choose a lower quality preset.');
    this.bloomWidth = Math.max(1, Math.ceil(width / 2));
    this.bloomHeight = Math.max(1, Math.ceil(height / 2));
    context.bindFramebuffer(context.FRAMEBUFFER, null);
  }

  // The prefilter and BRDF programs build while the other programs do, instead of after them.
  startEnvironmentPrograms() {
    this.pendingEnvironmentPrograms = new Map();
    for (const fragmentSource of [requireEnvironmentSupport().prefilterFragment, requireEnvironmentSupport().brdfFragment]) {
      this.pendingEnvironmentPrograms.set(fragmentSource, startProgram(this.context, fullscreenVertex, fragmentSource));
    }
  }

  compileEnvironmentProgram(context, vertexSource, fragmentSource) {
    const pendingProgram = this.pendingEnvironmentPrograms?.get(fragmentSource);
    if (!pendingProgram) return compileProgram(context, vertexSource, fragmentSource);
    this.pendingEnvironmentPrograms.delete(fragmentSource);
    return finishProgram(context, pendingProgram);
  }

  initializeEnvironment(map) {
    const context = this.context;
    context.useProgram(this.program);
    context.uniform1i(this.uniforms.environmentSpecular, ENVIRONMENT_SPECULAR_UNIT);
    context.uniform1i(this.uniforms.environmentBrdf, ENVIRONMENT_BRDF_UNIT);
    if (this.liquidProgram) {
      context.useProgram(this.liquidProgram);
      context.uniform1i(this.liquidUniforms.environmentSpecular, ENVIRONMENT_SPECULAR_UNIT);
    }
    this.bindEnvironmentTextures(this.whiteTexture, this.whiteTexture);
    if (!this.benchmark && map && !this.deferEnvironmentPrefilter) this.prepareEnvironment(map);
  }

  bindEnvironmentTextures(specularTexture, brdfTexture) {
    const context = this.context;
    context.activeTexture(context.TEXTURE0 + ENVIRONMENT_SPECULAR_UNIT);
    context.bindTexture(context.TEXTURE_2D, specularTexture);
    context.activeTexture(context.TEXTURE0 + ENVIRONMENT_BRDF_UNIT);
    context.bindTexture(context.TEXTURE_2D, brdfTexture);
  }

  // Prefilters a map the first time it is seen; maps spread from one created map share its data and reuse the GPU textures (an `irradianceSource` map, which only the diffuse light reads, counts as part of the map). Returns true when new textures were built.
  prepareEnvironment(map) {
    requireEnvironmentSupport().assertMap(map);
    if (this.environmentResources?.data === map.data && this.environmentResources.irradianceSource === map.irradianceSource) return false;
    requireEnvironmentSupport().estimateBytes(map, this.capabilities.maximumTextureSize);
    const resources = requireEnvironmentSupport().createResources(this.context, map, { compileProgram: (context, vertexSource, fragmentSource) => this.compileEnvironmentProgram(context, vertexSource, fragmentSource), fullscreenVertex });
    this.environmentResources?.dispose();
    this.environmentResources = resources;
    this.textureBytes += resources.bytes - this.environmentBytes;
    this.environmentBytes = resources.bytes;
    return true;
  }

  /**
   * Prefilters the map in steps, awaiting `checkpoint()` between them, for a renderer built with `deferEnvironmentPrefilter: true`.
   * Call it before the first render: the steps leave GL state mid-pass, so no frame may draw on this context until it resolves.
   */
  async prepareEnvironmentInSlices(map, checkpoint) {
    requireEnvironmentSupport().assertMap(map);
    if (this.environmentResources?.data === map.data && this.environmentResources.irradianceSource === map.irradianceSource) return false;
    requireEnvironmentSupport().estimateBytes(map, this.capabilities.maximumTextureSize);
    const resources = await requireEnvironmentSupport().createResourcesInSlices(this.context, map, { compileProgram: (context, vertexSource, fragmentSource) => this.compileEnvironmentProgram(context, vertexSource, fragmentSource), fullscreenVertex }, checkpoint);
    this.environmentResources?.dispose();
    this.environmentResources = resources;
    this.textureBytes += resources.bytes - this.environmentBytes;
    this.environmentBytes = resources.bytes;
    return true;
  }

  // Binds the prefiltered textures for this frame and returns the active map, or null for the built-in studio lighting.
  activateEnvironment(map) {
    this.activeMap = this.benchmark ? null : map;
    if (this.benchmark || !map) {
      this.bindEnvironmentTextures(this.whiteTexture, this.whiteTexture);
      return null;
    }
    if (this.prepareEnvironment(map)) this.resize();
    this.bindEnvironmentTextures(this.environmentResources.specularTexture, this.environmentResources.brdfTexture);
    return map;
  }

  applyEnvironmentUniforms(map, uniforms = this.uniforms) {
    const context = this.context;
    context.uniform1f(uniforms.environmentEnabled, map ? 1 : 0);
    if (!map) return;
    if (uniforms['environmentIrradiance[0]']) context.uniform3fv(uniforms['environmentIrradiance[0]'], map.irradianceWithBounce?.(this.environmentResources.irradiance) ?? this.environmentResources.irradiance);
    context.uniform1f(uniforms.environmentIntensity, map.intensity);
    context.uniform2f(uniforms.environmentRotation, Math.cos(map.rotation), Math.sin(map.rotation));
    context.uniform1f(uniforms.environmentLevelMax, this.environmentResources.levelCount - 1);
  }

  drawEnvironmentBackground(map, frame, exposure) {
    if (!map?.showBackground || this.transparent) return false;
    const context = this.context;
    if (!this.environmentBackgroundProgram) {
      this.environmentBackgroundProgram = compileProgram(context, fullscreenVertex, this.withViewTransform(requireEnvironmentSupport().backgroundFragment, 'background'));
      const names = ['inverseViewProjection', 'eye', 'backgroundLevel', 'exposure', 'hdrEnabled', 'environmentSpecular', 'environmentRotation', 'environmentIntensity', 'environmentLevelMax'];
      this.environmentBackgroundUniforms = Object.fromEntries(names.map(name => [name, context.getUniformLocation(this.environmentBackgroundProgram, name)]));
    }
    const uniforms = this.environmentBackgroundUniforms;
    const levelMax = this.environmentResources.levelCount - 1;
    context.disable(context.DEPTH_TEST);
    context.disable(context.CULL_FACE);
    context.bindVertexArray(null);
    context.useProgram(this.environmentBackgroundProgram);
    context.uniformMatrix4fv(uniforms.inverseViewProjection, false, this.inverseViewProjection);
    context.uniform3fv(uniforms.eye, frame.eye);
    context.uniform1f(uniforms.backgroundLevel, map.backgroundBlur * levelMax);
    context.uniform1f(uniforms.exposure, exposure);
    context.uniform1f(uniforms.hdrEnabled, this.hdr ? 1 : 0);
    context.uniform1i(uniforms.environmentSpecular, ENVIRONMENT_SPECULAR_UNIT);
    context.uniform2f(uniforms.environmentRotation, Math.cos(map.rotation), Math.sin(map.rotation));
    context.uniform1f(uniforms.environmentIntensity, map.intensity);
    context.uniform1f(uniforms.environmentLevelMax, levelMax);
    context.drawArrays(context.TRIANGLES, 0, 3);
    return true;
  }

  drawSky(frame) {
    const context = this.context;
    const environment = { skyTop: [0.20, 0.38, 0.52], skyBottom: [0.62, 0.70, 0.67], lightDirection: [-3, 6, 4], daylight: 1, ...this.environment, ...frame.environment };
    context.disable(context.DEPTH_TEST);
    context.disable(context.CULL_FACE);
    context.bindVertexArray(null);
    context.useProgram(this.skyProgram);
    context.uniform3fv(this.skyUniforms.skyTop, environment.skyTop);
    context.uniform3fv(this.skyUniforms.skyBottom, environment.skyBottom);
    context.uniform3fv(this.skyUniforms.sunDirection, environment.lightDirection);
    context.uniformMatrix4fv(this.skyUniforms.inverseViewProjection, false, this.inverseViewProjection);
    context.uniform3fv(this.skyUniforms.eye, frame.eye);
    context.uniform1f(this.skyUniforms.time, frame.time ?? 0);
    context.uniform1f(this.skyUniforms.daylight, environment.daylight);
    context.uniform1f(this.skyUniforms.hdrEnabled, this.hdr ? 1 : 0);
    context.drawArrays(context.TRIANGLES, 0, 3);
  }

  // True when the frame draws local volumes. An empty list costs nothing; anything else is checked here, before a program is bound.
  prepareLocalVolumes(input) {
    if (input === undefined || (Array.isArray(input) && input.length === 0)) return false;
    return requireFeatureCode('volumeFog').support.prepareLocalVolumes(this, input) > 0;
  }

  // The post steps this frame uses. A step that is off costs nothing in a program that has it compiled out.
  postStepsOf(frame, effects, volume, occluded, fogSky, localVolumes) {
    const steps = [];
    if (this.transparent) steps.push('transparent');
    if (occluded) steps.push('occlusion');
    if (effects.bloom.strength > 0) steps.push('bloom');
    if (volume.density > 0) steps.push('volume');
    if (volume.density > 0 && volume.field) steps.push('field');
    if (volume.density > 0 && requireFeatureCode('volumeFog').support.usesDetail(volume)) steps.push('detail');
    if (volume.density > 0 && this.fogLightBuffers?.count > 0) steps.push('lights');
    if (localVolumes) steps.push('local');
    if (fogSky) steps.push('sky');
    if (frame.volumeExplosion) steps.push('explosion');
    const gradesColor = effects.saturation !== 1 || effects.contrast !== 1 || effects.temperature !== 0;
    const finishes = gradesColor || (frame.monochrome ?? 0) !== 0 || Boolean(frame.cinematic) || effects.vignette !== 0 || effects.grain !== 0;
    if (finishes) steps.push('finish');
    return steps;
  }

  // Compiles a program for the steps of this frame the first time they occur. The program with every step stays in use
  // until the driver has finished building the new one, so a step that appears later does not stall a frame.
  selectPostProgram(steps) {
    if (steps.join() === POST_STEPS.join()) return { program: this.postProgram, uniforms: this.postUniforms };
    const key = steps.join(',');
    let variant = this.postVariants.get(key);
    if (!variant) {
      variant = { pending: startProgram(this.context, fullscreenVertex, this.withViewTransform(createPostFragment(steps), 'post')) };
      this.postVariants.set(key, variant);
    }
    if (variant.pending) {
      const parallelCompile = this.context.getExtension('KHR_parallel_shader_compile');
      const building = parallelCompile && !POST_STEPS_WITH_OPTIONAL_CODE.some(step => steps.includes(step)) && !this.context.getProgramParameter(variant.pending.program, parallelCompile.COMPLETION_STATUS_KHR);
      if (building) return { program: this.postProgram, uniforms: this.postUniforms };
      variant.program = finishProgram(this.context, variant.pending);
      variant.uniforms = postUniformLocations(this.context, variant.program);
      variant.pending = null;
    }
    return variant;
  }

  // The fog step leaves the last frame's texture on a mipmapped filter. The stages and bloom read before this frame's
  // mip chain exists, so on that filter they would sample the previous frame's blurred levels: a ghost after a seek.
  restoreSingleLevelFiltering() {
    if (!this.mipmappedTexture) return;
    const context = this.context;
    context.bindTexture(context.TEXTURE_2D, this.mipmappedTexture);
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MIN_FILTER, context.LINEAR);
    this.mipmappedTexture = null;
  }

  resolveFrame(frame, effects, environment, volume) {
    const context = this.context;
    context.bindFramebuffer(context.READ_FRAMEBUFFER, this.multisampleFramebuffer);
    context.bindFramebuffer(context.DRAW_FRAMEBUFFER, this.resolveFramebuffer);
    context.blitFramebuffer(0, 0, this.canvas.width, this.canvas.height, 0, 0, this.canvas.width, this.canvas.height, context.COLOR_BUFFER_BIT | (this.depth ? context.DEPTH_BUFFER_BIT : 0), context.NEAREST);
    this.restoreSingleLevelFiltering();
    let sourceTexture = this.frameTexture;
    for (const stage of this.postStages) sourceTexture = stage.apply(this, frame, effects, sourceTexture) ?? sourceTexture;
    if (effects.bloom.strength > 0) this.drawBloom(effects.bloom, sourceTexture);
    const occluded = effects.ambientOcclusion > 0 && Boolean(this.depthTexture);
    if (occluded) this.drawAmbientOcclusion(frame, effects);
    // A frame that names an outputFramebuffer (src/float-output.js) draws its final pass there, not on the canvas.
    context.bindFramebuffer(context.FRAMEBUFFER, frame.outputFramebuffer ?? null);
    context.viewport(0, 0, this.canvas.width, this.canvas.height);
    context.disable(context.DEPTH_TEST);
    context.disable(context.CULL_FACE);
    context.bindVertexArray(null);
    const fogSky = this.fogSkyVisibility?.(this.sceneParts, volume, context, environment);
    const fogSupport = volume.density > 0 ? requireFeatureCode('volumeFog').support : null;
    const localVolumes = this.prepareLocalVolumes(environment.localVolumes);
    if (fogSupport) fogSupport.packLights(this);
    else if (this.fogLightBuffers) this.fogLightBuffers.count = 0;
    if (localVolumes) requireFeatureCode('volumeFog').support.drawMeshVolumes(this, frame);
    const post = this.selectPostProgram(this.postStepsOf(frame, effects, volume, occluded, fogSky, localVolumes));
    context.useProgram(post.program);
    if (this.look) viewTransformShader.bindLook(this, post.program);
    context.activeTexture(context.TEXTURE0);
    context.bindTexture(context.TEXTURE_2D, sourceTexture);
    // The fog's glow reads blurred copies of the frame from its mip chain, so a tap is smooth instead of one speckled pixel.
    if (volume.density > 0) {
      context.generateMipmap(context.TEXTURE_2D);
      context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MIN_FILTER, context.LINEAR_MIPMAP_LINEAR);
      this.mipmappedTexture = sourceTexture;
    } else if (this.mipmappedTexture === sourceTexture) {
      context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MIN_FILTER, context.LINEAR);
      this.mipmappedTexture = null;
    }
    context.uniform1i(post.uniforms.frameTexture, 0);
    context.activeTexture(context.TEXTURE1);
    context.bindTexture(context.TEXTURE_2D, this.depthTexture ?? this.whiteTexture);
    context.uniform1i(post.uniforms.sceneDepth, 1);
    fogSupport?.bindUniforms(this, post, volume, environment, frame);
    if (localVolumes) requireFeatureCode('volumeFog').support.bindLocalVolumes(this, post, frame);
    context.activeTexture(context.TEXTURE2);
    context.bindTexture(context.TEXTURE_2D, effects.bloom.strength > 0 ? this.bloomTargets[1].texture : this.whiteTexture);
    context.uniform1i(post.uniforms.bloomTexture, 2);
    context.uniform1f(post.uniforms.bloomStrength, effects.bloom.strength);
    context.activeTexture(context.TEXTURE4);
    context.bindTexture(context.TEXTURE_2D, occluded ? this.occlusionTarget.texture : this.whiteTexture);
    context.uniform1i(post.uniforms.occlusionTexture, 4);
    context.uniform1f(post.uniforms.occlusionStrength, occluded ? effects.ambientOcclusion : 0);
    context.uniform2f(post.uniforms.occlusionTexel, 1 / Math.ceil(this.canvas.width / 2), 1 / Math.ceil(this.canvas.height / 2));
    context.uniform1f(post.uniforms.transparent, this.transparent ? 1 : 0);
    context.uniform1f(post.uniforms.hdrEnabled, this.hdr ? 1 : 0);
    context.uniform3f(post.uniforms.grade, effects.saturation, effects.contrast, effects.temperature);
    context.uniform1f(post.uniforms.vignette, effects.vignette);
    context.uniform1f(post.uniforms.grainAmount, effects.grain);
    context.uniform2f(post.uniforms.resolution, this.canvas.width, this.canvas.height);
    context.uniform1f(post.uniforms.monochrome, frame.monochrome ?? 0);
    context.uniform1f(post.uniforms.fade, frame.fade ?? 0);
    context.uniform1f(post.uniforms.cinematic, frame.cinematic ? 1 : 0);
    context.uniform1f(post.uniforms.time, frame.time ?? 0);
    context.uniform1f(post.uniforms.volumeExplosion, frame.volumeExplosion ? 1 : 0);
    context.uniform1f(post.uniforms.explosionProgress, frame.explosionProgress ?? 1);
    context.uniformMatrix4fv(post.uniforms.inverseViewProjection, false, this.inverseViewProjection);
    context.uniform3fv(post.uniforms.eye, frame.eye);
    context.drawArrays(context.TRIANGLES, 0, 3);
  }

  drawTranslucent(frame, environment, assemblyAmount, environmentMap) {
    this.activateEnvironment(environmentMap);
    const liquids = this.batches.filter(batch => batchPass(batch) === 'liquid');
    const foams = this.batches.filter(batch => batchPass(batch) === 'foam');
    if (liquids.length === 0 && foams.length === 0) return;
    liquidPassDrawer()(this, { frame, environment, assemblyAmount, environmentMap, liquids, foams, environmentSpecularUnit: ENVIRONMENT_SPECULAR_UNIT, maximumDistance: MAX_FINITE_DISTANCE, vertexSource: vertexShader, fragmentSource: liquidFragmentSource() });
  }

  // Allocated on the first frame that asks for bloom, so scenes without it pay nothing.
  ensureBloomTargets() {
    if (this.bloomTargets.length > 0) return;
    const context = this.context;
    for (let index = 0; index < 2; index++) {
      const texture = context.createTexture();
      const framebuffer = context.createFramebuffer();
      this.bloomTargets.push({ texture, framebuffer });
      context.bindTexture(context.TEXTURE_2D, texture);
      context.texImage2D(context.TEXTURE_2D, 0, this.hdr ? context.RGBA16F : context.RGBA8, this.bloomWidth, this.bloomHeight, 0, context.RGBA, this.hdr ? context.HALF_FLOAT : context.UNSIGNED_BYTE, null);
      context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MIN_FILTER, context.LINEAR);
      context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MAG_FILTER, context.LINEAR);
      context.texParameteri(context.TEXTURE_2D, context.TEXTURE_WRAP_S, context.CLAMP_TO_EDGE);
      context.texParameteri(context.TEXTURE_2D, context.TEXTURE_WRAP_T, context.CLAMP_TO_EDGE);
      context.bindFramebuffer(context.FRAMEBUFFER, framebuffer);
      context.framebufferTexture2D(context.FRAMEBUFFER, context.COLOR_ATTACHMENT0, context.TEXTURE_2D, texture, 0);
      if (context.checkFramebufferStatus(context.FRAMEBUFFER) !== context.FRAMEBUFFER_COMPLETE) throw new Error('Bloom framebuffer allocation failed. Choose a lower quality preset.');
    }
    context.bindFramebuffer(context.FRAMEBUFFER, null);
    this.renderTargets.record('bloomA', { width: this.bloomWidth, height: this.bloomHeight, format: this.hdr ? 'RGBA16F' : 'RGBA8' });
    this.renderTargets.record('bloomB', { width: this.bloomWidth, height: this.bloomHeight, format: this.hdr ? 'RGBA16F' : 'RGBA8' });
  }

  drawBloom(bloom, sourceTexture = this.frameTexture) {
    const context = this.context;
    this.ensureBloomTargets();
    context.disable(context.DEPTH_TEST);
    context.disable(context.CULL_FACE);
    context.bindVertexArray(null);
    context.useProgram(this.bloomProgram);
    context.viewport(0, 0, this.bloomWidth, this.bloomHeight);
    context.uniform1i(this.bloomUniforms.sourceTexture, 0);
    context.uniform1f(this.bloomUniforms.threshold, bloom.threshold);
    for (let pass = 0; pass < 2; pass++) {
      context.bindFramebuffer(context.FRAMEBUFFER, this.bloomTargets[pass].framebuffer);
      context.activeTexture(context.TEXTURE0);
      context.bindTexture(context.TEXTURE_2D, pass === 0 ? sourceTexture : this.bloomTargets[0].texture);
      context.uniform1f(this.bloomUniforms.extract, pass === 0 ? 1 : 0);
      context.uniform2f(this.bloomUniforms.texelDirection, pass === 0 ? bloom.radius / this.bloomWidth : 0, pass === 1 ? bloom.radius / this.bloomHeight : 0);
      context.drawArrays(context.TRIANGLES, 0, 3);
    }
  }

  /** Culling, cutout and opacity state for one batch, in the color pass (textured) or the shadow depth pass. */
  applyAlphaState(batch, textured) {
    const context = this.context;
    // The shadow depth pass (not textured) draws both faces. A single-sided terrain edge, leaf card or open shell seen from
    // behind would otherwise write no depth, and the sun would pass through it.
    if (batch.doubleSided || !textured) {
      context.disable(context.CULL_FACE);
    } else {
      context.enable(context.CULL_FACE);
    }
    const masked = batch.alphaMode === 'mask';
    if (!textured) {
      const uniforms = this.depthAlphaUniforms;
      context.uniform1f(uniforms.alphaMasked, masked ? 1 : 0);
      context.uniform1f(uniforms.alphaCutoff, batch.alphaCutoff);
      context.uniform1f(uniforms.materialOpacity, batch.opacity);
      context.uniform1f(uniforms.hasBaseMap, batch.mapState[0] ? 1 : 0);
      layerTextureSupport.bindDepth?.(this, batch);
      if (masked || batch.tintedShadow) {
        context.activeTexture(context.TEXTURE0 + 1);
        context.bindTexture(context.TEXTURE_2D, batch.textures[0]);
      }
      return;
    }
    this.applyDepthRank((batch.depthLayer ?? 0) * RANKS_PER_LAYER);
    const useCoverage = masked && this.samples > 1 && !this.benchmark && !this.renderingPass;
    if (useCoverage) {
      context.enable(context.SAMPLE_ALPHA_TO_COVERAGE);
    } else {
      context.disable(context.SAMPLE_ALPHA_TO_COVERAGE);
    }
    const uniforms = this.uniforms;
    context.uniform1f(uniforms.alphaMode, ALPHA_MODES[batch.alphaMode]);
    context.uniform1f(uniforms.alphaCutoff, batch.alphaCutoff);
    context.uniform1f(uniforms.materialOpacity, batch.opacity);
    context.uniform1f(uniforms.alphaToCoverage, useCoverage ? 1 : 0);
    context.uniform1f(uniforms.doubleSided, batch.doubleSided ? 1 : 0);
  }

  /**
   * Pulls what draws next `rank` steps toward the eye, in depth only, for the colour pass; rank 0 is the plain depth test.
   * A step is a view-space distance (FLUSH_STEP metres plus FLUSH_RELATIVE_STEP of the depth), so it separates two faces the
   * same way on every depth format, plus a slope-only polygon offset for the depth the rasteriser's snapping adds on a
   * grazing face. `towardEye` is the sign of nearer depth values: -1 for standard depth, 1 for reversed depth.
   */
  applyDepthRank(rank, towardEye = -1) {
    const context = this.context;
    context.uniform3f(this.uniforms.flushBias, rank * FLUSH_STEP, rank * FLUSH_RELATIVE_STEP, towardEye < 0 && rank ? -rank * FLUSH_CLIP_STEP : 0);
    if (rank) {
      context.enable(context.POLYGON_OFFSET_FILL);
      context.polygonOffset(towardEye * rank * FLUSH_SLOPE_STEP, 0);
    } else {
      context.disable(context.POLYGON_OFFSET_FILL);
    }
  }

  /** Tells the main program how clip space moves per metre along the view direction, for the depth ranks. */
  setFlushProjection(viewProjection) {
    const view = this.view;
    const forward = [-view[2], -view[6], -view[10]];
    for (let row = 0; row < 4; row++) {
      clipPerMetreScratch[row] = viewProjection[row] * forward[0] + viewProjection[4 + row] * forward[1] + viewProjection[8 + row] * forward[2];
    }
    this.context.uniform4fv(this.uniforms.clipPerMetre, clipPerMetreScratch);
  }

  /** Reorders a blend batch's instances back to front for this eye; translation columns stand in for object centers. */
  uploadSortedInstances(batch, eye) {
    if (batch.instanceCount < 2) return;
    const data = batch.instanceData;
    const distances = Array.from({ length: batch.instanceCount }, (unused, index) => {
      const offset = index * INSTANCE_STRIDE;
      return { index, distance: Math.hypot(data[offset + 12] - eye[0], data[offset + 13] - eye[1], data[offset + 14] - eye[2]) };
    });
    distances.sort((first, second) => second.distance - first.distance);
    batch.sortedData ??= new Float32Array(data.length);
    distances.forEach(({ index }, rank) => {
      batch.sortedData.set(data.subarray(index * INSTANCE_STRIDE, (index + 1) * INSTANCE_STRIDE), rank * INSTANCE_STRIDE);
    });
    this.context.bindBuffer(this.context.ARRAY_BUFFER, batch.instanceBuffer);
    this.context.bufferSubData(this.context.ARRAY_BUFFER, 0, batch.sortedData);
  }

  /** Whether any instance of a blend batch is fully opaque, and so has opaque texels to draw as a cutout first. */
  hasOpaqueInstance(batch) {
    for (let index = 0; index < batch.instanceCount; index++) {
      if (batch.instanceData[index * INSTANCE_STRIDE + OPACITY_OFFSET] >= 0.999) return true;
    }
    return false;
  }

  /** Alpha-blended batches draw after opaque and masked geometry, farthest first, without writing depth. Additive batches draw last. */
  drawBlendBatches(frame) {
    const context = this.context;
    const eye = frame.eye;
    const blendBatches = this.batches.filter(batch => batch.alphaMode === 'blend' && batchPass(batch) === 'opaque');
    // Light adds in any order, so additive batches need no sort.
    const addBatches = this.batches.filter(batch => batch.alphaMode === 'add' && batchPass(batch) === 'opaque');
    if (blendBatches.length === 0 && addBatches.length === 0) return;
    // The liquid and foam pass may have switched program, texture unit 0 and the viewport.
    context.bindFramebuffer(context.FRAMEBUFFER, this.multisampleFramebuffer);
    context.viewport(0, 0, this.canvas.width, this.canvas.height);
    context.enable(context.DEPTH_TEST);
    context.useProgram(this.program);
    context.activeTexture(context.TEXTURE0);
    context.bindTexture(context.TEXTURE_2D, this.shadowTexture);
    context.uniform1i(this.uniforms.shadowMap, 0);
    const distance = (batch) => {
      let total = 0;
      for (let index = 0; index < batch.instanceCount; index++) {
        const offset = index * INSTANCE_STRIDE;
        total += Math.hypot(batch.instanceData[offset + 12] - eye[0], batch.instanceData[offset + 13] - eye[1], batch.instanceData[offset + 14] - eye[2]);
      }
      return total / batch.instanceCount;
    };
    const ordered = blendBatches.map(batch => ({ batch, distance: distance(batch) })).sort((first, second) => second.distance - first.distance);
    // Fully opaque texels (most of a baked scene exported as BLEND) draw first as a cutout that writes depth, so they hide
    // whatever lies behind them in any draw order. The blend pass below then shades only the translucent texels (depth LESS).
    for (const { batch } of ordered) {
      if (this.hasOpaqueInstance(batch)) this.drawAlphaBatch({ ...batch, alphaMode: 'mask', alphaCutoff: 0.999 }, true);
    }
    context.enable(context.BLEND);
    context.blendFuncSeparate(context.SRC_ALPHA, context.ONE_MINUS_SRC_ALPHA, context.ONE, context.ONE_MINUS_SRC_ALPHA);
    context.depthMask(false);
    for (const { batch } of ordered) {
      this.uploadSortedInstances(batch, eye);
      this.drawAlphaBatch(batch, true);
    }
    if (addBatches.length > 0) {
      // Source colour times opacity is added to the frame; the destination alpha is kept.
      context.blendFuncSeparate(context.SRC_ALPHA, context.ONE, context.ZERO, context.ONE);
      for (const batch of addBatches) this.drawAlphaBatch(batch, true);
    }
    context.depthMask(true);
    this.applyDepthRank(0);
    context.disable(context.BLEND);
    context.disable(context.SAMPLE_ALPHA_TO_COVERAGE);
    context.enable(context.CULL_FACE);
    context.bindVertexArray(null);
  }

  drawAlphaBatch(batch, textured, culled = false) {
    const selection = culled ? this.selectBatchInstances(batch) : null;
    if (selection?.visibleCount === 0) return;
    this.applyAlphaState(batch, textured);
    this.drawBatch(batch, textured, selection);
  }

  // When every batch holds one instance, its flat values (colour, surface, emission, box normal matrix) are uniforms, not varyings.
  setSingleInstanceUniforms(data) {
    const context = this.context;
    context.uniform3f(this.uniforms.baseColor, data[25], data[26], data[27]);
    context.uniform4f(this.uniforms.surface, data[28], data[29], data[30], data[31]);
    context.uniform4f(this.uniforms.instanceEmission, data[38], data[39], data[40], 0);
    context.uniform1f(this.uniforms.instanceOpacity, data[OPACITY_OFFSET]);
    if (this.shaderFeatures.has('boxMapScale')) context.uniformMatrix3fv(this.uniforms.boxNormalMatrix, false, data.subarray(16, 25));
  }

  drawBatch(batch, textured = false, selection = null, levelSet = batch) {
    if (this.hasMorphs) {
      const uniforms = textured ? this.uniforms : this.depthMorphUniforms;
      this.context.uniform1f(uniforms.morphEnabled, batch.morph ? 1 : 0);
      if (batch.morph) {
        this.context.uniform1i(uniforms.morphVertexCount, batch.morphTexture.info.vertexCount);
        this.context.uniform1i(uniforms.morphTargetCount, batch.morphTexture.info.targetCount);
        this.context.uniform1fv(uniforms['morphWeights[0]'], batch.morphWeights);
        this.context.activeTexture(this.context.TEXTURE0 + 8);
        this.context.bindTexture(this.context.TEXTURE_2D, batch.morphTexture.texture);
      }
    }
    if (this.hasSkins) {
      const uniforms = textured ? this.uniforms : this.depthSkinUniforms;
      this.context.uniform1f(uniforms.crowdEnabled, batch.crowd ? 1 : 0);
      this.context.uniform1f(uniforms.skinEnabled, batch.skin ? 1 : 0);
      if (batch.crowd) {
        this.context.activeTexture(this.context.TEXTURE0 + 7);
        this.context.bindTexture(this.context.TEXTURE_2D, batch.crowdTexture.texture);
        this.context.uniform1i(uniforms.jointPalette, 7);
      } else if (batch.skin) {
        this.context.activeTexture(this.context.TEXTURE0 + 6);
        this.context.bindTexture(this.context.TEXTURE_2D, batch.influenceTexture.texture);
        this.context.uniform1i(uniforms.skinInfluences, 6);
        this.context.activeTexture(this.context.TEXTURE0 + 7);
        this.context.bindTexture(this.context.TEXTURE_2D, batch.skinTexture.texture);
        this.context.uniform1i(uniforms.jointPalette, 7);
      }
    }
    if (textured && !this.benchmark) {
      this.context.uniform1f(this.uniforms.shadowBlind, batch.receivesShadow === false ? 1 : 0);
      this.context.uniform1f(this.uniforms.tintBlind, batch.tintBlind ? 1 : 0);
      this.context.uniform1f(this.uniforms.compositeMode, batch.compositeMode ?? 0);
      for (let index = 0; index < MATERIAL_MAPS.length; index++) {
        this.context.activeTexture(this.context.TEXTURE0 + index + 1);
        this.context.bindTexture(this.context.TEXTURE_2D, batch.textures[index]);
        this.context.uniform1i(this.uniforms[MAP_UNIFORMS[index]], index + 1);
        this.context.uniform1f(this.uniforms[MAP_FLAGS[index]], batch.mapState[index] ? 1 + (batch.mapState[index].uvChannel ?? 0) : 0);
      }
      this.context.uniform2f(this.uniforms.normalScale, batch.mapState[5], batch.mapState[6]);
      this.context.uniform1f(this.uniforms.occlusionStrength, batch.mapState[7]);
      this.context.uniform4f(this.uniforms.materialMoss, batch.mapState[8], batch.mapState[9], batch.mapState[10], batch.mapState[11]);
      const layers = batch.layerState;
      this.context.uniform3f(this.uniforms.materialDielectric, layers[0], layers[1], layers[2]);
      this.context.uniform2f(this.uniforms.materialCoat, layers[3], layers[4]);
      this.context.uniform4f(this.uniforms.materialSheen, layers[5], layers[6], layers[7], layers[8]);
      this.context.uniform2f(this.uniforms.materialAnisotropy, layers[16], layers[17]);
      this.context.uniform3f(this.uniforms.materialIridescence, layers[18], layers[19], layers[20]);
      this.context.uniform1i(this.uniforms.lightLinkMask, layers[21]);
      this.context.uniform1f(this.uniforms.materialToon, layers[22]);
      this.context.uniform1f(this.uniforms.boxMapScale, batch.mapState[12]);
      this.context.uniform1i(this.uniforms.boxMapAxis, batch.mapState[13]);
      if (this.shaderFeatures?.has('splat')) requireSplatSupport().bind(this, batch.splat);
      layerTextureSupport.bind?.(this, batch.mapState, layers, batch);
      this.context.uniform1f(this.uniforms.hasLightMap, batch.lightMapTexture ? 1 : 0);
      if (batch.lightMapTexture) {
        this.context.activeTexture(this.context.TEXTURE0 + LIGHT_MAP_UNIT);
        this.context.bindTexture(this.context.TEXTURE_2D, batch.lightMapTexture);
        this.context.uniform1i(this.uniforms.lightMap, LIGHT_MAP_UNIT);
        this.context.uniform1f(this.uniforms.lightMapScale, batch.mapState[15]);
      }
    }
    if (textured && !this.benchmark && this.shaderFeatures?.has('instanced') === false)this.setSingleInstanceUniforms(batch.instanceData);
    // A reflecting matrix reverses screen winding: clockwise triangles are the front faces of a mirrored batch.
    if (batch.mirrored) this.context.frontFace(this.context.CW);
    // The shadow pass (not textured) draws the whole index buffer; its order does not matter there.
    const flushRanges = textured && !this.benchmark ? batch.flushOrder?.ranges ?? null : null;
    if (selection && !selection.isEverything) {
      this.drawSelectedLevels(batch, selection, levelSet, levelSet === batch ? flushRanges : null);
    } else {
      this.context.bindVertexArray(batch.vertexArray);
      if (flushRanges) this.drawFlushRanges(batch, flushRanges, batch.instanceCount);
      else this.context.drawElementsInstanced(this.context.TRIANGLES, batch.indexCount, this.context.UNSIGNED_INT, 0, batch.instanceCount);
    }
    if (batch.mirrored) this.context.frontFace(this.context.CCW);
  }

  // A render pass draws raw material data instead of the lit image; the addon validates frame.pass and returns the shader mode.
  preparePass(frame) {
    if (frame.pass === undefined) return 0;
    if (!this.passSupport) throw new Error('Render passes need installRenderPasses(renderer) from 67js/addons/render-passes.');
    return this.passSupport.prepare(frame);
  }

  /**
   * Sets the fog's density and velocity field (see docs/volumetric.md) until it is replaced or cleared with null. It wins over
   * a field in the constructor's or the frame's volumeFog. The same size is written into the existing texture on the next frame.
   */
  setFogField(field) {
    this.fogFieldOverride = field === null ? null : validateFogField(field);
  }

  render(frame) {
    const { eye, target = [0, 1.2, 0], armorColor = [0.53, 0.39, 0.24], armorSurface = [0.88, 0.32], exposure = 1, inspection = false } = frame;
    const effects = resolveEffects(frame.effects);
    const environment = { lightDirection: [-3, 6, 4], fogColor: [0.35, 0.43, 0.43], fogDensity: 0.006, daylight: 1, explosionCenter: [0, 0, 0], ...this.environment, ...frame.environment };
    environment.fogDensity ??= this.fittedFogDensity ?? 0.006;
    const volume = resolveVolumeFog(environment.volumeFog);
    if (this.fogFieldOverride) volume.field = this.fogFieldOverride;
    if (volume.density > 0) {
      requireFeatureCode('volumeFog');
      if (!this.depth || !this.hdr || this.transparent || this.benchmark) throw new Error('Volume fog requires depth:true, active HDR and an opaque canvas');
      if (!Number.isFinite(frame.time ?? 0) || Math.abs(frame.time ?? 0) > 1e6) throw new RangeError('Volume time must be finite and within ±1000000 seconds');
      const direction = environment.lightDirection;
      const lightLength = direction?.length === 3 ? Math.hypot(...direction) : NaN;
      if (!Number.isFinite(lightLength) || lightLength < 1e-6 || !Array.from(direction).every(component => typeof component === 'number' && Math.abs(component) <= 1e6)) throw new RangeError('Volume light direction must have a finite nonzero length and bounded components');
    }
    updateLightingState(this.lighting, environment, { world: this.world });
    this.syncViewTransform(environment);
    // The shadow view follows the sun, so a moved sun redraws the map.
    const lightChanged = String(this.activeLightDirection) !== String(environment.lightDirection);
    this.activeLightDirection = environment.lightDirection;
    this.diagnostics = frameDiagnostics({ world: this.world, depth: this.depth, effects, lightDirection: environment.lightDirection, shadowBounds: this.shadowBounds, coplanarProblems: this.coplanarDiagnostics?.(this.batches), skinProblems: deformationSupport.reflectedSkinDiagnostics?.(this.partLocations) });
    const start = performance.now();
    const context = this.context;
    this.beginGpuTiming();
    const assemblyAmount = Math.max(0, Math.min(1, frame.assemblyAmount ?? 0));
    // Swaying foliage moves every frame, so its shadow map is redrawn whenever time or wind changes.
    const windChanged = this.updateWindState(frame);
    const casterChanged = this.assemblyAmount !== assemblyAmount || this.shadowsDirty || windChanged || lightChanged;
    this.requireFeatureNames(shaderFeaturesOfLighting(this.lighting));
    const passMode = this.preparePass(frame);
    this.renderingPass = passMode > 0;
    this.volumeShadowWanted = volume.density > 0;
    if (casterChanged || this.shadowMapSizeWanted() !== this.shadowMapSize) {
      this.assemblyAmount = assemblyAmount;
      this.createShadowMap();
    }
    this.updateLocalShadows(casterChanged);
    const environmentMap = this.activateEnvironment(environment.map);
    this.requireFeatureNames([environmentMap ? 'environmentMap' : 'studioLighting']);
    mat4.lookAt(this.view, eye, target, frame.up ?? [0, 1, 0]);
    applyProjection(this.projection, this.withFittedNear(frame), this.canvas.width / this.canvas.height, { world: this.world });
    mat4.multiply(this.viewProjection, this.projection, this.view);
    mat4.invert(this.inverseViewProjection, this.viewProjection);
    extractFrustumPlanes(this.viewProjection, this.frustumPlanes);
    this.viewForward = [-this.view[2], -this.view[6], -this.view[10]];
    // The water mirror is a cheap draw: it reuses the cascades of the last lit frame and leaves their redraw to the lit frame that follows.
    if (frame.reflectionTarget && this.shadowCascades?.texture) {
      this.cascadeCastersChanged ||= casterChanged;
    } else {
      this.shadowCascades?.update(this, casterChanged || Boolean(this.cascadeCastersChanged));
      this.cascadeCastersChanged = false;
    }
    // The water reflection addon draws the scene a second time into its own smaller target (frame.reflectionTarget).
    const mirrorTarget = frame.reflectionTarget;
    context.bindFramebuffer(context.FRAMEBUFFER, mirrorTarget ? mirrorTarget.framebuffer : passMode ? this.passSupport.framebuffer : this.benchmark ? null : this.multisampleFramebuffer);
    context.viewport(0, 0, mirrorTarget?.width ?? this.canvas.width, mirrorTarget?.height ?? this.canvas.height);
    if (passMode) {
      context.clearColor(...this.passSupport.background(frame.pass));
    } else if (this.transparent) {
      context.clearColor(0, 0, 0, 0);
    } else {
      context.clearColor(0.145, 0.162, 0.177, 1);
    }
    // The environment background covers every pixel, so the colour clear before it would be overwritten.
    const backgroundCoversFrame = !passMode && Boolean(environmentMap?.showBackground) && !this.transparent;
    context.clear(backgroundCoversFrame ? context.DEPTH_BUFFER_BIT : context.COLOR_BUFFER_BIT | context.DEPTH_BUFFER_BIT);
    const environmentBackgroundDrawn = !passMode && this.drawEnvironmentBackground(environmentMap, frame, exposure);
    if (this.world && !this.benchmark && !passMode && !environmentBackgroundDrawn) this.drawSky(frame);
    context.enable(context.DEPTH_TEST);
    context.enable(context.CULL_FACE);
    context.useProgram(this.program);
    context.uniformMatrix4fv(this.uniforms.viewProjection, false, this.viewProjection);
    this.setFlushProjection(this.viewProjection);
    context.uniformMatrix4fv(this.uniforms.lightProjection, false, this.lightProjection);
    context.uniform1f(this.uniforms.shadowBiasPerSlope, this.shadowBiasPerSlope);
    context.uniform3fv(this.uniforms.eye, eye);
    this.shadowCascades?.bindUniforms(this);
    context.uniform3fv(this.uniforms.armorColor, armorColor);
    context.uniform2fv(this.uniforms.armorSurface, armorSurface);
    context.uniform1f(this.uniforms.exposure, exposure);
    context.uniform1f(this.uniforms.inspection, inspection ? 1 : 0);
    context.uniform1f(this.uniforms.hdrEnabled, this.hdr ? 1 : 0);
    context.uniform1i(this.uniforms.pointLightCount, frame.reflectionTarget ? 0 : this.lighting.pointCount);
    context.uniform4fv(this.uniforms['pointLightPositions[0]'], this.lighting.positions);
    context.uniform4fv(this.uniforms['pointLightColors[0]'], this.lighting.colors);
    context.uniform1fv(this.uniforms['pointLightRadii[0]'], this.lighting.radii);
    this.applyLocalLightUniforms(Boolean(frame.reflectionTarget));
    this.lighting.bind?.(this);
    context.uniform3fv(this.uniforms.keyColor, this.lighting.keyColor);
    context.uniform1f(this.uniforms.fillIntensity, this.lighting.fillIntensity);
    context.uniform1f(this.uniforms.ambientIntensity, this.lighting.ambientIntensity);
    context.uniform1f(this.uniforms.specularAntiAliasing, this.lighting.specularAntiAliasing);
    context.uniform1f(this.uniforms.time, frame.time ?? 0);
    context.uniform1f(this.uniforms.wind, frame.wind ?? 0.3);
    context.uniform1f(this.uniforms.worldMode, this.world ? 1 : 0);
    context.uniform1f(this.uniforms.daylight, environment.daylight);
    context.uniform3fv(this.uniforms.lightDirection, environment.lightDirection);
    context.uniform3fv(this.uniforms.fogColor, environment.fogColor);
    context.uniform1f(this.uniforms.fogDensity, environment.fogDensity);
    context.uniform3fv(this.uniforms.waterRipple, frame.waterRipple ?? [10000, 0, 10000]);
    context.uniform1f(this.uniforms.rippleTime, frame.rippleTime ?? -1000);
    context.uniform1f(this.uniforms.explosionProgress, frame.explosionProgress ?? 1);
    context.uniform3fv(this.uniforms.explosionCenter, environment.explosionCenter);
    context.uniform1f(this.uniforms.assemblyAmount, assemblyAmount);
    context.activeTexture(context.TEXTURE0);
    context.bindTexture(context.TEXTURE_2D, this.shadowTexture);
    context.uniform1i(this.uniforms.shadowMap, 0);
    this.bindTintedShadows();
    this.applyEnvironmentUniforms(environmentMap);
    context.uniform1f(this.uniforms.renderPassMode, passMode);
    context.uniform1f(this.uniforms.renderPassDepthRange, frame.passDepthRange ?? 100);
    if (passMode > 5) this.passSupport.bindFrame(frame, environment, volume);
    let objectBase = 0;
    for (const batch of this.batches) {
      if (this.benchmark) {
        this.drawBatch(batch, true);
      } else if ((passMode > 5 ? this.passSupport.drawsInPass(batch, passMode) : this.drawsInOpaqueLoop(batch)) && !(mirrorTarget && batch.mapState[20])) {
        context.uniform1f(this.uniforms.renderPassObjectBase, objectBase);
        objectBase += batch.instanceCount;
        // Object IDs are the instance ordinal, which culling and level selection renumber, so that pass draws every instance.
        if (passMode > 5) this.passSupport.drawBatch(batch, passMode, frame, objectBase - batch.instanceCount);
        else this.drawAlphaBatch(batch, true, passMode !== OBJECT_ID_PASS_MODE);
      }
    }
    this.applyDepthRank(0);
    context.disable(context.SAMPLE_ALPHA_TO_COVERAGE);
    context.enable(context.CULL_FACE);
    context.bindVertexArray(null);
    if (mirrorTarget) {
      this.renderingPass = false;
      this.endGpuTiming();
      return;
    }
    if (passMode) {
      this.passSupport.copyToCanvas();
    } else if (!this.benchmark) {
      this.drawTranslucent(frame, environment, assemblyAmount, environmentMap);
      this.drawBlendBatches(frame);
      this.resolveFrame(frame, effects, environment, volume);
    }
    this.renderingPass = false;
    this.endGpuTiming();
    this.cpuMilliseconds = performance.now() - start;
  }

  beginGpuTiming() {
    if (this.gpuTimer === undefined) this.gpuTimer = this.createGpuTimer?.(this.context) ?? null;
    this.gpuTimer?.begin();
  }

  endGpuTiming() {
    if (!this.gpuTimer) return;
    this.gpuTimer.end();
    this.gpuMilliseconds = this.gpuTimer.collect();
  }

  // The water mirror draws without local lights: it is blurred and rippled, and the sun, sky and fog colour carry the picture.
  applyLocalLightUniforms(withoutLights = false) {
    const context = this.context;
    const lighting = this.lighting;
    const uniforms = this.uniforms;
    context.uniform1fv(uniforms['pointLightShadowTiles[0]'], lighting.pointShadows);
    context.uniform1i(uniforms.spotLightCount, withoutLights ? 0 : lighting.spotCount);
    context.uniform4fv(uniforms['spotLightPositions[0]'], lighting.spotPositions);
    context.uniform4fv(uniforms['spotLightColors[0]'], lighting.spotColors);
    context.uniform4fv(uniforms['spotLightDirections[0]'], lighting.spotDirections);
    context.uniform4fv(uniforms['spotLightParameters[0]'], lighting.spotParameters);
    context.uniform1i(uniforms.areaLightCount, withoutLights ? 0 : lighting.areaCount);
    context.uniform4fv(uniforms['areaLightPositions[0]'], lighting.areaPositions);
    context.uniform4fv(uniforms['areaLightColors[0]'], lighting.areaColors);
    context.uniform4fv(uniforms['areaLightNormals[0]'], lighting.areaNormals);
    context.uniform4fv(uniforms['areaLightTangents[0]'], lighting.areaTangents);
    if (lighting.shadowCasters.length === 0 || !this.localShadowTexture) return;
    context.uniformMatrix4fv(uniforms['localShadowMatrices[0]'], false, this.localShadowMatrices);
    context.uniform1fv(uniforms['localShadowTexelAngles[0]'], this.localShadowTexelAngles);
    context.activeTexture(context.TEXTURE0 + LOCAL_SHADOW_UNIT);
    context.bindTexture(context.TEXTURE_2D, this.localShadowTexture);
    context.uniform1i(uniforms.localShadowAtlas, LOCAL_SHADOW_UNIT);
    context.activeTexture(context.TEXTURE0);
  }

  dispose() {
    this.fogFieldTexture?.dispose();
    if (this.meshVolumePass) requireFeatureCode('volumeFog').support.disposeMeshVolumes(this);
    this.releaseFrameTargets();
    this.shadowCascades?.dispose(this.context, this.renderTargets);
    viewTransformShader.dispose?.(this);
    if (this.localShadowTexture) this.context.deleteTexture(this.localShadowTexture);
    if (this.localShadowFramebuffer) this.context.deleteFramebuffer(this.localShadowFramebuffer);
    if (this.placeholderShadowTexture) this.context.deleteTexture(this.placeholderShadowTexture);
    if (this.tintFramebuffer) {
      this.context.deleteTexture(this.tintTexture);
      this.context.deleteFramebuffer(this.tintFramebuffer);
    }
    this.batches.forEach((batch) => {
      this.context.deleteVertexArray(batch.vertexArray);
      this.releaseLevelDraws(batch);
    });
    this.buffers.forEach((buffer) => this.context.deleteBuffer(buffer));
    this.geometryBuffers?.clear();
    this.context.deleteTexture(this.shadowTexture);
    this.context.deleteFramebuffer(this.shadowFramebuffer);
    this.context.deleteProgram(this.program);
    if (this.liquidProgram) this.context.deleteProgram(this.liquidProgram);
    this.context.deleteProgram(this.depthProgram);
    if (this.postProgram) this.context.deleteProgram(this.postProgram);
    // A program still linking must finish first: deleting it mid-link leaves a GL error that the next renderer on this context sees.
    for (const variant of this.postVariants?.values() ?? []) this.context.deleteProgram(variant.pending ? finishProgram(this.context, variant.pending) : variant.program);
    if (this.skyProgram) this.context.deleteProgram(this.skyProgram);
    if (this.bloomProgram) this.context.deleteProgram(this.bloomProgram);
    if (this.occlusionProgram) this.context.deleteProgram(this.occlusionProgram);
    this.passSupport?.dispose(this.context);
    for (const stage of this.postStages ?? []) stage.dispose(this.context);
    if (this.environmentBackgroundProgram) this.context.deleteProgram(this.environmentBackgroundProgram);
    this.environmentResources?.dispose();
    for (const texture of this.textures.values()) this.context.deleteTexture(texture);
    if (this.splatPlaceholder) requireSplatSupport().dispose(this);
    this.textures.clear();
    for (const cache of [this.skinTextures, this.influenceTextures, this.morphTextures]) {
      for (const record of cache?.values() ?? []) this.context.deleteTexture(record.texture);
      cache?.clear();
    }
    this.partLocations.clear();
    this.updatePartIdentities?.clear();
    this.updateSkins?.clear();
    this.updateMorphs?.clear();
    this.updateBatches?.clear();
  }
}

// Glaze is the public name of the real-time renderer; Renderer67 stays for existing code.
export { Renderer67 as Glaze };
