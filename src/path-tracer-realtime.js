import { buildTraceScene, refuseLocalVolumes } from './path-tracer-scene.js';
import { createCamera } from './path-tracer.js';
import { getContext, getKernel, releaseResources, setSceneUniforms, uploadScene } from './path-tracer-gpu.js';
import { sceneUsesSubsurface } from './path-tracer-gpu-pack.js';
import { createRadianceCache } from './path-tracer-radiance-cache.js';
import { createTemporalDenoiser } from './path-tracer-temporal-denoise.js';
import { createFloatTexture, createFramebuffer, FIRST_PASS_TEXTURE_UNIT } from './path-tracer-realtime-gl.js';
import { cacheCellSizes, resolveRealtimeOptions, viewsMatch } from './path-tracer-realtime-options.js';

// A real-time hybrid view of the GPU path tracer (issue #624): one path per pixel and frame at half the output size,
// two bounces, ended by a spatial hash radiance cache, then a temporal denoiser that also upsamples to the output size.
// `frame(camera)` draws one picture to `canvas`. Primary hits are traced, not rasterized (the tracer's first hit already
// gives the albedo, normal and distance a G-buffer would), and motion vectors come from the camera's move (the scene is
// static). It shares the WebGL2 context of `traceOnGpu`, so one render at a time owns it. The pieces:
//   path-tracer-radiance-cache.js, path-tracer-temporal-denoise.js, path-tracer-reprojection.js.

/**
 * `scene` is `{ parts, environment, camera }` as `renderPathTracedImage` takes them. `options`: `width` and `height` of the
 * output, `bounces` (2), `resolutionDivisor` (2: the tracing size is half the output), `seed`, `lightSelection`
 * ("importance"), `historyLimit` and `filterIterations` of the denoiser, `cacheCellSize` (the scene's size over 200).
 * The picture is tone mapped with ACES like the default view transform. `backend` is "gpu" (WebGL2, the default) or
 * "webgpu" (compute passes, path-tracer-realtime-webgpu.js): without WebGPU on the page, "webgpu" falls back to WebGL2, and
 * the tracer's `backend` and `fallbackReason` say so. The WebGPU tracer draws to its own `canvas` (or the one in
 * `options.canvas`), and its `readFrame` and `frame({ wait })` return promises.
 */
export async function createRealtimeTracer(scene, rawOptions = {}) {
  const resolved = resolveRealtimeOptions(rawOptions);
  let fallbackReason = null;
  if (resolved.backend === 'webgpu') {
    try {
      const { createWebGpuRealtimeTracer } = await import('./path-tracer-realtime-webgpu.js');
      return await createWebGpuRealtimeTracer(scene, resolved, rawOptions.canvas);
    } catch (error) {
      fallbackReason = error.message;
    }
  }
  const { outputWidth, outputHeight, traceWidth, traceHeight, options, historyLimit, filterIterations, cacheCellSize } = resolved;
  const { gl, gpu } = getContext();
  if (gl.getParameter(gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS) < FIRST_PASS_TEXTURE_UNIT + 12) throw new Error('The real-time path tracer needs 28 texture units.');
  gl.canvas.width = outputWidth;
  gl.canvas.height = outputHeight;

  const radianceTextures = [createFloatTexture(gl, traceWidth, traceHeight), createFloatTexture(gl, traceWidth, traceHeight)];
  const normalTextures = [createFloatTexture(gl, traceWidth, traceHeight), createFloatTexture(gl, traceWidth, traceHeight)];
  const albedoTexture = createFloatTexture(gl, traceWidth, traceHeight);
  const recordTexture = createFloatTexture(gl, traceWidth, traceHeight);
  const traceFramebuffers = [0, 1].map(index => createFramebuffer(gl, [
    { slot: 0, texture: radianceTextures[index] }, { slot: 1, texture: albedoTexture }, { slot: 2, texture: normalTextures[index] }, { slot: 4, texture: recordTexture },
  ]));
  const cache = createRadianceCache(gl);
  const denoiser = createTemporalDenoiser(gl, { traceWidth, traceHeight, outputWidth, outputHeight, historyLimit, filterIterations });
  const synchronizationPixel = new Uint8Array(4);

  let traceScene = null;
  let program = null;
  let lightCount = 0;
  let cacheTextureUnit = 0;
  let compileSeconds = 0;
  let currentSet = 0;
  let frameIndex = 0;
  let view = null;
  let previousView = null;
  let resetHistory = true;
  let disposed = false;

  const loadScene = (parts, environment) => {
    releaseResources(gl);
    traceScene = buildTraceScene(parts, environment);
    refuseLocalVolumes(traceScene, 'the WebGL realtime path tracer');
    const kernel = getKernel(sceneUsesSubsurface(traceScene.materials), false, options);
    program = kernel.program;
    compileSeconds = kernel.compileSeconds;
    gl.useProgram(program);
    const uploaded = uploadScene(gl, program, traceScene, options);
    lightCount = uploaded.lightCount;
    cacheTextureUnit = uploaded.nextUnit;
    gl.uniform1i(gl.getUniformLocation(program, 'uRadianceCache'), cacheTextureUnit);
    const { cellSize, levelDistance } = cacheCellSizes(traceScene, cacheCellSize);
    gl.uniform1f(gl.getUniformLocation(program, 'uCacheCellSize'), cellSize);
    gl.uniform1f(gl.getUniformLocation(program, 'uCacheLevelDistance'), levelDistance);
    cache.clear();
    view = null;
    resetHistory = true;
  };

  loadScene(scene.parts, scene.environment ?? {});

  const traceOneSample = () => {
    gl.useProgram(program);
    gl.uniform1i(gl.getUniformLocation(program, 'uSample'), frameIndex + 1);
    gl.activeTexture(gl.TEXTURE0 + cacheTextureUnit);
    gl.bindTexture(gl.TEXTURE_2D, cache.texture);
    gl.bindFramebuffer(gl.FRAMEBUFFER, traceFramebuffers[currentSet]);
    gl.viewport(0, 0, traceWidth, traceHeight);
    gl.disable(gl.BLEND);
    gl.disable(gl.SCISSOR_TEST);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };

  return {
    gpu,
    backend: 'gpu',
    fallbackReason,
    canvas: gl.canvas,
    width: outputWidth,
    height: outputHeight,
    traceWidth,
    traceHeight,
    get compileSeconds() { return compileSeconds; },
    get frameCount() { return frameIndex; },

    /** A new scene: the radiance cache and the denoiser's history start over. */
    update({ parts, environment }) {
      if (parts) loadScene(parts, environment ?? {});
    },

    /** Forgets the denoiser's history (the cache stays: it only depends on the scene). */
    resetHistory() {
      resetHistory = true;
    },

    /** Draws one frame to `canvas` for a camera. With `wait` the call returns once the GPU is done, for timing. */
    frame(camera, { wait = false } = {}) {
      if (disposed) throw new Error('This real-time tracer was disposed.');
      const nextView = createCamera(camera, outputWidth, outputHeight);
      previousView = view ?? nextView;
      if (!viewsMatch(view, nextView)) {
        gl.useProgram(program);
        setSceneUniforms(gl, program, traceScene, nextView, options, lightCount);
      }
      view = nextView;
      traceOneSample();
      cache.update(recordTexture, traceWidth, traceHeight);
      denoiser.run({
        radiance: radianceTextures[currentSet], albedo: albedoTexture, normal: normalTextures[currentSet],
        previousRadiance: radianceTextures[1 - currentSet], previousNormal: normalTextures[1 - currentSet],
        camera: view, previousCamera: previousView, resetHistory, farDistance: traceScene.farDistance,
      });
      resetHistory = false;
      currentSet = 1 - currentSet;
      frameIndex++;
      // gl.finish() does not wait in every browser; reading one value back does.
      if (wait) gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, synchronizationPixel);
      return { frame: frameIndex };
    },

    /** The last frame as tone mapped bytes, top row first. Call it right after `frame`, before the page gets a turn. */
    readFrame() {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      const bottomUp = new Uint8Array(outputWidth * outputHeight * 4);
      gl.readPixels(0, 0, outputWidth, outputHeight, gl.RGBA, gl.UNSIGNED_BYTE, bottomUp);
      const rgba = new Uint8ClampedArray(bottomUp.length);
      const rowBytes = outputWidth * 4;
      for (let row = 0; row < outputHeight; row++) rgba.set(bottomUp.subarray((outputHeight - 1 - row) * rowBytes, (outputHeight - row) * rowBytes), row * rowBytes);
      return { width: outputWidth, height: outputHeight, rgba };
    },

    dispose() {
      disposed = true;
      cache.dispose();
      denoiser.dispose();
      for (const texture of [...radianceTextures, ...normalTextures, albedoTexture, recordTexture]) gl.deleteTexture(texture);
      for (const framebuffer of traceFramebuffers) gl.deleteFramebuffer(framebuffer);
      releaseResources(gl);
    },
  };
}
