// Copies the version in package.json into the Claude Code marketplace entry.
// Run it with `npm run plugin:sync` after bumping the version for a release.
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const packageMetadata = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const marketplacePath = resolve(root, '.claude-plugin/marketplace.json');
const marketplace = JSON.parse(await readFile(marketplacePath, 'utf8'));

for (const plugin of marketplace.plugins) plugin.version = packageMetadata.version;
await writeFile(marketplacePath, `${JSON.stringify(marketplace, null, 2)}\n`);
console.log(`Claude Code plugin set to ${packageMetadata.version}.`);
