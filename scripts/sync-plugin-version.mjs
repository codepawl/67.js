// Copies the version in package.json into the Claude Code plugin manifest and the marketplace entry.
// Run it with `npm run plugin:sync` after bumping the version for a release.
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const packageMetadata = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));

async function updateJson(relativePath, update) {
  const filePath = resolve(root, relativePath);
  const document = JSON.parse(await readFile(filePath, 'utf8'));
  update(document);
  await writeFile(filePath, `${JSON.stringify(document, null, 2)}\n`);
}

await updateJson('.claude-plugin/plugin.json', (manifest) => {
  manifest.version = packageMetadata.version;
});
await updateJson('.claude-plugin/marketplace.json', (marketplace) => {
  for (const plugin of marketplace.plugins) plugin.version = packageMetadata.version;
});
console.log(`Claude Code plugin set to ${packageMetadata.version}.`);
