import './home.js';
import './documentation.css';
import { isVideoUrl } from './changelog-media.js';

const article = document.querySelector('#doc-article');
const versionList = document.querySelector('#doc-toc');
const topicMenu = document.querySelector('#doc-topic-menu');
const desktopTopics = matchMedia('(min-width: 1051px)');
const issueBase = 'https://github.com/codepawl/crucible/issues/';
topicMenu.open = desktopTopics.matches;
desktopTopics.addEventListener('change', () => { topicMenu.open = desktopTopics.matches; });

const svgNamespace = 'http://www.w3.org/2000/svg';

function breakingIcon() {
  const icon = document.createElementNS(svgNamespace, 'svg');
  icon.setAttribute('class', 'icon change-breaking-icon');
  icon.setAttribute('viewBox', '0 0 24 24');
  icon.setAttribute('fill', 'none');
  icon.setAttribute('stroke', 'currentColor');
  icon.setAttribute('stroke-width', '2');
  icon.setAttribute('stroke-linecap', 'round');
  icon.setAttribute('stroke-linejoin', 'round');
  icon.setAttribute('aria-hidden', 'true');
  icon.innerHTML = '<path d="M10.3 3.9 2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4M12 17h.01"/>';
  return icon;
}

// Entry text uses `code` spans. Build nodes instead of HTML so the text can never inject markup.
function appendText(parent, text) {
  text.split('`').forEach((piece, index) => {
    if (index % 2 === 1) {
      const code = document.createElement('code');
      code.textContent = piece;
      parent.append(code);
    } else {
      parent.append(piece);
    }
  });
}

// A clip plays like a GIF: muted, looping and inline. A picture loads when it scrolls near.
function mediaElement(media) {
  if (isVideoUrl(media.url)) {
    const video = document.createElement('video');
    video.className = 'change-media';
    video.src = media.url;
    video.muted = true;
    video.loop = true;
    video.autoplay = true;
    video.playsInline = true;
    video.setAttribute('aria-label', media.alt);
    return video;
  }
  const image = document.createElement('img');
  image.className = 'change-media';
  image.src = media.url;
  image.alt = media.alt;
  image.loading = 'lazy';
  image.decoding = 'async';
  return image;
}

function entryRow(entry) {
  const row = document.createElement('li');
  row.className = 'change-entry';
  const issue = document.createElement('span');
  issue.className = 'change-issue';
  if (entry.issue !== null) {
    const link = document.createElement('a');
    link.href = `${issueBase}${entry.issue}`;
    link.textContent = `#${entry.issue}`;
    issue.append(link);
  }
  const text = document.createElement('p');
  if (entry.breaking) {
    const label = document.createElement('span');
    label.className = 'change-breaking';
    label.append(breakingIcon(), 'Breaking');
    text.append(label);
  }
  // The issue column already links the number, so a trailing "(#N)" for the same issue is dropped.
  const trailingIssue = entry.issue === null ? null : new RegExp(`\\s*\\(#${entry.issue}\\)$`);
  appendText(text, trailingIssue ? entry.text.replace(trailingIssue, '') : entry.text);
  if (entry.media) text.append(mediaElement(entry.media));
  row.append(issue, text);
  return row;
}

function versionSection(id, title, entries) {
  const section = document.createElement('section');
  section.id = id;
  const heading = document.createElement('h2');
  heading.textContent = title;
  section.append(heading);
  // Entries come in runs that share a group. Each run gets its own heading and list.
  let list = null;
  let currentGroup;
  for (const entry of entries) {
    const group = entry.group ?? null;
    if (!list || group !== currentGroup) {
      if (group) {
        const groupHeading = document.createElement('h3');
        groupHeading.textContent = group;
        section.append(groupHeading);
      }
      list = document.createElement('ul');
      list.className = 'change-list';
      section.append(list);
      currentGroup = group;
    }
    list.append(entryRow(entry));
  }
  return section;
}

function render(data) {
  const sections = [];
  if (data.unreleased.length > 0) sections.push({ id: 'unreleased', title: 'Unreleased', entries: data.unreleased });
  for (const release of data.released) sections.push({ id: `v${release.version}`, title: release.version, entries: release.entries });
  const title = document.createElement('h1');
  title.textContent = 'Changelog';
  article.replaceChildren(title, ...sections.map((section) => versionSection(section.id, section.title, section.entries)));
  versionList.replaceChildren(...sections.map((section) => {
    const link = document.createElement('a');
    link.href = `#${section.id}`;
    link.textContent = section.title;
    return link;
  }));
  document.querySelector('#doc-topic-name').textContent = sections[0]?.title ?? '';
  if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView();
}

try {
  const response = await fetch('/changelog.json');
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  render(await response.json());
} catch {
  const fallback = document.createElement('a');
  fallback.href = '/changelog.md';
  fallback.textContent = 'plain-text changelog';
  article.replaceChildren('The changelog could not be loaded. Read the ', fallback, ' instead.');
}
