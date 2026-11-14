import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { AGENT_SCENE_DEFAULT_LIMITS } from '../src/agent-scene-capabilities.js';

async function readText(relativePath) {
  const text = await readFile(new URL(relativePath, import.meta.url), 'utf8');
  return text.replace(/\r\n/g, '\n');
}

const mcpGuide = await readText('../docs/mcp.md');
const readme = await readText('../README.md');
const llmsText = await readText('../public/llms.txt');

test('the mcp guide limits table states the checkpoint limit the code enforces', () => {
  const row = mcpGuide.match(/^\| Checkpoints per session \| (\d+) \|$/m);
  assert.ok(row, 'docs/mcp.md Limits table needs a "Checkpoints per session" row');
  assert.equal(Number(row[1]), AGENT_SCENE_DEFAULT_LIMITS.maxCheckpoints);
  const sentence = mcpGuide.match(/Each scene keeps up to (\d+) checkpoints/);
  assert.ok(sentence, 'docs/mcp.md names the checkpoint limit in prose');
  assert.equal(Number(sentence[1]), AGENT_SCENE_DEFAULT_LIMITS.maxCheckpoints);
});

test('the mcp guide does not quote a stale tool schema byte total', () => {
  assert.doesNotMatch(mcpGuide, /schemas total [\d,]+ bytes/);
  assert.match(mcpGuide, /bench\/tool-cost-ceilings\.json/);
});

test('llms.txt and the README say the quality render setting ships', () => {
  assert.doesNotMatch(llmsText, /Planned, not shipped: a `quality`/);
  assert.doesNotMatch(llmsText, /Do not call either one/);
  assert.match(llmsText, /settings\.quality/);
  assert.match(llmsText, /mcp\.md#render-quality/);
  assert.doesNotMatch(readme, /`quality` setting that picks a tier is planned/);
  assert.match(readme, /docs\/mcp\.md#render-quality/);
});
