import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentScene } from '../src/agent-scene.js';
import { exposureProblems, framingProblems, lumaShares, mergeFrameDiagnostics, pathTracerFindingsLimit, placementProblems, textureProblems } from '../src/frame-checks.js';
import { closedRoom, closedRoomWithoutBake } from './support/agent-bake-rooms.mjs';

function sceneWithCamera(camera) {
  return {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'box', type: 'box' }],
    materials: [{ id: 'red', color: [0.8, 0.2, 0.2] }],
    nodes: [{ id: 'cube', geometry: 'box', material: 'red' }],
    camera,
  };
}

function framingOf(recipe) {
  const scene = createAgentScene(recipe);
  return framingProblems({ camera: scene.camera, aspect: 1, boxes: scene.worldBounds() });
}

function kinds(problems) {
  return problems.map(problem => problem.kind);
}

test('a subject in view gives no framing warning', () => {
  assert.deepEqual(framingOf(sceneWithCamera({ eye: [3, 2, 4], target: [0, 0, 0], fov: 45 })), []);
  assert.deepEqual(framingOf(closedRoom()), []);
});

test('a scene with no parts is an empty frame and says what to add', () => {
  const problems = framingOf({ ...sceneWithCamera({}), nodes: [] });
  assert.deepEqual(kinds(problems), ['empty-frame']);
  assert.match(problems[0].fix, /add-node/);
});

test('a camera that looks away from the subject names a camera.target and camera.eye that frame it', () => {
  const problems = framingOf(sceneWithCamera({ eye: [3, 2, 4], target: [30, 2, -40], fov: 45 }));
  assert.deepEqual(kinds(problems), ['subject-out-of-frame']);
  assert.match(problems[0].fix, /camera\.target to \[0,0,0\].*camera\.eye to \[/);
});

test('a subject far away fills so little of the frame that it is called too small', () => {
  const problems = framingOf(sceneWithCamera({ eye: [0, 0, 400], target: [0, 0, 0], fov: 45, far: 2000 }));
  assert.deepEqual(kinds(problems), ['subject-too-small']);
});

test('hidden parts do not count and orthographic cameras are not judged', () => {
  const hidden = sceneWithCamera({ eye: [3, 2, 4], target: [0, 0, 0] });
  hidden.nodes[0].visible = false;
  assert.deepEqual(kinds(framingOf(hidden)), ['empty-frame']);
  assert.deepEqual(framingOf(sceneWithCamera({ eye: [3, 2, 4], target: [30, 2, -40], projection: 'orthographic' })), []);
});

function frameOf(luma, count = 100) {
  return new Uint8Array(count * 4).fill(luma);
}

test('exposure warns on a black or clipped frame and not on a normal one', () => {
  const black = exposureProblems({ shares: lumaShares(frameOf(0)), exposure: 1 });
  assert.deepEqual(kinds(black), ['exposure-black']);
  assert.match(black[0].fix, /effects\.exposure from 1 to 4/);
  const white = exposureProblems({ shares: lumaShares(frameOf(255)), exposure: 1 });
  assert.deepEqual(kinds(white), ['exposure-clipped']);
  assert.match(white[0].fix, /effects\.exposure from 1 to 0\.5/);
  assert.deepEqual(exposureProblems({ shares: lumaShares(frameOf(120)), exposure: 1 }), []);
  const mostlyMid = frameOf(120);
  mostlyMid.fill(255, 0, 40);
  assert.deepEqual(exposureProblems({ shares: lumaShares(mostlyMid), exposure: 1 }), []);
});

function lightMoves() {
  return closedRoom({ motion: { duration: 2, loop: false, tracks: [
    { kind: 'light', id: 'point:0', property: 'position', keyframes: [{ time: 0, value: [0, 2.7, 0] }, { time: 2, value: [1, 2.7, 0] }] },
  ] } });
}

test('an unchanged baked scene gives no stale warning at the rest pose', () => {
  assert.deepEqual(createAgentScene(closedRoom()).bakeStaleness(), []);
  const scene = createAgentScene(lightMoves());
  scene.sampleMotion(0);
  assert.deepEqual(scene.bakeStaleness(), []);
  assert.deepEqual(createAgentScene(closedRoomWithoutBake()).bakeStaleness(), []);
});

test('moving a light after a bake gives bake-stale with the fix', () => {
  const scene = createAgentScene(lightMoves());
  scene.sampleMotion(2);
  const problems = scene.bakeStaleness();
  assert.deepEqual(kinds(problems), ['bake-stale']);
  assert.match(problems[0].fix, /bake.rebake/);
  scene.sampleMotion(null);
  assert.deepEqual(scene.bakeStaleness(), []);
});

test('moving a part after a bake gives bake-stale', () => {
  const scene = createAgentScene(closedRoom({ motion: { duration: 2, loop: false, tracks: [
    { kind: 'node', id: 'block', property: 'translation', keyframes: [{ time: 0, value: [-0.7, 0.6, -0.4] }, { time: 2, value: [0.5, 0.6, -0.4] }] },
  ] } }));
  scene.sampleMotion(2);
  const problems = scene.bakeStaleness();
  assert.deepEqual(kinds(problems), ['bake-stale']);
});

test('job metrics keep one entry per warning across frames', () => {
  const metrics = {};
  const warning = { kind: 'exposure-black', target: 'effects.exposure', message: 'm', fix: 'f' };
  mergeFrameDiagnostics(metrics, [warning]);
  mergeFrameDiagnostics(metrics, [{ ...warning }]);
  mergeFrameDiagnostics(metrics, undefined);
  assert.equal(metrics.diagnostics.length, 1);
});

function boxScene(nodes) {
  return {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'box', type: 'box' }],
    materials: [{ id: 'red', color: [0.8, 0.2, 0.2] }],
    nodes: nodes.map(node => ({ geometry: 'box', material: 'red', ...node })),
    camera: { eye: [0, 3, 8], target: [0, 0.5, 0], fov: 45 },
  };
}

function placementOf(nodes) {
  return placementProblems({ boxes: createAgentScene(boxScene(nodes)).worldBounds() });
}

test('a box in the air is a floating part with its gap in metres and the nearest part', () => {
  const problems = placementOf([
    { id: 'floor', scale: [10, 0.2, 10], translation: [0, 0, 0] },
    { id: 'hover', translation: [0, 1.1, 0] },
  ]);
  assert.deepEqual(kinds(problems), ['floating-node']);
  assert.deepEqual(problems[0].nodes, ['hover']);
  assert.equal(problems[0].nearest, 'floor');
  assert.equal(problems[0].gapMeters, 0.5);
});

test('a box resting on the floor or on another box is not floating', () => {
  assert.deepEqual(placementOf([
    { id: 'floor', scale: [10, 0.2, 10], translation: [0, 0, 0] },
    { id: 'rest', translation: [0, 0.6, 0] },
    { id: 'stacked', scale: [0.5, 0.5, 0.5], translation: [0, 1.35, 0] },
  ]), []);
});

test('two boxes that overlap name both parts and how deep', () => {
  const problems = placementOf([
    { id: 'floor', scale: [10, 0.2, 10], translation: [0, 0, 0] },
    { id: 'first', translation: [-0.4, 0.6, 0] },
    { id: 'second', translation: [0.4, 0.6, 0] },
  ]);
  assert.deepEqual(kinds(problems), ['intersecting-nodes']);
  assert.deepEqual(problems[0].nodes, ['first', 'second']);
  assert.equal(problems[0].penetrationMeters, 0.2);
});

test('a box behind the camera is named as outside the frame while the rest stays in view', () => {
  const scene = createAgentScene(boxScene([
    { id: 'seen', translation: [0, 0, 0] },
    { id: 'also-seen', translation: [1, 0, 0] },
    { id: 'behind', translation: [0, 0, 20] },
  ]));
  const problems = framingProblems({ camera: scene.camera, aspect: 1.5, boxes: scene.worldBounds() });
  assert.deepEqual(kinds(problems), ['part-outside-frame']);
  assert.deepEqual(problems[0].nodes, ['behind']);
  assert.equal(problems[0].outsideCount, 1);
  assert.equal(problems[0].partCount, 3);
});

test('placement findings are capped and say how many were left out', () => {
  const nodes = Array.from({ length: 12 }, (_, index) => ({ id: `hover-${index}`, translation: [index * 3, 1 + index, 0] }));
  const problems = placementOf([{ id: 'floor', scale: [60, 0.2, 10], translation: [15, 0, 0] }, ...nodes]);
  assert.equal(problems.length, 8);
  assert.equal(problems[0].droppedCount, 4);
});

test('parts resting inside a large terrain box do not intersect it, but a real clash beside them does', () => {
  const trees = Array.from({ length: 10 }, (_, index) => ({ id: `tree-${index}`, scale: [0.5, 2, 0.5], translation: [index * 4 - 18, 3.9, 0] }));
  const terrain = { id: 'terrain', scale: [100, 4, 100], translation: [0, 2, 0] };
  assert.deepEqual(placementOf([terrain, ...trees]), []);
  const clash = placementOf([
    terrain, ...trees,
    { id: 'crate-a', translation: [30, 4.5, 0] },
    { id: 'crate-b', translation: [30.4, 4.5, 0] },
  ]);
  assert.deepEqual(kinds(clash), ['intersecting-nodes']);
  assert.deepEqual(clash[0].nodes, ['crate-a', 'crate-b']);
});

test('a cup half inside a table still intersects it', () => {
  const problems = placementOf([
    { id: 'table', scale: [2, 0.1, 2], translation: [0, 1, 0] },
    { id: 'cup', scale: [0.2, 0.3, 0.2], translation: [0, 1.1, 0] },
  ]);
  assert.deepEqual(kinds(problems), ['intersecting-nodes']);
});

test('parts outside the frame are left out of per-frame job checks and repeats collapse in job metrics', () => {
  const scene = createAgentScene(boxScene([{ id: 'a', translation: [0, 0, 0] }, { id: 'b', translation: [1, 0, 0] }, { id: 'c', translation: [-1, 0, 0] }, { id: 'd', translation: [0, 0, 0.5] }]));
  const boxes = scene.worldBounds();
  const metrics = {};
  for (let frame = 0; frame < 6; frame++) {
    const camera = { ...scene.camera, eye: [frame * 0.8, 3, 8], target: [frame * 0.8, 0.5, 0] };
    const jobFrame = framingProblems({ camera, aspect: 1.5, boxes, reportPartsOutside: false });
    assert.equal(jobFrame.filter(problem => problem.kind === 'part-outside-frame').length, 0);
    mergeFrameDiagnostics(metrics, framingProblems({ camera, aspect: 1.5, boxes }));
  }
  assert.ok((metrics.diagnostics ?? []).filter(problem => problem.kind === 'part-outside-frame').length <= 1);
  mergeFrameDiagnostics(metrics, [{ kind: 'subject-out-of-frame', target: 'camera', message: 'x', outsideCount: 3 }]);
  mergeFrameDiagnostics(metrics, [{ kind: 'subject-out-of-frame', target: 'camera', message: 'y', outsideCount: 4 }]);
  assert.equal(metrics.diagnostics.filter(problem => problem.kind === 'subject-out-of-frame').length, 1);
});

test('a blown-out frame reports how much is clipped', () => {
  const [finding] = exposureProblems({ shares: lumaShares(frameOf(255)), exposure: 1 });
  assert.equal(finding.kind, 'exposure-clipped');
  assert.equal(finding.whitePercent, 100);
  const [black] = exposureProblems({ shares: lumaShares(frameOf(0)), exposure: 1 });
  assert.equal(black.blackPercent, 100);
});

test('a clipped frame names the strongest lights and the field to lower', () => {
  const environment = { keyIntensity: 40, pointLights: [{ intensity: 3 }, { intensity: 12 }], spotLights: [{ intensity: 5 }] };
  const [finding] = exposureProblems({ shares: lumaShares(frameOf(255)), exposure: 1, environment });
  assert.deepEqual(finding.lights, [
    { field: 'environment.keyIntensity', intensity: 40 },
    { field: 'environment.pointLights[1].intensity', intensity: 12 },
    { field: 'environment.spotLights[0].intensity', intensity: 5 },
  ]);
  assert.match(finding.fix, /effects\.exposure from 1 to 0\.5, or lower the strongest light, environment\.keyIntensity \(now 40\)/);
  const lampFirst = exposureProblems({ shares: lumaShares(frameOf(255)), exposure: 1, environment: { keyIntensity: 1, areaLights: [{ intensity: 90 }] } })[0];
  assert.match(lampFirst.fix, /environment\.areaLights\[0\]\.intensity \(now 90\)/);
});

test('a clipped frame without an environment keeps the plain fix and no lights field', () => {
  const [finding] = exposureProblems({ shares: lumaShares(frameOf(255)), exposure: 1 });
  assert.equal(finding.lights, undefined);
  assert.match(finding.fix, /or lower environment\.keyIntensity\./);
});

function partWith(name, material) {
  return { name, material };
}

const goodImage = { width: 2, height: 2, data: new Uint8ClampedArray(16) };

test('a material whose map has no image is a texture-missing finding that names the parts and the field', () => {
  const broken = { id: 'brick', map: { colorSpace: 'srgb' } };
  const problems = textureProblems({ parts: [partWith('wall', broken), partWith('floor', broken), partWith('lamp', { id: 'steel' })] });
  assert.equal(problems.length, 1);
  const [problem] = problems;
  assert.equal(problem.kind, 'texture-missing');
  assert.deepEqual(problem.nodes, ['wall', 'floor']);
  assert.equal(problem.field, 'map');
  assert.equal(problem.material, 'brick');
  assert.match(problem.message, /2 parts use material brick whose map has no image/);
  assert.match(problem.fix, /set-material/);
});

test('empty and truncated texture images are reported and a good image is not', () => {
  const parts = [
    partWith('a', { id: 'm1', normalMap: { image: { width: 0, height: 0 } } }),
    partWith('b', { id: 'm2', map: { image: { width: 4, height: 4, data: new Uint8ClampedArray(8) } } }),
    partWith('c', { id: 'm3', map: { image: goodImage }, emissiveMap: { image: { width: 4, height: 4, compressed: { name: 'bc7' } } } }),
  ];
  const problems = textureProblems({ parts });
  assert.deepEqual(problems.map(problem => [problem.target, problem.field]), [['a', 'normalMap'], ['b', 'map']]);
  assert.match(problems[0].message, /image of no size/);
  assert.match(problems[1].message, /fewer pixel bytes/);
  assert.deepEqual(textureProblems({ parts: [partWith('ok', { id: 'm', map: { image: goodImage } })] }), []);
});

test('texture findings are capped at 8 per scene', () => {
  const parts = Array.from({ length: 12 }, (unused, index) => partWith(`p${index}`, { id: `m${index}`, map: {} }));
  assert.equal(textureProblems({ parts }).length, 8);
});

test('a path traced job says why exposure findings and passes are unavailable', () => {
  const limit = pathTracerFindingsLimit();
  assert.equal(limit.kind, 'findings-unavailable');
  assert.equal(limit.severity, 'info');
  assert.match(limit.message, /object ID, depth and normal/);
  assert.match(limit.fix, /scene_look/);
});

test('a scene reports the z-fighting its ranking left over, and none when it opted out', async () => {
  const { loadAgentSceneModules } = await import('../src/agent-scene-modules.js');
  await loadAgentSceneModules({ environment: { resolveCoplanar: 'offset' } });
  const scene = createAgentScene({ ...sceneWithCamera({ eye: [3, 2, 4], target: [0, 0, 0], fov: 45 }), environment: { resolveCoplanar: false } });
  assert.deepEqual(scene.flushLeftovers(), []);
});

test('the findings-unavailable note survives 20 part findings when it is merged first', () => {
  const partFindings = Array.from({ length: 20 }, (unused, index) => ({ kind: 'floating-node', severity: 'warning', target: `part${index}`, message: `part${index} floats` }));
  const metrics = {};
  mergeFrameDiagnostics(metrics, [pathTracerFindingsLimit(), ...partFindings]);
  assert.equal(metrics.diagnostics.length, 16);
  assert.equal(metrics.diagnostics[0].kind, 'findings-unavailable');
  const droppedWhenLast = {};
  mergeFrameDiagnostics(droppedWhenLast, [...partFindings, pathTracerFindingsLimit()]);
  assert.equal(droppedWhenLast.diagnostics.some(entry => entry.kind === 'findings-unavailable'), false);
});
