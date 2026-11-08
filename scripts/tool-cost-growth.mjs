// The growth gate for what MCP tools cost an agent. A pull request is measured against the base branch, so no pull request
// edits a number that another one edits. It reuses the size notes: acceptInstruction comes from size-growth.mjs.
import { acceptInstruction } from './size-growth.mjs';

export const TOOL_ALLOWANCE_BYTES = 64;
export const RESULT_ALLOWANCE_BYTES = 128;
export const TOTAL_ALLOWANCE_BYTES = 128;
export const TOTAL_NAME = 'tool-total';
const BUDGET_MARGIN = 1.02;
const BUDGET_ROUNDING_BYTES = 10;
const MOVE_ADVICE = 'Move rare detail into scene_capabilities or reference a shared schema.';

/** Flattens a report from measureToolCost() into named byte counts: tool:<name>, tool-total and result:<name>. */
export function costsFrom(report) {
  const costs = { [TOTAL_NAME]: report.schemaTotal.bytes };
  for (const row of report.schemas) costs[`tool:${row.name}`] = row.bytes;
  for (const row of report.results) costs[`result:${row.name}`] = row.bytes;
  return costs;
}

export function costAllowance(name) {
  if (name === TOTAL_NAME) return TOTAL_ALLOWANCE_BYTES;
  return name.startsWith('result:') ? RESULT_ALLOWANCE_BYTES : TOOL_ALLOWANCE_BYTES;
}

/** Compares each cost with the same cost on the base branch. A cost the base does not have is reported, not failed. */
export function compareCostsToBase(measured, baseMeasured, accepted = new Map()) {
  const rows = [];
  const problems = [];
  for (const [name, bytes] of Object.entries(measured)) {
    const base = baseMeasured[name];
    const growth = base === undefined ? null : bytes - base;
    const allowance = base === undefined ? null : costAllowance(name);
    const isAccepted = accepted.has(name);
    rows.push({ name, bytes, base: base ?? null, growth, allowance, accepted: isAccepted });
    if (growth !== null && growth > allowance && !isAccepted) {
      problems.push(`${name} grew by ${growth} bytes against the base branch (${base} to ${bytes}), over its allowance of ${allowance}. ${MOVE_ADVICE} ${acceptInstruction(name)}`);
    }
  }
  return { rows, problems };
}

function noteFor(row) {
  if (row.growth === null) return 'new, reported only';
  if (row.growth <= row.allowance) return '';
  return row.accepted ? 'accepted' : 'OVER';
}

/** Prints the costs that moved. An unchanged cost adds nothing, so the table stays short. */
export function formatCostRows(rows) {
  const moved = rows.filter(row => row.growth !== 0);
  if (!moved.length) return 'No tool schema or result changed against the base branch.';
  const header = `${'cost'.padEnd(34)}${'bytes'.padStart(9)}${'base'.padStart(9)}${'growth'.padStart(9)}${'allowed'.padStart(9)}  note`;
  const lines = moved.map(row => [
    row.name.padEnd(34), String(row.bytes).padStart(9), String(row.base ?? '-').padStart(9),
    String(row.growth ?? '-').padStart(9), String(row.allowance ?? '-').padStart(9), `  ${noteFor(row)}`,
  ].join(''));
  return [header, ...lines].join('\n');
}

function ceilingFor(bytes) {
  return Math.ceil((bytes * BUDGET_MARGIN) / BUDGET_ROUNDING_BYTES) * BUDGET_ROUNDING_BYTES;
}

/** Release ceilings: 2% over what is measured now. Only the large tools get their own line, the rest share schemaOtherToolBytes. */
export function budgetsFrom(measured, previous) {
  const budgets = { ...previous, schemaToolBytes: {}, resultBytes: {} };
  budgets.schemaTotalBytes = ceilingFor(measured[TOTAL_NAME]);
  for (const [name, bytes] of Object.entries(measured)) {
    if (name.startsWith('tool:') && bytes > previous.schemaOtherToolBytes) budgets.schemaToolBytes[name.slice('tool:'.length)] = ceilingFor(bytes);
    if (name.startsWith('result:')) budgets.resultBytes[name.slice('result:'.length)] = ceilingFor(bytes);
  }
  return budgets;
}

/**
 * The absolute ceilings in bench/tool-cost-ceilings.json. Unlike the release budgets they are set by hand and checked on every run,
 * so the total cannot drift back up one allowed step at a time. A ceiling is only raised with a reason in the pull request.
 */
export function hardCeilingProblems(measured, ceilings) {
  const problems = [];
  const check = (name, bytes, ceiling) => {
    if (bytes > ceiling) problems.push(`${name} is ${bytes} bytes, over its absolute ceiling of ${ceiling} by ${bytes - ceiling}. ${MOVE_ADVICE} Raise the ceiling in bench/tool-cost-ceilings.json only with a reason in the pull request.`);
  };
  check(TOTAL_NAME, measured[TOTAL_NAME], ceilings.schemaTotalBytes);
  for (const [name, bytes] of Object.entries(measured)) {
    if (name.startsWith('tool:')) check(name, bytes, ceilings.schemaToolBytes[name.slice('tool:'.length)] ?? ceilings.schemaOtherToolBytes);
    if (name.startsWith('result:')) {
      const ceiling = ceilings.resultBytes[name.slice('result:'.length)];
      if (ceiling !== undefined) check(name, bytes, ceiling);
    }
  }
  return problems;
}

/** The release ceilings in bench/tool-cost-budgets.json that the measured costs are past, as problems. */
export function ceilingProblems(measured, budgets) {
  const problems = [];
  const check = (name, bytes, ceiling) => {
    if (bytes > ceiling) problems.push(`${name} is ${bytes} bytes, over its release ceiling of ${ceiling} by ${bytes - ceiling}. ${MOVE_ADVICE}`);
  };
  check(TOTAL_NAME, measured[TOTAL_NAME], budgets.schemaTotalBytes);
  for (const [name, bytes] of Object.entries(measured)) {
    if (name.startsWith('tool:')) check(name, bytes, budgets.schemaToolBytes[name.slice('tool:'.length)] ?? budgets.schemaOtherToolBytes);
    if (name.startsWith('result:')) {
      const ceiling = budgets.resultBytes[name.slice('result:'.length)];
      if (ceiling === undefined) problems.push(`${name} has no release ceiling. A release adds one with npm run tool-cost:release.`);
      else check(name, bytes, ceiling);
    }
  }
  return problems;
}
