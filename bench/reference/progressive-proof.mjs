// Prints the three "Done when" numbers of issue #623 in one table: progressive time to the 64 sample still's FLIP score,
// the median frame time at 1 sample per pixel, and the light choice score against uniform at equal samples.
//   node bench/reference/progressive-proof.mjs <output directory> --cycles <directory with <scene>-cycles.npy> [--runs 3] [--frames 200]
// Behind the GPU lock: bash ~/.agents/tools/gpu-lock.sh node bench/reference/progressive-proof.mjs ...
// It runs progressive-compare.mjs and progressive-score.py (uv, flip-evaluator) once per run, so it needs Chrome, a GPU and uv.
// The scores do not change between runs; the times do, so every time is printed as a range over the runs.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const argumentsGiven = process.argv.slice(2);
const valueAfter = (flag, fallback) => (argumentsGiven.includes(flag) ? argumentsGiven[argumentsGiven.indexOf(flag) + 1] : fallback);
const outputDirectory = resolve(argumentsGiven[0] ?? '');
const cyclesDirectory = resolve(valueAfter('--cycles', ''));
const runCount = Number(valueAfter('--runs', 3));
const frameCount = Number(valueAfter('--frames', 200));
if (!argumentsGiven[0] || !argumentsGiven.includes('--cycles')) {
  throw new Error('Usage: progressive-proof.mjs <output directory> --cycles <directory with <scene>-cycles.npy> [--runs 3] [--frames 200]');
}

const TIMED_SCENES = ['lit-interior', 'spot-area'];
const TIMED_VARIANTS = ['random', 'tree'];
const FRAME_SCENE = 'tests/fixtures/demo-room.recipe.json';
const CHECKPOINTS = '1,2,3,4,6,8,12,16,24,32,48,64';
const LIGHT_SCENE_SAMPLES = '16,64';
// --skip-light-choice leaves out item 3, which draws 17 scenes in four ways.
const lightSceneIds = argumentsGiven.includes('--skip-light-choice') ? [] : [...Object.keys(JSON.parse(readFileSync('bench/reference/path-tracer.json', 'utf8')).scores), 'many-lights'];

function run(command, commandArguments) {
  const result = spawnSync(command, commandArguments, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 1 << 28 });
  if (result.status !== 0) throw new Error(`${command} ${commandArguments.slice(0, 3).join(' ')} failed with status ${result.status}`);
  return result.stdout;
}

function score(directory) {
  run('uv', ['run', '--no-project', '--python', '3.12', '--with', 'flip-evaluator', '--with', 'pillow', '--with', 'numpy',
    'python', '-I', 'bench/reference/progressive-score.py', directory, '--cycles', cyclesDirectory]);
  return JSON.parse(readFileSync(`${directory}/progressive-score.json`, 'utf8'));
}

const range = values => (Math.min(...values) === Math.max(...values) ? `${Math.min(...values).toFixed(1)}` : `${Math.min(...values).toFixed(1)} to ${Math.max(...values).toFixed(1)}`);
const fileHash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const report = { timedScenes: {}, frameTime: {}, lightChoice: {} };

// 1. Time to the still's score, and 2. frame time.
for (let runIndex = 1; runIndex <= runCount; runIndex++) {
  const directory = `${outputDirectory}/run${runIndex}`;
  run(process.execPath, ['bench/reference/progressive-compare.mjs', directory, TIMED_SCENES.join(','), '--still', '--variant', TIMED_VARIANTS.join(','), '--checkpoints', CHECKPOINTS]);
  const scores = score(directory);
  const timings = JSON.parse(readFileSync(`${directory}/timings.json`, 'utf8'));
  for (const scene of TIMED_SCENES) {
    const stillScore = scores[`${scene}:still-64`];
    const still = timings[`${scene}:still-64`];
    for (const variant of TIMED_VARIANTS) {
      const reached = CHECKPOINTS.split(',').map(Number).find(samples => scores[`${scene}:${variant}-${samples}`] <= stillScore);
      const entry = (report.timedScenes[`${scene}:${variant}`] ??= { stillScore, stillSeconds: [], reachedSamples: [], progressiveSeconds: [], progressiveScore: null });
      entry.stillSeconds.push(still.seconds);
      if (reached === undefined) continue;
      const point = timings[`${scene}:${variant}:${reached}`];
      entry.reachedSamples.push(reached);
      entry.progressiveScore = scores[`${scene}:${variant}-${reached}`];
      entry.progressiveSeconds.push(point.setupSeconds + point.stepSeconds + point.snapshotSeconds);
    }
  }
  const frameDirectory = `${directory}/frame`;
  run(process.execPath, ['bench/reference/progressive-compare.mjs', frameDirectory, FRAME_SCENE, '--variant', 'random', '--checkpoints', '1', '--frames', String(frameCount)]);
  const frame = JSON.parse(readFileSync(`${frameDirectory}/timings.json`, 'utf8'))['demo-room:random:frame'];
  (report.frameTime.medianMilliseconds ??= []).push(frame.medianMilliseconds);
  (report.frameTime.minimumMilliseconds ??= []).push(frame.minimumMilliseconds);
  (report.frameTime.maximumMilliseconds ??= []).push(frame.maximumMilliseconds);
}

// 3. Default light choice against forced uniform. Scores do not vary between runs, so one pass.
const lightDirectory = `${outputDirectory}/light-choice`;
if (lightSceneIds.length) run(process.execPath, ['bench/reference/progressive-compare.mjs', lightDirectory, lightSceneIds.join(','), '--variant', 'uniform,tree,importance', '--checkpoints', LIGHT_SCENE_SAMPLES]);
if (lightSceneIds.length) run(process.execPath, ['bench/reference/progressive-compare.mjs', lightDirectory, lightSceneIds.join(','), '--variant', 'random', '--checkpoints', LIGHT_SCENE_SAMPLES]);
const lightScores = lightSceneIds.length ? score(lightDirectory) : {};
const files = lightSceneIds.length ? readdirSync(lightDirectory) : [];
for (const scene of lightSceneIds) {
  for (const samples of LIGHT_SCENE_SAMPLES.split(',')) {
    const defaultPath = `${lightDirectory}/${scene}@random-${samples}.png`;
    const uniformPath = `${lightDirectory}/${scene}@uniform-${samples}.png`;
    if (!files.includes(`${scene}@random-${samples}.png`)) continue;
    report.lightChoice[`${scene}:${samples}`] = {
      defaultScore: lightScores[`${scene}:random-${samples}`] ?? null,
      uniformScore: lightScores[`${scene}:uniform-${samples}`] ?? null,
      treeScore: lightScores[`${scene}:tree-${samples}`] ?? null,
      importanceScore: lightScores[`${scene}:importance-${samples}`] ?? null,
      defaultEqualsUniform: existsSync(uniformPath) ? fileHash(defaultPath) === fileHash(uniformPath) : null,
    };
  }
}
writeFileSync(`${outputDirectory}/progressive-proof.json`, JSON.stringify(report, null, 1));

console.log(`\nItem 1: progressive (default options) against the 64 sample still, 960 by 540, ${runCount} runs (seconds: setup, compile, steps and read back)`);
console.log('| Scene | Light choice | Still FLIP | Progressive FLIP | Samples reached | Progressive s | Still s |');
console.log('| --- | --- | --- | --- | --- | --- | --- |');
for (const [key, entry] of Object.entries(report.timedScenes)) {
  const progressive = entry.progressiveSeconds.length ? range(entry.progressiveSeconds) : 'not reached';
  console.log(`| ${key.split(':')[0]} | ${key.split(':')[1] === 'random' ? 'default (uniform)' : 'forced tree'} | ${entry.stillScore} | ${entry.progressiveScore ?? '-'} | ${[...new Set(entry.reachedSamples)].join(', ') || '-'} | ${progressive} | ${range(entry.stillSeconds)} |`);
}
console.log(`\nItem 2: median frame time at 1 sample per pixel, demo room, ${frameCount} frames, ${runCount} runs: median ${range(report.frameTime.medianMilliseconds)} ms (fastest frame ${range(report.frameTime.minimumMilliseconds)}, slowest ${range(report.frameTime.maximumMilliseconds)})`);
console.log('\nItem 3: default light choice (auto) against forced uniform, FLIP against Cycles (- means no Cycles render given)');
console.log('| Scene | Samples | Default | Uniform | Tree | Importance | Default pixels equal uniform |');
console.log('| --- | --- | --- | --- | --- | --- | --- |');
for (const [key, entry] of Object.entries(report.lightChoice)) {
  const [scene, samples] = key.split(':');
  console.log(`| ${scene} | ${samples} | ${entry.defaultScore ?? '-'} | ${entry.uniformScore ?? '-'} | ${entry.treeScore ?? '-'} | ${entry.importanceScore ?? '-'} | ${entry.defaultEqualsUniform} |`);
}
