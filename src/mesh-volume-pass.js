import { compileProgram } from './gl-program.js';
import { assertClosedMesh } from './local-volume-parts.js';

// The rasterizer's half of a local volume with shape "mesh" and fit "mesh" (issue 807). Before the post pass, each such part is drawn
// without culling into a layer of one float target, and the post shader reads the result per pixel. A ray crosses a closed mesh an even
// number of times, and the length it spends inside is the sum over the back faces of (distance - the distance of each front face):
//   channel R  adds +distance at a back face and -distance at a front face, each clamped to [0, distance of the first surface];
//   channel G  keeps the nearest front face distance (the entry, used to order the volumes).
// That sum is exact for any number of shells and any shape, so there is no shell limit. The post shader then integrates the volume
// over that length in closed form, which is exact because a mesh volume has the same density everywhere inside (no falloff, no noise).
// The cost is two draws of the part per frame, so a scene without mesh volumes pays nothing.
// Limits: the mesh must be closed and rigid; geometry nearer than the camera's near plane is clipped, so a ray loses the stretch
// between the eye and the near plane; the target is as wide as the canvas and as tall as the canvas times the number of mesh volumes.

const MESH_VERTEX = `#version 300 es
precision highp float;
layout(location = 0) in vec3 position;
uniform mat4 viewProjection;
uniform mat4 model;
out vec3 worldPosition;
void main() {
  vec4 world = model * vec4(position, 1.0);
  worldPosition = world.xyz;
  gl_Position = viewProjection * world;
}`;

const MESH_FRAGMENT = `#version 300 es
precision highp float;
precision highp sampler2D;
in vec3 worldPosition;
uniform sampler2D sceneDepth;
uniform mat4 inverseViewProjection;
uniform vec3 eye;
uniform float orthographic;
uniform vec2 resolution;
uniform float layerOffset;
uniform float entryPass;
out vec4 result;
void main() {
  vec2 pixel = vec2(gl_FragCoord.x, gl_FragCoord.y - layerOffset);
  vec2 clipXY = pixel / resolution * 2.0 - 1.0;
  vec4 farPoint = inverseViewProjection * vec4(clipXY, 1.0, 1.0);
  vec4 nearPoint = inverseViewProjection * vec4(clipXY, -1.0, 1.0);
  vec3 origin = orthographic > 0.5 ? nearPoint.xyz / nearPoint.w : eye;
  vec3 direction = normalize(farPoint.xyz - origin * farPoint.w);
  float depth = texelFetch(sceneDepth, ivec2(pixel), 0).r;
  vec4 surfacePoint = inverseViewProjection * vec4(clipXY, depth * 2.0 - 1.0, 1.0);
  float surfaceDistance = 1e30;
  if (surfacePoint.w > 0.0) surfaceDistance = max(0.0, dot(surfacePoint.xyz - origin * surfacePoint.w, direction) / surfacePoint.w);
  float distanceAlongRay = clamp(dot(worldPosition - origin, direction), 0.0, surfaceDistance);
  if (entryPass > 0.5) result = vec4(0.0, gl_FrontFacing ? distanceAlongRay : 1e30, 0.0, 0.0);
  else result = vec4(gl_FrontFacing ? -distanceAlongRay : distanceAlongRay, 0.0, 0.0, 0.0);
}`;

const UNIFORM_NAMES = ['viewProjection', 'model', 'sceneDepth', 'inverseViewProjection', 'eye', 'orthographic', 'resolution', 'layerOffset', 'entryPass'];
const NO_ENTRY = 1e30;

// Positive when the triangles wind counter-clockwise seen from outside, which is what the draw's front faces rely on.
function signedVolume(positions, indices) {
  let total = 0;
  for (let corner = 0; corner < indices.length; corner += 3) {
    const a = indices[corner] * 3;
    const b = indices[corner + 1] * 3;
    const c = indices[corner + 2] * 3;
    total += positions[a] * (positions[b + 1] * positions[c + 2] - positions[b + 2] * positions[c + 1])
      + positions[a + 1] * (positions[b + 2] * positions[c] - positions[b] * positions[c + 2])
      + positions[a + 2] * (positions[b] * positions[c + 1] - positions[b + 1] * positions[c]);
  }
  return total;
}

function matrixDeterminant(matrix) {
  return matrix[0] * (matrix[5] * matrix[10] - matrix[6] * matrix[9])
    - matrix[4] * (matrix[1] * matrix[10] - matrix[2] * matrix[9])
    + matrix[8] * (matrix[1] * matrix[6] - matrix[2] * matrix[5]);
}

function uploadGeometry(context, geometry) {
  const vertexArray = context.createVertexArray();
  context.bindVertexArray(vertexArray);
  const positionBuffer = context.createBuffer();
  context.bindBuffer(context.ARRAY_BUFFER, positionBuffer);
  context.bufferData(context.ARRAY_BUFFER, geometry.positions instanceof Float32Array ? geometry.positions : new Float32Array(geometry.positions), context.STATIC_DRAW);
  context.enableVertexAttribArray(0);
  context.vertexAttribPointer(0, 3, context.FLOAT, false, 0, 0);
  const shortIndices = geometry.indices instanceof Uint16Array;
  const indexBuffer = context.createBuffer();
  context.bindBuffer(context.ELEMENT_ARRAY_BUFFER, indexBuffer);
  context.bufferData(context.ELEMENT_ARRAY_BUFFER, shortIndices || geometry.indices instanceof Uint32Array ? geometry.indices : new Uint32Array(geometry.indices), context.STATIC_DRAW);
  context.bindVertexArray(null);
  return {
    vertexArray,
    buffers: [positionBuffer, indexBuffer],
    count: geometry.indices.length,
    indexType: shortIndices ? context.UNSIGNED_SHORT : context.UNSIGNED_INT,
    insideOut: signedVolume(geometry.positions, geometry.indices) < 0,
  };
}

function createState(context) {
  if (!context.getExtension('EXT_float_blend')) throw new Error('Local volumes with fit "mesh" need the WebGL extension EXT_float_blend, which this browser does not offer; use fit "bounds"');
  const program = compileProgram(context, MESH_VERTEX, MESH_FRAGMENT);
  const uniforms = Object.fromEntries(UNIFORM_NAMES.map(name => [name, context.getUniformLocation(program, name)]));
  return { program, uniforms, geometries: new Map(), target: null };
}

function allocateTarget(renderer, state, layers) {
  const context = renderer.context;
  const width = renderer.canvas.width;
  const height = renderer.canvas.height * layers;
  if (state.target?.width === width && state.target.height === height) return;
  if (height > context.getParameter(context.MAX_TEXTURE_SIZE)) {
    throw new RangeError(`${layers} mesh volumes at ${width}x${renderer.canvas.height} need a ${height} pixel tall buffer, past this device's limit of ${context.getParameter(context.MAX_TEXTURE_SIZE)}; use fewer volumes with fit "mesh", a smaller canvas or fit "bounds"`);
  }
  releaseTarget(renderer, state);
  const texture = context.createTexture();
  context.bindTexture(context.TEXTURE_2D, texture);
  context.texImage2D(context.TEXTURE_2D, 0, context.RG32F, width, height, 0, context.RG, context.FLOAT, null);
  context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MIN_FILTER, context.NEAREST);
  context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MAG_FILTER, context.NEAREST);
  context.texParameteri(context.TEXTURE_2D, context.TEXTURE_WRAP_S, context.CLAMP_TO_EDGE);
  context.texParameteri(context.TEXTURE_2D, context.TEXTURE_WRAP_T, context.CLAMP_TO_EDGE);
  const framebuffer = context.createFramebuffer();
  context.bindFramebuffer(context.FRAMEBUFFER, framebuffer);
  context.framebufferTexture2D(context.FRAMEBUFFER, context.COLOR_ATTACHMENT0, context.TEXTURE_2D, texture, 0);
  if (context.checkFramebufferStatus(context.FRAMEBUFFER) !== context.FRAMEBUFFER_COMPLETE) throw new Error('The mesh volume buffer could not be allocated; use fit "bounds" or a smaller canvas');
  state.target = { texture, framebuffer, width, height };
  renderer.renderTargets.record('meshVolumes', { width, height, format: 'RG32F' });
}

function releaseTarget(renderer, state) {
  if (!state.target) return;
  renderer.context.deleteTexture(state.target.texture);
  renderer.context.deleteFramebuffer(state.target.framebuffer);
  state.target = null;
  renderer.renderTargets.release('meshVolumes');
}

function drawPart(context, state, part) {
  let gpu = state.geometries.get(part.geometry);
  if (!gpu) {
    gpu = uploadGeometry(context, part.geometry);
    state.geometries.set(part.geometry, gpu);
  }
  const matrix = part.matrix ?? [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  context.uniformMatrix4fv(state.uniforms.model, false, matrix);
  context.frontFace(gpu.insideOut !== matrixDeterminant(matrix) < 0 ? context.CW : context.CCW);
  context.bindVertexArray(gpu.vertexArray);
  context.drawElements(context.TRIANGLES, gpu.count, gpu.indexType, 0);
}

/**
 * Draws every fit "mesh" volume of the frame into the mesh buffer: layer n holds the volume with slice n, R the length inside along
 * each pixel's ray and G the nearest entry. The caller rebinds the post framebuffer afterwards through the restore this makes.
 * Returns the texture, or null when the frame has no such volume.
 */
export function drawMeshVolumes(renderer, frame) {
  const meshParts = renderer.localVolumeBuffers?.meshParts ?? [];
  if (meshParts.length === 0) return null;
  const context = renderer.context;
  const state = (renderer.meshVolumePass ??= createState(context));
  for (const { part, label } of meshParts) assertClosedMesh(part, label);
  allocateTarget(renderer, state, meshParts.length);
  const { width, height } = renderer.canvas;
  const blendWasOn = context.isEnabled(context.BLEND);
  context.bindFramebuffer(context.FRAMEBUFFER, state.target.framebuffer);
  context.colorMask(true, true, true, true);
  context.clearBufferfv(context.COLOR, 0, [0, NO_ENTRY, 0, 0]);
  context.useProgram(state.program);
  context.disable(context.DEPTH_TEST);
  context.disable(context.CULL_FACE);
  context.enable(context.BLEND);
  context.blendFunc(context.ONE, context.ONE);
  context.activeTexture(context.TEXTURE1);
  context.bindTexture(context.TEXTURE_2D, renderer.depthTexture);
  context.uniform1i(state.uniforms.sceneDepth, 1);
  context.uniformMatrix4fv(state.uniforms.viewProjection, false, renderer.viewProjection);
  context.uniformMatrix4fv(state.uniforms.inverseViewProjection, false, renderer.inverseViewProjection);
  context.uniform3fv(state.uniforms.eye, frame.eye);
  context.uniform1f(state.uniforms.orthographic, frame.projection === 'orthographic' ? 1 : 0);
  context.uniform2f(state.uniforms.resolution, width, height);
  meshParts.forEach(({ part }, slice) => {
    context.viewport(0, slice * height, width, height);
    context.uniform1f(state.uniforms.layerOffset, slice * height);
    context.uniform1f(state.uniforms.entryPass, 0);
    context.blendEquation(context.FUNC_ADD);
    context.colorMask(true, false, false, false);
    drawPart(context, state, part);
    context.uniform1f(state.uniforms.entryPass, 1);
    context.blendEquation(context.MIN);
    context.colorMask(false, true, false, false);
    drawPart(context, state, part);
  });
  context.colorMask(true, true, true, true);
  context.frontFace(context.CCW);
  context.blendEquation(context.FUNC_ADD);
  if (!blendWasOn) context.disable(context.BLEND);
  context.bindVertexArray(null);
  context.bindFramebuffer(context.FRAMEBUFFER, frame.outputFramebuffer ?? null);
  context.viewport(0, 0, width, height);
  return state.target.texture;
}

/** Frees the program, the buffer and the uploaded meshes. */
export function disposeMeshVolumePass(renderer) {
  const state = renderer.meshVolumePass;
  if (!state) return;
  const context = renderer.context;
  releaseTarget(renderer, state);
  for (const gpu of state.geometries.values()) {
    context.deleteVertexArray(gpu.vertexArray);
    gpu.buffers.forEach(buffer => context.deleteBuffer(buffer));
  }
  context.deleteProgram(state.program);
  renderer.meshVolumePass = null;
}
