import './home.js';
import './documentation.css';
import guide from '../docs/guide.md?raw';
import { highlightCode } from './code-highlight.js';
import { createLiveExample, autoRunVisibleExamples } from './docs-live.js';
import { createApiReference } from './docs-api.js';
import { topicAliases, topicSlug, guideTopics, learnTopics, orderTopics } from './documentation-topics.js';

const learnSources = import.meta.glob('../docs/learn/*.md', { query: '?raw', import: 'default', eager: true });

const article = document.querySelector('#doc-article');
const topicNavigation = document.querySelector('#doc-toc');
const pageOutline = document.querySelector('#doc-outline');
const search = document.querySelector('#doc-search');
const results = document.querySelector('#doc-results');
const topicMenu = document.querySelector('#doc-topic-menu');
const copyPage = document.querySelector('#copy-doc-page');
const copyStatus = document.querySelector('#doc-copy-status');
const desktopTopics = matchMedia('(min-width: 1051px)');
topicMenu.open = desktopTopics.matches;
desktopTopics.addEventListener('change', () => { topicMenu.open = desktopTopics.matches; });

const iconPaths = {
  start: '<path d="m9 5 10 7-10 7V5Z"/>',
  cube: '<path d="m12 3 9 5v8l-9 5-9-5V8l9-5Z M3 8l9 5 9-5 M12 13v8"/>',
  world: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18"/>',
  motion: '<path d="M5 5h14v14H5z M9 9l6 3-6 3V9Z"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="m3 16 5-5 4 4 3-3 6 6"/><circle cx="16" cy="8" r="1"/>',
  book: '<path d="M12 6c-3-2-6-2-9-1v14c3-1 6-1 9 1 3-2 6-2 9-1V5c-3-1-6-1-9 1Zm0 0v14"/>',
  copy: '<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M15 8V3H3v12h5"/>',
  arrow: '<path d="M5 12h14m-6-6 6 6-6 6"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
  tip: '<path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3Z"/>',
  note: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.01"/>',
  warning: '<path d="M12 3 2 21h20L12 3Zm0 7v5m0 3v.01"/>',
  check: '<path d="m5 12 5 5 9-10"/>',
  terminal: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="m7 9 3 3-3 3M13 15h4"/>',
};

function icon(name) {
  return `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true">${iconPaths[name]}</svg>`;
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
}

function inlineText(value) {
  return escapeHtml(value)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (match, label, href) => {
      const external = /^https?:/.test(href) && new URL(href, 'https://crucible.codepawl.com').origin !== 'https://crucible.codepawl.com';
      return `<a href="${href}"${external ? ' rel="noopener"' : ''}>${label}</a>`;
    });
}

// Code spans are cut out first, so `**` or `[x](y)` inside code stays literal.
function inline(value) {
  return value.split(/(`[^`]+`)/g).map(piece => piece.startsWith('`') && piece.endsWith('`') && piece.length > 1
    ? `<code>${escapeHtml(piece.slice(1, -1))}</code>`
    : inlineText(piece)).join('');
}

const { groups, topics } = orderTopics([...guideTopics(guide), ...learnTopics(learnSources)].filter(topic => !(topic.id in topicAliases)));
let currentTopic;
let exampleStarter;

async function copyText(button, text, code) {
  try {
    await navigator.clipboard.writeText(text);
    button.innerHTML = `${icon('check')}${code ? 'Copied' : 'Page copied'}`;
    copyStatus.textContent = `✓ ${code ? 'Code' : 'Page Markdown'} copied to clipboard.`;
  } catch {
    if (code) {
      const range = document.createRange();
      range.selectNodeContents(code);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      copyStatus.textContent = '⚠ Clipboard unavailable. Copy the selected code.';
    } else {
      const source = document.createElement('textarea');
      source.className = 'doc-copy-fallback';
      source.readOnly = true;
      source.setAttribute('aria-label', 'Page Markdown. Select and copy this text.');
      source.value = text;
      document.querySelector('.doc-copy-fallback')?.remove();
      copyStatus.after(source);
      source.focus();
      source.select();
      copyStatus.textContent = '⚠ Clipboard unavailable. Copy the selected Markdown below.';
    }
  }
  setTimeout(() => {
    button.innerHTML = `${icon('copy')}${code ? 'Copy code' : 'Copy page'}`;
  }, 2000);
}

const languages = { js: 'javascript', javascript: 'javascript', html: 'xml', xml: 'xml', sh: 'bash', bash: 'bash' };
const languageLabels = { javascript: 'JavaScript', xml: 'HTML', bash: 'Shell' };

function fenceInfo(block) {
  const [language = '', ...flags] = block.match(/^```([^\n]*)/)[1].trim().split(/\s+/);
  const options = {};
  for (const flag of flags) {
    const [key, value = true] = flag.split('=');
    options[key] = value;
  }
  return { language, options, source: block.replace(/^```[^\n]*\n/, '').replace(/```\s*$/, '').trimEnd() };
}

function codeBlock({ language: sourceLanguage, options, source }, title) {
  const language = languages[sourceLanguage];
  const label = options.file ?? (sourceLanguage === 'text' ? 'Output' : languageLabels[language] ?? (sourceLanguage || 'Plain text'));
  const container = document.createElement('div');
  container.className = sourceLanguage === 'text' ? 'code-block code-output' : 'code-block';
  const header = document.createElement('div');
  header.className = 'code-header';
  const languageLabel = document.createElement('span');
  languageLabel.className = 'code-language';
  languageLabel.innerHTML = sourceLanguage === 'text' ? `${icon('terminal')}${escapeHtml(label)}` : escapeHtml(label);
  header.append(languageLabel);
  const pre = document.createElement('pre');
  const code = document.createElement('code');
  code.className = language ? `hljs language-${language}` : 'hljs';
  code.innerHTML = language ? highlightCode(source, language) : escapeHtml(source);
  if (sourceLanguage !== 'text') {
    const button = document.createElement('button');
    button.className = 'copy-code';
    button.innerHTML = `${icon('copy')}Copy code`;
    button.setAttribute('aria-label', `Copy ${label} code from ${title}`);
    button.addEventListener('click', () => copyText(button, source, code));
    header.append(button);
  }
  pre.append(code);
  container.append(header, pre);
  return container;
}

// `npm install x` becomes one tab per package manager, the same choice the homepage offers.
const packageManagers = [
  { name: 'npm', command: command => command },
  { name: 'pnpm', command: command => command.replace(/^npm install/, 'pnpm add').replace(/^npm create/, 'pnpm create').replace(/^npm run /, 'pnpm ') },
  { name: 'yarn', command: command => command.replace(/^npm install/, 'yarn add').replace(/^npm create/, 'yarn create').replace(/ -- /, ' ').replace(/^npm run /, 'yarn ') },
  { name: 'bun', command: command => command.replace(/^npm install/, 'bun add').replace(/^npm create/, 'bun create').replace(/ -- /, ' ').replace(/^npm run /, 'bun run ') },
];
let chosenPackageManager = 'npm';
try { chosenPackageManager = localStorage.getItem('docs-package-manager') ?? 'npm'; } catch { /* Storage can be blocked. */ }

function installBlock(info, title) {
  const container = document.createElement('div');
  container.className = 'install-block';
  const tabs = document.createElement('div');
  tabs.className = 'install-tabs';
  tabs.setAttribute('role', 'group');
  tabs.setAttribute('aria-label', 'Package manager');
  const holder = document.createElement('div');
  function show(name) {
    const manager = packageManagers.find(entry => entry.name === name) ?? packageManagers[0];
    const source = info.source.split('\n').map(line => manager.command(line)).join('\n');
    holder.replaceChildren(codeBlock({ language: 'sh', options: {}, source }, title));
    for (const button of tabs.children) button.setAttribute('aria-pressed', String(button.dataset.manager === manager.name));
  }
  for (const manager of packageManagers) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.manager = manager.name;
    button.innerHTML = `<span class="package-logo package-logo-${manager.name}" aria-hidden="true"></span>${manager.name}`;
    button.addEventListener('click', () => {
      chosenPackageManager = manager.name;
      try { localStorage.setItem('docs-package-manager', manager.name); } catch { /* Storage can be blocked. */ }
      for (const block of document.querySelectorAll('.install-block')) block.showManager(manager.name);
    });
    tabs.append(button);
  }
  container.showManager = show;
  container.append(tabs, holder);
  show(chosenPackageManager);
  return container;
}

// A card list: one card per line, `Title | link | description | optional picture`.
function cardList(info) {
  const list = document.createElement('div');
  list.className = 'doc-cards';
  for (const line of info.source.split('\n').filter(Boolean)) {
    const [title, href, description = '', picture] = line.split('|').map(part => part.trim());
    const card = document.createElement('a');
    card.className = picture ? 'doc-card has-picture' : 'doc-card';
    card.href = href;
    card.innerHTML = `${picture ? `<img src="${escapeHtml(picture)}" alt="" loading="lazy" decoding="async">` : ''}<strong>${inline(title)} ${icon('arrow')}</strong><span>${inline(description)}</span>`;
    list.append(card);
  }
  return list;
}

function webglCheck() {
  const probe = document.createElement('canvas').getContext('webgl2');
  probe?.getExtension('WEBGL_lose_context')?.loseContext();
  const element = document.createElement('p');
  element.className = probe ? 'doc-check doc-check-ok' : 'doc-check doc-check-failed';
  element.setAttribute('role', 'status');
  element.innerHTML = probe
    ? `${icon('check')}<span>This browser supports WebGL2.</span>`
    : `${icon('warning')}<span>This browser has no WebGL2. Turn on hardware acceleration in its settings, or use a current Chrome, Edge, Firefox or Safari.</span>`;
  return element;
}

function renderFence(block, section) {
  const info = fenceInfo(block);
  if (info.options.live) {
    section.append(createLiveExample({ source: info.source, title: currentTopic.title, poster: info.options.poster, file: info.options.file }));
  } else if (info.options.install) {
    section.append(installBlock(info, currentTopic.title));
  } else if (info.language === 'cards') {
    section.append(cardList(info));
  } else if (info.language === 'api') {
    section.append(createApiReference());
  } else if (info.language === 'check') {
    section.append(webglCheck());
  } else {
    section.append(codeBlock(info, currentTopic.title));
  }
}

function figure(paragraph) {
  const match = paragraph.match(/^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)$/);
  const [, alt, source, caption] = match;
  const element = document.createElement('figure');
  element.className = 'doc-figure';
  if (/\.(webm|mp4)$/.test(source)) {
    const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
    element.innerHTML = `<video src="${source}" ${still ? 'controls' : 'autoplay loop'} muted playsinline preload="metadata" aria-label="${escapeHtml(alt)}"></video>`;
  } else {
    element.innerHTML = `<img src="${source}" alt="${escapeHtml(alt)}" loading="lazy" decoding="async">`;
  }
  if (caption) element.insertAdjacentHTML('beforeend', `<figcaption>${inline(caption)}</figcaption>`);
  return element;
}

// `> **Tip:** text` becomes a callout that leads with its own icon.
function callout(paragraph) {
  const text = paragraph.split('\n').map(line => line.replace(/^>\s?/, '')).join(' ');
  const kind = text.match(/^\*\*(Tip|Note|Warning):\*\*/)?.[1]?.toLowerCase() ?? 'note';
  const element = document.createElement('aside');
  element.className = `doc-callout doc-callout-${kind}`;
  element.innerHTML = `${icon(kind)}<p>${inline(text)}</p>`;
  return element;
}

function list(paragraph, ordered) {
  const element = document.createElement(ordered ? 'ol' : 'ul');
  const items = paragraph.split(/\n(?=\d+\.\s|[-*]\s)/);
  for (const line of items) {
    const item = document.createElement('li');
    item.innerHTML = inline(line.replace(/^(\d+\.|[-*])\s/, '').replace(/\n\s*/g, ' '));
    element.append(item);
  }
  return element;
}

function heading(paragraph) {
  const [, hashes, text] = paragraph.match(/^(#{2,4})\s+(.+)$/);
  const level = hashes.length;
  const element = document.createElement(`h${level}`);
  const step = level === 2 && text.match(/^(\d+)\.\s+(.+)$/);
  element.id = topicSlug(step ? step[2] : text);
  if (step) {
    element.className = 'doc-step';
    element.innerHTML = `<span class="doc-step-number" aria-hidden="true">${step[1]}</span><span>${inline(step[2])}</span>`;
    element.dataset.outline = step[2];
  } else {
    element.innerHTML = inline(text);
    element.dataset.outline = text;
  }
  return element;
}

function renderParagraph(paragraph, section) {
  if (/^#{2,4}\s/.test(paragraph) && !paragraph.includes('\n')) {
    section.append(heading(paragraph));
  } else if (paragraph.startsWith('|')) {
    const table = document.createElement('table');
    const rows = paragraph.split('\n').filter(row => !/^\|[\s:|-]+\|$/.test(row));
    table.innerHTML = rows.map((row, rowIndex) => `<tr>${row.split('|').slice(1, -1).map(cell => `<${rowIndex ? 'td' : 'th'}>${inline(cell.trim())}</${rowIndex ? 'td' : 'th'}>`).join('')}</tr>`).join('');
    const scroll = document.createElement('div');
    scroll.className = 'table-scroll';
    scroll.append(table);
    section.append(scroll);
  } else if (/^!\[[^\]]*\]\([^)]+\)$/.test(paragraph)) {
    section.append(figure(paragraph));
  } else if (paragraph.startsWith('>')) {
    section.append(callout(paragraph));
  } else if (/^\d+\.\s/.test(paragraph)) {
    section.append(list(paragraph, true));
  } else if (/^[-*]\s/.test(paragraph)) {
    section.append(list(paragraph, false));
  } else {
    const element = document.createElement('p');
    element.innerHTML = inline(paragraph.replace(/\n/g, ' '));
    section.append(element);
  }
}

function renderNavigation() {
  const words = search.value.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const matching = topics.filter(topic => words.every(word => topic.raw.toLowerCase().includes(word) || topic.title.toLowerCase().includes(word)));
  topicNavigation.replaceChildren();
  for (const group of groups) {
    const members = matching.filter(topic => group.ids.includes(topic.id));
    if (!members.length) continue;
    const region = document.createElement('div');
    region.className = 'doc-topic-group';
    const groupHeading = document.createElement('h2');
    groupHeading.innerHTML = `${icon(group.icon)}${escapeHtml(group.title)}`;
    region.append(groupHeading);
    for (const topic of members) {
      const link = document.createElement('a');
      link.href = `#${topic.id}`;
      link.textContent = topic.title;
      if (topic === currentTopic) link.setAttribute('aria-current', 'page');
      link.addEventListener('click', () => {
        if (!desktopTopics.matches) topicMenu.open = false;
        if (location.hash === link.hash) article.focus();
      });
      region.append(link);
    }
    topicNavigation.append(region);
  }
  results.textContent = words.length ? matching.length ? `${matching.length} ${matching.length === 1 ? 'topic' : 'topics'} found` : '⌕ No matching topics. Try camera, memory, or agents.' : '';
}

function renderOutline(section) {
  const headings = [...section.querySelectorAll('h2[id]')];
  pageOutline.replaceChildren();
  pageOutline.hidden = headings.length < 2;
  if (pageOutline.hidden) return;
  const title = document.createElement('h2');
  title.textContent = 'On this page';
  pageOutline.append(title);
  for (const element of headings) {
    const link = document.createElement('a');
    link.href = `#${currentTopic.id}/${element.id}`;
    link.textContent = element.dataset.outline.replace(/`/g, '');
    if (element.classList.contains('doc-step')) link.prepend(`${element.querySelector('.doc-step-number').textContent}. `);
    pageOutline.append(link);
  }
}

function parseHash() {
  const [requestedTopic = '', requestedSection = ''] = decodeURIComponent(location.hash.slice(1)).split('/');
  return { hashTopic: requestedTopic, requestedTopic: topicAliases[requestedTopic] ?? requestedTopic, requestedSection };
}

function stopExamples() {
  exampleStarter?.disconnect();
  for (const example of article.querySelectorAll('.live-example')) example.liveExample.dispose();
}

function openTopic(focus = false) {
  const { hashTopic, requestedTopic, requestedSection } = parseHash();
  const sameTopic = currentTopic && currentTopic.id === requestedTopic;
  if (sameTopic && requestedSection) {
    document.getElementById(requestedSection)?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    return;
  }
  stopExamples();
  currentTopic = topics.find(topic => topic.id === requestedTopic) ?? topics.find(topic => topic.id === 'introduction');
  // Compare the raw hash, so an alias such as #getting-started is rewritten to the topic it names.
  if (hashTopic !== currentTopic.id) history.replaceState(null, '', `#${currentTopic.id}`);
  const section = document.createElement('section');
  section.id = currentTopic.id;
  const title = document.createElement('h1');
  title.textContent = currentTopic.title;
  section.append(title);
  const content = currentTopic.raw.replace(/^#{1,2} [^\n]*\n/, '').trim().replace(/\r\n/g, '\n');
  for (const block of content.split(/(```[^\n]*\n[\s\S]*?```)/g)) {
    if (block.startsWith('```')) renderFence(block, section);
    else for (const paragraph of block.trim().split(/\n\s*\n/)) if (paragraph.trim()) renderParagraph(paragraph.trim(), section);
  }
  article.replaceChildren(section);
  const index = topics.indexOf(currentTopic);
  const pagination = document.createElement('nav');
  pagination.className = 'doc-pagination';
  pagination.setAttribute('aria-label', 'Adjacent topics');
  for (const [topic, direction] of [[topics[index - 1], 'Previous'], [topics[index + 1], 'Next']]) {
    if (!topic) continue;
    const link = document.createElement('a');
    link.href = `#${topic.id}`;
    link.className = `doc-pagination-${direction.toLowerCase()}`;
    link.innerHTML = `<span>${direction}</span><strong>${escapeHtml(topic.title)} ${direction === 'Next' ? icon('arrow') : ''}</strong>`;
    pagination.append(link);
  }
  article.append(pagination);
  document.querySelector('#doc-topic-name').textContent = currentTopic.title;
  document.title = `${currentTopic.title} · Crucible documentation`;
  copyStatus.textContent = '';
  document.querySelector('.doc-copy-fallback')?.remove();
  copyPage.innerHTML = `${icon('copy')}Copy page`;
  renderNavigation();
  renderOutline(section);
  exampleStarter = autoRunVisibleExamples(article);
  section.addEventListener('api-ready', () => {
    renderOutline(section);
    if (requestedSection) document.getElementById(requestedSection)?.scrollIntoView();
  }, { once: true });
  if (requestedSection) {
    requestAnimationFrame(() => document.getElementById(requestedSection)?.scrollIntoView());
  } else if (focus) {
    article.focus({ preventScroll: true });
    window.scrollTo({ top: 0 });
    for (const animation of article.getAnimations()) animation.cancel();
    if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
      article.animate([{ opacity:0.6, transform:'translateY(6px)' }, { opacity:1, transform:'translateY(0)' }], { duration:170, easing:'cubic-bezier(.2,0,0,1)' });
    }
  }
}

copyPage.innerHTML = `${icon('copy')}Copy page`;
document.querySelector('#doc-topic-menu summary > :last-child').innerHTML = icon('chevron');
copyPage.addEventListener('click', () => copyText(copyPage, currentTopic.raw));
search.addEventListener('input', () => {
  if (search.value.trim()) topicMenu.open = true;
  renderNavigation();
});
window.addEventListener('hashchange', () => openTopic(true));
openTopic();
