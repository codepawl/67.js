// What each tier runs in the tier benchmark. Names are working names from issue #890; `quality` is planned (#904), so none of this is an API.
// A Glaze tier is the set of Renderer67 options plus the frame effects of the reference harness. A setting that is not listed keeps its default.

// The realtime tier is Glaze as the reference suite draws it: every option at the value bench/reference/harness.js passes.
export const REALTIME_TIER = {
  label: 'realtime',
  rendererOptions: {
    // The suite's own choice for an HDR frame with a depth buffer, which the fog and occlusion effects need.
    hdr: true,
    depth: true,
    // 4 samples of multisampling: the renderer's default.
    samples: 4,
    // One canvas pixel per CSS pixel, so the frame is the size of the viewport (the renderer's default is 1.5).
    pixelRatio: 1,
    // Full shading: image based lighting, soft shadows and the specular model of the 'full' mode.
    shading: 'full',
  },
  frameEffects: {
    // Ambient occlusion and bloom are off by default; the suite leaves them off.
    ambientOcclusion: 0,
  },
};

// The draft tier (planned name): the cheapest frame Glaze can draw today, with the settings that exist now.
// Before 2026-11-11 this was only pixelRatio 0.5, 1 sample and light shading, which measured the same frame time as realtime on a small
// scene (the cost there is the pixel read). Two more existing settings now apply: an 8 bit target instead of a half float one, and a
// coarser level of detail.
export const DRAFT_TIER = {
  label: 'draft (planned name)',
  rendererOptions: {
    // 8 bit colour target: half the bytes of the half float target on every pass. The depth buffer stays, the fog needs it.
    hdr: false,
    depth: true,
    // Half the render scale: a quarter of the pixels, then shown at the viewport size by the browser or by the scorer.
    pixelRatio: 0.5,
    // The least multisampling the renderer accepts (it rejects 0): 1 sample is no multisampling, so edges alias, which is the
    // first thing a draft gives up. The drawn sample count is recorded as capabilities.samples in glaze.json.
    samples: 1,
    // 'light' shading drops the prefiltered environment lookup and the wide shadow filter and uses a cheaper Fresnel term.
    shading: 'light',
    // Switch to a coarser mesh when it is 4 pixels off instead of 1 (the default), which fewer triangles draw.
    lodPixelError: 4,
  },
  frameEffects: {
    // No ambient occlusion pass. Bloom is off unless a frame asks for it, and this one does not.
    ambientOcclusion: 0,
  },
  // Not a setting: the shadow map is 2048 by 2048 whenever a part casts (SHADOW_MAP_SIZE in src/renderer.js), so no cheaper shadow exists yet.
  notAvailable: ['smaller shadow map', 'screen space effects off by name'],
};

// Tiers that only explain the numbers, never a table row: each changes one thing between realtime and draft, to see what the score and the
// time follow. Run them with run-glaze.mjs --tiers realtime-half,draft-full,draft-hdr,draft-before.
export const DIAGNOSTIC_TIERS = {
  'realtime-half': { label: 'realtime at 0.5 render scale', rendererOptions: { ...REALTIME_TIER.rendererOptions, pixelRatio: 0.5 }, frameEffects: REALTIME_TIER.frameEffects },
  'draft-full': { label: 'draft with full shading', rendererOptions: { ...DRAFT_TIER.rendererOptions, shading: 'full' }, frameEffects: DRAFT_TIER.frameEffects },
  'draft-hdr': { label: 'draft with a half float target', rendererOptions: { ...DRAFT_TIER.rendererOptions, hdr: true }, frameEffects: DRAFT_TIER.frameEffects },
  'draft-before': { label: 'draft as of #931 (scale 0.5, light, hdr, default level of detail)', rendererOptions: { ...DRAFT_TIER.rendererOptions, hdr: true, lodPixelError: 1 }, frameEffects: DRAFT_TIER.frameEffects },
};

// The EEVEE 5.3 counterparts, applied by render-eevee.py. EEVEE draws its default of 64 samples for a final frame; the draft row
// uses the least it can: one sample, no shadow soft rays, no raytracing.
export const EEVEE_PRESETS = {
  default: { taaRenderSamples: 64, raytracing: false, description: 'EEVEE 5.3 defaults, as a new scene opens' },
  lowest: { taaRenderSamples: 1, raytracing: false, shadowRayCount: 1, shadowStepCount: 1, description: 'EEVEE 5.3 at one sample with the fewest shadow rays and steps' },
};

export const BASE_RESOLUTION = { width: 960, height: 540 };
export const HIGH_RESOLUTION = { width: 1920, height: 1080 };
