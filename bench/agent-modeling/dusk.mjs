// A still life and three offered colour grades. The prompt describes the look in words (warm, mid-tones, readable)
// and offers three grades. Which one meets the description only shows in the
// picture: the check draws the exported recipe in headless Chrome and measures the pixels, so it grades the look that
// came out and not the numbers the agent typed.

export const DUSK_GRADES = {
  dusk: { exposure: 1.1, contrast: 1.4, saturation: 1.0, temperature: 0.45 },
  golden: { exposure: 1.4, contrast: 1.2, saturation: 1.0, temperature: 0.45 },
  airy: { exposure: 2.5, contrast: 1.0, saturation: 1.0, temperature: 0.45 },
};
export const DUSK_START_GRADE = 'dusk';
export const DUSK_BEST_GRADE = 'golden';

export function duskRecipe(grade) {
  const parts = [
    { id: 'floor', geometry: 'block', material: 'oak', scale: [4, 0.05, 3], translation: [0, -0.025, 0] },
    { id: 'wall', geometry: 'block', material: 'plaster', scale: [4, 2.2, 0.1], translation: [0, 1.1, -1.5] },
    { id: 'table', geometry: 'block', material: 'oak', scale: [1.4, 0.06, 0.8], translation: [0, 0.72, -0.4] },
    { id: 'jug', geometry: 'block', material: 'glaze', scale: [0.18, 0.3, 0.18], translation: [-0.35, 0.9, -0.4] },
    { id: 'loaf', geometry: 'block', material: 'crust', scale: [0.4, 0.14, 0.2], translation: [0.2, 0.82, -0.3] },
    { id: 'cloth', geometry: 'block', material: 'linen', scale: [0.5, 0.01, 0.5], translation: [0.2, 0.755, -0.3] },
  ];
  return {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'block', type: 'box', bevel: 0.01 }],
    materials: [
      { id: 'oak', color: [0.45, 0.3, 0.17] },
      { id: 'plaster', color: [0.85, 0.82, 0.75] },
      { id: 'glaze', color: [0.15, 0.4, 0.5] },
      { id: 'crust', color: [0.62, 0.38, 0.15] },
      { id: 'linen', color: [0.92, 0.9, 0.84] },
    ],
    nodes: parts,
    camera: { target: [0, 0.85, -0.4], eye: [0, 1.5, 2.2], up: [0, 1, 0], fov: 40, near: 0.1, far: 50 },
    environment: { environmentIntensity: 0.2, keyColor: [1, 0.7, 0.4], keyIntensity: 2.2, lightDirection: [-0.5, -0.45, -0.7] },
    effects: { ...DUSK_GRADES[grade] },
  };
}

export const DUSK_START = duskRecipe(DUSK_START_GRADE);
export const DUSK_SOLUTION = duskRecipe(DUSK_BEST_GRADE);

export const DUSK_PROMPT = `The still life below (a floor, a wall, a slab with a jug, a loaf and a cloth, lit by a low warm sun) is graded with "dusk" in
effects: ${JSON.stringify(DUSK_GRADES.dusk)}. Two other grades are candidates: "golden" ${JSON.stringify(DUSK_GRADES.golden)} and "airy" ${JSON.stringify(DUSK_GRADES.airy)}.
The picture from the recipe camera should read as a warm late-afternoon photograph in mid-tones: the whole slab and
what stands on it easy to read, neither dim and heavy nor pale and washed out. Keep the grade whose picture fits that
look. Change only the effects block, not the scene, camera or lights.`;

// The window is measured on the picture (see look.mjs measureRenderedLook): mean brightness over the whole frame, and
// the shares of clipped and crushed pixels. Dusk draws at about 0.25, golden at 0.35, airy at 0.52.
export const DUSK_CHECKS = [
  { kind: 'lint' },
  { kind: 'parts', min: 6, max: 6 },
  ...[['table', [0, 0.72, -0.4]], ['jug', [-0.35, 0.9, -0.4]], ['loaf', [0.2, 0.82, -0.3]]].map(([node, position]) => ({ kind: 'centreAt', node, position })),
  { kind: 'renderedLook', brightness: [0.3, 0.46], maxClipped: 0.01, maxCrushed: 0.02 },
];
