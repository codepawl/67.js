import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

// Writes a playable game as one folder that any static host can serve: index.html, game.json (the recipe with its game
// section) and engine/ (the built 67js modules that index.html imports, found by following the import statements from
// build/game.js). There is no server code. The folder is bounded, so an export never fills the disk.

export const WEB_EXPORT_LIMITS = Object.freeze({ maxEngineBytes: 12 * 1024 * 1024, maxEngineFiles: 400, maxTitleLength: 64, maxRecipeBytes: 1024 * 1024, maxAssetBytes: 64 * 1024 * 1024 });
const ASSET_ID = /^[a-f0-9]{64}$/;

const ENTRY_MODULE = 'game.js';
const IMPORT_PATTERN = /(?:from\s*|import\s*\(\s*|import\s*)["'](\.\/[A-Za-z0-9_.-]+\.js)["']/g;

/** Every module file build/game.js needs, including the ones it loads on demand, as names relative to the build folder. */
export async function engineModuleNames(buildDirectory) {
  const found = new Set();
  const pending = [ENTRY_MODULE];
  while (pending.length) {
    const name = pending.pop();
    if (found.has(name)) continue;
    let source;
    try {
      source = await readFile(join(buildDirectory, name), 'utf8');
    } catch {
      // A match inside an error message is not an import; only the entry module must exist.
      if (name !== ENTRY_MODULE) continue;
      throw new Error(`The web export needs the built engine, and ${name} is missing from ${buildDirectory}. Run npm run build:lib, or install the published package.`);
    }
    found.add(name);
    if (found.size > WEB_EXPORT_LIMITS.maxEngineFiles) throw new RangeError(`The engine has more than ${WEB_EXPORT_LIMITS.maxEngineFiles} modules, which is not expected. Rebuild the package.`);
    for (const match of source.matchAll(IMPORT_PATTERN)) pending.push(match[1].slice(2));
  }
  return [...found].sort();
}

function escapeHtml(text) {
  return text.replace(/[&<>"']/g, character => `&#${character.charCodeAt(0)};`);
}

function pageTitle(title) {
  const clean = String(title ?? 'Game').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, WEB_EXPORT_LIMITS.maxTitleLength);
  return escapeHtml(clean || 'Game');
}

/** The page. `?replay=name.json` plays a recording from the same folder instead of the keyboard, for tests and demos. */
export function indexHtml(title, assetUrls = {}) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<link rel="icon" href="data:,">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<title>${pageTitle(title)}</title>
<style>html,body{margin:0;height:100%;background:#101014;overflow:hidden}canvas{display:block;width:100%;height:100%;touch-action:none}</style>
</head>
<body>
<canvas id="game"></canvas>
<script type="module">
import { startGame } from './engine/${ENTRY_MODULE}';
const canvas = document.getElementById('game');
const recipe = await (await fetch('./game.json')).json();
const replayName = new URLSearchParams(location.search).get('replay');
const replay = /^[\\w.-]+\\.json$/.test(replayName ?? '') ? await (await fetch('./' + replayName)).json() : undefined;
const assetUrls = ${JSON.stringify(assetUrls)};
window.__game = await startGame(canvas, recipe, { replay, assetUrls });
</script>
</body>
</html>
`;
}

/**
 * Write the web build of a recipe into `outputDirectory` (created, must not hold a build already) and return its summary.
 * `buildDirectory` is the package's build/ folder.
 */
export async function writeWebBuild({ recipe, buildDirectory, outputDirectory, title, assets = new Map() }) {
  if (!recipe?.game) throw new Error('This scene has no game. Add one with scene_apply set-game (fields: scene_capabilities topic game), then export again.');
  if (recipe.game.physics) throw new Error('game.physics is true, and the web export does not bundle the physics engine yet. Set game.physics to false with set-game.');
  if (recipe.nodes?.some(node => node.vegetation)) throw new Error('The web export does not carry grown vegetation yet. Remove it, or build the plants from geometry.');
  const missing = (recipe.nodes ?? []).filter(node => node.asset && !assets.has(node.asset.id)).map(node => node.id);
  if (missing.length) throw new Error(`The web export needs the bytes of the catalog assets placed by ${missing.join(', ')}. Pass them as assets (asset id to Buffer).`);
  if (recipe.format !== '67js.scene') throw new Error('The web export needs a 67js.scene recipe. Create the scene with scene_create.');
  const recipeText = JSON.stringify(recipe);
  if (Buffer.byteLength(recipeText) > WEB_EXPORT_LIMITS.maxRecipeBytes) throw new RangeError(`The recipe is larger than ${WEB_EXPORT_LIMITS.maxRecipeBytes} bytes. Simplify the scene.`);

  const names = await engineModuleNames(buildDirectory);
  let engineBytes = 0;
  for (const name of names) engineBytes += (await stat(join(buildDirectory, name))).size;
  if (engineBytes > WEB_EXPORT_LIMITS.maxEngineBytes) throw new RangeError(`The engine is ${engineBytes} bytes, above the ${WEB_EXPORT_LIMITS.maxEngineBytes} byte limit. Rebuild the package.`);

  await mkdir(join(outputDirectory, 'engine'), { recursive: true });
  for (const name of names) await copyFile(join(buildDirectory, name), join(outputDirectory, 'engine', name));
  await writeFile(join(outputDirectory, 'game.json'), recipeText);
  const assetUrls = {};
  let assetBytes = 0;
  if (assets.size) await mkdir(join(outputDirectory, 'assets'), { recursive: true });
  for (const [id, bytes] of assets) {
    if (!ASSET_ID.test(id)) throw new RangeError(`Asset id ${JSON.stringify(id)} is not a catalog id of 64 hexadecimal characters.`);
    assetBytes += bytes.byteLength;
    if (assetBytes > WEB_EXPORT_LIMITS.maxAssetBytes) throw new RangeError(`The placed assets are over ${WEB_EXPORT_LIMITS.maxAssetBytes} bytes together. Use fewer or smaller assets.`);
    await writeFile(join(outputDirectory, 'assets', `${id}.glb`), bytes);
    assetUrls[id] = `./assets/${id}.glb`;
  }
  const html = indexHtml(title, assetUrls);
  await writeFile(join(outputDirectory, 'index.html'), html);
  const totalBytes = engineBytes + assetBytes + Buffer.byteLength(recipeText) + Buffer.byteLength(html);
  return { directory: dirname(join(outputDirectory, 'index.html')), files: names.length + 2 + assets.size, engineModules: names.length, bytes: totalBytes };
}
