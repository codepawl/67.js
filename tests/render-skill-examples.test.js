import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

// The render-crucible-media skill teaches agents scene_render_submit by example. Every json block in its jobs reference must be
// valid JSON whose settings use only fields the tool schema declares, and a kind, width and height the schema requires.
const serverSource = await readFile(new URL('../scripts/mcp-server.mjs', import.meta.url), 'utf8');
const schemaStart = serverSource.indexOf('const renderSettings = z.strictObject({');
const schemaEnd = serverSource.indexOf('}).describe(', schemaStart);
const declaredFields = new Set([...serverSource.slice(schemaStart, schemaEnd).matchAll(/^  (\w+): z\./gm)].map(match => match[1]));
const referenceUrl = new URL('../skills/render-crucible-media/references/jobs.md', import.meta.url);
const reference = await readFile(referenceUrl, 'utf8');
const submissions = [...reference.matchAll(/```json\r?\n([\s\S]*?)```/g)].map(match => JSON.parse(match[1]));

test('the render skill reference has submissions to check', () => {
  assert.ok(declaredFields.has('kind') && declaredFields.has('passes'), 'the schema fields were found');
  assert.ok(submissions.length >= 6);
});

submissions.forEach((submission, index) => {
  test(`render skill submission ${index + 1} uses declared settings`, () => {
    assert.ok(Number.isInteger(submission.expectedRevision));
    const { settings } = submission;
    for (const field of Object.keys(settings)) assert.ok(declaredFields.has(field), `${field} is not a render setting`);
    assert.ok(['image', 'stills', 'video'].includes(settings.kind));
    for (const side of [settings.width, settings.height]) assert.ok(Number.isInteger(side) && side >= 64 && side <= 1920);
    if (settings.kind === 'video') assert.ok(settings.width % 2 === 0 && settings.height % 2 === 0);
    if (settings.timeline) assert.ok(!settings.motion && !settings.animation, 'a timeline owns the motion clock');
  });
});
