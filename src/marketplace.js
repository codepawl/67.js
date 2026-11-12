import './site.css';
import './brand.js';
import './marketplace.css';

const NPM_SEARCH_URL = 'https://registry.npmjs.org/-/v1/search?text=keywords:67js-addon&size=50';
const NPM_MANIFEST_URL = 'https://registry.npmjs.org/';
const MAXIMUM_RANGE_LOOKUPS = 20;
const CONCURRENT_RANGE_LOOKUPS = 5;
const ADDONS_DOC_URL = 'https://github.com/codepawl/67.js/blob/main/docs/addons.md';
const KIND_LABELS = {
  assets: ['model', 'models'],
  images: ['image', 'images'],
  looks: ['look', 'looks'],
  environments: ['HDRI', 'HDRIs'],
  materials: ['material', 'materials'],
  recipes: ['recipe', 'recipes'],
};
const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
// One shape per state, so the state reads without the text: a ring, a magnifier, a warning triangle.
const STATE_ICONS = {
  loading: 'M12 3a9 9 0 1 0 9 9',
  empty: 'M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13Zm5 11.5L21 21M8 10.5h5',
  error: 'M12 3 2 20h20L12 3Zm0 6v5m0 3h.01',
};

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function icon(path, className = 'market-icon') {
  const svg = document.createElementNS(SVG_NAMESPACE, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', className);
  svg.setAttribute('aria-hidden', 'true');
  const shape = document.createElementNS(SVG_NAMESPACE, 'path');
  shape.setAttribute('d', path);
  svg.append(shape);
  return svg;
}

function link(text, href, className) {
  const anchor = element('a', className, text);
  anchor.href = href;
  return anchor;
}

function showState(container, state, message, ...links) {
  const notice = element('p', `market-state market-state-${state}`);
  notice.setAttribute('role', state === 'error' ? 'alert' : 'status');
  notice.append(icon(STATE_ICONS[state]), element('span', '', message), ...links);
  container.replaceChildren(notice);
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function countLabel(kind, count) {
  const [singular, plural] = KIND_LABELS[kind] ?? [kind, kind];
  return `${count} ${count === 1 ? singular : plural}`;
}

async function copyText(button, text) {
  const label = button.textContent;
  try {
    await navigator.clipboard.writeText(text);
    button.textContent = 'Copied';
  } catch {
    button.textContent = 'Copy failed';
  }
  setTimeout(() => { button.textContent = label; }, 1800);
}

function copyButton(text, label = 'Copy') {
  const button = element('button', 'market-copy', label);
  button.type = 'button';
  button.addEventListener('click', () => copyText(button, text));
  return button;
}

function packCard(pack) {
  const card = element('article', 'market-card pack-card');
  if (pack.preview) {
    const preview = element('img', 'pack-preview');
    preview.src = pack.preview;
    preview.alt = `Preview of ${pack.name}`;
    preview.loading = 'lazy';
    card.append(preview);
  } else {
    const placeholder = element('div', 'pack-preview pack-preview-empty');
    placeholder.append(icon('M3 7 12 2l9 5v10l-9 5-9-5V7Zm0 0 9 5 9-5M12 12v10'));
    card.append(placeholder);
  }
  const body = element('div', 'pack-body');
  const title = element('h3', '', pack.name);
  title.append(element('span', 'market-version', pack.version));
  const facts = element('ul', 'market-facts');
  const factTexts = [...Object.entries(pack.items).map(([kind, count]) => countLabel(kind, count)), pack.license, `67js ${pack.engines}`, formatBytes(pack.bytes), `by ${pack.author}`];
  for (const text of factTexts) facts.append(element('li', '', text));
  const download = link('Download', pack.zip, 'market-button');
  download.setAttribute('download', '');
  download.prepend(icon('M12 3v12m-5-5 5 5 5-5M4 17v4h16v-4', 'market-icon market-button-icon'));
  const checksum = element('div', 'pack-checksum');
  checksum.append(element('span', '', 'SHA-256'), element('code', '', pack.sha256), copyButton(pack.sha256));
  const actions = element('div', 'pack-actions');
  actions.append(download, checksum);
  body.append(title, element('p', 'market-description', pack.description), facts, actions);
  card.append(body);
  return card;
}

async function loadPacks(container) {
  showState(container, 'loading', 'Loading packs');
  try {
    const response = await fetch('/packs/index.json');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const { packs } = await response.json();
    if (!Array.isArray(packs) || packs.length === 0) {
      showState(container, 'empty', 'No packs are published yet.', link('How to make one', 'https://github.com/codepawl/67.js/blob/main/docs/packs.md'));
      return;
    }
    container.replaceChildren(...packs.map(packCard));
  } catch {
    showState(container, 'error', 'The pack list did not load. Reload the page to try again.');
  }
}

function npmUrl(name) {
  return `https://www.npmjs.com/package/${name}`;
}

function addonCard(addon) {
  const card = element('article', 'market-card addon-card');
  card.dataset.addon = addon.name;
  const title = element('h3');
  title.append(link(addon.name, npmUrl(addon.name)), element('span', 'market-version', addon.version));
  const body = element('div', 'addon-body');
  body.append(title);
  if (addon.description) body.append(element('p', 'market-description', addon.description));
  const facts = element('ul', 'market-facts');
  facts.append(element('li', '', addon.range ? `67js ${addon.range}` : 'Range not stated'));
  body.append(facts);
  const npm = link('npm', npmUrl(addon.name), 'market-button market-button-quiet');
  const logo = element('span', 'package-logo package-logo-npm');
  logo.setAttribute('aria-hidden', 'true');
  npm.prepend(logo);
  npm.setAttribute('aria-label', `${addon.name} on npm`);
  card.append(body, npm);
  return card;
}

async function fetchLatestRange(name) {
  try {
    const response = await fetch(`${NPM_MANIFEST_URL}${name.replace('/', '%2F')}/latest`);
    if (!response.ok) return null;
    const manifest = await response.json();
    return typeof manifest['67js']?.range === 'string' ? manifest['67js'].range : null;
  } catch {
    return null;
  }
}

// The search result carries no `67js` field, so the latest manifest of each listed package is read, a few at a time.
async function fillRanges(addons, container) {
  const queue = addons.slice(0, MAXIMUM_RANGE_LOOKUPS);
  const workers = Array.from({ length: Math.min(CONCURRENT_RANGE_LOOKUPS, queue.length) }, async () => {
    while (queue.length > 0) {
      const addon = queue.shift();
      addon.range = await fetchLatestRange(addon.name);
      const row = container.querySelector(`[data-addon="${CSS.escape(addon.name)}"]`);
      if (row) row.replaceWith(addonCard(addon));
    }
  });
  await Promise.all(workers);
}

async function loadAddons(container) {
  showState(container, 'loading', 'Searching npm for addons');
  try {
    const response = await fetch(NPM_SEARCH_URL);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const { objects } = await response.json();
    const addons = (objects ?? []).map(({ package: entry }) => ({ name: entry.name, version: entry.version, description: entry.description ?? '', range: null }));
    if (addons.length === 0) {
      showState(container, 'empty', 'No addons are published yet.', link('Write the first one', ADDONS_DOC_URL));
      return;
    }
    container.replaceChildren(...addons.map(addonCard));
    await fillRanges(addons, container);
  } catch {
    showState(container, 'error', 'npm did not answer, so the addon list is missing. Search npm for 67js-addon instead.', link('Open the npm search', 'https://www.npmjs.com/search?q=keywords%3A67js-addon'));
  }
}

document.querySelectorAll('[data-copy]').forEach(button => {
  button.addEventListener('click', () => copyText(button, button.dataset.copy));
});
loadPacks(document.querySelector('#pack-list'));
loadAddons(document.querySelector('#addon-list'));
