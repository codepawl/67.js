import { appendFileSync } from 'node:fs';

export const CALL_LOG_ENVIRONMENT_VARIABLE = 'SIXTYSEVENJS_MCP_LOG';

// Result size is the UTF-8 length of the text content plus the base64 length of images: what the agent has to read.
function resultByteCount(result) {
  let total = 0;
  for (const item of result?.content ?? []) {
    if (typeof item.text === 'string') {
      total += Buffer.byteLength(item.text);
    } else if (typeof item.data === 'string') {
      total += item.data.length;
    }
  }
  return total;
}

// Returns null when no path is set, so the server pays for nothing. A line holds the time, tool name, duration, outcome
// and result size, never the arguments, the scene or any path the caller passed.
export function createCallLogger(logPath, { now = () => performance.now(), clock = () => new Date() } = {}) {
  if (!logPath) {
    return null;
  }
  return async function logCall(toolName, run) {
    const startedAt = now();
    let result;
    let thrown;
    try {
      result = await run();
    } catch (error) {
      thrown = error;
    }
    const failed = thrown !== undefined || result?.isError === true;
    const line = {
      time: clock().toISOString(),
      tool: toolName,
      durationMs: Math.round((now() - startedAt) * 10) / 10,
      ok: !failed,
      ...(failed ? { error: thrown !== undefined ? 'thrown' : 'tool_error' } : {}),
      resultBytes: resultByteCount(result),
    };
    try {
      appendFileSync(logPath, `${JSON.stringify(line)}\n`);
    } catch (error) {
      console.error(`67js call log write failed: ${error.message}`);
    }
    if (thrown !== undefined) {
      throw thrown;
    }
    return result;
  };
}
