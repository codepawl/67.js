import test from 'node:test';
import assert from 'node:assert/strict';
import { collectFields, findUnmarkedFields, newerFields, readGuides, readReleasedFields } from '../scripts/guide-fields.mjs';
import { withVersionHint } from '../scripts/mcp-server.mjs';

const released = { release: '0.20.0', game: ['player', 'player.node', 'npcs'], tools: ['scene_apply operations', 'scene_render_submit settings.id'] };

test('the guides tag every field that is newer than the last release', async () => {
  const releasedFields = readReleasedFields();
  const newer = newerFields(await collectFields(), releasedFields);
  const problems = findUnmarkedFields({ guides: readGuides(), newer, released: releasedFields });
  assert.deepEqual(problems, [], `Add {since X.Y.Z} beside each field, or run: node scripts/guide-fields.mjs snapshot (after a release).`);
});

test('the snapshot of the last release lists the game and tool fields', () => {
  const releasedFields = readReleasedFields();
  assert.ok(releasedFields.game.includes('player.animation'));
  assert.ok(releasedFields.game.includes('npcs[].path'));
  assert.ok(releasedFields.tools.some(entry => entry.startsWith('scene_render_submit settings.')));
});

test('newerFields keeps only what the release lacks', () => {
  const current = { game: ['player', 'player.node', 'player.brake', 'npcs'], tools: ['scene_apply operations', 'scene_render_submit settings.id', 'scene_render_submit settings.tonemap'] };
  assert.deepEqual(newerFields(current, released), { game: ['player.brake'], tools: ['scene_render_submit settings.tonemap'] });
});

test('an unmarked newer game field in a table row is reported, a tagged one is not', () => {
  const newer = { game: ['player.brake'], tools: [] };
  const unmarked = { 'docs/game.md': '| `player.brake` | 1 | Stopping force |' };
  const tagged = { 'docs/game.md': '| `player.brake` {since 0.21.0} | 1 | Stopping force |' };
  assert.equal(findUnmarkedFields({ guides: unmarked, newer, released }).length, 1);
  assert.deepEqual(findUnmarkedFields({ guides: tagged, newer, released }), []);
});

test('one tag covers the paragraph it sits in, not the next paragraph', () => {
  const newer = { game: [], tools: ['scene_render_submit settings.tonemap'] };
  const guides = { 'docs/mcp.md': 'Pass `tonemap` for the curve {since 0.21.0}.\nIt also changes `tonemap` output.\n\nLater, `tonemap` shows again.' };
  const problems = findUnmarkedFields({ guides, newer, released });
  assert.equal(problems.length, 1);
  assert.match(problems[0].line, /Later/);
});

test('a newer tool field named like a released one is not matched by its common name', () => {
  const newer = { game: [], tools: ['scene_apply operations.id'] };
  const guides = { 'docs/mcp.md': 'Every node has an `id`.' };
  assert.deepEqual(findUnmarkedFields({ guides, newer, released }), []);
});

test('a refusal of an unknown field names the installed version', () => {
  const refusal = 'Game setup player.animation is not a field. Use one of: node, controller.';
  const hinted = withVersionHint(refusal, '0.19.0');
  assert.match(hinted, /^Game setup player\.animation is not a field/);
  assert.match(hinted, /This server is Crucible 0\.19\.0; a field in a newer guide may only arrive in a later release/);
  assert.equal(withVersionHint('node must be a string.', '0.19.0'), 'node must be a string.');
});
