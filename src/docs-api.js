// The API reference: every export of `67js` and its addons, from /api-reference.json, which `npm run build` makes with
// scripts/api-reference.mjs. In development, run that script once.
import { highlightCode } from './code-highlight.js';

const sourceBase = 'https://github.com/codepawl/67.js/blob/main/';

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
}

function entryElement(module, entry) {
  const element = document.createElement('div');
  element.className = 'api-entry';
  element.id = `api-${module.replace(/\W+/g, '-')}-${entry.name}`;
  element.dataset.search = `${module} ${entry.name} ${entry.summary}`.toLowerCase();
  const [file, line] = entry.source.split(':');
  const summary = entry.summary ? `<p>${escapeHtml(entry.summary).replace(/`([^`]+)`/g, '<code>$1</code>')}</p>` : '';
  element.innerHTML = `
    <div class="api-entry-heading"><h4>${escapeHtml(entry.name)}</h4><span class="api-kind">${entry.kind}</span><a class="api-source" href="${sourceBase}${file}${line ? `#L${line}` : ''}" rel="noopener">Source</a></div>
    <pre><code class="hljs language-javascript">${highlightCode(entry.signature, 'javascript')}</code></pre>
    ${summary}`;
  return element;
}

function moduleElement(module) {
  const element = document.createElement('section');
  element.className = 'api-module';
  element.dataset.module = module.module;
  const heading = document.createElement('h3');
  heading.id = `api-${module.module.replace(/\W+/g, '-')}`;
  heading.innerHTML = `<code>${escapeHtml(module.module)}</code><span>${module.exports.length}</span>`;
  element.append(heading);
  const importLine = document.createElement('p');
  importLine.className = 'api-import';
  const example = module.exports.find(entry => entry.kind !== 'constant') ?? module.exports[0];
  importLine.innerHTML = example
    ? `<code>import { ${escapeHtml(example.name)} } from '${escapeHtml(module.module)}';</code>`
    : `<code>import '${escapeHtml(module.module)}';</code> Importing it registers shader code. It has no exports.`;
  element.append(importLine);
  for (const entry of module.exports) element.append(entryElement(module.module, entry));
  return element;
}

/** Render the reference with a filter box. The data loads on first use, so other pages do not download it. */
export function createApiReference() {
  const container = document.createElement('div');
  container.className = 'api-reference';
  container.innerHTML = `
    <label class="api-filter"><span>Filter exports</span><input type="search" placeholder="Name or word, such as camera or gltf" autocomplete="off"></label>
    <p class="api-count" role="status" aria-live="polite">Loading the reference…</p>
    <div class="api-modules"></div>`;
  const input = container.querySelector('input');
  const count = container.querySelector('.api-count');
  const list = container.querySelector('.api-modules');
  fetch('/api-reference.json').then(response => {
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }).then(reference => {
    const core = reference.modules.filter(module => module.module === '67js');
    const addons = reference.modules.filter(module => module.module !== '67js');
    for (const [title, modules] of [['Core', core], ['Addons', addons]]) {
      const heading = document.createElement('h2');
      heading.id = title.toLowerCase();
      heading.dataset.outline = title;
      heading.textContent = title;
      list.append(heading, ...modules.map(moduleElement));
    }
    const total = reference.modules.reduce((sum, module) => sum + module.exports.length, 0);
    function filter() {
      const words = input.value.toLowerCase().trim().split(/\s+/).filter(Boolean);
      let shown = 0;
      for (const module of list.querySelectorAll('.api-module')) {
        let moduleShown = 0;
        for (const entry of module.querySelectorAll('.api-entry')) {
          const match = words.every(word => entry.dataset.search.includes(word));
          entry.hidden = !match;
          if (match) moduleShown++;
        }
        module.hidden = moduleShown === 0 && words.length > 0;
        shown += moduleShown;
      }
      count.textContent = words.length ? `${shown} of ${total} exports match.` : `${total} exports in ${reference.modules.length} modules.`;
    }
    input.addEventListener('input', filter);
    filter();
    container.dispatchEvent(new CustomEvent('api-ready', { bubbles: true }));
  }).catch(() => {
    count.textContent = '⚠ The reference did not load. Reload the page to try again.';
  });
  return container;
}
