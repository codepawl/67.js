// Runaway guard for `claude -p` bench runs.
//
// The bench used to pass `--max-budget-usd` to claude. Claude Code shows that budget to the model as a
// running "remaining" figure, and Haiku read a small remainder as a reason to stop before it started (#962).
// The cap now lives here, outside the model's view: the bench adds up the token cost of the streamed
// messages itself and kills the run when the estimate passes the cap, or when the time limit is reached.

// Dollars per million tokens, deliberately on the high side so the guard fires early rather than late.
const RATES_PER_MILLION_TOKENS = {
  haiku: { input: 1, output: 5 },
  sonnet: { input: 3, output: 15 },
  opus: { input: 5, output: 25 },
};
const CACHE_WRITE_MULTIPLIER = 1.25;
const CACHE_READ_MULTIPLIER = 0.1;

export function ratesForModel(model) {
  const name = String(model ?? '').toLowerCase();
  if (name.includes('haiku')) return RATES_PER_MILLION_TOKENS.haiku;
  if (name.includes('sonnet')) return RATES_PER_MILLION_TOKENS.sonnet;
  return RATES_PER_MILLION_TOKENS.opus;
}

export function estimateUsageCostUsd(usage, model) {
  const rates = ratesForModel(model);
  const inputTokens = usage?.input_tokens ?? 0;
  const outputTokens = usage?.output_tokens ?? 0;
  const cacheWriteTokens = usage?.cache_creation_input_tokens ?? 0;
  const cacheReadTokens = usage?.cache_read_input_tokens ?? 0;
  const inputTokenEquivalents = inputTokens + cacheWriteTokens * CACHE_WRITE_MULTIPLIER + cacheReadTokens * CACHE_READ_MULTIPLIER;
  return (inputTokenEquivalents * rates.input + outputTokens * rates.output) / 1e6;
}

/**
 * Watches a claude child process. Feed it each stdout chunk; it kills the child when the estimated cost
 * passes `budgetUsd` or when `timeoutSeconds` runs out. Call `stop()` once the child has closed.
 */
export function createRunGuard({ child, model, budgetUsd, timeoutSeconds }) {
  const costByMessageId = new Map();
  let pendingText = '';
  let trippedReason = null;

  const trip = reason => {
    if (trippedReason) return;
    trippedReason = reason;
    child.kill();
  };

  const timer = setTimeout(() => trip('timeout'), Number(timeoutSeconds) * 1000);

  const totalCostUsd = () => [...costByMessageId.values()].reduce((sum, cost) => sum + cost, 0);

  const readLine = line => {
    if (!line.startsWith('{')) return;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    if (event.type !== 'assistant' || !event.message?.usage) return;
    // One message is streamed as several events that repeat its usage, so each message id counts once.
    const messageId = event.message.id ?? `line-${costByMessageId.size}`;
    costByMessageId.set(messageId, estimateUsageCostUsd(event.message.usage, event.message.model ?? model));
    if (totalCostUsd() > Number(budgetUsd)) trip('budget');
  };

  return {
    feed(chunk) {
      pendingText += chunk;
      const lines = pendingText.split('\n');
      pendingText = lines.pop();
      for (const line of lines) readLine(line.trim());
    },
    stop() {
      clearTimeout(timer);
    },
    get reason() {
      return trippedReason;
    },
    get estimatedCostUsd() {
      return totalCostUsd();
    },
  };
}
