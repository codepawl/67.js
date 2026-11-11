import test from 'node:test';
import assert from 'node:assert/strict';
import { Document } from '@gltf-transform/core';
import {
  APEX,
  APEX_NODE_NAME,
  DEFAULT_REST_PATH,
  HOUSE,
  HOUSE_NODE_NAME,
  buildApexCabinet,
  buildMachineryHouse,
  createIo,
  findCraneCentres,
  findCollapsedHouseTriangles,
  fixCraneRear,
} from '../scripts/fix-port-crane-rear.mjs';

const CRANE_CENTRE = 10;

function boundsOf(buckets) {
  const minimum = [Infinity, Infinity, Infinity];
  const maximum = [-Infinity, -Infinity, -Infinity];
  for (const bucket of Object.values(buckets)) {
    for (let index = 0; index < bucket.positions.length; index += 3) {
      for (let axis = 0; axis < 3; axis++) {
        minimum[axis] = Math.min(minimum[axis], bucket.positions[index + axis]);
        maximum[axis] = Math.max(maximum[axis], bucket.positions[index + axis]);
      }
    }
  }
  return { minimum, maximum };
}

// A world with one crane whose house collapsed into a tetrahedron (as in the export), plus the paint mesh with an A-frame beam.
function createCollapsedWorld() {
  const document = new Document();
  const buffer = document.createBuffer();
  const scene = document.createScene();
  const materials = {};
  for (const name of ['sts_house', 'sts_paint', 'rail_steel.001', 'safety_yellow.001']) materials[name] = document.createMaterial(name);

  const tetrahedron = [
    [CRANE_CENTRE - 5.7, 54.3, -35.7], [CRANE_CENTRE + 5.7, 62.2, -52.5], [CRANE_CENTRE - 5.6, 54.6, -52.6], [CRANE_CENTRE + 5.6, 62.0, -35.6],
    [CRANE_CENTRE + 60, 20, 10], [CRANE_CENTRE + 61, 20, 10], [CRANE_CENTRE + 60, 21, 10],
  ];
  const houseIndices = [0, 1, 2, 3, 0, 1, 1, 3, 2, 3, 2, 0, 4, 5, 6];
  const houseMesh = document.createMesh('house').addPrimitive(createPrimitive(document, buffer, tetrahedron, houseIndices, materials.sts_house));
  scene.addChild(document.createNode('sts_house').setMesh(houseMesh));

  const beamVertices = [];
  for (let step = 0; step < 4; step++) beamVertices.push([CRANE_CENTRE - 3 + step * 2, 79.5, -6], [CRANE_CENTRE - 3 + step * 2, 80.5, -5]);
  const paintMesh = document.createMesh('paint').addPrimitive(createPrimitive(document, buffer, beamVertices, [0, 1, 2], materials.sts_paint));
  scene.addChild(document.createNode('sts_paint').setMesh(paintMesh));
  return document;
}

function createPrimitive(document, buffer, vertices, indices, material) {
  const position = document.createAccessor().setType('VEC3').setArray(new Float32Array(vertices.flat())).setBuffer(buffer);
  const index = document.createAccessor().setType('SCALAR').setArray(new Uint16Array(indices)).setBuffer(buffer);
  return document.createPrimitive().setAttribute('POSITION', position).setIndices(index).setMaterial(material);
}

test('the machinery house is a closed box inside the girder footprint, with every material the world already has', () => {
  const buckets = buildMachineryHouse();
  const { minimum, maximum } = boundsOf(buckets);
  assert.ok(minimum[1] >= HOUSE.floorY - 1e-6, 'nothing below the girder deck');
  assert.ok(maximum[1] - HOUSE.roofY < 1.3, 'only a hand rail rises above the roof');
  assert.ok(minimum[2] > HOUSE.rearZ - 0.5 && maximum[2] < HOUSE.frontZ + 0.5);
  assert.ok(maximum[0] <= HOUSE.halfWidth + 0.3 && minimum[0] >= -HOUSE.halfWidth - 0.3);
  assert.deepEqual(Object.keys(buckets).sort(), ['rail_steel.001', 'safety_yellow.001', 'sts_house', 'sts_paint']);
  assert.ok(buckets.sts_house.triangleCount >= 20, 'walls and roof of a box are at least ten quads');
  const totalTriangles = Object.values(buckets).reduce((sum, bucket) => sum + bucket.triangleCount, 0);
  assert.ok(totalTriangles < 1200, `the house stays light, got ${totalTriangles} triangles`);
});

test('house faces point outward and normals are unit length', () => {
  for (const bucket of Object.values(buildMachineryHouse())) {
    for (let triangle = 0; triangle < bucket.triangleCount; triangle++) {
      const [first, second, third] = [0, 1, 2].map((corner) => bucket.indices[triangle * 3 + corner]);
      const point = (vertex) => [0, 1, 2].map((axis) => bucket.positions[vertex * 3 + axis]);
      const [a, b, c] = [first, second, third].map(point);
      const edgeOne = b.map((value, axis) => value - a[axis]);
      const edgeTwo = c.map((value, axis) => value - a[axis]);
      const faceNormal = [edgeOne[1] * edgeTwo[2] - edgeOne[2] * edgeTwo[1], edgeOne[2] * edgeTwo[0] - edgeOne[0] * edgeTwo[2], edgeOne[0] * edgeTwo[1] - edgeOne[1] * edgeTwo[0]];
      const stored = [0, 1, 2].map((axis) => bucket.normals[first * 3 + axis]);
      assert.ok(Math.abs(Math.hypot(...stored) - 1) < 1e-6);
      const alignment = faceNormal[0] * stored[0] + faceNormal[1] * stored[1] + faceNormal[2] * stored[2];
      assert.ok(alignment > 0, 'the winding agrees with the stored normal');
    }
  }
});

test('the apex cabinet sits on the A-frame beam', () => {
  const { minimum, maximum } = boundsOf(buildApexCabinet());
  assert.ok(Math.abs(minimum[1] - APEX.beamY) < 1e-6);
  assert.ok(maximum[1] - APEX.beamY < 2.5);
  assert.ok(maximum[0] - minimum[0] < 8.5, 'narrower than the cross beam');
});

test('fixCraneRear replaces a collapsed house with the machinery house and leaves other triangles alone', () => {
  const document = createCollapsedWorld();
  const houseNode = document.getRoot().listNodes().find((node) => node.getName() === 'sts_house');
  assert.deepEqual(findCraneCentres(houseNode).map((centre) => Math.round(centre)), [CRANE_CENTRE]);
  assert.equal(findCollapsedHouseTriangles(houseNode, [CRANE_CENTRE]).length, 4);

  const result = fixCraneRear(document);
  assert.equal(result.changed, true);
  assert.equal(result.removedTriangles, 4);
  assert.equal(houseNode.getMesh().listPrimitives()[0].getIndices().getCount(), 3, 'the unrelated triangle survives');
  const houses = document.getRoot().listNodes().filter((node) => node.getName() === HOUSE_NODE_NAME);
  const cabinets = document.getRoot().listNodes().filter((node) => node.getName() === APEX_NODE_NAME);
  assert.equal(houses.length, 1);
  assert.equal(cabinets.length, 1);
  assert.deepEqual(houses[0].getTranslation().map(Math.round), [CRANE_CENTRE, 0, 0]);

  assert.equal(fixCraneRear(document).changed, false, 'a second run changes nothing');
});

test('the committed port world has six machinery houses and no collapsed house', async () => {
  const io = await createIo();
  const document = await io.read(DEFAULT_REST_PATH);
  assert.equal(fixCraneRear(document).changed, false);
  const houses = document.getRoot().listNodes().filter((node) => node.getName() === HOUSE_NODE_NAME);
  assert.equal(houses.length, 6);
  const houseNode = document.getRoot().listNodes().find((node) => node.getName() === 'sts_house');
  const craneCentres = houses.map((node) => node.getTranslation()[0]);
  assert.equal(findCollapsedHouseTriangles(houseNode, craneCentres).length, 0, 'no sts_house triangle is left inside a house volume');
});
