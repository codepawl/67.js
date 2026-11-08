// The offline path tracer that a render job selects with settings.renderer, as plain data for the MCP server. The code
// and its own bounds are src/path-tracer.js; tests/path-tracer.test.js keeps these numbers equal to PATH_TRACER_LIMITS
// there. It lives apart from agent-scene-capabilities.js so the agent scene bundle does not carry it. maxSeconds stops
// below the job deadline.
export const PATH_TRACER_JOB_LIMITS = Object.freeze({
  samples: Object.freeze({ minimum: 1, maximum: 1024, default: 64 }),
  bounces: Object.freeze({ minimum: 1, maximum: 16, default: 8 }),
  maxSeconds: Object.freeze({ minimum: 1, maximum: 600, default: 120 }),
  seed: Object.freeze({ minimum: 0, maximum: 2147483647, default: 0 }),
  noiseThreshold: Object.freeze({ minimum: 0, maximum: 0.1, default: 0 }),
});

// "wavelet" is the built-in filter (true), "none" is no filter (false), and "oidn" is Intel Open Image Denoise from the optional
// package @codepawlhq/67js-denoise-oidn. A job that asks for "oidn" and leaves samples out gets OIDN_DEFAULT_SAMPLES.
export const PATH_TRACER_DENOISERS = Object.freeze(['wavelet', 'oidn', 'none']);
export const OIDN_DEFAULT_SAMPLES = 16;

export const PATH_TRACER_CAPABILITIES = Object.freeze({
  setting: 'settings.renderer { type: "pathTracer", backend ("cpu" default | "gpu" | "native"), samples, bounces, denoise (true | false | "wavelet" | "oidn" | "none"), seed, maxSeconds, noiseThreshold }; image, stills and video jobs, no passes. backend gpu needs a runtime on the GPU backend; backend native uses hardware ray queries through the optional @codepawlhq/67js-render-native package and falls back to gpu (cpu on a cpu runtime) with metrics.pathTracer.backendNote when the package, its binary or a Vulkan ray query adapter is missing (it draws no volume fog or subsurface, named in report.ignored); the report names backend, gpuCompileSeconds and gpuKernelCompiles (1 for a whole film). Past maxSeconds on one frame the job fails.',
  noiseThreshold: 'Default 0 draws every sample. Above 0 a pixel stops once its standard error relative to its mean is under the value, checked from 16 samples on: faster and noisier, and it cost quality on spot-area (score 0.0658 at 0, 0.0900 at 0.03). docs/path-tracer.md has the table.',
  traces: 'emissive maps and strength; volume fog as a uniform medium (density, colour, anisotropy, box; noise, drift and ambient are not used); the material subsurface block as a bounded random walk on the cpu and gpu backends (at most 32 scattering events, mean free path radius times scale in metres), and a card with nothing behind it as thin translucency.',
  skips: 'occlusion maps, liquids, anisotropy, iridescence, sheen, caustics, depth of field, bloom; metrics.pathTracer.ignored in the job result lists what the scene asked for.',
  limits: PATH_TRACER_JOB_LIMITS,
});
