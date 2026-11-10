// Live hero for the homepage, drawn by Glaze (Renderer67): the staged airport ramp world
// (a 787 at its stand, the turnaround crew, service trucks, terminal and tower) with cascaded
// shadows and an HDRI sky. Visitors orbit it or pick one of four shots, one a surface-normal view.
import './replace-textured-parts.js';
import { Glaze } from './renderer.js';
import { createSharedTextures, loadGltf } from './gltf.js';
import { loadHdri } from './hdri.js';
import { createCascadedShadows } from './cascaded-shadows.js';
import { readPartRanks } from './showcase-download.js';

const PROMPTS = {
  model: {
    prompt: '"Frame the widebody stand at golden hour with 3-cascade shadows across the Boeing 787-9, service trucks, and ground crew."',
    state: {
      eye: [138, 64, 36],
      target: [1, 3, -13],
      fov: 20,
      inspection: false,
      exposure: 1.0,
    },
  },
  explode: {
    prompt: '"Sweep down to ramp level beside the nose gear, turbofan cowling, pushback tug, and ground turnaround crew."',
    state: {
      eye: [58, 31, 84],
      target: [-8, 3, -18],
      fov: 24,
      inspection: false,
      exposure: 1.04,
    },
  },
  blend: {
    prompt: '"Orbit across the carbon wing, fuel tanker, terminal pier, and control tower against the Industrial Sunset HDRI sky."',
    state: {
      eye: [-86, 36, 82],
      target: [6, 8, -16],
      fov: 24,
      inspection: false,
      exposure: 1.02,
    },
  },
  review: {
    prompt: '"Switch Glaze to world-space surface normal inspection across the airliner fuselage, turbine blades, and ground vehicles."',
    state: {
      eye: [72, 26, 56],
      target: [-2, 4, -14],
      fov: 22,
      inspection: true,
      exposure: 1.0,
    },
  },
};

function orbitFromCamera(eye, target) {
  const dx = eye[0] - target[0];
  const dy = eye[1] - target[1];
  const dz = eye[2] - target[2];
  const distance = Math.hypot(dx, dy, dz) || 1;
  return {
    yaw: Math.atan2(dx, dz),
    pitch: Math.asin(Math.max(-0.99, Math.min(0.99, dy / distance))),
    distance,
    target: [...target],
  };
}

function eyeFromOrbit(orbit) {
  const horiz = Math.cos(orbit.pitch) * orbit.distance;
  return [
    orbit.target[0] + Math.sin(orbit.yaw) * horiz,
    orbit.target[1] + Math.sin(orbit.pitch) * orbit.distance,
    orbit.target[2] + Math.cos(orbit.yaw) * horiz,
  ];
}

function inWholeWorldOrder(files) {
  if (files.some(file => !file.ranks || file.ranks.length !== file.parts.length)) {
    return files.flatMap(file => file.parts);
  }
  const ranked = files.flatMap(file =>
    file.parts.map((part, index) => ({ part, rank: file.ranks[index] })),
  );
  return ranked.sort((a, b) => a.rank - b.rank).map(entry => entry.part);
}

async function fetchBlob(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to fetch ${url} (${response.status})`);
  return response.blob();
}

const LIVE_HERO_QUERY = '(min-width: 961px) and (prefers-reduced-motion: no-preference)';
const AUTO_CYCLE_MS = 7500;

// The live hero only runs where it is cheap to: a wide screen, no data saver, motion allowed.
// Everywhere else the poster image stays, so phones never download the world.
function liveHeroAllowed() {
  if (navigator.connection?.saveData) return false;
  return window.matchMedia(LIVE_HERO_QUERY).matches;
}

function afterPageSettles(start) {
  const whenIdle = () => {
    if ('requestIdleCallback' in window) requestIdleCallback(start, { timeout: 2500 });
    else setTimeout(start, 300);
  };
  if (document.readyState === 'complete') whenIdle();
  else window.addEventListener('load', whenIdle, { once: true });
}

export function mountHeroAgentWorkbench() {
  if (!liveHeroAllowed()) return;
  afterPageSettles(() => mountHomeAgentHero());
}

function createOrbitState(preset) {
  const orbit = orbitFromCamera(preset.state.eye, preset.state.target);
  return {
    yaw: orbit.yaw,
    pitch: orbit.pitch,
    distance: orbit.distance,
    target: [...orbit.target],
    fov: preset.state.fov,
    exposure: preset.state.exposure,
    inspection: preset.state.inspection,
  };
}

export async function mountHomeAgentHero() {
  const canvas = document.querySelector('#hero-viewport');
  const frame = document.querySelector('.hero-frame');
  if (!canvas || !frame) return;

  let renderer = null;
  let activeMap = null;
  let sceneDescription = null;
  let sharedTextures = null;
  let firstAsset = null;
  let firstRanks = null;

  try {
    const descriptionResponse = await fetch('/showcase/airport/scene.json');
    if (!descriptionResponse.ok) throw new Error(`Airport scene description unavailable (${descriptionResponse.status})`);
    sceneDescription = await descriptionResponse.json();

    const glbUrl = new URL(sceneDescription.glb, location.href);
    const previewSkyUrl = new URL(sceneDescription.hdriPreview ?? sceneDescription.hdri, location.href).href;
    const [firstBlob, previewMap] = await Promise.all([
      fetchBlob(glbUrl.href),
      loadHdri(previewSkyUrl, sceneDescription.hdriOptions ?? {}),
    ]);

    sharedTextures = createSharedTextures();
    firstAsset = await loadGltf(firstBlob, {
      baseUrl: new URL('.', glbUrl).href,
      sharedTextures,
      ...(sceneDescription.gltfOptions ?? {}),
    });
    firstRanks = await readPartRanks(firstBlob);

    activeMap = previewMap;
    const rendererOptions = sceneDescription.renderer ?? {};
    const shadowCascades = rendererOptions.shadowCascades
      ? createCascadedShadows(rendererOptions.shadowCascades)
      : undefined;

    renderer = new Glaze(canvas, firstAsset.parts, {
      ground: false,
      hdr: true,
      depth: true,
      samples: 4,
      pixelRatio: Math.min(window.devicePixelRatio || 1, 1.5),
      memoryBudgetMiB: 512,
      ...rendererOptions,
      shadowCascades,
      environment: {
        ...(rendererOptions.environment ?? {}),
        map: activeMap,
      },
    });
  } catch (error) {
    window.__heroWorkbench = { error: error.message };
    return;
  }

  // The rest of the world (about 11 MB) and the full sky (about 4 MB) load only once someone
  // engages with the hero, so a visitor who scrolls past pays for the first stage alone.
  let fullWorldRequested = false;
  async function loadFullWorld() {
    if (fullWorldRequested) return;
    fullWorldRequested = true;
    try {
      const restPaths = sceneDescription.glbRest ?? [];
      const fullSkyUrl = new URL(sceneDescription.hdri, location.href).href;
      const [restBlobs, fullMap] = await Promise.all([
        Promise.all(restPaths.map(path => fetchBlob(new URL(path, location.href).href))),
        loadHdri(fullSkyUrl, sceneDescription.hdriOptions ?? {}).catch(() => null),
      ]);
      if (restBlobs.length > 0) {
        const files = [{ parts: firstAsset.parts, ranks: firstRanks }];
        for (let index = 0; index < restBlobs.length; index++) {
          const baseUrl = new URL('.', new URL(restPaths[index], location.href)).href;
          const restAsset = await loadGltf(restBlobs[index], {
            baseUrl,
            sharedTextures,
            ...(sceneDescription.gltfOptions ?? {}),
          });
          files.push({ parts: restAsset.parts, ranks: await readPartRanks(restBlobs[index]) });
        }
        renderer.replaceParts(inWholeWorldOrder(files));
      }
      if (fullMap) activeMap = fullMap;
    } catch (error) {
      window.__heroWorkbench = { ...window.__heroWorkbench, restError: error.message };
    }
  }

  const current = createOrbitState(PROMPTS.model);
  let target = createOrbitState(PROMPTS.model);
  let activeKey = 'model';
  let dragging = false;
  let userInteracted = false;
  let pointerStart = [0, 0];
  let orbitStart = [0, 0];
  let simTime = 0;
  let lastNow = performance.now();
  let rafId = 0;
  let heroVisible = true;

  const promptElement = document.querySelector('[data-agent-prompt]');
  const presetButtons = [...document.querySelectorAll('[data-prompt-preset]')];

  function markInteracted() {
    userInteracted = true;
    loadFullWorld();
  }

  function applyPresetUI(key) {
    const preset = PROMPTS[key];
    if (!preset) return;
    activeKey = key;
    target = createOrbitState(preset);
    presetButtons.forEach(button => {
      button.setAttribute('aria-pressed', String(button.dataset.promptPreset === key));
    });
    if (promptElement) promptElement.textContent = preset.prompt;
  }

  presetButtons.forEach(button => {
    button.addEventListener('click', () => {
      markInteracted();
      applyPresetUI(button.dataset.promptPreset);
    });
  });

  const presetKeys = Object.keys(PROMPTS);
  const autoCycle = setInterval(() => {
    if (userInteracted || document.hidden || !heroVisible) return;
    const nextIndex = (presetKeys.indexOf(activeKey) + 1) % presetKeys.length;
    applyPresetUI(presetKeys[nextIndex]);
  }, AUTO_CYCLE_MS);

  canvas.addEventListener('pointerdown', event => {
    dragging = true;
    markInteracted();
    pointerStart = [event.clientX, event.clientY];
    orbitStart = [target.yaw, target.pitch];
    canvas.setPointerCapture?.(event.pointerId);
  });

  canvas.addEventListener('pointermove', event => {
    if (!dragging) return;
    const deltaX = event.clientX - pointerStart[0];
    const deltaY = event.clientY - pointerStart[1];
    target.yaw = orbitStart[0] - deltaX * 0.0055;
    target.pitch = Math.max(0.05, Math.min(1.35, orbitStart[1] + deltaY * 0.0045));
  });

  const endDrag = () => {
    dragging = false;
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  const resizeObserver = new ResizeObserver(() => {
    renderer.resize();
  });
  resizeObserver.observe(canvas);

  const frameDefaults = sceneDescription.frame ?? {};
  const baseEffects = frameDefaults.effects ?? {};

  function renderFrame(time) {
    renderer.render({
      ...frameDefaults,
      eye: eyeFromOrbit(current),
      target: current.target,
      fov: current.fov,
      exposure: current.exposure,
      time,
      inspection: current.inspection,
      environment: {
        ...(sceneDescription.renderer?.environment ?? {}),
        map: activeMap,
      },
      effects: {
        ...baseEffects,
        ambientOcclusion: 0.55,
        ambientOcclusionRadius: 4.5,
      },
    });
  }

  function tick(now) {
    rafId = 0;
    const deltaSeconds = Math.min(0.05, Math.max(0.001, (now - lastNow) / 1000));
    lastNow = now;
    simTime += deltaSeconds;

    const blend = 1 - Math.exp(-deltaSeconds * 5.2);
    if (!dragging) target.yaw += deltaSeconds * 0.018;

    current.yaw += (target.yaw - current.yaw) * blend;
    current.pitch += (target.pitch - current.pitch) * blend;
    current.distance += (target.distance - current.distance) * blend;
    for (let axis = 0; axis < 3; axis++) {
      current.target[axis] += (target.target[axis] - current.target[axis]) * blend;
    }
    current.fov += (target.fov - current.fov) * blend;
    current.exposure += (target.exposure - current.exposure) * blend;
    current.inspection = target.inspection;

    renderFrame(simTime);
    scheduleTick();
  }

  // Stop drawing while the hero is off screen or the tab is hidden, so the GPU idles while people read.
  function scheduleTick() {
    if (rafId || !heroVisible || document.hidden) return;
    rafId = requestAnimationFrame(tick);
  }

  const visibilityObserver = new IntersectionObserver(entries => {
    heroVisible = entries.some(entry => entry.isIntersecting);
    lastNow = performance.now();
    scheduleTick();
  });
  visibilityObserver.observe(frame);
  const onVisibilityChange = () => {
    lastNow = performance.now();
    scheduleTick();
  };
  document.addEventListener('visibilitychange', onVisibilityChange);

  renderer.resize();
  // One synchronous frame before going live, so the canvas never fades in empty.
  renderFrame(0);
  frame.dataset.live = 'true';
  frame.classList.add('is-live-3d');
  scheduleTick();

  window.__heroWorkbench = { renderer, applyPresetUI, loadFullWorld, complete: true };
  window.addEventListener('pagehide', () => {
    clearInterval(autoCycle);
    if (rafId) cancelAnimationFrame(rafId);
    resizeObserver.disconnect();
    visibilityObserver.disconnect();
    document.removeEventListener('visibilitychange', onVisibilityChange);
    renderer.dispose();
  });
}
