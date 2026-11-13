// Scene variants that split the texture residuals of #1030 (cutout brightness, textured-emitter light samples, brick-graph).
//   node bench/cycles-parity/residual-variants.mjs <outputDirectory>
// Writes <outputDirectory>/scenes/<id>.json, loaded by `trace-native.mjs` and `render-cycles.py` like any parity scene.
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { TEXTURE_SCENES } from './texture-scenes.mjs';
import { loadReferenceScene, serializeSceneDescription } from './scene-bridge.mjs';

const TEXTURE_SIZE = 16;

function findPart(scene, name) {
  const found = scene.parts.find((part) => part.name === name);
  if (!found) {
    throw new RangeError(`The scene has no part named "${name}".`);
  }
  return found;
}

function setMaskAlpha(scene, alphaOfTexelColumn) {
  const image = findPart(scene, 'mask').material.map.image;
  for (let row = 0; row < TEXTURE_SIZE; row++) {
    for (let column = 0; column < TEXTURE_SIZE; column++) {
      image.data[(row * TEXTURE_SIZE + column) * 4 + 3] = alphaOfTexelColumn(column);
    }
  }
}

const MASK_VARIANTS = {
  'mask-base': () => TEXTURE_SCENES['tex-split-mask'](),
  // Only the world light, then only the point lights: which kind of shadow ray sees the excess.
  'mask-world-only': () => {
    const scene = TEXTURE_SCENES['tex-split-mask']();
    scene.environment = { ...scene.environment, pointLights: [] };
    return scene;
  },
  'mask-lights-only': () => {
    const scene = TEXTURE_SCENES['tex-split-mask']();
    scene.blenderWorld = { type: 'constant', value: 0 };
    return scene;
  },
  // A hard edge in the stored alpha: nothing for a filter to blend, so the hole edge cannot depend on how alpha is filtered.
  'mask-binary-alpha': () => {
    const scene = TEXTURE_SCENES['tex-split-mask']();
    setMaskAlpha(scene, (column) => (column >= TEXTURE_SIZE / 2 ? 255 : 0));
    return scene;
  },
  // Stored alpha of 0.30 and 0.70 instead of 0 and 1: partial alpha values on both sides of a hard edge.
  'mask-two-level-alpha': () => {
    const scene = TEXTURE_SCENES['tex-split-mask']();
    setMaskAlpha(scene, (column) => (column >= TEXTURE_SIZE / 2 ? 178 : 77));
    return scene;
  },
  // The ramp of tex-split-mask shifted so that the blend of two texels crosses the cutoff off the exact tie at 0.5.
  'mask-off-tie-ramp': () => {
    const scene = TEXTURE_SCENES['tex-split-mask']();
    setMaskAlpha(scene, (column) => (column >= TEXTURE_SIZE / 2 ? 160 + (column - 8) * 10 : 20 + column * 10));
    return scene;
  },
  // Cutoff nudged either way, to see how fast the mean follows it.
  'mask-cutoff-low': () => {
    const scene = TEXTURE_SCENES['tex-split-mask']();
    findPart(scene, 'mask').material.alphaCutoff = 0.46;
    return scene;
  },
  'mask-cutoff-high': () => {
    const scene = TEXTURE_SCENES['tex-split-mask']();
    findPart(scene, 'mask').material.alphaCutoff = 0.54;
    return scene;
  },
  'mask-all-holes': () => {
    const scene = TEXTURE_SCENES['tex-split-mask']();
    setMaskAlpha(scene, () => 0);
    return scene;
  },
};

async function brickVariants() {
  const variants = {};
  const { rawScene: withNormalMap } = await loadReferenceScene('brick-graph');
  variants['brick-graph'] = withNormalMap;
  const { rawScene: withoutNormalMap } = await loadReferenceScene('brick-graph');
  const wallMaterial = withoutNormalMap.parts.find((part) => part.name === 'wall').material;
  delete wallMaterial.normalMap;
  delete wallMaterial.graph;
  delete wallMaterial.graphBump;
  variants['brick-no-normal-map'] = withoutNormalMap;
  const { rawScene: flat } = await loadReferenceScene('brick-flat');
  variants['brick-flat'] = flat;
  return variants;
}

async function writeVariant(scenesDirectory, sceneId, scene) {
  const description = await serializeSceneDescription(sceneId, scene);
  await writeFile(join(scenesDirectory, `${sceneId}.json`), JSON.stringify(description));
  const wall = description.materials.find((material) => material.normalMap);
  console.log(JSON.stringify({ sceneId, parts: description.parts.length, hasNormalMap: Boolean(wall) }));
}

const outputDirectory = process.argv[2];
if (!outputDirectory) {
  throw new RangeError('Usage: node bench/cycles-parity/residual-variants.mjs <outputDirectory>');
}
const scenesDirectory = join(resolve(outputDirectory), 'scenes');
await mkdir(scenesDirectory, { recursive: true });
for (const [sceneId, build] of Object.entries(MASK_VARIANTS)) {
  await writeVariant(scenesDirectory, sceneId, build());
}
for (const sceneId of ['tex-emit-floor', 'tex-repeat', 'tex-wraps']) {
  await writeVariant(scenesDirectory, sceneId, TEXTURE_SCENES[sceneId]());
}
for (const [sceneId, scene] of Object.entries(await brickVariants())) {
  await writeVariant(scenesDirectory, sceneId, scene);
}
