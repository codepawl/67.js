// A build without Cook still has to work: the preview page imports the Cook scene packers by package name, and this
// plugin swaps them for scripts/cook-missing.js when the package is not installed or COOK_DISABLE=1 asks for that mode.
// Used by config/vite.lib.config.js, which builds the page that carries the packers.
import { fileURLToPath } from 'node:url';

const PACKER_SPECIFIERS = new Set(['@codepawlhq/cook/pack-input', '@codepawlhq/cook/job-input']);
const MISSING_STUB_PATH = fileURLToPath(new URL('./cook-missing.js', import.meta.url));

function isResolvable(specifier) {
  try {
    import.meta.resolve(specifier);
    return true;
  } catch {
    return false;
  }
}

export function cookOptionalForVite({ environment = process.env, isInstalled = isResolvable, stubPath = MISSING_STUB_PATH } = {}) {
  return {
    name: 'cook-optional',
    enforce: 'pre',
    resolveId(specifier) {
      if (!PACKER_SPECIFIERS.has(specifier)) return null;
      if (environment.COOK_DISABLE === '1') return stubPath;
      return isInstalled(specifier) ? null : stubPath;
    },
  };
}
