// Stands in for the Cook scene packers (@codepawlhq/cook/pack-input and /job-input) in a build made without Cook. Each export
// has the name the preview page imports and throws, so a native job reports the usual fallback note instead of failing to load.
const MISSING_MESSAGE = 'this build has no Cook scene packer; install @codepawlhq/cook and rebuild';

function throwMissing() {
  throw new Error(MISSING_MESSAGE);
}

export function buildNativeInput() {
  throwMissing();
}

export function buildNativeTexelInput() {
  throwMissing();
}

export function buildJobNativeInput() {
  throwMissing();
}

export function buildFlattenedJobNativeInput() {
  throwMissing();
}
