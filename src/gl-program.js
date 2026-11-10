// Shader program helpers shared by the renderer and its optional addons, kept apart so an addon does not pull in the renderer.

import { shaderTransforms } from './shader-registry.js';

export const fullscreenVertex = `#version 300 es
precision highp float;
out vec2 textureCoordinate;
void main() {
  vec2 position = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  textureCoordinate = position;
  gl_Position = vec4(position * 2.0 - 1.0, 0.0, 1.0);
}`;

// Starting a program without asking for its result lets the driver build several programs at once.
export function startProgram(context, vertexSource, fragmentSource) {
  const program = context.createProgram();
  context.getExtension('KHR_parallel_shader_compile');
  const shaders = [];
  for (const [kind, source] of [[context.VERTEX_SHADER, vertexSource], [context.FRAGMENT_SHADER, fragmentSource]]) {
    const shader = context.createShader(kind);
    context.shaderSource(shader, shaderTransforms.reduce((text, transform) => transform(text), source));
    context.compileShader(shader);
    context.attachShader(program, shader);
    shaders.push(shader);
  }
  context.linkProgram(program);
  return { program, shaders };
}

export function finishProgram(context, { program, shaders }) {
  const linked = context.getProgramParameter(program, context.LINK_STATUS);
  const failedShader = shaders.find(shader => !context.getShaderParameter(shader, context.COMPILE_STATUS));
  const message = failedShader ? context.getShaderInfoLog(failedShader) : context.getProgramInfoLog(program);
  shaders.forEach((shader) => context.deleteShader(shader));
  if (!linked) {
    context.deleteProgram(program);
    // On a lost context every link reports false with a null log; the context is gone, so there is nothing to report (#541).
    if (context.isContextLost()) return program;
    throw new Error(failedShader ? `Shader compilation failed: ${message}` : `Shader linking failed: ${message}`);
  }
  return program;
}

export function compileProgram(context, vertexSource, fragmentSource) {
  return finishProgram(context, startProgram(context, vertexSource, fragmentSource));
}
