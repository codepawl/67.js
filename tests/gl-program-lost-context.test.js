import { test } from 'node:test';
import assert from 'node:assert/strict';
import { finishProgram } from '../src/gl-program.js';

function fakeContext({ lost }) {
  const deleted = [];
  return {
    deleted,
    LINK_STATUS: 0x8b82,
    COMPILE_STATUS: 0x8b81,
    getProgramParameter: () => false,
    getShaderParameter: () => false,
    getShaderInfoLog: () => null,
    getProgramInfoLog: () => null,
    deleteShader: (shader) => deleted.push(shader),
    deleteProgram: (program) => deleted.push(program),
    isContextLost: () => lost,
  };
}

test('finishProgram on a lost context deletes the program and throws nothing (#541)', () => {
  const context = fakeContext({ lost: true });
  const pending = { program: 'program', shaders: ['vertex', 'fragment'] };
  assert.doesNotThrow(() => finishProgram(context, pending));
  assert.deepEqual(context.deleted.sort(), ['fragment', 'program', 'vertex']);
});

test('finishProgram on a live context still reports a failed compile', () => {
  const context = fakeContext({ lost: false });
  context.getShaderInfoLog = () => 'ERROR: 0:1: syntax error';
  assert.throws(() => finishProgram(context, { program: 'program', shaders: ['vertex'] }), /Shader compilation failed: ERROR/);
});
