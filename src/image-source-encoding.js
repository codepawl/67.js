// Remembers the encoded bytes an image was decoded from, so an export can write them back unchanged
// instead of re-encoding the pixels. The record belongs to the decoded image object: a copy, a resize
// or a bake produces a different object, which has no record and is encoded from its pixels.
const encodingsByImage = new WeakMap();

/** Keep `bytes` (a JPEG, PNG or WebP file) as the source of the decoded `image`. Does nothing for a non-object image. */
export function rememberSourceEncoding(image, bytes, mimeType) {
  if (image === null || typeof image !== 'object') return;
  encodingsByImage.set(image, { bytes, mimeType });
}

/** The `{ bytes, mimeType }` an image was decoded from, or undefined when its pixels may differ from them. */
export function sourceEncodingOf(image) {
  if (image === null || typeof image !== 'object') return undefined;
  return encodingsByImage.get(image);
}
