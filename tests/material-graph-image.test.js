import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { bakeMaterialPattern, normalizeMaterialPattern } from '../src/material-patterns.js';
import { compileMaterialGraph, graphImageAssets } from '../src/material-graph.js';
import { sequenceFrameIds } from '../src/agent-texture-sequence.js';
import { createAgentScene } from '../src/agent-scene.js';

const IMAGE_ASSET = 'a'.repeat(64);
const OTHER_ASSET = 'b'.repeat(64);

function imagePool(width, height, pixel) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let row = 0; row < height; row++) {
    for (let column = 0; column < width; column++) data.set(pixel(column, row), (row * width + column) * 4);
  }
  return new Map([[IMAGE_ASSET, { width, height, data }]]);
}

const srgbByteToLinear = byte => {
  const encoded = byte / 255;
  return encoded <= 0.04045 ? encoded / 12.92 : ((encoded + 0.055) / 1.055) ** 2.4;
};

const imagePattern = () => normalizeMaterialPattern({ type: 'graph', resolution: 256, graph: { color: { image: { asset: IMAGE_ASSET } } } });

const colorHash = baked => createHash('sha256').update(Buffer.from(baked.map.image.data)).digest('hex');

test('an image node matches a bilinear reference at texel centres and halfway between them', () => {
  const pool = imagePool(2, 2, (column, row) => [column * 200, row * 100, 50, 255 - column * 100]);
  const colorNode = compileMaterialGraph({ color: { image: { asset: IMAGE_ASSET } } }, { images: pool }).outputs.color;
  const alphaNode = compileMaterialGraph({ opacity: { image: { asset: IMAGE_ASSET, output: 'alpha' } } }, { images: pool }).outputs.opacity;
  // Texel centres sit at 0.25 and 0.75 on a 2 by 2 image.
  assert.ok(Math.abs(colorNode.parts[0](0.75, 0.25) - srgbByteToLinear(200)) < 1e-9);
  assert.ok(Math.abs(colorNode.parts[1](0.25, 0.75) - srgbByteToLinear(100)) < 1e-9);
  assert.ok(Math.abs(alphaNode.evaluate(0.75, 0.25) - 155 / 255) < 1e-9);
  const halfway = (srgbByteToLinear(0) + srgbByteToLinear(200)) / 2;
  assert.ok(Math.abs(colorNode.parts[0](0.5, 0.25) - halfway) < 1e-9);
  assert.ok(Math.abs(colorNode.parts[0](0.6, 0.3) - colorNode.parts[0](1.6, -0.7)) < 1e-9);
});

test('an image node validates its asset and output, and needs the pixels only when baking', () => {
  assert.throws(() => compileMaterialGraph({ color: { image: { asset: 'https://example.com/a.png' } } }), /catalog image asset ID.*Remote URLs/);
  assert.throws(() => compileMaterialGraph({ color: { image: { asset: IMAGE_ASSET, output: 'red' } } }), /image output must be one of color, alpha/);
  assert.throws(() => compileMaterialGraph({ color: { image: { asset: IMAGE_ASSET, extra: 1 } } }), /image does not take "extra"/);
  assert.throws(() => bakeMaterialPattern(imagePattern(), new Map()), /image aaaaaaaaaaaa was not loaded/);
});

test('a baked image graph is deterministic and its colour map carries the image', () => {
  const pool = imagePool(4, 4, (column, row) => [column * 60, row * 60, 128, 255]);
  const first = bakeMaterialPattern(imagePattern(), pool);
  assert.equal(colorHash(first), colorHash(bakeMaterialPattern(imagePattern(), pool)));
  const offset = (32 * 256 + 32) * 4;
  assert.ok(first.map.image.data[offset] < 60);
  assert.ok(first.map.image.data[offset + 2] > 100);
  assert.notEqual(colorHash(first), colorHash(bakeMaterialPattern(imagePattern(), imagePool(4, 4, () => [255, 255, 255, 255]))));
});

test('graphImageAssets lists the images a graph reads and the host finds them in a recipe', () => {
  const graph = { color: { mix: [{ image: { asset: IMAGE_ASSET } }, { image: { asset: OTHER_ASSET, at: { mapping: { scale: 2 } } } }, 0.5] } };
  assert.deepEqual(graphImageAssets(graph), [IMAGE_ASSET, OTHER_ASSET]);
  assert.deepEqual(graphImageAssets({ color: { noise: { scale: 4 } } }), []);
  const recipe = { materials: [{ id: 'wall', tag: 'surface', pattern: { type: 'graph', graph } }] };
  assert.deepEqual(sequenceFrameIds(recipe).sort(), [IMAGE_ASSET, OTHER_ASSET]);
});

test('a scene material with an image graph bakes through the frame pool the host decodes', () => {
  const pool = imagePool(2, 2, column => [column * 255, 0, 0, 255]);
  const recipe = {
    format: '67js.scene', schemaVersion: 1,
    geometries: [{ id: 'block', type: 'grid', segments: 1 }],
    materials: [{ id: 'photo', tag: 'surface', pattern: { type: 'graph', resolution: 256, mapping: 'uv', graph: { color: { image: { asset: IMAGE_ASSET } } } } }],
    nodes: [{ id: 'a', geometry: 'block', material: 'photo' }],
  };
  const scene = createAgentScene(recipe, {}, { sequenceFrames: pool });
  const material = scene.parts[0].material;
  const data = material.map.image.data;
  assert.equal(data.length, 256 * 256 * 4);
  assert.ok(data[(128 * 256 + 255) * 4] > data[(128 * 256) * 4]);
});
