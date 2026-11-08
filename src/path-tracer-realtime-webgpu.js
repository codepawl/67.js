import { buildTraceScene } from './path-tracer-scene.js';
import { createCamera } from './path-tracer.js';
import { prepareRealtimeKernel } from './path-tracer-webgpu.js';
import { REALTIME_KERNEL_PIECES } from './path-tracer-realtime-webgpu-kernel.js';
import { cacheCellSizes } from './path-tracer-realtime-options.js';
import { createWebGpuDenoiser, createWebGpuRadianceCache } from './path-tracer-realtime-webgpu-passes.js';

// The WebGPU backend of the real-time path tracer (issue #624): the same frame as path-tracer-realtime.js, one path per
// pixel at half the output size, two bounces ended by the radiance cache, then the temporal denoiser, but every step is a
// compute pass of one command buffer and the tracing is the WebGPU megakernel (path-tracer-webgpu.js, which compiles in
// under a second). The kernel pieces are in path-tracer-realtime-webgpu-kernel.js, the cache and denoiser passes in
// path-tracer-realtime-webgpu-passes.js. The picture goes to `canvas` through a buffer to texture copy.

const TILE_CELL_SIZE_WORD = 48;
const TILE_LEVEL_DISTANCE_WORD = 49;
const SAMPLE_INDEX_WORD = 43;

const watchedDevices = new WeakSet();

// A rejected command does not throw in the page; the device reports it here, and the frame stays black or stale.
function reportDeviceErrors(device) {
  if (watchedDevices.has(device)) return;
  watchedDevices.add(device);
  device.addEventListener('uncapturederror', event => console.error(`WebGPU real-time tracer: ${event.error.message}`));
}

function createOutputCanvas(width, height) {
  const canvas = typeof document === 'undefined' ? new OffscreenCanvas(width, height) : document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

/** `resolved` is what `resolveRealtimeOptions` returns for the options of `createRealtimeTracer`; `suppliedCanvas` is optional. */
export async function createWebGpuRealtimeTracer(scene, resolved, suppliedCanvas) {
  const { outputWidth, outputHeight, traceWidth, traceHeight, options, historyLimit, filterIterations, cacheCellSize } = resolved;
  let traceScene = null;
  let kernel = null;
  let device = null;
  let traced = null;
  let cache = null;
  let denoiser = null;
  let canvas = null;
  let context = null;
  let parameterBuffer = null;
  let recordBuffer = null;
  let traceGroups = null;
  let cellSizes = null;
  const pixelCount = traceWidth * traceHeight;
  const swapped = navigator.gpu.getPreferredCanvasFormat() === 'bgra8unorm';
  let currentSet = 0;
  let frameIndex = 0;
  let view = null;
  let resetHistory = true;
  let clearCache = true;
  let disposed = false;

  const loadScene = async (parts, environment) => {
    traceScene = buildTraceScene(parts, environment);
    const next = await prepareRealtimeKernel(traceScene, options, REALTIME_KERNEL_PIECES);
    const previousKernel = kernel;
    kernel = next;
    device = kernel.device;
    reportDeviceErrors(device);
    if (!traced) {
      traced = [0, 1].map(index => device.createBuffer({ label: `traced ${index}`, size: pixelCount * 16 * 3, usage: GPUBufferUsage.STORAGE }));
      recordBuffer = device.createBuffer({ label: 'cache records', size: pixelCount * 16, usage: GPUBufferUsage.STORAGE });
      parameterBuffer = device.createBuffer({ label: 'realtime parameters', size: 512, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      cache = await createWebGpuRadianceCache(device);
      denoiser = await createWebGpuDenoiser(device, { traceWidth, traceHeight, outputWidth, outputHeight, tracedBuffers: traced, historyLimit, filterIterations, swapped });
      canvas = suppliedCanvas ?? createOutputCanvas(outputWidth, outputHeight);
      context = canvas.getContext('webgpu');
      context.configure({ device, format: navigator.gpu.getPreferredCanvasFormat(), usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_DST, alphaMode: 'opaque' });
    }
    previousKernel?.uploaded.buffers.forEach(buffer => buffer.destroy());
    traceGroups = [0, 1].map(set => device.createBindGroup({
      layout: kernel.bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: parameterBuffer, size: kernel.parameterBytes } },
        ...[...kernel.uploaded.buffers, traced[set], cache.table, recordBuffer].map((buffer, index) => ({ binding: index + 1, resource: { buffer } })),
      ],
    }));
    cellSizes = cacheCellSizes(traceScene, cacheCellSize);
    view = null;
    resetHistory = true;
    clearCache = true;
  };

  await loadScene(scene.parts, scene.environment ?? {});

  const writeParameters = (camera) => {
    const words = kernel.parameterWords(camera);
    const floats = new Float32Array(words.buffer);
    floats[TILE_CELL_SIZE_WORD] = cellSizes.cellSize;
    floats[TILE_LEVEL_DISTANCE_WORD] = cellSizes.levelDistance;
    words[SAMPLE_INDEX_WORD] = frameIndex + 1;
    device.queue.writeBuffer(parameterBuffer, 0, words);
  };

  const encodeFrame = (nextView, previousView) => {
    const encoder = device.createCommandEncoder();
    if (clearCache) {
      cache.clear(encoder);
      clearCache = false;
    }
    const pass = encoder.beginComputePass();
    pass.setPipeline(kernel.pipeline);
    pass.setBindGroup(0, traceGroups[currentSet], [0]);
    pass.dispatchWorkgroups(Math.ceil(traceWidth / 8), Math.ceil(traceHeight / 8));
    cache.encode(pass, recordBuffer, pixelCount);
    denoiser.encode(pass, currentSet, { camera: nextView, previousCamera: previousView, resetHistory, farDistance: traceScene.farDistance });
    pass.end();
    encoder.copyBufferToTexture(
      { buffer: denoiser.outputBuffer, bytesPerRow: denoiser.rowWords * 4, rowsPerImage: outputHeight },
      { texture: context.getCurrentTexture() },
      { width: outputWidth, height: outputHeight },
    );
    device.queue.submit([encoder.finish()]);
  };

  return {
    gpu: kernel.gpu,
    backend: 'webgpu',
    fallbackReason: null,
    get canvas() { return canvas; },
    width: outputWidth,
    height: outputHeight,
    traceWidth,
    traceHeight,
    get compileSeconds() { return kernel.compileSeconds; },
    get frameCount() { return frameIndex; },

    /** A new scene: the radiance cache and the denoiser's history start over. */
    async update({ parts, environment }) {
      if (parts) await loadScene(parts, environment ?? {});
    },

    /** Forgets the denoiser's history (the cache stays: it only depends on the scene). */
    resetHistory() {
      resetHistory = true;
    },

    /** Draws one frame to `canvas` for a camera. With `wait` the result has a `done` promise that settles when the GPU is done, for timing. */
    frame(camera, { wait = false } = {}) {
      if (disposed) throw new Error('This real-time tracer was disposed.');
      const nextView = createCamera(camera, outputWidth, outputHeight);
      const previousView = view ?? nextView;
      writeParameters(nextView);
      view = nextView;
      encodeFrame(nextView, previousView);
      resetHistory = false;
      currentSet = 1 - currentSet;
      frameIndex++;
      return { frame: frameIndex, done: wait ? device.queue.onSubmittedWorkDone() : undefined };
    },

    /** The last frame as tone mapped bytes, top row first. */
    async readFrame() {
      const rowBytes = denoiser.rowWords * 4;
      const readback = device.createBuffer({ size: rowBytes * outputHeight, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
      const encoder = device.createCommandEncoder();
      encoder.copyBufferToBuffer(denoiser.outputBuffer, 0, readback, 0, rowBytes * outputHeight);
      device.queue.submit([encoder.finish()]);
      await readback.mapAsync(GPUMapMode.READ);
      const packed = new Uint8Array(readback.getMappedRange());
      const rgba = new Uint8ClampedArray(outputWidth * outputHeight * 4);
      for (let row = 0; row < outputHeight; row++) {
        for (let column = 0; column < outputWidth; column++) {
          const source = row * rowBytes + column * 4;
          const target = (row * outputWidth + column) * 4;
          rgba[target] = packed[source + (swapped ? 2 : 0)];
          rgba[target + 1] = packed[source + 1];
          rgba[target + 2] = packed[source + (swapped ? 0 : 2)];
          rgba[target + 3] = 255;
        }
      }
      readback.destroy();
      return { width: outputWidth, height: outputHeight, rgba };
    },

    dispose() {
      disposed = true;
      cache.dispose();
      denoiser.dispose();
      for (const buffer of [...traced, recordBuffer, parameterBuffer, ...kernel.uploaded.buffers]) buffer.destroy();
      context.unconfigure();
    },
  };
}
