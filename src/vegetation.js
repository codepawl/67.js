// Procedural vegetation for Crucible: branching trees, bushes, grass, Poisson-disk scattering
// on terrain and distance level of detail.
//
// Trees use a parametric recursive branching model (not space colonization): every branch
// generation is a handful of numbers per species, so a species is a small readable preset,
// the same seed always grows the same tree, and branch count and triangle cost are known
// before growing. Space colonization needs attractor clouds and many iterations for the
// same silhouette and is harder to budget.

import './world-material-shader.js';
import { mat4, quat } from 'gl-matrix';
import {
  FULL_TURN, WORLD_UP, addLeafSurface, addScaled, addTube, addVectors, clamp, createFrame, createLeafFrame,
  createMeshBuilder, createRandom, crossProduct, lerp, lerpVectors, normalized, randomInRange, scaleVector,
  subtractVectors, valueNoise, vectorLength,
} from './vegetation-geometry.js';
import { coverageMean, createCrownSkyField, matchMeanVisibility, scaleVisibility, vertexCoverage } from './tree-sky.js';
import { TREE_LEVEL_GAINS } from './tree-level-gains.js';
import { LEVEL_SETTINGS, SPECIES, TREE_LEVEL_DISTANCES } from './vegetation-species.js';
import { barkTextureDescriptor, leafTextureDescriptor } from './vegetation-textures.js';
import { pixelErrorScale, selectBlendedLevels } from './vegetation-impostors.js';

export { prepareImpostors, getImpostor, bakeImpostorAtlas, blendLevels, pixelErrorScale } from './vegetation-impostors.js';
const DEFAULT_FADE_BAND = 0.06;

export { SPECIES };

const BARK_TILE_SIZE = 0.6;
const SCANNED_BARK_TILE_SIZE = 0.8;
const LEAF_MODES = ['cards', 'mesh'];
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const GRASS_LEVEL_DISTANCES = [24];
const LEAF_COLOR_BASE = [0.85, 0.95, 0.8];
const LEAF_COLOR_TIP = [1.1, 1.05, 0.9];
const SCANNED_LEAF_TINT = [1.05, 1.08, 1];
const DEFAULT_MIX = { broadleaf: 3, birch: 1.5, conifer: 2, bush: 2.5 };

function rotateAroundUp(vector, angle) {
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  return [vector[0] * cosine + vector[2] * sine, vector[1], -vector[0] * sine + vector[2] * cosine];
}

function randomUnitOffset(random) {
  return [random() - 0.5, random() - 0.5, random() - 0.5];
}

function sampleBranch(branch, fraction) {
  const { points, radii } = branch;
  const scaled = clamp(fraction, 0, 1) * (points.length - 1);
  const index = Math.min(Math.floor(scaled), points.length - 2);
  const local = scaled - index;
  return {
    position: lerpVectors(points[index], points[index + 1], local),
    direction: normalized(subtractVectors(points[index + 1], points[index])),
    radius: lerp(radii[index], radii[index + 1], local),
  };
}

function lengthProfile(profile, progress) {
  if (profile === 'crown') return 0.62 + 0.38 * Math.sin(Math.PI * clamp(progress * 0.85 + 0.1, 0, 1));
  if (profile === 'cone') return 1 - 0.9 * progress;
  return 1;
}

function createChildSlots(spec, random) {
  const slots = [];
  if (spec.whorls) {
    for (let whorl = 0; whorl < spec.whorls; whorl++) {
      const fraction = lerp(spec.start, spec.end, spec.whorls > 1 ? whorl / (spec.whorls - 1) : 0);
      const count = Math.round(randomInRange(random, spec.perWhorl));
      for (let member = 0; member < count; member++) {
        slots.push({ fraction, azimuth: member / count * FULL_TURN + whorl * 0.9 + (random() - 0.5) * 0.5 });
      }
    }
    return slots;
  }
  const count = Math.round(randomInRange(random, spec.count));
  for (let index = 0; index < count; index++) {
    slots.push({ fraction: lerp(spec.start, spec.end, (index + random() * 0.5) / count), azimuth: index * 2.399963 + random() * 0.5 });
  }
  return slots;
}

function growSkeleton(preset, height, random) {
  const lastLevel = preset.levels.length - 1;
  const branches = [];
  const leafSites = [];

  function addLeafSites(branch) {
    const spec = preset.leaf;
    const paired = preset.levels[branch.level].pairedLeaves;
    const count = Math.max(2, Math.round(branch.length * spec.sitesPerMeter));
    for (let index = 0; index < count; index++) {
      const sample = sampleBranch(branch, lerp(spec.start, 1, index / (count - 1)));
      const sideAxis = normalized(crossProduct(sample.direction, WORLD_UP));
      const directions = paired
        ? [-1, 1].map(side => normalized(addVectors(scaleVector(sample.direction, 0.5), scaleVector(sideAxis, 0.85 * side))))
        : [normalized(addVectors(addVectors(sample.direction, scaleVector(WORLD_UP, spec.upBias)), scaleVector(randomUnitOffset(random), 0.9)))];
      for (const direction of directions) {
        leafSites.push({ position: sample.position, direction, scale: 0.8 + random() * 0.45, roll: (random() - 0.5) * 0.8 });
      }
    }
  }

  function spawnChildren(branch, spec) {
    for (const slot of createChildSlots(spec, random)) {
      const sample = sampleBranch(branch, slot.fraction);
      const frame = createFrame(sample.direction);
      const axis = addVectors(scaleVector(frame.first, Math.cos(slot.azimuth)), scaleVector(frame.second, Math.sin(slot.azimuth)));
      const angle = randomInRange(random, spec.angle);
      const direction = normalized(addVectors(scaleVector(sample.direction, Math.cos(angle)), scaleVector(axis, Math.sin(angle))));
      const progress = (slot.fraction - spec.start) / Math.max(spec.end - spec.start, 1e-6);
      growBranch({
        origin: sample.position,
        direction,
        length: branch.length * randomInRange(random, spec.lengthRatio) * lengthProfile(spec.profile, progress),
        radius: sample.radius * spec.radiusRatio,
        level: branch.level + 1,
      });
    }
  }

  function growBranch({ origin, direction, length, radius, level }) {
    const parameters = preset.levels[level];
    const points = [origin];
    const radii = [radius];
    const stepLength = length / parameters.segments;
    let current = direction;
    for (let step = 1; step <= parameters.segments; step++) {
      const wander = scaleVector(randomUnitOffset(random), parameters.gnarl * 2);
      current = normalized(addVectors(addVectors(current, wander), [0, parameters.tropism, 0]));
      points.push(addScaled(points[step - 1], current, stepLength));
      radii.push(radius * lerp(1, parameters.tipRadius, step / parameters.segments));
    }
    const branch = { level, points, radii, length };
    branches.push(branch);
    if (parameters.children) spawnChildren(branch, parameters.children);
    if (level === lastLevel) addLeafSites(branch);
  }

  const trunkSettings = preset.levels[0];
  const leanAngle = random() * FULL_TURN;
  const lean = trunkSettings.lean ?? 0;
  growBranch({
    origin: [0, 0, 0],
    direction: normalized([Math.cos(leanAngle) * lean, 1, Math.sin(leanAngle) * lean]),
    length: height * (trunkSettings.lengthScale ?? 1),
    radius: height * preset.trunkRadiusRatio,
    level: 0,
  });
  return { branches, leafSites, crown: describeCrown(leafSites) };
}

function describeCrown(leafSites) {
  const center = scaleVector(leafSites.reduce((sum, site) => addVectors(sum, site.position), [0, 0, 0]), 1 / leafSites.length);
  const radius = Math.max(...leafSites.map(site => vectorLength(subtractVectors(site.position, center))), 0.1);
  return { center, radius };
}

/** Every `stride`-th ring of a branch, and always its tip. */
function thinnedRings(points, radii, stride) {
  const kept = points.map((point, index) => index).filter(index => index % stride === 0 || index === points.length - 1);
  return { points: kept.map(index => points[index]), radii: kept.map(index => radii[index]) };
}

function buildBark(skeleton, preset, setting, bark) {
  const lastLevel = preset.levels.length - 1;
  const maximumLevel = setting.maximumBranchLevel < 0 ? lastLevel + setting.maximumBranchLevel : setting.maximumBranchLevel;
  const builder = createMeshBuilder();
  for (const branch of skeleton.branches) {
    if (branch.level > maximumLevel) continue;
    const baseSides = preset.sides[Math.min(branch.level, preset.sides.length - 1)];
    const sides = Math.max(3, Math.round(baseSides * setting.sideScale));
    let { points, radii } = branch;
    if (setting.pointStride > 1) ({ points, radii } = thinnedRings(points, radii, setting.pointStride));
    if (branch.level === 0) {
      const direction = normalized(subtractVectors(points[1], points[0]));
      points = [addScaled(points[0], direction, -0.3), ...points];
      radii = [radii[0] * preset.rootFlare, ...radii];
    }
    addTube(builder, points, radii, sides, bark.tileSize, [1, 1, 1], { worldScaleUv: bark.scanned });
  }
  return builder.build();
}

/**
 * The trunk alone with half the sides, for a shadow map whose texels are wider than any branch. `error` is the width of
 * the thickest branch it drops plus the corners it cuts from the trunk: detail thinner than that covers less than a
 * texel of the map, so a level is used only when one texel is at least this wide.
 */
function buildShadowTrunk(skeleton, preset, bark) {
  const trunkOnly = { sideScale: 0.5, maximumBranchLevel: 0 };
  const thickestBranchRadius = Math.max(0, ...skeleton.branches.filter(branch => branch.level > 0).map(branch => branch.radii[0]));
  const trunkRadius = skeleton.branches[0].radii[0] * preset.rootFlare;
  return { geometry: buildBark(skeleton, preset, trunkOnly, bark), error: 2 * thickestBranchRadius + 0.15 * trunkRadius };
}

// The trunk of the shadow level again with a third of its rings, which cuts a bend of the trunk by at most this many meters.
const THINNED_TRUNK_ERROR = 0.3;

function buildThinnedShadowTrunk(skeleton, preset, bark, trunk) {
  const thinned = { sideScale: 0.25, maximumBranchLevel: 0, pointStride: 3 };
  return { geometry: buildBark(skeleton, preset, thinned, bark), error: trunk.error + THINNED_TRUNK_ERROR };
}

function isTextureDescriptor(value) {
  return Boolean(value) && typeof value === 'object' && Boolean(value.image);
}

/**
 * Picks the scanned bark set for a species. `barkTextures` is either one set
 * (`{ color, normal, roughness }`) or an object keyed by species name; returns null for procedural bark.
 */
export function resolveBarkTextures(barkTextures, species) {
  if (!barkTextures) return null;
  const set = isTextureDescriptor(barkTextures.color) ? barkTextures : barkTextures[species];
  if (!set) return null;
  if (!isTextureDescriptor(set.color)) throw new TypeError(`Bark textures for ${species} need a color texture descriptor.`);
  for (const channel of ['normal', 'roughness']) {
    if (set[channel] !== undefined && !isTextureDescriptor(set[channel])) throw new TypeError(`Bark ${channel} must be a texture descriptor.`);
  }
  return set;
}

/**
 * Picks the scanned leaf cards for a species. `leafTextures` is one set (`{ color, normal, crown }`) or an object keyed
 * by species name, as `loadLeafTextures` returns; returns null for procedural leaves.
 */
export function resolveLeafTextures(leafTextures, species) {
  if (!leafTextures) return null;
  const set = isTextureDescriptor(leafTextures.color) ? leafTextures : leafTextures[species];
  if (!set) return null;
  if (!isTextureDescriptor(set.color)) throw new TypeError(`Leaf textures for ${species} need a color texture descriptor.`);
  for (const channel of ['normal', 'crown']) {
    if (set[channel] !== undefined && !isTextureDescriptor(set[channel])) throw new TypeError(`Leaf ${channel} must be a texture descriptor.`);
  }
  return set;
}

function crownShading(skeleton, position) {
  const { center, radius } = skeleton.crown;
  const offset = subtractVectors(position, center);
  const distanceFraction = clamp(vectorLength(offset) / radius, 0, 1);
  const heightFraction = clamp(offset[1] / radius * 0.5 + 0.5, 0, 1);
  return {
    brightness: lerp(0.55, 1.1, distanceFraction ** 0.8) + 0.12 * heightFraction,
    canopyNormal: normalized(addVectors(normalized(offset), scaleVector(WORLD_UP, 0.35))),
  };
}

function addMeshLeaves(builder, skeleton, spec, site, scale, random) {
  const { brightness, canopyNormal } = crownShading(skeleton, site.position);
  for (let index = 0; index < spec.meshPerSite; index++) {
    const yaw = (index - (spec.meshPerSite - 1) / 2) * spec.meshSpread;
    const direction = normalized(addScaled(rotateAroundUp(site.direction, yaw), WORLD_UP, (random() - 0.5) * 0.5));
    const length = spec.meshLength * site.scale * scale;
    addLeafSurface(builder, {
      origin: site.position,
      frame: createLeafFrame(direction, site.roll + (random() - 0.5) * 0.6),
      length,
      width: spec.meshWidth * site.scale * scale,
      rows: spec.profile,
      droop: spec.droop,
      fold: spec.fold,
      canopyNormal,
      canopyBlend: 0.45,
      colorBase: LEAF_COLOR_BASE,
      colorTip: LEAF_COLOR_TIP,
      brightness: brightness * (0.9 + random() * 0.2) / 1.5,
    });
  }
}

function addCards(builder, skeleton, spec, site, scale, random) {
  const { brightness, canopyNormal } = crownShading(skeleton, site.position);
  const firstRoll = (random() - 0.5) * 0.6;
  for (let index = 0; index < spec.cardsPerSite; index++) {
    addLeafSurface(builder, {
      origin: site.position,
      frame: createLeafFrame(site.direction, firstRoll + index * (Math.PI / 2 + (random() - 0.5) * 0.5)),
      length: spec.cardSize[1] * site.scale * scale,
      width: spec.cardSize[0] * site.scale * scale,
      rows: [[0, 1], [0.5, 1], [1, 1]],
      backFaces: false,
      droop: 0.12,
      canopyNormal,
      canopyBlend: 0.55,
      colorBase: LEAF_COLOR_BASE,
      colorTip: LEAF_COLOR_TIP,
      brightness: brightness * (0.9 + random() * 0.2),
    });
  }
}

function addBlob(builder, center, radius, brightness = 1) {
  const segments = 8;
  const rings = 5;
  const firstVertex = builder.vertexCount;
  for (let ring = 0; ring <= rings; ring++) {
    const polar = ring / rings * Math.PI;
    for (let segment = 0; segment <= segments; segment++) {
      const azimuth = (segment % segments) / segments * FULL_TURN;
      const direction = [Math.sin(polar) * Math.cos(azimuth), Math.cos(polar), Math.sin(polar) * Math.sin(azimuth)];
      const jitter = 1 + (valueNoise(direction[0] * 2 + center[0], direction[2] * 2 + center[2], 3) - 0.5) * 0.5;
      const position = [center[0] + direction[0] * radius * jitter, center[1] + direction[1] * radius * 0.8 * jitter, center[2] + direction[2] * radius * jitter];
      const color = scaleVector(LEAF_COLOR_BASE, brightness);
      builder.addVertex(position, direction, segment / segments, ring / rings, color);
    }
  }
  const ringSize = segments + 1;
  for (let ring = 0; ring < rings; ring++) {
    for (let segment = 0; segment < segments; segment++) {
      const current = firstVertex + ring * ringSize + segment;
      builder.addTriangle(current, current + 1, current + ringSize);
      builder.addTriangle(current + ringSize, current + 1, current + ringSize + 1);
    }
  }
}

function addCrownClumps(builder, skeleton, spec, mode, random, widthScale = 1) {
  const cellSize = skeleton.crown.radius / 2.1;
  const cells = new Map();
  for (const site of skeleton.leafSites) {
    const key = site.position.map(value => Math.floor(value / cellSize)).join(',');
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(site);
  }
  // Two cards of a clump lie about flat and the third stands along the vertical. Each clump rolls its standing card by the
  // golden angle from the last, so the standing cards of a crown face every way evenly and the crown looks as bright from every
  // side (issue #432). Unrolled, they all faced one world direction, and the far levels were three times darker from one side.
  let clumpIndex = 0;
  for (const sites of cells.values()) {
    const center = scaleVector(sites.reduce((sum, site) => addVectors(sum, site.position), [0, 0, 0]), 1 / sites.length);
    const yaw = clumpIndex * GOLDEN_ANGLE;
    clumpIndex++;
    const shading = crownShading(skeleton, center);
    const radius = cellSize * (0.55 + 0.1 * Math.min(sites.length, 5)) * widthScale * (spec.clumpScale ?? 1);
    if (mode === 'mesh') {
      addBlob(builder, center, radius, shading.brightness / 1.5);
      continue;
    }
    for (let card = 0; card < 3; card++) {
      const direction = card === 2 ? WORLD_UP : [Math.cos(card * 1.9 + center[0]), 0.15, Math.sin(card * 1.9 + center[2])];
      addLeafSurface(builder, {
        origin: addScaled(center, normalized(direction), -radius),
        frame: createLeafFrame(normalized(direction), card === 2 ? yaw : 0),
        length: radius * 2,
        width: radius * 2,
        rows: [[0, 1], [1, 1]],
        backFaces: false,
        canopyNormal: shading.canopyNormal,
        // Their own normals: blended toward the crown's, a sun behind the tree left the far levels near black (issue #432).
        canopyBlend: spec.clumpCanopyBlend ?? 0,
        colorBase: LEAF_COLOR_BASE,
        colorTip: LEAF_COLOR_TIP,
        brightness: shading.brightness,
      });
    }
  }
}

function buildFoliage(skeleton, preset, mode, setting, random) {
  const builder = createMeshBuilder({ withColors: true });
  if (setting.leafKeep === 0) {
    addCrownClumps(builder, skeleton, preset.leaf, mode, random, setting.crownScale);
    return builder.build();
  }
  const stride = Math.round(1 / setting.leafKeep);
  skeleton.leafSites.forEach((site, index) => {
    if (index % stride !== 0) return;
    if (mode === 'mesh') addMeshLeaves(builder, skeleton, preset.leaf, site, setting.leafScale, random);
    else addCards(builder, skeleton, preset.leaf, site, setting.leafScale, random);
  });
  return builder.build();
}

function createBarkMaterial(preset, scannedTextures) {
  if (!scannedTextures) {
    return { color: preset.bark.tint, roughness: 0.95, metallic: 0, emission: 0, map: barkTextureDescriptor(preset.bark.texture) };
  }
  const material = { color: [1, 1, 1], roughness: 1, metallic: 0, emission: 0, map: scannedTextures.color };
  if (scannedTextures.normal) material.normalMap = scannedTextures.normal;
  if (scannedTextures.roughness) material.metallicRoughnessMap = scannedTextures.roughness;
  return material;
}

// Thinner leaf layers for a shadow map whose texels are wider than a leaf. Each keeps the covered area of the layer above it
// (fewer leaves, each larger), draws with the same material as the tree, and `error` is how far a leaf may sit from where
// the full layer has one: about the spacing of the leaves it replaces.
const SHADOW_FOLIAGE_SETTINGS = [
  { leafKeep: 0.34, leafScale: 1.7, error: 1 },
  { leafKeep: 0.125, leafScale: 2.8, error: 2 },
];

function buildShadowFoliage(skeleton, preset, mode, seed, firstSetting) {
  return SHADOW_FOLIAGE_SETTINGS.slice(firstSetting).map((setting, index) => ({
    geometry: buildFoliage(skeleton, preset, mode, setting, createRandom(seed * 104729 + 50 + firstSetting + index)),
    error: setting.error,
  }));
}

function createMaterials(preset, mode, scannedBark, scannedLeaves) {
  const bark = createBarkMaterial(preset, scannedBark);
  if (mode === 'mesh') {
    const foliage = { tag: 'foliage', color: scaleVector(preset.leaf.foliageColor, 1.5), roughness: 0.8, metallic: 0, emission: 0 };
    return { bark, foliage, crown: foliage };
  }
  const cardMaterial = (texture) => ({
    tag: 'foliage', color: preset.leaf.tint, roughness: 0.85, metallic: 0, emission: 0,
    map: leafTextureDescriptor(texture, preset.leaf.color), alphaMode: 'mask', alphaCutoff: 0.5, doubleSided: true,
  });
  if (!scannedLeaves) return { bark, foliage: cardMaterial(preset.leaf.texture), crown: cardMaterial('clump') };
  // Scanned cards keep their own colour; the vertex colours still shade the crown from its centre outward.
  const scannedCard = (map, normalMap) => ({
    tag: 'foliage', color: SCANNED_LEAF_TINT, roughness: 0.75, metallic: 0, emission: 0,
    map, ...(normalMap ? { normalMap, normalScale: [0.7, 0.7] } : {}), alphaMode: 'mask', alphaCutoff: 0.5, doubleSided: true,
  });
  return {
    bark,
    foliage: scannedCard(scannedLeaves.color, scannedLeaves.normal),
    crown: scannedLeaves.crown ? scannedCard(scannedLeaves.crown) : cardMaterial('clump'),
  };
}

// Every level describes the same crown, so every level reads one sky visibility field, measured on the leaves of level 0.
// `skyVisibility` is worked out the first time something reads it (the renderer, when it uploads the geometry), so a
// tree that is only measured or exported costs nothing extra, and a forest of distinct trees pays for the ones drawn.
// A level's mean is taken over the leaf its vertices stand for, not over the vertices, because a clump has few vertices for a lot of leaf.

function bakeCrownSkyVisibility(levels, species) {
  const foliageOf = level => level.parts[1].geometry;
  const coverageOf = geometry => vertexCoverage(geometry.positions, geometry.indices);
  let field = null;
  for (const [levelIndex, level] of levels.entries()) {
    const part = level.parts[1];
    const { geometry } = part;
    if (geometry.positions.length === 0) continue;
    const gain = TREE_LEVEL_GAINS[species]?.[levelIndex];
    if (gain) {
      const colorGain = gain.color * leafAreaCorrection(geometry, foliageOf(levels[0]), gain.area, TREE_LEVEL_GAINS[species].areaExponent);
      if (part.material.map) geometry.colors = geometry.colors.map(channel => channel * colorGain);
      else part.material = { ...part.material, color: part.material.color.map(channel => Math.min(1, channel * colorGain)) };
    }
    let skyVisibility = null;
    Object.defineProperty(geometry, 'skyVisibility', {
      enumerable: true,
      configurable: true,
      get() {
        field ??= createCrownSkyField(foliageOf(levels[0]).positions);
        if (!skyVisibility) {
          skyVisibility = field.visibilityOf(geometry.positions);
          if (levelIndex > 0) {
            const levelZero = foliageOf(levels[0]);
            const targetMean = coverageMean(levelZero.skyVisibility, coverageOf(levelZero));
            skyVisibility = matchMeanVisibility(skyVisibility, targetMean, coverageOf(geometry));
            if (gain) skyVisibility = scaleVisibility(skyVisibility, gain.sky);
          }
        }
        return skyVisibility;
      },
    });
  }
}

// A tree whose lower level carries more leaf area against level 0 than the species usually does draws that level darker (its
// clumps overlap and shade each other more), so the colour gain grows with the area ratio (issue #432). `meanLogArea` is the
// species' usual log area ratio for that level, and the exponent how strongly the brightness follows it.
function leafAreaCorrection(geometry, levelZero, meanLogArea, exponent) {
  if (meanLogArea === undefined || !exponent) return 1;
  const leafArea = foliage => vertexCoverage(foliage.positions, foliage.indices).reduce((sum, share) => sum + share, 0);
  return Math.exp(exponent * (Math.log(leafArea(geometry) / leafArea(levelZero)) - meanLogArea));
}

function boundsOf(geometries) {
  const minimum = [Infinity, Infinity, Infinity];
  const maximum = [-Infinity, -Infinity, -Infinity];
  for (const geometry of geometries) {
    for (let offset = 0; offset < geometry.positions.length; offset++) {
      const axis = offset % 3;
      minimum[axis] = Math.min(minimum[axis], geometry.positions[offset]);
      maximum[axis] = Math.max(maximum[axis], geometry.positions[offset]);
    }
  }
  return { minimum, maximum };
}

function describeLevel(parts) {
  return { parts, triangles: parts.reduce((total, part) => total + part.geometry.indices.length / 3, 0) };
}

/**
 * Grows one tree. `speciesOrOptions` is a preset name ('broadleaf', 'birch', 'conifer', 'palm',
 * 'bush') or `{ species, height, leaves, barkTextures, barkTileSize, leafTextures }`. Returns three levels of detail; each level lists the
 * parts (`bark`, `foliage`) with their geometry and material, in local meters with the trunk at the origin.
 */
export function createTree(speciesOrOptions = 'broadleaf', seed = 1) {
  const options = typeof speciesOrOptions === 'string' ? { species: speciesOrOptions } : { ...speciesOrOptions };
  const preset = SPECIES[options.species];
  if (!preset) throw new RangeError(`Unknown tree species: ${options.species}`);
  const leaves = options.leaves ?? 'cards';
  if (!LEAF_MODES.includes(leaves)) throw new RangeError(`Leaves must be one of ${LEAF_MODES.join(', ')}.`);
  if (!Number.isFinite(seed)) throw new TypeError('Tree seed must be a finite number.');
  const random = createRandom(seed * 7919 + 17);
  const height = options.height ?? randomInRange(random, preset.height);
  const skeleton = growSkeleton(preset, height, random);
  const scannedBark = resolveBarkTextures(options.barkTextures, options.species);
  const bark = { scanned: Boolean(scannedBark), tileSize: options.barkTileSize ?? (scannedBark ? SCANNED_BARK_TILE_SIZE : BARK_TILE_SIZE) };
  const scannedLeaves = leaves === 'cards' ? resolveLeafTextures(options.leafTextures, options.species) : null;
  const materials = createMaterials(preset, leaves, scannedBark, scannedLeaves);
  const shadowTrunk = buildShadowTrunk(skeleton, preset, bark);
  const thinnedShadowTrunk = buildThinnedShadowTrunk(skeleton, preset, bark, shadowTrunk);
  const levels = LEVEL_SETTINGS.map((setting, levelIndex) => {
    const levelRandom = createRandom(seed * 104729 + levelIndex);
    const foliageMaterial = setting.leafKeep === 0 ? materials.crown : materials.foliage;
    const barkGeometry = buildBark(skeleton, preset, setting, bark);
    const foliageGeometry = buildFoliage(skeleton, preset, leaves, setting, levelRandom);
    // Level 0 can drop to either thinner layer and level 1 to the second; the crown clumps of level 2 are thin enough.
    const shadowFoliage = setting.leafKeep === 0 ? [] : buildShadowFoliage(skeleton, preset, leaves, seed, levelIndex);
    return describeLevel([
      { role: 'bark', geometry: barkGeometry, material: materials.bark, tintable: false, shadowLods: [{ geometry: barkGeometry, error: 0 }, shadowTrunk, thinnedShadowTrunk] },
      {
        role: 'foliage', geometry: foliageGeometry, material: foliageMaterial, tintable: true,
        ...(shadowFoliage.length ? { shadowLods: [{ geometry: foliageGeometry, error: 0 }, ...shadowFoliage] } : {}),
      },
    ]);
  });
  bakeCrownSkyVisibility(levels, options.species);
  return {
    kind: 'tree', species: options.species, seed, height, leaves, levels, materials,
    distances: TREE_LEVEL_DISTANCES,
    bounds: boundsOf(levels[0].parts.map(part => part.geometry)),
  };
}

function grassMaterial(style, color) {
  if (style === 'cards') {
    return { tag: 'grass', color: [1, 1, 1], roughness: 0.9, metallic: 0, emission: 0, map: leafTextureDescriptor('grass', [80, 128, 40]), alphaMode: 'mask', alphaCutoff: 0.5, doubleSided: true };
  }
  return { tag: 'grass', color, roughness: 0.9, metallic: 0, emission: 0 };
}

function buildGrassBlades(random, blades, height, radius, widthScale) {
  const builder = createMeshBuilder({ withColors: true });
  for (let blade = 0; blade < blades; blade++) {
    const azimuth = random() * FULL_TURN;
    const distance = Math.sqrt(random()) * radius;
    const lean = 0.2 + random() * 0.4;
    addLeafSurface(builder, {
      origin: [Math.cos(azimuth) * distance, 0, Math.sin(azimuth) * distance],
      frame: createLeafFrame(normalized([Math.cos(azimuth) * lean, 1, Math.sin(azimuth) * lean]), random() * FULL_TURN),
      length: height * (0.6 + random() * 0.6),
      width: 0.04 * widthScale * (0.8 + random() * 0.5),
      rows: [[0, 1], [0.35, 0.85], [0.7, 0.5], [1, 0]],
      droop: 0.3 + random() * 0.4,
      canopyNormal: WORLD_UP,
      canopyBlend: 0.55,
      colorBase: [0.43, 0.5, 0.39],
      colorTip: [1, 1, 0.78],
    });
  }
  return builder.build();
}

function buildGrassCards(random, height, radius) {
  const builder = createMeshBuilder({ withColors: true });
  const startAngle = random() * Math.PI;
  for (let card = 0; card < 3; card++) {
    const angle = startAngle + card * Math.PI / 3;
    const right = [Math.cos(angle), 0, Math.sin(angle)];
    addLeafSurface(builder, {
      origin: [0, 0, 0],
      frame: { forward: WORLD_UP, right, normal: crossProduct(right, WORLD_UP) },
      length: height * (0.9 + random() * 0.2),
      width: radius * 2.4,
      rows: [[0, 1], [0.5, 1], [1, 1]],
      backFaces: false,
      droop: 0.1,
      canopyNormal: WORLD_UP,
      canopyBlend: 0.6,
      colorBase: [0.6, 0.65, 0.55],
      colorTip: [1, 1, 0.95],
    });
  }
  return builder.build();
}

/**
 * A tuft of grass. `style: 'blades'` (default) is real curved blade geometry with the swaying `grass` tag;
 * `'cards'` is three crossed alpha-masked cards. Level 1 has half the blades, wider.
 */
export function createGrassClump({ blades = 16, height = 0.45, radius = 0.13, style = 'blades', color = [0.23, 0.39, 0.07], seed = 1 } = {}) {
  if (!['blades', 'cards'].includes(style)) throw new RangeError('Grass style must be blades or cards.');
  const random = createRandom(seed * 6271 + 5);
  const material = grassMaterial(style, color);
  const geometries = style === 'cards'
    ? [buildGrassCards(random, height, radius), buildGrassCards(random, height, radius)]
    : [buildGrassBlades(random, blades, height, radius, 1), buildGrassBlades(random, Math.max(3, Math.round(blades / 2)), height, radius, 1.7)];
  const levels = geometries.map(geometry => describeLevel([{ role: 'grass', geometry, material, tintable: true }]));
  return { kind: 'grass', species: 'grass', seed, height, levels, materials: { grass: material }, distances: GRASS_LEVEL_DISTANCES, bounds: boundsOf(geometries) };
}

function buildFlowerPatch(random, flowers, height, petalColor) {
  const builder = createMeshBuilder({ withColors: true });
  const stemColor = [0.16, 0.3, 0.07];
  for (let flower = 0; flower < flowers; flower++) {
    const azimuth = random() * FULL_TURN;
    const distance = Math.sqrt(random()) * 0.14;
    const base = [Math.cos(azimuth) * distance, 0, Math.sin(azimuth) * distance];
    const stemHeight = height * (0.7 + random() * 0.5);
    const lean = [(random() - 0.5) * 0.12, 0, (random() - 0.5) * 0.12];
    const top = addVectors(addVectors(base, [0, stemHeight, 0]), lean);
    const middle = addVectors(lerpVectors(base, top, 0.5), scaleVector(lean, 0.6));
    addTube(builder, [base, middle, top], [0.005, 0.0045, 0.004], 3, 0.3, stemColor);
    const petals = 6;
    for (let petal = 0; petal < petals; petal++) {
      const angle = petal / petals * FULL_TURN;
      const forward = normalized([Math.cos(angle), 0.3, Math.sin(angle)]);
      addLeafSurface(builder, {
        origin: top, frame: createLeafFrame(forward, 0), length: 0.055, width: 0.04,
        rows: [[0, 0.5], [0.5, 1], [1, 0.5]], canopyNormal: WORLD_UP, canopyBlend: 0.5, colorBase: petalColor, colorTip: petalColor,
      });
    }
    addBlob(builder, addScaled(top, WORLD_UP, 0.004), 0.014);
  }
  return builder.build();
}

/** A patch of small flowers on thin stems; color lives in vertex colors, so one material serves every hue. */
export function createFlowerPatch({ flowers = 5, height = 0.4, color = [1, 0.85, 0.3], seed = 1 } = {}) {
  const random = createRandom(seed * 3571 + 11);
  const geometry = buildFlowerPatch(random, flowers, height, color);
  const material = { color: [1, 1, 1], roughness: 0.8, metallic: 0, emission: 0 };
  return { kind: 'flowers', species: 'flowers', seed, height, levels: [describeLevel([{ role: 'flowers', geometry, material, tintable: false }])], materials: { flowers: material }, distances: [], bounds: boundsOf([geometry]) };
}

const FLOWER_COLORS = [[0.95, 0.8, 0.25], [0.8, 0.35, 0.55], [0.9, 0.9, 0.85], [0.45, 0.4, 0.85]];

function createVariant(species, variantSeed, variantIndex, leaves, barkTextures, leafTextures) {
  if (species === 'grass') return createGrassClump({ seed: variantSeed, height: 0.38 + 0.12 * (variantIndex % 3) });
  if (species === 'flowers') return createFlowerPatch({ seed: variantSeed, color: FLOWER_COLORS[variantIndex % FLOWER_COLORS.length] });
  return createTree({ species, leaves, barkTextures, leafTextures }, variantSeed);
}

function poissonDiskPoints(area, radius, random, accept) {
  const cellSize = radius / Math.SQRT2;
  const columns = Math.ceil((area.maxX - area.minX) / cellSize) + 1;
  const rows = Math.ceil((area.maxZ - area.minZ) / cellSize) + 1;
  const grid = new Int32Array(columns * rows).fill(-1);
  const points = [];
  const cellOf = point => [Math.floor((point[0] - area.minX) / cellSize), Math.floor((point[1] - area.minZ) / cellSize)];
  const isFree = (point) => {
    if (point[0] < area.minX || point[0] > area.maxX || point[1] < area.minZ || point[1] > area.maxZ) return false;
    const [column, row] = cellOf(point);
    for (let rowOffset = -2; rowOffset <= 2; rowOffset++) {
      for (let columnOffset = -2; columnOffset <= 2; columnOffset++) {
        const neighborColumn = column + columnOffset;
        const neighborRow = row + rowOffset;
        if (neighborColumn < 0 || neighborRow < 0 || neighborColumn >= columns || neighborRow >= rows) continue;
        const neighbor = grid[neighborRow * columns + neighborColumn];
        if (neighbor >= 0 && Math.hypot(points[neighbor][0] - point[0], points[neighbor][1] - point[1]) < radius) return false;
      }
    }
    return accept(point);
  };
  const insert = (point) => {
    const [column, row] = cellOf(point);
    grid[row * columns + column] = points.length;
    points.push(point);
  };
  // Restarts let the fill cross regions that exclusion has cut off from the first dart.
  for (let restart = 0; restart < 24; restart++) {
    const start = [lerp(area.minX, area.maxX, random()), lerp(area.minZ, area.maxZ, random())];
    if (!isFree(start)) continue;
    const active = [points.length];
    insert(start);
    while (active.length) {
      const activeIndex = Math.floor(random() * active.length);
      const origin = points[active[activeIndex]];
      let placed = false;
      for (let attempt = 0; attempt < 24 && !placed; attempt++) {
        const angle = random() * FULL_TURN;
        const distance = radius * (1 + random());
        const candidate = [origin[0] + Math.cos(angle) * distance, origin[1] + Math.sin(angle) * distance];
        if (!isFree(candidate)) continue;
        active.push(points.length);
        insert(candidate);
        placed = true;
      }
      if (!placed) active.splice(activeIndex, 1);
    }
  }
  return points;
}

function slopeDegrees(terrainHeight, x, z) {
  const step = 0.6;
  const slopeX = (terrainHeight(x + step, z) - terrainHeight(x - step, z)) / (2 * step);
  const slopeZ = (terrainHeight(x, z + step) - terrainHeight(x, z - step)) / (2 * step);
  return Math.atan(Math.hypot(slopeX, slopeZ)) * 180 / Math.PI;
}

function chooseSpecies(speciesNames, weights, x, z, seed, random) {
  const scores = speciesNames.map((name, index) => weights[name] * (0.15 + valueNoise(x / 22, z / 22, seed + index * 17)) ** 2);
  let pick = random() * scores.reduce((total, score) => total + score, 0);
  for (let index = 0; index < scores.length; index++) {
    pick -= scores[index];
    if (pick <= 0) return speciesNames[index];
  }
  return speciesNames[speciesNames.length - 1];
}

function instanceMatrix(position, yaw, scale) {
  return mat4.fromRotationTranslationScale(mat4.create(), quat.setAxisAngle(quat.create(), WORLD_UP, yaw), position, [scale, scale, scale]);
}

function instanceParts(instance, levelIndex, label) {
  if (!instance.partsByLevel[levelIndex]) {
    instance.partsByLevel[levelIndex] = instance.variant.levels[levelIndex].parts.map((part) => ({
      name: `${label} ${part.role}`,
      geometry: part.geometry,
      shadowLods: part.shadowLods,
      matrix: instance.matrix,
      material: part.tintable ? { ...part.material, color: part.material.color.map((channel, axis) => Math.min(1, channel * instance.tint[axis])) } : part.material,
    }));
  }
  return instance.partsByLevel[levelIndex];
}

/**
 * Scatters vegetation with Poisson-disk spacing. `area` is `{ minX, maxX, minZ, maxZ }`, `density` is
 * instances per square meter, `slopeLimit` is degrees, `exclusion(x, z)` returns true to keep a spot clear
 * `barkTextures` and `leafTextures` (one set or one per species) swap procedural bark and leaf cards for scanned textures, and `mix` weighs species ('broadleaf', 'birch', 'conifer', 'palm', 'bush', 'grass', 'flowers').
 * A few variants per species are shared by every instance, so the renderer batches them as instances.
 * Returns `{ instances, parts, variants, counts }`; `parts` shows every instance at full detail.
 */
export function scatterVegetation({
  area, density = 0.012, terrainHeight = () => 0, slopeLimit = 32, exclusion = () => false, seed = 1,
  mix = DEFAULT_MIX, variants = 3, leaves = 'cards', scale = [0.8, 1.25], spacing, barkTextures, leafTextures,
} = {}) {
  if (!area || ![area.minX, area.maxX, area.minZ, area.maxZ].every(Number.isFinite) || area.maxX <= area.minX || area.maxZ <= area.minZ) {
    throw new TypeError('Scatter area needs finite minX < maxX and minZ < maxZ.');
  }
  if (!(density > 0)) throw new RangeError('Scatter density must be positive.');
  const random = createRandom(seed);
  const speciesNames = Object.keys(mix).filter(name => mix[name] > 0);
  const accept = ([x, z]) => slopeDegrees(terrainHeight, x, z) <= slopeLimit && !exclusion(x, z);
  const points = poissonDiskPoints(area, spacing ?? Math.sqrt(0.6 / density), random, accept);
  const variantsBySpecies = {};
  const counts = {};
  const instances = points.map(([x, z], index) => {
    const species = chooseSpecies(speciesNames, mix, x, z, seed, random);
    if (!variantsBySpecies[species]) {
      variantsBySpecies[species] = Array.from({ length: variants }, (_, variantIndex) => createVariant(species, seed * 131 + variantIndex * 977 + species.length, variantIndex, leaves, barkTextures, leafTextures));
    }
    const variant = variantsBySpecies[species][Math.floor(random() * variants)];
    const size = randomInRange(random, scale);
    const yaw = random() * FULL_TURN;
    const position = [x, terrainHeight(x, z) - 0.04, z];
    counts[species] = (counts[species] ?? 0) + 1;
    const tint = [0.88 + random() * 0.24, 0.9 + random() * 0.2, 0.85 + random() * 0.25];
    return { index, species, variant, position, yaw, scale: size, tint, matrix: instanceMatrix(position, yaw, size), level: 0, partsByLevel: [] };
  });
  const parts = instances.flatMap(instance => instanceParts(instance, 0, `${instance.species} ${instance.index}`));
  return { instances, parts, variants: variantsBySpecies, counts };
}

/** Dense meadow: grass clumps with a few flowers, scattered with the same rules as `scatterVegetation`. */
export function createGrassField(options = {}) {
  return scatterVegetation({ density: 2.5, mix: { grass: 1, flowers: 0.06 }, variants: 4, slopeLimit: 40, scale: [0.8, 1.4], ...options });
}

function nextLevel(currentLevel, distance, thresholds, hysteresis, cullDistance) {
  const lastLevel = thresholds.length;
  let level = currentLevel < 0 ? lastLevel : currentLevel;
  while (level < lastLevel && distance > thresholds[level] * (1 + hysteresis)) level++;
  while (level > 0 && distance < thresholds[level - 1] * (1 - hysteresis)) level--;
  const cullFactor = currentLevel < 0 ? 1 - hysteresis : 1 + hysteresis;
  return distance > cullDistance * cullFactor ? -1 : level;
}

/**
 * Picks a level of detail per instance from its distance to `eye`. A level changes only after the
 * distance passes its threshold by `hysteresis` (a fraction), so instances at a boundary do not flicker.
 * `fade` (a fraction, such as 0.06) cross-fades neighbouring levels with a dither; `impostors` (`true` or `{ from }`) draws the baked card from level `from` (default 3) on. Either one picks the level from the distance alone, with no hysteresis.
 * Returns `{ parts, changed, levelCounts, culled, triangles }` (`culled` counts instances past `cullDistance`); rebuild or update the renderer when `changed` is true.
 */
export function selectLevels(instances, eye, { distanceScale = 1, hysteresis = 0.12, cullDistance = Infinity, fade = 0, impostors = false, pixelError = null } = {}) {
  if (fade > 0 || impostors) return selectBlendedLevels(instances, eye, { distanceScale, fade: fade || DEFAULT_FADE_BAND, cullDistance, impostors, pixelError });
  const parts = [];
  const levelCounts = [];
  let changed = false;
  let culled = 0;
  let triangles = 0;
  const pixelScale = pixelError ? pixelErrorScale(pixelError) : 1;
  for (const instance of instances) {
    const distance = Math.hypot(eye[0] - instance.position[0], eye[1] - instance.position[1], eye[2] - instance.position[2]);
    const thresholds = instance.variant.distances.map(threshold => threshold * distanceScale * pixelScale * (pixelError ? instance.scale : 1));
    const level = nextLevel(instance.level, distance, thresholds, hysteresis, cullDistance);
    if (level !== instance.level) changed = true;
    instance.level = level;
    if (level < 0) {
      culled++;
      continue;
    }
    levelCounts[level] = (levelCounts[level] ?? 0) + 1;
    parts.push(...instanceParts(instance, level, `${instance.species} ${instance.index}`));
    triangles += instance.variant.levels[level].triangles;
  }
  return { parts, changed, levelCounts: Array.from(levelCounts, count => count ?? 0), culled, triangles };
}

/** The level of detail for one distance, without hysteresis: a pure function of the distance, or -1 past cullDistance. */
export function levelForDistance(distance, variant, { distanceScale = 1, cullDistance = Infinity } = {}) {
  return nextLevel(-1, distance, variant.distances.map(threshold => threshold * distanceScale), 0, cullDistance);
}

/** Renderer parts for one tree (or clump) placed by `matrix`, at a level of detail. */
export function vegetationParts(variant, matrix, levelIndex = 0, name = variant.species) {
  return variant.levels[levelIndex].parts.map(part => ({ name: `${name} ${part.role}`, geometry: part.geometry, shadowLods: part.shadowLods, matrix, material: part.material }));
}
