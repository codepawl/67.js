// One native session per sequence job (issue 896): the first frame of a stills or video job creates a session on the Cycles kernel,
// and each later frame renders through it. A frame whose scene differs only in the camera reuses the uploaded scene, the compiled
// kernel and the acceleration structures; one whose materials, lights or instance transforms changed sends those tables; one the
// session cannot take (other counts, geometry, textures or environment) gets a new session. Every frame equals the one-shot
// `traceNative` render of the same input byte for byte, and its route says which of these happened.
import { isNativeTimeLimitError } from './agent-native-trace.mjs';

const SESSION_OPTIONS = { kernel: 'cycles' };
const FIRST_FRAME_REASON = 'first frame of the sequence';
const REQUIRED_TRACER_FUNCTIONS = ['createNativeSession', 'planNativeSessionUpdate', 'prepareCyclesInput'];

/**
 * @param {{ tracer: object }} options `tracer` is the loaded render-native package.
 * @returns {{ trace(input: object, traceOptions: object): { traced: object, route: object }, close(): void }}
 *   `trace` takes a v1 table set or a FORMAT-v2 input and the `traceNative` options of the frame, and returns the traced
 *   planes with the route the frame took: `path` is "new-session", "reused", "updated" or "one-shot", `reason` says why a
 *   session was created or skipped, and the session's own reuse flags and update report ride along.
 */
export function createNativeSequence({ tracer }) {
  if (tracer === null || typeof tracer !== 'object') {
    throw new TypeError('createNativeSequence: pass `tracer`, the loaded @codepawlhq/67js-render-native package.');
  }
  let session = null;
  let heldInput = null;
  let closed = false;

  function closeSession() {
    const closingSession = session;
    session = null;
    heldInput = null;
    try {
      closingSession?.close();
    } catch {
      // The session is gone either way; the next frame creates a new one.
    }
  }

  function missingSessionSupport() {
    const missing = REQUIRED_TRACER_FUNCTIONS.filter(name => typeof tracer[name] !== 'function');
    return missing.length === 0 ? null : `the installed render-native package has no ${missing.join(' or ')}`;
  }

  function traceOnce(input, traceOptions, reason) {
    return { traced: tracer.traceNative(input, traceOptions), route: { path: 'one-shot', reason } };
  }

  // Returns null when the open session now holds `nextInput`, otherwise the reason it was closed.
  function bringSessionUpToDate(nextInput, route) {
    let changedTables;
    try {
      changedTables = Object.keys(tracer.planNativeSessionUpdate(heldInput, nextInput));
    } catch (error) {
      closeSession();
      return error.message;
    }
    if (changedTables.length === 0) {
      route.path = 'reused';
      return null;
    }
    try {
      const report = session.update(nextInput);
      heldInput = nextInput;
      Object.assign(route, { path: 'updated', changedTables, accelerationRebuilt: report.accelerationRebuilt, kernelRespecialized: report.kernelRespecialized,
        updateSeconds: report.updateSeconds });
      return null;
    } catch (error) {
      // A failed update closes the session by design, so the frame goes to a new one.
      closeSession();
      return `the session update failed (${error.message})`;
    }
  }

  function createSession(nextInput, route, reason) {
    session = tracer.createNativeSession(nextInput, SESSION_OPTIONS);
    heldInput = nextInput;
    Object.assign(route, { path: 'new-session', reason });
  }

  return {
    trace(input, traceOptions) {
      if (closed) throw new Error('createNativeSequence: this sequence is closed. Create a new one for the next job.');
      const unsupported = missingSessionSupport();
      if (unsupported) return traceOnce(input, traceOptions, unsupported);
      const nextInput = tracer.prepareCyclesInput(input, traceOptions);
      const route = {};
      const reasonForNewSession = session ? bringSessionUpToDate(nextInput, route) : FIRST_FRAME_REASON;
      if (reasonForNewSession !== null) {
        try {
          createSession(nextInput, route, reasonForNewSession);
        } catch (error) {
          closeSession();
          return traceOnce(input, traceOptions, `${reasonForNewSession}; creating a session failed (${error.message})`);
        }
      }
      try {
        const traced = session.render({ ...traceOptions, kernelParams: nextInput.kernelParams });
        Object.assign(route, { pipelineReused: traced.pipelineReused, accelerationReused: traced.accelerationReused, frameIndex: traced.frameIndex });
        return { traced, route };
      } catch (error) {
        closeSession();
        if (isNativeTimeLimitError(error)) throw error;
        return traceOnce(input, traceOptions, `the session render failed (${error.message})`);
      }
    },
    close() {
      closed = true;
      closeSession();
    },
  };
}
