// Draws a nature terrain with sunk rocks and a trunk (or a lit box), for bench/reference/mesh-blend.mjs. It imports only
// the renderer and geometry, so the same page runs on a checkout of main, which has no mesh-blend.js.
//   window.setupScene({ scene: 'nature' | 'lit-box', mode: 'plain' | 'installed' | 'blend' })
//   window.snapshot() -> PNG data URL, window.measureFrames(count) -> milliseconds per frame, window.teardown()
import { mat4 } from 'gl-matrix';
import { CrucibleRenderer } from '/src/renderer.js';
import { box, cylinder, sphere } from '/src/geometry.js';
import { createNoiseHeight, createTerrain } from '/src/terrain.js';

const canvas = document.querySelector('canvas');
let renderer = null;
let frame = null;

function placed(geometry, material, name, center, size, extra = {}) {
  const positions = geometry.positions;
  const low = [Infinity, Infinity, Infinity];
  const high = [-Infinity, -Infinity, -Infinity];
  for (let index = 0; index < positions.length; index += 3) {
    for (let axis = 0; axis < 3; axis++) {
      low[axis] = Math.min(low[axis], positions[index + axis]);
      high[axis] = Math.max(high[axis], positions[index + axis]);
    }
  }
  const middle = low.map((value, axis) => (value + high[axis]) / 2);
  const scale = size.map((value, axis) => value / (high[axis] - low[axis]));
  const matrix = new Float32Array(16);
  mat4.translate(matrix, mat4.create(), center);
  mat4.rotateY(matrix, matrix, extra.turn ?? 0);
  mat4.scale(matrix, matrix, scale);
  mat4.translate(matrix, matrix, middle.map(value => -value));
  return { name, geometry, material, matrix, ...(extra.blend ? { blend: extra.blend } : {}) };
}

function natureScene(blend) {
  const terrain = createTerrain({
    size: 160, chunks: 8, resolution: 32, levels: 3, eye: [0, 3, 8],
    height: createNoiseHeight({ amplitude: 1.2, mountainAmplitude: 0, featureSize: 22, octaves: 4, warp: 0 }, 3),
    material: { color: [0.30, 0.38, 0.16], metallic: 0, roughness: 0.95, emission: 0 },
  });
  const ground = terrain.heightAt;
  const radius = blend ? { blend: { radius: 0.18 } } : {};
  const rockMaterial = (tone) => ({ color: [tone, tone * 0.95, tone * 0.88], metallic: 0, roughness: 0.9, emission: 0 });
  const rockGeometry = sphere(48, 32);
  const blockGeometry = box(0.08, 3);
  const rocks = [[-2.6, -1.0, 1.1, 0.7], [-0.4, -2.2, 0.9, 0.55], [2.4, -0.2, 1.4, 0.9], [1.0, 1.4, 0.7, 0.5], [-3.8, 1.2, 1.6, 1.0]].map(([x, z, width, height], index) => placed(
    index % 2 ? blockGeometry : rockGeometry, rockMaterial(0.34 + index * 0.03), `rock-${index}`, [x, ground(x, z) + height * 0.18, z], [width, height, width * 0.85], { turn: index, ...radius }));
  const trunkMaterial = { color: [0.28, 0.19, 0.12], metallic: 0, roughness: 0.85, emission: 0 };
  const trunk = placed(cylinder(48, 0.01, 2), trunkMaterial, 'trunk', [-1.4, ground(-1.4, 2.2) + 1.2, 2.2], [0.55, 3.4, 0.55], radius);
  const parts = [...terrain.parts, ...rocks, trunk];
  return {
    parts,
    camera: { eye: [0.6, ground(0.6, 7) + 1.7, 7.2], target: [-0.6, ground(-0.6, 0) + 0.6, 0.4], fov: 42 },
    shadowBounds: { center: [0, 0, 0], radius: 14 },
  };
}

function litBoxScene() {
  const gray = { color: [0.6, 0.55, 0.5], metallic: 0, roughness: 0.6, emission: 0 };
  const parts = [placed(box(0.08, 3), gray, 'box', [0, 0.5, 0], [1, 1, 1])];
  return { parts, camera: { eye: [2.2, 1.6, 3], target: [0, 0.5, 0], fov: 40 }, shadowBounds: undefined };
}

window.setupScene = async ({ scene, mode }) => {
  const built = scene === 'nature' ? natureScene(mode === 'blend') : litBoxScene();
  renderer = new CrucibleRenderer(canvas, built.parts, {
    ground: scene === 'lit-box', hdr: true, depth: true, samples: 4, pixelRatio: 1, memoryBudgetMiB: 1024, world: scene === 'nature',
    ...(built.shadowBounds ? { shadowBounds: built.shadowBounds } : {}),
  });
  if (mode !== 'plain') {
    const { installMeshBlend } = await import(/* @vite-ignore */ ['/src/mesh', 'blend.js'].join('-'));
    installMeshBlend(renderer);
  }
  if (location.search.includes('debug')) watch(renderer.context);
  renderer.resize();
  frame ={ ...built.camera, environment: { lightDirection: [-3, 6, 4] }, time: 0, exposure: 1, effects: { ambientOcclusion: 0 } };
  renderer.render(frame);
  return { width: canvas.width, height: canvas.height, glError: window.debugFirstError ? 1 : 0, debug: window.debugFirstError };
};

window.snapshot = () => {
  renderer.render(frame);
  return canvas.toDataURL('image/png');
};

window.measureFrames = (count) => {
  const context = renderer.context;
  const pixel = new Uint8Array(4);
  for (let index = 0; index < 30; index++) {
    renderer.render(frame);
    context.readPixels(0, 0, 1, 1, context.RGBA, context.UNSIGNED_BYTE, pixel);
  }
  const times = [];
  for (let index = 0; index < count; index++) {
    const started = performance.now();
    renderer.render(frame);
    context.readPixels(0, 0, 1, 1, context.RGBA, context.UNSIGNED_BYTE, pixel);
    times.push(performance.now() - started);
  }
  return times;
};

// GPU milliseconds per frame from EXT_disjoint_timer_query_webgl2, or null where the browser does not expose it.
window.measureGpuFrames = async (count) => {
  const context = renderer.context;
  const timer = context.getExtension('EXT_disjoint_timer_query_webgl2');
  if (!timer) return null;
  for (let index = 0; index < 30; index++) renderer.render(frame);
  const queries = [];
  for (let index = 0; index < count; index++) {
    const query = context.createQuery();
    context.beginQuery(timer.TIME_ELAPSED_EXT, query);
    renderer.render(frame);
    context.endQuery(timer.TIME_ELAPSED_EXT);
    queries.push(query);
  }
  const times = [];
  for (const query of queries) {
    while (!context.getQueryParameter(query, context.QUERY_RESULT_AVAILABLE)) await new Promise(done => setTimeout(done, 1));
    if (!context.getParameter(timer.GPU_DISJOINT_EXT)) times.push(context.getQueryParameter(query, context.QUERY_RESULT) / 1e6);
    context.deleteQuery(query);
  }
  return times;
};

window.teardown = () => {
  renderer.dispose();
  renderer = null;
};
window.debugFirstError = null;
function watch(context) {
  const proto = Object.getPrototypeOf(context);
  for (const name of Object.getOwnPropertyNames(proto)) {
    if (name === 'getError' || name === 'constructor' || typeof context[name] !== 'function') continue;
    const original = context[name].bind(context);
    context[name] = (...args) => {
      const result = original(...args);
      if (!window.debugFirstError) {
        const error = context.getError();
        if (error) window.debugFirstError = `${name}(${args.map(value => (typeof value === 'number' ? value : typeof value)).join(',')}) -> ${error}`;
      }
      return result;
    };
  }
}
window.harnessReady = true;
