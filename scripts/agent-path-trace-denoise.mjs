import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// The optional native denoiser is its own npm package, so the server never carries it. The name sits in a variable so the
// bundler leaves the import alone and it resolves from the user's node_modules when a job asks for it.
const OIDN_PACKAGE = '@codepawlhq/67js-denoise-oidn';

// A source checkout keeps the package in packages/, beside scripts/ or, from the bundled server, two folders above build/mcp.
const CHECKOUT_PACKAGE_URLS = ['../packages/denoise-oidn/index.mjs', '../../packages/denoise-oidn/index.mjs']
  .map(relative => new URL(/* @vite-ignore */ relative, import.meta.url));

async function loadOidnPackage() {
  const checkoutSpecifiers = CHECKOUT_PACKAGE_URLS.filter(packageUrl => existsSync(fileURLToPath(packageUrl))).map(packageUrl => packageUrl.href);
  for (const specifier of [OIDN_PACKAGE, ...checkoutSpecifiers]) {
    try {
      const denoiser = await import(/* @vite-ignore */ specifier);
      if (denoiser.findOidnBinary()) return denoiser;
    } catch {
      // Try the next place the package may live.
    }
  }
  return null;
}

/**
 * What a job's `settings.renderer.denoise` becomes. "oidn" needs the optional package and its binary; without them the
 * wavelet filter runs instead and `note` says so, so the job result never claims a denoiser that did not run.
 * `preferOidn` is set for the native backend: there the default (`true`) means OIDN with the albedo and normal guides when
 * it is installed, else the wavelet filter with the same guides, and the note says why. Explicit values keep their meaning.
 */
export async function chooseDenoiser(requested, { preferOidn = false, loadOidn = loadOidnPackage } = {}) {
  const defaultsToOidn = preferOidn && requested === true;
  if (requested !== 'oidn' && !defaultsToOidn) return { denoise: requested };
  const denoiser = await loadOidn();
  if (denoiser) {
    return defaultsToOidn
      ? { denoise: 'oidn', denoiser, note: 'The native backend denoises with OIDN and the albedo and normal guides by default.' }
      : { denoise: 'oidn', denoiser };
  }
  const reason = `needs ${OIDN_PACKAGE} and its binary (npm run fetch in that package, or OIDN_DENOISE_PATH)`;
  return { denoise: 'wavelet', note: defaultsToOidn
    ? `The native backend denoises with OIDN, which ${reason}: the wavelet filter ran instead.`
    : `denoise "oidn" ${reason}: the wavelet filter ran instead.` };
}

function floatsFromBase64(base64) {
  const bytes = Buffer.from(base64, 'base64');
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
}

/**
 * Filters the features a page returned for denoise "oidn" and gives the result back to the page to draw. If the tool fails,
 * the page filters the same pixels with the wavelet filter and the report says so. Returns the PNG as base64 and the report.
 */
export async function finishWithOidn({ traced, denoiser, drawLinear }) {
  const { width, height } = traced.report;
  const features = Object.fromEntries(['color', 'albedo', 'normal'].map(name => [name, floatsFromBase64(traced.features[name])]));
  const started = performance.now();
  let linear;
  let failure;
  try {
    linear = await denoiser.denoiseWithOidn({ width, height, ...features });
  } catch (error) {
    failure = error.message;
  }
  const denoiseSeconds = (performance.now() - started) / 1000;
  const drawn = await drawLinear({ width, height, ...(linear ? { linear: Buffer.from(linear.buffer, linear.byteOffset, linear.byteLength).toString('base64') } : {}) });
  const report = { ...traced.report, denoised: true, denoiser: linear ? 'oidn' : 'wavelet', denoiseSeconds, ...(linear ? { oidnVersion: denoiser.OIDN_VERSION } : { denoiserNote: `OIDN failed (${failure}): the wavelet filter ran instead.` }) };
  return { data: drawn.data, report };
}
