// Why a bench run made no scene tool calls. A run with 0 scene calls is either the machine's fault (infra: claude -p or
// the MCP server never got going) or the model's (it quit after ToolSearch, refused, or answered without tools).
// Infra runs are retried once and kept out of pass@1; model runs stay counted and carry a label.
//
// classifyZeroCalls(output, { exitCode, errors, toolCalls }) returns null when the run made scene calls, else
// { kind: 'infra' | 'model', cause, detail }.
//   infra  start-up-failure      no init event, or no result event, or a non-zero exit without a result
//   infra  mcp-server-failed     the init event lists the Crucible server as not connected
//   infra  timeout               the run was killed by the timeout (no result, exit signal)
//   infra  toolsearch-empty      ToolSearch ran but returned no Crucible tool, so the model never saw the tools
//   model  toolsearch-then-quit  ToolSearch returned the Crucible tools and the model ended without calling one
//   model  refusal               the model declined (stop reason refusal, or a refusal in the result text)
//   model  no-tool-use           the model answered without ToolSearch or any tool call
const MCP_SERVER_NAME = 'crucible';
const REFUSAL_PATTERN = /\b(i can(?:'|’)?t (?:help|assist|do)|i(?:'|’)m (?:unable|not able) to|i (?:cannot|won(?:'|’)t)|i must decline)\b/i;

function textOf(content) {
  if (typeof content === 'string') return content;
  return (content ?? []).filter(block => block.type === 'text').map(block => block.text).join('');
}

/** Parses the stream-json lines into the facts the classifier needs. */
export function readRunFacts(output) {
  const facts = { initialized: false, serverStatus: null, toolSearchCalls: 0, toolSearchSawSceneTools: false, result: null };
  const toolSearchIds = new Set();
  for (const line of String(output ?? '').split('\n')) {
    if (!line.trim().startsWith('{')) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === 'system' && event.subtype === 'init') {
      facts.initialized = true;
      const server = (event.mcp_servers ?? []).find(candidate => candidate.name === MCP_SERVER_NAME);
      facts.serverStatus = server ? server.status : 'missing';
    }
    if (event.type === 'assistant') {
      for (const block of event.message?.content ?? []) {
        if (block.type === 'tool_use' && block.name === 'ToolSearch') {
          facts.toolSearchCalls++;
          toolSearchIds.add(block.id);
        }
      }
    }
    if (event.type === 'user') {
      for (const block of event.message?.content ?? []) {
        if (block.type === 'tool_result' && toolSearchIds.has(block.tool_use_id) && !block.is_error) {
          if (textOf(block.content).includes(`mcp__${MCP_SERVER_NAME}__`)) facts.toolSearchSawSceneTools = true;
        }
      }
    }
    if (event.type === 'result') facts.result = event;
  }
  return facts;
}

export function classifyZeroCalls(output, { exitCode = 0, errors = '', toolCalls = 0 } = {}) {
  if (toolCalls > 0) return null;
  const facts = readRunFacts(output);
  const stderrNote = String(errors ?? '').trim().split('\n')[0].slice(0, 120);
  if (!facts.initialized) return { kind: 'infra', cause: 'start-up-failure', detail: stderrNote || `no init event, exit ${exitCode}` };
  if (facts.serverStatus !== 'connected') return { kind: 'infra', cause: 'mcp-server-failed', detail: `Crucible server ${facts.serverStatus}` };
  if (!facts.result) {
    return exitCode === null || exitCode === undefined
      ? { kind: 'infra', cause: 'timeout', detail: 'killed before a result' }
      : { kind: 'infra', cause: 'start-up-failure', detail: stderrNote || `no result event, exit ${exitCode}` };
  }
  const resultText = String(facts.result.result ?? '');
  if (facts.result.stop_reason === 'refusal' || (facts.toolSearchCalls === 0 && REFUSAL_PATTERN.test(resultText))) {
    return { kind: 'model', cause: 'refusal', detail: resultText.slice(0, 120) };
  }
  if (facts.toolSearchCalls > 0 && !facts.toolSearchSawSceneTools) {
    return { kind: 'infra', cause: 'toolsearch-empty', detail: `${facts.toolSearchCalls} ToolSearch calls returned no Crucible tool` };
  }
  if (facts.toolSearchCalls > 0) return { kind: 'model', cause: 'toolsearch-then-quit', detail: `${facts.toolSearchCalls} ToolSearch calls, then no scene call` };
  return { kind: 'model', cause: 'no-tool-use', detail: resultText.slice(0, 120) };
}
