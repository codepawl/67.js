import { buildTraceScene } from './path-tracer-scene.js';
import { denoiseRadiance } from './path-tracer-denoise.js';
import { createCamera, normalizePathTracerOptions, toneMapToRgba8 } from './path-tracer.js';
import {
  averageBuffers, createBandState, createTargets, drawOneSample, getContext, getKernel, releaseResources, setSceneUniforms, uploadScene, withBlueNoiseTile,
} from './path-tracer-gpu.js';
import { sceneUsesSubsurface } from './path-tracer-gpu-pack.js';

// A progressive view of the GPU path tracer (issue #623). `step()` draws one sample for every pixel and adds it to the
// image; while the scene and camera rest the image gets cleaner with each step, and `update()` starts it over. Like the
// Cycles viewport, it starts at a fraction of the resolution (one sample each at 1/4 and 1/2) so the first picture
// appears at once, then draws at full size. It shares the WebGL2 context of `traceOnGpu`, so one render at a time owns it.

const DEFAULT_RESOLUTION_DIVISORS = Object.freeze([4, 2, 1]);

/**
 * `scene` is `{ parts, environment, camera }` as `renderPathTracedImage` takes them. `options` are the same options
 * (`width`, `height`, `bounces`, `seed`, `samplingPattern`, `lightSelection`, `denoise`, `viewTransform`); `samples` and
 * `backend` are not used. `resolutionDivisors` lists the sizes drawn first, one sample each, ending with 1.
 */
export async function createProgressiveTracer(scene, rawOptions = {}, { resolutionDivisors = DEFAULT_RESOLUTION_DIVISORS } = {}) {
  const options = await withBlueNoiseTile(normalizePathTracerOptions({ ...rawOptions, backend: 'gpu', samples: 1, maxSeconds: rawOptions.maxSeconds ?? 3600 }));
  const { gl, gpu } = getContext();
  const { width, height } = options;
  let traceScene = null;
  let program = null;
  let compileSeconds = 0;
  let lightCount = 0;
  let levelIndex = 0;
  let samples = 0;
  let levelFinished = false;
  const synchronizationPixel = new Float32Array(4);
  let band = createBandState(height);
  let disposed = false;

  const levelSize = () => {
    const divisor = resolutionDivisors[levelIndex];
    return { divisor, levelWidth: Math.max(1, Math.ceil(width / divisor)), levelHeight: Math.max(1, Math.ceil(height / divisor)) };
  };

  const loadScene = (parts, environment) => {
    releaseResources(gl);
    traceScene = buildTraceScene(parts, environment);
    const kernel = getKernel(sceneUsesSubsurface(traceScene.materials), false, options);
    program = kernel.program;
    compileSeconds = kernel.compileSeconds;
    gl.useProgram(program);
    lightCount = uploadScene(gl, program, traceScene, options).lightCount;
    createTargets(gl, width, height);
  };

  const loadCamera = camera => {
    const view = createCamera(camera, width, height);
    setSceneUniforms(gl, program, traceScene, view, options, lightCount);
  };

  const clearTargets = () => {
    for (let index = 0; index < 4; index++) gl.clearBufferfv(gl.COLOR, index, [0, 0, 0, 0]);
  };

  const setLevelUniforms = () => {
    const { levelWidth, levelHeight } = levelSize();
    gl.uniform2i(gl.getUniformLocation(program, 'uSize'), levelWidth, levelHeight);
  };

  const startOver = () => {
    levelIndex = 0;
    samples = 0;
    levelFinished = false;
    band = createBandState(height);
    setLevelUniforms();
    clearTargets();
  };

  loadScene(scene.parts, scene.environment ?? {});
  loadCamera(scene.camera);
  startOver();

  return {
    gpu,
    get compileSeconds() { return compileSeconds; },
    get samples() { return samples; },
    get level() { return { ...levelSize(), final: levelIndex === resolutionDivisors.length - 1 }; },

    /** A new camera, and with `parts` a new scene: the image starts over at the reduced size. */
    update({ camera, parts, environment }) {
      if (parts) loadScene(parts, environment ?? {});
      if (camera) loadCamera(camera);
      startOver();
    },

    /** Draws one more sample of every pixel; resolves with the size drawn and how many samples that image holds. */
    async step(shouldStop = () => {}) {
      if (disposed) throw new Error('This progressive tracer was disposed.');
      if (levelFinished && levelIndex < resolutionDivisors.length - 1) {
        levelIndex++;
        samples = 0;
        setLevelUniforms();
        clearTargets();
      }
      const { levelWidth, levelHeight, divisor } = levelSize();
      await drawOneSample(gl, program, levelWidth, levelHeight, samples, band, shouldStop);
      // gl.finish() does not wait in every browser; reading one value back does, so a step is over when this returns.
      gl.readBuffer(gl.COLOR_ATTACHMENT0);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.FLOAT, synchronizationPixel);
      samples++;
      levelFinished = true;
      return { width: levelWidth, height: levelHeight, divisor, samples };
    },

    /**
     * The image as it stands after the last `step()`, at the size of that step: linear colour (filtered unless
     * `denoise` is off), tone mapped bytes and the samples each pixel holds. It reads the targets back, so it is not free.
     */
    snapshot() {
      const { levelWidth, levelHeight } = levelSize();
      const buffers = averageBuffers(gl, levelWidth, levelHeight, samples);
      for (let pixel = 0; pixel < levelWidth * levelHeight; pixel++) {
        const length = Math.hypot(buffers.normal[pixel * 3], buffers.normal[pixel * 3 + 1], buffers.normal[pixel * 3 + 2]) || 1;
        for (let channel = 0; channel < 3; channel++) buffers.normal[pixel * 3 + channel] /= length;
      }
      const { samplesTaken, ...features } = buffers;
      const linear = options.denoiser === 'wavelet' ? denoiseRadiance({ width: levelWidth, height: levelHeight, ...features }) : buffers.color;
      return { width: levelWidth, height: levelHeight, linear, rgba: toneMapToRgba8(linear, levelWidth, levelHeight, options), samples, features };
    },

    dispose() {
      disposed = true;
      releaseResources(gl);
    },
  };
}
