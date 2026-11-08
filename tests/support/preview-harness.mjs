import { readFile } from 'node:fs/promises';
import { Script, createContext } from 'node:vm';
import { mat4 } from 'gl-matrix';
import { createAgentScene, applyCameraFields, needsMeshBooleans, loadMeshBooleans, meshBooleansLoaded, needsPhysics, loadPhysicsEngine, physicsEngineLoaded, loadAllAgentSceneModules, allAgentSceneModulesLoaded } from '../../src/agent-scene.js';
import { normalizeBlend } from '../../src/mesh-blend.js';
import { applyProjection } from '../../src/camera.js';
import { effectsWithFStop } from '../../src/camera-effects.js';
import { resolveAgentShadow, agentEnvironmentMap } from '../../src/agent-look.js';
import { agentSceneModule, agentSceneModuleLoaded } from '../../src/agent-scene-modules.js';
import { createAgentAssetScene } from '../../src/agent-asset.js';
import { parseGltf } from '../../src/gltf.js';
import { hasPatternTextures } from '../../scripts/agent-preview-textures.js';
import { assetCopyKey, recipeAssetNeeds } from '../../src/agent-scene-assets.js';
import { BRANCH_LIMITS, createBranchStore, printableLabel } from '../../src/agent-branches.js';
import { sessionProblem } from '../../src/agent-errors.js';
import { framingProblems, exposureProblems, lumaShares } from '../../src/frame-checks.js';
import { agentAssetDecodeOptions, withCatalogLimitAdvice } from '../../src/agent-asset-limits.js';
import { sceneQueryFor, summarizeWalkMap, walkOptionsFor, createQueryOnlyCache } from '../../scripts/agent-walkmap.js';

// Runs the preview page's adapter code in a VM with a fault-injected renderer, the way the MCP preview runs it in a browser.
const source = (await readFile(new URL('../../scripts/agent-preview-browser.js', import.meta.url), 'utf8')).replace(/^import .+;\r?$/gm, '');

export function previewHarness() {
  let renderError = 0;
  let lost = false;
  let replacementError = false;
  let replacementCount = 0;
  let currentRenderer;
  let currentScene;
  const renders = [];
  const tiles = [];
  const makeCanvas = () => ({ width: 768, height: 512,
    replaceWith() {}, toDataURL: () => 'data:image/png;base64,cG5n',
    getContext(kind) { const target = this; return kind === '2d' ? { fillRect() {}, fillText() {}, strokeText() {},
      drawImage: () => { if (target.width !== 64) tiles.push(renders.at(-1)); },
      getImageData: (x, y, width, height) => ({ data: new Uint8ClampedArray(width * height * 4).fill(128) }) } : { getExtension: () => null }; } });
  const canvas = makeCanvas();
  class FaultInjectedRenderer {
    memoryPlan = { estimatedBytes: 1024 };
    capabilities = { hdr: true, samples: 4 };
    constructor(canvasElement, parts, options = {}) { currentRenderer = this; this.shadowCascades = options.shadowCascades ?? null; }
    context = {
      isContextLost: () => lost,
      getError: () => renderError,
      getExtension: () => null,
      getParameter: () => 'Test renderer',
    };
    resize() {}
    updateParts() {}
    replaceParts() {
      if (replacementError) throw new Error('Injected replacement allocation failure');
      replacementCount++;
    }
    render(camera) {
      renders.push({ camera: JSON.parse(JSON.stringify(camera)),
        parts: currentScene.parts.map(part => ({ matrix: Array.from(part.matrix),
          joints: Array.from(part.skin?.jointMatrices ?? []) })) });
    }
    dispose() {}
  }
  const context = createContext({
    window: {},
    document: { querySelector: () => canvas, createElement: makeCanvas },
    // The real browser bundles these functions in one realm. Bridge only the VM realm here.
    createAgentScene: input => {
      const scene = createAgentScene(JSON.parse(JSON.stringify(input)));
      if (scene.parts.length) currentScene = scene;
      return scene;
    },
    createAgentAssetScene: (asset, input) => {
      currentScene = createAgentAssetScene(asset, JSON.parse(JSON.stringify(input)));
      const scene = currentScene;
      const bridgedMethods = new Set(['sampleFrame', 'inspect', 'inspectMeshes']);
      return new Proxy({}, { get: (target, field) => bridgedMethods.has(field)
        ? value => scene[field](JSON.parse(JSON.stringify(value ?? {}))) : scene[field] });
    },
    needsMeshBooleans, loadMeshBooleans, meshBooleansLoaded, loadAllAgentSceneModules, allAgentSceneModulesLoaded,
    // The VM has no Worker, as in Node: builds stay synchronous, the way the preview falls back without workers.
    buildWithKernels: build => build(), kernelWorkersAvailable: () => false,
    kernelStats: () => ({ worker: 0, inline: 0, fallbacks: [] }), resetKernelStats: () => {}, performance, setInterval: () => 0,
    // The harness loads Manifold from node_modules directly, so the preview's served-file loader is ignored.
    setManifoldModuleLoader: () => {},
    needsPhysics, loadPhysicsEngine, physicsEngineLoaded, setPhysicsModuleLoader: () => {},
    sceneQueryFor, summarizeWalkMap, walkOptionsFor, createQueryOnlyCache, parseGltf, hasPatternTextures, Uint8Array, atob, sessionProblem, framingProblems, exposureProblems, lumaShares, assetCopyKey, recipeAssetNeeds, agentAssetDecodeOptions, withCatalogLimitAdvice,
    applyProjection, applyCameraFields, mat4, resolveAgentShadow, agentEnvironmentMap, BRANCH_LIMITS,
    // Line art needs a real renderer with render passes, so the fault-injected one gets a no-op install.
    agentSceneModule: name => (name === 'lineArt' ? { installLineArt: renderer => renderer } : name === 'userPass' ? { ...agentSceneModule(name), installUserPasses: renderer => renderer } : agentSceneModule(name)), agentSceneModuleLoaded, createBranchStore, printableLabel,
    Renderer67: FaultInjectedRenderer, skyOpenness: () => 1, fogSkyVisibility: () => null,
    // The fault-injected renderer has no floor part; the automatic floor is covered by agent-ground.test.js and the live smokes.
    agentGroundPlacement: () => null, createAgentGround: () => null, placeAgentGround: () => {}, FLOOR_COLOR: [0.22, 0.22, 0.21], groundBounceEnvironment: (parts, environment) => environment,
    // The optional addons only plug stages into a real renderer; the fault-injected one needs none.
    installCameraEffects: renderer => renderer, effectsWithFStop, installRenderPasses: renderer => renderer, installDepthPrecision: renderer => renderer,
    installMeshBlend: renderer => Object.assign(renderer, { meshBlend: { radii: new Map() } }), normalizeBlend,
  });
  // Evaluate only trusted repository adapter code; inject the driver boundary for failure cases.
  new Script(source).runInContext(context);
  return {
    preview: context.window.__agentPreview,
    injectError: value => { renderError = value; },
    loseContext: () => { lost = true; },
    rejectReplacement: value => { replacementError = value; },
    replacementCount: () => replacementCount,
    disableHdr: () => { currentRenderer.capabilities.hdr = false; },
    scene: () => currentScene, renders, tiles,
  };
}
