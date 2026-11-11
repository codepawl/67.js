// The light path of the home hero shows the poster and a "Play live 3D" button; pressing it loads the 3D. This is the press handler,
// with its page-specific parts passed in so it can run without a browser:
//   playButton   the button element (disabled with a loading mark while the world loads)
//   beginLive    starts the loop; rejects when the world cannot be fetched or built, and may be called again to retry
//   showError    shows a message on the stage
//   focusTarget  element that takes focus once the button is gone, so keyboard and screen reader users keep their place
//   onLive       called after the poster has had time to fade out, to switch the page to its live layout
export const PLAY_HANDOFF_MS = 800;
const PLAY_LABEL = 'Play live 3D';
const LOADING_LABEL = 'Loading 3D';

export function createPlayOnDemand({ playButton, beginLive, showError, focusTarget, onLive, wait = setTimeout }) {
  const label = playButton.querySelector('.play-label');

  function showLoading() {
    playButton.disabled = true;
    playButton.dataset.state = 'loading';
    label.textContent = LOADING_LABEL;
  }

  function showReady() {
    playButton.disabled = false;
    delete playButton.dataset.state;
    label.textContent = PLAY_LABEL;
  }

  return async function playOnDemand() {
    showLoading();
    try {
      await beginLive();
    } catch (error) {
      showError(`Live view unavailable: ${error.message}`);
      showReady();
      return false;
    }
    playButton.hidden = true;
    focusTarget?.focus({ preventScroll: true });
    wait(onLive, PLAY_HANDOFF_MS);
    return true;
  };
}
