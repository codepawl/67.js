// The contract between 67js and a native render engine module (see docs/render-engines.md). 67js checks the module once, when
// the native tracer is first looked for, and a module that does not fit gives one clear reason instead of a failure in the
// middle of a render job.

const REQUIRED_CALLS = ['describeEngine', 'findNativeAddon', 'traceNative', 'traceNativeTexels'];
const SESSION_CALLS = ['createNativeSession', 'planNativeSessionUpdate', 'prepareCyclesInput'];
const DENOISER_CALLS = { atrous: 'denoiseAtrous', oidn: 'createNativeOidnDenoiser' };

function missingCalls(engineModule, names) {
  return names.filter(name => typeof engineModule[name] !== 'function');
}

function readDescription(engineModule) {
  try {
    return { description: engineModule.describeEngine() };
  } catch (error) {
    return { reason: `describeEngine() threw an error (${error?.message ?? error}).` };
  }
}

function revisionProblem(description) {
  const packFormat = description.packFormat;
  const revision = packFormat?.revision;
  const range = packFormat?.readsRevisions;
  const rangeIsValid = Array.isArray(range) && range.length === 2 && range.every(Number.isInteger);
  if (!Number.isInteger(revision) || !rangeIsValid) {
    return 'its description has no packFormat.revision and packFormat.readsRevisions.';
  }
  const [oldest, newest] = range;
  if (revision < oldest || revision > newest) {
    return `the pack revision ${revision} of the scene packer 67js uses is outside revisions ${oldest} to ${newest}, which this engine reads. Install a matching version of the engine.`;
  }
  return null;
}

function optionalCallProblems(engineModule, description) {
  const problems = [];
  if (description.sessions) {
    const missing = missingCalls(engineModule, SESSION_CALLS);
    if (missing.length > 0) problems.push(`its description offers sessions but it has no ${missing.join(' or ')}`);
  }
  const denoisers = Array.isArray(description.denoisers) ? description.denoisers : [];
  for (const [denoiser, callName] of Object.entries(DENOISER_CALLS)) {
    if (denoisers.includes(denoiser) && typeof engineModule[callName] !== 'function') {
      problems.push(`its description offers the "${denoiser}" denoiser but it has no ${callName}`);
    }
  }
  return problems;
}

/**
 * Checks that a loaded module is a render engine this build of 67js can drive. Never throws. Resolves to
 * `{ engine, description }` when it fits, or `{ reason }` with one sentence that says what is wrong.
 */
export function requireRenderEngine(engineModule) {
  if (engineModule === null || typeof engineModule !== 'object') {
    return { reason: 'the render engine module did not load as an object.' };
  }
  const missing = missingCalls(engineModule, REQUIRED_CALLS);
  if (missing.length > 0) {
    return { reason: `the render engine module has no ${missing.join(' or ')}; it is not a render engine this 67js can use.` };
  }
  const read = readDescription(engineModule);
  if (read.reason) return { reason: `the render engine module is broken: ${read.reason}` };
  const description = read.description;
  if (description === null || typeof description !== 'object') {
    return { reason: 'the render engine module is broken: describeEngine() did not return an object.' };
  }
  const revisionReason = revisionProblem(description);
  if (revisionReason) {
    const label = description.name ? `the render engine ${description.name}` : 'the render engine';
    return { reason: `${label} cannot read this scene format: ${revisionReason}` };
  }
  const problems = optionalCallProblems(engineModule, description);
  if (problems.length > 0) return { reason: `the render engine module does not match its own description: ${problems.join('; ')}.` };
  return { engine: engineModule, description };
}

/**
 * The limits a job uses: each 67js default, lowered to the engine's declared limit of the same name when it declares one.
 * An engine limit of null (or none) declares no limit, so the default stays.
 */
export function clampLimitsByEngine(defaultLimits, engineLimits) {
  const limits = {};
  for (const [name, defaultValue] of Object.entries(defaultLimits)) {
    const declared = engineLimits?.[name];
    const hasDeclaredLimit = typeof declared === 'number' && Number.isFinite(declared);
    limits[name] = hasDeclaredLimit ? Math.min(defaultValue, declared) : defaultValue;
  }
  return limits;
}
