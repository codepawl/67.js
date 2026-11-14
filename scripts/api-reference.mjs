// Build the API reference from the package's real exports: every name that `crucible` and each documented addon export,
// with its kind, its signature and the comment above its declaration.
// `node scripts/api-reference.mjs` writes public/api-reference.json. `npm run build` runs it, so the site always matches the code.
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Package export path to source file. The library build maps each addon entry name to its source.
async function entryFiles() {
  const packageJson = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
  const libraryConfig = await readFile(resolve(root, 'config/vite.lib.config.js'), 'utf8');
  const sources = Object.fromEntries([...libraryConfig.matchAll(/^\s*'?([\w-]+)'?:\s*'(src\/[\w-]+\.js)'/gm)].map(match => [match[1], match[2]]));
  const entries = [];
  for (const exportPath of Object.keys(packageJson.exports)) {
    if (exportPath === '.') entries.push({ module: 'crucible', file: sources.core });
    const addon = exportPath.match(/^\.\/addons\/([\w-]+)$/);
    if (addon && sources[addon[1]]) entries.push({ module: `crucible/addons/${addon[1]}`, file: sources[addon[1]] });
  }
  return entries;
}

const fileCache = new Map();
async function sourceText(file) {
  if (!fileCache.has(file)) fileCache.set(file, (await readFile(resolve(root, file), 'utf8')).replace(/\r\n/g, '\n'));
  return fileCache.get(file);
}

function resolveImport(fromFile, specifier) {
  return relative(root, resolve(root, dirname(fromFile), specifier)).replace(/\\/g, '/');
}

// The comment lines directly above a declaration, without the comment markers.
function leadingComment(text, index) {
  const lines = text.slice(0, index).split('\n');
  lines.pop();
  const comment = [];
  while (lines.length) {
    const line = lines[lines.length - 1].trim();
    if (!/^(\/\/|\/\*\*?|\*)/.test(line)) break;
    comment.unshift(line.replace(/^\/\*\*?\s?|\*\/$|^\*\s?|^\/\/\s?/g, '').trim());
    lines.pop();
  }
  return comment.filter(Boolean).join(' ').trim();
}

// Read the parameter list of `name(...)`, counting brackets so default objects and arrays stay whole.
function parameterList(text, start) {
  let depth = 0;
  for (let index = start; index < text.length; index++) {
    const character = text[index];
    if ('([{'.includes(character)) depth++;
    if (')]}'.includes(character)) depth--;
    if (depth === 0) return text.slice(start, index + 1).replace(/\s+/g, ' ');
  }
  return '()';
}

async function declaration(file, name, seen = new Set()) {
  const key = `${file}#${name}`;
  if (seen.has(key)) return null;
  seen.add(key);
  const text = await sourceText(file);
  const patterns = [
    { kind: 'function', pattern: new RegExp(`^export (?:async )?function\\*? ${name}\\s*\\(`, 'm') },
    { kind: 'class', pattern: new RegExp(`^export class ${name}\\b`, 'm') },
    { kind: 'constant', pattern: new RegExp(`^export (?:const|let) ${name}\\b`, 'm') },
  ];
  for (const { kind, pattern } of patterns) {
    const match = pattern.exec(text);
    if (!match) continue;
    const line = text.slice(0, match.index).split('\n').length;
    let signature = name;
    if (kind === 'function') signature = `${name}${parameterList(text, match.index + match[0].length - 1)}`;
    if (kind === 'class') {
      const constructorMatch = /\n\s+constructor\s*\(/.exec(text.slice(match.index));
      if (constructorMatch) signature = `new ${name}${parameterList(text, match.index + constructorMatch.index + constructorMatch[0].length - 1)}`;
    }
    return { kind, signature, summary: leadingComment(text, match.index), source: `${file}:${line}` };
  }
  // A local declaration exported later by an `export { name }` list.
  const local = new RegExp(`^(?:async )?function ${name}\\s*\\(|^(?:const|let) ${name}\\b|^class ${name}\\b`, 'm').exec(text);
  if (local && new RegExp(`^export \\{[^}]*\\b${name}\\b[^}]*\\};?$`, 'm').test(text)) {
    const kind = local[0].includes('function') ? 'function' : local[0].includes('class') ? 'class' : 'constant';
    const line = text.slice(0, local.index).split('\n').length;
    const signature = kind === 'function' ? `${name}${parameterList(text, local.index + local[0].length - 1)}` : name;
    return { kind, signature, summary: leadingComment(text, local.index), source: `${file}:${line}` };
  }
  // `import { name } from './other.js'` followed by `export { name }`.
  if (new RegExp(`^export \\{[^}]*\\b${name}\\b[^}]*\\};?$`, 'm').test(text)) {
    for (const match of text.matchAll(/^import \{([^}]+)\} from '(\.[^']+)';?$/gm)) {
      for (const item of match[1].split(',').map(part => part.trim()).filter(Boolean)) {
        const [original, alias = original] = item.split(/\s+as\s+/);
        if (alias === name) return declaration(resolveImport(file, match[2]), original, seen);
      }
    }
  }
  for (const match of text.matchAll(/^export \{([^}]+)\} from '([^']+)';?$/gm)) {
    for (const item of match[1].split(',').map(part => part.trim()).filter(Boolean)) {
      const [original, alias = original] = item.split(/\s+as\s+/);
      if (alias === name) return declaration(resolveImport(file, match[2]), original, seen);
    }
  }
  for (const match of text.matchAll(/^export \* from '([^']+)';?$/gm)) {
    const found = await declaration(resolveImport(file, match[1]), name, seen);
    if (found) return found;
  }
  return null;
}

/** Return the reference for every documented entry point, in package order. */
export async function buildApiReference() {
  const modules = [];
  for (const { module, file } of await entryFiles()) {
    const namespace = await import(`file://${resolve(root, file).replace(/\\/g, '/')}`).catch(() => null);
    if (!namespace) continue;
    const exports = [];
    for (const name of Object.keys(namespace).sort((first, second) => first.localeCompare(second))) {
      const found = await declaration(file, name);
      const value = namespace[name];
      const kind = found?.kind ?? (typeof value === 'function' ? 'function' : 'constant');
      exports.push({ name, kind, signature: found?.signature ?? name, summary: found?.summary ?? '', source: found?.source ?? file });
    }
    modules.push({ module, file, exports });
  }
  return { modules };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const reference = await buildApiReference();
  await writeFile(resolve(root, 'public/api-reference.json'), `${JSON.stringify(reference, null, 1)}\n`);
  const count = reference.modules.reduce((total, entry) => total + entry.exports.length, 0);
  console.log(`Wrote public/api-reference.json: ${reference.modules.length} modules, ${count} exports.`);
}
