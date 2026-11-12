import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { checkAddon, CORE_PACKAGE } from '../bin/67js-addon-check.mjs';

// Addons the person who starts the MCP server allows. Only startup options choose them (--addons, --allow-addon); no tool
// call can name one. Each is looked up in <folder>/node_modules/<name> and must pass the addon contract (docs/addons.md).

export const MAXIMUM_ADDON_BUNDLE_BYTES = 2 * 1024 * 1024;
export const MAXIMUM_ALLOWED_ADDONS = 16;
const PACKAGE_NAME = /^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/;

function isInside(folder, path) {
  const inside = relative(folder, path);
  return inside !== '' && !inside.startsWith('..') && !isAbsolute(inside);
}

// The ES module entry of a package: a string `exports`, its "." entry, or the import/default condition of either; else `main`.
function entryOf(pack) {
  const exportsField = pack.exports;
  const root = exportsField && typeof exportsField === 'object' && '.' in exportsField ? exportsField['.'] : exportsField;
  if (typeof root === 'string') return root;
  if (root && typeof root === 'object') {
    const conditional = root.import ?? root.default;
    if (typeof conditional === 'string') return conditional;
  }
  return typeof pack.main === 'string' ? pack.main : null;
}

// A broken package (a missing entry file, an unreadable folder) is skipped like any other failing addon: it never stops the server.
function loadOne(name, addonsFolder, version) {
  try {
    return loadOneChecked(name, addonsFolder, version);
  } catch (error) {
    return { reason: `${name} could not be read (${error.message}). Reinstall it with npm install ${name} in ${addonsFolder}.` };
  }
}

function loadOneChecked(name, addonsFolder, version) {
  if (!PACKAGE_NAME.test(name)) {
    return { reason: `"${name}" is not an npm package name. Pass the name as installed, such as my-addon or @scope/my-addon.` };
  }
  const packageFolder = join(addonsFolder, 'node_modules', ...name.split('/'));
  if (!existsSync(packageFolder)) {
    return { reason: `${name} is listed with --allow-addon but is not installed in ${join(addonsFolder, 'node_modules')}. Run npm install ${name} in ${addonsFolder}.` };
  }
  const realFolder = realpathSync(packageFolder);
  if (!isInside(addonsFolder, realFolder)) {
    return { reason: `${name} resolves to ${realFolder}, outside the addons folder ${addonsFolder}. Install the package inside that folder instead of linking it from elsewhere.` };
  }
  const { errors } = checkAddon(realFolder, { version });
  if (errors.length > 0) return { reason: `${name} fails the addon contract: ${errors.join(' ')}` };
  const pack = JSON.parse(readFileSync(join(realFolder, 'package.json'), 'utf8'));
  if (pack.name !== name) return { reason: `${name} has package name "${pack.name}" in its package.json. Install the package under its own name.` };
  if (pack['67js'].bundleBytes > MAXIMUM_ADDON_BUNDLE_BYTES) {
    return { reason: `${name} declares bundleBytes ${pack['67js'].bundleBytes}, above the server bound of ${MAXIMUM_ADDON_BUNDLE_BYTES} bytes (2 MiB). Ship a smaller entry file.` };
  }
  const entry = entryOf(pack);
  if (entry === null) return { reason: `${name} names no entry file. Set "exports" (or its "." import condition) or "main" to the ES module that exports registerAddon.` };
  const entryPath = resolve(realFolder, entry);
  if (!existsSync(entryPath)) return { reason: `${name} entry file ${entry} does not exist in the package. Rebuild or reinstall the addon.` };
  const realEntry = realpathSync(entryPath);
  if (!isInside(realFolder, realEntry)) return { reason: `${name} entry file resolves outside the package folder. Point main or exports inside the package.` };
  if (!/\.m?js$/.test(realEntry)) return { reason: `${name} entry file ${entry} must be an ES module ending in .js or .mjs.` };
  if (statSync(realEntry).size > MAXIMUM_ADDON_BUNDLE_BYTES) return { reason: `${name} entry file is above 2 MiB.` };
  return {
    addon: {
      name,
      version: pack.version ?? 'unknown',
      folder: realFolder,
      entry: relative(realFolder, realEntry).split(sep).join('/'),
      extensionPoints: [...pack['67js'].extensionPoints],
    },
  };
}

/**
 * Resolve the allowlisted addons. Returns { addons, skipped } where each skipped item is { name, reason }. A missing or failing
 * addon is skipped and never stops the server. The folder must be an absolute path to an existing directory.
 */
export function resolveAddons({ folder, names = [], version }) {
  if (folder === undefined) {
    if (names.length > 0) throw new Error(`--allow-addon needs --addons <absolute folder> that holds node_modules. Add it, or remove ${names.map(name => `--allow-addon ${name}`).join(' ')}.`);
    return { addons: [], skipped: [] };
  }
  if (typeof folder !== 'string' || !isAbsolute(folder) || !existsSync(folder) || !statSync(folder).isDirectory()) {
    throw new Error('--addons must be an absolute path to an existing folder that holds node_modules.');
  }
  if (names.length > MAXIMUM_ALLOWED_ADDONS) throw new Error(`--allow-addon may be given at most ${MAXIMUM_ALLOWED_ADDONS} times.`);
  const addonsFolder = realpathSync(folder);
  const addons = [];
  const skipped = [];
  for (const name of [...new Set(names)]) {
    const { addon, reason } = loadOne(name, addonsFolder, version);
    if (addon) addons.push(addon);
    else skipped.push({ name, reason });
  }
  return { addons, skipped };
}

/** The file inside an allowlisted addon that a page request names, or null. Checks the real path on every call, so a link swapped in later fails. */
export function addonFileFor(addons, requestPath) {
  const match = /^\/addons\/(\d+)\/(.+)$/.exec(requestPath);
  const addon = match ? addons[Number(match[1])] : undefined;
  if (!addon) return null;
  let decoded;
  try {
    decoded = decodeURIComponent(match[2]);
  } catch {
    return null;
  }
  if (!/\.m?js$/.test(decoded) || decoded.includes('\0') || decoded.includes('\\')) return null;
  try {
    const real = realpathSync(resolve(addon.folder, decoded));
    return isInside(addon.folder, real) ? real : null;
  } catch {
    return null;
  }
}

/** The import map that points the host package specifiers at the page's own engine modules, so an addon shares them. */
export function addonImportMap(exportsField) {
  const imports = {};
  for (const [subpath, target] of Object.entries(exportsField)) {
    if (subpath !== '.' && !subpath.startsWith('./addons/')) continue;
    if (typeof target !== 'string' || !target.startsWith('./build/')) continue;
    imports[subpath === '.' ? CORE_PACKAGE : `${CORE_PACKAGE}/${subpath.slice(2)}`] = `/${target.slice('./build/'.length)}`;
  }
  return { imports };
}

export function addonCapabilities({ addons = [], skipped = [], registered = {}, refused = [] }) {
  return {
    configured: addons.length + skipped.length > 0,
    loaded: addons.map(addon => ({ name: addon.name, version: addon.version, extensionPoints: addon.extensionPoints, registered: registered[addon.name] ?? { controllers: [], cameraRigs: [] } })),
    skipped: [...skipped, ...refused],
    use: 'Set game.player.controller or game.camera to a registered kind name. Addons are chosen by whoever starts the server; no tool loads one.',
  };
}
