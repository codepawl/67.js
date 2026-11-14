import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const learnFolder = new URL('../docs/learn/', import.meta.url);
const pages = readdirSync(learnFolder).filter(file => file.endsWith('.md')).map(file => ({
  id: file.slice(0, -3),
  text: readFileSync(new URL(file, learnFolder), 'utf8').replace(/\r\n/g, '\n'),
}));
const guide = readFileSync(new URL('../docs/guide.md', import.meta.url), 'utf8');
const navigation = readFileSync(new URL('../src/documentation-topics.js', import.meta.url), 'utf8');

function slug(text) {
  return text.trim().toLowerCase().replace(/`/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

const topicIds = new Set([
  ...pages.map(page => page.id),
  ...[...guide.matchAll(/^## (.+)$/gm)].map(match => slug(match[1])),
]);

test('each start page has one title and is in the navigation', () => {
  for (const page of pages) {
    assert.equal(page.text.match(/^# /gm)?.length, 1, `${page.id} needs one # title`);
    assert.ok(navigation.includes(`'${page.id}'`), `${page.id} is missing from the navigation groups`);
  }
});

test('every navigation id names a real topic', () => {
  const groupIds = [...navigation.matchAll(/ids: \[([^\]]+)\]/g)].flatMap(match => [...match[1].matchAll(/'([\w-]+)'/g)].map(id => id[1]));
  for (const id of groupIds) assert.ok(topicIds.has(id), `navigation lists ${id}, which has no topic`);
});

test('documentation links to topics and sections resolve', () => {
  for (const page of [...pages, { id: 'guide', text: guide }]) {
    for (const [, target] of page.text.matchAll(/\]\(#([^)\s]+)\)|^[^|\n]+\|\s*#([\w/-]+)/gm)) {
      if (!target) continue;
      const [topic, section] = target.split('/');
      assert.ok(topicIds.has(topic) || ['overview', 'getting-started'].includes(topic), `${page.id} links to #${target}, which has no topic`);
      if (section) {
        const owner = pages.find(entry => entry.id === topic);
        const headings = [...owner.text.matchAll(/^##+ (?:\d+\.\s+)?(.+)$/gm)].map(match => slug(match[1]));
        assert.ok(headings.includes(section), `${page.id} links to #${target}, which has no section`);
      }
    }
  }
});

test('every poster and loop of a live example exists', () => {
  for (const page of pages) {
    for (const [, name] of page.text.matchAll(/^```js live[^\n]*\bposter=([\w-]+)/gm)) {
      assert.ok(existsSync(new URL(`../public/docs-media/${name}.webp`, import.meta.url)), `${page.id}: run npm run docs:media for ${name}.webp`);
    }
    for (const [, file] of page.text.matchAll(/\]\((\/docs-media\/[\w.-]+)/g)) {
      assert.ok(existsSync(new URL(`../public${file}`, import.meta.url)), `${page.id}: ${file} is missing`);
    }
  }
});

test('the plain-text guide holds every topic once, in navigation order', async () => {
  const { plainGuide } = await import('../scripts/plain-guide.mjs');
  const text = await plainGuide(fileURLToPath(new URL('..', import.meta.url)));
  assert.equal(text.match(/^# /gm).length, 1);
  for (const page of pages) assert.ok(text.includes(`## ${page.text.match(/^# (.+)$/m)[1]}\n`), `${page.id} is missing from /guide.md`);
  assert.ok(text.indexOf('## Introduction') < text.indexOf('## Parts and geometry'));
});

test('links to plain-text contracts point at files the site publishes', () => {
  const release = readFileSync(new URL('../scripts/prepare-release.mjs', import.meta.url), 'utf8');
  const published = new Set(['guide.md', 'gltf.md', 'changelog.md', ...[...release.matchAll(/'([\w-]+\.md)'/g)].map(match => match[1])]);
  for (const page of pages) {
    for (const [, file] of page.text.matchAll(/\]\(\/([\w-]+\.md)(?:#[\w-]+)?\)/g)) {
      assert.ok(published.has(file), `${page.id} links to /${file}, which the site does not publish`);
    }
  }
});

test('the API reference finds the declaration of the core exports', async () => {
  const { buildApiReference } = await import('../scripts/api-reference.mjs');
  const reference = await buildApiReference();
  const core = reference.modules.find(module => module.module === 'crucible');
  for (const name of ['CrucibleRenderer', 'box', 'cameraView', 'exportGlb']) {
    const entry = core.exports.find(item => item.name === name);
    assert.ok(entry?.source.includes(':'), `${name} has no source line`);
  }
  assert.match(core.exports.find(item => item.name === 'CrucibleRenderer').signature, /^new CrucibleRenderer\(canvas/);
  assert.ok(reference.modules.some(module => module.module === 'crucible/addons/gltf'));
});
