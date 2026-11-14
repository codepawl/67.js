// A gallery wall with a painting, a pillar in front of it and one spotlight. Three positions are offered for the light.
// The pillar stands near the wall, so from two of the positions its shadow falls on part of the painting, and from the
// third it does not. The prompt gives positions, not shadow geometry: the pick is told from a render (scene_look) or by
// tracing rays past the pillar. The check on the exported recipe traces those rays itself, so it grades the result of
// the pick and not the method.

export const GALLERY_LIGHT_POSITIONS = [[-1.8, 2.4, 1.5], [0, 2.4, 1.5], [1.8, 2.4, 1.5]];
const PAINTING_CENTRE = [0, 1.5, -1.98];
const SPOT_ANGLE = 0.45;

function aimedAt(position, target) {
  const offset = target.map((value, axis) => value - position[axis]);
  const length = Math.hypot(...offset);
  return offset.map(value => Number((value / length).toFixed(4)));
}

function galleryRecipe(lightPosition) {
  const parts = [
    { id: 'floor', geometry: 'block', scale: [6, 0.05, 6], translation: [0, -0.025, 0] },
    { id: 'wall', geometry: 'block', scale: [6, 3, 0.1], translation: [0, 1.5, -2.05] },
    { id: 'painting', geometry: 'block', scale: [1, 0.7, 0.04], translation: PAINTING_CENTRE },
    { id: 'pillar', geometry: 'block', scale: [0.4, 2.6, 0.4], translation: [-0.3, 1.3, -0.5] },
  ];
  return {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'block', type: 'box', bevel: 0 }],
    materials: [{ id: 'plaster', color: [0.8, 0.78, 0.72] }],
    nodes: parts.map(part => ({ material: 'plaster', ...part })),
    environment: {
      spotLights: [{
        position: lightPosition, direction: aimedAt(lightPosition, PAINTING_CENTRE),
        angle: SPOT_ANGLE, intensity: 40, castShadow: true,
      }],
    },
  };
}

/** The gallery as the task starts: the spotlight at the first position, where the pillar shadows the painting. */
export const GALLERY_START = galleryRecipe(GALLERY_LIGHT_POSITIONS[0]);

/** The right pick: the third position, from which no ray to the painting meets the pillar. */
export const GALLERY_SOLUTION = galleryRecipe(GALLERY_LIGHT_POSITIONS[2]);

export const GALLERY_PROMPT = `The gallery scene below has a floor, a back wall, a painting on the wall and a pillar standing between the painting and the
room. One spotlight with shadows on lights the painting; it is at [-1.8, 2.4, 1.5] and aimed at the painting's centre.
Two other places could hold it: [0, 2.4, 1.5] and [1.8, 2.4, 1.5]. Keep the spotlight at the one place from which the
painting is lit all over, with no part of it in the pillar's shadow. Leave it aimed at the painting's centre, with shadows
on and its cone wide enough to reach the whole painting. Leave the floor, wall, painting and pillar as they are, and keep
this one light.`;

export const GALLERY_CHECKS = [
  { kind: 'lint' },
  { kind: 'parts', min: 4, max: 4 },
  { kind: 'centreAt', node: 'pillar', position: [-0.3, 1.3, -0.5] },
  { kind: 'centreAt', node: 'painting', position: PAINTING_CENTRE },
  { kind: 'litPainting', painting: 'painting', blocker: 'pillar', positions: GALLERY_LIGHT_POSITIONS, maxAngle: 0.9 },
];
