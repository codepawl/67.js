// Packs the library the way a release does and prints the archive size: node scripts/measure-archive.mjs --json
// The base measurement of the size check runs it inside a checkout of the base branch, so the numbers come from the base source.
// It builds the library and the MCP server like prepare-release.mjs, then asks npm for the size of the archive without writing one.
// Each run builds into its own staging package under build/ and packs that, so it never rewrites build/ or build/mcp while
// another process (a live MCP test, a preview) reads them. build/ is ignored by git, so the MCP manifest still sees a clean tree.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, copyFileSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

function run(arguments_, { capture = false, cwd } = {}) {
  const result = spawnSync(process.execPath, arguments_, { cwd, encoding: 'utf8', windowsHide: true, stdio: capture ? 'pipe' : ['ignore', 2, 2], maxBuffer: MAX_OUTPUT_BYTES });
  if (result.status !== 0) throw new Error(`${arguments_.join(' ')} failed: ${result.stderr ?? ''}`);
  return result.stdout;
}

// The MCP build records the source commit and refuses a folder that is not a repository. The unpacked base branch is one folder
// of files, so it gets a throwaway repository with one commit, which is clean like a release checkout.
function ensureRepository() {
  if (existsSync('.git')) return;
  const identity = ['-c', 'user.name=archive', '-c', 'user.email=archive@example.com', '-c', 'commit.gpgsign=false'];
  for (const command of [['init', '-q'], ['add', '-A'], [...identity, 'commit', '-q', '-m', 'base']]) {
    const result = spawnSync('git', command, { encoding: 'utf8', windowsHide: true, maxBuffer: MAX_OUTPUT_BYTES });
    if (result.status !== 0) throw new Error(`git ${command.join(' ')} failed: ${result.stderr}`);
  }
}

function packedFiles(npmCli, cwd) {
  const packResult = JSON.parse(run([npmCli, 'pack', '--ignore-scripts', '--dry-run', '--json'], { capture: true, cwd }));
  return Array.isArray(packResult) ? packResult[0] : Object.values(packResult)[0];
}

// The staging package holds package.json, every packed file outside build/ and its own fresh build/, so npm applies the same
// files list, exclusions included, to the same contents a release would pack.
function copyPackageSources(npmCli, stagingRoot) {
  for (const { path } of packedFiles(npmCli, '.').files) {
    if (path.startsWith('build/')) continue;
    const destination = join(stagingRoot, path);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(path, destination);
  }
}

// The Vite builds a release runs before npm pack, in the order prepare-release.mjs runs them. The library build empties the
// output folder and the standalone module is written beside it. A base branch from before the standalone module has no
// vite.browser.config.js, so it is measured without one.
export const RELEASE_VITE_CONFIGS = ['vite.lib.config.js', 'vite.browser.config.js'];

export function viteBuildArguments(outputFolder, configExists = existsSync) {
  const presentConfigs = RELEASE_VITE_CONFIGS.filter(config => configExists(config));
  return presentConfigs.map(config => {
    const viteArguments = ['node_modules/vite/bin/vite.js', 'build', '--config', config];
    if (!outputFolder) return viteArguments;
    viteArguments.push('--outDir', outputFolder);
    if (config === RELEASE_VITE_CONFIGS[0]) viteArguments.push('--emptyOutDir');
    return viteArguments;
  });
}

function buildLibrary(outputFolder) {
  for (const viteArguments of viteBuildArguments(outputFolder)) run(viteArguments);
}

// The base measurement runs this script inside a throwaway checkout of the base branch, whose build-mcp.mjs may predate
// --library-dir. Nothing else reads that checkout, so building in place there is safe and measures the same way.
function measureInPlace(npmCli) {
  buildLibrary(null);
  run(['scripts/build-mcp.mjs']);
  return packedFiles(npmCli, '.').size;
}

export function measureArchiveBytes() {
  ensureRepository();
  const npmCli = process.env.npm_execpath ?? resolve(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
  if (!readFileSync('scripts/build-mcp.mjs', 'utf8').includes('--library-dir')) return measureInPlace(npmCli);
  mkdirSync('build', { recursive: true });
  const stagingRoot = mkdtempSync(join('build', '.archive-'));
  try {
    const stagingBuild = join(stagingRoot, 'build');
    buildLibrary(stagingBuild);
    run(['scripts/build-mcp.mjs', '--out-dir', join(stagingBuild, 'mcp'), '--library-dir', stagingBuild]);
    copyPackageSources(npmCli, stagingRoot);
    return packedFiles(npmCli, stagingRoot).size;
  } finally {
    rmSync(stagingRoot, { recursive: true, force: true });
  }
}

// Only when this file is the script that runs: measure-size.mjs imports it and has its own --json output.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href && process.argv.includes('--json')) {
  process.stdout.write(JSON.stringify({ archiveBytes: measureArchiveBytes() }));
}
