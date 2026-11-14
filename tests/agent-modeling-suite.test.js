import assert from 'node:assert/strict';
import test from 'node:test';
import { gradeRecipe } from '../bench/agent-modeling/check.mjs';
import { TASKS, taskById, taskPrompt } from '../bench/agent-modeling/tasks.mjs';
import { REFERENCES } from '../bench/agent-modeling/references.mjs';
import { GALLERY_LIGHT_POSITIONS } from '../bench/agent-modeling/gallery.mjs';
import { COLONNADE_BEST_PLACE, COLONNADE_LIGHT_POSITIONS } from '../bench/agent-modeling/colonnade.mjs';
import { DUSK_GRADES } from '../bench/agent-modeling/dusk.mjs';
import { EASING_PLAIN_SOLUTION } from '../bench/agent-modeling/easing.mjs';
import { binomialP } from '../bench/agent-modeling/default-judge.mjs';
import { countFixRounds, isMcpRender, isMcpWrite } from '../bench/agent-modeling/fix-rounds.mjs';
import { judgePairs, pairwiseTable, planPairs, runPairwise, summarizePairing } from '../bench/agent-modeling/pairwise-judge.mjs';
import { readTranscript as readThreejsTranscript } from '../bench/agent-modeling/threejs.mjs';

test('the look pick passes the golden grade and fails the dim, the pale and a moved scene', async () => {
  const task = taskById('look-pick');
  const golden = await gradeRecipe(task, structuredClone(REFERENCES['look-pick']));
  assert.deepEqual(failedKinds(golden), [], failedDetails(golden));

  for (const [name, reason] of [['dusk', /too dim/], ['airy', /too pale/]]) {
    const wrongGrade = structuredClone(REFERENCES['look-pick']);
    wrongGrade.effects = { ...DUSK_GRADES[name] };
    const grade = await gradeRecipe(task, wrongGrade);
    assert.deepEqual(failedKinds(grade), ['renderedLook'], name);
    assert.match(grade.results.at(-1).detail, reason);
  }

  const brightLight = structuredClone(REFERENCES['look-pick']);
  brightLight.environment.keyIntensity = 6;
  assert.deepEqual(failedKinds(await gradeRecipe(task, brightLight)), ['renderedLook']);

  const movedLoaf = structuredClone(REFERENCES['look-pick']);
  movedLoaf.nodes.find(node => node.id === 'loaf').translation = [0.5, 0.82, -0.3];
  assert.ok(failedKinds(await gradeRecipe(task, movedLoaf)).includes('centreAt'));
});

const failedKinds = grade => grade.results.filter(result => !result.pass).map(result => result.label ?? result.kind);
const failedDetails = grade => JSON.stringify(grade.results.filter(result => !result.pass));

test('every task has a reference solution that passes all its checks', async () => {
  assert.deepEqual(Object.keys(REFERENCES).sort(), TASKS.map(task => task.id).sort());
  for (const task of TASKS) {
    const grade = await gradeRecipe(task, REFERENCES[task.id]);
    assert.equal(grade.pass, true, `${task.id}: ${JSON.stringify(grade.results.filter(result => !result.pass))}`);
  }
});

test('checks reject objects that miss the asked-for features', async () => {
  const plainCrate = structuredClone(REFERENCES.crate);
  plainCrate.geometries[0].edits = plainCrate.geometries[0].edits.slice(0, 6);
  assert.deepEqual(failedKinds(await gradeRecipe(taskById('crate'), plainCrate)).sort(),
    ['raised lid', 'recessed panel on +X', 'recessed panel on -Z', 'size', 'volume'].sort());

  const noUv = await gradeRecipe(taskById('crate-uv'), REFERENCES.crate);
  assert.deepEqual(failedKinds(noUv), ['uv']);

  const solidWindow = structuredClone(REFERENCES.window);
  solidWindow.geometries[0].holes = solidWindow.geometries[0].holes.slice(0, 2);
  assert.ok(failedKinds(await gradeRecipe(taskById('window'), solidWindow)).includes('four open panes'));

  const floatingTable = structuredClone(REFERENCES.table);
  floatingTable.nodes = floatingTable.nodes.map(node => ({ ...node, translation: [node.translation[0], node.translation[1] + 0.1, node.translation[2]] }));
  assert.ok(failedKinds(await gradeRecipe(taskById('table'), floatingTable)).includes('ground'));

  const elevenTeeth = structuredClone(REFERENCES.gear);
  elevenTeeth.geometries[0].contour = elevenTeeth.geometries[0].contour.slice(0, 55);
  assert.ok(failedKinds(await gradeRecipe(taskById('gear'), elevenTeeth)).includes('tips'));
});

function movedAlong(node, axis, amount) {
  const translation = [...node.translation];
  translation[axis] += amount;
  return { ...node, translation };
}

test('long tasks reject plausible wrong variants', async () => {
  const smoothPlate = structuredClone(REFERENCES['chamfer-plate']);
  smoothPlate.geometries[0].edits = smoothPlate.geometries[0].edits.filter(edit => edit.op !== 'bevel');
  assert.deepEqual(failedKinds(await gradeRecipe(taskById('chamfer-plate'), smoothPlate)), ['chamfered top edge']);

  const fivePockets = structuredClone(REFERENCES['chamfer-plate']);
  fivePockets.geometries[0].edits.pop();
  assert.ok(failedKinds(await gradeRecipe(taskById('chamfer-plate'), fivePockets)).includes('plate outline and six pockets'));

  const squareRail = structuredClone(REFERENCES['slotted-rail']);
  squareRail.geometries[0].edits = squareRail.geometries[0].edits.filter(edit => edit.op !== 'bevel');
  assert.deepEqual(failedKinds(await gradeRecipe(taskById('slotted-rail'), squareRail)), ['chamfered end edges']);

  const fourSlots = structuredClone(REFERENCES['slotted-rail']);
  fourSlots.geometries[0].edits.pop();
  const fourSlotFailures = failedKinds(await gradeRecipe(taskById('slotted-rail'), fourSlots));
  assert.ok(fourSlotFailures.includes('holes') && fourSlotFailures.includes('bar outline and five slots'));

  const unchangedCrate = failedKinds(await gradeRecipe(taskById('crate-revision'), REFERENCES.crate));
  assert.ok(unchangedCrate.includes('size') && unchangedCrate.includes('raised lid with the hole'));

  const throughHoleCrate = structuredClone(REFERENCES['crate-revision']);
  throughHoleCrate.geometries[0].edits.at(-1).scale = [0.03, 0.6, 0.03];
  assert.ok(failedKinds(await gradeRecipe(taskById('crate-revision'), throughHoleCrate)).includes('hole stops at 0.5 m'));

  const oldBracket = failedKinds(await gradeRecipe(taskById('bracket-revision'), REFERENCES.bracket));
  assert.ok(oldBracket.includes('size') && oldBracket.includes('holes'));

  const lopsidedWorkshop = structuredClone(REFERENCES.workshop);
  lopsidedWorkshop.nodes = lopsidedWorkshop.nodes.filter(node => node.id !== 'chair-leg-3').map(node => (node.id === 'mug' ? movedAlong(node, 1, 0.2) : node));
  const workshopFailures = failedKinds(await gradeRecipe(taskById('workshop'), lopsidedWorkshop));
  assert.ok(workshopFailures.includes('four table legs and four chair legs') && workshopFailures.includes('mug on the table'));
});

test('the robot shot needs both hands on target and a side-on camera', async () => {
  const task = taskById('robot-shot');
  const oneHand = structuredClone(REFERENCES['robot-shot']);
  oneHand.motion.ik.pop();
  assert.deepEqual(failedKinds(await gradeRecipe(task, oneHand)), ['assetReach']);

  const defaultFraming = structuredClone(REFERENCES['robot-shot']);
  defaultFraming.camera.eye = [4, 5, 6];
  assert.deepEqual(failedKinds(await gradeRecipe(task, defaultFraming)), ['shot']);

  const noCamera = structuredClone(REFERENCES['robot-shot']);
  delete noCamera.camera;
  assert.deepEqual(failedKinds(await gradeRecipe(task, noCamera)), ['shot']);
});

test('the walk and wave check needs both clips, the legs walking and only the right arm waving', async () => {
  const task = taskById('robot-walk-wave');
  const noWave = structuredClone(REFERENCES['robot-walk-wave']);
  noWave.motion.layers.pop();
  assert.deepEqual(failedKinds(await gradeRecipe(task, noWave)), ['assetWalkAndWave']);

  const waveEverywhere = structuredClone(REFERENCES['robot-walk-wave']);
  delete waveEverywhere.motion.layers[1].mask;
  assert.deepEqual(failedKinds(await gradeRecipe(task, waveEverywhere)), ['assetWalkAndWave']);

  const wrongClip = structuredClone(REFERENCES['robot-walk-wave']);
  wrongClip.motion.layers[1].clip = 2;
  assert.deepEqual(failedKinds(await gradeRecipe(task, wrongClip)), ['assetWalkAndWave']);

  const waveOnLegs = structuredClone(REFERENCES['robot-walk-wave']);
  waveOnLegs.motion.layers[1].mask.joints = ['node-37', 'node-57'];
  assert.deepEqual(failedKinds(await gradeRecipe(task, waveOnLegs)), ['assetWalkAndWave']);

  const noMotion = structuredClone(REFERENCES['robot-walk-wave']);
  delete noMotion.motion;
  assert.deepEqual(failedKinds(await gradeRecipe(task, noMotion)), ['assetWalkAndWave']);
});

test('tasks that change an existing scene carry their starting recipe in the prompt', () => {
  for (const id of ['crate-revision', 'bracket-revision']) {
    const task = taskById(id);
    assert.ok(taskPrompt(task).includes(JSON.stringify(task.startRecipe)), id);
    assert.doesNotMatch(taskPrompt(task), /\n/);
  }
  assert.equal(taskPrompt(taskById('bolt')).includes('scene_create with exactly'), false);
});

test('the pillar court check rejects a grid with a wrong count or spacing', async () => {
  const fourByThree = structuredClone(REFERENCES['pillar-court']);
  fourByThree.nodes[0].instances.grid.counts = [4, 1, 3];
  const missingColumn = failedKinds(await gradeRecipe(taskById('pillar-court'), fourByThree));
  assert.ok(missingColumn.includes('fifteen pillars'), missingColumn.join(', '));
  assert.ok(missingColumn.includes('size'));

  const tooTight = structuredClone(REFERENCES['pillar-court']);
  tooTight.nodes[0].instances.grid.spacing = [3, 1, 5];
  assert.ok(failedKinds(await gradeRecipe(taskById('pillar-court'), tooTight)).includes('size'));
});

test('an invalid recipe fails every check with the reason', async () => {
  const grade = await gradeRecipe(taskById('bolt'), { format: 'crucible.scene', schemaVersion: 1, geometries: [], materials: [], nodes: [{ id: 'x', geometry: 'missing' }] });
  assert.equal(grade.passed, 0);
  assert.match(grade.results[0].detail, /recipe failed/);
});

test('the tray-drop checks reject a box collider, a missing section and a body that falls through', async () => {
  const boxCollider = structuredClone(REFERENCES['tray-drop']);
  boxCollider.physics.bodies[0].shape = 'box';
  assert.deepEqual(failedKinds(await gradeRecipe(taskById('tray-drop'), boxCollider)), ['tray is a fixed trimesh', 'balls rest on the pocket floor']);

  const noPhysics = structuredClone(REFERENCES['tray-drop']);
  delete noPhysics.physics;
  assert.deepEqual(failedKinds(await gradeRecipe(taskById('tray-drop'), noPhysics)), ['tray is a fixed trimesh', 'balls rest on the pocket floor', 'seek back repeats the frame']);

  const fallingThrough = structuredClone(REFERENCES['tray-drop']);
  fallingThrough.physics.bodies[0].collidesWith = [1];
  assert.deepEqual(failedKinds(await gradeRecipe(taskById('tray-drop'), fallingThrough)), ['balls rest on the pocket floor']);
});

test('the terrain walk needs the opening, the hills and a walk that goes around the opening', async () => {
  const task = taskById('terrain-hole-walk');
  const closedGround = structuredClone(REFERENCES['terrain-hole-walk']);
  delete closedGround.geometries[0].holes;
  assert.deepEqual(failedKinds(await gradeRecipe(task, closedGround)), ['through']);

  const flatGround = structuredClone(REFERENCES['terrain-hole-walk']);
  flatGround.geometries[0].amplitude = 0;
  assert.deepEqual(failedKinds(await gradeRecipe(task, flatGround)), ['groundRelief']);

  const straightWalk = structuredClone(REFERENCES['terrain-hole-walk']);
  straightWalk.motion.tracks[0].keyframes = [{ time: 0, value: [-15, 0.5, -15] }, { time: 10, value: [15, 0.5, 15] }];
  assert.deepEqual(failedKinds(await gradeRecipe(task, straightWalk)), ['walkPath']);

  const hoveringWalker = structuredClone(REFERENCES['terrain-hole-walk']);
  for (const keyframe of hoveringWalker.motion.tracks[0].keyframes) keyframe.value[1] = 4;
  assert.deepEqual(failedKinds(await gradeRecipe(task, hoveringWalker)), ['walkPath']);
});

test('the path walk passes its reference and fails a walk through the second opening or the rock', async () => {
  const task = taskById('terrain-path-walk');
  assert.deepEqual(failedKinds(await gradeRecipe(task, structuredClone(REFERENCES['terrain-path-walk']))), []);

  const throughSecondOpening = structuredClone(REFERENCES['terrain-path-walk']);
  throughSecondOpening.motion.tracks[0].keyframes = [{ time: 0, value: [-15, 0.5, -15] }, { time: 4, value: [-4, 0.5, -5] }, { time: 5.5, value: [5, 0.5, -5] }, { time: 10, value: [15, 0.5, 15] }];
  assert.deepEqual(failedKinds(await gradeRecipe(task, throughSecondOpening)), ['walkPath']);

  const throughRock = structuredClone(REFERENCES['terrain-path-walk']);
  throughRock.motion.tracks[0].keyframes = [{ time: 0, value: [-15, 0.5, -15] }, { time: 2, value: [-8, 0.5, -8] }, { time: 3, value: [-6, 0.5, -3] }, { time: 5.5, value: [5, 0.5, -5] }, { time: 7, value: [5, 0.5, 13] }, { time: 10, value: [15, 0.5, 15] }];
  assert.deepEqual(failedKinds(await gradeRecipe(task, throughRock)), ['walkPath']);
});

test('the render pick passes the unshadowed light and fails the two shadowed places and shortcuts', async () => {
  const task = taskById('render-pick');
  assert.deepEqual(failedKinds(await gradeRecipe(task, structuredClone(REFERENCES['render-pick']))), []);

  for (const place of GALLERY_LIGHT_POSITIONS.slice(0, 2)) {
    const shadowed = structuredClone(REFERENCES['render-pick']);
    const [light] = shadowed.environment.spotLights;
    light.position = place;
    const toCentre = [0 - place[0], 1.5 - place[1], -1.96 - place[2]];
    const length = Math.hypot(...toCentre);
    light.direction = toCentre.map(value => value / length);
    const grade = await gradeRecipe(task, shadowed);
    assert.deepEqual(failedKinds(grade), ['litPainting']);
    assert.match(grade.results.at(-1).detail, /in shadow/);
  }

  const shadowsOff = structuredClone(REFERENCES['render-pick']);
  shadowsOff.environment.spotLights[0].castShadow = false;
  assert.deepEqual(failedKinds(await gradeRecipe(task, shadowsOff)), ['litPainting']);

  const offeredPlaceMissed = structuredClone(REFERENCES['render-pick']);
  offeredPlaceMissed.environment.spotLights[0].position = [2.5, 2.4, 1.5];
  assert.deepEqual(failedKinds(await gradeRecipe(task, offeredPlaceMissed)), ['litPainting']);

  const twoLights = structuredClone(REFERENCES['render-pick']);
  twoLights.environment.spotLights.push(structuredClone(twoLights.environment.spotLights[0]));
  assert.deepEqual(failedKinds(await gradeRecipe(task, twoLights)), ['litPainting']);

  const movedPillar = structuredClone(REFERENCES['render-pick']);
  movedPillar.nodes.find(node => node.id === 'pillar').translation = [3, 1.3, -0.5];
  assert.ok(failedKinds(await gradeRecipe(task, movedPillar)).includes('centreAt'));
});

test('the hard light pick passes the least shadowed place and fails every other place and shortcut', async () => {
  const task = taskById('light-pick-hard');
  assert.deepEqual(failedKinds(await gradeRecipe(task, structuredClone(REFERENCES['light-pick-hard']))), []);

  for (const [index, place] of COLONNADE_LIGHT_POSITIONS.entries()) {
    if (index === COLONNADE_BEST_PLACE) continue;
    const wrongPlace = structuredClone(REFERENCES['light-pick-hard']);
    const [light] = wrongPlace.environment.spotLights;
    light.position = place;
    const toCentre = [0 - place[0], 1.5 - place[1], -1.98 - place[2]];
    const length = Math.hypot(...toCentre);
    light.direction = toCentre.map(value => value / length);
    const grade = await gradeRecipe(task, wrongPlace);
    assert.deepEqual(failedKinds(grade), ['litPainting'], `place ${index + 1}`);
    assert.match(grade.results.at(-1).detail, /shades \d+ of 861 points/);
  }

  const shadowsOff = structuredClone(REFERENCES['light-pick-hard']);
  shadowsOff.environment.spotLights[0].castShadow = false;
  assert.deepEqual(failedKinds(await gradeRecipe(task, shadowsOff)), ['litPainting']);

  const offeredPlaceMissed = structuredClone(REFERENCES['light-pick-hard']);
  offeredPlaceMissed.environment.spotLights[0].position = [1.7, 2.6, 1.5];
  assert.deepEqual(failedKinds(await gradeRecipe(task, offeredPlaceMissed)), ['litPainting']);

  const twoLights = structuredClone(REFERENCES['light-pick-hard']);
  twoLights.environment.spotLights.push(structuredClone(twoLights.environment.spotLights[0]));
  assert.deepEqual(failedKinds(await gradeRecipe(task, twoLights)), ['litPainting']);

  const movedPost = structuredClone(REFERENCES['light-pick-hard']);
  movedPost.nodes.find(node => node.id === 'post-3').translation[0] = 3;
  assert.ok(failedKinds(await gradeRecipe(task, movedPost)).includes('centreAt'));
});

test('the overshoot lift passes with one named easing or with hand-placed keyframes, and fails without an overshoot', async () => {
  const task = taskById('overshoot-lift');
  assert.deepEqual(failedKinds(await gradeRecipe(task, structuredClone(REFERENCES['overshoot-lift']))), []);
  assert.deepEqual(failedKinds(await gradeRecipe(task, structuredClone(EASING_PLAIN_SOLUTION))), []);
  const keyframeCount = recipe => recipe.motion.tracks[0].keyframes.length;
  assert.ok(keyframeCount(REFERENCES['overshoot-lift']) < keyframeCount(EASING_PLAIN_SOLUTION));

  const noOvershoot = structuredClone(REFERENCES['overshoot-lift']);
  delete noOvershoot.motion.tracks[0].keyframes[0].easing;
  assert.deepEqual(failedKinds(await gradeRecipe(task, noOvershoot)), ['overshoot']);
});

test('the plain overshoot task forbids easings in its prompt and grades the hand-placed keyframes', async () => {
  const task = taskById('overshoot-lift-plain');
  assert.match(task.prompt, /do not use the easing field/);
  assert.deepEqual(failedKinds(await gradeRecipe(task, structuredClone(REFERENCES['overshoot-lift-plain']))), []);
});

const PAIRWISE_SIDES = {
  a: { label: 'Crucible MCP', pattern: 'renders/mcp/{attempt}/{task}.png' },
  b: { label: 'three.js by code', pattern: 'renders/code/{task}-{attempt}.png' },
};

test('the pairwise order is a function of the seed, and repeats of one task swap sides', () => {
  const tasks = ['crate', 'bolt', 'table'];
  const plan = seed => planPairs({ tasks, attempts: 3, seed, sides: PAIRWISE_SIDES }).map(pair => `${pair.task}${pair.attempt}${pair.firstSide}`);
  assert.deepEqual(plan(53), plan(53));
  assert.notDeepEqual(plan(53), plan(54));
  const pairs = planPairs({ tasks, attempts: 3, seed: 53, sides: PAIRWISE_SIDES });
  for (const pair of pairs.filter(candidate => candidate.attempt === 2)) {
    const first = pairs.find(candidate => candidate.task === pair.task && candidate.attempt === 1);
    assert.notEqual(pair.firstSide, first.firstSide, 'attempt 2 shows the other side first');
  }
  const crate = pairs[0];
  assert.equal(crate.firstLabel, PAIRWISE_SIDES[crate.firstSide].label);
  assert.match(crate.firstImage.replaceAll('\\', '/'), crate.firstSide === 'a' ? /renders\/mcp\/1\/crate\.png$/ : /renders\/code\/crate-1\.png$/);
});

test('the pairwise win count follows a fixed set of answers and its exact p', async () => {
  const tasks = ['crate', 'bolt', 'table', 'fence', 'window', 'bracket'];
  const pairs = planPairs({ tasks, attempts: 1, seed: 53, sides: PAIRWISE_SIDES });
  // The stub always names side B's image, wherever it sits, except for the last task, which it gives to side A.
  const ask = async pair => {
    const wantedSide = pair.task === 'bracket' ? 'a' : 'b';
    return { answer: pair.firstSide === wantedSide ? 'first' : 'second', costUsd: 0.01 };
  };
  const records = await judgePairs({ pairs, ask });
  const summary = summarizePairing({ records, labels: { a: 'Crucible MCP', b: 'three.js by code' }, control: false });
  assert.deepEqual(summary.wins, { 'Crucible MCP': 1, 'three.js by code': 5 });
  assert.equal(summary.trials, 6);
  assert.ok(Math.abs(summary.pValue - 0.21875) < 1e-9, 'two-sided p of 5 of 6 is 14/64');
  assert.equal(summary.costUsd, 0.06);
  const undecided = await judgePairs({ pairs: pairs.slice(0, 2), ask: async () => ({ answer: null }) });
  assert.equal(summarizePairing({ records: undecided, labels: { a: 'a', b: 'b' }, control: false }).trials, 0);
});

test('the binomial p matches known values', () => {
  assert.equal(binomialP(0, 0), 1);
  assert.equal(binomialP(9, 18), 1);
  assert.ok(Math.abs(binomialP(18, 18) - 2 * 0.5 ** 18) < 1e-12);
  assert.ok(Math.abs(binomialP(0, 10) - 2 / 1024) < 1e-12);
  assert.ok(Math.abs(binomialP(13, 18) - 0.096) < 0.001, '13 of 18 is not significant');
});

test('the control pairs one render with itself and reports position bias', async () => {
  const pairs = planPairs({ tasks: ['crate', 'bolt', 'table', 'chair'], attempts: 2, seed: 53, sides: PAIRWISE_SIDES, control: true });
  assert.equal(pairs.length, 8);
  for (const pair of pairs) {
    assert.equal(pair.firstImage, pair.secondImage, 'identical input on both sides');
    assert.equal(pair.firstLabel, 'Crucible MCP');
    assert.equal(pair.secondLabel, 'Crucible MCP');
  }
  const records = await judgePairs({ pairs, ask: async () => ({ answer: 'first' }) });
  const summary = summarizePairing({ records, labels: { a: 'Crucible MCP', b: 'three.js by code' }, control: true });
  assert.equal(summary.pickedFirst, 8);
  assert.equal(summary.pickedSecond, 0);
  assert.ok(summary.pBias < 0.01, 'always picking first is position bias');
});

test('runPairwise calls the judge once per pair and once per control pair, with no model', async () => {
  let calls = 0;
  const result = await runPairwise({ ask: async () => { calls++; return { answer: calls % 2 ? 'first' : 'second' }; }, tasks: ['crate', 'bolt'], attempts: 2, seed: 53, sides: PAIRWISE_SIDES });
  assert.equal(calls, 8);
  assert.equal(result.pairing.records.length, 4);
  assert.equal(result.control.records.length, 4);
  assert.match(pairwiseTable(result), /Exact p/);
  calls = 0;
  const controlOnly = await runPairwise({ ask: async () => { calls++; return { answer: 'first' }; }, tasks: ['crate'], attempts: 3, seed: 53, sides: PAIRWISE_SIDES, controlOnly: true });
  assert.equal(calls, 3);
  assert.equal(controlOnly.pairing, null);
});

test('fix rounds count the writes after the first render, in both systems', () => {
  const mcpSteps = ['scene_create', 'scene_apply', 'scene_look', 'scene_apply', 'scene_look', 'scene_apply', 'scene_export_recipe']
    .map(name => ({ name: `mcp__crucible__${name}` }));
  assert.equal(countFixRounds(mcpSteps, { isRender: isMcpRender, isWrite: isMcpWrite }), 2);
  assert.equal(countFixRounds(mcpSteps.slice(0, 2), { isRender: isMcpRender, isWrite: isMcpWrite }), 0, 'never rendered');

  const toolUse = (name, input) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: name, name, input }] } });
  const transcript = [
    toolUse('Write', { file_path: 'build.mjs' }),
    toolUse('Bash', { command: 'node build.mjs' }),
    toolUse('Edit', { file_path: 'build.mjs' }),
    toolUse('Bash', { command: 'node build.mjs' }),
    toolUse('Write', { file_path: 'build.mjs' }),
    toolUse('Bash', { command: 'node build.mjs' }),
  ].join('\n');
  const summary = readThreejsTranscript(transcript);
  assert.equal(summary.toolCalls, 6);
  assert.equal(summary.fixRounds, 2);
});

test('the findings-fix task fails its starting scene and each half-fix, and passes the reference', async () => {
  const task = taskById('findings-fix');
  const start = structuredClone(task.startRecipe);
  const startGrade = await gradeRecipe(task, start);
  assert.equal(startGrade.pass, false);
  assert.ok(startGrade.results.some(result => result.kind === 'restsOnSupport' && !result.pass));
  assert.ok(startGrade.results.some(result => result.kind === 'litRange' && !result.pass));

  const onlyLowered = structuredClone(start);
  onlyLowered.nodes.find(node => node.id === 'crate').translation = [1.6, 0.25, 0.4];
  const loweredGrade = await gradeRecipe(task, onlyLowered);
  assert.deepEqual(loweredGrade.results.filter(result => !result.pass).map(result => result.kind), ['litRange']);

  const onlyDimmed = structuredClone(start);
  onlyDimmed.environment.keyIntensity = 1;
  const dimmedGrade = await gradeRecipe(task, onlyDimmed);
  assert.deepEqual(dimmedGrade.results.filter(result => !result.pass).map(result => result.kind), ['restsOnSupport']);

  assert.equal((await gradeRecipe(task, structuredClone(REFERENCES['findings-fix']))).pass, true);
});
