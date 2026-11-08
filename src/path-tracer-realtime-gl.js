// Small WebGL2 helpers of the real-time path tracer's passes (radiance cache, temporal denoiser). The tracer program
// keeps texture units 0 to 15 for the scene tables; these passes bind their inputs from unit 16 up.

export const FIRST_PASS_TEXTURE_UNIT = 16;
// The same triangle as the tracer kernel's vertex shader (not imported: the kernel imports the radiance cache, which imports this file).
export const FULLSCREEN_VERTEX_SOURCE = `#version 300 es
void main() {
  vec2 corner = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
}`;
export const FRAGMENT_HEADER = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
`;

function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(`A real-time path tracer shader did not compile: ${gl.getShaderInfoLog(shader)}`);
  return shader;
}

/** A program with a uniform lookup that remembers locations. */
export function createPass(gl, fragmentSource, vertexSource = FULLSCREEN_VERTEX_SOURCE) {
  const program = gl.createProgram();
  gl.attachShader(program, compileShader(gl, gl.VERTEX_SHADER, vertexSource));
  gl.attachShader(program, compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`A real-time path tracer program did not link: ${gl.getProgramInfoLog(program)}`);
  const locations = new Map();
  const locate = name => {
    if (!locations.has(name)) locations.set(name, gl.getUniformLocation(program, name));
    return locations.get(name);
  };
  return { program, locate };
}

export function createFloatTexture(gl, width, height) {
  const texture = gl.createTexture();
  gl.activeTexture(gl.TEXTURE0 + FIRST_PASS_TEXTURE_UNIT);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, width, height, 0, gl.RGBA, gl.FLOAT, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return texture;
}

/** A framebuffer from `{ slot, texture }` entries; slots without an entry are not drawn to. */
export function createFramebuffer(gl, attachments) {
  const framebuffer = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  const slotCount = Math.max(...attachments.map(entry => entry.slot)) + 1;
  const drawBuffers = new Array(slotCount).fill(gl.NONE);
  for (const { slot, texture } of attachments) {
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + slot, gl.TEXTURE_2D, texture, 0);
    drawBuffers[slot] = gl.COLOR_ATTACHMENT0 + slot;
  }
  gl.drawBuffers(drawBuffers);
  if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('The real-time path tracer cannot render to float targets here.');
  return framebuffer;
}

/** Binds `texture` to the pass's sampler `name` on the pass texture unit `index`. The pass must be in use. */
export function bindInput(gl, pass, name, index, texture) {
  gl.activeTexture(gl.TEXTURE0 + FIRST_PASS_TEXTURE_UNIT + index);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.uniform1i(pass.locate(name), FIRST_PASS_TEXTURE_UNIT + index);
}

export function drawFullscreen(gl, framebuffer, width, height) {
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.viewport(0, 0, width, height);
  gl.disable(gl.BLEND);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}
