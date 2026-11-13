import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourceDigest } from './source-digest.mjs';

/** Throws unless build/ was made from the src/ and package version that sit in the project folder now. */
export async function checkBuildFresh(projectRoot) {
  const manifestPath = join(projectRoot, 'build', 'mcp', 'manifest.json');
  const manifest = await readFile(manifestPath, 'utf8').then(JSON.parse, () => {
    throw new Error(`${manifestPath} is missing or unreadable. Run npm run build:lib before you pack.`);
  });
  const metadata = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8'));
  if (manifest.packageVersion !== metadata.version) {
    throw new Error(`build/ was made for ${manifest.packageVersion}, but package.json says ${metadata.version}. Run npm run build:lib.`);
  }
  const currentDigest = await sourceDigest(projectRoot);
  if (manifest.sourceDigest !== currentDigest) {
    throw new Error('build/ was not made from the current src/ (its recorded source digest differs). Run npm run build:lib, then pack again; a stale build would ship a game runtime and MCP server that disagree with src/.');
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await checkBuildFresh(fileURLToPath(new URL('..', import.meta.url)));
  console.log('build/ matches src/.');
}
