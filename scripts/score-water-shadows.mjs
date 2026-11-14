// Scores the water shadow pool against a Cycles reference (issue #349):
//   node scripts/score-water-shadows.mjs [work directory]
// Draws the pool from above in Crucible, renders the same pool in Blender Cycles (volume absorption and scatter, CPU, 6 threads) with the sun and sky
// taken from the dry bed Crucible measured, then FLIP-scores each pair with bench/reference/water-shadows-score.py. Results land in <work directory>/scores.json.
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { constants, setPriority } from 'node:os';
import { resolve } from 'node:path';
import { WATER_DEPTHS, openPage } from './measure-water-shadows.mjs';
import { WATER_PRESETS } from '../src/world-material-shader.js';

setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL);
const WIDTH = 480;
const HEIGHT = 270;
const BLENDER = process.env.BLENDER_PATH ?? 'C:/Program Files/Blender Foundation/Blender 5.2/blender.exe';
const work = resolve(process.argv.slice(2).find(argument => !argument.startsWith('--')) ?? 'artifacts/water-shadows');
await mkdir(work, { recursive: true });

const cases = [];
for (const depth of WATER_DEPTHS) {
  cases.push({ name: `dry-${depth}`, depth, preset: null, absorption: null, turbidity: 0 });
  for (const preset of ['lake', 'river']) {
    cases.push({ name: `${preset}-${depth}`, depth, preset, absorption: WATER_PRESETS[preset].absorption, turbidity: WATER_PRESETS[preset].turbidity });
  }
}

const { page, close } = await openPage(process.cwd());
let calibration;
try {
  const result = await page.evaluate(async ({ cases, width, height }) => {
    const scene = await import('/scripts/water-shadow-scene.js');
    const pictures = {};
    for (const entry of cases) {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      canvas.style.cssText = `width:${width}px;height:${height}px;display:block`;
      document.body.append(canvas);
      const water = entry.preset ? { waterPreset: entry.preset } : { tag: 'surface' };
      const renderer = scene.drawPool(canvas, entry.depth, water, { eye: [0, 12, 0], target: [0, 0, 0], up: [0, 0, -1] });
      pictures[entry.name] = canvas.toDataURL('image/png');
      renderer.dispose?.();
      canvas.remove();
    }
    const probe = document.createElement('canvas');
    probe.width = 200;
    probe.height = 120;
    document.body.append(probe);
    return { pictures, dry: scene.measureBed(probe, 1, null) };
  }, { cases, width: WIDTH, height: HEIGHT });
  for (const [name, dataUrl] of Object.entries(result.pictures)) {
    await writeFile(resolve(work, `js-${name}.png`), Buffer.from(dataUrl.split(',')[1], 'base64'));
  }
  calibration = result.dry;
} finally {
  await close();
}

await writeFile(resolve(work, 'cases.json'), JSON.stringify({ width: WIDTH, height: HEIGHT, calibration, cases }));
if (!process.argv.includes('--skip-blender')) {
  const blender = spawnSync(BLENDER, ['-b', '--factory-startup', '-t', '6', '--python', resolve('bench/reference/water-shadows-cycles.py'), '--', resolve(work, 'cases.json'), work], { stdio: 'inherit' });
  if (blender.status !== 0) {
    throw new Error(`Blender exited with ${blender.status}`);
  }
}
const score = spawnSync('uv', ['run', '--no-project', '--python', '3.12', '--with', 'flip-evaluator', '--with', 'pillow', '--with', 'numpy', 'python', '-I', resolve('bench/reference/water-shadows-score.py'), work], { stdio: 'inherit' });
if (score.status !== 0) {
  throw new Error(`Scoring exited with ${score.status}`);
}
