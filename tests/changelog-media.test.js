import test from 'node:test';
import assert from 'node:assert/strict';
import { isAllowedMediaUrl, isVideoUrl } from '../src/changelog-media.js';

test('clips are told from pictures by file name, ignoring a query string', () => {
  assert.equal(isVideoUrl('/media/a.mp4'), true);
  assert.equal(isVideoUrl('https://example.com/a.WEBM?x=1'), true);
  assert.equal(isVideoUrl('/media/a.png'), false);
});

test('only https URLs and site paths are allowed as media', () => {
  assert.equal(isAllowedMediaUrl('https://example.com/a.png'), true);
  assert.equal(isAllowedMediaUrl('/media/a.png'), true);
  for (const url of ['http://example.com/a.png', '//example.com/a.png', 'javascript:alert(1)', 'data:image/png;base64,AA']) {
    assert.equal(isAllowedMediaUrl(url), false, url);
  }
});
