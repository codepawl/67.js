// Page side of the issue #625 spike: builds the demo room trace scene once, then traces it with the WGSL megakernel
// (traceWithWebGpu) or with the shipped WebGL2 kernel (traceWithWebGl), undenoised, and returns timings and a tone mapped PNG.
import { KERNEL_SOURCE, WORKGROUP_SIZE } from './kernel.js';
import { packAtlas, packEnvironment, packLights, packMaterials, packNodes, packTriangles } from '/src/path-tracer-gpu-pack.js';
import { createCamera, toneMapToRgba8 } from '/src/path-tracer.js';
import { buildTraceScene } from '/src/path-tracer-scene.js';

let prepared = null;

async function prepareScene(recipe, width, height) {
  const { createAgentScene, loadAllAgentSceneModules, needsMeshBooleans, loadMeshBooleans, setManifoldModuleLoader } = await import('/src/agent-scene.js');
  const { agentEnvironmentMap } = await import('/src/agent-look.js');
  await loadAllAgentSceneModules();
  if (needsMeshBooleans(recipe)) {
    setManifoldModuleLoader(() => import(/* @vite-ignore */ '/node_modules/manifold-3d/manifold.js'));
    await loadMeshBooleans();
  }
  const agentScene = createAgentScene(recipe);
  const environment = { ...agentScene.environment, map: agentEnvironmentMap(agentScene.environment) };
  const started = performance.now();
  const scene = buildTraceScene(agentScene.parts, environment);
  const camera = createCamera(agentScene.camera, width, height);
  prepared = { scene, camera, width, height };
  return { triangles: scene.indices.length / 3, buildSeconds: (performance.now() - started) / 1000 };
}

function median(values) {
  const sorted = [...values].sort((first, second) => first - second);
  return sorted[Math.floor(sorted.length / 2)];
}

async function pngBase64(linear, width, height) {
  const rgba = toneMapToRgba8(linear, width, height, { viewTransform: 'aces', look: null });
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d').putImageData(new ImageData(rgba, width, height), 0, 0);
  return canvas.toDataURL('image/png').split(',')[1];
}

// The first call compiles the kernel (its compileSeconds), so tracedSeconds is taken from a second, warm call.
async function traceWithWebGl(options) {
  const { traceOnGpu } = await import('/src/path-tracer-gpu.js');
  const { scene, camera } = prepared;
  const firstStarted = performance.now();
  const first = await traceOnGpu(scene, camera, options, () => {});
  const firstTotalSeconds = (performance.now() - firstStarted) / 1000;
  const started = performance.now();
  const traced = await traceOnGpu(scene, camera, options, () => {});
  const tracedSeconds = (performance.now() - started) / 1000;
  return { gpu: traced.gpu, compileSeconds: first.compileSeconds, firstTotalSeconds, tracedSeconds, image: await pngBase64(traced.color, options.width, options.height) };
}

function createStorageBuffer(device, data, label) {
  const buffer = device.createBuffer({ label, size: Math.max(16, Math.ceil(data.byteLength / 4) * 4), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(buffer, 0, data.buffer, data.byteOffset, data.byteLength);
  return buffer;
}

function packAtlasWords(atlas) {
  return new Uint32Array(atlas.data.buffer, atlas.data.byteOffset, Math.floor(atlas.data.byteLength / 4));
}

function writeParams(scene, camera, options, lightCount, atlas, sampleIndex) {
  const buffer = new ArrayBuffer(12 * 16);
  const floats = new Float32Array(buffer);
  const ints = new Int32Array(buffer);
  const words = new Uint32Array(buffer);
  const { sun } = scene.lights;
  const { environment } = scene;
  floats.set([...camera.eye, 0], 0);
  floats.set([...camera.forward, 0], 4);
  floats.set([...camera.right, 0], 8);
  floats.set([...camera.above, 0], 12);
  floats.set([...(sun?.direction ?? [0, 1, 0]), 0], 16);
  floats.set([...(sun?.color ?? [0, 0, 0]), Math.cos(Math.PI / 360)], 20);
  floats.set([environment?.width ?? 1, environment?.height ?? 1, environment?.intensity ?? 1, environment?.total ?? 1], 24);
  floats.set([environment?.cosine ?? 1, environment?.sine ?? 0, scene.surfaceOffset, scene.farDistance], 28);
  floats.set([camera.halfWidth, camera.halfHeight, options.fireflyClamp, 0], 32);
  ints.set([options.width, options.height, options.bounces, lightCount], 36);
  ints.set([(sun ? 1 : 0) + lightCount + (environment ? 1 : 0), sun ? 1 : 0, environment ? 1 : 0, sampleIndex], 40);
  words.set([options.seed >>> 0, atlas.width, 0, 0], 44);
  return buffer;
}

async function traceWithWebGpu(options) {
  const { scene, camera } = prepared;
  const { width, height, samples } = options;
  const pixelCount = width * height;
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  const device = await adapter.requestDevice({
    requiredLimits: {
      maxStorageBufferBindingSize: Math.min(adapter.limits.maxStorageBufferBindingSize, 1 << 30),
      maxBufferSize: Math.min(adapter.limits.maxBufferSize, 1 << 30),
    },
  });
  device.addEventListener('uncapturederror', event => console.log('WEBGPU ERROR', event.error.message));
  const compileStarted = performance.now();
  const module = device.createShaderModule({ label: 'path tracer', code: KERNEL_SOURCE });
  const info = await module.getCompilationInfo();
  const errors = info.messages.filter(message => message.type === 'error').map(message => `${message.lineNum}: ${message.message}`);
  if (errors.length > 0) throw new Error(`WGSL did not compile:\n${errors.slice(0, 12).join('\n')}`);
  const pipeline = await device.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint: 'main' } });
  const compileSeconds = (performance.now() - compileStarted) / 1000;
  // Building the same pipeline again measures the in-process cache, not the driver compile.
  const secondStarted = performance.now();
  await device.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint: 'main' } });
  const secondCompileSeconds = (performance.now() - secondStarted) / 1000;

  const uploadStarted = performance.now();
  const atlas = packAtlas(scene.materials);
  const lights = packLights(scene.lights);
  const environment = packEnvironment(scene.environment);
  const environmentTables = new Float32Array(environment ? environment.height + environment.width * environment.height : 4);
  if (environment) {
    environmentTables.set(environment.rows.data.subarray(0, environment.height), 0);
    environmentTables.set(environment.pixels.data.subarray(0, environment.width * environment.height), environment.height);
  }
  const buffers = [
    createStorageBuffer(device, packNodes(scene.bvh).data, 'nodes'),
    createStorageBuffer(device, packTriangles(scene).data, 'triangles'),
    createStorageBuffer(device, packMaterials(scene.materials, atlas).data, 'materials'),
    createStorageBuffer(device, lights.table.data, 'lights'),
    createStorageBuffer(device, packAtlasWords(atlas), 'atlas'),
    createStorageBuffer(device, environment?.colors ?? new Float32Array(4), 'environment colors'),
    createStorageBuffer(device, environmentTables, 'environment tables'),
  ];
  const accumulation = device.createBuffer({ label: 'accumulation', size: pixelCount * 4 * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
  const parameters = device.createBuffer({ label: 'parameters', size: 12 * 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [parameters, ...buffers, accumulation].map((buffer, binding) => ({ binding, resource: { buffer } })),
  });
  await device.queue.onSubmittedWorkDone();
  const uploadSeconds = (performance.now() - uploadStarted) / 1000;

  const traceStarted = performance.now();
  const sampleSeconds = [];
  for (let sampleIndex = 0; sampleIndex < samples; sampleIndex++) {
    const sampleStarted = performance.now();
    device.queue.writeBuffer(parameters, 0, writeParams(scene, camera, options, lights.count, atlas, sampleIndex));
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(Math.ceil(width / WORKGROUP_SIZE), Math.ceil(height / WORKGROUP_SIZE));
    pass.end();
    device.queue.submit([encoder.finish()]);
    await device.queue.onSubmittedWorkDone();
    sampleSeconds.push((performance.now() - sampleStarted) / 1000);
  }
  const dispatchSeconds = (performance.now() - traceStarted) / 1000;

  const readback = device.createBuffer({ size: pixelCount * 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  const encoder = device.createCommandEncoder();
  encoder.copyBufferToBuffer(accumulation, 0, readback, 0, pixelCount * 16);
  device.queue.submit([encoder.finish()]);
  await readback.mapAsync(GPUMapMode.READ);
  const sums = new Float32Array(readback.getMappedRange());
  const color = new Float32Array(pixelCount * 3);
  for (let pixel = 0; pixel < pixelCount; pixel++) {
    for (let channel = 0; channel < 3; channel++) color[pixel * 3 + channel] = sums[pixel * 4 + channel] / samples;
  }
  const tracedSeconds = (performance.now() - traceStarted) / 1000;
  const image = await pngBase64(color, width, height);
  return {
    gpu: `${adapter.info.vendor} ${adapter.info.architecture}`, compileSeconds, secondCompileSeconds, uploadSeconds, dispatchSeconds, tracedSeconds,
    firstSampleSeconds: sampleSeconds[0], medianSampleSeconds: median(sampleSeconds), image,
  };
}

window.prepareScene = prepareScene;
window.traceWithWebGl = traceWithWebGl;
window.traceWithWebGpu = traceWithWebGpu;
window.harnessReady = true;
