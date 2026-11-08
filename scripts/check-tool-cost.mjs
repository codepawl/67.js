// Checks what the MCP tools cost an agent: npm run tool-cost
// A pull request fails when a tool schema, the schema total or a typical result grows past its allowance against the base branch
// (--base, default origin/main) unless its own changes/*.size.md accepts it. --absolute also enforces the release ceilings in
// bench/tool-cost-budgets.json. --set-budgets refreshes the ceilings at release. The absolute ceilings in
// bench/tool-cost-ceilings.json are enforced on every run, beside the growth check.
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { measureToolCost } from './measure-tool-cost.mjs';
import { DEFAULT_BASE_REF, baseRefExists, measureBase, readAcceptedBundles } from './size-base.mjs';
import { budgetsFrom, ceilingProblems, compareCostsToBase, costsFrom, formatCostRows, hardCeilingProblems } from './tool-cost-growth.mjs';

const BUDGETS_PATH = 'bench/tool-cost-budgets.json';
const CEILINGS_PATH = 'bench/tool-cost-ceilings.json';
// The measuring script imports the source beside itself, so the base branch runs its own copy of it.
const TOOL_COST_METHOD = {
  script: fileURLToPath(new URL('./measure-tool-cost.mjs', import.meta.url)),
  runInBase: true,
  files: ['measure-tool-cost.mjs', 'check-tool-cost.mjs', 'tool-cost-growth.mjs', 'size-base.mjs'],
};

const argumentsGiven = process.argv.slice(2);
const flags = new Set(argumentsGiven);

function valueAfter(flag) {
  const index = argumentsGiven.indexOf(flag);
  return index === -1 ? undefined : argumentsGiven[index + 1];
}

const requestedBase = valueAfter('--base');
const baseRef = requestedBase ?? DEFAULT_BASE_REF;
if (requestedBase && !baseRefExists(baseRef)) {
  console.error(`The base ref ${baseRef} does not exist. Fetch it first, for example: git fetch origin main`);
  process.exit(1);
}
const refreshing = flags.has('--set-budgets');
const checkGrowth = baseRefExists(baseRef) && !refreshing;
const baseMeasurement = checkGrowth ? measureBase(baseRef, TOOL_COST_METHOD) : null;
const measured = costsFrom(await measureToolCost());
const budgets = JSON.parse(await readFile(BUDGETS_PATH, 'utf8'));
const problems = [];

if (refreshing) {
  await writeFile(BUDGETS_PATH, `${JSON.stringify(budgetsFrom(measured, budgets), null, 2)}\n`);
  console.log(`Wrote the release ceilings to ${BUDGETS_PATH}.`);
  process.exit(0);
}

const ceilings = JSON.parse(await readFile(CEILINGS_PATH, 'utf8'));
problems.push(...hardCeilingProblems(measured, ceilings));

if (checkGrowth) {
  const accepted = readAcceptedBundles(baseRef);
  const growth = compareCostsToBase(measured, costsFrom(await baseMeasurement), accepted);
  console.log(`Tool cost against ${baseRef}, in bytes:`);
  console.log(formatCostRows(growth.rows));
  for (const [name, reason] of accepted) {
    if (name in measured) console.log(`Accepted: ${name}, ${reason}`);
  }
  problems.push(...growth.problems);
} else {
  console.log(`No ${baseRef} to compare with, so the growth check is skipped. Fetch it, or pass --base <ref>.`);
}

// The absolute budgets are the release ceilings. They are reported on a pull request and enforced with --absolute.
const overCeiling = ceilingProblems(measured, budgets);
if (overCeiling.length) {
  if (flags.has('--absolute')) {
    problems.push(...overCeiling);
  } else {
    console.log(`\n${overCeiling.length} cost(s) are past their release ceiling. A release refreshes them with npm run tool-cost:release. List them with npm run tool-cost -- --absolute.`);
  }
}
if (problems.length) {
  console.error(`\n${problems.length} tool cost problem(s):`);
  for (const problem of problems) console.error(`- ${problem}`);
  process.exit(1);
}
console.log('\nNo tool cost grew past its allowance.');
