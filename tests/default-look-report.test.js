import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { buildReport, meanScore, proposeDefaultChanges, scoreTable, winningScenes } from '../bench/reference/default-look-report.mjs';
import { DEFAULT_LOOK_VARIANTS } from '../bench/reference/default-look-variants.js';

const REFERENCE_DIRECTORY = new URL('../bench/reference/', import.meta.url);
const SCENES = ['shapes', 'corner', 'material-row', 'colonnade'];

function scoresWhere(challengerValues) {
  return Object.fromEntries(SCENES.map((sceneId, index) => [sceneId, { 'crucible-default': 0.1, 'crucible-ao': challengerValues[index], 'three-default': 0.2 }]));
}

test('a challenger wins the scenes where it is lower than the Crucible defaults by more than the margin', () => {
  const scores = scoresWhere([0.05, 0.1005, 0.2, 0.09]);
  assert.deepEqual(winningScenes(scores, 'crucible-ao'), ['shapes', 'colonnade']);
});

test('a default change is proposed only with a win on at least three scenes', () => {
  assert.deepEqual(proposeDefaultChanges(scoresWhere([0.05, 0.05, 0.2, 0.2])), []);
  const proposals = proposeDefaultChanges(scoresWhere([0.05, 0.05, 0.05, 0.2]));
  assert.deepEqual(proposals, [{ challenger: 'crucible-ao', wins: ['shapes', 'corner', 'material-row'] }]);
});

test('the mean skips scenes that have no score for the variant', () => {
  assert.equal(meanScore({ first: { a: 0.1 }, second: { a: 0.2 }, third: {} }, 'a'), 0.15);
  assert.equal(meanScore({ first: {} }, 'a'), null);
});

test('the report holds the scores, means, image paths and proposals', () => {
  const scores = scoresWhere([0.05, 0.05, 0.05, 0.05]);
  const report = buildReport({ scores, variants: DEFAULT_LOOK_VARIANTS, settings: { width: 640 }, generatedBy: 'test' });
  assert.equal(report.issue, 988);
  assert.deepEqual(Object.keys(report.images), SCENES);
  assert.equal(report.images.shapes.cycles, 'default-look/shapes-cycles.png');
  assert.equal(report.means['crucible-default'], 0.1);
  assert.equal(report.proposals.length, 1);
  assert.match(scoreTable(report), /^\| scene \| crucible-default \|/);
  assert.match(scoreTable(report), /\| mean \|/);
});

test('every variant says its engine, and a Crucible variant leaves the renderer defaults alone unless it names an option', () => {
  for (const [name, variant] of Object.entries(DEFAULT_LOOK_VARIANTS)) {
    assert.ok(['crucible', 'three'].includes(variant.engine), name);
    assert.ok(variant.label, name);
  }
  assert.deepEqual(DEFAULT_LOOK_VARIANTS['crucible-default'].rendererOptions, {});
  assert.equal(DEFAULT_LOOK_VARIANTS['crucible-default'].effects.ambientOcclusion, 0);
});

test('the committed default look report covers four scenes, both engines and a committed Cycles image for each', () => {
  const report = JSON.parse(readFileSync(new URL('default-look.json', REFERENCE_DIRECTORY), 'utf8'));
  assert.equal(Object.keys(report.scores).length >= 4, true);
  for (const [sceneId, sceneScores] of Object.entries(report.scores)) {
    for (const variantName of Object.keys(DEFAULT_LOOK_VARIANTS)) {
      assert.equal(typeof sceneScores[variantName], 'number', `${sceneId} ${variantName}`);
    }
    assert.ok(existsSync(new URL(report.images[sceneId].cycles, REFERENCE_DIRECTORY)), `${sceneId} Cycles reference`);
    assert.ok(existsSync(new URL(report.images[sceneId].sheet, REFERENCE_DIRECTORY)), `${sceneId} sheet`);
  }
});
