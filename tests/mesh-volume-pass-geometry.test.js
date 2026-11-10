// The mesh volume pass keeps one set of GPU buffers per part geometry (issue 807). A geometry that is replaced or leaves the scene
// must give its buffers back, or a scene that edits a mesh every frame leaks. Runs against a recording fake of the GL context.
import test from 'node:test';
import assert from 'node:assert/strict';
import { drawMeshVolumes } from '../src/mesh-volume-pass.js';

function recordingContext() {
  const created = { vertexArrays: new Set(), buffers: new Set() };
  const deleted = { vertexArrays: [], buffers: [] };
  let nextHandle = 0;
  const handlers = {
    getExtension: () => ({}),
    checkFramebufferStatus: () => 'FRAMEBUFFER_COMPLETE',
    getParameter: () => 16384,
    isEnabled: () => false,
    getUniformLocation: name => name,
    getShaderParameter: () => true,
    getProgramParameter: () => true,
    getShaderInfoLog: () => '',
    getProgramInfoLog: () => '',
    createVertexArray: () => {
      const handle = { kind: 'vertexArray', id: nextHandle++ };
      created.vertexArrays.add(handle);
      return handle;
    },
    createBuffer: () => {
      const handle = { kind: 'buffer', id: nextHandle++ };
      created.buffers.add(handle);
      return handle;
    },
    deleteVertexArray: handle => deleted.vertexArrays.push(handle),
    deleteBuffer: handle => deleted.buffers.push(handle),
  };
  const context = new Proxy({}, {
    get(_target, name) {
      if (name in handlers) return handlers[name];
      if (/^[A-Z0-9_]+$/.test(name)) return name;
      return () => ({ kind: String(name), id: nextHandle++ });
    },
  });
  return { context, created, deleted };
}

function closedTetrahedron(offset) {
  return {
    positions: new Float32Array([offset, 0, 0, offset + 1, 0, 0, offset, 1, 0, offset, 0, 1]),
    normals: new Float32Array(12),
    indices: new Uint32Array([0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3]),
  };
}

function rendererWith(context, geometry) {
  return {
    context,
    dispose() { this.disposed = true; },
    canvas: { width: 8, height: 8 },
    depthTexture: {},
    viewProjection: new Float32Array(16),
    inverseViewProjection: new Float32Array(16),
    renderTargets: { record() {}, release() {} },
    localVolumeBuffers: { meshParts: [{ label: 'environment.localVolumes[0]', part: { name: 'room', geometry } }] },
  };
}

test('replacing a mesh volume geometry deletes the buffers of the old one', () => {
  const { context, created, deleted } = recordingContext();
  const renderer = rendererWith(context, closedTetrahedron(0));
  const frame = { eye: [0, 0, 5], projection: 'perspective' };
  drawMeshVolumes(renderer, frame);
  assert.equal(created.vertexArrays.size, 1);
  assert.equal(deleted.buffers.length, 0);
  drawMeshVolumes(renderer, frame);
  assert.equal(deleted.buffers.length, 0, 'the same geometry keeps its buffers');
  const [oldVertexArray] = created.vertexArrays;
  const [oldPositions, oldIndices] = created.buffers;
  renderer.localVolumeBuffers.meshParts[0].part.geometry = closedTetrahedron(2);
  drawMeshVolumes(renderer, frame);
  assert.deepEqual(deleted.vertexArrays, [oldVertexArray]);
  assert.deepEqual(deleted.buffers, [oldPositions, oldIndices]);
  assert.equal(created.vertexArrays.size, 2);
});

test('disposing the pass deletes the buffers still in use', () => {
  const { context, deleted } = recordingContext();
  const renderer = rendererWith(context, closedTetrahedron(0));
  drawMeshVolumes(renderer, { eye: [0, 0, 5], projection: 'perspective' });
  renderer.dispose();
  assert.equal(deleted.buffers.length, 2);
  assert.equal(renderer.meshVolumePass, null);
  assert.equal(renderer.disposed, true, 'the renderer still disposes the rest');
});
