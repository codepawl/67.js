// The order of the documentation. The site navigation and the plain-text guide (`/guide.md`) both read it.
// Ids are file names in docs/learn, or slugs of the `## ` headings in docs/guide.md.
export const documentationGroups = [
  { title: 'Start here', icon: 'start', ids: ['introduction', 'install', 'first-scene', 'faq'] },
  { title: 'Build a scene', icon: 'cube', ids: ['parts-and-geometry', 'materials-and-color', 'cameras-and-framing', 'effects-and-lighting', 'local-lights-and-volume-fog', 'hdr-environment-lighting', 'renderer-reference'] },
  { title: 'Model and fit surfaces', icon: 'cube', ids: ['procedural-modeling', 'sculpt-brushes', 'contact-detection', 'shrinkwrap-and-surface-patches', 'retained-surface-attachments'] },
  { title: 'Worlds', icon: 'world', ids: ['terrain-and-ground-textures', 'trees-and-grass', 'grass-fields', 'wheeled-vehicles', 'baked-liquid'] },
  { title: 'Animate and interact', icon: 'motion', ids: ['deterministic-animation', 'animation-curves-and-mixing', 'skeletal-and-morph-animation', 'humanoid-retargeting-and-crowds', 'recorded-physics', 'assemblies-and-interaction'] },
  { title: 'Assets and media', icon: 'image', ids: ['import-and-export-models', 'images-and-films', 'render-a-png-from-a-script-without-mcp'] },
  { title: 'Reference and workflows', icon: 'book', ids: ['api-reference', 'performance-and-memory', 'lifecycle-and-troubleshooting', 'connect-mcp', 'agent-workflows', 'optimize-for-agents', 'models-and-ai-agents', 'addons-and-limits', 'release-and-source-availability', 'resources'] },
];

// Old links keep working after the start pages replaced the first sections of the guide.
export const topicAliases = { overview: 'introduction', 'getting-started': 'first-scene' };

export function topicSlug(text) {
  return text.trim().toLowerCase().replace(/`/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/** Split the guide at its `## ` headings into topics with their exact Markdown. */
export function guideTopics(guide) {
  const headings = [...guide.matchAll(/^## (.+)\r?$/gm)];
  return headings.map((heading, index) => ({
    id: topicSlug(heading[1]),
    title: heading[1].trim(),
    raw: guide.slice(heading.index, headings[index + 1]?.index ?? guide.length),
  }));
}

/** Turn `{ 'path/name.md': text }` into topics, one per learn page. */
export function learnTopics(sources) {
  return Object.entries(sources).map(([path, raw]) => {
    const text = raw.replace(/\r\n/g, '\n');
    return { id: path.match(/([\w-]+)\.md$/)[1], title: text.match(/^# (.+)$/m)[1].trim(), raw: text };
  });
}

/** Every topic in navigation order. A topic that no group lists goes to a "More guides" group, so none is hidden. */
export function orderTopics(topics, groups = documentationGroups) {
  const byId = new Map(topics.map(topic => [topic.id, topic]));
  const listed = new Set(groups.flatMap(group => group.ids));
  const unlisted = [...byId.keys()].filter(id => !listed.has(id));
  const allGroups = unlisted.length ? [...groups, { title: 'More guides', icon: 'book', ids: unlisted }] : groups;
  return { groups: allGroups, topics: allGroups.flatMap(group => group.ids.map(id => byId.get(id)).filter(Boolean)) };
}
