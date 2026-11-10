// Direction B: a world. Scroll position scrubs a camera through a live 67js scene while the text chapters swap.
// Three candidate scenes, picked with ?scene=valley | ignition | port (default valley). Each lives in ./scenes and loads on its own.
import './lab.css';
import { clamp, damp, prefersReducedMotion, showStageError, smoothstep, startLoop } from './stage.js';

const SCENES = {
  valley: () => import('./scenes/valley.js'),
  ignition: () => import('./scenes/ignition.js'),
  port: () => import('./scenes/port.js'),
};
const requested = new URLSearchParams(location.search).get('scene');
const sceneId = Object.hasOwn(SCENES, requested) ? requested : 'valley';

const stage = document.querySelector('#stage');
const canvas = document.querySelector('#viewport');
const root = document.querySelector('.hero-b');
const chapterOne = document.querySelector('#chapter-one');
const chapterTwo = document.querySelector('#chapter-two');
const cue = document.querySelector('#cue');
const progressFill = document.querySelector('#progress-fill');
const openLink = document.querySelector('#open-scene');

const SCRUB_RATE = 7;
// Reduced motion freezes scene time at one fixed moment.
const STILL_TIME = 1;
root.dataset.scene = sceneId;

function scrollProgress() {
  const travel = root.offsetHeight - innerHeight;
  return clamp(-root.getBoundingClientRect().top / travel, 0, 1);
}

// Chapter copy is driven by the scroll progress, using transform and opacity only. Reduced motion keeps the fades and drops the travel.
function paintChapters(progress) {
  const travel = prefersReducedMotion ? 0 : 1;
  const leaving = smoothstep(0.12, 0.38, progress);
  chapterOne.style.opacity = String(1 - leaving);
  chapterOne.style.transform = `translateY(${-28 * leaving * travel}px)`;
  chapterOne.style.pointerEvents = leaving > 0.5 ? 'none' : '';
  const arriving = smoothstep(0.62, 0.9, progress);
  chapterTwo.style.opacity = String(arriving);
  chapterTwo.style.transform = `translateY(${24 * (1 - arriving) * travel}px)`;
  cue.style.opacity = String(1 - smoothstep(0.02, 0.12, progress));
  progressFill.style.transform = `scaleY(${progress})`;
}

async function start() {
  const { createScene } = await SCENES[sceneId]();
  const scene = await createScene(canvas);
  // A scene may hold the poster until it is whole (the port waits for every part so no frame shows an unfinished world).
  await scene.ready;
  openLink.href = scene.openHref;
  canvas.setAttribute('aria-label', `A live 3D scene: ${scene.label}. Scroll to move the camera.`);

  const state = { progress: scrollProgress(), aim: scrollProgress(), settled: false, override: null };
  // With reduced motion the camera holds one chosen framing; scrolling only swaps the text.
  const cameraProgress = () => (prefersReducedMotion ? scene.staticProgress : state.progress);
  const loop = startLoop(stage, (seconds, timestamp) => {
    state.aim = scrollProgress();
    state.progress = state.instant ? state.aim : damp(state.progress, state.aim, SCRUB_RATE, seconds);
    state.settled = Math.abs(state.progress - state.aim) < 0.0004;
    if (state.settled) state.progress = state.aim;
    const sceneTime = prefersReducedMotion ? STILL_TIME : timestamp / 1000;
    scene.render(cameraProgress(), sceneTime, state.override);
    paintChapters(state.progress);
    return !state.settled || (scene.ambient && !prefersReducedMotion);
  });
  window.addEventListener('scroll', loop.wake, { passive: true });
  window.addEventListener('resize', () => { scene.resize?.(); loop.wake(); });
  window.__heroB = { sceneId, state, scene, wake: loop.wake, canvas };
}

paintChapters(scrollProgress());
start().catch(error => showStageError(stage, `Live view unavailable: ${error.message}`));
