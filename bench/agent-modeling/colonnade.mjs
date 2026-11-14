// A gallery with six thin posts and a painting, and five places for the one spotlight. The posts stand at different
// depths and heights, so each place throws a different pattern of thin shadows over the painting. The prompt asks for the
// place that leaves the least of the painting in shadow. Shadow shares at the five places are 24, 24, 37, 10 and 27 per
// cent, so no place is clear and the best cannot be read off the layout: a render of each place (or a fork per place) tells
// it, and a trace by hand means testing 6 posts against 5 places over the whole painting. The check traces the rays itself,
// so it grades the pick and not the method.

export const COLONNADE_LIGHT_POSITIONS = [[-2.4, 2.6, 1.5], [-1.2, 2.6, 1.5], [0, 2.6, 1.5], [1.2, 2.6, 1.5], [2.4, 2.6, 1.5]];
export const COLONNADE_BEST_PLACE = 3;
const PAINTING_CENTRE = [0, 1.5, -1.98];
const SPOT_ANGLE = 0.5;

// Each post: id, x, depth z (the post is 0.08 m thick in z), bottom, top, width in x.
const POSTS = [
  ['post-1', 1.745, 0.611, 0, 2.632, 0.088],
  ['post-2', -1.345, -0.333, 0.737, 3.082, 0.058],
  ['post-3', -0.125, 0.845, 0, 2.736, 0.095],
  ['post-4', -1.048, -0.926, 1.293, 3.17, 0.07],
  ['post-5', -0.869, -0.014, 1.077, 2.877, 0.066],
  ['post-6', -0.168, -0.856, 1.351, 2.314, 0.084],
];

function aimedAt(position, target) {
  const offset = target.map((value, axis) => value - position[axis]);
  const length = Math.hypot(...offset);
  return offset.map(value => Number((value / length).toFixed(4)));
}

function colonnadeRecipe(lightPosition) {
  const parts = [
    { id: 'floor', geometry: 'block', scale: [6, 0.05, 6], translation: [0, -0.025, 0] },
    { id: 'wall', geometry: 'block', scale: [6, 3.4, 0.1], translation: [0, 1.7, -2.05] },
    { id: 'painting', geometry: 'block', scale: [2, 1.2, 0.04], translation: PAINTING_CENTRE },
    ...POSTS.map(([id, x, z, bottom, top, width]) => ({
      id, geometry: 'block', scale: [width, top - bottom, 0.08], translation: [x, (top + bottom) / 2, z],
    })),
  ];
  return {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'block', type: 'box', bevel: 0 }],
    materials: [{ id: 'plaster', color: [0.8, 0.78, 0.72] }],
    nodes: parts.map(part => ({ material: 'plaster', ...part })),
    environment: {
      spotLights: [{
        position: lightPosition, direction: aimedAt(lightPosition, PAINTING_CENTRE),
        angle: SPOT_ANGLE, intensity: 60, castShadow: true,
      }],
    },
  };
}

/** The scene as the task starts: the spotlight at the first place. */
export const COLONNADE_START = colonnadeRecipe(COLONNADE_LIGHT_POSITIONS[0]);

/** The right pick: the fourth place, which leaves the least of the painting in shadow. */
export const COLONNADE_SOLUTION = colonnadeRecipe(COLONNADE_LIGHT_POSITIONS[COLONNADE_BEST_PLACE]);

export const COLONNADE_PROMPT = `The gallery scene below has a floor, a back wall, a 2 m by 1.2 m painting on the wall and six thin posts standing at
different depths and heights in the room. One spotlight with shadows on lights the painting; it is at [-2.4, 2.6, 1.5] and
aimed at the painting's centre. Four other places could hold it: [-1.2, 2.6, 1.5], [0, 2.6, 1.5], [1.2, 2.6, 1.5] and
[2.4, 2.6, 1.5]. Every place puts some post shadow on the painting. Keep the spotlight at the one place that leaves the
least of the painting in shadow. Leave it aimed at the painting's centre, with shadows on and its cone wide enough to
reach the whole painting. Leave the floor, wall, painting and posts as they are, and keep this one light.`;

export const COLONNADE_CHECKS = [
  { kind: 'lint' },
  { kind: 'parts', min: 9, max: 9 },
  { kind: 'centreAt', node: 'painting', position: PAINTING_CENTRE },
  ...POSTS.map(([id, x, z, bottom, top]) => ({ kind: 'centreAt', node: id, position: [x, (top + bottom) / 2, z] })),
  {
    kind: 'litPainting', painting: 'painting', blockers: POSTS.map(([id]) => id), least: true,
    positions: COLONNADE_LIGHT_POSITIONS, maxAngle: 0.9,
  },
];
