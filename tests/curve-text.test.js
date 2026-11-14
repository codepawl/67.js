import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentScene, agentSceneModulesNeeded, AGENT_SCENE_CAPABILITIES } from '../src/agent-scene.js';
import { curve } from '../src/modeling.js';
import { registerFont, text, flattenContour, groupRings } from '../src/text-geometry.js';
import { DEFAULT_FONT_DATA } from '../src/font-default.js';

const CIRCLE_HANDLE = 0.5522847498;

function triangleMeasures({ positions, indices }) {
  let volume = 0;
  let area = 0;
  for (let offset = 0; offset < indices.length; offset += 3) {
    const [a, b, c] = [0, 1, 2].map(corner => Array.from(positions.subarray(indices[offset + corner] * 3, indices[offset + corner] * 3 + 3)));
    volume += (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
    const first = b.map((value, axis) => value - a[axis]);
    const second = c.map((value, axis) => value - a[axis]);
    area += Math.hypot(first[1] * second[2] - first[2] * second[1], first[2] * second[0] - first[0] * second[2], first[0] * second[1] - first[1] * second[0]) / 2;
  }
  return { volume, area };
}

function bounds({ positions }) {
  const minimum = [Infinity, Infinity, Infinity];
  const maximum = [-Infinity, -Infinity, -Infinity];
  for (let index = 0; index < positions.length; index += 3) {
    for (let axis = 0; axis < 3; axis++) {
      minimum[axis] = Math.min(minimum[axis], positions[index + axis]);
      maximum[axis] = Math.max(maximum[axis], positions[index + axis]);
    }
  }
  return { minimum, maximum };
}

function unwelded(mesh) {
  // Edges counted by rounded position: a closed surface uses every edge twice.
  const key = index => Array.from(mesh.positions.subarray(index * 3, index * 3 + 3), value => value.toFixed(4)).join(',');
  const uses = new Map();
  for (let offset = 0; offset < mesh.indices.length; offset += 3) {
    for (let side = 0; side < 3; side++) {
      const from = key(mesh.indices[offset + side]);
      const to = key(mesh.indices[offset + (side + 1) % 3]);
      if (from === to) continue;
      const edge = from < to ? `${from}|${to}` : `${to}|${from}`;
      uses.set(edge, (uses.get(edge) ?? 0) + 1);
    }
  }
  return [...uses.values()].filter(count => count !== 2).length;
}

const circlePoints = [
  { position: [1, 0, 0], handleIn: [1, -CIRCLE_HANDLE, 0], handleOut: [1, CIRCLE_HANDLE, 0] },
  { position: [0, 1, 0], handleIn: [CIRCLE_HANDLE, 1, 0], handleOut: [-CIRCLE_HANDLE, 1, 0] },
  { position: [-1, 0, 0], handleIn: [-1, CIRCLE_HANDLE, 0], handleOut: [-1, -CIRCLE_HANDLE, 0] },
  { position: [0, -1, 0], handleIn: [-CIRCLE_HANDLE, -1, 0], handleOut: [CIRCLE_HANDLE, -1, 0] },
];

test('a closed Bezier ring with a round profile has the volume of a torus and faces outward', () => {
  const mesh = curve(circlePoints, { closed: true, radius: 0.1, radialSegments: 48, resolution: 24 });
  const { volume } = triangleMeasures(mesh);
  const torusVolume = 2 * Math.PI * Math.PI * 1 * 0.01;
  assert.ok(volume > 0, 'faces point outward');
  assert.ok(Math.abs(volume - torusVolume) / torusVolume < 0.01, `${volume} against ${torusVolume}`);
  assert.equal(unwelded(mesh), 0, 'a closed curve has no open edge');
});

test('an open curve gets flat caps and is watertight', () => {
  const mesh = curve([[0, 0, 0], [1, 1, 0], [2, 0, 0], [3, 1, 1]], { radius: 0.1, radialSegments: 8 });
  assert.ok(triangleMeasures(mesh).volume > 0);
  assert.equal(unwelded(mesh), 0);
});

test('taper scales the radius along the length: a cone has a third of the cylinder volume', () => {
  const cone = curve([[0, 0, 0], [0, 3, 0]], { radius: 0.5, taper: [1, 0], radialSegments: 64, resolution: 32 });
  const cylinder = curve([[0, 0, 0], [0, 3, 0]], { radius: 0.5, radialSegments: 64, resolution: 4 });
  const ratio = triangleMeasures(cone).volume / triangleMeasures(cylinder).volume;
  assert.ok(Math.abs(ratio - 1 / 3) < 0.01, `ratio ${ratio}`);
});

test('a custom profile sweeps its own cross-section whichever way it winds', () => {
  const bar = [[-0.2, -0.1], [0.2, -0.1], [0.2, 0.1], [-0.2, 0.1]];
  for (const profile of [bar, [...bar].reverse()]) {
    const mesh = curve([[0, 0, 0], [0, 0, 2]], { radius: 1, profile });
    assert.ok(Math.abs(triangleMeasures(mesh).volume - 0.4 * 0.2 * 2) < 1e-6);
    assert.equal(unwelded(mesh), 0);
  }
  const { minimum, maximum } = bounds(curve([[0, 0, 0], [0, 0, 2]], { radius: 1, profile: bar }));
  assert.ok(Math.abs(maximum[2] - minimum[2] - 2) < 1e-6);
});

test('handles: automatic ones are smooth, a lone handle is mirrored and explicit ones bend the span', () => {
  const automatic = bounds(curve([[0, 0, 0], [1, 1, 0], [2, 0, 0]], { radius: 0.01, radialSegments: 3 }));
  assert.ok(automatic.maximum[1] > 0.9 && automatic.maximum[1] < 1.2);
  const mirrored = curve([{ position: [0, 0, 0], handleOut: [0, 1, 0] }, [4, 0, 0]], { radius: 0.01, radialSegments: 3 });
  assert.ok(bounds(mirrored).maximum[1] > 0.4, 'the span leaves along the handle');
  const straight = bounds(curve([[0, 0, 0], [4, 0, 0]], { radius: 0.01, radialSegments: 3 }));
  assert.ok(straight.maximum[1] < 0.011);
});

test('curve rejects hostile or malformed input', () => {
  const line = [[0, 0, 0], [1, 0, 0]];
  const cases = [
    () => curve([[0, 0, 0]], {}),
    () => curve(Array.from({ length: 1025 }, (_, index) => [index, 0, 0]), {}),
    () => curve(line, { radius: 0 }),
    () => curve(line, { radius: NaN }),
    () => curve(line, { radius: Infinity }),
    () => curve(line, { resolution: 0 }),
    () => curve(line, { resolution: 65 }),
    () => curve(line, { radialSegments: 2 }),
    () => curve(line, { taper: [1] }),
    () => curve(line, { taper: [1, -1] }),
    () => curve(line, { taper: Array.from({ length: 65 }, () => 1) }),
    () => curve(line, { profile: [[0, 0], [1, 0]] }),
    () => curve(line, { profile: Array.from({ length: 257 }, (_, index) => [Math.cos(index), Math.sin(index)]) }),
    () => curve(line, { profile: [[0, 0], [1, 0], [0, 0]] }),
    () => curve([[0, 0, 0], [0, 0, 0]], {}),
    () => curve([[0, 0], [1, 0]], {}),
    () => curve([{ position: [0, 0, 0], extra: 1 }, [1, 0, 0]], {}),
    () => curve([{ position: [0, 0, 0], handleOut: 'x' }, [1, 0, 0]], {}),
    () => curve(['a', 'b'], {}),
    () => curve(line, { closed: 'yes' }),
    () => curve(line, { closed: true }),
    () => curve(line, { resolution: 64, radialSegments: 128, maxVertices: 1000 }),
    () => curve(null, {}),
  ];
  cases.forEach((run, index) => assert.throws(run, Error, `case ${index} should throw`));
});

test('the bundled font builds every printable character and keeps counters open', () => {
  for (let code = 33; code <= 126; code++) {
    const character = String.fromCharCode(code);
    const mesh = text(character, { size: 1, depth: 0.1, curveSegments: 3 });
    assert.ok(triangleMeasures(mesh).volume > 0, `${character} faces outward`);
  }
  const solid = triangleMeasures(text('I', { depth: 1 })).volume;
  const letterB = triangleMeasures(text('B', { depth: 1, curveSegments: 12 }));
  assert.ok(letterB.volume > solid && letterB.volume < 0.5, 'B is area times depth, with two holes cut out');
});

test('text sits on its baseline, reads along +X, is centred through its depth and splits lines', () => {
  const single = bounds(text('Hello', { size: 2, depth: 0.5 }));
  assert.ok(Math.abs(single.minimum[2] + 0.25) < 1e-6 && Math.abs(single.maximum[2] - 0.25) < 1e-6);
  assert.ok(single.minimum[1] > -0.1 * 2 && single.maximum[1] > 1.4 && single.maximum[1] < 1.6);
  const advances = [...'Hello'].reduce((total, character) => total + DEFAULT_FONT_DATA.glyphs[character][0], 0) * 2 / DEFAULT_FONT_DATA.unitsPerEm;
  assert.ok(single.maximum[0] < advances && single.maximum[0] > advances * 0.9);
  const centered = bounds(text('Hello', { size: 2, depth: 0.5, align: 'center' }));
  assert.ok(Math.abs((centered.minimum[0] + centered.maximum[0]) / 2) < advances * 0.1);
  const right = bounds(text('Hello', { size: 2, align: 'right' }));
  assert.ok(right.maximum[0] <= 1e-6);
  const twoLines = bounds(text('Hi\nHi', { size: 1 }));
  assert.ok(twoLines.minimum[1] < -1.1);
});

test('text rejects hostile or unsupported input', () => {
  const cases = [
    () => text('', {}),
    () => text(42, {}),
    () => text('a'.repeat(257), {}),
    () => text('a\n'.repeat(17), {}),
    () => text('   ', {}),
    () => text('é', {}),
    () => text('\u{1F600}', {}),
    () => text('a', { size: 0 }),
    () => text('a', { size: NaN }),
    () => text('a', { depth: -1 }),
    () => text('a', { depth: Infinity }),
    () => text('a', { curveSegments: 0 }),
    () => text('a', { curveSegments: 17 }),
    () => text('a', { curveSegments: 2.5 }),
    () => text('a', { align: 'justify' }),
    () => text('a', { font: 'missing' }),
    () => text('a', { font: '__proto__' }),
    () => text('@'.repeat(200), { curveSegments: 16, maxVertices: 10_000 }),
  ];
  cases.forEach((run, index) => assert.throws(run, Error, `case ${index} should throw`));
});

test('registerFont validates a font table and the font becomes usable by name', () => {
  const square = [0, 0, 1, 500, 0, 1, 500, 500, 1, 0, 500, 1];
  const font = { unitsPerEm: 1000, ascender: 800, descender: -200, glyphs: { A: [600, square] } };
  registerFont('Square', font);
  const mesh = text('AA', { font: 'Square', size: 1, depth: 1 });
  assert.ok(Math.abs(triangleMeasures(mesh).volume - 2 * 0.25) < 1e-5);
  const invalid = [
    ['bad/name', font],
    ['', font],
    ['ok', null],
    ['ok', { ...font, unitsPerEm: 4 }],
    ['ok', { ...font, unitsPerEm: 1000.5 }],
    ['ok', { ...font, ascender: NaN }],
    ['ok', { ...font, glyphs: {} }],
    ['ok', { ...font, glyphs: { AB: [600, square] } }],
    ['ok', { ...font, glyphs: { A: 'x' } }],
    ['ok', { ...font, glyphs: { A: [600, [0, 0, 1, 1, 1, 1]] } }],
    ['ok', { ...font, glyphs: { A: [600, [...square.slice(0, 11), 2]] } }],
    ['ok', { ...font, glyphs: { A: [600, [...square.slice(0, 3), NaN, 0, 1, 1, 1, 1]] } }],
    ['ok', { ...font, glyphs: { A: [600, Array.from({ length: 129 * 3 }, (_, index) => (index % 3 === 2 ? 1 : index))] } }],
    ['ok', { ...font, glyphs: Object.fromEntries(Array.from({ length: 2049 }, (_, index) => [String.fromCodePoint(0x4e00 + index), [600, square]])) }],
  ];
  invalid.forEach(([name, table], index) => assert.throws(() => registerFont(name, table), Error, `font case ${index} should throw`));
});

test('contours flatten with implied points and group into outlines with holes', () => {
  const ring = flattenContour([0, 0, 1, 100, 0, 0, 100, 100, 0, 0, 100, 1], 4);
  assert.ok(ring.length >= 4 && ring.every(point => Number.isFinite(point[0])));
  const outer = [[0, 0], [10, 0], [10, 10], [0, 10]];
  const hole = [[2, 2], [2, 8], [8, 8], [8, 2]];
  const island = [[4, 4], [6, 4], [6, 6], [4, 6]];
  const grouped = groupRings([outer, hole, island]);
  assert.equal(grouped.length, 2);
  assert.equal(grouped[0].holes.length, 1);
});

const signRecipe = {
  format: 'crucible.scene', schemaVersion: 1,
  geometries: [
    { id: 'board', type: 'box', bevel: 0 },
    { id: 'letters', type: 'text', text: 'OPEN', size: 0.5, depth: 0.05, align: 'center' },
    { id: 'pipe', type: 'curve', points: [[-1, 0, 0], { position: [0, 1, 0], handleIn: [-0.5, 1, 0], handleOut: [0.5, 1, 0] }, [1, 0, 0]], radius: 0.04, taper: [1, 0.5] },
  ],
  materials: [{ id: 'paint', color: [0.9, 0.8, 0.2] }, { id: 'metal', color: [0.6, 0.6, 0.65], metallic: 1, roughness: 0.3 }],
  nodes: [
    { id: 'board', geometry: 'board', material: 'paint', scale: [2, 1, 0.05] },
    { id: 'letters', geometry: 'letters', material: 'metal', translation: [0, -0.2, 0.05] },
    { id: 'pipe', geometry: 'pipe', material: 'metal' },
  ],
};

test('a recipe draws a labelled sign and a piped curve', () => {
  assert.deepEqual(agentSceneModulesNeeded(signRecipe), ['modeling', 'text', 'reflections']);
  const scene = createAgentScene(signRecipe);
  const letters = scene.parts.find(part => part.name === 'letters');
  const pipe = scene.parts.find(part => part.name === 'pipe');
  assert.ok(letters.geometry.indices.length > 0 && pipe.geometry.indices.length > 0);
  assert.deepEqual(scene.exportRecipe().geometries.map(geometry => geometry.type), ['box', 'text', 'curve']);
});

test('recipe geometry validation rejects unknown fields, wrong types and oversized text before generating', () => {
  const withGeometry = geometry => ({ ...signRecipe, geometries: [geometry], nodes: [{ id: 'n', geometry: 'g', material: 'paint' }] });
  const bad = [
    { id: 'g', type: 'text', text: 'A', unknown: 1 },
    { id: 'g', type: 'text', text: 5 },
    { id: 'g', type: 'text', text: 'A'.repeat(257) },
    { id: 'g', type: 'text', text: 'A', size: 'big' },
    { id: 'g', type: 'text', text: 'A', font: 7 },
    { id: 'g', type: 'text', text: 'W'.repeat(255), curveSegments: 16 },
    { id: 'g', type: 'curve', points: 'a' },
    { id: 'g', type: 'curve', points: [[0, 0, 0]] },
    { id: 'g', type: 'curve', points: [[0, 0, 0], [1, 0, 0]], resolution: 1000 },
    { id: 'g', type: 'curve', points: [[0, 0, 0], [1, 0, 0]], profile: 4 },
    { id: 'g', type: 'curve', points: [[0, 0, 0], [1, 0, 0]], radialSegments: 500 },
    { id: 'g', type: 'curve', points: [[0, 0, 0], [1, 0, 0]], extra: true },
    { id: 'g', type: 'curve', points: [{ position: [0, 0, 0], handleIn: [0, 0] }, [1, 0, 0]] },
  ];
  bad.forEach((geometry, index) => assert.throws(() => createAgentScene(withGeometry(geometry)), Error, `recipe case ${index} should throw`));
});

test('no bundled glyph exceeds the vertex bound the recipe estimate uses', () => {
  const { verticesPerCharacterSegment } = AGENT_SCENE_CAPABILITIES.curveText;
  for (const curveSegments of [1, 4, 16]) {
    for (let code = 33; code <= 126; code++) {
      const vertices = text(String.fromCharCode(code), { curveSegments }).positions.length / 3;
      assert.ok(vertices <= verticesPerCharacterSegment * curveSegments, `${String.fromCharCode(code)} at ${curveSegments}: ${vertices}`);
    }
  }
});

test('capabilities list the new types with their limits and details', () => {
  assert.ok(AGENT_SCENE_CAPABILITIES.geometryTypes.includes('curve') && AGENT_SCENE_CAPABILITIES.geometryTypes.includes('text'));
  assert.equal(AGENT_SCENE_CAPABILITIES.curveText.maxTextCharacters, 256);
  assert.match(AGENT_SCENE_CAPABILITIES.curveText.details.text, /baseline/);
});
