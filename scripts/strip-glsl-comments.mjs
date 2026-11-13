// Removes the line comments inside GLSL template literals, so the published bundles do not carry explanations
// that only a person reading src/ needs. JavaScript comments are left to the minifier.
// Used as a plugin by config/vite.lib.config.js and scripts/measure-size.mjs, so the size budgets measure the same text.
import { readFile } from 'node:fs/promises';

const GLSL_MARKER = /#version 300 es|^uniform /m;
const SOURCE_FILE = /[\\/]src[\\/][^\\/]+\.js$/;

function countBackticks(line) {
  return (line.match(/(?<!\\)`/g) ?? []).length;
}

function stripLine(line) {
  if (/^\s*\/\/.*$/.test(line)) return null;
  if (line.includes('${') || line.includes('`')) return line;
  return line.replace(/\s+\/\/.*$/, '');
}

export function stripGlslComments(source) {
  if (!GLSL_MARKER.test(source)) return source;
  let insideTemplate = false;
  const kept = [];
  for (const line of source.split(/\r?\n/)) {
    const startedInside = insideTemplate;
    if (countBackticks(line) % 2 === 1) insideTemplate = !insideTemplate;
    const stripped = startedInside ? stripLine(line) : line;
    if (stripped !== null) kept.push(stripped);
  }
  return kept.join('\n');
}

export function glslCommentStripperForVite() {
  return {
    name: 'strip-glsl-comments',
    enforce: 'pre',
    transform(code, id) {
      return SOURCE_FILE.test(id) ? { code: stripGlslComments(code), map: null } : null;
    },
  };
}

export function glslCommentStripperForEsbuild() {
  return {
    name: 'strip-glsl-comments',
    setup(build) {
      build.onLoad({ filter: SOURCE_FILE }, async ({ path }) => ({ contents: stripGlslComments(await readFile(path, 'utf8')), loader: 'js' }));
    },
  };
}
