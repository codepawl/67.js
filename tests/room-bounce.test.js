import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentScene } from '../src/agent-scene.js';
import { createEnvironmentMap } from '../src/environment.js';
import { findRoomSurface, groundBounceEnvironment, roomBounceRadiance } from '../src/ground-bounce.js';

const WALL = 0.2;
const ROOM_SIZE = 10;
const ROOM_HEIGHT = 6;

function slab(id, translation, scale, material) {
  return { id, geometry: 'box', material, translation, scale };
}

// A 10 x 6 x 10 room from six slabs; `roof: false` leaves the top open and `redLeft` paints the west wall red.
function roomParts({ roof = true, redLeft = false } = {}) {
  const slabs = [
    slab('floor', [0, -3, 0], [ROOM_SIZE, WALL, ROOM_SIZE], 'grey'),
    slab('north', [0, 0, -5], [ROOM_SIZE, ROOM_HEIGHT, WALL], 'grey'),
    slab('south', [0, 0, 5], [ROOM_SIZE, ROOM_HEIGHT, WALL], 'grey'),
    slab('west', [-5, 0, 0], [WALL, ROOM_HEIGHT, ROOM_SIZE], redLeft ? 'red' : 'grey'),
    slab('east', [5, 0, 0], [WALL, ROOM_HEIGHT, ROOM_SIZE], 'grey'),
  ];
  if (roof) {
    slabs.push(slab('roof', [0, 3, 0], [ROOM_SIZE, WALL, ROOM_SIZE], 'grey'));
  }
  const recipe = {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'box', type: 'box', bevel: 0 }],
    materials: [{ id: 'grey', color: [0.5, 0.5, 0.5] }, { id: 'red', color: [0.8, 0.1, 0.1] }],
    nodes: slabs,
  };
  return createAgentScene(recipe).parts;
}

function dimWorld() {
  return createEnvironmentMap({ width: 8, height: 4, data: new Float32Array(8 * 4 * 3).fill(0.02) });
}

function lampEnvironment(overrides = {}) {
  return {
    map: dimWorld(),
    keyColor: [0, 0, 0],
    pointLights: [{ position: [0, 1, 0], color: [1, 1, 1], intensity: 10 }],
    ...overrides,
  };
}

test('a closed room lit by a lamp gets flux * rho / (pi * area * (1 - rho)) as its bounce, scaled by the fitted gain', () => {
  const parts = roomParts();
  const room = findRoomSurface(parts);
  assert.ok(room, 'the six slabs form a room');
  const innerArea = 2 * ROOM_SIZE * ROOM_SIZE + 4 * ROOM_SIZE * ROOM_HEIGHT;
  assert.ok(Math.abs(room.area - innerArea) / innerArea < 0.05, `inner area ${room.area} against ${innerArea}`);
  const bounced = groundBounceEnvironment(parts, lampEnvironment());
  const albedo = 0.5;
  const unscaled = (4 * 10) * albedo / (room.area * (1 - albedo));
  const ratio = bounced.map.bounce[0] / unscaled;
  assert.ok(ratio > 0.5 && ratio < 1, `the fitted gain is below one: ${ratio}`);
  assert.deepEqual(roomBounceRadiance(room, lampEnvironment()), Array.from(bounced.map.bounce));
});

test('the bounce takes the colour of the walls', () => {
  const bounced = groundBounceEnvironment(roomParts({ redLeft: true }), lampEnvironment());
  const [red, green, blue] = bounced.map.bounce;
  assert.ok(red > green && green === blue || red > blue, `red ${red}, green ${green}, blue ${blue}`);
  const plain = groundBounceEnvironment(roomParts(), lampEnvironment()).map.bounce;
  assert.ok(Math.abs(plain[0] - plain[2]) < 1e-9, 'grey walls and a white lamp give a grey bounce');
});

test('the map keeps its data, so a lamp that changes every frame never rebuilds the environment textures', () => {
  const parts = roomParts();
  const environment = lampEnvironment();
  const bounced = groundBounceEnvironment(parts, environment);
  assert.equal(bounced.map.data, environment.map.data);
  const brighter = groundBounceEnvironment(parts, lampEnvironment({ map: environment.map, pointLights: [{ position: [0, 1, 0], intensity: 20 }] }));
  assert.ok(Math.abs(brighter.map.bounce[0] / bounced.map.bounce[0] - 2) < 1e-9);
});

test('no bounce is added with a sun, with roomBounce off, in an open room or from a lamp outside the room', () => {
  const parts = roomParts();
  const withSun = lampEnvironment({ keyColor: [3, 3, 3] });
  assert.equal(groundBounceEnvironment(parts, withSun), withSun);
  const switchedOff = lampEnvironment({ roomBounce: false });
  assert.equal(groundBounceEnvironment(parts, switchedOff), switchedOff);
  const openRoom = lampEnvironment();
  assert.equal(groundBounceEnvironment(roomParts({ roof: false }), openRoom), openRoom);
  const outside = lampEnvironment({ pointLights: [{ position: [0, 20, 0], intensity: 10 }] });
  assert.equal(groundBounceEnvironment(parts, outside), outside);
});

test('a scene without a map or without lamps is left alone', () => {
  const parts = roomParts();
  const noMap = { keyColor: [0, 0, 0], pointLights: [{ position: [0, 1, 0], intensity: 10 }] };
  assert.equal(groundBounceEnvironment(parts, noMap), noMap);
});

test('scene_inspect names the bake for a closed room lit by lamps only', () => {
  const recipe = {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'box', type: 'box', bevel: 0 }],
    materials: [{ id: 'grey', color: [0.5, 0.5, 0.5] }],
    nodes: [
      slab('floor', [0, -3, 0], [ROOM_SIZE, WALL, ROOM_SIZE], 'grey'),
      slab('north', [0, 0, -5], [ROOM_SIZE, ROOM_HEIGHT, WALL], 'grey'),
      slab('south', [0, 0, 5], [ROOM_SIZE, ROOM_HEIGHT, WALL], 'grey'),
      slab('west', [-5, 0, 0], [WALL, ROOM_HEIGHT, ROOM_SIZE], 'grey'),
      slab('east', [5, 0, 0], [WALL, ROOM_HEIGHT, ROOM_SIZE], 'grey'),
      slab('roof', [0, 3, 0], [ROOM_SIZE, WALL, ROOM_SIZE], 'grey'),
    ],
    environment: { keyIntensity: 0, pointLights: [{ position: [0, 1, 0], intensity: 10 }] },
  };
  const found = createAgentScene(recipe).inspect().diagnostics.find(entry => entry.kind === 'closed-room-without-bake');
  assert.ok(found);
  assert.match(found.message, /lit only by its point, spot or area lights/);
  assert.match(found.fix, /"preset": "standard"/);
});
