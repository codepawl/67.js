import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { MAXIMUM_JOB_DEADLINE_MS, jobDeadlineMs, normalizeJobSettings } from '../scripts/agent-render-jobs.mjs';
import { createAgentRuntime } from '../scripts/agent-runtime.mjs';
import { MAXIMUM_JOB_FPS, MAXIMUM_JOB_FRAMES } from '../src/agent-scene-capabilities.js';
import { DEFAULT_ENCODER_TIMEOUT_MS } from '../scripts/frame-encoder.mjs';

test('the encoder waits 30 seconds by default and no caller sets a different value', async () => {
  assert.equal(DEFAULT_ENCODER_TIMEOUT_MS, 30000);
  for (const file of ['../scripts/render-media.mjs', '../scripts/agent-runtime.mjs']) {
    const source = await readFile(new URL(file, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /timeoutMs\s*:/, `${file} must use the shared encoder default.`);
  }
});

test('the job deadline grows with frames and pixels and never passes its ceiling', () => {
  const still = jobDeadlineMs({ frameCount: 1, width: 1920, height: 1080 });
  assert.ok(still > 60000 && still < 90000);
  // The film that missed five minutes on a loaded machine: 360 frames at 1024x576.
  assert.equal(jobDeadlineMs({ frameCount: 360, width: 1024, height: 576 }), 780000);
  assert.ok(jobDeadlineMs({ frameCount: 360, width: 1920, height: 1080 }) > jobDeadlineMs({ frameCount: 360, width: 1024, height: 576 }));
  assert.ok(jobDeadlineMs({ frameCount: 360, width: 64, height: 64 }) < jobDeadlineMs({ frameCount: 720, width: 64, height: 64 }));
  assert.equal(jobDeadlineMs({ frameCount: 900, width: 1920, height: 1080 }), MAXIMUM_JOB_DEADLINE_MS);
  assert.equal(jobDeadlineMs({ frameCount: 900, width: 1920, height: 1080 }, 5000), 5000);
  assert.equal(MAXIMUM_JOB_DEADLINE_MS, 30 * 60 * 1000);
});

test('capabilities report the frame rate and frame limits the job validator enforces', async context => {
  const runtime = createAgentRuntime({ backend: 'cpu', memory: 64 });
  context.after(() => runtime.close());
  const { jobs } = await runtime.capabilities();
  const videoSettings = { kind: 'video', width: 64, height: 64, duration: 1 };
  assert.equal(jobs.maximumFps, MAXIMUM_JOB_FPS);
  assert.equal(normalizeJobSettings({ ...videoSettings, fps: jobs.maximumFps }, [], null).fps, jobs.maximumFps);
  assert.throws(() => normalizeJobSettings({ ...videoSettings, fps: jobs.maximumFps + 1 }, [], null), /fps/);
  assert.equal(jobs.maximumFrames, MAXIMUM_JOB_FRAMES);
  assert.throws(() => normalizeJobSettings({ ...videoSettings, fps: 60, duration: 16 }, [], null), /900 frames/);
});
