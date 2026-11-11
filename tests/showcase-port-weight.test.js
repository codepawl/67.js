import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { parseGltf } from '../src/gltf.js';
import { parseRadianceHdr } from '../src/hdri.js';

const SHOWCASE_SOURCE = new URL('../src/showcase.js', import.meta.url);
const MEGABYTE = 1024 * 1024;
const WORLDS = ['port', 'airport', 'datacenter'];
// The first part is what a visitor waits for: at 5 Mbps every megabyte is about 1.7 s, and the first frame is due within 5 s.
const FIRST_PART_BYTE_BUDGET = 3.1 * MEGABYTE;
const REST_PART_BYTE_BUDGET = 16 * MEGABYTE;
// Node has no image decoder, so the test stubs createImageBitmap and only the geometry is real.
const SHOWCASE_LIMITS = { maxBytes: 64 * MEGABYTE, maxVertices: 4_000_000, maxParts: 20_000, maxTexturePixels: 512 * MEGABYTE, maxTextureImagePixels: 100_000_000 };

// The first view's sky must stay small so the first live frame is not held up on a slow link.
const PREVIEW_SKY_BYTE_BUDGET = 150 * 1024;

// Mean linear colour of a parsed sky, weighted by the solid angle of each row, and the mean luminance of each quarter of its width.
function summarizeSky({ width, height, data }) {
  const mean = [0, 0, 0];
  const quarterLuminance = [0, 0, 0, 0];
  let totalWeight = 0;
  const quarterWeights = [0, 0, 0, 0];
  for (let row = 0; row < height; row++) {
    const weight = Math.sin(((row + 0.5) / height) * Math.PI);
    for (let column = 0; column < width; column++) {
      const offset = (row * width + column) * 3;
      const luminance = 0.2126 * data[offset] + 0.7152 * data[offset + 1] + 0.0722 * data[offset + 2];
      const quarter = Math.floor((column * 4) / width);
      for (let channel = 0; channel < 3; channel++) mean[channel] += data[offset + channel] * weight;
      quarterLuminance[quarter] += luminance * weight;
      quarterWeights[quarter] += weight;
      totalWeight += weight;
    }
  }
  return { mean: mean.map(value => value / totalWeight), quarterLuminance: quarterLuminance.map((value, quarter) => value / quarterWeights[quarter]) };
}

function readGltfJson(buffer) {
  const jsonLength = buffer.readUInt32LE(12);
  return JSON.parse(buffer.subarray(20, 20 + jsonLength).toString('utf8'));
}

async function readWorld(world) {
  const directory = new URL(`../public/showcase/${world}/`, import.meta.url);
  const description = JSON.parse(await readFile(new URL('scene.json', directory), 'utf8'));
  const first = await readFile(new URL('scene.glb', directory));
  const rest = await readFile(new URL('scene.rest.glb', directory));
  return { directory, description, first, rest };
}

for (const world of WORLDS) {
  test(`the ${world} showcase loads in two meshopt-compressed parts, the first small enough to draw quickly`, async () => {
    const { description, first, rest } = await readWorld(world);
    for (const buffer of [first, rest]) {
      assert.ok(readGltfJson(buffer).extensionsRequired.includes('EXT_meshopt_compression'));
    }
    assert.ok(first.length < FIRST_PART_BYTE_BUDGET, `${world} scene.glb is ${first.length} bytes, budget ${FIRST_PART_BYTE_BUDGET}`);
    assert.ok(rest.length < REST_PART_BYTE_BUDGET, `${world} scene.rest.glb is ${rest.length} bytes, budget ${REST_PART_BYTE_BUDGET}`);
    assert.equal(description.glb, `/showcase/${world}/scene.glb`);
    assert.deepEqual(description.glbRest, [`/showcase/${world}/scene.rest.glb`]);
  });

  test(`the ${world} showcase parts hold meshes and keep every skinned part in the first`, async () => {
    const { first, rest } = await readWorld(world);
    const firstDocument = readGltfJson(first);
    const restDocument = readGltfJson(rest);
    assert.ok(firstDocument.nodes.some(node => node.mesh !== undefined));
    assert.ok(restDocument.nodes.some(node => node.mesh !== undefined));
    assert.equal(restDocument.skins, undefined, 'the renderer cannot add a skinned part to a scene that is already drawing');
  });

  test(`the ${world} showcase has a small preview sky that parses`, async () => {
    const { directory, description } = await readWorld(world);
    assert.equal(description.hdriPreview, `/showcase/${world}/sky.preview.hdr`);
    const preview = await readFile(new URL('sky.preview.hdr', directory));
    assert.ok(preview.length <= PREVIEW_SKY_BYTE_BUDGET, `the preview sky is ${preview.length} bytes`);
    const { width, height, data } = parseRadianceHdr(preview);
    assert.ok(width > 0 && height > 0);
    assert.ok(data.some(value => value > 0));
  });

  test(`the ${world} preview sky is the full sky at the same orientation, exposure and total light`, async () => {
    const { directory } = await readWorld(world);
    const full = parseRadianceHdr(await readFile(new URL('sky.hdr', directory)));
    const preview = parseRadianceHdr(await readFile(new URL('sky.preview.hdr', directory)));
    assert.equal(preview.width / preview.height, full.width / full.height);
    for (const [name, summary] of [['full', summarizeSky(full)], ['preview', summarizeSky(preview)]]) {
      assert.ok(summary.mean.every(value => value > 0), `${name} sky has light in every channel`);
    }
    const fullSummary = summarizeSky(full);
    const previewSummary = summarizeSky(preview);
    // Averaging blocks keeps the total light, so the first view is lit by the same amount of sky as the full world.
    for (let channel = 0; channel < 3; channel++) {
      assert.ok(Math.abs(previewSummary.mean[channel] / fullSummary.mean[channel] - 1) < 0.01, `channel ${channel} mean differs by more than 1%`);
    }
    // The mean of each quarter of the panorama matches too, so a swap does not change the sky's side-to-side balance.
    for (let quarter = 0; quarter < 4; quarter++) {
      assert.ok(Math.abs(previewSummary.quarterLuminance[quarter] / fullSummary.quarterLuminance[quarter] - 1) < 0.02, `quarter ${quarter} luminance differs by more than 2%`);
    }
  });
}

test('the showcase page leaves meshopt decoding to the glTF loader', async () => {
  const source = await readFile(SHOWCASE_SOURCE, 'utf8');
  assert.doesNotMatch(source, /meshopt_decoder/);
  assert.doesNotMatch(source, /decoders/);
});

for (const world of WORLDS) {
  test(`the ${world} showcase files load through loadGltf without a decoder option`, async () => {
    const { first, rest } = await readWorld(world);
    globalThis.createImageBitmap ??= async () => ({ width: 4, height: 4, close() {} });
    for (const buffer of [first, rest]) {
      const asset = await parseGltf(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength), SHOWCASE_LIMITS);
      assert.ok(asset.parts.length > 0);
    }
  });
}

test('the showcase page draws the first part before it streams the rest', async () => {
  const source = await readFile(SHOWCASE_SOURCE, 'utf8');
  assert.match(source, /glbRest/);
  assert.match(source, /replaceParts/);
  assert.match(source, /replace-textured-parts/);
});
