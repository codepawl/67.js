import { resolveLightSelection } from './path-tracer-light-tree.js';
import { buildFragmentSource, VERTEX_SOURCE } from './path-tracer-gpu-shader.js';
import { gpuTriangleCapacity, packAtlas, packEnvironment, packLightTree, packLights, packMaterials, packNodes, packSubsurface, packTriangles, sceneUsesSubsurface } from './path-tracer-gpu-pack.js';
import { MAX_GPU_TRACE_TRIANGLES } from './path-tracer-scene.js';

// The GPU backend of the path tracer: one WebGL2 fragment pass per sample draws every pixel of a band, and four float
// targets add the samples up. It needs a page with WebGL2 (a canvas), EXT_color_buffer_float and EXT_float_blend. The
// CPU tracer stays the reference: the same scene, camera, options and random numbers go in, the same buffers come out.

const TARGET_COUNT = 4;
const DRAW_SECONDS_TARGET = 0.08;
const MINIMUM_BAND_ROWS = 4;
const YIELD_SECONDS = 0.25;

function createCanvas() {
  if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(1, 1);
  if (typeof document !== 'undefined') return document.createElement('canvas');
  return null;
}

/** True when this page can run the GPU tracer. */
export function isGpuTracerAvailable() {
  const canvas = createCanvas();
  const context = canvas?.getContext('webgl2');
  if (!context) return false;
  return Boolean(context.getExtension('EXT_color_buffer_float') && context.getExtension('EXT_float_blend'));
}

function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(`The GPU path tracer shader did not compile: ${gl.getShaderInfoLog(shader)}`);
  }
  return shader;
}

function createProgram(gl, variant) {
  const program = gl.createProgram();
  gl.attachShader(program, compileShader(gl, gl.VERTEX_SHADER, VERTEX_SOURCE));
  gl.attachShader(program, compileShader(gl, gl.FRAGMENT_SHADER, buildFragmentSource(variant)));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`The GPU path tracer program did not link: ${gl.getProgramInfoLog(program)}`);
  return program;
}

// Textures and targets of the render in progress; the context and program outlive it (compiling the kernel takes seconds).
const resources = [];
let session = null;

function createTexture(gl, unit, internalFormat, format, type, width, height, data) {
  const texture = gl.createTexture();
  resources.push(texture);
  gl.activeTexture(gl.TEXTURE0 + unit);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, width, height, 0, format, type, data);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return texture;
}

/**
 * The options with the blue noise tile of the seed added when the sampling pattern needs it. The tile maker loads on
 * demand, so a render that draws random samples (and the light bake) does not carry it.
 */
export async function withBlueNoiseTile(options) {
  if (options.samplingPattern !== 'blue-noise-first') return options;
  const { BLUE_NOISE_SIZE, createBlueNoiseTile } = await import('./path-tracer-blue-noise.js');
  return { ...options, blueNoiseTile: { size: BLUE_NOISE_SIZE, bytes: createBlueNoiseTile(options.seed ?? 0) } };
}

export function uploadScene(gl, program, scene, options = {}) {
  const atlas = packAtlas(scene.materials);
  const lights = packLights(scene.lights);
  const environment = packEnvironment(scene.environment);
  const nodes = packNodes(scene.bvh);
  const triangles = packTriangles(scene);
  const materials = packMaterials(scene.materials, atlas, scene.shadowOnlyParts);
  const floatTables = [['uNodes', nodes], ['uTriangles', triangles], ['uMaterials', materials], ['uLights', lights.table]];
  if (sceneUsesSubsurface(scene.materials)) floatTables.push(['uSubsurface', packSubsurface(scene.materials)]);
  if (options.lightSelection === 'tree') floatTables.push(['uLightTree', packLightTree(scene.lights)]);
  let unit = 0;
  const bind = (name) => gl.uniform1i(gl.getUniformLocation(program, name), unit++);
  for (const [name, table] of floatTables) {
    createTexture(gl, unit, gl.RGBA32F, gl.RGBA, gl.FLOAT, table.width, table.height, table.data);
    bind(name);
  }
  createTexture(gl, unit, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, atlas.width, atlas.height, atlas.data);
  bind('uAtlas');
  const colors = environment?.colors ?? new Float32Array(4);
  createTexture(gl, unit, gl.RGBA32F, gl.RGBA, gl.FLOAT, environment?.width ?? 1, environment?.height ?? 1, colors);
  bind('uEnvironment');
  const empty = { width: 1, height: 1, data: new Float32Array(1) };
  for (const [name, table] of [['uEnvironmentRows', environment?.rows ?? empty], ['uEnvironmentPixels', environment?.pixels ?? empty]]) {
    createTexture(gl, unit, gl.R32F, gl.RED, gl.FLOAT, table.width, table.height, table.data);
    bind(name);
  }
  if (options.blueNoiseTile) {
    createTexture(gl, unit, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, options.blueNoiseTile.size, options.blueNoiseTile.size, options.blueNoiseTile.bytes);
    bind('uBlueNoise');
  }
  return { lightCount: lights.count, nextUnit: unit };
}

export function setSceneUniforms(gl, program, scene, camera, options, lightCount) {
  const location = name => gl.getUniformLocation(program, name);
  const { sun } = scene.lights;
  const { environment, volume } = scene;
  gl.uniform3fv(location('uEye'), camera.eye);
  gl.uniform3fv(location('uForward'), camera.forward);
  gl.uniform3fv(location('uRight'), camera.right);
  gl.uniform3fv(location('uAbove'), camera.above);
  gl.uniform2f(location('uHalfSize'), camera.halfWidth, camera.halfHeight);
  gl.uniform2i(location('uSize'), options.width, options.height);
  gl.uniform1ui(location('uSeed'), options.seed >>> 0);
  gl.uniform1i(location('uBounces'), options.bounces);
  gl.uniform1f(location('uFireflyClamp'), options.fireflyClamp);
  gl.uniform1f(location('uSurfaceOffset'), scene.surfaceOffset);
  gl.uniform1f(location('uFarDistance'), scene.farDistance);
  gl.uniform1i(location('uLightCount'), lightCount);
  gl.uniform1i(location('uEmitterCount'), (sun ? 1 : 0) + lightCount + (environment ? 1 : 0));
  gl.uniform1i(location('uHasSun'), sun ? 1 : 0);
  gl.uniform3fv(location('uSunDirection'), sun?.direction ?? [0, 1, 0]);
  gl.uniform3fv(location('uSunColor'), sun?.color ?? [0, 0, 0]);
  gl.uniform1f(location('uSunCosineMax'), Math.cos(sun?.angularRadius ?? Math.PI / 360));
  gl.uniform1i(location('uHasEnvironment'), environment ? 1 : 0);
  gl.uniform4f(location('uEnvironmentShape'), environment?.width ?? 1, environment?.height ?? 1, environment?.intensity ?? 1, environment?.total ?? 1);
  gl.uniform2f(location('uEnvironmentRotation'), environment?.cosine ?? 1, environment?.sine ?? 0);
  gl.uniform1i(location('uHasVolume'), volume ? 1 : 0);
  gl.uniform3fv(location('uVolumeMinimum'), volume?.minimum ?? [0, 0, 0]);
  gl.uniform3fv(location('uVolumeMaximum'), volume?.maximum ?? [0, 0, 0]);
  gl.uniform3fv(location('uVolumeAlbedo'), volume?.albedo ?? [1, 1, 1]);
  gl.uniform3f(location('uVolumeShape'), volume?.density ?? 0, volume?.anisotropy ?? 0, volume?.maxDistance ?? 0);
}

export function createTargets(gl, width, height) {
  const framebuffer = gl.createFramebuffer();
  resources.push(framebuffer);
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  const attachments = [];
  for (let index = 0; index < TARGET_COUNT; index++) {
    const texture = gl.createTexture();
    resources.push(texture);
    gl.activeTexture(gl.TEXTURE15);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, width, height, 0, gl.RGBA, gl.FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + index, gl.TEXTURE_2D, texture, 0);
    attachments.push(gl.COLOR_ATTACHMENT0 + index);
  }
  gl.drawBuffers(attachments);
  if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('The GPU path tracer cannot render to float targets here.');
  gl.clearBufferfv(gl.COLOR, 0, [0, 0, 0, 0]);
  for (let index = 1; index < TARGET_COUNT; index++) gl.clearBufferfv(gl.COLOR, index, [0, 0, 0, 0]);
  return attachments;
}

export function readTarget(gl, index, width, height) {
  const pixels = new Float32Array(width * height * 4);
  gl.readBuffer(gl.COLOR_ATTACHMENT0 + index);
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.FLOAT, pixels);
  return pixels;
}

export function averageBuffers(gl, width, height, samples) {
  const pixelCount = width * height;
  const radiance = readTarget(gl, 0, width, height);
  const albedo = readTarget(gl, 1, width, height);
  const normal = readTarget(gl, 2, width, height);
  const statistics = readTarget(gl, 3, width, height);
  const buffers = {
    color: new Float32Array(pixelCount * 3), albedo: new Float32Array(pixelCount * 3), normal: new Float32Array(pixelCount * 3),
    depth: new Float32Array(pixelCount), variance: new Float32Array(pixelCount), samplesTaken: new Uint16Array(pixelCount).fill(samples),
  };
  for (let pixel = 0; pixel < pixelCount; pixel++) {
    for (let channel = 0; channel < 3; channel++) {
      buffers.color[pixel * 3 + channel] = radiance[pixel * 4 + channel] / samples;
      buffers.albedo[pixel * 3 + channel] = albedo[pixel * 4 + channel] / samples;
      buffers.normal[pixel * 3 + channel] = normal[pixel * 4 + channel] / samples;
    }
    buffers.depth[pixel] = radiance[pixel * 4 + 3] / samples;
    const mean = statistics[pixel * 4] / samples;
    buffers.variance[pixel] = Math.max(0, statistics[pixel * 4 + 1] / samples - mean * mean) / Math.max(samples - 1, 1);
  }
  return buffers;
}

const nextTask = () => new Promise(resolve => setTimeout(resolve, 0));

/**
 * Traces `options.samples` paths for every pixel and resolves with the same buffers as the CPU tracer
 * (color, albedo, normal, depth, variance, samplesTaken) plus a `gpu` note. `noiseThreshold` is not used: every pixel
 * draws all its samples. `shouldStop` throws when the time limit passes.
 */
export function getContext() {
  if (session) return session;
  const canvas = createCanvas();
  const gl = canvas?.getContext('webgl2', { antialias: false, depth: false, stencil: false, alpha: false, powerPreference: 'high-performance' });
  if (!gl) throw new Error('The GPU path tracer needs WebGL2.');
  if (!gl.getExtension('EXT_color_buffer_float') || !gl.getExtension('EXT_float_blend')) throw new Error('The GPU path tracer needs float render targets with blending.');
  const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
  session = { gl, programs: new Map(), gpu: debugInfo ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) : 'unknown' };
  return session;
}

let kernelCompileCount = 0;

/** How many path tracing kernels (the light bake's texel kernel not counted) this page has compiled so far: a job of many frames compiles one, because every frame reuses the cached program. */
export function gpuKernelCompileCount() {
  return kernelCompileCount;
}

/** The kernel for a scene, compiled once per variant: a scene with a subsurface part gets the random walk, any other scene the plain kernel. */
export function getKernel(hasSubsurface, texelBake = false, options = {}) {
  const { gl, programs } = getContext();
  const blueNoise = options.samplingPattern === 'blue-noise-first';
  const lightImportance = options.lightSelection === 'importance';
  const lightTree = options.lightSelection === 'tree';
  const radianceCache = options.radianceCache === true;
  const key = `${hasSubsurface}:${texelBake}:${blueNoise}:${lightImportance}:${radianceCache}:${lightTree}`;
  if (!programs.has(key)) {
    const started = performance.now();
    const program = createProgram(gl, { hasSubsurface, texelBake, blueNoise, lightImportance, radianceCache, lightTree });
    gl.getProgramParameter(program, gl.LINK_STATUS);
    programs.set(key, { program, compileSeconds: (performance.now() - started) / 1000 });
    if (!texelBake) kernelCompileCount++;
  }
  return programs.get(key);
}

export function releaseResources(gl) {
  for (const resource of resources) {
    if (resource instanceof WebGLFramebuffer) gl.deleteFramebuffer(resource);
    else gl.deleteTexture(resource);
  }
  resources.length = 0;
}

/** The band size and the last turn given to the page, kept from one sample to the next. */
export function createBandState(height) {
  return { bandRows: Math.min(height, 32), lastYield: performance.now() };
}

/** Draws one sample of every pixel in bands that take about DRAW_SECONDS_TARGET each, giving the page a turn now and then. */
export async function drawOneSample(gl, program, width, height, sample, band, shouldStop) {
  gl.viewport(0, 0, width, height);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE);
  gl.enable(gl.SCISSOR_TEST);
  gl.uniform1i(gl.getUniformLocation(program, 'uSample'), sample);
  let rowStart = 0;
  while (rowStart < height) {
    const rows = Math.min(band.bandRows, height - rowStart);
    const firstRow = rowStart;
    rowStart += rows;
    const started = performance.now();
    gl.scissor(0, firstRow, width, rows);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.finish();
    const seconds = (performance.now() - started) / 1000;
    const scale = Math.min(2, DRAW_SECONDS_TARGET / Math.max(seconds, 1e-4));
    band.bandRows = Math.max(MINIMUM_BAND_ROWS, Math.min(height, Math.round(rows * scale)));
    shouldStop();
    if ((performance.now() - band.lastYield) / 1000 > YIELD_SECONDS) {
      await nextTask();
      band.lastYield = performance.now();
    }
  }
  gl.disable(gl.SCISSOR_TEST);
}

async function drawSamples(gl, program, width, height, samples, shouldStop) {
  const band = createBandState(height);
  for (let sample = 0; sample < samples; sample++) await drawOneSample(gl, program, width, height, sample, band, shouldStop);
}

export async function traceOnGpu(scene, camera, rawOptions, shouldStop) {
  const tiledOptions = await withBlueNoiseTile(rawOptions);
  const options = { ...tiledOptions, lightSelection: resolveLightSelection(tiledOptions.lightSelection, scene.lights) };
  const { gl, gpu } = getContext();
  const { program, compileSeconds } = getKernel(sceneUsesSubsurface(scene.materials), false, options);
  const { width, height, samples } = options;
  gl.useProgram(program);
  const { lightCount } = uploadScene(gl, program, scene, options);
  setSceneUniforms(gl, program, scene, camera, options, lightCount);
  createTargets(gl, width, height);
  await drawSamples(gl, program, width, height, samples, shouldStop);
  const buffers = averageBuffers(gl, width, height, samples);
  releaseResources(gl);
  return Object.assign(buffers, { gpu, compileSeconds });
}

const TEXEL_ROW_WIDTH = 2048;

/**
 * Traces `options.samples` cosine weighted paths from every texel of a lightmap and resolves with, per texel, the mean
 * radiance that arrives (`radiance`, three floats) and the share of first rays that left the scene (`escaped`).
 * `texels` holds `count`, `points` and `normals` (three floats each, world space). `options.bounces` counts hits, as in
 * the CPU bake. The scene is traced as it is: its lights, materials and environment decide the light.
 */
export async function traceTexelsOnGpu(scene, texels, options, shouldStop) {
  const { gl, gpu } = getContext();
  const { program, compileSeconds } = getKernel(sceneUsesSubsurface(scene.materials), true);
  const { count, points, normals } = texels;
  const { samples, seed } = options;
  const width = Math.min(count, TEXEL_ROW_WIDTH);
  const height = Math.ceil(count / width);
  gl.useProgram(program);
  const { lightCount, nextUnit } = uploadScene(gl, program, scene);
  const camera = { eye: [0, 0, 0], forward: [0, 0, 1], right: [1, 0, 0], above: [0, 1, 0], halfWidth: 1, halfHeight: 1 };
  setSceneUniforms(gl, program, scene, camera, { width, height, seed, bounces: options.bounces - 1, fireflyClamp: options.fireflyClamp }, lightCount);
  const upload = (unit, name, vectors) => {
    const padded = new Float32Array(width * height * 4);
    for (let texel = 0; texel < count; texel++) padded.set(vectors.subarray(texel * 3, texel * 3 + 3), texel * 4);
    createTexture(gl, unit, gl.RGBA32F, gl.RGBA, gl.FLOAT, width, height, padded);
    gl.uniform1i(gl.getUniformLocation(program, name), unit);
  };
  upload(nextUnit, 'uTexelPoints', points);
  upload(nextUnit + 1, 'uTexelNormals', normals);
  gl.uniform1i(gl.getUniformLocation(program, 'uTexelCount'), count);
  gl.uniform1i(gl.getUniformLocation(program, 'uSampleCount'), samples);
  createTargets(gl, width, height);
  await drawSamples(gl, program, width, height, samples, shouldStop);
  const radianceSums = readTarget(gl, 0, width, height);
  const statistics = readTarget(gl, 3, width, height);
  releaseResources(gl);
  const radiance = new Float32Array(count * 3);
  const escaped = new Float32Array(count);
  for (let texel = 0; texel < count; texel++) {
    for (let channel = 0; channel < 3; channel++) radiance[texel * 3 + channel] = radianceSums[texel * 4 + channel] / samples;
    escaped[texel] = statistics[texel * 4 + 2] / samples;
  }
  return { radiance, escaped, gpu, compileSeconds };
}

/** The triangles this page's WebGL2 context can hold in its data textures (MAX_TEXTURE_SIZE rows of the triangle table), up to MAX_GPU_TRACE_TRIANGLES. */
export function gpuTriangleLimit() {
  const { gl } = getContext();
  return gpuTriangleCapacity({ maximumTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE) }, MAX_GPU_TRACE_TRIANGLES);
}
