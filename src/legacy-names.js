// Names from before the rename to Crucible. Saved recipes, assets and packs that use them keep loading for one release;
// everything the code writes uses the new names.
export const LEGACY_FORMAT_NAMES = Object.freeze({
  '67js.scene': 'crucible.scene',
  '67js.asset': 'crucible.asset',
  '67js.pack': 'crucible.pack',
});
export const LEGACY_PACK_MANIFEST_FILE = '67js-pack.json';
export const LEGACY_ENGINE_KEY = '67js';

const warnedMessages = new Set();

/** The current format string for a possibly legacy one; any other value comes back unchanged. */
export function currentFormatName(format) {
  return typeof format === 'string' && Object.hasOwn(LEGACY_FORMAT_NAMES, format) ? LEGACY_FORMAT_NAMES[format] : format;
}

/** Prints a one-line deprecation notice to stderr, once per message. */
export function warnLegacyOnce(message) {
  if (warnedMessages.has(message)) return;
  warnedMessages.add(message);
  console.warn(`Deprecated: ${message}`);
}
