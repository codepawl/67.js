import assert from 'node:assert/strict';
import test from 'node:test';
import { Renderer67 } from '../src/renderer.js';

const LINEAR = 'LINEAR';
const LINEAR_MIPMAP_LINEAR = 'LINEAR_MIPMAP_LINEAR';

function fakeContext() {
  const filters = new Map();
  let boundTexture = null;
  return {
    filters,
    READ_FRAMEBUFFER: 1,
    DRAW_FRAMEBUFFER: 2,
    COLOR_BUFFER_BIT: 4,
    DEPTH_BUFFER_BIT: 8,
    NEAREST: 9,
    TEXTURE_2D: 3,
    TEXTURE_MIN_FILTER: 5,
    LINEAR,
    bindFramebuffer() {},
    blitFramebuffer() {},
    bindTexture(target, texture) { boundTexture = texture; },
    texParameteri(target, name, value) { filters.set(boundTexture, value); },
  };
}

test('stages and bloom never read a texture left on a mipmapped filter by the previous frame (#578)', () => {
  const context = fakeContext();
  const frameTexture = { name: 'frame' };
  context.filters.set(frameTexture, LINEAR_MIPMAP_LINEAR);
  const stageReached = new Error('stage reached');
  let filterSeenByStage = null;
  const renderer = {
    context,
    canvas: { width: 4, height: 4 },
    depth: true,
    frameTexture,
    mipmappedTexture: frameTexture,
    postStages: [{
      apply() {
        filterSeenByStage = context.filters.get(frameTexture);
        throw stageReached;
      },
    }],
    restoreSingleLevelFiltering: Renderer67.prototype.restoreSingleLevelFiltering,
  };
  assert.throws(() => Renderer67.prototype.resolveFrame.call(renderer, {}, {}, {}, {}), stageReached);
  assert.equal(filterSeenByStage, LINEAR);
  assert.equal(renderer.mipmappedTexture, null);
});
