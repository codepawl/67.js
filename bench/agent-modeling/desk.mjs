// A desk of 12 parts stacked on each other: top, four legs, two drawers with a handle each, a lamp on a base and a
// book. The relations version states where each part sits; the plain version holds the same absolute positions.

const DESK_HEIGHT = 0.75;
const LEG_SIZE = 0.05;
const LEG_INSET = 0.05;
const DRAWER_INSET = 0.1;
const DRAWER_SIZE = [0.5, 0.12, 0.5];
const HANDLE_SIZE = [0.1, 0.02, 0.02];
const LAMP_BASE_SIZE = [0.15, 0.03, 0.15];
const LAMP_SIZE = [0.03, 0.4, 0.03];
const BOOK_SIZE = [0.25, 0.04, 0.18];

function placed(withRelations, relations) {
  return withRelations ? { relations } : {};
}

function legParts(topSize, withRelations) {
  const [topWidth, topThickness, topDepth] = topSize;
  const underside = DESK_HEIGHT - topThickness;
  const parts = [];
  for (const [xName, xSign] of [['left', -1], ['right', 1]]) {
    for (const [zName, zSign] of [['back', -1], ['front', 1]]) {
      parts.push({
        id: `leg-${xName}-${zName}`, geometry: 'block', scale: [LEG_SIZE, underside, LEG_SIZE],
        translation: [xSign * (topWidth / 2 - LEG_INSET - LEG_SIZE / 2), underside / 2, zSign * (topDepth / 2 - LEG_INSET - LEG_SIZE / 2)],
        ...placed(withRelations, [
          { kind: 'gap', to: 'top', side: '-y' },
          { kind: 'align', to: 'top', axis: 'x', at: xSign < 0 ? 'min' : 'max', offset: -xSign * LEG_INSET },
          { kind: 'align', to: 'top', axis: 'z', at: zSign < 0 ? 'min' : 'max', offset: -zSign * LEG_INSET },
        ]),
      });
    }
  }
  return parts;
}

function drawerParts(topSize, drawerDepth, withRelations) {
  const [topWidth, topThickness] = topSize;
  const drawerY = DESK_HEIGHT - topThickness - DRAWER_SIZE[1] / 2;
  const parts = [];
  for (const [name, sign] of [['left', -1], ['right', 1]]) {
    const drawerX = sign * (topWidth / 2 - DRAWER_INSET - DRAWER_SIZE[0] / 2);
    parts.push({
      id: `drawer-${name}`, geometry: 'block', scale: [DRAWER_SIZE[0], DRAWER_SIZE[1], drawerDepth], translation: [drawerX, drawerY, 0],
      ...placed(withRelations, [
        { kind: 'gap', to: 'top', side: '-y' },
        { kind: 'align', to: 'top', axis: 'x', at: sign < 0 ? 'min' : 'max', offset: -sign * DRAWER_INSET },
        { kind: 'centered', to: 'top', axes: ['z'] },
      ]),
    });
    parts.push({
      id: `handle-${name}`, geometry: 'block', scale: HANDLE_SIZE, translation: [drawerX, drawerY, drawerDepth / 2 + HANDLE_SIZE[2] / 2],
      ...placed(withRelations, [{ kind: 'attach', to: `drawer-${name}`, side: '+z' }]),
    });
  }
  return parts;
}

function topParts(topSize, withRelations) {
  const [topWidth] = topSize;
  const lampBaseX = topWidth / 2 - DRAWER_INSET - LAMP_BASE_SIZE[0] / 2;
  const lampBaseY = DESK_HEIGHT + LAMP_BASE_SIZE[1] / 2;
  return [
    {
      id: 'lamp-base', geometry: 'block', scale: LAMP_BASE_SIZE, translation: [lampBaseX, lampBaseY, 0],
      ...placed(withRelations, [
        { kind: 'gap', to: 'top', side: '+y' },
        { kind: 'align', to: 'top', axis: 'x', at: 'max', offset: -DRAWER_INSET },
        { kind: 'centered', to: 'top', axes: ['z'] },
      ]),
    },
    {
      id: 'lamp', geometry: 'block', scale: LAMP_SIZE, translation: [lampBaseX, lampBaseY + LAMP_BASE_SIZE[1] / 2 + LAMP_SIZE[1] / 2, 0],
      ...placed(withRelations, [{ kind: 'attach', to: 'lamp-base', side: '+y' }]),
    },
    {
      id: 'book', geometry: 'block', scale: BOOK_SIZE, translation: [-topWidth / 2 + DRAWER_INSET + BOOK_SIZE[0] / 2, DESK_HEIGHT + BOOK_SIZE[1] / 2, 0],
      ...placed(withRelations, [
        { kind: 'gap', to: 'top', side: '+y' },
        { kind: 'align', to: 'top', axis: 'x', at: 'min', offset: DRAWER_INSET },
        { kind: 'centered', to: 'top', axes: ['z'] },
      ]),
    },
  ];
}

/** The desk for a top of [width, thickness, depth] metres and drawers of the given depth. */
export function deskRecipe(topSize, drawerDepth, withRelations) {
  const parts = [
    { id: 'top', geometry: 'block', scale: topSize, translation: [0, DESK_HEIGHT - topSize[1] / 2, 0] },
    ...legParts(topSize, withRelations),
    ...drawerParts(topSize, drawerDepth, withRelations),
    ...topParts(topSize, withRelations),
  ];
  return {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'block', type: 'box', bevel: 0 }],
    materials: [{ id: 'paint', color: [0.6, 0.55, 0.5] }],
    nodes: parts.map(part => ({ material: 'paint', ...part })),
  };
}

export const DESK_START = deskRecipe([1.2, 0.04, 0.6], 0.5, true);
export const DESK_START_PLAIN = deskRecipe([1.2, 0.04, 0.6], 0.5, false);
export const DESK_FINAL = deskRecipe([1.6, 0.08, 0.8], 0.7, true);
export const DESK_FINAL_PLAIN = deskRecipe([1.6, 0.08, 0.8], 0.7, false);

const touchPairs = [
  ...['left-back', 'left-front', 'right-back', 'right-front'].map(name => ({ node: `leg-${name}`, against: 'top', side: '-y' })),
  { node: 'drawer-left', against: 'top', side: '-y' },
  { node: 'drawer-right', against: 'top', side: '-y' },
  { node: 'handle-left', against: 'drawer-left', side: '+z' },
  { node: 'handle-right', against: 'drawer-right', side: '+z' },
  { node: 'lamp-base', against: 'top', side: '+y' },
  { node: 'lamp', against: 'lamp-base', side: '+y' },
  { node: 'book', against: 'top', side: '+y' },
];

/** Contact for every attached pair, plus where the parts must end up after the last step. */
export const DESK_CHECKS = [
  { kind: 'lint' },
  { kind: 'size', expected: [1.6, 1.18, 0.8] },
  { kind: 'ground' },
  ...touchPairs.map(pair => ({ kind: 'touches', ...pair })),
  ...DESK_FINAL.nodes
    .filter(node => ['leg-left-back', 'leg-right-front', 'drawer-left', 'drawer-right', 'handle-right', 'lamp', 'book'].includes(node.id))
    .map(node => ({ kind: 'centreAt', node: node.id, position: node.translation })),
];
