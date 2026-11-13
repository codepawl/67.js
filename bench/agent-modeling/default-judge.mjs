// Blind pairwise judge of the engine's default look. A recipe that sets no lighting is drawn under two defaults and a
// vision judge, shown the two renders as "first" and "second" in a seeded random order, says which looks more like a
// finished, believable render. Wins per side and an exact binomial p against 0.5 tell whether the judge sees the change.
// The `sonnet-vision` judge cannot: it compares with a reference drawn under the same defaults.
//
// node bench/agent-modeling/default-judge.mjs render --label <name> [--no-floor] [--directory <directory>]
//   Draws the stored cold recipes (bench/agent-modeling/cold-recipes) from two cameras: the fixed three-quarter view
//   and the recipe camera, which is what `scene_look` draws, at the preview size 768 x 512.
// node bench/agent-modeling/default-judge.mjs judge --claude <path> --model <name> --a <label> --b <label> [--control]
//   One judge call per task and repeat. Order is a function of --seed, task and repeat, so a result can be re-scored.
//   --control shows label a against itself: any preference for "first" or "second" is position bias.
// The stored recipes hold every normalized default, including `environment`, `effects` and `shadow`, which agents never
// set. Those three fields are dropped here so the engine's current defaults apply.
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { boundsOfGeometries, lookCameras } from './look-cameras.mjs';
import { withLookPage, worldGeometriesOf } from './look.mjs';

const repository = resolve(import.meta.dirname, '../..');
const COLD_TASKS = ['crate', 'mug', 'table', 'soap', 'chair', 'gear'];
const PREVIEW_SIZE = { width: 768, height: 512 };
const THREE_QUARTER_SIZE = { width: 512, height: 512 };
const THREE_QUARTER = 'three-quarter';
const PREVIEW = 'preview';
const VIEW_ORDER = [THREE_QUARTER, PREVIEW];
const REPEATS = 3;
const DEFAULT_SEED = 53;

// A short system prompt: the default one is about 25k tokens and made most calls cost ten times more.
const JUDGE_ROLE = 'You compare two rendered images and answer in the format asked.';

export const JUDGE_QUESTION = `You see renders of one 3D object drawn by two different renderers, in two camera views. For each view you get a "first" and a "second" render, in that order.
Which renderer gives the images that look more like a finished, believable render of a real object (grounding, shadows, lighting, depth), not a preview of floating geometry?
Ignore the shape of the object; it is the same in both. Judge only the image as a whole, in both views together.
Give one short sentence naming what decided it, then as the very last line exactly: WINNER: first   or   WINNER: second`;

export function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

/** Which side is shown first: repeat 0 is random, repeat 1 swaps it, repeat 2 is random again. */
export function firstSideOf(seed, taskIndex, repeat) {
  const random = seededRandom(seed * 1000 + taskIndex);
  const base = random() < 0.5;
  const later = random() < 0.5;
  if (repeat === 0) return base ? 'a' : 'b';
  if (repeat === 1) return base ? 'b' : 'a';
  return later ? 'a' : 'b';
}

/** Exact two-sided binomial p against 0.5 for `wins` out of `trials`. */
export function binomialP(wins, trials) {
  if (trials === 0) return 1;
  const probabilityOf = count => {
    let logChoose = 0;
    for (let step = 1; step <= count; step++) logChoose += Math.log((trials - count + step) / step);
    return Math.exp(logChoose + trials * Math.log(0.5));
  };
  const observed = probabilityOf(wins);
  let total = 0;
  for (let count = 0; count <= trials; count++) {
    const probability = probabilityOf(count);
    if (probability <= observed * (1 + 1e-9)) total += probability;
  }
  return Math.min(1, total);
}

async function loadColdRecipe(taskId, { noFloor }) {
  const recipe = JSON.parse(await readFile(join(import.meta.dirname, 'cold-recipes', `${taskId}.recipe.json`), 'utf8'));
  const { environment, effects, shadow, physics, ...cold } = recipe;
  return noFloor ? { ...cold, environment: { ground: false } } : cold;
}

async function renderVariant({ label, noFloor, directory }) {
  await mkdir(directory, { recursive: true });
  const recipes = [];
  const threeQuarterViews = [];
  for (const taskId of COLD_TASKS) {
    const recipe = await loadColdRecipe(taskId, { noFloor });
    recipes.push(recipe);
    const bounds = boundsOfGeometries(await worldGeometriesOf(recipe));
    threeQuarterViews.push(lookCameras(bounds).filter(({ name }) => name === THREE_QUARTER));
  }
  const draw = async (page, recipe, views, name) => {
    const images = await page.evaluate(([sceneRecipe, cameraViews]) => window.renderLookViews(sceneRecipe, cameraViews), [recipe, views]);
    await writeFile(join(directory, name), Buffer.from(images[0].image, 'base64'));
  };
  await withLookPage(async page => {
    for (const [index, taskId] of COLD_TASKS.entries()) await draw(page, recipes[index], threeQuarterViews[index], `${taskId}-${THREE_QUARTER}.png`);
  }, THREE_QUARTER_SIZE);
  await withLookPage(async page => {
    for (const [index, taskId] of COLD_TASKS.entries()) await draw(page, recipes[index], [{ name: PREVIEW }], `${taskId}-${PREVIEW}.png`);
  }, PREVIEW_SIZE);
  console.log(`${label}: ${COLD_TASKS.length * VIEW_ORDER.length} images`);
}

export function imageBlock(bytes) {
  return { type: 'image', source: { type: 'base64', media_type: 'image/png', data: bytes.toString('base64') } };
}

/** One headless `claude -p` call on the subscription with no tools. `content` is a list of text and image blocks. */
export function callClaudeJudge({ claude, model, content }) {
  const message = JSON.stringify({ type: 'user', message: { role: 'user', content } });
  const result = spawnSync(claude, ['-p', '--model', model, '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--tools', '', '--system-prompt', JUDGE_ROLE, '--strict-mcp-config', '--no-session-persistence', '--max-budget-usd', '0.2'],
  { input: `${message}\n`, encoding: 'utf8', timeout: 300000, maxBuffer: 64 * 1024 * 1024 });
  const final = result.stdout.split('\n').filter(Boolean).map(line => JSON.parse(line)).find(event => event.type === 'result');
  const text = String(final?.result ?? '');
  const match = /WINNER:\s*(first|second)/i.exec(text);
  return { answer: match ? match[1].toLowerCase() : null, costUsd: final?.total_cost_usd ?? 0, note: text.split('\n').find(line => line.trim()) };
}

function askJudge({ claude, model, firstDirectory, secondDirectory, taskId }) {
  return readImages({ firstDirectory, secondDirectory, taskId }).then(images => {
    const content = [{ type: 'text', text: JUDGE_QUESTION }];
    for (const view of VIEW_ORDER) {
      content.push({ type: 'text', text: `View "${view}", first render:` }, imageBlock(images[view].first));
      content.push({ type: 'text', text: `View "${view}", second render:` }, imageBlock(images[view].second));
    }
    return callClaudeJudge({ claude, model, content });
  });
}

async function readImages({ firstDirectory, secondDirectory, taskId }) {
  const images = {};
  for (const view of VIEW_ORDER) {
    images[view] = {
      first: await readFile(join(firstDirectory, `${taskId}-${view}.png`)),
      second: await readFile(join(secondDirectory, `${taskId}-${view}.png`)),
    };
  }
  return images;
}

async function judgeVariants({ claude, model, a, b, control, seed, directory, label }) {
  const records = [];
  for (const [taskIndex, taskId] of COLD_TASKS.entries()) {
    for (let repeat = 0; repeat < REPEATS; repeat++) {
      const firstSide = firstSideOf(seed, taskIndex, repeat);
      const sideLabels = { a, b: control ? a : b };
      const firstLabel = sideLabels[firstSide];
      const secondLabel = sideLabels[firstSide === 'a' ? 'b' : 'a'];
      const verdict = await askJudge({ claude, model, taskId, firstDirectory: join(directory, firstLabel), secondDirectory: join(directory, secondLabel) });
      const winnerSide = verdict.answer === null ? null : verdict.answer === 'first' ? firstSide : (firstSide === 'a' ? 'b' : 'a');
      records.push({ task: taskId, repeat, firstSide, answer: verdict.answer, winnerSide, costUsd: verdict.costUsd, note: verdict.note });
    }
  }
  const decided = records.filter(record => record.answer !== null);
  const summary = { trials: decided.length, costUsd: Number(records.reduce((sum, record) => sum + record.costUsd, 0).toFixed(4)) };
  if (control) {
    const pickedFirst = decided.filter(record => record.answer === 'first').length;
    Object.assign(summary, { pickedFirst, pickedSecond: decided.length - pickedFirst, pBias: binomialP(pickedFirst, decided.length) });
  } else {
    const bWins = decided.filter(record => record.winnerSide === 'b').length;
    Object.assign(summary, { winsA: decided.length - bWins, winsB: bWins, pValue: binomialP(bWins, decided.length) });
  }
  return { label, model, seed, a, b: control ? `${a} (control)` : b, summary, records };
}

if (import.meta.url === `file:///${process.argv[1].replaceAll('\\', '/')}`) {
  const [command, ...rest] = process.argv.slice(2);
  const { values } = parseArgs({ args: rest, options: {
    claude: { type: 'string' }, model: { type: 'string', default: 'sonnet' }, label: { type: 'string' }, a: { type: 'string' }, b: { type: 'string' },
    seed: { type: 'string', default: String(DEFAULT_SEED) }, directory: { type: 'string', default: join(repository, 'artifacts', 'agent-modeling', 'default-judge') },
    control: { type: 'boolean', default: false }, 'no-floor': { type: 'boolean', default: false },
  } });
  if (command === 'render') {
    await renderVariant({ label: values.label, noFloor: values['no-floor'], directory: join(values.directory, values.label) });
  } else if (command === 'judge') {
    const result = await judgeVariants({ claude: values.claude, model: values.model, a: values.a, b: values.b, control: values.control, seed: Number(values.seed), directory: values.directory, label: values.label ?? `${values.a}-vs-${values.b}` });
    console.log(JSON.stringify(result, null, 2));
  } else {
    throw new Error('Use the render or judge command.');
  }
}
