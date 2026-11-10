import test from 'node:test';
import assert from 'node:assert/strict';
import { mat4 } from 'gl-matrix';
import { installRenderPasses } from '../src/render-passes.js';
import { withWireframe, MAXIMUM_WIREFRAME_REPORTED_PARTS } from '../src/wireframe-pass.js';
import { RENDER_PASS_NAMES } from '../src/agent-scene-capabilities.js';

// A context that records every call; constants read back as their own names and shader and program checks succeed.
function recordingContext(calls) {
  const answers = { getShaderParameter: () => true, getProgramParameter: () => true, checkFramebufferStatus: () => 'FRAMEBUFFER_COMPLETE', getUniformLocation: (_program, name) => name, getExtension: () => ({}), isContextLost: () => false };
  return new Proxy({}, {
    get(_target, name) {
      if (name in answers) return answers[name];
      if (name === name.toUpperCase()) return name;
      return (...parameters) => {
        calls.push([name, ...parameters]);
        return {};
      };
    },
  });
}

// An open box (five quads as ten triangles) as renderer geometry: four boundary edges, no triangulation diagonals drawn.
function openBoxGeometry() {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1]);
  const quads = [[0, 3, 2, 1], [0, 1, 5, 4], [2, 3, 7, 6], [0, 4, 7, 3], [1, 2, 6, 5]];
  const indices = quads.flatMap(([a, b, c, d]) => [a, b, c, a, c, d]);
  return { positions, normals: new Float32Array(positions.length), indices: new Uint32Array(indices) };
}

function rendererWith(parts, calls, extra = {}) {
  const batch = { parts, layerState: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], textures: [] };
  const renderer = {
    context: recordingContext(calls),
    canvas: { width: 8, height: 8 },
    benchmark: false,
    program: {},
    viewProjection: mat4.create(),
    renderTargets: { record: () => {}, release: () => {} },
    requireFeatureNames: () => {},
    drawsInOpaqueLoop: () => true,
    batches: [batch],
    ...extra,
  };
  installRenderPasses(renderer);
  renderer.passSupport.prepare({ pass: 'wireframe' });
  return renderer;
}

const identity = () => mat4.create();

test('wireframe is a named pass that draws as the diffuse pass on a light background', () => {
  assert.equal(RENDER_PASS_NAMES.at(-1), 'wireframe');
  const renderer = rendererWith([], []);
  assert.equal(renderer.passSupport.prepare({ pass: 'wireframe' }), renderer.passSupport.prepare({ pass: 'diffuse' }));
  assert.deepEqual(renderer.passSupport.background('wireframe'), [0.82, 0.84, 0.86, 1]);
  assert.throws(() => renderer.passSupport.prepare({ pass: 'beauty' }), /Unknown render pass: beauty\. Use .*wireframe/);
});

test('the overlay runs only while a wireframe frame renders and reports edge counts and faulty parts', () => {
  const calls = [];
  const geometry = openBoxGeometry();
  const renderer = rendererWith([{ name: 'open-box', geometry, matrix: identity() }, { name: 'second', geometry, matrix: identity() }], calls);
  renderer.passSupport.copyToCanvas();
  assert.equal(calls.some(call => call[0] === 'drawArraysInstanced'), false, 'A plain pass frame draws no edges.');
  const report = withWireframe(renderer, () => renderer.passSupport.copyToCanvas());
  assert.equal(renderer.passSupport.overlay, null);
  assert.deepEqual(report.edges, { regular: 16, boundary: 8, nonManifold: 0, flipped: 0, degenerate: 0 });
  assert.deepEqual(report.faultyParts.map(part => part.part), ['open-box', 'second']);
  assert.equal(report.partsOmitted, 0);
  const draws = calls.filter(call => call[0] === 'drawArraysInstanced');
  assert.deepEqual(draws.map(call => call.slice(1)), [['TRIANGLES', 0, 6, 12], ['TRIANGLES', 0, 6, 12]]);
});

test('depth state follows the pass: reversed-Z tests GEQUAL with a projection of its own, standard depth tests LEQUAL', () => {
  const part = { name: 'open-box', geometry: openBoxGeometry(), matrix: identity() };
  const standardCalls = [];
  const standard = rendererWith([part], standardCalls);
  withWireframe(standard, () => standard.passSupport.copyToCanvas());
  assert.deepEqual(standardCalls.find(call => call[0] === 'depthFunc').slice(1), ['LEQUAL']);
  const reversedCalls = [];
  const reversed = rendererWith([part], reversedCalls, { reversedDepth: true, rasterViewProjection: mat4.create() });
  withWireframe(reversed, () => reversed.passSupport.copyToCanvas());
  assert.deepEqual(reversedCalls.filter(call => call[0] === 'depthFunc').map(call => call[1]), ['GEQUAL', 'GREATER']);
  assert.deepEqual(standardCalls.filter(call => call[0] === 'depthFunc').map(call => call[1]), ['LEQUAL', 'LESS']);
});

test('a part with no polygon view is skipped and counted instead of failing the frame', () => {
  const collapsed = { positions: new Float32Array(9), normals: new Float32Array(9), indices: new Uint32Array([0, 1, 2]) };
  const renderer = rendererWith([{ name: 'flat', geometry: collapsed, matrix: identity() }], []);
  const report = withWireframe(renderer, () => renderer.passSupport.copyToCanvas());
  assert.equal(report.partsSkipped, 1);
  assert.equal(report.edges.regular, 0);
});

test('the report names at most the worst parts and says how many it left out', () => {
  const parts = Array.from({ length: MAXIMUM_WIREFRAME_REPORTED_PARTS + 3 }, (_unused, index) => ({ name: `part-${index}`, geometry: openBoxGeometry(), matrix: identity() }));
  const renderer = rendererWith(parts, []);
  const report = withWireframe(renderer, () => renderer.passSupport.copyToCanvas());
  assert.equal(report.faultyParts.length, MAXIMUM_WIREFRAME_REPORTED_PARTS);
  assert.equal(report.faultyPartsOmitted, 3);
});

test('a frame that never reaches the canvas copy is an error, and the overlay is removed', () => {
  const renderer = rendererWith([], []);
  assert.throws(() => withWireframe(renderer, () => {}), /drew no frame/);
  assert.equal(renderer.passSupport.overlay, null);
  assert.throws(() => withWireframe(renderer, () => { throw new Error('boom'); }), /boom/);
  assert.equal(renderer.passSupport.overlay, null);
});
