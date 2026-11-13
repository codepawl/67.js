// Shared by the sequence benches: hashing, per-frame summaries and the session / one-shot frame loop.
import { createHash } from 'node:crypto';
import * as renderNative from '@codepawlhq/cook';
import { createNativeSequence } from '../../scripts/agent-native-sequence.mjs';

export const PHASE_NAMES = ['setupSeconds', 'compileSeconds', 'uploadSeconds', 'accelerationBuildSeconds', 'tracedSeconds'];

export function readFlag(argumentList, flagName, fallbackValue) {
  const flagIndex = argumentList.indexOf(flagName);
  return flagIndex === -1 ? fallbackValue : argumentList[flagIndex + 1];
}

function sha256Of(values) {
  return createHash('sha256').update(Buffer.from(values.buffer, values.byteOffset, values.byteLength)).digest('hex');
}

function summarizeFrame(traced, route, wallSeconds) {
  const frame = { rgbaSha256: sha256Of(traced.rgba), wallSeconds: Number(wallSeconds.toFixed(6)), path: route?.path ?? 'one-shot' };
  for (const phaseName of PHASE_NAMES) frame[phaseName] = Number((traced[phaseName] ?? 0).toFixed(6));
  if (route?.reason) frame.reason = route.reason;
  if (route?.changedTables) frame.changedTables = route.changedTables;
  return frame;
}

export function averageOfWarmFrames(frames, fieldName) {
  const warmFrames = frames.slice(1);
  const total = warmFrames.reduce((sum, frame) => sum + frame[fieldName], 0);
  return Number((total / Math.max(1, warmFrames.length)).toFixed(6));
}

/**
 * Renders the frames in order through a native sequence ("session") or one by one with traceNative ("oneshot"). `prepareInput(frameIndex)`
 * runs before the frame's timer starts and returns the frame's input, so copying a large table never counts as render time.
 */
export function runSequence(frameCount, prepareInput, mode, traceOptions) {
  const sequence = mode === 'session' ? createNativeSequence({ tracer: renderNative }) : null;
  const frames = [];
  const sequenceStarted = performance.now();
  let preparationSeconds = 0;
  try {
    for (let frameIndex = 0; frameIndex < frameCount; frameIndex++) {
      const preparationStarted = performance.now();
      const input = prepareInput(frameIndex);
      preparationSeconds += (performance.now() - preparationStarted) / 1000;
      const frameStarted = performance.now();
      const { traced, route } = sequence ? sequence.trace(input, traceOptions) : { traced: renderNative.traceNative(input, traceOptions) };
      frames.push(summarizeFrame(traced, route, (performance.now() - frameStarted) / 1000));
    }
  } finally {
    sequence?.close();
  }
  const totalSeconds = (performance.now() - sequenceStarted) / 1000 - preparationSeconds;
  return { frames, totalSeconds: Number(totalSeconds.toFixed(6)) };
}
