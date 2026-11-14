// Which game fields and MCP tool fields the last npm release accepts, and which guide text names a newer one without a
// version tag. The site deploys from main, so its guides run ahead of the install line (#1131).
//
//   node scripts/guide-fields.mjs snapshot [--tag v0.20.0]   write bench/guide-fields/released.json
//   node scripts/guide-fields.mjs check                      list newer fields a guide does not tag
//
// A guide marks a newer field with `{since 0.21.0}` in the same table row, bullet or paragraph. The site draws the mark as a
// small tag; the plain-text guide keeps it as written.

import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const RELEASED_FIELDS_PATH = join(REPOSITORY_ROOT, 'bench', 'guide-fields', 'released.json');
export const GUIDE_PATHS = Object.freeze(['docs/game.md', 'docs/mcp.md']);
export const SINCE_MARK = /\{since (\d+\.\d+\.\d+)\}/;

const MAXIMUM_SCHEMA_DEPTH = 8;

/** The game setup fields as dotted paths: `camera`, `player.animation`, `npcs[].path`. Read from the source text so an old checkout works too. */
export function collectGameFields(root = REPOSITORY_ROOT) {
  const source = readFileSync(join(root, 'src', 'game-setup.js'), 'utf8');
  const namesOf = constantName => {
    const match = source.match(new RegExp(`const ${constantName} = \\[([^\\]]*)\\]`));
    if (!match) throw new Error(`src/game-setup.js has no ${constantName} list; update scripts/guide-fields.mjs.`);
    return [...match[1].matchAll(/'([^']+)'/g)].map(entry => entry[1]);
  };
  return [
    ...namesOf('SETUP_FIELDS'),
    ...namesOf('PLAYER_FIELDS').map(name => `player.${name}`),
    ...namesOf('NPC_FIELDS').map(name => `npcs[].${name}`),
  ];
}

function walkSchema(schema, path, found, depth) {
  if (!schema || typeof schema !== 'object' || depth > MAXIMUM_SCHEMA_DEPTH) return;
  for (const [name, child] of Object.entries(schema.properties ?? {})) {
    const childPath = path ? `${path}.${name}` : name;
    found.add(childPath);
    walkSchema(child, childPath, found, depth + 1);
  }
  if (schema.items) walkSchema(schema.items, `${path}[]`, found, depth + 1);
  for (const key of ['anyOf', 'oneOf', 'allOf']) {
    for (const variant of schema[key] ?? []) walkSchema(variant, path, found, depth + 1);
  }
}

/** Every input property of every MCP tool as `tool path`, such as `scene_render_submit settings.multilayer`. */
export async function collectToolFields() {
  const { Client } = await import('@modelcontextprotocol/client');
  const { InMemoryTransport } = await import('@modelcontextprotocol/server');
  const { createAgentMcpServer } = await import('./mcp-server.mjs');
  const server = createAgentMcpServer({ async close() {} });
  const client = new Client({ name: 'guide-fields', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const { tools } = await client.listTools();
    const fields = [];
    for (const tool of tools) {
      const found = new Set();
      walkSchema(tool.inputSchema, '', found, 0);
      fields.push(...[...found].map(path => `${tool.name} ${path}`));
    }
    return fields;
  } finally {
    await client.close();
    await server.close();
  }
}

export async function collectFields(root = REPOSITORY_ROOT) {
  return {
    game: collectGameFields(root).sort(),
    tools: (await collectToolFields()).sort(),
  };
}

export function readReleasedFields() {
  return JSON.parse(readFileSync(RELEASED_FIELDS_PATH, 'utf8'));
}

function lastSegment(path) {
  return path.split('.').pop().replace(/\[\]$/, '');
}

/** The fields the current source accepts that the release did not: `{ game: [...], tools: [...] }`. */
export function newerFields(current, released) {
  const releasedGame = new Set(released.game);
  const releasedToolFields = new Set(released.tools);
  return {
    game: current.game.filter(path => !releasedGame.has(path)),
    tools: current.tools.filter(entry => !releasedToolFields.has(entry)),
  };
}

// A guide line is a table row, a bullet, or the blank-line-separated paragraph around it.
function guideBlocks(text) {
  const blocks = [];
  let paragraph = [];
  const flush = () => {
    if (paragraph.length) blocks.push(paragraph.join('\n'));
    paragraph = [];
  };
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    if (line.trim() === '') flush();
    else if (/^\s*(\||[-*] )/.test(line)) {
      flush();
      blocks.push(line);
    } else paragraph.push(line);
  }
  flush();
  return blocks;
}

function mentions(block, name) {
  return block.includes(`\`${name}\``) || new RegExp(`\`${name.replace(/[.[\]]/g, '\\$&')}[\`.\\[]`).test(block);
}

/**
 * Newer fields a guide names without a `{since X.Y.Z}` mark. A game field is matched by its dotted path (`player.animation`,
 * `npcs[].path`, or the bare name for a top-level one). A tool field is matched by its last name only when no released field
 * carries that name, so a common word such as `id` or `note` never trips it.
 */
export function findUnmarkedFields({ guides, newer, released }) {
  const releasedLeaves = new Set(released.tools.map(entry => lastSegment(entry.split(' ')[1])));
  const gameNames = newer.game;
  const toolNames = [...new Set(newer.tools.map(entry => lastSegment(entry.split(' ')[1])))].filter(name => !releasedLeaves.has(name));
  const problems = [];
  for (const [guide, text] of Object.entries(guides)) {
    for (const block of guideBlocks(text)) {
      if (SINCE_MARK.test(block)) continue;
      for (const name of [...gameNames, ...toolNames]) {
        if (mentions(block, name)) problems.push({ guide, name, line: block.split('\n')[0].slice(0, 100) });
      }
    }
  }
  return problems;
}

export function readGuides(root = REPOSITORY_ROOT) {
  return Object.fromEntries(GUIDE_PATHS.map(path => [path, readFileSync(join(root, path), 'utf8')]));
}

function buildTaggedSnapshot(tag) {
  const folder = mkdtempSync(join(tmpdir(), 'crucible-guide-fields-'));
  try {
    const archive = execFileSync('git', ['archive', tag], { cwd: REPOSITORY_ROOT, maxBuffer: 1 << 30 });
    execFileSync('tar', ['-x'], { cwd: folder, input: archive });
    symlinkSync(join(REPOSITORY_ROOT, 'node_modules'), join(folder, 'node_modules'), 'junction');
    copyFileSync(fileURLToPath(import.meta.url), join(folder, 'scripts', 'guide-fields.mjs'));
    const output = execFileSync(process.execPath, [join(folder, 'scripts', 'guide-fields.mjs'), 'print'], { cwd: folder, encoding: 'utf8', maxBuffer: 1 << 28 });
    return JSON.parse(output);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

async function main(argumentsList) {
  const [command, ...rest] = argumentsList;
  if (command === 'print') {
    process.stdout.write(JSON.stringify(await collectFields()));
    return 0;
  }
  if (command === 'snapshot') {
    const tagIndex = rest.indexOf('--tag');
    const tag = tagIndex >= 0 ? rest[tagIndex + 1] : null;
    const fields = tag ? buildTaggedSnapshot(tag) : await collectFields();
    const release = tag ? tag.replace(/^v/, '') : JSON.parse(readFileSync(join(REPOSITORY_ROOT, 'package.json'), 'utf8')).version;
    mkdirSync(dirname(RELEASED_FIELDS_PATH), { recursive: true });
    writeFileSync(RELEASED_FIELDS_PATH, `${JSON.stringify({ release, ...fields }, null, 1)}\n`);
    console.log(`Wrote ${RELEASED_FIELDS_PATH} for ${release}: ${fields.game.length} game fields, ${fields.tools.length} tool fields.`);
    return 0;
  }
  if (command === 'check') {
    const released = readReleasedFields();
    const newer = newerFields(await collectFields(), released);
    const problems = findUnmarkedFields({ guides: readGuides(), newer, released });
    for (const problem of problems) console.log(`${problem.guide}: \`${problem.name}\` is newer than ${released.release} and needs {since X.Y.Z}: ${problem.line}`);
    console.log(problems.length ? `${problems.length} unmarked.` : `clean (${newer.game.length} newer game fields, ${newer.tools.length} newer tool fields).`);
    return problems.length ? 1 : 0;
  }
  console.error('Usage: node scripts/guide-fields.mjs snapshot [--tag v0.20.0] | check');
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
