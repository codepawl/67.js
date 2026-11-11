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

const COLUMNS = ['Tier', 'For', 'Runs on', 'Trade-off', '67js measured', 'Blender equivalent measured', 'FLIP vs Cycles (lower is better)'];

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

// Samples needed for the same relMSE as the reference engine's, and the time that takes. points: [{ samples, relMse }].
function samplesForError(points, targetError) {
  const ordered = [...points].sort((first, second) => first.samples - second.samples);
  for (let index = 0; index + 1 < ordered.length; index++) {
    const low = ordered[index];
    const high = ordered[index + 1];
    if (Math.min(low.relMse, high.relMse) <= targetError && targetError <= Math.max(low.relMse, high.relMse) && low.relMse !== high.relMse) {
      const fraction = (Math.log(targetError) - Math.log(low.relMse)) / (Math.log(high.relMse) - Math.log(low.relMse));
      return { samples: Math.exp(Math.log(low.samples) + fraction * (Math.log(high.samples) - Math.log(low.samples))), method: 'interpolated between measured counts' };
    }
  }
  const nearest = ordered.reduce((best, point) => (Math.abs(Math.log(point.relMse / targetError)) < Math.abs(Math.log(best.relMse / targetError)) ? point : best));
  return { samples: (nearest.samples * nearest.relMse) / targetError, method: `extrapolated from ${nearest.samples} samples as 1 over N` };
}

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

// The equal-error statement for one Cook engine against Cycles: the samples it needs and the time ratio at that error.
function equalErrorStatement(scene, engine, label) {
  const cycles = countedPoints(scene, 'cycles');
  const cook = countedPoints(scene, engine);
  const reference = cycles.find(point => point.samples === 256) ?? cycles[0];
  // A reference error of zero (the reference compared with itself) has no equal-error point.
  if (!reference || cook.length === 0 || !(reference.relMse > 1e-9)) return null;
  const needed = samplesForError(cook.map(point => ({ samples: point.samples, relMse: point.relMse })), reference.relMse);
  const perSampleCook = median(cook.map(point => point.samplingSeconds / point.samples));
  const setupCook = median(cook.map(point => point.totalSeconds - point.samplingSeconds));
  const perSampleCycles = reference.samplingSeconds / reference.samples;
  const samplingTime = needed.samples * perSampleCook;
  const totalTime = samplingTime + setupCook;
  return {
    engine, label, targetRelMse: reference.relMse, cyclesSamples: reference.samples, samplesNeeded: needed.samples, sampleRatio: needed.samples / reference.samples, method: needed.method,
    perSampleSpeedup: perSampleCycles / perSampleCook, samplingSeconds: samplingTime, totalSeconds: totalTime,
    timeRatioSampling: samplingTime / reference.samplingSeconds, timeRatioTotal: totalTime / reference.totalSeconds,
  };
}

function equalErrorText(statement) {
  if (!statement) return null;
  const times = value => number(value, 2);
  return `Equal error: ${statement.label} needs about ${number(statement.sampleRatio, 1)} times the samples of Cycles (${number(Math.round(statement.samplesNeeded), 0)} against ${statement.cyclesSamples}, to reach relMSE ${number(statement.targetRelMse, 4)}; ${statement.method}). It draws a sample ${times(statement.perSampleSpeedup)} times faster, so the time to equal error is ${times(statement.timeRatioSampling)} times Cycles' (sampling only) and ${times(statement.timeRatioTotal)} times with setup included (${number(statement.samplingSeconds, 1)} s against ${number(statement.samplingSeconds / statement.timeRatioSampling, 1)} s sampling).`;
}

function rowsForScene(scene) {
  const draftGlaze = group(scene, 'glaze-draft');
  const draftEevee = group(scene, 'eevee-lowest');
  const realtimeGlaze = group(scene, 'glaze-realtime');
  const realtimeEevee = group(scene, 'eevee-default');
  const native = group(scene, 'cook-native');
  const cyclesAt = group(scene, 'cycles', native.cells[0]?.samples ?? 256);
  const nativeAt = native.cells.length ? group(scene, 'cook-native', native.cells[0].samples) : native;
  const rows = [
    ['draft (planned name)', 'A quick look while editing', 'Glaze, 0.5 render scale, 1 sample, light shading, 8 bit target, coarser level of detail', 'Aliased edges, no environment lookup, a quarter of the pixels enlarged', glazeText(draftGlaze), eeveeText(draftEevee),
      flipText([glazeFlip(draftGlaze, 'Glaze'), plainFlip(draftEevee, 'EEVEE 1 sample')])],
    ['realtime', 'Interactive use', 'Glaze, default settings', 'No path-traced global illumination: indirect light is approximate', glazeText(realtimeGlaze), eeveeText(realtimeEevee),
      flipText([glazeFlip(realtimeGlaze, 'Glaze'), plainFlip(realtimeEevee, 'EEVEE 64 samples')])],
    ['realtime-high', 'Interactive, higher quality', 'Planned (#902), not measurable yet', 'none', 'none', 'none', 'none'],
    ['final', 'Offline images', 'Cook native (Vulkan ray queries)', 'Needs more samples than Cycles for the same noise (see below)', countedText(nativeAt), `Cycles: ${countedText(cyclesAt)}`,
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

const markdown = [];
const html = [];
for (const scene of sceneIds) {
  const rows = rowsForScene(scene);
  const statements = [['cook-native', 'Cook native'], ['cook-webgpu', 'Cook webgpu']].map(([engine, label]) => equalErrorText(equalErrorStatement(scene, engine, label))).filter(Boolean);
  markdown.push(`### ${scene}`, '', `| ${COLUMNS.join(' | ')} |`, `| ${COLUMNS.map(() => '---').join(' | ')} |`, ...rows.map(row => `| ${row.map(cell => String(cell).replace(/\|/g, '/')).join(' | ')} |`), '', ...statements.flatMap(text => [text, '']));
  html.push(`<h3>${escapeHtml(scene)}</h3>`, '<table>', `<thead><tr>${COLUMNS.map(column => `<th>${escapeHtml(column)}</th>`).join('')}</tr></thead>`, '<tbody>', ...rows.map(row => `<tr>${row.map(cell => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`), '</tbody>', '</table>', ...statements.map(text => `<p>${escapeHtml(text)}</p>`));
}
markdown.push(`Conditions. ${conditionsText()}`, '');
html.push(`<p class="conditions">${escapeHtml(conditionsText())}</p>`);
await writeFile(markdownPath, `${markdown.join('\n')}\n`);
await writeFile(htmlPath, `${html.join('\n')}\n`);
console.log(`wrote ${markdownPath}\nwrote ${htmlPath}`);
