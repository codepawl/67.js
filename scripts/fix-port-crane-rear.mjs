// Rebuilds the machinery house on the rear girder of every ship-to-shore crane of the hero port, and the equipment cabinet on top of
// each A-frame.
//
//   node scripts/fix-port-crane-rear.mjs [--rest public/showcase/port/scene.rest.glb] [--dry-run]
//
// Why: the world export decimated the crane meshes, and the house of each crane (a 12-triangle box, 11.7 x 7.6 x 16.6 m) came out
// as a 4-triangle tetrahedron with every texture coordinate at zero. It draws as a flat grey wedge that cuts through the orange
// girder, with the roof vents and louvres floating beside it. The wedge is already in the world as first exported (commit
// ab6cf7bd, before any hero script) and so in scene.rest.glb and scene.first.glb alike.
//
// What it does: finds those tetrahedra in the `sts_house` mesh of scene.rest.glb and removes them, then adds one machinery house
// mesh (cladding with panel ribs, orange frame bands, a door, an access ladder, a roof rail) to six nodes, one per crane, and an
// equipment cabinet on top of each A-frame. The new triangles use the materials already in the file, so the world gains no texture.
// Rebuild the first view afterwards with `node scripts/build-hero-first-view.mjs`.
// It also removes the loose yellow rail pieces of the old house (see removeLeftoverRails). Running it twice is safe: a world that already
// has the houses and no leftovers is left alone.
import { writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTMeshoptCompression } from '@gltf-transform/extensions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_REST_PATH = resolve(SCRIPT_DIRECTORY, '..', 'public', 'showcase', 'port', 'scene.rest.glb');
export const HOUSE_NODE_NAME = 'sts_machinery_house';
export const APEX_NODE_NAME = 'sts_apex_cabinet';

// The house of every crane sits on the same spot of the girder; only the crane's x differs. Metres, world axes (z grows toward the ship).
export const HOUSE = {
  halfWidth: 5.85,
  floorY: 54.7,
  roofY: 62.3,
  rearZ: -52.4,
  frontZ: -35.8,
  roofThickness: 0.3,
  roofOverhang: 0.2,
};
export const APEX = { beamY: 81.2, height: 2.0, halfWidth: 3.4, rearZ: -6.9, frontZ: -4.1 };
const TEXTURE_TILE_METRES = 6;
const DARK_STEEL_MATERIAL = 'rail_steel.001';
const RAIL_MATERIAL = 'safety_yellow.001';
const DEGENERATE_SEARCH = { minimumY: 54.0, maximumY: 62.6, minimumZ: -53, maximumZ: -35.3, halfWidth: 6.3 };

const FACES = [
  { name: 'right', axis: 0, sign: 1 },
  { name: 'left', axis: 0, sign: -1 },
  { name: 'top', axis: 1, sign: 1 },
  { name: 'bottom', axis: 1, sign: -1 },
  { name: 'front', axis: 2, sign: 1 },
  { name: 'rear', axis: 2, sign: -1 },
];

class GeometryBucket {
  constructor() {
    this.positions = [];
    this.normals = [];
    this.uvs = [];
    this.indices = [];
  }

  // An axis-aligned box. `skip` names the faces that stay closed off (not drawn); texture coordinates follow world position so the
  // cladding tiles at the same scale on every face.
  addBox(minimum, maximum, skip = ['bottom']) {
    for (const face of FACES) {
      if (skip.includes(face.name)) continue;
      this.addFace(minimum, maximum, face);
    }
  }

  addFace(minimum, maximum, face) {
    const fixedValue = face.sign > 0 ? maximum[face.axis] : minimum[face.axis];
    const [firstAxis, secondAxis] = [0, 1, 2].filter((axis) => axis !== face.axis);
    const corners = [
      [minimum[firstAxis], minimum[secondAxis]],
      [maximum[firstAxis], minimum[secondAxis]],
      [maximum[firstAxis], maximum[secondAxis]],
      [minimum[firstAxis], maximum[secondAxis]],
    ];
    const normal = [0, 0, 0];
    normal[face.axis] = face.sign;
    const firstVertex = this.positions.length / 3;
    for (const [first, second] of corners) {
      const position = [0, 0, 0];
      position[face.axis] = fixedValue;
      position[firstAxis] = first;
      position[secondAxis] = second;
      this.positions.push(...position);
      this.normals.push(...normal);
      const horizontal = face.axis === 0 ? position[2] : position[0];
      const vertical = face.axis === 1 ? position[2] : position[1];
      this.uvs.push(horizontal / TEXTURE_TILE_METRES, vertical / TEXTURE_TILE_METRES);
    }
    // The corner order above runs counter-clockwise seen from +x and +z but from -y (the cross product of x and z points down),
    // so flip it whenever the face looks the other way.
    const counterClockwiseSign = face.axis === 1 ? -1 : 1;
    const windingFlipped = face.sign !== counterClockwiseSign;
    const order = windingFlipped ? [0, 2, 1, 0, 3, 2] : [0, 1, 2, 0, 2, 3];
    for (const offset of order) this.indices.push(firstVertex + offset);
  }

  get triangleCount() {
    return this.indices.length / 3;
  }
}

// Everything of one house, in coordinates relative to the crane's centre line (x = 0) and absolute in y and z.
export function buildMachineryHouse() {
  const buckets = { sts_house: new GeometryBucket(), sts_paint: new GeometryBucket(), [DARK_STEEL_MATERIAL]: new GeometryBucket(), [RAIL_MATERIAL]: new GeometryBucket() };
  const { halfWidth, floorY, roofY, rearZ, frontZ, roofThickness, roofOverhang } = HOUSE;
  const wallTopY = roofY - roofThickness;
  const cladding = buckets.sts_house;
  const frame = buckets.sts_paint;
  const dark = buckets[DARK_STEEL_MATERIAL];
  const rail = buckets[RAIL_MATERIAL];

  cladding.addBox([-halfWidth, floorY, rearZ], [halfWidth, wallTopY, frontZ]);
  cladding.addBox([-halfWidth - roofOverhang, wallTopY, rearZ - roofOverhang], [halfWidth + roofOverhang, roofY, frontZ + roofOverhang]);

  addPanelRibs(cladding, { halfWidth, floorY, wallTopY, rearZ, frontZ });
  addFrameBands(frame, { halfWidth, floorY, wallTopY, rearZ, frontZ });
  addDoor(frame, dark, { halfWidth, floorY, frontZ });
  addLadder(dark, { halfWidth, floorY, roofY, frontZ });
  addRoofRail(rail, { halfWidth, roofY, rearZ, frontZ });
  return buckets;
}

function addPanelRibs(bucket, { halfWidth, floorY, wallTopY, rearZ, frontZ }) {
  const ribWidth = 0.28;
  const ribDepth = 0.12;
  // On the long walls the ribs sit between the four louvre panels that are already in the world.
  for (const sideSign of [-1, 1]) {
    const wallX = sideSign * halfWidth;
    for (const centreZ of [-48.35, -44.1, -39.85]) {
      const near = sideSign > 0 ? wallX : wallX - ribDepth;
      const far = sideSign > 0 ? wallX + ribDepth : wallX;
      bucket.addBox([near, floorY, centreZ - ribWidth / 2], [far, wallTopY, centreZ + ribWidth / 2], ['bottom', sideSign > 0 ? 'left' : 'right']);
    }
  }
  const endRibs = [{ wallZ: rearZ, sign: -1, positions: [-3.9, -1.3, 1.3, 3.9] }, { wallZ: frontZ, sign: 1, positions: [-1.3, 1.3] }];
  for (const { wallZ, sign, positions } of endRibs) {
    for (const centreX of positions) {
      const near = sign > 0 ? wallZ : wallZ - ribDepth;
      const far = sign > 0 ? wallZ + ribDepth : wallZ;
      bucket.addBox([centreX - ribWidth / 2, floorY, near], [centreX + ribWidth / 2, wallTopY, far], ['bottom', sign > 0 ? 'rear' : 'front']);
    }
  }
}

// Orange corner posts, a skirt and an eave band tie the grey cladding to the crane's paint.
function addFrameBands(bucket, { halfWidth, floorY, wallTopY, rearZ, frontZ }) {
  const outset = 0.1;
  const postSize = 0.4;
  for (const sideSign of [-1, 1]) {
    for (const [wallZ, endSign] of [[rearZ, -1], [frontZ, 1]]) {
      const minimumX = sideSign > 0 ? halfWidth - postSize + outset : -halfWidth - outset;
      const minimumZ = endSign > 0 ? wallZ - postSize + outset : wallZ - outset;
      bucket.addBox([minimumX, floorY, minimumZ], [minimumX + postSize, wallTopY, minimumZ + postSize], ['bottom']);
    }
  }
  const bands = [[floorY, floorY + 0.6], [wallTopY - 0.4, wallTopY]];
  for (const [bottomY, topY] of bands) {
    bucket.addBox([-halfWidth - outset, bottomY, rearZ - outset], [halfWidth + outset, topY, rearZ + 0.05], ['bottom']);
    bucket.addBox([-halfWidth - outset, bottomY, frontZ - 0.05], [halfWidth + outset, topY, frontZ + outset], ['bottom']);
    bucket.addBox([-halfWidth - outset, bottomY, rearZ], [-halfWidth + 0.05, topY, frontZ], ['bottom']);
    bucket.addBox([halfWidth - 0.05, bottomY, rearZ], [halfWidth + outset, topY, frontZ], ['bottom']);
  }
}

function addDoor(frameBucket, darkBucket, { floorY, frontZ }) {
  const doorMinimumX = -4.45;
  const doorMaximumX = -2.55;
  const doorTopY = floorY + 3.3;
  const frameWidth = 0.15;
  const outset = 0.1;
  darkBucket.addBox([doorMinimumX, floorY, frontZ], [doorMaximumX, doorTopY, frontZ + outset], ['bottom', 'rear']);
  frameBucket.addBox([doorMinimumX - frameWidth, floorY, frontZ], [doorMinimumX, doorTopY + frameWidth, frontZ + outset + 0.02], ['bottom', 'rear']);
  frameBucket.addBox([doorMaximumX, floorY, frontZ], [doorMaximumX + frameWidth, doorTopY + frameWidth, frontZ + outset + 0.02], ['bottom', 'rear']);
  frameBucket.addBox([doorMinimumX, doorTopY, frontZ], [doorMaximumX, doorTopY + frameWidth, frontZ + outset + 0.02], ['bottom', 'rear']);
}

// A vertical ladder from the girder deck to the roof, rails standing off the wall on three brackets.
function addLadder(bucket, { floorY, roofY, frontZ }) {
  const centreX = 3.5;
  const railSpacing = 0.5;
  const railThickness = 0.08;
  const standoff = 0.2;
  const bottomY = floorY + 0.3;
  const topY = roofY + 1.0;
  for (const offset of [-railSpacing / 2, railSpacing / 2]) {
    const x = centreX + offset;
    bucket.addBox([x - railThickness / 2, bottomY, frontZ + standoff - railThickness / 2], [x + railThickness / 2, topY, frontZ + standoff + railThickness / 2], ['bottom', 'rear']);
  }
  for (let rungY = bottomY + 0.4; rungY < topY - 0.2; rungY += 0.45) {
    bucket.addBox([centreX - railSpacing / 2, rungY, frontZ + standoff - 0.03], [centreX + railSpacing / 2, rungY + 0.05, frontZ + standoff + 0.03], ['bottom', 'rear']);
  }
  for (const bracketY of [bottomY + 0.8, (bottomY + topY) / 2, topY - 0.8]) {
    bucket.addBox([centreX - railSpacing / 2 - 0.03, bracketY, frontZ], [centreX + railSpacing / 2 + 0.03, bracketY + 0.05, frontZ + standoff], ['bottom', 'rear']);
  }
}

// A yellow hand rail round the roof edge, the way the cranes of a real terminal are fenced for roof work.
function addRoofRail(bucket, { halfWidth, roofY, rearZ, frontZ }) {
  const inset = 0.35;
  const postSize = 0.08;
  const postHeight = 1.1;
  const minimumX = -halfWidth + inset;
  const maximumX = halfWidth - inset;
  const minimumZ = rearZ + inset;
  const maximumZ = frontZ - inset;
  const postPositions = [];
  const alongZ = Math.round((maximumZ - minimumZ) / 4);
  const alongX = Math.round((maximumX - minimumX) / 4);
  for (let step = 0; step <= alongZ; step++) {
    const z = minimumZ + ((maximumZ - minimumZ) * step) / alongZ;
    postPositions.push([minimumX, z], [maximumX, z]);
  }
  for (let step = 1; step < alongX; step++) {
    const x = minimumX + ((maximumX - minimumX) * step) / alongX;
    postPositions.push([x, minimumZ], [x, maximumZ]);
  }
  for (const [x, z] of postPositions) {
    bucket.addBox([x - postSize / 2, roofY, z - postSize / 2], [x + postSize / 2, roofY + postHeight, z + postSize / 2], ['bottom']);
  }
  const railThickness = 0.06;
  for (const railY of [roofY + postHeight - railThickness, roofY + 0.55]) {
    bucket.addBox([minimumX, railY, minimumZ], [maximumX, railY + railThickness, minimumZ + railThickness], ['bottom']);
    bucket.addBox([minimumX, railY, maximumZ - railThickness], [maximumX, railY + railThickness, maximumZ], ['bottom']);
    bucket.addBox([minimumX, railY, minimumZ], [minimumX + railThickness, railY + railThickness, maximumZ], ['bottom']);
    bucket.addBox([maximumX - railThickness, railY, minimumZ], [maximumX, railY + railThickness, maximumZ], ['bottom']);
  }
}

// The equipment cabinet on top of the A-frame's cross beam: a cladded box with an eave band, under the beacon.
export function buildApexCabinet() {
  const buckets = { sts_house: new GeometryBucket(), sts_paint: new GeometryBucket() };
  const { beamY, height, halfWidth, rearZ, frontZ } = APEX;
  buckets.sts_house.addBox([-halfWidth, beamY, rearZ], [halfWidth, beamY + height - 0.2, frontZ]);
  buckets.sts_paint.addBox([-halfWidth - 0.1, beamY + height - 0.2, rearZ - 0.1], [halfWidth + 0.1, beamY + height, frontZ + 0.1], ['bottom']);
  return buckets;
}

function nodeWorldVertex(node, accessor, index) {
  const scale = node.getScale();
  const translation = node.getTranslation();
  const [x, y, z] = accessor.getElement(index, []);
  return [x * scale[0] + translation[0], y * scale[1] + translation[1], z * scale[2] + translation[2]];
}

function assertNoRotation(node) {
  const [x, y, z] = node.getRotation();
  if (Math.abs(x) + Math.abs(y) + Math.abs(z) > 1e-6) throw new Error(`Node ${node.getName()} is rotated, and this script reads vertices as translated and scaled only.`);
}

// The triangles that make up a crane's collapsed house: every vertex inside the house box of that crane.
export function findCollapsedHouseTriangles(houseNode, craneCentres) {
  assertNoRotation(houseNode);
  const primitive = houseNode.getMesh().listPrimitives()[0];
  const positions = primitive.getAttribute('POSITION');
  const indices = primitive.getIndices();
  const found = [];
  for (let triangle = 0; triangle < indices.getCount() / 3; triangle++) {
    const vertices = [0, 1, 2].map((corner) => nodeWorldVertex(houseNode, positions, indices.getScalar(triangle * 3 + corner)));
    const owner = craneCentres.find((centre) => vertices.every(([x, y, z]) => Math.abs(x - centre) <= DEGENERATE_SEARCH.halfWidth && y >= DEGENERATE_SEARCH.minimumY && y <= DEGENERATE_SEARCH.maximumY && z >= DEGENERATE_SEARCH.minimumZ && z <= DEGENERATE_SEARCH.maximumZ));
    if (owner !== undefined) found.push({ triangle, centre: owner });
  }
  return found;
}

// The crane centres, read from the collapsed houses themselves: the middle of the x extent of the triangles at the house height.
export function findCraneCentres(houseNode) {
  assertNoRotation(houseNode);
  const primitive = houseNode.getMesh().listPrimitives()[0];
  const positions = primitive.getAttribute('POSITION');
  const indices = primitive.getIndices();
  const candidates = [];
  for (let triangle = 0; triangle < indices.getCount() / 3; triangle++) {
    const vertices = [0, 1, 2].map((corner) => nodeWorldVertex(houseNode, positions, indices.getScalar(triangle * 3 + corner)));
    const atHouseHeight = vertices.every(([, y, z]) => y > 54 && y < 62.6 && z < -35 && z > -53);
    const spansHouse = Math.max(...vertices.map(([x]) => x)) - Math.min(...vertices.map(([x]) => x)) > 5;
    if (atHouseHeight && spansHouse) candidates.push(vertices);
  }
  const centres = [];
  for (const vertices of candidates) {
    const xs = vertices.map(([x]) => x);
    const centre = (Math.min(...xs) + Math.max(...xs)) / 2;
    if (!centres.some((known) => Math.abs(known - centre) < 8)) centres.push(centre);
  }
  return centres.sort((first, second) => first - second);
}

function hasApexBeam(paintNode, centre) {
  const primitive = paintNode.getMesh().listPrimitives()[0];
  const positions = primitive.getAttribute('POSITION');
  let hits = 0;
  for (let index = 0; index < positions.getCount(); index++) {
    const [x, y, z] = nodeWorldVertex(paintNode, positions, index);
    if (Math.abs(x - centre) <= 4.2 && y >= 78.6 && y <= 81.4 && z >= -7.1 && z <= -3.9) hits++;
  }
  return hits >= 8;
}

function createMeshFromBuckets(document, name, buckets) {
  const mesh = document.createMesh(name);
  const buffer = document.getRoot().listBuffers()[0];
  const materialsByName = new Map(document.getRoot().listMaterials().map((material) => [material.getName(), material]));
  for (const [materialName, bucket] of Object.entries(buckets)) {
    if (bucket.triangleCount === 0) continue;
    const material = materialsByName.get(materialName);
    if (!material) throw new Error(`The world has no material ${materialName}, so ${name} cannot use it.`);
    const position = document.createAccessor().setType('VEC3').setArray(new Float32Array(bucket.positions)).setBuffer(buffer);
    const normal = document.createAccessor().setType('VEC3').setArray(new Float32Array(bucket.normals)).setBuffer(buffer);
    const uv = document.createAccessor().setType('VEC2').setArray(new Float32Array(bucket.uvs)).setBuffer(buffer);
    const indices = document.createAccessor().setType('SCALAR').setArray(new Uint16Array(bucket.indices)).setBuffer(buffer);
    mesh.addPrimitive(document.createPrimitive().setAttribute('POSITION', position).setAttribute('NORMAL', normal).setAttribute('TEXCOORD_0', uv).setIndices(indices).setMaterial(material));
  }
  return mesh;
}

function removeTriangles(primitive, triangleNumbers) {
  const indices = primitive.getIndices();
  const removed = new Set(triangleNumbers);
  const kept = [];
  for (let triangle = 0; triangle < indices.getCount() / 3; triangle++) {
    if (removed.has(triangle)) continue;
    kept.push(indices.getScalar(triangle * 3), indices.getScalar(triangle * 3 + 1), indices.getScalar(triangle * 3 + 2));
  }
  const ArrayType = indices.getArray().constructor;
  indices.setArray(new ArrayType(kept));
}

// The yellow rail of the original house survived the decimation as loose pieces in the `safety_yellow` mesh: zero-area slivers and,
// for each crane, one 0.6 x 6 m slab tilted from the roof edge to 4 m behind the rear wall. Seen from the hero camera it floats above
// the machinery house, detached from the new roof rail. Triangles whose three vertices all lie in this box around a crane's house go.
const LEFTOVER_RAIL_SEARCH = { minimumY: 62.2, maximumY: 63.6, minimumZ: -57, maximumZ: -35.3, halfWidth: 6.3 };
const LEFTOVER_RAIL_MATERIAL = 'safety_yellow';

export function findLeftoverRailTriangles(railNode, craneCentres) {
  assertNoRotation(railNode);
  const found = [];
  for (const primitive of railNode.getMesh().listPrimitives()) {
    if (primitive.getMaterial()?.getName() !== LEFTOVER_RAIL_MATERIAL) continue;
    const positions = primitive.getAttribute('POSITION');
    const indices = primitive.getIndices();
    const triangles = [];
    for (let triangle = 0; triangle < indices.getCount() / 3; triangle++) {
      const vertices = [0, 1, 2].map((corner) => nodeWorldVertex(railNode, positions, indices.getScalar(triangle * 3 + corner)));
      const insideSomeHouse = craneCentres.some((centre) => vertices.every(([x, y, z]) => Math.abs(x - centre) <= LEFTOVER_RAIL_SEARCH.halfWidth && y >= LEFTOVER_RAIL_SEARCH.minimumY && y <= LEFTOVER_RAIL_SEARCH.maximumY && z >= LEFTOVER_RAIL_SEARCH.minimumZ && z <= LEFTOVER_RAIL_SEARCH.maximumZ));
      if (insideSomeHouse) triangles.push(triangle);
    }
    if (triangles.length > 0) found.push({ primitive, triangles });
  }
  return found;
}

function removeLeftoverRails(document, craneCentres) {
  let removed = 0;
  for (const node of document.getRoot().listNodes()) {
    if (!node.getMesh() || node.getName() === HOUSE_NODE_NAME || node.getName() === APEX_NODE_NAME) continue;
    for (const { primitive, triangles } of findLeftoverRailTriangles(node, craneCentres)) {
      removeTriangles(primitive, triangles);
      removed += triangles.length;
    }
  }
  return removed;
}

// Applies the fix to a document read from scene.rest.glb. Returns what it did; `changed` is false when nothing was left to fix.
// The two steps are independent, so a world that already has the houses still loses its leftover rail pieces.
export function fixCraneRear(document) {
  const nodes = document.getRoot().listNodes();
  const existingHouses = nodes.filter((node) => node.getName() === HOUSE_NODE_NAME);
  const houseNode = nodes.find((node) => node.getName() === 'sts_house' && node.getMesh());
  const paintNode = nodes.find((node) => node.getName() === 'sts_paint' && node.getMesh());
  if (!houseNode || !paintNode) throw new Error('The world has no sts_house or sts_paint mesh: this is not the port rest file.');
  const housesPresent = existingHouses.length > 0;
  const craneCentres = housesPresent ? existingHouses.map((node) => node.getTranslation()[0]).sort((first, second) => first - second) : findCraneCentres(houseNode);
  if (craneCentres.length === 0) throw new Error('No collapsed crane house found in sts_house; nothing to rebuild.');

  let collapsedCount = 0;
  const apexCentres = [];
  if (!housesPresent) {
    const collapsed = findCollapsedHouseTriangles(houseNode, craneCentres);
    collapsedCount = collapsed.length;
    removeTriangles(houseNode.getMesh().listPrimitives()[0], collapsed.map(({ triangle }) => triangle));
    const scene = document.getRoot().listScenes()[0];
    // One mesh per node, never one shared mesh: the first-view crop cuts a mesh in place by the pose of the node it visits first.
    for (const centre of craneCentres) {
      const houseMesh = createMeshFromBuckets(document, HOUSE_NODE_NAME, buildMachineryHouse());
      scene.addChild(document.createNode(HOUSE_NODE_NAME).setMesh(houseMesh).setTranslation([centre, 0, 0]));
      if (hasApexBeam(paintNode, centre)) {
        const apexMesh = createMeshFromBuckets(document, APEX_NODE_NAME, buildApexCabinet());
        scene.addChild(document.createNode(APEX_NODE_NAME).setMesh(apexMesh).setTranslation([centre, 0, 0]));
        apexCentres.push(centre);
      }
    }
  }
  const removedRailTriangles = removeLeftoverRails(document, craneCentres);
  if (housesPresent && removedRailTriangles === 0) return { changed: false, reason: 'already fixed' };
  return { changed: true, craneCentres, apexCentres, removedTriangles: collapsedCount, removedRailTriangles };
}

export async function createIo() {
  await Promise.all([MeshoptDecoder.ready, MeshoptEncoder.ready]);
  return new NodeIO()
    .registerExtensions([...ALL_EXTENSIONS, EXTMeshoptCompression])
    .registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });
}

async function main(argv) {
  const dryRun = argv.includes('--dry-run');
  const restFlag = argv.indexOf('--rest');
  const restPath = restFlag >= 0 ? resolve(argv[restFlag + 1]) : DEFAULT_REST_PATH;
  const io = await createIo();
  const document = await io.read(restPath);
  const result = fixCraneRear(document);
  if (!result.changed) {
    console.log(JSON.stringify(result));
    return;
  }
  document.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.FILTER });
  const written = Buffer.from(await io.writeBinary(document));
  if (!dryRun) writeFileSync(restPath, written);
  console.log(JSON.stringify({ ...result, bytes: written.length, wrote: !dryRun, file: join('public', 'showcase', 'port', 'scene.rest.glb') }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main(process.argv.slice(2));
