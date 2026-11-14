// Fix rounds: how many times an agent changed the model after it first looked at a render.
// A run that builds the object and renders once has 0. Each write or edit step after the first render is one round,
// so a run that looks, edits, looks and edits again has 2. It is recorded next to `toolCalls` and `toolErrors`.

const MCP_RENDER_TOOLS = ['scene_look', 'scene_render_submit'];
const MCP_WRITE_TOOLS = ['scene_apply', 'scene_create_asset'];
const CODE_WRITE_TOOLS = ['Write', 'Edit'];
const CODE_RENDER_COMMAND = /build\.mjs|\bnode\b/;

/** The tool name of a Crucible MCP call, with or without the `mcp__<server>__` prefix. */
function mcpToolName(step) {
  return step.name.replace(/^mcp__.*?__/, '');
}

export function isMcpRender(step) {
  return MCP_RENDER_TOOLS.includes(mcpToolName(step));
}

export function isMcpWrite(step) {
  return MCP_WRITE_TOOLS.includes(mcpToolName(step));
}

/** The three.js agent renders by running its build script with Bash. */
export function isCodeRender(step) {
  return step.name === 'Bash' && CODE_RENDER_COMMAND.test(String(step.input?.command ?? ''));
}

export function isCodeWrite(step) {
  return CODE_WRITE_TOOLS.includes(step.name);
}

/**
 * @param {{ name: string, input?: object }[]} steps tool calls in the order the agent made them
 * @param {{ isRender: (step) => boolean, isWrite: (step) => boolean }} kinds
 * @returns {number} write steps after the first render; 0 when the agent never rendered
 */
export function countFixRounds(steps, { isRender, isWrite }) {
  const firstRender = steps.findIndex(isRender);
  if (firstRender === -1) return 0;
  return steps.slice(firstRender + 1).filter(isWrite).length;
}
