// Sizes and sky shared by the page, the driver and the tests; no browser imports here, so Node can load it.
export const SKY_RADIANCE = 0.6;
export const IMAGE_WIDTH = 640;
export const IMAGE_HEIGHT = 360;

// The looks the default look bench draws and scores (issue #988). Plain data, so a Node test can read it.
// "default" rows leave every option at the library's own default. The other Crucible rows change one option each.
// three.js rows use renderer.toneMapping as three.js leaves it (none), and with ACES at exposure 1.
export const DEFAULT_LOOK_VARIANTS = {
  'crucible-default': { engine: 'crucible', label: 'Crucible defaults', rendererOptions: {}, effects: { ambientOcclusion: 0, ambientOcclusionRadius: 0.5 } },
  'crucible-ao': { engine: 'crucible', label: 'Crucible, ambient occlusion 0.5', rendererOptions: { depth: true }, effects: { ambientOcclusion: 0.5, ambientOcclusionRadius: 0.5 } },
  'crucible-samples8': { engine: 'crucible', label: 'Crucible, 8 samples', rendererOptions: { samples: 8 }, effects: { ambientOcclusion: 0, ambientOcclusionRadius: 0.5 } },
  'crucible-hdr': { engine: 'crucible', label: 'Crucible, hdr on', rendererOptions: { hdr: true }, effects: { ambientOcclusion: 0, ambientOcclusionRadius: 0.5 } },
  'three-default': { engine: 'three', label: 'three.js defaults', rendererSettings: () => ({}) },
  'three-aces': {
    engine: 'three',
    label: 'three.js, ACES tone mapping',
    // three.js folds the 1 / 0.6 pre-exposure of the ACES fit into the curve, so exposure 1 is the same scene exposure as Crucible.
    rendererSettings: three => ({ toneMapping: three.ACESFilmicToneMapping, toneMappingExposure: 1 }),
  },
};

export const BASELINE_VARIANT = 'crucible-default';
export const CHALLENGER_VARIANTS = ['crucible-ao', 'crucible-samples8', 'crucible-hdr'];
