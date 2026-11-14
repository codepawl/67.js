// A lamp with a bulb and a shade. The task offers three shade widths and states a goal that only one of them meets,
// so the check on the exported recipe tells whether the right variant was kept. How the agent compared them (branches,
// checkpoints or plain edits) is not graded; the tool calls and the tool names in the transcript show it.

const BULB_SIZE = [0.08, 0.08, 0.08];
const SHADE_HEIGHT = 0.12;
const SHADE_BOTTOM_Y = 0.38;
const STARTING_SHADE_WIDTH = 0.1;

function lampRecipe(shadeWidth) {
  const parts = [
    { id: 'base', geometry: 'block', scale: [0.16, 0.02, 0.16], translation: [0, 0.01, 0] },
    { id: 'stem', geometry: 'block', scale: [0.02, 0.35, 0.02], translation: [0, 0.195, 0] },
    { id: 'bulb', geometry: 'block', scale: BULB_SIZE, translation: [0, 0.4, 0] },
    { id: 'shade', geometry: 'block', scale: [shadeWidth, SHADE_HEIGHT, shadeWidth], translation: [0, SHADE_BOTTOM_Y + SHADE_HEIGHT / 2, 0] },
  ];
  return {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'block', type: 'box', bevel: 0 }],
    materials: [{ id: 'paint', color: [0.8, 0.75, 0.6] }],
    nodes: parts.map(part => ({ material: 'paint', ...part })),
  };
}

/** The lamp as the task starts: a shade 0.1 m wide, too narrow to cover the bulb. */
export const LAMP_START = lampRecipe(STARTING_SHADE_WIDTH);

/** The right pick: 0.18 m covers the 0.08 m bulb by 0.05 m a side and fits the 0.2 m shelf. */
export const LAMP_SOLUTION = lampRecipe(0.18);

export const LAMP_PROMPT = `The lamp scene below has a base, a stem, a 0.08 m bulb and a shade. Three shade widths are candidates: 0.1 m (as it is),
0.18 m and 0.26 m, each square in plan (X and Z) and still 0.12 m tall. Compare the three candidates and keep the one that
meets both of these goals: the shade covers the bulb with at least 0.03 m to spare on every side when seen from above, and
the whole lamp fits a shelf that is 0.2 m deep, so it is no wider than 0.2 m. The kept shade stays centred on X = 0 and
Z = 0 with its underside at 0.38 m. Leave the base, stem and bulb as they are.`;

export const LAMP_CHECKS = [
  { kind: 'lint' },
  { kind: 'size', expected: [0.18, 0.5, 0.18] },
  { kind: 'ground' },
  { kind: 'parts', min: 4, max: 4 },
  { kind: 'centreAt', node: 'shade', position: [0, 0.44, 0] },
];
