// The terrain-hole-walk task: rolling ground with a round opening cut through it, and a walker that has to go around
// the opening. Without a ground with holes the agent has to cut a hole into hand-made hills, which the mesh tools can
// do only by deleting faces; the exported recipe shows which way it went (recipeFeatures.geometryTypes).

const GROUND_SIZE = 40;
const OPENING_CENTER = [0, 0];
const OPENING_RADIUS = 3;
const WALK_FROM = [-15, -15];
const WALK_TO = [15, 15];
const WALK_SECONDS = 10;

export const TERRAIN_TASKS = [
  {
    id: 'terrain-hole-walk',
    prompt: `You are working with the Crucible MCP tools. Units are metres and Y is up. Build a stretch of rolling ground ${GROUND_SIZE} m by ${GROUND_SIZE} m, centred on X = 0 and Z = 0, as a node named ground:
gentle hills whose highest and lowest points differ by about 1.2 m. A round opening of radius ${OPENING_RADIUS} m is cut clean through
the ground, centred on X = 0, Z = 0, like a cave mouth, with no surface left inside it. Add a node named walker (a small body that is itself drawn, say a box 0.4 m by 1 m by 0.4 m) that walks across the ground from [X = ${WALK_FROM[0]}, Z = ${WALK_FROM[1]}] to [X = ${WALK_TO[0]}, Z = ${WALK_TO[1]}] over a ${WALK_SECONDS} second motion that
starts at time 0. Keep the walker's node position within 1.5 m of the ground surface height and at least 0.3 m outside the opening's edge for the whole walk, so it goes around the opening instead of falling in. When it is finished, call scene_export_recipe once: the exported recipe is what gets graded.`,
    ownPreamble: true,
    checks: [
      { kind: 'groundRelief', node: 'ground', min: 0.6, max: 2.2 },
      { kind: 'through', axis: 'y', open: [[0.13, 0.07], [2.5, 0.11], [0.09, -2.5], [-1.8, 1.8]], solid: [[3.6, 0.13], [0.13, 3.6], [-3.6, 0.13], [10.13, -10.07], [-12.07, 12.11], [15.07, 5.11]] },
      { kind: 'walkPath', node: 'walker', ground: 'ground', from: WALK_FROM, to: WALK_TO, duration: WALK_SECONDS, avoid: { center: OPENING_CENTER, radius: OPENING_RADIUS }, margin: 0.3, heightTolerance: 1.5 },
    ],
  },
  {
    id: 'terrain-path-walk',
    prompt: `You are working with the Crucible MCP tools. Units are metres and Y is up. Build a stretch of rolling ground ${GROUND_SIZE} m by ${GROUND_SIZE} m, centred on X = 0 and Z = 0, as a node named ground:
gentle hills whose highest and lowest points differ by about 1.2 m. Two round openings are cut clean through the ground, with no surface inside them: one of radius ${OPENING_RADIUS} m
centred on X = 0, Z = 0, and one of radius 2.5 m centred on X = 9, Z = 9. Add a node named rock, a box 3 m by 2 m by 3 m centred on X = -8, Z = -8 and standing on the ground.
Add a node named walker (a small body that is itself drawn, say a box 0.4 m by 1 m by 0.4 m) that walks across the ground from [X = ${WALK_FROM[0]}, Z = ${WALK_FROM[1]}] to
[X = ${WALK_TO[0]}, Z = ${WALK_TO[1]}] over a ${WALK_SECONDS} second motion that starts at time 0. Keep the walker's node position within 1.5 m of the ground surface height, at least 0.3 m outside
both openings' edges and at least 0.3 m from the rock's footprint for the whole walk, so it goes around them. When it is finished, call scene_export_recipe once: the exported recipe is what gets graded.`,
    ownPreamble: true,
    checks: [
      { kind: 'groundRelief', node: 'ground', min: 0.6, max: 2.2 },
      { kind: 'through', axis: 'y', open: [[0.13, 0.07], [2.5, 0.11], [9.1, 9.05], [10.9, 9.1], [9.05, 7.2]], solid: [[3.6, 0.13], [0.13, 3.6], [-3.6, 0.13], [12.2, 9.1], [9.1, 12.2], [-12.07, 12.11], [15.07, 5.11]] },
      {
        kind: 'walkPath', node: 'walker', ground: 'ground', from: WALK_FROM, to: WALK_TO, duration: WALK_SECONDS,
        avoid: [{ center: OPENING_CENTER, radius: OPENING_RADIUS }, { center: [9, 9], radius: 2.5 }], avoidNodes: ['rock'], margin: 0.3, heightTolerance: 1.5,
      },
    ],
  },
];
