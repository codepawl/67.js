// Camera effects stay off in every preset; a recipe turns them on with a blur above zero or a shutter above zero.
const CAMERA_OFF = Object.freeze({ depthOfField: Object.freeze({ blur: 0, focusDistance: 5 }), motionBlur: Object.freeze({ shutter: 0 }) });

export const EFFECT_PRESETS = Object.freeze({
  neutral: Object.freeze({ depthOfField: CAMERA_OFF.depthOfField, motionBlur: CAMERA_OFF.motionBlur, saturation: 1, contrast: 1, temperature: 0, vignette: 0, grain: 0, ambientOcclusion: 0, ambientOcclusionRadius: 0.5, bloom: Object.freeze({ strength: 0, threshold: 1, radius: 1 }) }),
  cinematic: Object.freeze({ depthOfField: CAMERA_OFF.depthOfField, motionBlur: CAMERA_OFF.motionBlur, saturation: 0.88, contrast: 1.08, temperature: 0.08, vignette: 0.16, grain: 0.012, ambientOcclusion: 0, ambientOcclusionRadius: 0.5, bloom: Object.freeze({ strength: 0.25, threshold: 1, radius: 1.5 }) }),
  vivid: Object.freeze({ depthOfField: CAMERA_OFF.depthOfField, motionBlur: CAMERA_OFF.motionBlur, saturation: 1.15, contrast: 1.03, temperature: 0, vignette: 0.06, grain: 0, ambientOcclusion: 0, ambientOcclusionRadius: 0.5, bloom: Object.freeze({ strength: 0.3, threshold: 0.9, radius: 1.2 }) }),
});

function numberInRange(value, fallback, minimum, maximum, name) {
  const result = value ?? fallback;
  if (!Number.isFinite(result) || result < minimum || result > maximum) throw new Error(`${name} must be between ${minimum} and ${maximum}.`);
  return result;
}

export function resolveEffects(effects = {}) {
  if (!effects || typeof effects !== 'object' || Array.isArray(effects)) throw new Error('Effects must be an object.');
  const bloom = effects.bloom ?? {};
  if (!bloom || typeof bloom !== 'object' || Array.isArray(bloom)) throw new Error('Bloom must be an object.');
  const depthOfField = effects.depthOfField ?? {};
  const motionBlur = effects.motionBlur ?? {};
  if (typeof depthOfField !== 'object' || Array.isArray(depthOfField)) throw new Error('Depth of field must be an object.');
  if (typeof motionBlur !== 'object' || Array.isArray(motionBlur)) throw new Error('Motion blur must be an object.');
  return {
    depthOfField: {
      blur: numberInRange(depthOfField.blur, 0, 0, 1, 'Depth of field blur'),
      focusDistance: numberInRange(depthOfField.focusDistance, 5, 0.01, 100000, 'Depth of field focus distance'),
    },
    // `objects` (0 to 1, how much of each part's own motion to smear) appears only when set, so a scene without it resolves as before.
    motionBlur: { shutter: numberInRange(motionBlur.shutter, 0, 0, 0.5, 'Motion blur shutter'),
      ...(motionBlur.objects > 0 ? { objects: numberInRange(motionBlur.objects, 0, 0, 1, 'Motion blur objects') } : {}) },
    saturation: numberInRange(effects.saturation, 1, 0, 2, 'Saturation'),
    contrast: numberInRange(effects.contrast, 1, 0.1, 2, 'Contrast'),
    temperature: numberInRange(effects.temperature, 0, -1, 1, 'Temperature'),
    vignette: numberInRange(effects.vignette, 0, 0, 1, 'Vignette'),
    grain: numberInRange(effects.grain, 0, 0, 0.1, 'Grain'),
    ambientOcclusion: numberInRange(effects.ambientOcclusion, 0, 0, 1, 'Ambient occlusion'),
    ambientOcclusionRadius: numberInRange(effects.ambientOcclusionRadius, 0.5, 0.01, 100, 'Ambient occlusion radius'),
    bloom: {
      strength: numberInRange(bloom.strength, 0, 0, 2, 'Bloom strength'),
      threshold: numberInRange(bloom.threshold, 1, 0, 10, 'Bloom threshold'),
      radius: numberInRange(bloom.radius, 1, 0.1, 4, 'Bloom radius'),
    },
  };
}
