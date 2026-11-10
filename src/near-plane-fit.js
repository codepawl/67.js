// Without EXT_clip_control a 24-bit depth buffer cannot be reversed, so its precision depends on the near plane (issue #751). A
// camera that left near at its default 0.1 while the whole scene is 30 m or more away wastes most of the buffer on empty space, so
// the near plane moves out to just in front of the nearest point of the scene bounds. The result depends only on the eye, the view
// direction and the bounds, so it is deterministic and costs eight dot products per frame.
import { geometryBoundingSphere } from './render-culling.js';

export const DEFAULT_NEAR = 0.1;
// The bounds are padded by this fraction of their size so that a sway, a shadow-only part or a rounding error never reaches the plane.
const BOUNDS_PADDING = 0.05;
// The plane stops at this share of the nearest depth, and never passes this share of the far plane.
const NEAREST_DEPTH_SHARE = 0.9;
const FAR_SHARE_LIMIT = 0.01;

/** World-space box around every part (and an optional extra box such as the ground), or null when a part can move out of it. */
export function sceneBoundsOfParts(parts) {
  const minimum = [Infinity, Infinity, Infinity];
  const maximum = [-Infinity, -Infinity, -Infinity];
  for (const part of parts) {
    if (part.skin || part.morph || part.crowd || !part.matrix) return null;
    const box = geometryBoundingSphere(part.geometry);
    for (let corner = 0; corner < 8; corner++) {
      const x = corner & 1 ? box.maximum[0] : box.minimum[0];
      const y = corner & 2 ? box.maximum[1] : box.minimum[1];
      const z = corner & 4 ? box.maximum[2] : box.minimum[2];
      const matrix = part.matrix;
      for (let axis = 0; axis < 3; axis++) {
        const value = matrix[axis] * x + matrix[4 + axis] * y + matrix[8 + axis] * z + matrix[12 + axis];
        minimum[axis] = Math.min(minimum[axis], value);
        maximum[axis] = Math.max(maximum[axis], value);
      }
    }
  }
  if (!minimum.every(Number.isFinite) || !maximum.every(Number.isFinite)) return null;
  const padding = Math.max(...maximum.map((value, axis) => value - minimum[axis])) * BOUNDS_PADDING;
  return { minimum: minimum.map(value => value - padding), maximum: maximum.map(value => value + padding) };
}

/** Depth in front of the eye of the nearest corner of the box, along the view direction. */
export function nearestDepthOfBounds(bounds, view) {
  let nearest = Infinity;
  for (let corner = 0; corner < 8; corner++) {
    const x = corner & 1 ? bounds.maximum[0] : bounds.minimum[0];
    const y = corner & 2 ? bounds.maximum[1] : bounds.minimum[1];
    const z = corner & 4 ? bounds.maximum[2] : bounds.minimum[2];
    nearest = Math.min(nearest, -(view[2] * x + view[6] * y + view[10] * z + view[14]));
  }
  return nearest;
}

/** The near plane for a frame whose camera left near at its default: the default, or further out when the scene is far from the eye. */
export function fittedNearPlane(bounds, view, far) {
  const nearestDepth = nearestDepthOfBounds(bounds, view);
  if (!(nearestDepth > DEFAULT_NEAR / NEAREST_DEPTH_SHARE)) return DEFAULT_NEAR;
  return Math.min(nearestDepth * NEAREST_DEPTH_SHARE, far * FAR_SHARE_LIMIT);
}
