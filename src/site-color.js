// Light or dark on the branded pages. The system preference decides until the visitor presses the header button; the
// choice is kept in localStorage and set on <html data-color> by the inline script in each page head, so the first paint
// already has it. Storage can throw (private windows, blocked site data); the page still works without it.
const STORAGE_KEY = 'crucible-color';
const darkQuery = matchMedia('(prefers-color-scheme: dark)');
const iconPaths = {
  dark: 'M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z',
  light: 'M12 4V2m0 20v-2m8-8h2M2 12h2m13.66-5.66 1.41-1.41M4.93 19.07l1.41-1.41m0-11.32L4.93 4.93m14.14 14.14-1.41-1.41M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z',
};

function currentColor() {
  const chosen = document.documentElement.dataset.color;
  if (chosen === 'light' || chosen === 'dark') return chosen;
  return darkQuery.matches ? 'dark' : 'light';
}

function rememberColor(color) {
  try {
    localStorage.setItem(STORAGE_KEY, color);
  } catch {
    // The choice lasts for this page view only.
  }
}

function drawButton(button) {
  const next = currentColor() === 'dark' ? 'light' : 'dark';
  const label = next === 'dark' ? 'Switch to dark' : 'Switch to light';
  button.setAttribute('aria-label', label);
  button.title = label;
  button.querySelector('path').setAttribute('d', iconPaths[next]);
}

export function addColorToggle(navigation) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'color-toggle';
  button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path/></svg>';
  button.addEventListener('click', () => {
    const next = currentColor() === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.color = next;
    rememberColor(next);
    drawButton(button);
  });
  darkQuery.addEventListener('change', () => drawButton(button));
  drawButton(button);
  navigation.querySelector('.site-nav-cta')?.before(button);
}
