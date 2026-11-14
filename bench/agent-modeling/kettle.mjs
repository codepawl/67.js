// A kettle whose lid, handle and spout sit against its body. The relations version states that in the recipe, so the
// body can be resized with one edit; the plain version holds the same parts as absolute positions.

const LID_SIZE = [0.12, 0.02, 0.1];
const HANDLE_SIZE = [0.03, 0.1, 0.04];
const SPOUT_SIZE = [0.04, 0.03, 0.03];

function relationsIf(withRelations, relation) {
  return withRelations ? { relations: [relation] } : {};
}

export function kettleRecipe(bodySize, withRelations) {
  const [bodyWidth, bodyHeight] = bodySize;
  const bodyCentreY = bodyHeight / 2;
  const sideCentreX = bodyWidth / 2;
  const parts = [
    { id: 'body', geometry: 'block', translation: [0, bodyCentreY, 0], scale: bodySize },
    {
      id: 'lid', geometry: 'block', scale: LID_SIZE, translation: [0, bodyHeight + LID_SIZE[1] / 2, 0],
      ...relationsIf(withRelations, { kind: 'attach', to: 'body', side: '+y' }),
    },
    {
      id: 'handle', geometry: 'block', scale: HANDLE_SIZE, translation: [sideCentreX + HANDLE_SIZE[0] / 2, bodyCentreY, 0],
      ...relationsIf(withRelations, { kind: 'attach', to: 'body', side: '+x' }),
    },
    {
      id: 'spout', geometry: 'block', scale: SPOUT_SIZE, translation: [-sideCentreX - SPOUT_SIZE[0] / 2, bodyCentreY, 0],
      ...relationsIf(withRelations, { kind: 'attach', to: 'body', side: '-x' }),
    },
  ];
  return {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'block', type: 'box', bevel: 0 }],
    materials: [{ id: 'paint', color: [0.6, 0.55, 0.5] }],
    nodes: parts.map(part => ({ material: 'paint', ...part })),
  };
}

/** The kettle as the task starts: a 0.2 x 0.16 x 0.12 m body, with or without relations on its parts. */
export const KETTLE_START = kettleRecipe([0.2, 0.16, 0.12], true);
export const KETTLE_START_PLAIN = kettleRecipe([0.2, 0.16, 0.12], false);
export const KETTLE_RESIZED = kettleRecipe([0.3, 0.24, 0.12], true);
export const KETTLE_RESIZED_PLAIN = kettleRecipe([0.3, 0.24, 0.12], false);
