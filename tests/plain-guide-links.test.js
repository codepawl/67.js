import assert from 'node:assert/strict';
import test from 'node:test';
import { absoluteDocsLinks, plainGuide } from '../scripts/plain-guide.mjs';

test('a ../ link from a learn page becomes an absolute GitHub link', () => {
  const result = absoluteDocsLinks('See the [bridge](../three-bridge.md) and [site](https://example.com/a.md).');
  assert.equal(
    result,
    'See the [bridge](https://github.com/codepawl/67.js/blob/main/docs/three-bridge.md) and [site](https://example.com/a.md).',
  );
});

// public/guide.md is git-ignored, so the link check skips it; this keeps the generated guide covered.
test('the generated plain guide has no relative ../ links left', async () => {
  const guide = await plainGuide(process.cwd());
  const leftovers = [...guide.matchAll(/\]\(\.\.\/[^)]*\)/g)].map((match) => match[0]);
  assert.deepEqual(leftovers, []);
});
