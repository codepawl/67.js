// Turns the results file of run-all.mjs (after score-tiers.py matrix) into the tier table, as Markdown and as an HTML snippet.
//   node bench/tiers/make-table.mjs <results.json> [--scenes lit-interior,...] [--markdown <file>] [--html <file>]
// One table per scene. Every figure is the median of the runs that were not contended, with the range beside it; a cell whose background
// utilisation was over the limit stays in the results file and is left out here. When every run of a figure was contended the figure is
// still printed, marked "contended". The Cook rows end with the equal-error statement, computed from the results.
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { median } from './idle-gate.mjs';

const argumentsGiven = process.argv.slice(2);
const valueAfter = (flag, fallback) => (argumentsGiven.includes(flag) ? argumentsGiven[argumentsGiven.indexOf(flag) + 1] : fallback);
const resultsPath = resolve(argumentsGiven[0] ?? (() => { throw new Error('Usage: make-table.mjs <results.json> [--scenes a,b] [--markdown file] [--html file]'); })());
const results = JSON.parse(await readFile(resultsPath, 'utf8'));
const sceneIds = valueAfter('--scenes', null)?.split(',') ?? results.scenes;
const markdownPath = resolve(valueAfter('--markdown', resultsPath.replace(/\.json$/, '.table.md')));
const htmlPath = resolve(valueAfter('--html', resultsPath.replace(/\.json$/, '.table.html')));

const COLUMNS = ['Tier', 'For', 'Runs on', 'Trade-off', 'Crucible measured', 'Blender equivalent measured', 'FLIP vs Cycles (lower is better)'];

// The cells of one engine on one scene: the usable ones, or all of them (flagged) when none is usable.
function group(scene, engine, samples = null) {
  const all = results.cells.filter(cell => cell.status === 'ok' && cell.scene === scene && cell.engine === engine && (samples === null || cell.samples === samples));
  const usable = all.filter(cell => !cell.contended);
  return { cells: usable.length ? usable : all, usable: usable.length, total: all.length, contendedOnly: usable.length === 0 && all.length > 0 };
}

function spread(values, digits = 1) {
  if (values.length === 0) return null;
  return { median: median(values), low: Math.min(...values), high: Math.max(...values), count: values.length, digits };
}

const number = (value, digits = 1) => value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
function show(figure, unit) {
  if (!figure) return 'not run';
  const range = figure.count > 1 ? ` (${number(figure.low, figure.digits)} to ${number(figure.high, figure.digits)})` : '';
  return `${number(figure.median, figure.digits)}${unit ? ` ${unit}` : ''}${range}`;
}
const flag = grouped => (grouped.contendedOnly ? ' contended' : '');
const runsNote = grouped => (grouped.total === 0 ? '' : `, ${grouped.usable} of ${grouped.total} runs usable${flag(grouped)}`);

function metric(grouped, name, digits = 1, scale = 1) {
  return spread(grouped.cells.map(cell => cell.metrics[name]).filter(value => typeof value === 'number').map(value => value * scale), digits);
}
function score(grouped, name = 'flip') {
  return spread(grouped.cells.map(cell => cell.score?.[name]).filter(value => typeof value === 'number'), 3);
}

function glazeText(grouped) {
  if (grouped.total === 0) return 'not run';
  const frame = metric(grouped, 'primaryMilliseconds', 2);
  const throughput = metric(grouped, 'throughputMilliseconds', 2);
  const first = metric(grouped, 'firstFrameMilliseconds', 1);
  return `${show(frame, 'ms a frame with the pixel read')}; ${show(throughput, 'ms a frame queued back to back')}; first frame ${show(first, 'ms')}${runsNote(grouped)}`;
}

function eeveeText(grouped) {
  if (grouped.total === 0) return 'not run';
  const call = metric(grouped, 'primaryMilliseconds', 0);
  const engine = metric(grouped, 'engineMilliseconds', 0);
  return `${show(call, 'ms a render call')}; Blender's own render time ${engine ? show(engine, 'ms') : 'not available'}${runsNote(grouped)}`;
}

function countedText(grouped) {
  if (grouped.total === 0) return 'not run';
  const perSample = metric(grouped, 'perSampleMilliseconds', 2);
  const total = metric(grouped, 'totalTraceSeconds', 2);
  return `${show(perSample, 'ms a sample')}; ${grouped.cells[0].samples} samples take ${show(total, 's')} with setup${runsNote(grouped)}`;
}

function flipText(parts) {
  return parts.filter(Boolean).join('; ') || 'not scored';
}

function glazeFlip(grouped, label) {
  if (grouped.total === 0) return null;
  const upscaled = score(grouped);
  const native = score(grouped, 'flipNative');
  if (!upscaled) return null;
  return `${label} ${show(upscaled, '')}${native ? ` enlarged, ${show(native, '')} at its own ${grouped.cells[0].score.nativeSize}` : ''}`;
}
function plainFlip(grouped, label) {
  const value = score(grouped);
  return value ? `${label} ${show(value, '')}` : null;
}

// Cook's relMSE is read as noise-limited only when it falls roughly as 1 over N between the two measured counts. A 1024 sample error above
// this share of the 256 sample error (1/N would give 0.25) means the error is held up by something that more samples do not remove: a bias.
const BIAS_LIMIT_RATIO = 0.4;
const REFERENCE_SAMPLES = 256;
const LONGER_SAMPLES = 1024;

function countedPoints(scene, engine) {
  const sampleCounts = [...new Set(results.cells.filter(cell => cell.scene === scene && cell.engine === engine && cell.status === 'ok').map(cell => cell.samples))];
  return sampleCounts.map(samples => {
    const grouped = group(scene, engine, samples);
    const relMse = score(grouped, 'relMse');
    const sampling = metric(grouped, 'samplingSeconds', 3);
    const total = metric(grouped, 'totalTraceSeconds', 3);
    return relMse && sampling && total ? { samples, relMse: relMse.median, samplingSeconds: sampling.median, totalSeconds: total.median } : null;
  }).filter(Boolean);
}

// How one engine's relMSE moves between 256 and 1024 samples. 1/N gives a ratio of 0.25.
function errorTrend(points) {
  const short = points.find(point => point.samples === REFERENCE_SAMPLES);
  const long = points.find(point => point.samples === LONGER_SAMPLES);
  if (!short || !long || !(short.relMse > 1e-9)) return null;
  const ratio = long.relMse / short.relMse;
  return { short: short.relMse, long: long.relMse, ratio, biasLimited: ratio > BIAS_LIMIT_RATIO };
}

// Samples at which an error that falls as 1 over N from the longer measured count reaches the target.
function samplesForError(longPoint, targetError) {
  return (longPoint.samples * longPoint.relMse) / targetError;
}

// The equal-error assessment of Cook native against Cycles on one scene. Three outcomes:
//   noise: both errors fall roughly as 1/N between 256 and 1024 samples, so the ratio is extrapolated from 1024 samples and printed.
//   native-bias: Cook native's error falls slower than 1/N, so no ratio is given.
//   target-floor: the Cycles 256 sample error itself falls slower than 1/N (a floor, not a noise level), so no ratio is given.
function equalErrorAssessment(scene) {
  const cycles = countedPoints(scene, 'cycles');
  const native = countedPoints(scene, 'cook-native');
  const cyclesTrend = errorTrend(cycles);
  const nativeTrend = errorTrend(native);
  if (!cyclesTrend || !nativeTrend) return null;
  const reference = cycles.find(point => point.samples === REFERENCE_SAMPLES);
  const longNative = native.find(point => point.samples === LONGER_SAMPLES);
  const assessment = { scene, cyclesTrend, nativeTrend, targetRelMse: reference.relMse, outcome: 'noise' };
  if (nativeTrend.biasLimited) return { ...assessment, outcome: 'native-bias' };
  if (cyclesTrend.biasLimited) return { ...assessment, outcome: 'target-floor' };
  const needed = samplesForError(longNative, reference.relMse);
  const perSampleNative = median(native.map(point => point.samplingSeconds / point.samples));
  const setupNative = median(native.map(point => point.totalSeconds - point.samplingSeconds));
  const perSampleCycles = reference.samplingSeconds / reference.samples;
  const samplingTime = needed * perSampleNative;
  const totalTime = samplingTime + setupNative;
  return {
    ...assessment, samplesNeeded: needed, sampleRatio: needed / reference.samples, perSampleSpeedup: perSampleCycles / perSampleNative,
    samplingSeconds: samplingTime, totalSeconds: totalTime, cyclesSamplingSeconds: reference.samplingSeconds,
    timeRatioSampling: samplingTime / reference.samplingSeconds, timeRatioTotal: totalTime / reference.totalSeconds,
  };
}

const relMseText = value => value.toExponential(2);

function equalErrorText(assessment) {
  if (!assessment) return null;
  const times = value => number(value, 2);
  const { cyclesTrend, nativeTrend } = assessment;
  const measured = `relMSE ${relMseText(nativeTrend.short)} at ${REFERENCE_SAMPLES} samples and ${relMseText(nativeTrend.long)} at ${LONGER_SAMPLES}, against Cycles' ${relMseText(cyclesTrend.short)} at ${REFERENCE_SAMPLES} and ${relMseText(cyclesTrend.long)} at ${LONGER_SAMPLES}`;
  if (assessment.outcome === 'native-bias') {
    return `Equal error: Cook native does not reach Cycles' ${REFERENCE_SAMPLES}-sample error by ${LONGER_SAMPLES} samples (error falls slower than 1/N, likely a bias): ${measured}. No ratio is given.`;
  }
  if (assessment.outcome === 'target-floor') {
    return `Equal error: Cook native does not reach Cycles' ${REFERENCE_SAMPLES}-sample error by ${LONGER_SAMPLES} samples, and Cycles' own error falls slower than 1/N here (a floor, not a noise level, likely a bias): ${measured}. No ratio is given.`;
  }
  return `Equal error: Cook native needs about ${number(assessment.sampleRatio, 1)} times the samples of Cycles (${number(Math.round(assessment.samplesNeeded), 0)} against ${REFERENCE_SAMPLES}, to reach relMSE ${relMseText(assessment.targetRelMse)}; extrapolated from ${LONGER_SAMPLES} samples as 1 over N, which both engines' measured errors support: ${measured}). It draws a sample ${times(assessment.perSampleSpeedup)} times faster, so the time to equal error is ${times(assessment.timeRatioSampling)} times Cycles' (sampling only) and ${times(assessment.timeRatioTotal)} times with setup included (${number(assessment.samplingSeconds, 1)} s against ${number(assessment.cyclesSamplingSeconds, 1)} s sampling).`;
}

// Cook webgpu runs the same kernel as native but at 256 samples only, so no equal-error figure is given: its per-sample speed against native,
// and how closely its 256-sample image matches the native one (score.versusNative, from score-tiers.py).
function webgpuAgreement(scene) {
  const native = group(scene, 'cook-native', REFERENCE_SAMPLES);
  const webgpu = group(scene, 'cook-webgpu', REFERENCE_SAMPLES);
  const nativePerSample = metric(native, 'perSampleMilliseconds', 2);
  const webgpuPerSample = metric(webgpu, 'perSampleMilliseconds', 2);
  const versus = values => spread(webgpu.cells.map(cell => cell.score?.versusNative?.[values]).filter(value => typeof value === 'number'), 4);
  if (!nativePerSample || !webgpuPerSample) return null;
  return { slowdown: webgpuPerSample.median / nativePerSample.median, relMse: versus('relMse'), flip: versus('flip') };
}

function webgpuText(agreement) {
  if (!agreement) return null;
  const similarity = agreement.relMse ? ` Its ${REFERENCE_SAMPLES}-sample image matches native's at equal samples (relMSE between the two images ${relMseText(agreement.relMse.median)}, FLIP ${number(agreement.flip.median, 4)}).` : '';
  return `Cook webgpu (measured at ${REFERENCE_SAMPLES} samples only) draws a sample ${number(agreement.slowdown, 1)} times slower than native.${similarity} It runs the same kernel, so no separate equal-error figure is given.`;
}

function rowsForScene(scene) {
  const draftGlaze = group(scene, 'glaze-draft');
  const draftEevee = group(scene, 'eevee-lowest');
  const realtimeGlaze = group(scene, 'glaze-realtime');
  const realtimeEevee = group(scene, 'eevee-default');
  const native = group(scene, 'cook-native');
  const cyclesAt = group(scene, 'cycles', REFERENCE_SAMPLES);
  const nativeAt = group(scene, 'cook-native', REFERENCE_SAMPLES);
  const rows = [
    ['draft (planned name)', 'A quick look while editing', 'Glaze, 0.5 render scale, 1 sample, light shading, 8 bit target, coarser level of detail', 'Aliased edges, no environment lookup, a quarter of the pixels enlarged', glazeText(draftGlaze), eeveeText(draftEevee),
      flipText([glazeFlip(draftGlaze, 'Glaze'), plainFlip(draftEevee, 'EEVEE 1 sample')])],
    ['realtime', 'Interactive use', 'Glaze, default settings', 'No path-traced global illumination: indirect light is approximate', glazeText(realtimeGlaze), eeveeText(realtimeEevee),
      flipText([glazeFlip(realtimeGlaze, 'Glaze'), plainFlip(realtimeEevee, 'EEVEE 64 samples')])],
    ['realtime-high', 'Interactive, higher quality', 'Planned (#902), not measurable yet', 'none', 'none', 'none', 'none'],
    ['final', 'Offline images', 'Cook native (Vulkan ray queries)', 'Error against samples is in the equal-error note below', countedText(nativeAt), `Cycles: ${countedText(cyclesAt)}`,
      flipText([plainFlip(nativeAt, 'Cook native'), plainFlip(cyclesAt, 'Cycles')])],
  ];
  for (const [engine, label] of [['cook-webgpu', 'Cook webgpu (WGSL compute, software BVH)'], ['cook-gpu', 'Cook gpu (WebGL2)'], ['cook-cpu', 'Cook cpu (JavaScript threads)']]) {
    const grouped = group(scene, engine);
    if (grouped.total === 0) continue;
    rows.push(['final', 'Offline images', label, 'Slower per sample than native', countedText(grouped), 'same Cycles', flipText([plainFlip(grouped, label.split(' (')[0])])]);
  }
  return rows;
}

function conditionsText() {
  const { conditions, gate } = results;
  const cells = results.cells;
  const contended = cells.filter(cell => cell.contended).length;
  const repetitionCount = Math.max(0, ...cells.map(cell => cell.repetition));
  return `${conditions.card ?? 'card unknown'}; ${conditions.blender ?? 'Blender unknown'}; Node ${conditions.node ?? '?'}; Chrome headless on D3D11 (ANGLE); ${results.width} by ${results.height}; measured ${conditions.date ?? 'date unknown'} on scenes ${sceneIds.join(', ')}. Idle gate: wait for at most ${gate?.thresholdPercent}% utilisation on ${gate?.consecutivePolls} polls in a row (max wait ${gate?.maxWaitSeconds} s${gate?.reportOnly ? ', REPORT ONLY: the gate did not wait' : ''}); a run whose utilisation in the 3 s before it was over ${gate?.contendedAbovePercent}% is contended and left out of medians. ${contended} of ${cells.length} runs were contended. Medians with ranges over up to ${repetitionCount} repetitions, engines interleaved in a rotating order. Reference: Cycles at ${results.referenceSamples} samples. Time columns: Glaze is a frame with a pixel read (and queued back to back); EEVEE is the whole render call including scene sync, Blender's own render time beside it; Cook and Cycles are sampling time.`;
}

function escapeHtml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// The cross-scene summary: for each figure, the lowest and highest per-scene median.
function acrossScenes(read, digits = 1) {
  const values = sceneIds.map(read).filter(value => typeof value === 'number' && Number.isFinite(value));
  if (values.length === 0) return null;
  return { low: Math.min(...values), high: Math.max(...values), count: values.length, digits };
}
function rangeText(figure, unit = '') {
  if (!figure) return 'not run';
  const suffix = unit ? ` ${unit}` : '';
  return `${number(figure.low, figure.digits)} to ${number(figure.high, figure.digits)}${suffix}`;
}
const medianOf = (scene, engine, samples, name, scale = 1) => metric(group(scene, engine, samples), name, 3, scale)?.median;
const flipOf = (scene, engine, samples, name = 'flip') => score(group(scene, engine, samples), name)?.median;

function summaryRows() {
  const glazeTier = engine => [
    `${rangeText(acrossScenes(scene => medianOf(scene, engine, null, 'primaryMilliseconds'), 2), 'ms a frame with the pixel read')}; ${rangeText(acrossScenes(scene => medianOf(scene, engine, null, 'throughputMilliseconds'), 2), 'ms queued back to back')}`,
  ];
  const eeveeTier = engine => `${rangeText(acrossScenes(scene => medianOf(scene, engine, null, 'primaryMilliseconds'), 0), 'ms a render call')}`;
  const flipRange = (engine, samples = null) => rangeText(acrossScenes(scene => flipOf(scene, engine, samples), 3));
  return [
    ['draft (planned name)', glazeTier('glaze-draft')[0], eeveeTier('eevee-lowest'), `Glaze ${flipRange('glaze-draft')}`, `EEVEE 1 sample ${flipRange('eevee-lowest')}`],
    ['realtime', glazeTier('glaze-realtime')[0], eeveeTier('eevee-default'), `Glaze ${flipRange('glaze-realtime')}`, `EEVEE 64 samples ${flipRange('eevee-default')}`],
    ['final (Cook native, 256 samples)',
      `${rangeText(acrossScenes(scene => medianOf(scene, 'cook-native', REFERENCE_SAMPLES, 'perSampleMilliseconds'), 2), 'ms a sample')}; ${rangeText(acrossScenes(scene => medianOf(scene, 'cook-native', REFERENCE_SAMPLES, 'totalTraceSeconds'), 2), 's for 256 samples with setup')}`,
      `Cycles ${rangeText(acrossScenes(scene => medianOf(scene, 'cycles', REFERENCE_SAMPLES, 'perSampleMilliseconds'), 2), 'ms a sample')}; ${rangeText(acrossScenes(scene => medianOf(scene, 'cycles', REFERENCE_SAMPLES, 'totalTraceSeconds'), 2), 's for 256 samples with setup')}`,
      `Cook native ${flipRange('cook-native', REFERENCE_SAMPLES)}`, `Cycles ${flipRange('cycles', REFERENCE_SAMPLES)}`],
  ];
}

function summaryLines(assessments) {
  const noise = assessments.filter(assessment => assessment.outcome === 'noise');
  const limited = assessments.filter(assessment => assessment.outcome !== 'noise');
  const perSample = acrossScenes(scene => {
    const native = medianOf(scene, 'cook-native', REFERENCE_SAMPLES, 'perSampleMilliseconds');
    const cycles = medianOf(scene, 'cycles', REFERENCE_SAMPLES, 'perSampleMilliseconds');
    return native && cycles ? cycles / native : null;
  }, 1);
  const range = (items, read, digits = 1) => rangeText(items.length ? { low: Math.min(...items.map(read)), high: Math.max(...items.map(read)), digits } : null);
  const agreements = sceneIds.map(webgpuAgreement).filter(Boolean);
  const slowdown = rangeText(acrossScenes(scene => webgpuAgreement(scene)?.slowdown, 1));
  const matching = agreements.filter(agreement => agreement.relMse);
  const lines = [
    `Final, per-sample speed: Cook native draws a sample ${rangeText(perSample)} times faster than Cycles (256 samples, per-scene medians).`,
  ];
  if (noise.length > 0) {
    lines.push(`Final, equal error, on the ${noise.length} noise-limited scene${noise.length === 1 ? '' : 's'} (${noise.map(item => item.scene).join(', ')}), where both engines' relMSE falls roughly as 1/N between 256 and 1024 samples: Cook native needs ${range(noise, item => item.sampleRatio)} times Cycles' samples (extrapolated from 1024 samples), which is ${range(noise, item => item.timeRatioSampling, 2)} times Cycles' time (sampling only) and ${range(noise, item => item.timeRatioTotal, 2)} times with setup included.`);
  } else {
    lines.push('Final, equal error: no scene is noise-limited, so no ratio is given.');
  }
  lines.push(`Bias-limited scenes (no equal-error ratio given; the 1024-sample error is above ${BIAS_LIMIT_RATIO} times the 256-sample error, where 1/N gives 0.25): ${limited.length ? limited.map(item => `${item.scene} (${item.outcome === 'native-bias' ? 'Cook native' : "Cycles' target"}: ${relMseText(item.outcome === 'native-bias' ? item.nativeTrend.short : item.cyclesTrend.short)} at 256, ${relMseText(item.outcome === 'native-bias' ? item.nativeTrend.long : item.cyclesTrend.long)} at 1024)`).join('; ') : 'none'}.`);
  const matchingValues = matching.map(item => item.relMse.median);
  const matchingText = matching.length ? `; its 256-sample image matches native's (relMSE between the two images ${relMseText(Math.min(...matchingValues))} to ${relMseText(Math.max(...matchingValues))}, FLIP between them ${number(Math.min(...matching.map(item => item.flip.median)), 4)} to ${number(Math.max(...matching.map(item => item.flip.median)), 4)})` : '';
  lines.push(`Cook webgpu draws a sample ${slowdown} times slower than native (256 samples only, so it gets no equal-error figure)${matchingText}.`);
  return lines;
}

const SUMMARY_COLUMNS = ['Tier', 'Crucible time (range over scenes)', 'Blender time (range over scenes)', 'FLIP, Crucible', 'FLIP, Blender'];
const assessments = sceneIds.map(equalErrorAssessment).filter(Boolean);
const summary = summaryLines(assessments);
const summaryRowsList = summaryRows();
const markdown = [`## Summary across ${sceneIds.length} scenes`, '', `| ${SUMMARY_COLUMNS.join(' | ')} |`, `| ${SUMMARY_COLUMNS.map(() => '---').join(' | ')} |`, ...summaryRowsList.map(row => `| ${row.join(' | ')} |`), '', ...summary.flatMap(line => [line, '']), '## Per scene', ''];
const html = [`<h2>Summary across ${sceneIds.length} scenes</h2>`, '<table>', `<thead><tr>${SUMMARY_COLUMNS.map(column => `<th>${escapeHtml(column)}</th>`).join('')}</tr></thead>`, '<tbody>', ...summaryRowsList.map(row => `<tr>${row.map(cell => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`), '</tbody>', '</table>', ...summary.map(line => `<p>${escapeHtml(line)}</p>`), '<h2>Per scene</h2>'];
for (const scene of sceneIds) {
  const rows = rowsForScene(scene);
  const statements = [equalErrorText(assessments.find(item => item.scene === scene)), webgpuText(webgpuAgreement(scene))].filter(Boolean);
  markdown.push(`### ${scene}`, '', `| ${COLUMNS.join(' | ')} |`, `| ${COLUMNS.map(() => '---').join(' | ')} |`, ...rows.map(row => `| ${row.map(cell => String(cell).replace(/\|/g, '/')).join(' | ')} |`), '', ...statements.flatMap(text => [text, '']));
  html.push(`<h3>${escapeHtml(scene)}</h3>`, '<table>', `<thead><tr>${COLUMNS.map(column => `<th>${escapeHtml(column)}</th>`).join('')}</tr></thead>`, '<tbody>', ...rows.map(row => `<tr>${row.map(cell => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`), '</tbody>', '</table>', ...statements.map(text => `<p>${escapeHtml(text)}</p>`));
}
markdown.push(`Conditions. ${conditionsText()}`, '');
html.push(`<p class="conditions">${escapeHtml(conditionsText())}</p>`);
await writeFile(markdownPath, `${markdown.join('\n')}\n`);
await writeFile(htmlPath, `${html.join('\n')}\n`);
console.log(`wrote ${markdownPath}\nwrote ${htmlPath}`);
