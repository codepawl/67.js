import './film-style.css';
import './brand.js';
import { CrucibleRenderer } from './renderer.js';
import './explosion-shader.js';
import { createFilmScenes, FILM_DURATION, sampleFilm } from './film.js';

const query = new URLSearchParams(window.location.search);
const exporting = query.get('export') === '1';
function numberOption(name, fallback, minimum, maximum) {
  const raw = query.get(name);
  const value = raw === null || raw.trim() === '' ? fallback : Number(raw);
  return Number.isFinite(value) ? Math.round(Math.max(minimum, Math.min(maximum, value))) : fallback;
}
const width = numberOption('width', 1280, 320, 7680);
const height = numberOption('height', 720, 240, 4320);
const samples = numberOption('samples', 4, 1, 8);
const memoryBudgetMiB = numberOption('memory', 384, 64, 1024);
const canvas = document.querySelector('#film-canvas');
const stage = document.querySelector('.film-stage');
const slider = document.querySelector('#film-time');
const playButton = document.querySelector('#film-play');
const playLabel = document.querySelector('#play-label');
const playSymbol = document.querySelector('#play-symbol');
const clock = document.querySelector('#film-clock');
const title = document.querySelector('#film-title');
const titleText = document.querySelector('#title-text');
const subtitleText = document.querySelector('#subtitle-text');
const flash = document.querySelector('#film-flash');
const scenes = createFilmScenes();
slider.max = String(FILM_DURATION);
const score = exporting ? null : new Audio('./media/critical.mp4');
if (score) score.preload = 'none';
let renderer = null;
let activeScene = null;
let currentTime = 0;
let playing = false;
let animationFrame = 0;
let playbackOrigin = 0;
let scrubbing = false;
let resumeAfterScrub = false;
let seekFrame = 0;
let pendingSeek = null;
let audioSeekTarget = null;

if (exporting) {
  document.body.classList.add('export-mode');
  stage.style.width = `${width}px`;
  stage.style.height = `${height}px`;
}

function displayTime(seconds) {
  return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
}

function renderAt(time) {
  const sample = sampleFilm(time, { aspect: canvas.clientWidth / canvas.clientHeight });
  const scene = scenes[sample.scene];
  if (activeScene !== sample.scene) {
    renderer?.dispose();
    renderer = null;
    activeScene = null;
    const parts = sample.scene === 'ignition' ? scene.parts.filter(part => !['fire', 'smoke'].includes(part.material.tag)) : scene.parts;
    renderer = new CrucibleRenderer(canvas, parts, {
      world: true,
      ground: scene.ground,
      environment: scene.environment,
      shadowBounds: scene.shadowBounds,
      pixelRatio: 1,
      samples,
      hdr: true,
      depth: true,
      memoryBudgetMiB,
    });
    activeScene = sample.scene;
  }
  scene.animate?.(sample.sceneTime);
  if (scene.animate) renderer.updateParts(scene.parts);
  renderer.render({
    ...sample.camera,
    time: sample.sceneTime,
    exposure: sample.exposure,
    monochrome: sample.monochrome,
    fade: sample.fade,
    cinematic: true,
    effects: sample.effects,
    explosionProgress: sample.explosionProgress,
    volumeExplosion: sample.scene === 'ignition',
    environment: scene.environment,
  });
  currentTime = sample.time;
  if (!scrubbing) slider.value = String(currentTime);
  slider.setAttribute('aria-valuetext', `${currentTime.toFixed(1)} of ${FILM_DURATION} seconds`);
  clock.value = `${displayTime(currentTime)} / ${displayTime(FILM_DURATION)}`;
  titleText.textContent = sample.title;
  subtitleText.textContent = sample.subtitle;
  title.style.opacity = String(sample.titleOpacity);
  flash.style.opacity = String(sample.flash);
  return sample;
}

function setPlaying(value) {
  playing = value;
  playLabel.textContent = playing ? 'Pause' : currentTime >= FILM_DURATION ? 'Play again' : 'Play film';
  playSymbol.textContent = playing ? 'Ⅱ' : '▶';
  playButton.setAttribute('aria-label', playing ? 'Pause film' : 'Play film');
  cancelAnimationFrame(animationFrame);
  animationFrame = 0;
  if (playing) {
    if (currentTime >= FILM_DURATION) renderAt(0);
    if (score) {
      audioSeekTarget = currentTime;
      score.currentTime = currentTime;
      score.play().catch(error => {
        if (!playing || error.name === 'AbortError') return;
        document.querySelector('.film-caption').textContent = '⚠ Score unavailable. The 3D film continues.';
      });
    }
    playbackOrigin = performance.now() - currentTime * 1000;
    animationFrame = requestAnimationFrame(advance);
  } else score?.pause();
}

function showError(error) {
  setPlaying(false);
  const notice = document.querySelector('#film-error');
  notice.textContent = `⚠ ${error.message}`;
  notice.hidden = false;
  window.__filmError = error.message;
}

function advance(timestamp) {
  if (!playing || scrubbing) return;
  try {
    if (audioSeekTarget !== null && score && !score.paused && score.readyState >= 2) {
      if (score.seeking || score.currentTime < audioSeekTarget - 0.1) {
        animationFrame = requestAnimationFrame(advance);
        return;
      }
      audioSeekTarget = null;
      playbackOrigin = timestamp - currentTime * 1000;
    }
    const seconds = score && !score.paused && score.readyState >= 2 && !score.seeking ? score.currentTime : (timestamp - playbackOrigin) / 1000;
    renderAt(Math.max(currentTime, seconds));
    if (currentTime >= FILM_DURATION) setPlaying(false);
    else animationFrame = requestAnimationFrame(advance);
  } catch (error) {
    showError(error);
  }
}

playButton.addEventListener('click', () => {
  if (scrubbing) finishScrub(false);
  setPlaying(!playing);
});
document.querySelector('#film-replay').addEventListener('click', () => {
  finishScrub(false);
  setPlaying(false);
  renderAt(0);
  setPlaying(true);
});
function beginScrub() {
  if (scrubbing) return;
  resumeAfterScrub = playing;
  scrubbing = true;
  setPlaying(false);
}

function flushSeek() {
  cancelAnimationFrame(seekFrame);
  seekFrame = 0;
  if (pendingSeek === null) return;
  const destination = pendingSeek;
  pendingSeek = null;
  renderAt(destination);
}

function finishScrub(resume = true) {
  if (!scrubbing) return;
  flushSeek();
  scrubbing = false;
  slider.value = String(currentTime);
  const shouldResume = resume && resumeAfterScrub;
  resumeAfterScrub = false;
  if (shouldResume) setPlaying(true);
}

slider.addEventListener('pointerdown', beginScrub);
slider.addEventListener('input', () => {
  const destination = Number(slider.value);
  beginScrub();
  pendingSeek = destination;
  if (!seekFrame) seekFrame = requestAnimationFrame(flushSeek);
});
slider.addEventListener('change', () => finishScrub());
window.addEventListener('pointerup', () => finishScrub());
window.addEventListener('pointercancel', () => finishScrub(false));
window.addEventListener('blur', () => finishScrub(false));
slider.addEventListener('blur', () => finishScrub(false));
slider.addEventListener('keydown', event => {
  if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) beginScrub();
});
slider.addEventListener('keyup', () => finishScrub());
document.addEventListener('keydown', event => {
  if (event.code !== 'Space' || event.target.closest('input, button, a')) return;
  event.preventDefault();
  setPlaying(!playing);
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    finishScrub(false);
    setPlaying(false);
  }
});
window.addEventListener('resize', () => {
  if (!renderer || exporting) return;
  renderer.resize();
  renderAt(currentTime);
});
window.addEventListener('pagehide', () => {
  cancelAnimationFrame(seekFrame);
  seekFrame = 0;
  pendingSeek = null;
  scrubbing = false;
  setPlaying(false);
  renderer?.dispose();
  renderer = null;
  activeScene = null;
});

window.__filmReady = false;
window.renderAt = renderAt;
window.__film = {
  scenes,
  get renderer() { return renderer; },
  sampleFilm,
  renderAt,
  duration: FILM_DURATION,
  score,
  get playing() { return playing; },
  get scrubbing() { return scrubbing; },
  get currentTime() { return currentTime; },
  exporting,
  options: { width, height, samples, memoryBudgetMiB },
};
try {
  // Playback waits for a click for every motion preference, including reduced motion.
  renderAt(exporting ? 0 : 0.8);
  window.__filmReady = true;
} catch (error) {
  showError(error);
}
