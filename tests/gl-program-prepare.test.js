import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileProgram, finishProgram, isLinkComplete, ProgramNotReady, setPreparing } from '../src/gl-program.js';

// A context whose programs report completion after a number of polls, as a driver building on its own threads does.
function fakeContext({ pollsUntilComplete }) {
  const polls = new Map();
  let created = 0;
  return {
    created: () => created,
    LINK_STATUS: 0x8b82,
    COMPILE_STATUS: 0x8b81,
    VERTEX_SHADER: 1,
    FRAGMENT_SHADER: 2,
    getExtension: () => ({ COMPLETION_STATUS_KHR: 0x91b1 }),
    createProgram: () => ({ id: created++ }),
    createShader: () => ({}),
    shaderSource() {},
    compileShader() {},
    attachShader() {},
    linkProgram() {},
    getProgramParameter(program, parameter) {
      if (parameter !== 0x91b1) return true;
      polls.set(program, (polls.get(program) ?? 0) + 1);
      return polls.get(program) > pollsUntilComplete;
    },
    getShaderParameter: () => true,
    getShaderInfoLog: () => '',
    getProgramInfoLog: () => '',
    deleteShader() {},
    deleteProgram() {},
    isContextLost: () => false,
  };
}

test('outside preparation a program is finished at once, even before the driver reports completion', () => {
  const context = fakeContext({ pollsUntilComplete: 5 });
  assert.doesNotThrow(() => compileProgram(context, 'vertex', 'fragment'));
});

test('while preparing, an unfinished program throws ProgramNotReady and is found again, not restarted', () => {
  const context = fakeContext({ pollsUntilComplete: 2 });
  setPreparing(context, true);
  let program = null;
  let attempts = 0;
  while (!program) {
    attempts++;
    try {
      program = compileProgram(context, 'vertex', 'fragment');
    } catch (error) {
      assert.ok(error instanceof ProgramNotReady);
      assert.equal(isLinkComplete(context, error.program), false);
    }
  }
  setPreparing(context, false);
  assert.equal(context.created(), 1, 'the retry reused the started program');
  assert.ok(attempts > 1);
});

test('a finished program is not blocked while preparing, and preparation ends cleanly', () => {
  const context = fakeContext({ pollsUntilComplete: 0 });
  setPreparing(context, true);
  assert.doesNotThrow(() => finishProgram(context, { program: { id: 9 }, shaders: [] }));
  setPreparing(context, false);
  assert.doesNotThrow(() => finishProgram(context, { program: { id: 10 }, shaders: [] }));
});
