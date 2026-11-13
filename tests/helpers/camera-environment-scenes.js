import { createEnvironmentMap } from '../../src/environment.js';

// Scenes for the camera-environment tests and the review picture: a closed room lit only through a window, and a ball in the open.
export const ROOM_CAMERA = { eye: [0, 0, 1.8], target: [0, 0, -4], up: [0, 1, 0], fov: 60 };
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

export function skyMap(intensity) {
  const width = 16;
  const height = 8;
  const data = new Float32Array(width * height * 3);
  for (let row = 0; row < height; row++) {
    const brightness = 0.6 + 1.4 * (1 - row / (height - 1));
    for (let column = 0; column < width; column++) {
      const base = (row * width + column) * 3;
      data[base] = brightness;
      data[base + 1] = brightness * 1.05;
      data[base + 2] = brightness * 1.2;
    }
  }
  return createEnvironmentMap({ width, height, data, intensity });
}

export function uniformSkyMap(intensity) {
  const width = 8;
  const height = 4;
  const data = new Float32Array(width * height * 3);
  for (let texel = 0; texel < width * height; texel++) {
    data.set([0.5, 0.7, 0.9], texel * 3);
  }
  return createEnvironmentMap({ width, height, data, intensity });
}

// The quad faces the room centre, so a pane in the back wall faces the camera and the sky is on its back side.
function quadPart(name, corners, material) {
  const [first, second, , fourth] = corners;
  const across = second.map((value, axis) => value - first[axis]);
  const along = fourth.map((value, axis) => value - first[axis]);
  let normal = [
    across[1] * along[2] - across[2] * along[1],
    across[2] * along[0] - across[0] * along[2],
    across[0] * along[1] - across[1] * along[0],
  ];
  const length = Math.hypot(...normal);
  normal = normal.map(value => value / length);
  const towardCentre = [0, 0, -1].map((value, axis) => value - first[axis]);
  const facesCentre = normal[0] * towardCentre[0] + normal[1] * towardCentre[1] + normal[2] * towardCentre[2] > 0;
  const facing = facesCentre ? normal : normal.map(value => -value);
  return {
    name,
    geometry: {
      positions: Float32Array.from(corners.flat()),
      normals: Float32Array.from([...facing, ...facing, ...facing, ...facing]),
      indices: Uint32Array.from(facesCentre ? [0, 1, 2, 0, 2, 3] : [0, 2, 1, 0, 3, 2]),
    },
    matrix: IDENTITY,
    material,
  };
}

const WALL = { color: [0.7, 0.65, 0.6], roughness: 1, metallic: 0, specular: 0 };
export const WINDOW = { left: -1, right: 1, bottom: -0.5, top: 1 };
export const BACK = -4;

// A closed room, 4 by 3 by 6 metres, with a window in the back wall that holds a pane of glass. Only the sky through the pane lights it.
export function roomParts(glassIor) {
  const { left, right, bottom, top } = WINDOW;
  const glass = { color: [1, 1, 1], roughness: 0, metallic: 0, transmission: 1, ior: glassIor };
  return [
    quadPart('floor', [[-2, -1.5, 2], [2, -1.5, 2], [2, -1.5, BACK], [-2, -1.5, BACK]], WALL),
    quadPart('ceiling', [[-2, 1.5, 2], [2, 1.5, 2], [2, 1.5, BACK], [-2, 1.5, BACK]], WALL),
    quadPart('left', [[-2, -1.5, 2], [-2, -1.5, BACK], [-2, 1.5, BACK], [-2, 1.5, 2]], WALL),
    quadPart('right', [[2, -1.5, 2], [2, -1.5, BACK], [2, 1.5, BACK], [2, 1.5, 2]], WALL),
    quadPart('front', [[-2, -1.5, 2], [2, -1.5, 2], [2, 1.5, 2], [-2, 1.5, 2]], WALL),
    quadPart('below-window', [[-2, -1.5, BACK], [2, -1.5, BACK], [2, bottom, BACK], [-2, bottom, BACK]], WALL),
    quadPart('above-window', [[-2, top, BACK], [2, top, BACK], [2, 1.5, BACK], [-2, 1.5, BACK]], WALL),
    quadPart('beside-window-left', [[-2, bottom, BACK], [left, bottom, BACK], [left, top, BACK], [-2, top, BACK]], WALL),
    quadPart('beside-window-right', [[right, bottom, BACK], [2, bottom, BACK], [2, top, BACK], [right, top, BACK]], WALL),
    quadPart('pane', [[left, bottom, BACK], [right, bottom, BACK], [right, top, BACK], [left, top, BACK]], glass),
  ];
}

export function sphereParts() {
  const rings = 24;
  const segments = 32;
  const positions = [];
  const indices = [];
  for (let ring = 0; ring <= rings; ring++) {
    const polar = (Math.PI * ring) / rings;
    for (let segment = 0; segment <= segments; segment++) {
      const azimuth = (2 * Math.PI * segment) / segments;
      positions.push(Math.sin(polar) * Math.cos(azimuth), Math.cos(polar), Math.sin(polar) * Math.sin(azimuth));
    }
  }
  for (let ring = 0; ring < rings; ring++) {
    for (let segment = 0; segment < segments; segment++) {
      const first = ring * (segments + 1) + segment;
      const second = first + segments + 1;
      indices.push(first, second, first + 1, first + 1, second, second + 1);
    }
  }
  const geometry = { positions: Float32Array.from(positions), normals: Float32Array.from(positions), indices: Uint32Array.from(indices) };
  return [{ name: 'ball', geometry, matrix: IDENTITY, material: { color: [0.8, 0.3, 0.2], roughness: 1, metallic: 0, specular: 0 } }];
}

