// Blind pairwise look judge for two systems that built the same task (issue #987). A vision model sees the render of
// system A and the render of system B as "first" and "second", in a seeded random order, and says which looks like the
// better finished render of the object. It never learns which system made which. Wins per system and an exact binomial
// p against 0.5 tell whether the judge prefers one. A control pairs one system's render with itself: any preference for
// "first" or "second" is position bias, and a result near the control's size is not a preference for a system.
//
// node bench/agent-modeling/pairwise-judge.mjs --claude <path> --model <name> --name <result name> --tasks crate,bolt
//   --a "Crucible MCP=artifacts/agent-modeling/<run>/look/{attempt}/{task}-three-quarter.png"
//   --b "three.js by code=artifacts/agent-modeling/<run>/{task}-{attempt}.png" [--attempts 1] [--seed 53] [--control-only]
// Each side is `label=image pattern`; `{task}` and `{attempt}` are filled in. One judge call per task, attempt and
// pairing (the pair, then the control). The result is written to bench/agent-modeling/results/<name>.json, and
// compare-threejs.mjs --pairwise prints it. Calls go through headless `claude -p` on the subscription, never the API.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { binomialP, callClaudeJudge, firstSideOf, imageBlock } from './default-judge.mjs';

const repository = resolve(import.meta.dirname, '../..');
const DEFAULT_SEED = 53;

export const PAIRWISE_QUESTION = `You see two renders of the same 3D object, drawn by two different systems. The first render comes first, the second render second.
Which one looks like the better finished render of that object: a believable shape, proportions, surface and lighting, grounded on a surface, with nothing missing or broken?
Judge only the pictures. Give one short sentence naming what decided it, then as the very last line exactly: WINNER: first   or   WINNER: second`;

/** Splits `label=pattern` at the first equals sign. */
export function parseSide(argument) {
  const separator = String(argument ?? '').indexOf('=');
  if (separator < 1 || separator === argument.length - 1) throw new RangeError('Give each side as "label=image pattern", for example "Crucible=dir/{task}-{attempt}.png".');
  return { label: argument.slice(0, separator), pattern: argument.slice(separator + 1) };
}

function imagePathOf(side, task, attempt) {
  return resolve(side.pattern.replaceAll('{task}', task).replaceAll('{attempt}', String(attempt)));
}

/**
 * One entry per task and attempt, with the seeded order of the two renders. A control pairing shows side A's own
 * image on both sides, so its two inputs are identical.
 */
export function planPairs({ tasks, attempts = 1, seed = DEFAULT_SEED, sides, control = false }) {
  const pairs = [];
  for (const [taskIndex, task] of tasks.entries()) {
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const firstSide = firstSideOf(seed, taskIndex, attempt - 1);
      const secondSide = firstSide === 'a' ? 'b' : 'a';
      const own = { a: sides.a, b: control ? sides.a : sides.b };
      pairs.push({
        task,
        attempt,
        firstSide,
        firstLabel: own[firstSide].label,
        secondLabel: own[secondSide].label,
        firstImage: imagePathOf(own[firstSide], task, attempt),
        secondImage: imagePathOf(own[secondSide], task, attempt),
      });
    }
  }
  return pairs;
}

/** Asks `ask(pair)` once per pair and maps the answer back to the system that won. `ask` returns { answer, costUsd, note }. */
export async function judgePairs({ pairs, ask }) {
  const records = [];
  for (const pair of pairs) {
    const verdict = await ask(pair);
    const answer = verdict.answer ?? null;
    const winnerSide = answer === null ? null : answer === 'first' ? pair.firstSide : (pair.firstSide === 'a' ? 'b' : 'a');
    records.push({
      task: pair.task,
      attempt: pair.attempt,
      firstSide: pair.firstSide,
      answer,
      winnerSide,
      winner: answer === null ? null : answer === 'first' ? pair.firstLabel : pair.secondLabel,
      costUsd: verdict.costUsd ?? 0,
      note: verdict.note,
    });
  }
  return records;
}

/** Wins per system and the exact p for the pairing; for the control, how often "first" was picked and the p of that. */
export function summarizePairing({ records, labels, control }) {
  const decided = records.filter(record => record.answer !== null);
  const costUsd = Number(records.reduce((sum, record) => sum + record.costUsd, 0).toFixed(4));
  if (control) {
    const pickedFirst = decided.filter(record => record.answer === 'first').length;
    return { trials: decided.length, undecided: records.length - decided.length, pickedFirst, pickedSecond: decided.length - pickedFirst, pBias: binomialP(pickedFirst, decided.length), costUsd };
  }
  const winsB = decided.filter(record => record.winnerSide === 'b').length;
  return { trials: decided.length, undecided: records.length - decided.length, wins: { [labels.a]: decided.length - winsB, [labels.b]: winsB }, pValue: binomialP(winsB, decided.length), costUsd };
}

async function readImageBlock(path) {
  return imageBlock(await readFile(path));
}

/** The judge call for real runs: both images and the question in one message to headless Claude. */
export function claudeAsk({ claude, model }) {
  return async pair => {
    const content = [
      { type: 'text', text: PAIRWISE_QUESTION },
      { type: 'text', text: 'First render:' },
      await readImageBlock(pair.firstImage),
      { type: 'text', text: 'Second render:' },
      await readImageBlock(pair.secondImage),
    ];
    return callClaudeJudge({ claude, model, content });
  };
}

/** Runs the pairing (unless controlOnly) and the control, and returns the result file contents. */
export async function runPairwise({ ask, tasks, attempts, seed, sides, controlOnly = false, model = null }) {
  const labels = { a: sides.a.label, b: sides.b.label };
  const result = { mode: 'pairwise', model, seed, tasks, attempts, labels, pairing: null, control: null };
  if (!controlOnly) {
    const records = await judgePairs({ pairs: planPairs({ tasks, attempts, seed, sides }), ask });
    result.pairing = { summary: summarizePairing({ records, labels, control: false }), records };
  }
  const controlRecords = await judgePairs({ pairs: planPairs({ tasks, attempts, seed, sides, control: true }), ask });
  result.control = { label: labels.a, summary: summarizePairing({ records: controlRecords, labels, control: true }), records: controlRecords };
  return result;
}

/** Markdown lines for a result file, as compare-threejs.mjs prints them. */
export function pairwiseTable(result) {
  const lines = [];
  if (result.pairing) {
    const { summary } = result.pairing;
    const [labelA, labelB] = [result.labels.a, result.labels.b];
    lines.push('| Pairwise judge | Trials | Wins | Exact p |', '| --- | --- | --- | --- |');
    lines.push(`| ${labelA} vs ${labelB} | ${summary.trials} | ${labelA} ${summary.wins[labelA]}, ${labelB} ${summary.wins[labelB]} | ${summary.pValue.toFixed(4)} |`);
  }
  const control = result.control.summary;
  lines.push('', '| Control (same render on both sides) | Trials | Picked first | Picked second | Exact p of position bias |', '| --- | --- | --- | --- | --- |');
  lines.push(`| ${result.control.label} | ${control.trials} | ${control.pickedFirst} | ${control.pickedSecond} | ${control.pBias.toFixed(4)} |`);
  return lines.join('\n');
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  const { values } = parseArgs({ options: {
    claude: { type: 'string', default: process.env.CLAUDE_EXECUTABLE ?? 'claude' },
    model: { type: 'string', default: 'sonnet' },
    name: { type: 'string' },
    tasks: { type: 'string' },
    a: { type: 'string' },
    b: { type: 'string' },
    attempts: { type: 'string', default: '1' },
    seed: { type: 'string', default: String(DEFAULT_SEED) },
    'control-only': { type: 'boolean', default: false },
  } });
  if (!values.name || !values.tasks || !values.a) throw new Error('Give --name, --tasks and --a (and --b unless --control-only).');
  const sides = { a: parseSide(values.a), b: parseSide(values.b ?? values.a) };
  const result = await runPairwise({
    ask: claudeAsk({ claude: values.claude, model: values.model }),
    tasks: values.tasks.split(','),
    attempts: Number(values.attempts),
    seed: Number(values.seed),
    sides,
    controlOnly: values['control-only'],
    model: values.model,
  });
  const outputPath = join(repository, 'bench', 'agent-modeling', 'results', `${values.name}.json`);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`);
  console.log(pairwiseTable(result));
  console.log(`\nWritten to bench/agent-modeling/results/${values.name}.json`);
}
