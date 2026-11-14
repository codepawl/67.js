import './site.css';
import './brand.js';
import './site-motion.js';
import { highlightElement } from './code-highlight.js';

const copyControls = [];
const packageControls = [];
const controls = document.querySelector('[data-copy-install]') ? await import('./site-controls.js') : null;

const state = { status: 'loading', release: null, packageManager: 'npm' };
const packageCommands = { npm: 'npm install', pnpm: 'pnpm add', yarn: 'yarn add', bun: 'bun add' };

function installCommand() {
  if (!state.release) return '';
  return state.release.installCommand.replace(/^npm install/, packageCommands[state.packageManager]);
}

function setText(selector, text) {
  document.querySelectorAll(selector).forEach(element => { element.textContent = text; });
}

function releaseURL(value) {
  const url = new URL(value, location.href);
  if (url.origin !== location.origin || !['https:', 'http:'].includes(url.protocol)) {
    throw new Error('Release files must use the current site.');
  }
  return url.href;
}

function validateRelease(release) {
  for (const key of ['version', 'packageName', 'commit', 'installCommand', 'tarball', 'module', 'api']) {
    if (typeof release[key] !== 'string' || !release[key].trim()) throw new Error(`Missing release field: ${key}`);
  }
  if (typeof release.registryPublished !== 'boolean') throw new Error('Missing publication status.');
  if (!/^[a-f0-9]{7,40}$/i.test(release.commit)) throw new Error('Invalid release commit.');
  releaseURL(release.tarball);
  releaseURL(release.module);
  releaseURL(release.api);
  return release;
}

function setLink(selector, url, download = false) {
  document.querySelectorAll(selector).forEach(link => {
    if (url) {
      link.href = url;
      link.removeAttribute('aria-disabled');
      if (download) link.setAttribute('download', '');
    } else {
      link.removeAttribute('href');
      link.setAttribute('aria-disabled', 'true');
    }
  });
}

function renderRelease() {
  const release = state.release;
  copyControls.forEach(control => control.update({ disabled:!release }));
  document.querySelectorAll('[data-release-retry]').forEach(button => { button.hidden = state.status !== 'error'; });
  document.querySelectorAll('[data-release-status]').forEach(element => { element.dataset.status = state.status; });
  setText('[data-release-version]', release ? `v${release.version}` : state.status === 'error' ? 'Release unavailable' : 'Loading release');
  setText('[data-install-command]', release ? installCommand() : state.status === 'error' ? 'Release information is unavailable' : 'Loading the release command…');
  if (release) document.querySelectorAll('[data-install-command]').forEach(element => highlightElement(element, 'shell'));
  packageControls.forEach(({ name, control }) => control.update({ 'aria-pressed':String(name === state.packageManager) }));
  document.querySelectorAll('.release-feedback').forEach(element => { element.hidden = state.status !== 'error'; });
  setText('[data-release-status]', state.status === 'error' ? 'Release information could not load. Retry to get the current files.' : '');
  setLink('[data-release-tarball]', release ? releaseURL(release.tarball) : null, true);
  setLink('[data-release-module]', release ? releaseURL(release.module) : null, true);
  setLink('[data-release-api]', release ? releaseURL(release.api) : null);
  setLink('[data-release-commit]', release ? `https://github.com/codepawl/crucible/commit/${release.commit}` : null);
  setText('[data-release-commit]', release ? `Commit ${release.commit.slice(0, 7)}` : 'Release commit');
}

async function loadRelease() {
  state.status = 'loading';
  state.release = null;
  renderRelease();
  try {
    const response = await fetch('./release.json', { cache: 'no-store', headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`Release endpoint returned ${response.status}.`);
    state.release = validateRelease(await response.json());
    state.status = 'ready';
  } catch {
    state.status = 'error';
  }
  renderRelease();
}

function selectCommand() {
  const element = document.querySelector('[data-install-command]');
  const range = document.createRange();
  range.selectNodeContents(element);
  const selection = getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}

document.querySelectorAll('[data-copy-install]').forEach(button => {
  const control = controls.mountButton(button, { icon:'copy', onClick:async () => {
    if (!state.release) return;
    try {
      await navigator.clipboard.writeText(installCommand());
      control.update({ label:'Copied', icon:'check' });
      setTimeout(() => { control.update({ label:'Copy command', icon:'copy' }); }, 2000);
    } catch {
      selectCommand();
      document.querySelectorAll('.release-feedback').forEach(element => { element.hidden = false; });
      setText('[data-release-status]', 'Clipboard unavailable. Copy the selected command.');
    }
  } });
  copyControls.push(control);
});
document.querySelectorAll('[data-release-retry]').forEach(button => {
  controls.mountButton(button, { hidden:button.hidden, onClick:loadRelease });
});

document.querySelectorAll('[data-package-manager]').forEach(button => {
  const name = button.dataset.packageManager;
  const control = controls.mountButton(button, { icon:controls.packageLogo(name), onClick:() => {
    state.packageManager = name;
    renderRelease();
    if (!matchMedia('(prefers-reduced-motion: reduce)').matches) document.querySelector('[data-install-command]').animate([{ opacity:0.4 }, { opacity:1 }], { duration:170 });
  } });
  packageControls.push({ name, control });
});

function mountCodeCopyButton(button) {
  const source = document.getElementById(button.dataset.copyCode);
  const control = controls.mountButton(button, { icon:'copy', onClick:async () => {
    try {
      await navigator.clipboard.writeText(source.textContent);
      control.update({ label:'Copied', icon:'check' });
      setTimeout(() => { control.update({ label:'Copy', icon:'copy' }); }, 2000);
    } catch {
      getSelection().selectAllChildren(source);
    }
  } });
}

document.querySelectorAll('[data-copy-code]').forEach(mountCodeCopyButton);
document.querySelectorAll('code[data-language]').forEach(element => highlightElement(element, element.dataset.language));

document.querySelectorAll('.example img').forEach(image => {
  image.addEventListener('error', () => {
    image.alt = `${image.alt}. Preview unavailable. Open the example to explore it`;
  }, { once: true });
});
window.__home = { state, loadRelease };
loadRelease();
window.addEventListener('pageshow', event => { if (event.persisted) loadRelease(); });
