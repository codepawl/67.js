// Trap scenes for the flicker probe (issue #751): small scenes built to z-fight, each with the camera that shows it.
// Open /bench/flicker/index.html?trap=<name>, or run probe.mjs with --traps. Every face has its own flat colour (vertex
// colours), so the probe also sees two faces of one mesh trade places.

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const DEGREES = Math.PI / 180;

function faceColour(index) {
  const hue = (index * 0.618034) % 1;
  return [0, 1 / 3, 2 / 3].map(offset => 0.5 + 0.45 * Math.cos(2 * Math.PI * (hue + offset)));
}

function cross(first, second) {
  return [first[1] * second[2] - first[2] * second[1], first[2] * second[0] - first[0] * second[2], first[0] * second[1] - first[1] * second[0]];
}

// A quad centred on `centre`, spanning `width` along `right` and `height` along `up` (unit vectors); it faces right x up.
function quad(centre, right, up, width, height, colour) {
  const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([alongRight, alongUp]) => centre.map((value, axis) => value + right[axis] * alongRight * width / 2 + up[axis] * alongUp * height / 2));
  return { corners, normal: cross(right, up), colour };
}

function wallQuad(centre, width, height, colour) {
  return quad(centre, [1, 0, 0], [0, 1, 0], width, height, colour);
}

function floorQuad(centre, width, depth, colour) {
  return quad(centre, [1, 0, 0], [0, 0, -1], width, depth, colour);
}

// The six faces of a box from `low` to `high`, each with the next colour.
function boxQuads(low, high, firstColour) {
  const centre = low.map((value, axis) => (value + high[axis]) / 2);
  const size = low.map((value, axis) => high[axis] - value);
  const faces = [
    [[0, 0, 1], [1, 0, 0], [0, 1, 0], size[0], size[1]], [[0, 0, -1], [-1, 0, 0], [0, 1, 0], size[0], size[1]],
    [[1, 0, 0], [0, 0, -1], [0, 1, 0], size[2], size[1]], [[-1, 0, 0], [0, 0, 1], [0, 1, 0], size[2], size[1]],
    [[0, 1, 0], [1, 0, 0], [0, 0, -1], size[0], size[2]], [[0, -1, 0], [1, 0, 0], [0, 0, 1], size[0], size[2]],
  ];
  return faces.map(([normal, right, up, width, height], index) => quad(centre.map((value, axis) => value + normal[axis] * size[axis] / 2), right, up, width, height, faceColour(firstColour + index)));
}

function part(name, quads, extra = {}) {
  const positions = [];
  const normals = [];
  const colors = [];
  const indices = [];
  quads.forEach((face, index) => {
    for (const corner of face.corners) {
      positions.push(...corner);
      normals.push(...face.normal);
      colors.push(...face.colour);
    }
    indices.push(index * 4, index * 4 + 1, index * 4 + 2, index * 4, index * 4 + 2, index * 4 + 3);
  });
  return {
    name,
    geometry: { positions: new Float32Array(positions), normals: new Float32Array(normals), colors: new Float32Array(colors), indices: new Uint32Array(indices) },
    matrix: new Float32Array(IDENTITY),
    material: { color: [1, 1, 1], metallic: 0, roughness: 1 },
    ...extra,
  };
}

function movedCopy(source, name, translation) {
  const matrix = new Float32Array(IDENTITY);
  matrix.set(translation, 12);
  return { ...source, name, matrix };
}

function plaqueOnWall(distance) {
  return {
    parts: [part('wall', [wallQuad([0, 2, 0], 10, 4, faceColour(0))]), part('plaque', [wallQuad([0, 2, 0], 2, 1, faceColour(1))])],
    eye: [distance * 0.3, 2 + distance * 0.1, distance],
    target: [0, 2, 0],
  };
}

function stackedSlabs() {
  return {
    parts: [
      part('slabWest', boxQuads([-6, 0, -4], [2, 0.2, 4], 0)),
      part('slabEast', boxQuads([-2, 0, -4], [6, 0.2, 4], 6)),
      part('slabUpper', boxQuads([-3, 0.2, -4], [3, 0.4, 4], 12)),
      part('slabUpperTwin', boxQuads([-1, 0.2, -4], [5, 0.4, 2], 18)),
    ],
    eye: [9, 7, 13],
    target: [0, 0.2, 0],
  };
}

// One mesh, as a kitbashed asset arrives: a wall, an exact duplicate, a staggered copy and trims that sit on the same plane.
function kitbashedDuplicates() {
  return {
    parts: [part('kitbash', [
      wallQuad([0, 2, 0], 8, 4, faceColour(0)), wallQuad([0, 2, 0], 8, 4, faceColour(1)), wallQuad([1.5, 2.5, 0], 8, 4, faceColour(2)),
      wallQuad([-2, 2, 0], 1.5, 2.5, faceColour(3)), wallQuad([2, 1.5, 0], 3, 0.4, faceColour(4)), wallQuad([2, 1.5, 0], 1, 1.2, faceColour(5)),
    ])],
    eye: [4, 3, 12],
    target: [0.5, 2, 0],
  };
}

function grazingDecal() {
  const distance = 30;
  return {
    parts: [part('ground', [floorQuad([0, 0, 0], 60, 60, faceColour(0))]), part('marking', [floorQuad([0, 0, 0], 6, 6, faceColour(1))], { decal: true })],
    eye: [0, distance * Math.tan(2 * DEGREES), distance],
    target: [0, 0, 0],
  };
}

// Two walls 1.6 cm apart, seen from 1 km at 5 degrees to their plane. The front wall is a little smaller, so both show.
function gappedWalls() {
  const distance = 1000;
  return {
    parts: [part('backWall', [wallQuad([0, 30, 0], 240, 60, faceColour(0))]), part('frontWall', [wallQuad([0, 30, 0.016], 200, 40, faceColour(1))])],
    eye: [-distance * Math.cos(5 * DEGREES), 30, distance * Math.sin(5 * DEGREES)],
    target: [0, 30, 0],
  };
}

// A panel 1.5 cm in front of a wall, seen from 176 m: past the 1 cm a cut may open, so the panel is ranked, not cut. The case of
// the glass reported in #751 (there as an unconfirmed `rank-overflow`), with an opaque panel so the probe can read its colour.
function panelOnWallFar() {
  const distance = 176;
  return {
    parts: [part('wall', [wallQuad([0, 30, 0], 120, 60, faceColour(0))]), part('panel', [wallQuad([0, 30, 0.015], 50, 30, faceColour(1))])],
    eye: [distance * 0.3, 30 + distance * 0.1, distance],
    target: [0, 30, 0],
  };
}

// 30 quads on exactly one plane in one mesh, each a little smaller than the one before, so every one shows as a ring.
function exactStack() {
  return {
    parts: [part('stack', Array.from({ length: 30 }, (unused, index) => wallQuad([0, 2, 0], 6 - index * 0.18, 4 - index * 0.12, faceColour(index))))],
    eye: [3, 3, 9],
    target: [0, 2, 0],
  };
}

// Three instances of one box geometry; only the first has its front face in the plane of the wall.
function instancedFlush() {
  const crate = part('crateFlush', boxQuads([-0.5, 0, -1], [0.5, 1, 0], 2));
  return {
    parts: [
      part('wall', [wallQuad([0, 2, 0], 10, 4, faceColour(0))]),
      crate, movedCopy(crate, 'crateFree', [3, 0, 2]), movedCopy(crate, 'crateFar', [-3, 0, 3]),
    ],
    eye: [2, 2.5, 10],
    target: [0, 1, 0],
  };
}

// A plaque flush on a wall, turned off the axes and far from round coordinates, seen from half a metre at the corner of the
// plaque: the wall is cut around the plaque there. A white backdrop stands behind the dark wall, so a seam a cut left open
// shows as a pixel that is neither face (`countOpen` asks the probe for that count).
function plaqueCloseUp() {
  const length = Math.hypot(0.83, 0.07, -0.55);
  const right = [0.83 / length, 0.07 / length, -0.55 / length];
  const sideways = cross(right, [0, 1, 0]);
  const normal = sideways.map(value => value / Math.hypot(...sideways));
  const up = cross(normal, right);
  const along = (origin, alongRight, alongUp, alongNormal = 0) => origin.map((value, axis) => value + right[axis] * alongRight + up[axis] * alongUp + normal[axis] * alongNormal);
  const centre = [137.37, 21.93, -64.11];
  const plaqueCentre = along(centre, 0.31, 0.17);
  const corner = along(plaqueCentre, 0.65, 0.35);
  return {
    parts: [
      part('backdrop', [quad(along(centre, 0, 0, -0.3), right, up, 30, 30, [1, 1, 1])]),
      part('wall', [quad(centre, right, up, 9.7, 3.9, [0.05, 0.2, 0.05])]),
      part('plaque', [quad(plaqueCentre, right, up, 1.3, 0.7, [0.05, 0.05, 0.25])]),
    ],
    eye: along(corner, 0.04, -0.03, 0.5),
    target: corner,
    countOpen: true,
  };
}

export const TRAPS = {
  'plaque-2m': () => plaqueOnWall(2),
  'plaque-20m': () => plaqueOnWall(20),
  'plaque-200m': () => plaqueOnWall(200),
  'stacked-slabs': stackedSlabs,
  'kitbash-duplicates': kitbashedDuplicates,
  'decal-grazing-2deg': grazingDecal,
  'walls-16mm-1km-5deg': gappedWalls,
  'panel-15mm-176m': panelOnWallFar,
  'stack-30-exact': exactStack,
  'instanced-flush': instancedFlush,
  'plaque-closeup-0.5m': plaqueCloseUp,
};
