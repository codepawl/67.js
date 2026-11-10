// Build the plain-text guide (`/guide.md`) for agents and readers without JavaScript: the start pages, then the guide,
// in the order of the site navigation. Learn page headings move down one level so the file keeps one `#` title.
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { guideTopics, learnTopics, orderTopics, topicAliases } from '../src/documentation-topics.js';

function demoteHeadings(markdown) {
  const parts = markdown.split(/(```[^\n]*\n[\s\S]*?```)/g);
  return parts.map(part => part.startsWith('```') ? part : part.replace(/^(#{1,5}) /gm, '#$1 ')).join('');
}

/** Return the complete plain-text guide for a checkout at `root`. */
export async function plainGuide(root) {
  const guide = (await readFile(resolve(root, 'docs/guide.md'), 'utf8')).replace(/\r\n/g, '\n');
  const learnFolder = resolve(root, 'docs/learn');
  const sources = {};
  for (const file of (await readdir(learnFolder)).filter(name => name.endsWith('.md'))) {
    sources[file] = await readFile(resolve(learnFolder, file), 'utf8');
  }
  const learnIds = new Set(Object.keys(sources).map(file => file.slice(0, -3)));
  const topics = [...guideTopics(guide), ...learnTopics(sources)].filter(topic => !(topic.id in topicAliases));
  const { topics: ordered } = orderTopics(topics);
  const introduction = guide.slice(0, guide.search(/^## /m)).trimEnd();
  const body = ordered.map(topic => (learnIds.has(topic.id) ? demoteHeadings(topic.raw) : topic.raw).trim());
  return `${introduction}\n\n${body.join('\n\n')}\n`;
}
