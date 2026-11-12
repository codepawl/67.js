// Marks a person leaves on a rendered view for scene_ask_user (issue #922): pure helpers shared by the preview page and the
// local annotate server. A mark is a pixel and a short note; the page turns each pixel into a ray and the scene query turns
// the ray into a part, a world point and a surface normal.
import { mat4, vec4 } from 'gl-matrix';
import { applyProjection } from './camera.js';

export const ANNOTATE_LIMITS = Object.freeze({
  maxMarks: 16,
  maxNoteLength: 280,
  maxPromptLength: 200,
  defaultTimeoutSeconds: 300,
  maxTimeoutSeconds: 900,
  maxImageBytes: 1024 * 1024,
});

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47];

function invalidMarks(detail) {
  return new TypeError(`The annotate marks are invalid: ${detail}`);
}

/**
 * Checks marks sent by the annotate page. Returns clean { x, y, note } records with pixel positions inside the view.
 * Throws a TypeError that says which mark failed, so a broken page cannot slip unbounded data to the agent.
 */
export function validateMarks(marks, { width, height, maxMarks = ANNOTATE_LIMITS.maxMarks }) {
  if (!Array.isArray(marks)) throw invalidMarks('marks must be an array.');
  if (marks.length > maxMarks) throw invalidMarks(`at most ${maxMarks} marks, got ${marks.length}.`);
  return marks.map((mark, index) => {
    if (!mark || typeof mark !== 'object' || Array.isArray(mark)) throw invalidMarks(`mark ${index + 1} must be an object.`);
    const { x, y, note = '' } = mark;
    if (!Number.isFinite(x) || x < 0 || x > width) throw invalidMarks(`mark ${index + 1} x must be a pixel from 0 to ${width}.`);
    if (!Number.isFinite(y) || y < 0 || y > height) throw invalidMarks(`mark ${index + 1} y must be a pixel from 0 to ${height}.`);
    if (typeof note !== 'string' || note.length > ANNOTATE_LIMITS.maxNoteLength) {
      throw invalidMarks(`mark ${index + 1} note must be text of at most ${ANNOTATE_LIMITS.maxNoteLength} characters.`);
    }
    return { x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10, note: note.trim() };
  });
}

/** True when the base64 text is a PNG within the image budget. */
export function isBoundedPng(base64) {
  if (typeof base64 !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) return false;
  const bytes = Buffer.from(base64, 'base64');
  return bytes.length <= ANNOTATE_LIMITS.maxImageBytes && PNG_SIGNATURE.every((value, index) => bytes[index] === value);
}

/** The world ray through a pixel of a camera: { origin, direction } with a unit direction. */
export function pixelRay(camera, pixelX, pixelY, width, height) {
  const view = mat4.lookAt(mat4.create(), camera.eye, camera.target, camera.up);
  const combined = mat4.multiply(mat4.create(), applyProjection(mat4.create(), camera, width / height), view);
  const inverse = mat4.invert(mat4.create(), combined);
  if (!inverse) throw new RangeError('The camera matrix cannot be inverted.');
  const ndcX = pixelX / width * 2 - 1;
  const ndcY = 1 - pixelY / height * 2;
  const unproject = ndcZ => {
    const point = vec4.transformMat4(vec4.create(), [ndcX, ndcY, ndcZ, 1], inverse);
    return [point[0] / point[3], point[1] / point[3], point[2] / point[3]];
  };
  const near = unproject(-1);
  const far = unproject(1);
  const direction = [0, 1, 2].map(axis => far[axis] - near[axis]);
  const length = Math.hypot(...direction);
  return { origin: near, direction: direction.map(value => value / length) };
}

function roundedVector(vector) {
  return Array.from(vector, value => Math.round(value * 1000) / 1000);
}

/** Numbers the marks and attaches what each one points at: part ID, world point, normal and distance, or null on empty sky. */
export function describeMarks(marks, camera, { width, height, raycast }) {
  return marks.map((mark, index) => {
    const hit = raycast(pixelRay(camera, mark.x, mark.y, width, height));
    return {
      number: index + 1,
      pixel: [mark.x, mark.y],
      note: mark.note,
      partId: hit ? hit.id : null,
      point: hit ? roundedVector(hit.point) : null,
      normal: hit ? roundedVector(hit.normal) : null,
      distance: hit ? Math.round(hit.distance * 1000) / 1000 : null,
      material: hit?.material ?? null,
    };
  });
}
