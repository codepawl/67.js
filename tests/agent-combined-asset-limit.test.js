import test from 'node:test';
import assert from 'node:assert/strict';
import { AGENT_ASSET_LIMITS, assertCombinedAssetBytes, combinedAssetBytes } from '../src/agent-asset-limits.js';

const MEBIBYTE = 1024 * 1024;

function base64OfSize(byteCount) {
  return Buffer.alloc(byteCount).toString('base64');
}

test('combinedAssetBytes counts decoded bytes of every asset field in one call', () => {
  const input = {
    assetData: { a: base64OfSize(10), b: base64OfSize(11) },
    sequenceData: { c: base64OfSize(12) },
    sources: { d: base64OfSize(13) },
    data: base64OfSize(14),
  };
  assert.equal(combinedAssetBytes(input), 60);
  assert.equal(combinedAssetBytes({}), 0);
});

test('a call whose assets are each under maxBytes but together over maxCombinedBytes fails naming limit and total', () => {
  const each = 40 * MEBIBYTE;
  assert.ok(each < AGENT_ASSET_LIMITS.maxBytes);
  const input = { assetData: { first: base64OfSize(each), second: base64OfSize(each) } };
  assert.throws(
    () => assertCombinedAssetBytes(input),
    error => error instanceof RangeError
      && error.message.includes('maxCombinedBytes')
      && error.message.includes(String(AGENT_ASSET_LIMITS.maxCombinedBytes))
      && error.message.includes(String(2 * each)),
  );
});

test('a call at exactly maxCombinedBytes passes', () => {
  const half = AGENT_ASSET_LIMITS.maxCombinedBytes / 2;
  assert.doesNotThrow(() => assertCombinedAssetBytes({ assetData: { first: base64OfSize(half) }, sources: { second: base64OfSize(half) } }));
});
