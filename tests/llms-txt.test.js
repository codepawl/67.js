import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildLlmsText, listRegisteredTools } from '../scripts/generate-llms.mjs';

// A Windows checkout may turn LF into CRLF; compare the text, not the line endings.
const llmsText = (await readFile(new URL('../public/llms.txt', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');

test('llms.txt names every registered MCP tool', async () => {
  const tools = await listRegisteredTools();
  const missing = tools.filter(tool => !llmsText.includes(`\`${tool.name}\``)).map(tool => tool.name);
  assert.deepEqual(missing, [], 'run `npm run llms` to add the tool to public/llms.txt');
});

test('llms.txt is what the generator writes from the current registry', async () => {
  const expected = buildLlmsText(await listRegisteredTools());
  assert.equal(llmsText, expected, 'public/llms.txt is stale, run `npm run llms`');
});

test('llms.txt points agents at the server, the plugin and the changelog data', () => {
  assert.doesNotMatch(llmsText, /does not expose an MCP server/);
  assert.match(llmsText, /\/plugin marketplace add codepawl\/crucible/);
  assert.match(llmsText, /\/plugin install crucible@crucible/);
  assert.match(llmsText, /@codepawlhq\/crucible/);
  assert.match(llmsText, /changelog\.json/);
});
