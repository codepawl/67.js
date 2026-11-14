// A cabinet of 10 parts hung on its body: a body, four feet, two doors with a handle each and a cornice. The relations
// version states where each part sits against the body; the plain version holds the same absolute positions.
// Resizing the cabinet moves every dependent part, which is the edit relations are meant to save.

const FOOT_HEIGHT = 0.08;
const FOOT_SIZE = 0.06;
const FOOT_INSET = 0.04;
const CORNICE_HEIGHT = 0.03;
const CORNICE_OVERHANG = 0.02;
const DOOR_THICKNESS = 0.02;
const DOOR_MARGIN = 0.04;
const HANDLE_SIZE = [0.02, 0.12, 0.02];
const HANDLE_INSET = 0.04;
const BODY_DEPTH = 0.5;

function placed(withRelations, relations) {
  return withRelations ? { relations } : {};
}

/** The cabinet for a body width and a total height (feet to cornice) in metres, body depth 0.5 m. */
export function cabinetRecipe(width, height, withRelations) {
  const bodyHeight = height - FOOT_HEIGHT - CORNICE_HEIGHT;
  const bodyCentreY = FOOT_HEIGHT + bodyHeight / 2;
  const frontZ = BODY_DEPTH / 2;
  const parts = [
    { id: 'body', geometry: 'block', scale: [width, bodyHeight, BODY_DEPTH], translation: [0, bodyCentreY, 0] },
  ];
  for (const [xName, xSign] of [['left', -1], ['right', 1]]) {
    for (const [zName, zSign] of [['back', -1], ['front', 1]]) {
      parts.push({
        id: `foot-${xName}-${zName}`, geometry: 'block', scale: [FOOT_SIZE, FOOT_HEIGHT, FOOT_SIZE],
        translation: [xSign * (width / 2 - FOOT_INSET - FOOT_SIZE / 2), FOOT_HEIGHT / 2, zSign * (BODY_DEPTH / 2 - FOOT_INSET - FOOT_SIZE / 2)],
        ...placed(withRelations, [
          { kind: 'gap', to: 'body', side: '-y' },
          { kind: 'align', to: 'body', axis: 'x', at: xSign < 0 ? 'min' : 'max', offset: -xSign * FOOT_INSET },
          { kind: 'align', to: 'body', axis: 'z', at: zSign < 0 ? 'min' : 'max', offset: -zSign * FOOT_INSET },
        ]),
      });
    }
  }
  const doorHeight = bodyHeight - 2 * DOOR_MARGIN;
  for (const [name, sign] of [['left', -1], ['right', 1]]) {
    parts.push({
      id: `door-${name}`, geometry: 'block', scale: [width / 2, doorHeight, DOOR_THICKNESS],
      translation: [sign * width / 4, bodyCentreY, frontZ + DOOR_THICKNESS / 2],
      ...placed(withRelations, [
        { kind: 'gap', to: 'body', side: '+z' },
        { kind: 'align', to: 'body', axis: 'x', at: sign < 0 ? 'min' : 'max', offset: 0 },
        { kind: 'centered', to: 'body', axes: ['y'] },
      ]),
    });
    parts.push({
      id: `handle-${name}`, geometry: 'block', scale: HANDLE_SIZE,
      translation: [sign * (HANDLE_INSET + HANDLE_SIZE[0] / 2), bodyCentreY, frontZ + DOOR_THICKNESS + HANDLE_SIZE[2] / 2],
      ...placed(withRelations, [
        { kind: 'gap', to: `door-${name}`, side: '+z' },
        { kind: 'align', to: `door-${name}`, axis: 'x', at: sign < 0 ? 'max' : 'min', offset: sign < 0 ? -HANDLE_INSET : HANDLE_INSET },
        { kind: 'centered', to: `door-${name}`, axes: ['y'] },
      ]),
    });
  }
  parts.push({
    id: 'cornice', geometry: 'block', scale: [width + 2 * CORNICE_OVERHANG, CORNICE_HEIGHT, BODY_DEPTH + 2 * CORNICE_OVERHANG],
    translation: [0, FOOT_HEIGHT + bodyHeight + CORNICE_HEIGHT / 2, 0],
    ...placed(withRelations, [{ kind: 'attach', to: 'body', side: '+y' }]),
  });
  return {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'block', type: 'box', bevel: 0 }],
    materials: [{ id: 'paint', color: [0.55, 0.5, 0.45] }],
    nodes: parts.map(part => ({ material: 'paint', ...part })),
  };
}

export const CABINET_START = cabinetRecipe(1, 1.8, true);
export const CABINET_START_PLAIN = cabinetRecipe(1, 1.8, false);
export const CABINET_FINAL = cabinetRecipe(1.3, 1.9, true);
export const CABINET_FINAL_PLAIN = cabinetRecipe(1.3, 1.9, false);

const touchPairs = [
  ...['left-back', 'left-front', 'right-back', 'right-front'].map(name => ({ node: `foot-${name}`, against: 'body', side: '-y' })),
  { node: 'door-left', against: 'body', side: '+z' },
  { node: 'door-right', against: 'body', side: '+z' },
  { node: 'handle-left', against: 'door-left', side: '+z' },
  { node: 'handle-right', against: 'door-right', side: '+z' },
  { node: 'cornice', against: 'body', side: '+y' },
];

/** Contact for every attached pair, plus where the parts must end up after the resize. */
export const CABINET_CHECKS = [
  { kind: 'lint' },
  { kind: 'size', expected: [1.34, 1.9, 0.56] },
  { kind: 'ground' },
  ...touchPairs.map(pair => ({ kind: 'touches', ...pair })),
  ...CABINET_FINAL.nodes
    .filter(node => node.id !== 'body')
    .map(node => ({ kind: 'centreAt', node: node.id, position: node.translation })),
];
