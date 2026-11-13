import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

/**
 * One hash of every file under src/, by relative path and contents. The MCP build records it in build/mcp/manifest.json, and
 * check-build-fresh.mjs compares it with the tree before a pack, so a build that was not rebuilt from this src cannot ship.
 */
export async function sourceDigest(projectRoot) {
  const sourceFolder = join(projectRoot, 'src');
  const entries = await readdir(sourceFolder, { recursive: true, withFileTypes: true });
  const filePaths = entries
    .filter(entry => entry.isFile())
    .map(entry => join(entry.parentPath, entry.name))
    .sort((left, right) => left.localeCompare(right, 'en'));
  const hash = createHash('sha256');
  for (const filePath of filePaths) {
    hash.update(`${relative(sourceFolder, filePath).split(sep).join('/')}\0`);
    hash.update(await readFile(filePath));
    hash.update('\0');
  }
  return hash.digest('hex');
}
