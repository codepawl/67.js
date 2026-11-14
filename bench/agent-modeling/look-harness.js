// Runs in the page: draws a recipe from each fixed camera, the way the MCP preview draws a scene.
import { createAgentScene, loadAllAgentSceneModules, loadMeshBooleans, needsMeshBooleans } from '/src/agent-scene.js';
import { agentEnvironmentMap, resolveAgentShadow } from '/src/agent-look.js';
import { agentGroundPlacement, createAgentGround } from '/src/agent-ground.js';
import { CrucibleRenderer } from '/src/renderer.js';

const CLIPPED_CHANNEL = 250;
const CRUSHED_LUMA = 12;

/** Mean brightness, warmth (mean red over mean blue), and the shares of clipped and crushed pixels of a drawn canvas. */
function pixelStatistics(canvas) {
  const copy = document.createElement('canvas');
  copy.width = canvas.width;
  copy.height = canvas.height;
  const context = copy.getContext('2d');
  context.drawImage(canvas, 0, 0);
  const { data } = context.getImageData(0, 0, copy.width, copy.height);
  const pixelCount = data.length / 4;
  let lumaTotal = 0;
  let redTotal = 0;
  let blueTotal = 0;
  let clipped = 0;
  let crushed = 0;
  for (let index = 0; index < data.length; index += 4) {
    const red = data[index];
    const green = data[index + 1];
    const blue = data[index + 2];
    const luma = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
    lumaTotal += luma;
    redTotal += red;
    blueTotal += blue;
    if (red >= CLIPPED_CHANNEL && green >= CLIPPED_CHANNEL && blue >= CLIPPED_CHANNEL) clipped++;
    if (luma <= CRUSHED_LUMA) crushed++;
  }
  return {
    meanBrightness: lumaTotal / pixelCount / 255,
    warmth: redTotal / Math.max(blueTotal, 1),
    clippedShare: clipped / pixelCount,
    crushedShare: crushed / pixelCount,
  };
}

async function renderLookViews(recipe, views, measure = false) {
  await loadAllAgentSceneModules();
  if (needsMeshBooleans(recipe)) await loadMeshBooleans();
  const scene = createAgentScene(recipe);
  if (recipe.motion) scene.sampleMotion(0);
  const canvas = document.querySelector('canvas');
  // The MCP preview lights a recipe with the setup's environment map; without it the images would show a darker scene than agents get.
  const environment = { ...scene.environment, map: agentEnvironmentMap(scene.environment) };
  const effects = scene.effects;
  const placement = agentGroundPlacement(scene.parts, scene.environment);
  const renderer = new CrucibleRenderer(canvas, scene.parts, {
    ground: placement ? createAgentGround(placement) : false, hdr: true, depth: true, samples: 1, pixelRatio: 1, memoryBudgetMiB: 512,
    world: environment.world, environment,
    shadowBounds: resolveAgentShadow(scene.shadow, environment.lightDirection),
  });
  const images = [];
  try {
    for (const { name, camera: viewCamera } of views) {
      // A view with no camera of its own is drawn from the recipe camera, the one the MCP preview uses.
      const camera = viewCamera ?? scene.camera;
      renderer.resize();
      renderer.updateParts(scene.parts);
      renderer.render({ ...camera, environment, effects, exposure: effects.exposure, time: 0 });
      renderer.render({ ...camera, environment, effects, exposure: effects.exposure, time: 0 });
      const glError = renderer.context.getError();
      if (glError !== 0) throw new Error(`${name} gave WebGL error ${glError}.`);
      images.push(measure
        ? { name, statistics: pixelStatistics(canvas) }
        : { name, image: canvas.toDataURL('image/png').split(',')[1] });
    }
  } finally {
    renderer.dispose();
  }
  return images;
}

window.renderLookViews = renderLookViews;
