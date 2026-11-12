// The recipe of the boat clip for the boat controller and wake (#982): a Kenney fishing boat steered by keyframed controls
// through a baked sea, with a wake behind it. Used by render-buoyancy-film.mjs with --scene boat.
export const BOAT_SIZE = { width: 1.78, length: 3.87, hullHeight: 0.7 };

// The top face of a box, cut into 17 x 17 cells and subdivided 3 times into 136 x 136 (0.44 m apart over 60 m), fine enough for the
// wake to show. The cuts come before the delete: after it the cut finds no edges to split.
const SEA_EDITS = [
  { op: 'subdivide_edges', edges: { all: true }, cuts: 16 },
  { op: 'delete', select: { not: { normal: [0, 1, 0], maxAngle: 10 } } },
  { op: 'subdivide', levels: 3 },
  { op: 'set_position', position: { mul: [{ attr: 'position' }, [60, 1, 60]] } },
];

// The kit's bow points to +z. The boat holds its heading for a second, then the helm goes to the right and it turns through the sea.
const CONTROLS = [
  { time: 0, throttle: 1, rudder: 0 },
  { time: 0.8, throttle: 1, rudder: 0 },
  { time: 1.4, throttle: 1, rudder: 0.8 },
];

export function buildBoatRecipe(boatAssetId, duration) {
  const boatLift = BOAT_SIZE.hullHeight / 2;
  return {
    format: '67js.scene', schemaVersion: 1,
    geometries: [
      { id: 'hull', type: 'box' },
      { id: 'sea', type: 'mesh', base: { type: 'box', bevel: 0 }, edits: SEA_EDITS, stack: [{ op: 'ocean', windSpeed: 3.5, choppiness: 0.2, size: 30, seed: 5, resolution: 5 }] },
    ],
    materials: [
      { id: 'water', color: [0.02, 0.12, 0.2], tag: 'water' },
      { id: 'ghost', color: [1, 1, 1], opacity: 0 },
    ],
    nodes: [
      { id: 'sea', geometry: 'sea', material: 'water' },
      { id: 'hull', geometry: 'hull', material: 'ghost', castShadow: false, translation: [3, 0.8, -7], scale: [BOAT_SIZE.width, BOAT_SIZE.hullHeight, BOAT_SIZE.length] },
      { id: 'boat', parent: 'hull', asset: { id: boatAssetId }, translation: [0, -boatLift / BOAT_SIZE.hullHeight, 0], scale: [1 / BOAT_SIZE.width, 1 / BOAT_SIZE.hullHeight, 1 / BOAT_SIZE.length] },
    ],
    camera: { eye: [3, 4.2, 9.5], target: [-2.2, 0.2, -1.5], fov: 54 },
    motion: { duration, tracks: [{ kind: 'geometry', id: 'sea', property: 'oceanTime', interpolation: 'LINEAR', keyframes: [{ time: 0, value: 0 }, { time: duration, value: duration }] }] },
    physics: {
      duration,
      ocean: { geometry: 'sea' },
      bodies: [{
        node: 'hull', density: 300,
        float: {
          drag: 1.5, angularDrag: 3, points: [[-0.6, 0, -1.4], [0.6, 0, -1.4], [-0.6, 0, 1.4], [0.6, 0, 1.4]],
          boat: { thrust: 3.5, rudder: 1, forward: '+z', controls: CONTROLS, wake: { width: 1.5, strength: 1, height: 0.16, lifetime: 6 } },
        },
      }],
    },
  };
}
