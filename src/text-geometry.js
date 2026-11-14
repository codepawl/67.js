// 3D text: glyph outlines from a font table, flattened to polygons and extruded. The default font is DejaVu Sans
// (printable ASCII only). This module loads on demand because its font data is the heaviest part of the engine.
import { extrude } from './modeling.js';
import { DEFAULT_FONT_DATA } from './font-default.js';
import { CURVE_TEXT_LIMITS } from './agent-scene-capabilities.js';

const DEFAULT_FONT_NAME = 'default';
const MAX_TEXT_CHARACTERS = CURVE_TEXT_LIMITS.maxTextCharacters;
const MAX_TEXT_LINES = CURVE_TEXT_LIMITS.maxTextLines;
const MAX_GLYPHS_PER_FONT = 2048;
const MAX_POINTS_PER_CONTOUR = 2048;
const MAX_POINTS_PER_FONT = 400_000;
const LINE_HEIGHT_EMS = 1.2;
const ALIGNMENTS = ['left', 'center', 'right'];

const fonts = new Map();

function checkNumber(value, name) {
  if (!Number.isFinite(value)) throw new TypeError(`${name} must be a finite number.`);
}

function validateGlyph(character, record) {
  if (!Array.isArray(record) || record.length < 1 || record.length > 65) throw new TypeError(`Glyph ${JSON.stringify(character)} must be [advance, contour...] with up to 64 contours.`);
  checkNumber(record[0], 'advance');
  let points = 0;
  for (const contour of record.slice(1)) {
    if (!Array.isArray(contour) || contour.length % 3 !== 0 || contour.length < 9 || contour.length > MAX_POINTS_PER_CONTOUR * 3) {
      throw new RangeError(`A contour of ${JSON.stringify(character)} needs 3 to ${MAX_POINTS_PER_CONTOUR} points as x, y, onCurve.`);
    }
    contour.forEach((value, index) => {
      checkNumber(value, 'contour value');
      if (index % 3 === 2 && value !== 0 && value !== 1) throw new TypeError('A contour onCurve flag must be 0 or 1.');
    });
    points += contour.length / 3;
  }
  if (points > CURVE_TEXT_LIMITS.maxPointsPerGlyph) throw new RangeError(`Glyph ${JSON.stringify(character)} has ${points} outline points; the limit is ${CURVE_TEXT_LIMITS.maxPointsPerGlyph}.`);
  return points;
}

/** Add a font table (see scripts/build-font.py for how to make one from a TrueType file) under a name recipes can use. */
export function registerFont(name, data) {
  if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,47}$/.test(name)) throw new TypeError('A font name is 1 to 48 letters, digits, spaces, dots, dashes or underscores.');
  if (!data || typeof data !== 'object' || !data.glyphs || typeof data.glyphs !== 'object') throw new TypeError('A font table needs unitsPerEm, ascender, descender and glyphs.');
  if (!Number.isInteger(data.unitsPerEm) || data.unitsPerEm < 16 || data.unitsPerEm > 16384) throw new RangeError('unitsPerEm must be an integer from 16 to 16384.');
  checkNumber(data.ascender, 'ascender');
  checkNumber(data.descender, 'descender');
  const characters = Object.keys(data.glyphs);
  if (characters.length === 0 || characters.length > MAX_GLYPHS_PER_FONT) throw new RangeError(`A font holds 1 to ${MAX_GLYPHS_PER_FONT} glyphs.`);
  let points = 0;
  for (const character of characters) {
    if ([...character].length !== 1) throw new TypeError('Each glyph key must be one character.');
    points += validateGlyph(character, data.glyphs[character]);
  }
  if (points > MAX_POINTS_PER_FONT) throw new RangeError(`A font holds at most ${MAX_POINTS_PER_FONT} outline points.`);
  fonts.set(name, data);
}

registerFont(DEFAULT_FONT_NAME, DEFAULT_FONT_DATA);

function midpoint(first, second) {
  return [(first[0] + second[0]) / 2, (first[1] + second[1]) / 2, 1];
}

// TrueType stores quadratic curves whose on-curve points may be left out between two off-curve points.
function withImpliedPoints(flat) {
  const points = [];
  for (let index = 0; index < flat.length; index += 3) points.push([flat[index], flat[index + 1], flat[index + 2]]);
  const expanded = [];
  points.forEach((point, index) => {
    expanded.push(point);
    const next = points[(index + 1) % points.length];
    if (!point[2] && !next[2]) expanded.push(midpoint(point, next));
  });
  const start = expanded.findIndex(point => point[2]);
  if (start < 0) throw new RangeError('A contour has no on-curve point.');
  return [...expanded.slice(start), ...expanded.slice(0, start)];
}

/** Polygon for one contour, `curveSegments` straight pieces per quadratic curve, in font units. */
export function flattenContour(flat, curveSegments) {
  const points = withImpliedPoints(flat);
  const polygon = [[points[0][0], points[0][1]]];
  let index = 1;
  while (index <= points.length) {
    const current = points[index - 1];
    const next = points[index % points.length];
    if (next[2]) {
      polygon.push([next[0], next[1]]);
      index += 1;
      continue;
    }
    const end = points[(index + 1) % points.length];
    for (let step = 1; step <= curveSegments; step++) {
      const t = step / curveSegments;
      const remainder = 1 - t;
      polygon.push([
        remainder * remainder * current[0] + 2 * remainder * t * next[0] + t * t * end[0],
        remainder * remainder * current[1] + 2 * remainder * t * next[1] + t * t * end[1],
      ]);
    }
    index += 2;
  }
  polygon.pop();
  return polygon;
}

function insideRing(point, ring) {
  let result = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
    const a = ring[index];
    const b = ring[previous];
    if ((a[1] > point[1]) !== (b[1] > point[1]) && point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]) result = !result;
  }
  return result;
}

function withoutRepeats(ring) {
  const kept = ring.filter((point, index) => {
    const next = ring[(index + 1) % ring.length];
    return point[0] !== next[0] || point[1] !== next[1];
  });
  return kept;
}

/** Splits a glyph's rings into outlines with their holes: a ring inside an odd number of others is a hole. */
export function groupRings(rings) {
  const depths = rings.map((ring, index) => rings.filter((other, otherIndex) => otherIndex !== index && insideRing(ring[0], other)).length);
  const outlines = [];
  rings.forEach((ring, index) => {
    if (depths[index] % 2 === 0) outlines.push({ contour: ring, holes: [], index });
  });
  rings.forEach((ring, index) => {
    if (depths[index] % 2 === 0) return;
    const containing = outlines.filter(outline => insideRing(ring[0], outline.contour));
    const owner = containing.reduce((best, outline) => (depths[outline.index] > depths[best.index] ? outline : best));
    owner.holes.push(ring);
  });
  return outlines;
}

function glyphMesh(record, unitsPerEm, { size, depth, curveSegments, maxVertices }) {
  const factor = size / unitsPerEm;
  const rings = record.slice(1).map(contour => withoutRepeats(flattenContour(contour, curveSegments).map(([x, y]) => [x * factor, y * factor])));
  return groupRings(rings).map(({ contour, holes }) => extrude(contour, { holes, depth, maxVertices }));
}

function translated(mesh, offsetX, offsetY, offsetZ) {
  const positions = Float32Array.from(mesh.positions);
  for (let index = 0; index < positions.length; index += 3) {
    positions[index] += offsetX;
    positions[index + 1] += offsetY;
    positions[index + 2] += offsetZ;
  }
  return { positions, normals: mesh.normals, uvs: mesh.uvs, indices: mesh.indices };
}

function merged(meshes) {
  const vertexCount = meshes.reduce((total, mesh) => total + mesh.positions.length / 3, 0);
  const indexCount = meshes.reduce((total, mesh) => total + mesh.indices.length, 0);
  const result = {
    positions: new Float32Array(vertexCount * 3), normals: new Float32Array(vertexCount * 3),
    uvs: new Float32Array(vertexCount * 2), indices: new Uint32Array(indexCount),
  };
  let vertexOffset = 0;
  let indexOffset = 0;
  for (const mesh of meshes) {
    result.positions.set(mesh.positions, vertexOffset * 3);
    result.normals.set(mesh.normals, vertexOffset * 3);
    result.uvs.set(mesh.uvs, vertexOffset * 2);
    mesh.indices.forEach((vertex, index) => {
      result.indices[indexOffset + index] = vertex + vertexOffset;
    });
    vertexOffset += mesh.positions.length / 3;
    indexOffset += mesh.indices.length;
  }
  return result;
}

function glyphRecord(font, fontName, character) {
  const record = Object.hasOwn(font.glyphs, character) ? font.glyphs[character] : undefined;
  if (!record) throw new RangeError(`Font ${JSON.stringify(fontName)} has no glyph for ${JSON.stringify(character)}. The bundled font covers printable ASCII only (space to ~), so use those characters.`);
  return record;
}

function lineWidth(line, font, fontName, factor) {
  let width = 0;
  for (const character of line) width += glyphRecord(font, fontName, character)[0] * factor;
  return width;
}

/**
 * Text in the XY plane, its first baseline on y = 0, reading along +X and facing +Z, centred through its depth.
 * Lines split at "\n". Every printable character must exist in the font.
 */
export function text(content, { size = 1, depth = 0.2, font: fontName = DEFAULT_FONT_NAME, align = 'left', curveSegments = 4, maxVertices = 250_000 } = {}) {
  if (typeof content !== 'string' || content.length === 0 || [...content].length > MAX_TEXT_CHARACTERS) throw new RangeError(`text needs 1 to ${MAX_TEXT_CHARACTERS} characters.`);
  checkNumber(size, 'size');
  checkNumber(depth, 'depth');
  if (size <= 0 || depth <= 0) throw new RangeError('size and depth must be positive.');
  if (!Number.isInteger(curveSegments) || curveSegments < 1 || curveSegments > 16) throw new RangeError('curveSegments must be an integer from 1 to 16.');
  if (!ALIGNMENTS.includes(align)) throw new RangeError(`align must be one of ${ALIGNMENTS.join(', ')}.`);
  const font = fonts.get(fontName);
  if (!font) throw new RangeError(`Unknown font ${JSON.stringify(fontName)}. Known fonts: ${[...fonts.keys()].join(', ')}.`);
  const lines = content.split('\n');
  if (lines.length > MAX_TEXT_LINES) throw new RangeError(`text has at most ${MAX_TEXT_LINES} lines.`);
  const factor = size / font.unitsPerEm;
  const cache = new Map();
  const meshes = [];
  let vertexCount = 0;
  lines.forEach((line, lineIndex) => {
    const width = lineWidth(line, font, fontName, factor);
    let cursor = align === 'center' ? -width / 2 : align === 'right' ? -width : 0;
    const baseline = -lineIndex * LINE_HEIGHT_EMS * size;
    for (const character of line) {
      const record = glyphRecord(font, fontName, character);
      if (!cache.has(character)) cache.set(character, glyphMesh(record, font.unitsPerEm, { size, depth, curveSegments, maxVertices }));
      for (const mesh of cache.get(character)) {
        vertexCount += mesh.positions.length / 3;
        if (vertexCount > maxVertices) throw new RangeError(`Text requires more than maxVertices ${maxVertices}. Shorten it or lower curveSegments.`);
        meshes.push(translated(mesh, cursor, baseline, -depth / 2));
      }
      cursor += record[0] * factor;
    }
  });
  if (meshes.length === 0) throw new RangeError('text has no visible characters.');
  return merged(meshes);
}
