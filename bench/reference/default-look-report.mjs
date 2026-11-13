// The default look report (issue #988): the FLIP scores of each variant against Cycles, who beats the 67js defaults, and the JSON shape written to
// bench/reference/default-look.json. No browser and no Blender in here, so tests/default-look-report.test.js runs it as it is.
import { BASELINE_VARIANT, CHALLENGER_VARIANTS } from './default-look-variants.js';

// A challenger has to beat the baseline by more than this FLIP difference to count as a win on a scene.
export const WIN_MARGIN = 0.001;
export const WINS_NEEDED = 3;

export function winningScenes(scores, challenger, baseline = BASELINE_VARIANT, margin = WIN_MARGIN) {
  return Object.entries(scores)
    .filter(([, sceneScores]) => sceneScores[challenger] !== undefined && sceneScores[baseline] - sceneScores[challenger] > margin)
    .map(([sceneId]) => sceneId);
}

// The challengers that beat the baseline on at least `winsNeeded` scenes, with the scenes they win.
export function proposeDefaultChanges(scores, { challengers = CHALLENGER_VARIANTS, baseline = BASELINE_VARIANT, winsNeeded = WINS_NEEDED } = {}) {
  return challengers
    .map(challenger => ({ challenger, wins: winningScenes(scores, challenger, baseline) }))
    .filter(({ wins }) => wins.length >= winsNeeded);
}

export function meanScore(scores, variant) {
  const values = Object.values(scores).map(sceneScores => sceneScores[variant]).filter(value => typeof value === 'number');
  return values.length === 0 ? null : Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(4));
}

export function buildReport({ scores, settings, variants, generatedBy }) {
  const sceneIds = Object.keys(scores);
  const variantNames = Object.keys(variants);
  const means = Object.fromEntries([...variantNames, 'eevee'].map(name => [name, meanScore(scores, name)]).filter(([, value]) => value !== null));
  return {
    issue: 988,
    generatedBy,
    settings,
    variants: Object.fromEntries(Object.entries(variants).map(([name, variant]) => [name, variant.label])),
    scores,
    means,
    images: Object.fromEntries(sceneIds.map(sceneId => [sceneId, { cycles: `default-look/${sceneId}-cycles.png`, sheet: `default-look/${sceneId}-sheet.jpg` }])),
    proposals: proposeDefaultChanges(scores),
    note: 'Lower FLIP is closer to Cycles. A proposal needs a win on at least three scenes and is only a proposal: no default changes in this report.',
  };
}

export function scoreTable(report) {
  const variantNames = Object.keys(report.variants);
  const columns = [...(Object.values(report.scores).some(sceneScores => sceneScores.eevee !== undefined) ? ['eevee'] : []), ...variantNames];
  const header = `| scene | ${columns.join(' | ')} |`;
  const divider = `| --- |${columns.map(() => ' ---: |').join('')}`;
  const rows = Object.entries(report.scores).map(([sceneId, sceneScores]) => `| ${sceneId} | ${columns.map(name => sceneScores[name]?.toFixed(4) ?? '-').join(' | ')} |`);
  const meanRow = `| mean | ${columns.map(name => report.means[name]?.toFixed(4) ?? '-').join(' | ')} |`;
  return [header, divider, ...rows, meanRow].join('\n');
}
