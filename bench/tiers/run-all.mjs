// The tier benchmark in one command: every engine on every scene, interleaved, behind the idle gate, resumable.
//   [gpu-lock heavy] node bench/tiers/run-all.mjs <work directory> [--scenes lit-interior,spot-area,...] [--repetitions 3] [--width 960]
//       [--samples 256,1024] [--engines glaze-draft,...] [--with-cook-gpu] [--with-cook-cpu] [--reference-samples 4096]
//       [--max-wait 600] [--report-only] [--results <file>] [--no-score] [--frames 10]
// Per repetition and scene the engines run back to back in a fixed order that rotates by one place each repetition:
//   glaze-draft, glaze-realtime, eevee-lowest, eevee-default, cook-native, cycles, cook-webgpu (then cook-gpu, cook-cpu when asked).
// Cook native and Cycles run once per --samples count (webgpu, gpu and cpu run at the first count only: one Cook trace is limited in size).
// Each cell goes through bench/tiers/idle-gate.mjs, so it waits for a quiet card first and records the card's load before and during the run.
// The results file (default <work directory>/matrix-<width>.json) is rewritten after every cell, and a cell already in it is skipped, so an
// interrupted run continues where it stopped. Scoring (FLIP against Cycles) runs at the end and adds `score` to the cells that lack it;
// make-table.mjs turns the file into the tier table. Needs Blender 5.3, uv, Node 24 and Chrome, like the other scripts in this folder.
import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { constants, setPriority } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const runFile = promisify(execFile);
const argumentsGiven = process.argv.slice(2);
const flagPresent = flag => argumentsGiven.includes(flag);
const valueAfter = (flag, fallback) => (flagPresent(flag) ? argumentsGiven[argumentsGiven.indexOf(flag) + 1] : fallback);
const workDirectory = resolve(argumentsGiven[0] ?? (() => { throw new Error('Usage: run-all.mjs <work directory> [options], see the top of the file.'); })());
const ALL_SCENES = 'lit-interior,spot-area,light-linking,metal,glass,outdoor-hdri';
const sceneIds = valueAfter('--scenes', ALL_SCENES).split(',');
const repetitions = Number(valueAfter('--repetitions', 3));
const width = Number(valueAfter('--width', 960));
const height = Math.round((width * 9) / 16);
const sampleCounts = valueAfter('--samples', '256,1024').split(',').map(Number);
const referenceSamples = Number(valueAfter('--reference-samples', 4096));
const frameCount = Number(valueAfter('--frames', 10));
const maxWaitSeconds = valueAfter('--max-wait', '600');
const reportOnly = flagPresent('--report-only');
const resultsPath = resolve(valueAfter('--results', join(workDirectory, `matrix-${width}.json`)));
const blenderBinary = process.env.BLENDER_BIN ?? 'C:/Program Files/Blender Foundation/Blender 5.3/blender.exe';
const skipScoring = flagPresent('--no-score');

const BASE_ORDER = ['glaze-draft', 'glaze-realtime', 'eevee-lowest', 'eevee-default', 'cook-native', 'cycles', 'cook-webgpu'];
const OPTIONAL_ORDER = [flagPresent('--with-cook-gpu') ? 'cook-gpu' : null, flagPresent('--with-cook-cpu') ? 'cook-cpu' : null].filter(Boolean);
const engineNames = valueAfter('--engines', null)?.split(',') ?? [...BASE_ORDER, ...OPTIONAL_ORDER];
const COUNTED_ENGINES = new Set(['cook-native', 'cycles']);

// The cells of one repetition and scene, in this repetition's order: the base order rotated by (repetition - 1) places.
function cellsOfRepetition(repetition) {
  const expanded = engineNames.flatMap(engine => (COUNTED_ENGINES.has(engine) ? sampleCounts.map(samples => ({ engine, samples })) : [{ engine, samples: engine.startsWith('cook-') ? sampleCounts[0] : null }]));
  const shift = (repetition - 1) % expanded.length;
  return [...expanded.slice(shift), ...expanded.slice(0, shift)];
}

const cellKey = (scene, engine, samples, repetition) => `${scene}|${engine}|${samples ?? '-'}|r${repetition}`;

async function run(command, commandArguments, logPath) {
  return new Promise(done => {
    const chunks = [];
    const child = spawn(command, commandArguments, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GPU_LOCK: '' } });
    child.stdout.on('data', chunk => chunks.push(chunk));
    child.stderr.on('data', chunk => chunks.push(chunk));
    child.on('error', error => { chunks.push(Buffer.from(String(error))); done(127); });
    child.on('close', async code => {
      if (logPath) await writeFile(logPath, Buffer.concat(chunks));
      done(code ?? 1);
    });
  });
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function exportSceneIfMissing(scene) {
  const sceneJson = join(workDirectory, 'scenes', `${scene}.json`);
  if (!existsSync(sceneJson)) {
    console.log(`export ${scene}`);
    const exitCode = await run('node', ['bench/cycles-parity/export-scene.mjs', workDirectory, '--scene', scene], join(workDirectory, `export-${scene}.log`));
    if (exitCode !== 0) throw new Error(`Exporting ${scene} failed, see ${workDirectory}/export-${scene}.log.`);
  }
  return sceneJson;
}

// The Cycles reference the scores use. Not a timed cell, so it runs outside the gate.
async function ensureReference(scene, sceneJson) {
  const prefix = join(workDirectory, 'reference', `${scene}-cycles-${referenceSamples}-seed1`);
  if (!existsSync(`${prefix}.npy`)) {
    await mkdir(join(workDirectory, 'reference'), { recursive: true });
    console.log(`reference ${scene} at ${referenceSamples} samples`);
    const exitCode = await run(blenderBinary, ['-b', '--factory-startup', '--python', 'bench/cycles-parity/render-cycles.py', '--', sceneJson, prefix, '--samples', String(referenceSamples), '--bounces', '8', '--seed', '1', '--width', String(width), '--height', String(height)], `${prefix}.log`);
    if (exitCode !== 0) throw new Error(`Reference render of ${scene} failed, see ${prefix}.log.`);
  }
  return `${prefix}.npy`;
}

function measuredCommand(prefix, command) {
  return ['uv', 'run', '--no-project', '--with', 'psutil', 'python', 'bench/cycles-parity/measure-gpu-run.py', `${prefix}.metrics.json`, '--', ...command];
}

// For one cell: the command to run and a function that reads its outputs into { metrics, image }.
function planCell(scene, sceneJson, engine, samples, repetition, directory) {
  const prefix = join(directory, 'out');
  if (engine.startsWith('glaze-')) {
    const tier = engine.slice('glaze-'.length);
    return {
      command: ['node', 'bench/tiers/run-glaze.mjs', directory, scene, '--tiers', tier, '--repetitions', '1', '--first-repetition', String(repetition), '--width', String(width), '--height', String(height), '--frames', String(frameCount)],
      async collect() {
        const record = (await readJson(join(directory, `glaze-${width}.json`))).runs[0];
        return {
          metrics: {
            primaryMilliseconds: record.medianFrameMilliseconds, primaryName: 'frame, draw plus pixel read',
            throughputMilliseconds: record.throughputMilliseconds, firstFrameMilliseconds: record.firstFrameMilliseconds, setupMilliseconds: record.setupMilliseconds,
            frameMilliseconds: record.frameMilliseconds, canvas: `${record.canvasWidth}x${record.canvasHeight}`, renderTargetMegabytes: record.memoryReport.totalMegabytes,
            cardDeltaMebibytes: record.card.deltaMebibytes, samplesDrawn: record.capabilities.samples,
          },
          image: { path: join(directory, `${scene}-${tier}-${width}-r${repetition}.png`), kind: 'png-display', nativeWidth: record.canvasWidth, nativeHeight: record.canvasHeight },
        };
      },
    };
  }
  if (engine.startsWith('eevee-')) {
    return {
      command: measuredCommand(prefix, [blenderBinary, '-b', '--factory-startup', '--python', 'bench/tiers/render-eevee.py', '--', sceneJson, prefix, '--preset', engine.slice('eevee-'.length), '--width', String(width), '--height', String(height), '--frames', String(frameCount)]),
      async collect() {
        const report = await readJson(`${prefix}.json`);
        const processMetrics = await readJson(`${prefix}.metrics.json`);
        return {
          metrics: {
            primaryMilliseconds: report.medianFrameSeconds * 1000, primaryName: 'render call, scene sync included',
            engineMilliseconds: report.engineMedianFrameSeconds === null ? null : report.engineMedianFrameSeconds * 1000,
            firstFrameMilliseconds: report.firstFrameSeconds * 1000, frameMilliseconds: report.frameSeconds.map(seconds => seconds * 1000),
            sceneBuildSeconds: report.sceneBuildSeconds, effectiveSettings: report.effectiveSettings, blenderVersion: report.blenderVersion,
            processWallSeconds: processMetrics.wallSeconds, cardDeltaMebibytes: processMetrics.peakVramDeltaMegabytes,
          },
          image: { path: `${prefix}.npy`, kind: 'linear-npy' },
        };
      },
    };
  }
  if (engine === 'cook-native' || engine === 'cycles') {
    const traceCommand = engine === 'cook-native'
      ? ['node', 'bench/cycles-parity/trace-native.mjs', sceneJson, prefix, '--samples', String(samples), '--bounces', '8', '--seed', '1', '--firefly-clamp', '1000000000', '--noise-threshold', '0']
      : [blenderBinary, '-b', '--factory-startup', '--python', 'bench/cycles-parity/render-cycles.py', '--', sceneJson, prefix, '--samples', String(samples), '--bounces', '8', '--seed', '1', '--width', String(width), '--height', String(height)];
    return {
      command: measuredCommand(prefix, traceCommand),
      async collect() {
        const report = await readJson(`${prefix}.json`);
        const processMetrics = await readJson(`${prefix}.metrics.json`);
        return {
          metrics: {
            samples, samplingSeconds: report.samplingSeconds, totalTraceSeconds: report.totalTraceSeconds, perSampleMilliseconds: (report.samplingSeconds / samples) * 1000,
            primaryMilliseconds: report.samplingSeconds * 1000, primaryName: 'sampling, all samples',
            processWallSeconds: processMetrics.wallSeconds, cardDeltaMebibytes: processMetrics.peakVramDeltaMegabytes, peakRamMegabytes: processMetrics.peakRamMegabytes,
          },
          image: { path: `${prefix}.npy`, kind: 'linear-npy' },
        };
      },
    };
  }
  if (engine.startsWith('cook-')) {
    const backend = engine.slice('cook-'.length);
    const cookPrefix = join(directory, `${scene}-cook-${backend}-s${samples}-r${repetition}`);
    return {
      command: ['node', 'bench/tiers/run-cook.mjs', directory, scene, '--backend', backend, '--samples', String(samples), '--repetitions', '1', '--first-repetition', String(repetition), '--width', String(width), '--height', String(height)],
      async collect() {
        const report = await readJson(`${cookPrefix}.json`);
        const compileSeconds = report.report.gpuCompileSeconds ?? 0;
        const samplingSeconds = report.report.tracedSeconds - compileSeconds;
        return {
          metrics: {
            samples, samplingSeconds, totalTraceSeconds: report.report.tracedSeconds, compileSeconds, perSampleMilliseconds: (samplingSeconds / samples) * 1000,
            primaryMilliseconds: samplingSeconds * 1000, primaryName: 'sampling, all samples', cardDeltaMebibytes: report.card.deltaMebibytes,
          },
          image: { path: `${cookPrefix}.npy`, kind: 'linear-npy' },
        };
      },
    };
  }
  throw new Error(`Unknown engine ${engine}.`);
}

async function loadResults() {
  if (existsSync(resultsPath)) return readJson(resultsPath);
  return { schema: 1, width, height, scenes: sceneIds, referenceSamples, created: new Date().toISOString(), conditions: {}, references: {}, cells: [] };
}

async function saveResults(results) {
  const temporaryPath = `${resultsPath}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(results, null, 1)}\n`);
  await rename(temporaryPath, resultsPath);
}

async function captureConditions() {
  const text = async (command, commandArguments) => (await runFile(command, commandArguments).catch(() => ({ stdout: '' }))).stdout.trim();
  const card = await text('nvidia-smi', ['--query-gpu=name,driver_version,memory.total', '--format=csv,noheader']);
  const blender = await text(blenderBinary, ['--version']);
  return { card, blender: blender.split(/\r?\n/)[0], node: process.version, platform: process.platform, date: new Date().toISOString().slice(0, 10) };
}

setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL);
await mkdir(workDirectory, { recursive: true });
const results = await loadResults();
Object.assign(results.conditions, await captureConditions());
results.gate = { maxWaitSeconds: Number(maxWaitSeconds), reportOnly, thresholdPercent: 15, consecutivePolls: 5, contendedAbovePercent: 30 };
const sceneFiles = {};
for (const scene of sceneIds) {
  sceneFiles[scene] = await exportSceneIfMissing(scene);
  results.references[scene] = { path: await ensureReference(scene, sceneFiles[scene]), samples: referenceSamples };
}
await saveResults(results);

// A contended cell is kept in the results; --rerun-contended runs it again (when the card is quieter) and replaces it.
const done = new Set(results.cells.filter(cell => cell.status === 'ok' && !(flagPresent('--rerun-contended') && cell.contended)).map(cell => cell.key));
let failures = 0;
for (let repetition = 1; repetition <= repetitions; repetition++) {
  for (const scene of sceneIds) {
    for (const { engine, samples } of cellsOfRepetition(repetition)) {
      const key = cellKey(scene, engine, samples, repetition);
      if (done.has(key)) continue;
      const directory = join(workDirectory, 'matrix', scene, `${engine}${samples ? `-s${samples}` : ''}-r${repetition}`);
      await mkdir(directory, { recursive: true });
      const plan = planCell(scene, sceneFiles[scene], engine, samples, repetition, directory);
      const gateFile = join(directory, 'gate.json');
      const gateFlags = ['--out', gateFile, '--max-wait', maxWaitSeconds, ...(reportOnly ? ['--report-only'] : [])];
      const started = Date.now();
      const exitCode = await run('node', ['bench/tiers/idle-gate.mjs', ...gateFlags, '--', ...plan.command], join(directory, 'run.log'));
      const gate = existsSync(gateFile) ? await readJson(gateFile) : null;
      const cell = { key, scene, engine, samples, repetition, width, height, startedAt: new Date(started).toISOString(), directory, gate, contended: gate?.contended ?? true, contendedReason: gate?.contendedReason ?? null };
      try {
        if (exitCode !== 0) throw new Error(gate?.gate?.timedOut ? gate.gate.message : `command exited ${exitCode}, see ${directory}/run.log`);
        Object.assign(cell, await plan.collect(), { status: 'ok' });
      } catch (error) {
        cell.status = 'failed';
        cell.error = error.message;
        failures += 1;
      }
      results.cells = results.cells.filter(existing => existing.key !== key);
      results.cells.push(cell);
      await saveResults(results);
      const util = gate?.background ? `background ${gate.background.utilMedian}% (max ${gate.background.utilMax}%), during ${gate.run?.utilMedian}%` : 'no gate record';
      console.log(`${cell.status.padEnd(6)} r${repetition} ${scene} ${engine}${samples ? ` s${samples}` : ''}`, cell.status === 'ok' ? `${cell.metrics.primaryMilliseconds.toFixed(1)} ms` : cell.error, '|', util, cell.contended ? '| CONTENDED' : '');
    }
  }
}

if (!skipScoring) {
  console.log('scoring');
  const exitCode = await run('uv', ['run', '--no-project', '--python', '3.12', '--with', 'flip-evaluator', '--with', 'pillow', '--with', 'numpy', 'python', '-I', 'bench/tiers/score-tiers.py', 'matrix', resultsPath], join(workDirectory, 'score.log'));
  if (exitCode !== 0) console.log(`scoring failed, see ${workDirectory}/score.log`);
}
console.log(`results ${resultsPath}: ${results.cells.length} cells, ${results.cells.filter(cell => cell.contended).length} contended, ${failures} failed this run`);
process.exit(failures > 0 ? 1 : 0);
