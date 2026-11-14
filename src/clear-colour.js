export const DEFAULT_BACKGROUND = Object.freeze([0.145, 0.162, 0.177, 1]);

// Accepts [red, green, blue] or [red, green, blue, alpha], each from 0 to 1, and returns a new four-number array.
export function resolveBackground(background) {
  const valid = Array.isArray(background)
    && (background.length === 3 || background.length === 4)
    && background.every(channel => typeof channel === 'number' && Number.isFinite(channel) && channel >= 0 && channel <= 1);
  if (!valid) throw new Error('background must be [red, green, blue] or [red, green, blue, alpha], each a number from 0 to 1.');
  return [background[0], background[1], background[2], background[3] ?? 1];
}

// A transparent canvas is premultiplied, so the colour is scaled by its alpha. Without an explicit background it clears to nothing.
export function clearColourFor(background, transparent) {
  if (!transparent) return background ?? DEFAULT_BACKGROUND;
  if (!background) return [0, 0, 0, 0];
  const [red, green, blue, alpha] = background;
  return [red * alpha, green * alpha, blue * alpha, alpha];
}
