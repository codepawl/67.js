import test from 'node:test';
import assert from 'node:assert/strict';
import { exportGlb } from '../src/export.js';
import { createFlowerPatch, createGrassClump, createGrassField, createTree, scatterVegetation, selectLevels, SPECIES } from '../src/vegetation.js';
import { createBarkPixels, createLeafPixels } from '../src/vegetation-textures.js';

const SPECIES_NAMES = Object.keys(SPECIES);

function assertValidGeometry(geometry) {
  const vertexCount = geometry.positions.length / 3;
  assert.ok(vertexCount > 0 && geometry.indices.length > 0);
  assert.equal(geometry.normals.length, geometry.positions.length);
  assert.equal(geometry.uvs.length, vertexCount * 2);
  for (const value of [...geometry.positions, ...geometry.normals, ...geometry.uvs]) assert.ok(Number.isFinite(value));
  for (const index of geometry.indices) assert.ok(index < vertexCount);
  for (let offset = 0; offset < geometry.normals.length; offset += 3) {
    const length = Math.hypot(geometry.normals[offset], geometry.normals[offset + 1], geometry.normals[offset + 2]);
    assert.ok(Math.abs(length - 1) < 1e-3, `normal length ${length}`);
  }
  if (geometry.colors) assert.equal(geometry.colors.length, geometry.positions.length);
}

function digest(tree) {
  return tree.levels.map(level => level.parts.map(part => [...part.geometry.positions.slice(0, 60), part.geometry.indices.length].join(',')).join('|')).join('#');
}

test('trees are deterministic by seed and differ between seeds', () => {
  assert.equal(digest(createTree('broadleaf', 5)), digest(createTree('broadleaf', 5)));
  assert.notEqual(digest(createTree('broadleaf', 5)), digest(createTree('broadleaf', 6)));
});

test('every species and leaf mode yields valid geometry on all levels', () => {
  for (const species of SPECIES_NAMES) {
    for (const leaves of ['cards', 'mesh']) {
      const tree = createTree({ species, leaves }, 3);
      assert.equal(tree.levels.length, 4);
      for (const level of tree.levels) {
        for (const part of level.parts) assertValidGeometry(part.geometry);
      }
    }
  }
});

test('bark faces outward and leaf cards carry the alpha-mask material contract', () => {
  const tree = createTree('broadleaf', 2);
  const bark = tree.levels[0].parts[0].geometry;
  let outward = 0;
  let total = 0;
  for (let offset = 0; offset < bark.indices.length; offset += 3) {
    const corners = [0, 1, 2].map(corner => Array.from(bark.positions.subarray(bark.indices[offset + corner] * 3, bark.indices[offset + corner] * 3 + 3)));
    const edgeA = corners[1].map((value, axis) => value - corners[0][axis]);
    const edgeB = corners[2].map((value, axis) => value - corners[0][axis]);
    const face = [edgeA[1] * edgeB[2] - edgeA[2] * edgeB[1], edgeA[2] * edgeB[0] - edgeA[0] * edgeB[2], edgeA[0] * edgeB[1] - edgeA[1] * edgeB[0]];
    const normalOffset = bark.indices[offset] * 3;
    const alignment = face[0] * bark.normals[normalOffset] + face[1] * bark.normals[normalOffset + 1] + face[2] * bark.normals[normalOffset + 2];
    total++;
    if (alignment > 0) outward++;
  }
  assert.ok(outward / total > 0.98, `${outward}/${total} outward`);
  const foliage = tree.levels[0].parts[1].material;
  assert.equal(foliage.alphaMode, 'mask');
  assert.equal(foliage.doubleSided, true);
  assert.ok(foliage.map.image.width > 0);
  assert.equal(createTree({ species: 'birch', leaves: 'mesh' }, 1).levels[0].parts[1].material.tag, 'foliage');
});

test('invalid inputs are rejected', () => {
  assert.throws(() => createTree('banana', 1), RangeError);
  assert.throws(() => createTree({ species: 'oak', leaves: 'sprites' }, 1), RangeError);
  assert.throws(() => scatterVegetation({ area: { minX: 0, maxX: 0, minZ: 0, maxZ: 5 } }), TypeError);
});

test('triangle budgets fall with each level of detail', () => {
  const budgets = { broadleaf: [60000, 12000, 2500, 2500], birch: [60000, 12000, 2500, 2500], conifer: [60000, 12000, 2500, 1200], palm: [30000, 8000, 3000, 3000], bush: [20000, 5000, 2500, 2500] };
  for (const species of SPECIES_NAMES) {
    for (const leaves of ['cards', 'mesh']) {
      const triangles = createTree({ species, leaves }, 4).levels.map(level => level.triangles);
      assert.ok(triangles[0] > triangles[1] && triangles[1] > triangles[2] && triangles[2] >= triangles[3], `${species} ${leaves} ${triangles}`);
      const scale = leaves === 'mesh' ? 2 : 1;
      triangles.forEach((count, level) => assert.ok(count <= budgets[species][level] * scale, `${species} ${leaves} level ${level}: ${count}`));
    }
  }
});

test('foliage carries thinner shadow layers, and the far conifer level costs under half the level before it', () => {
  const tree = createTree('conifer', 4);
  const [full, sparse, sparsest] = tree.levels[0].parts[1].shadowLods;
  assert.equal(full.error, 0);
  assert.ok(full.geometry.indices.length > sparse.geometry.indices.length && sparse.geometry.indices.length > sparsest.geometry.indices.length);
  assert.ok(sparse.error > 0 && sparsest.error > sparse.error, 'errors grow as the layers thin out');
  assert.equal(tree.levels[1].parts[1].shadowLods.length, 2, 'level 1 already is the first thinner layer');
  assert.equal(tree.levels[2].parts[1].shadowLods, undefined, 'the crown clumps are thin enough');
  assert.ok(tree.levels[3].triangles < tree.levels[2].triangles / 2);
});

test('wind sway comes from leaves on the foliage tag while bark stays static', () => {
  const tree = createTree({ species: 'conifer', leaves: 'mesh' }, 1);
  assert.equal(tree.levels[0].parts[0].material.tag, undefined);
  assert.equal(tree.levels[0].parts[1].material.tag, 'foliage');
  assert.equal(createGrassClump({ seed: 1 }).levels[0].parts[0].material.tag, 'grass');
});

test('grass and flowers produce valid geometry', () => {
  for (const style of ['blades', 'cards']) {
    const clump = createGrassClump({ style, seed: 2 });
    clump.levels.forEach(level => assertValidGeometry(level.parts[0].geometry));
  }
  assertValidGeometry(createFlowerPatch({ seed: 3 }).levels[0].parts[0].geometry);
});

test('textures have alpha leaves and opaque bark', () => {
  const leaf = createLeafPixels('sprig', [60, 110, 40]);
  const alphas = new Set(Array.from({ length: leaf.width * leaf.height }, (_, pixel) => leaf.data[pixel * 4 + 3] > 127));
  assert.deepEqual([...alphas].sort(), [false, true]);
  for (const kind of ['rough', 'birch']) {
    const bark = createBarkPixels(kind);
    assert.ok(bark.data.every((value, offset) => offset % 4 !== 3 || value === 255));
  }
});

const AREA = { minX: -40, maxX: 40, minZ: -40, maxZ: 40 };
const ROLLING = (x, z) => Math.sin(x * 0.12) * 2 + Math.cos(z * 0.1) * 1.5;

test('scatter keeps spacing, honors exclusion and slope, and is deterministic', () => {
  const options = { area: AREA, density: 0.02, terrainHeight: ROLLING, slopeLimit: 12, exclusion: (x, z) => Math.hypot(x, z) < 10, seed: 9 };
  const first = scatterVegetation(options);
  const second = scatterVegetation(options);
  assert.ok(first.instances.length > 40);
  assert.deepEqual(first.instances.map(instance => instance.position), second.instances.map(instance => instance.position));
  const spacing = Math.sqrt(0.6 / 0.02);
  for (let a = 0; a < first.instances.length; a++) {
    const [x, , z] = first.instances[a].position;
    assert.ok(Math.hypot(x, z) >= 10);
    const slopeX = (ROLLING(x + 0.6, z) - ROLLING(x - 0.6, z)) / 1.2;
    const slopeZ = (ROLLING(x, z + 0.6) - ROLLING(x, z - 0.6)) / 1.2;
    assert.ok(Math.atan(Math.hypot(slopeX, slopeZ)) * 180 / Math.PI <= 12 + 1e-6);
    for (let b = a + 1; b < first.instances.length; b++) {
      const other = first.instances[b].position;
      assert.ok(Math.hypot(x - other[0], z - other[2]) >= spacing - 1e-6);
    }
  }
});

test('scattered instances share geometry per variant and a species mix is respected', () => {
  const field = scatterVegetation({ area: AREA, density: 0.03, seed: 4, variants: 3, mix: { broadleaf: 1, conifer: 1 } });
  const geometries = new Set(field.parts.map(part => part.geometry));
  assert.ok(geometries.size <= 2 * 3 * 2);
  assert.ok(field.parts.length > geometries.size * 2);
  assert.deepEqual(Object.keys(field.counts).sort(), ['broadleaf', 'conifer']);
  assert.ok(Object.values(field.variants).every(list => list.length === 3));
});

test('level selection follows distance with hysteresis and culling', () => {
  const field = scatterVegetation({ area: { minX: -5, maxX: 5, minZ: -5, maxZ: 5 }, density: 0.02, seed: 2, mix: { broadleaf: 1 } });
  const instance = field.instances[0];
  const [x, y, z] = instance.position;
  const levelAt = (distance, options) => {
    selectLevels([instance], [x + distance, y, z], options);
    return instance.level;
  };
  assert.equal(levelAt(5), 0);
  assert.equal(levelAt(50), 1);
  assert.equal(levelAt(120), 2);
  assert.equal(levelAt(40), 1, 'inside the hysteresis band the level holds');
  assert.equal(levelAt(36), 1);
  assert.equal(levelAt(30), 0);
  const result = selectLevels([instance], [x + 400, y, z], { cullDistance: 300 });
  assert.equal(instance.level, -1);
  assert.equal(result.culled, 1);
  assert.equal(result.parts.length, 0);
  assert.equal(levelAt(10, { cullDistance: 300 }), 0);
});

test('selectLevels reports changes and triangle totals, and parts keep geometry identity', () => {
  const field = scatterVegetation({ area: AREA, density: 0.02, seed: 7, mix: { broadleaf: 1, birch: 1 } });
  const near = selectLevels(field.instances, [0, 5, 0]);
  const far = selectLevels(field.instances, [300, 5, 300]);
  assert.ok(far.changed);
  assert.ok(far.triangles < near.triangles);
  const again = selectLevels(field.instances, [300, 5, 300]);
  assert.equal(again.changed, false);
  assert.equal(again.parts.every((part, index) => part === far.parts[index]), true);
});

test('grass fields scatter clumps and flowers', () => {
  const meadow = createGrassField({ area: { minX: 0, maxX: 12, minZ: 0, maxZ: 12 }, seed: 5 });
  assert.ok(meadow.counts.grass > 50);
  assert.ok(meadow.parts.every(part => part.geometry.indices.length > 0));
});

test('mesh vegetation keeps vertex and material colors within [0, 1] for GLB export across all species and levels', () => {
  const matrix = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const broadleaf = createTree({ species: 'broadleaf', height: 9, leaves: 'mesh' }, 13);
  for (const level of broadleaf.levels) {
    const binary = exportGlb(level.parts.map(part => ({ ...part, matrix })));
    assert.ok(binary.byteLength > 0);
  }
  for (const species of SPECIES_NAMES) {
    const tree = createTree({ species, leaves: 'mesh' }, 3);
    for (const level of tree.levels) {
      for (const part of level.parts) {
        for (const channel of part.material.color) assert.ok(channel >= 0 && channel <= 1);
        if (part.geometry.colors) {
          for (const channel of part.geometry.colors) assert.ok(channel >= 0 && channel <= 1);
        }
      }
      assert.ok(exportGlb(level.parts.map(part => ({ ...part, matrix }))).byteLength > 0);
    }
  }
  const clump = createGrassClump({ style: 'blades', seed: 2 });
  for (const level of clump.levels) {
    assert.ok(exportGlb(level.parts.map(part => ({ ...part, matrix }))).byteLength > 0);
  }
  const flowers = createFlowerPatch({ seed: 3 });
  assert.ok(exportGlb(flowers.levels[0].parts.map(part => ({ ...part, matrix }))).byteLength > 0);
  const field = scatterVegetation({ area: { minX: -10, maxX: 10, minZ: -10, maxZ: 10 }, density: 0.04, leaves: 'mesh', seed: 7 });
  assert.ok(exportGlb(field.parts).byteLength > 0);
});
