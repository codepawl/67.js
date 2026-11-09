import './support/load-agent-scene-modules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentScene, AGENT_SCENE_CAPABILITIES } from '../src/agent-scene.js';
import { filmTimelineDuration, filmTimelineShotStarts, normalizeFilmTimeline, sampleFilmTimeline } from '../src/film-timeline.js';
import { createAgentRenderJobs } from '../scripts/agent-render-jobs.mjs';
import { createAudioLibrary } from '../scripts/job-audio.mjs';
import { audioCodecArguments } from '../scripts/frame-encoder.mjs';

function recipeWith(extra = {}) {
  return {
    format: '67js.scene', schemaVersion: 1,
    geometries: [{ id: 'box', type: 'box' }],
    materials: [{ id: 'grey', color: [0.5, 0.5, 0.5] }],
    nodes: [{ id: 'block', geometry: 'box', material: 'grey' }],
    camera: { eye: [0, 1, 6], target: [0, 0, 0], fov: 40 },
    ...extra,
  };
}

const threeShots = {
  shots: [
    { name: 'wide', duration: 2 },
    { name: 'close', duration: 3, camera: { eye: [0, 0.5, 2], fov: 30 }, dip: 1 },
    { name: 'end', duration: 1 },
  ],
};

test('a timeline keeps its shots, camera overrides and durations through the scene', () => {
  const scene = createAgentScene(recipeWith({ timeline: threeShots }));
  const exported = scene.exportRecipe();
  assert.deepEqual(exported.timeline.shots.map(shot => shot.name), ['wide', 'close', 'end']);
  assert.deepEqual(exported.timeline.shots[1].camera, { eye: [0, 0.5, 2], fov: 30 });
  assert.equal(filmTimelineDuration(exported.timeline), 6);
  assert.deepEqual(filmTimelineShotStarts(exported.timeline).map(shot => shot.start), [0, 2, 5]);
});

test('set-timeline edits the timeline and null removes it', () => {
  const scene = createAgentScene(recipeWith());
  assert.ok(AGENT_SCENE_CAPABILITIES.operations.includes('set-timeline'));
  scene.apply([{ type: 'set-timeline', timeline: threeShots }], { expectedRevision: scene.revision });
  assert.equal(scene.exportRecipe().timeline.shots.length, 3);
  scene.apply([{ type: 'set-timeline', timeline: null }], { expectedRevision: scene.revision });
  assert.equal(Object.hasOwn(scene.exportRecipe(), 'timeline'), false);
  assert.throws(() => scene.apply([{ type: 'set-timeline' }], { expectedRevision: scene.revision }), /timeline: got undefined; expected a timeline value, or null to clear it/);
});

test('hostile timelines are rejected with a reason', () => {
  const rejected = [
    [{ shots: [] }, /1 to 64/],
    [{ shots: [{ name: 'a', duration: 1 }], layers: [] }, /unsupported field "layers"/],
    [{ shots: [{ name: 'a b', duration: 1 }] }, /name must be/],
    [{ shots: [{ name: '../x', duration: 1 }] }, /name must be/],
    [{ shots: [{ name: 'a', duration: 1 }, { name: 'a', duration: 1 }] }, /used twice/],
    [{ shots: [{ name: 'a', duration: 0.01 }] }, /duration must be/],
    [{ shots: [{ name: 'a', duration: 31 }] }, /duration must be/],
    [{ shots: [{ name: 'a', duration: 30 }, { name: 'b', duration: 30 }, { name: 'c', duration: 1 }] }, /the most is 60/],
    [{ shots: [{ name: 'a', duration: 1, motionStart: 0 }] }, /no motion, physics or cloth/],
    [{ shots: [{ name: 'a', duration: 1, dip: 4 }] }, /dip is longer/],
    [{ shots: [{ name: 'a', duration: 1, camera: 'close' }] }, /plain object/],
    [{ shots: [{ name: 'a', duration: 1, extra: true }] }, /unsupported field "extra"/],
    [{ shots: Array.from({ length: 65 }, (unused, index) => ({ name: `s${index}`, duration: 0.1 })) }, /1 to 64/],
  ];
  for (const [timeline, message] of rejected) {
    assert.throws(() => createAgentScene(recipeWith({ timeline })), message);
  }
  assert.throws(() => createAgentScene(recipeWith({ timeline: { shots: [{ name: 'a', duration: 1, camera: { eye: [0, 0, 0], target: [0, 0, 0], fov: 400 } }] } })), /fov|camera/i);
  assert.throws(() => createAgentScene(recipeWith({ timeline: { shots: [{ name: 'a', duration: 1, camera: { zoom: 2 } }] } })), /camera/);
  assert.throws(() => normalizeFilmTimeline(Object.create({ shots: [] }), recipeWith()), /plain object/);
  for (const duration of [Number.NaN, Infinity, '2', null]) {
    assert.throws(() => normalizeFilmTimeline({ shots: [{ name: 'a', duration }] }, recipeWith()), /duration must be/);
  }
});

test('motion must cover the shots unless it loops or the shot sets motionStart', () => {
  const motion = { duration: 4, tracks: [{ kind: 'node', id: 'block', property: 'translation', keyframes: [{ time: 0, value: [0, 0, 0] }, { time: 4, value: [1, 0, 0] }] }] };
  assert.throws(() => createAgentScene(recipeWith({ motion, timeline: threeShots })), /reads motion up to 5 s/);
  const replayed = { shots: [{ name: 'a', duration: 3 }, { name: 'b', duration: 3, motionStart: 2 }] };
  assert.throws(() => createAgentScene(recipeWith({ motion, timeline: replayed })), /reads motion up to 5 s/);
  assert.doesNotThrow(() => createAgentScene(recipeWith({ motion: { ...motion, loop: true }, timeline: threeShots })));
  const cuts = { shots: [{ name: 'a', duration: 2 }, { name: 'b', duration: 2, motionStart: 0 }] };
  assert.doesNotThrow(() => createAgentScene(recipeWith({ motion, timeline: cuts })));
});

test('sampling is stateless: a time gives one shot, motion clock, camera and brightness in any order', () => {
  const motion = { duration: 10, tracks: [{ kind: 'node', id: 'block', property: 'translation', keyframes: [{ time: 0, value: [0, 0, 0] }, { time: 10, value: [1, 0, 0] }] }] };
  const recipe = recipeWith({ motion });
  const timeline = normalizeFilmTimeline({ shots: [
    { name: 'wide', duration: 2 },
    { name: 'close', duration: 3, motionStart: 7, camera: { fov: 30 }, dip: 1 },
  ] }, recipe);
  const first = sampleFilmTimeline(timeline, recipe, 2.25);
  assert.equal(first.shotName, 'close');
  assert.equal(first.motionTime, 7.25);
  assert.deepEqual(first.camera, { fov: 30 });
  assert.equal(first.brightness, 0.5);
  const order = [4.99, 0, 2.25, 1.99, 2.25];
  const samples = order.map(time => JSON.stringify(sampleFilmTimeline(timeline, recipe, time)));
  assert.equal(samples[2], samples[4]);
  assert.equal(sampleFilmTimeline(timeline, recipe, 0).shotName, 'wide');
  assert.equal(sampleFilmTimeline(timeline, recipe, 1.75).brightness, 0.5);
  assert.equal(sampleFilmTimeline(timeline, recipe, 2).brightness, 0);
  assert.equal(sampleFilmTimeline(timeline, recipe, 3).brightness, 1);
  assert.equal(sampleFilmTimeline(timeline, recipe, 5).shotName, 'close');
  assert.throws(() => sampleFilmTimeline(timeline, recipe, 5.01), /outside/);
  assert.throws(() => sampleFilmTimeline(timeline, recipe, -1), /outside/);
  const stillRecipe = recipeWith();
  assert.equal(sampleFilmTimeline(normalizeFilmTimeline(threeShots, stillRecipe), stillRecipe, 3).motionTime, null);
});

async function controllerFor(context) {
  const root = await mkdtemp(join(tmpdir(), '67js-timeline-jobs-'));
  const controller = await createAgentRenderJobs({ root, async run({ signal }) {
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    throw signal.reason;
  } });
  context.after(async () => {
    await controller.close();
    await rm(root, { recursive: true, force: true });
  });
  return controller;
}

function submission(settings, recipe = createAgentScene(recipeWith({ timeline: threeShots })).exportRecipe()) {
  return { sourceRevision: 0, snapshot: { recipe }, settings: { kind: 'video', width: 64, height: 64, fps: 10, ...settings } };
}

test('timeline settings derive the duration and reject mixed clocks and ranges past the end', async context => {
  const controller = await controllerFor(context);
  const record = await controller.submit(submission({ timeline: {} }));
  assert.equal(controller.status(record.jobId).settings.duration, 6);
  assert.equal(controller.status(record.jobId).settings.frameCount, 60);
  assert.deepEqual(controller.status(record.jobId).settings.timeline, { start: 0 });
  controller.cancel(record.jobId);
  while (!['cancelled', 'failed'].includes(controller.status(record.jobId).state)) await new Promise(resolve => setTimeout(resolve, 10));
  const rejected = [
    { timeline: { start: 7 } },
    { timeline: { start: 4 }, duration: 3 },
    { timeline: { offset: 1 } },
    { timeline: {}, motion: { start: 0 } },
    { timeline: { start: -1 } },
  ];
  for (const settings of rejected) await assert.rejects(controller.submit(submission(settings)));
  await assert.rejects(controller.submit(submission({ timeline: {} }, recipeWith())), /require a recipe with a timeline/);
});

test('encoder is a bounded enum and audio is a plain file name, both video only', async context => {
  const controller = await controllerFor(context);
  const hostileEncoders = ['libx264', 'nvenc -f lavfi', 'cpu; rm -rf', '', null, 7, ['cpu'], { name: 'cpu' }];
  for (const encoder of hostileEncoders) await assert.rejects(controller.submit(submission({ encoder })), /encoder/);
  await assert.rejects(controller.submit(submission({ kind: 'image', encoder: 'cpu' })), /encoder needs kind video/);
  const hostileFiles = ['../score.wav', '..\\score.wav', 'C:\\score.wav', '/etc/passwd.wav', 'http://example.com/a.wav', 'file:score.wav',
    'concat:a.wav|b.wav', '-i score.wav', 'score.wav\0.mp3', 'score.exe', 'score', '.wav', 'a b.wav', 'a'.repeat(70) + '.wav', ['score.wav'], { toString: () => 'score.wav' }, 7];
  for (const file of hostileFiles) await assert.rejects(controller.submit(submission({ audio: { file } })), /audio/);
  await assert.rejects(controller.submit(submission({ audio: { file: 'score.wav', gain: 2 } })), /Unknown audio field/);
  await assert.rejects(controller.submit(submission({ audio: { file: 'score.wav', offset: -1 } })), /audio offset/);
  await assert.rejects(controller.submit(submission({ kind: 'image', audio: { file: 'score.wav' } })), /audio needs kind video/);
  for (const track of ['wav', 'AAC', '', null, 7, ['pcm']]) {
    await assert.rejects(controller.submit(submission({ audio: { file: 'score.wav', track } })), /audio.track/);
  }
  const accepted = await controller.submit(submission({ encoder: 'nvenc', audio: { file: 'score.wav', offset: 1.5 } }));
  assert.deepEqual(controller.status(accepted.jobId).settings.audio, { file: 'score.wav', offset: 1.5, track: 'aac' });
  assert.equal(controller.status(accepted.jobId).settings.encoder, 'nvenc');
});

test('audio.track pcm is kept on the job for parts that will be joined', async context => {
  const controller = await controllerFor(context);
  const accepted = await controller.submit(submission({ audio: { file: 'score.wav', offset: 30, track: 'pcm' } }));
  assert.deepEqual(controller.status(accepted.jobId).settings.audio, { file: 'score.wav', offset: 30, track: 'pcm' });
});

test('audio codec arguments: AAC by default, PCM for parts that will be joined, nothing else', () => {
  assert.deepEqual(audioCodecArguments('aac'), ['-c:a', 'aac', '-b:a', '192k']);
  assert.deepEqual(audioCodecArguments('pcm'), ['-c:a', 'pcm_s16le']);
  assert.throws(() => audioCodecArguments('libmp3lame'), /aac or pcm/);
});

test('the audio library resolves plain files only and refuses links, empty files and wrong names', async context => {
  const root = await mkdtemp(join(tmpdir(), '67js-audio-library-'));
  const outside = await mkdtemp(join(tmpdir(), '67js-audio-outside-'));
  context.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]));
  await writeFile(join(root, 'score.wav'), 'RIFF');
  await writeFile(join(root, 'empty.wav'), '');
  await writeFile(join(outside, 'secret.wav'), 'RIFF');
  await mkdir(join(root, 'folder.wav'));
  const library = createAudioLibrary(root);
  assert.equal(await library.resolve('score.wav'), join(root, 'score.wav'));
  await assert.rejects(library.resolve('missing.wav'), /not in the audio folder/);
  await assert.rejects(library.resolve('empty.wav'), /1 byte/);
  await assert.rejects(library.resolve('folder.wav'), /regular file/);
  await assert.rejects(library.resolve('../secret.wav'), /not allowed/);
  await assert.rejects(library.resolve(join(outside, 'secret.wav')), /not allowed/);
  try {
    await symlink(join(outside, 'secret.wav'), join(root, 'link.wav'));
    await assert.rejects(library.resolve('link.wav'), /regular file|outside/);
  } catch (error) {
    if (error.code !== 'EPERM') throw error;
  }
  assert.throws(() => createAudioLibrary('relative/folder'), /absolute/);
});

test('a shot sets its own focus distance and blur, and a seek gives the same answer', () => {
  const recipe = recipeWith();
  const timeline = normalizeFilmTimeline({ shots: [
    { name: 'wide', duration: 2 },
    { name: 'portrait', duration: 2, focusDistance: 1.8, blur: 0.7 },
    { name: 'distance', duration: 2, focusDistance: 40 },
  ] }, recipe);
  assert.equal(sampleFilmTimeline(timeline, recipe, 1).depthOfField, null, 'a shot with neither field keeps the recipe depth of field');
  assert.deepEqual(sampleFilmTimeline(timeline, recipe, 3).depthOfField, { focusDistance: 1.8, blur: 0.7 });
  assert.deepEqual(sampleFilmTimeline(timeline, recipe, 5).depthOfField, { focusDistance: 40 });
  const order = [5, 3, 1, 3, 5.5, 3];
  const samples = order.map(time => JSON.stringify(sampleFilmTimeline(timeline, recipe, time)));
  assert.equal(samples[1], samples[3]);
  assert.equal(samples[1], samples[5]);
  const kept = createAgentScene(recipeWith({ timeline: { shots: [{ name: 'a', duration: 1, focusDistance: 2, blur: 0.5 }] } })).exportRecipe();
  assert.equal(kept.timeline.shots[0].focusDistance, 2);
  assert.equal(kept.timeline.shots[0].blur, 0.5);
});

test('shot focus distance and blur are checked at the boundary', () => {
  const rejected = [
    [{ focusDistance: 0 }, /focusDistance must be a number from 0.01 to 100000/],
    [{ focusDistance: 100001 }, /focusDistance must be/],
    [{ focusDistance: '2' }, /focusDistance must be/],
    [{ blur: 1.5 }, /blur must be a number from 0 to 1/],
    [{ blur: -0.1 }, /blur must be/],
  ];
  for (const [fields, message] of rejected) {
    assert.throws(() => createAgentScene(recipeWith({ timeline: { shots: [{ name: 'a', duration: 1, ...fields }] } })), message);
  }
});
