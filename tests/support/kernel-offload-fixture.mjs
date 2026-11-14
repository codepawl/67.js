import { createHash } from 'node:crypto';
import { createAgentScene } from '../../src/agent-scene.js';
import { buildWithKernels } from '../../src/kernel-offload.js';
import { answerKernelRequest } from '../../src/kernel-registry.js';

// A scene that reaches every offloaded kernel: uv_unwrap, light bake, cloth and a pattern texture.
export function kernelRoom() {
  const box = (id, translation, scale, material) => ({ id, geometry: 'box', material, translation, scale });
  return {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [
      { id: 'box', type: 'box' },
      { id: 'crate', type: 'mesh', base: { type: 'box', bevel: 0 }, stack: [{ op: 'uv_unwrap' }] },
      { id: 'banner', type: 'grid', segments: 6 },
    ],
    materials: [
      { id: 'white', color: [0.8, 0.8, 0.8], roughness: 0.9 },
      { id: 'lamp', color: [1, 1, 1], emission: 2 },
      { id: 'wood', pattern: { type: 'wood', resolution: 256 } },
    ],
    nodes: [
      box('floor', [0, -0.05, 0], [4, 0.1, 4], 'white'),
      box('ceiling', [0, 3.05, 0], [4, 0.1, 4], 'white'),
      box('back', [0, 1.5, -2.05], [4.2, 3.2, 0.1], 'white'),
      box('bulb', [0.9, 2.5, 0.6], [0.2, 0.2, 0.2], 'lamp'),
      { id: 'crate', geometry: 'crate', material: 'wood', translation: [-0.7, 0.4, -0.4] },
      { id: 'flag', geometry: 'banner', material: 'white', translation: [0.5, 2, 0] },
    ],
    camera: { eye: [0, 1.5, 1.9], target: [0, 1.4, -2], fov: 70, near: 0.05, far: 20 },
    environment: { pointLights: [{ position: [0, 2.7, 0], intensity: 14, radius: 0.1 }], keyIntensity: 0, fillIntensity: 0 },
    bake: { preset: 'draft', samples: 8, texelsPerUnit: 2 },
    cloth: { duration: 0.5, sheets: [{ node: 'flag', pin: ['top'] }] },
  };
}

/** A worker that answers like the real one, in this process. Input and output cross structuredClone, as they would a real worker. */
export function createInProcessWorker(requestedKernels = []) {
  const worker = {
    terminated: false,
    postMessage(message) {
      requestedKernels.push(message.name);
      const { response } = answerKernelRequest(structuredClone(message));
      setTimeout(() => worker.onmessage?.({ data: structuredClone(response) }), 0);
    },
    terminate() {
      worker.terminated = true;
    },
  };
  return worker;
}

export function digestOf(value) {
  const hash = createHash('sha256');
  const visit = (item) => {
    if (ArrayBuffer.isView(item)) {
      hash.update(Buffer.from(item.buffer, item.byteOffset, item.byteLength));
    } else if (Array.isArray(item)) {
      item.forEach(visit);
    } else if (item && typeof item === 'object') {
      for (const key of Object.keys(item).sort()) {
        hash.update(key);
        visit(item[key]);
      }
    } else {
      hash.update(String(item));
    }
  };
  visit(value);
  return hash.digest('hex');
}

const TEXTURE_FIELDS = ['map', 'normalMap', 'metallicRoughnessMap', 'emissiveMap', 'lightMap'];

/** Hash of everything a render reads from the scene: geometry and textures at rest, then geometry with the cloth in motion. */
export function sceneDigest(scene) {
  const atRest = scene.parts.map(part => [part.geometry, TEXTURE_FIELDS.map(field => part.material[field])]);
  scene.sampleMotion(0.4);
  const inMotion = scene.parts.map(part => part.geometry);
  const { seconds, ...bakeReport } = scene.inspect().bake;
  return digestOf({ atRest, inMotion, bakeReport });
}

/** Builds the room cold, in this process, either plainly or through `buildWithKernels` with an in-process worker. */
export async function buildKernelRoom(mode) {
  const requestedKernels = [];
  if (mode === 'inline') {
    return { scene: createAgentScene(kernelRoom()), requestedKernels };
  }
  const scene = await buildWithKernels(() => {
    const built = createAgentScene(kernelRoom());
    built.parts.forEach(part => void part.material.map);
    return built;
  }, { createWorker: () => createInProcessWorker(requestedKernels), available: true });
  return { scene, requestedKernels };
}
