// Shared helpers for the home-hero prototypes: the poster-to-canvas load path, a render loop that
// pauses when the page is hidden or the hero is off screen, damping, and the numbers the measurement script reads.

export const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// Frame-rate independent smoothing. A new target at any time only changes where the value is heading, so it stays interruptible.
export function damp(current, target, rate, seconds) {
  return target + (current - target) * Math.exp(-rate * seconds);
}

export function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

export function smoothstep(edgeStart, edgeEnd, value) {
  const amount = clamp((value - edgeStart) / (edgeEnd - edgeStart), 0, 1);
  return amount * amount * (3 - 2 * amount);
}

export function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((first, second) => first - second);
  return sorted[Math.floor(sorted.length / 2)];
}

// window.__hero is read by the measurement script: when the first live frame was submitted and how long frames took after that.
export const metrics = window.__hero = {
  firstLiveFrameMs: null,
  frameIntervals: [],
  renderMilliseconds: [],
  bytesNote: 'transfer size comes from the network log, not from the page',
  error: null,
};

const WARNING_ICON = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M12 3 2.5 20h19L12 3Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M12 10v4.5M12 17.2v.1" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';

// The poster is a still of the opening frame. The live canvas sits under it, draws once, then the poster fades out.
export function revealLiveCanvas(stage) {
  if (stage.dataset.live === 'true') return;
  metrics.firstLiveFrameMs = Math.round(performance.now());
  requestAnimationFrame(() => { stage.dataset.live = 'true'; });
}

export function showStageError(stage, message) {
  metrics.error = message;
  const notice = document.createElement('p');
  notice.className = 'stage-status';
  notice.setAttribute('role', 'status');
  notice.innerHTML = `${WARNING_ICON}<span></span>`;
  notice.querySelector('span').textContent = message;
  stage.append(notice);
}

// Calls draw(seconds, now) on every animation frame while the stage is visible and the tab is shown.
// draw returns false when nothing moved and the loop may rest until wake() is called.
export function startLoop(stage, draw) {
  let frameRequest = 0;
  let lastTimestamp = 0;
  let visible = true;
  let firstDrawn = false;

  const step = timestamp => {
    frameRequest = 0;
    if (document.hidden || !visible) {
      lastTimestamp = 0;
      return;
    }
    const seconds = lastTimestamp ? Math.min((timestamp - lastTimestamp) / 1000, 0.05) : 0.016;
    if (lastTimestamp && firstDrawn) metrics.frameIntervals.push(timestamp - lastTimestamp);
    lastTimestamp = timestamp;
    const started = performance.now();
    const keepGoing = draw(seconds, timestamp) !== false;
    if (firstDrawn) metrics.renderMilliseconds.push(performance.now() - started);
    if (!firstDrawn) {
      firstDrawn = true;
      revealLiveCanvas(stage);
    }
    if (keepGoing) wake();
    else lastTimestamp = 0;
  };

  function wake() {
    if (!frameRequest && visible && !document.hidden) frameRequest = requestAnimationFrame(step);
  }

  new IntersectionObserver(entries => {
    visible = entries[0].isIntersecting;
    wake();
  }).observe(stage);
  document.addEventListener('visibilitychange', wake);
  wake();
  return { wake };
}
