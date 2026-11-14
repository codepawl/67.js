import assert from 'node:assert/strict';
import test from 'node:test';

import { buildFragmentSource } from '../src/path-tracer-gpu-shader.js';

// Issue #1228: the camera ray read the shadow-only flag of its hit with one expression, a texture fetch whose index came from a
// second texture fetch (the material index in the triangle table). On ANGLE / D3D11 that expression read the flag as set for every
// material after the first, so the camera ray stepped through every part but the first and the GPU trace drew one part. The
// kernel therefore keeps each fetch in its own statement: the result of one fetch is held in a variable before it indexes another.

function nestedFetches(source) {
  const found = [];
  const fetchCall = /fetch(?:Data|Scalar)\(/g;
  let match;
  while ((match = fetchCall.exec(source)) !== null) {
    let depth = 1;
    let cursor = match.index + match[0].length;
    const argumentStart = cursor;
    while (depth > 0 && cursor < source.length) {
      if (source[cursor] === '(') depth++;
      if (source[cursor] === ')') depth--;
      cursor++;
    }
    const argumentText = source.slice(argumentStart, cursor - 1);
    if (/fetch(?:Data|Scalar)\(/.test(argumentText)) found.push(source.slice(match.index, cursor).trim());
  }
  return found;
}

test('no texture fetch of the GPU kernel takes its index from another texture fetch', () => {
  assert.deepEqual(nestedFetches(buildFragmentSource({})), []);
  assert.deepEqual(nestedFetches(buildFragmentSource({ hasSubsurface: true, lightTree: true, radianceCache: true })), []);
});
