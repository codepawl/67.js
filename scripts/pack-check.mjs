#!/usr/bin/env node
// Checks data-only packs before you publish them: `npm run pack:check -- <pack folder> [<pack folder> ...]`.
// Runs the checks the MCP server runs when it loads --packs, plus the scene validator for recipes and materials.
import { resolve } from 'node:path';
import packageMetadata from '../package.json' with { type: 'json' };
import { loadPack } from './agent-packs.mjs';
import { validatePackScene } from './pack-scene-validator.mjs';

const folders = process.argv.slice(2);
if (folders.length === 0) {
  console.error('Usage: npm run pack:check -- <absolute or relative pack folder> [more folders]');
  process.exit(2);
}

let failed = false;
for (const folder of folders) {
  try {
    const pack = await loadPack(resolve(folder), { packageVersion: packageMetadata.version, validateScene: validatePackScene });
    const counts = Object.entries(pack.items).filter(([, items]) => items.length > 0).map(([kind, items]) => `${items.length} ${kind}`).join(', ');
    console.log(`ok   ${pack.name} ${pack.version} (${counts || 'no items'})`);
  } catch (error) {
    failed = true;
    console.error(`FAIL ${error.message}`);
  }
}
process.exit(failed ? 1 : 0);
