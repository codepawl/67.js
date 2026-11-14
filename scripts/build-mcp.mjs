import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { constants, setPriority } from 'node:os';
import { isBuiltin } from 'node:module';
import { dirname, resolve, join, relative, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import libraryConfiguration, { MCP_BUILD_RUNNING } from '../config/vite.lib.config.js';

// This script reruns the library configuration in memory; the flag keeps that run from rebuilding build/mcp again.
process.env[MCP_BUILD_RUNNING] = '1';

const root = fileURLToPath(new URL('..', import.meta.url));

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function packageAt(directory) {
  const metadataPath = join(directory, 'package.json');
  if (!existsSync(metadataPath)) return null;
  return { directory, metadata: JSON.parse(await readFile(metadataPath, 'utf8')) };
}

async function dependencyFor(moduleId) {
  if (!moduleId.includes('node_modules')) return null;
  let directory = dirname(moduleId.split('?')[0]);
  while (directory !== dirname(directory)) {
    const dependency = await packageAt(directory);
    if (dependency?.metadata.name && dependency.metadata.version) return dependency;
    directory = dirname(directory);
  }
  return null;
}

async function collectLicenses(chunks) {
  const dependencies = new Map();
  const embedded = new Map();
  const rootsByModule = new Map();
  for (const chunk of chunks) {
    for (const [moduleId, information] of Object.entries(chunk.modules)) {
      if (information.renderedLength === 0) continue;
      let dependency = rootsByModule.get(moduleId);
      if (dependency === undefined) {
        dependency = await dependencyFor(moduleId);
        rootsByModule.set(moduleId, dependency);
      }
      if (!dependency) continue;
      const key = `${dependency.metadata.name}@${dependency.metadata.version}`;
      dependencies.set(key, dependency);
      // The SDK ships prebundled dependencies whose module roots are invisible to Rolldown.
      if (!dependency.metadata.name.startsWith('@modelcontextprotocol/')) continue;
      const source = await readFile(moduleId.split('?')[0], 'utf8');
      for (const match of source.matchAll(/\/\/#[rR]egion [^\n]*\/\.pnpm\/([^/]+)\/node_modules\/(?:@[^/]+\/)?[^/]+\//g)) {
        const encoded = match[1].split('_')[0];
        const versionOffset = encoded.lastIndexOf('@');
        if (versionOffset < 1) continue;
        const name = encoded.slice(0, versionOffset).replace('+', '/');
        const version = encoded.slice(versionOffset + 1);
        if (!/^\d+\.\d+\.\d+/.test(version)) continue;
        embedded.set(`${name}@${version}`, { name, version, bundledBy: key });
      }
    }
  }
  const gaps = [];
  const embeddedNotices = [];
  for (const [key, dependency] of embedded) {
    if (dependencies.has(key)) continue;
    const installed = await packageAt(join(root, 'node_modules', dependency.name));
    if (installed?.metadata.version === dependency.version) {
      dependencies.set(key, installed);
    } else {
      const filename = join(root, 'licenses', 'mcp', `${dependency.name.replaceAll('/', '_')}-${dependency.version}.txt`);
      if (existsSync(filename)) {
        const contents = await readFile(filename, 'utf8');
        embeddedNotices.push(`## ${key}\n\n${contents}`);
        dependency.licenseFile = relative(root, filename).replaceAll('\\', '/');
        dependency.licenseSha256 = digest(Buffer.from(contents));
      } else {
        gaps.push({ ...dependency, reason: 'Exact prebundled dependency license is unavailable in installed package roots or licenses/mcp.' });
      }
    }
  }
  const projectLicense = await readFile(join(root, 'LICENSE'), 'utf8');
  const notices = [`# MCP bundle licenses\n\n## ${JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).name}\n\n${projectLicense}`];
  const records = [];
  for (const [key, dependency] of [...dependencies].sort(([left], [right]) => left.localeCompare(right))) {
    const filenames = (await readdir(dependency.directory)).filter(name => /^(?:licen[sc]e|copying|notice)(?:[.-].*)?$/i.test(name)).sort();
    if (!filenames.some(name => /^(?:licen[sc]e|copying)/i.test(name))) {
      gaps.push({ name: dependency.metadata.name, version: dependency.metadata.version, reason: 'Installed package root has no complete license file.' });
    }
    records.push({ name: dependency.metadata.name, version: dependency.metadata.version, license: dependency.metadata.license ?? null, licenseFiles: filenames });
    for (const filename of filenames) {
      notices.push(`## ${key}: ${filename}\n\n${await readFile(join(dependency.directory, filename), 'utf8')}`);
    }
  }
  return { text: `${[...notices, ...embeddedNotices].join('\n\n')}\n`, dependencies: records, embeddedDependencies: [...embedded.values()], licenseGaps: gaps };
}

function singleModule(result, filename) {
  const outputs = (Array.isArray(result) ? result : [result]).flatMap(bundle => bundle.output);
  if (outputs.length !== 1 || outputs[0].type !== 'chunk' || !outputs[0].isEntry || outputs[0].fileName !== filename) {
    throw new Error(`${filename} must be exactly one self-contained entry module, without additional assets or chunks.`);
  }
  const chunk = outputs[0];
  for (const specifier of chunk.imports) {
    if (!isBuiltin(specifier) && specifier !== 'playwright-core') {
      throw new Error(`${filename} has an unexpected external import: ${specifier}.`);
    }
  }
  for (const specifier of chunk.dynamicImports) {
    // Rolldown retains a self import to initialize inlined lazy modules without an extra chunk.
    // manifold-3d is an optional peer dependency loaded on demand.
    if (specifier !== filename && specifier !== 'manifold-3d' && specifier !== '@dimforge/rapier3d-compat' && !isBuiltin(specifier) && specifier !== 'playwright-core') {
      throw new Error(`${filename} has an unexpected dynamic import: ${specifier}.`);
    }
  }
  return chunk;
}

const PREVIEW_ENTRY_FILE = 'mcp/preview.js';

/**
 * The preview page is an entry of the library build, so it shares chunks with the package entries instead of
 * carrying its own copy of the engine. Rebuild the library in memory to learn which chunks the preview reaches,
 * then check them on disk, because the manifest and the license notices must cover exactly those files.
 */
async function reachablePreviewChunks(build, libraryDirectory) {
  const libraryResult = await build({
    ...libraryConfiguration,
    configFile: false,
    logLevel: 'silent',
    build: { ...libraryConfiguration.build, write: false, emptyOutDir: false },
  });
  const chunksByName = new Map();
  for (const bundle of Array.isArray(libraryResult) ? libraryResult : [libraryResult]) {
    for (const output of bundle.output) {
      if (output.type === 'chunk') chunksByName.set(output.fileName, output);
    }
  }
  const reached = new Map();
  const pending = [PREVIEW_ENTRY_FILE];
  while (pending.length) {
    const fileName = pending.pop();
    if (reached.has(fileName)) continue;
    const chunk = chunksByName.get(fileName);
    if (!chunk) continue;
    reached.set(fileName, chunk);
    pending.push(...chunk.imports, ...chunk.dynamicImports);
  }
  if (!reached.has(PREVIEW_ENTRY_FILE)) {
    throw new Error(`The library build has no ${PREVIEW_ENTRY_FILE} entry.`);
  }
  const chunks = [];
  for (const [fileName, chunk] of reached) {
    const bytes = await readFile(join(libraryDirectory, fileName));
    chunks.push({ fileName, chunk, bytes });
  }
  return chunks;
}

function requireProjectSubdirectory(directory, label) {
  const absolute = resolve(root, directory);
  const offset = relative(root, absolute);
  if (!offset || offset === '..' || offset.startsWith(`..`) || isAbsolute(offset)) {
    throw new Error(`${label} must be a dedicated subdirectory of the project root.`);
  }
  return absolute;
}

// libraryDir is the folder the library build wrote, which holds the preview chunks; measure-archive.mjs points both
// folders at its own staging package so it never rewrites build/ while something else reads it.
export async function buildMcp({ outDir = join(root, 'build', 'mcp'), libraryDir = join(root, 'build') } = {}) {
  const destination = requireProjectSubdirectory(outDir, 'MCP output');
  const libraryDirectory = requireProjectSubdirectory(libraryDir, 'The library build folder');
  setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL);
  const { build } = await import('vite');
  const metadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const revision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, windowsHide: true, encoding: 'utf8' });
  if (revision.status !== 0) throw new Error('Git source commit is unavailable. Build from the release checkout.');
  const status = spawnSync('git', ['status', '--porcelain', '--untracked-files=normal'], { cwd: root, windowsHide: true, encoding: 'utf8' });
  if (status.status !== 0) throw new Error('Git source status is unavailable. Build from the release checkout.');
  const configuration = {
    root,
    configFile: false,
    logLevel: 'silent',
    publicDir: false,
    build: { write: false, copyPublicDir: false, emptyOutDir: false, outDir: destination, sourcemap: false, minify: true },
  };
  const legalBanner = '/*! Crucible MCP bundle. Complete license texts and notices: ./LICENSES.md */';
  const previewChunks = await reachablePreviewChunks(build, libraryDirectory);
  const server = singleModule(await build({
    ...configuration,
    resolve: {
      conditions: ['node', 'import', 'default'],
      mainFields: ['main', 'module'],
      alias: { '@modelcontextprotocol/server/_shims': join(root, 'scripts', 'mcp-sdk-shims.mjs') },
    },
    build: {
      ...configuration.build,
      target: 'node20',
      lib: { entry: join(root, 'scripts', 'mcp-server.mjs'), formats: ['es'], fileName: () => 'server.mjs' },
      rolldownOptions: {
        platform: 'node',
        external: specifier => isBuiltin(specifier) || specifier === 'playwright-core' || specifier === 'manifold-3d' || specifier === '@dimforge/rapier3d-compat',
        output: { codeSplitting: false, comments: { legal: true }, banner: legalBanner },
      },
    },
  }), 'server.mjs');
  // The scene engine runs in the preview page; bundling it into the server again would cost ~120 KB of the npm
  // archive's 1 MiB budget for code the server never calls.
  for (const marker of ['ExtrudeGeometry', 'extrudeFaceRegion', 'createAgentScene']) {
    if (server.code.includes(marker)) {
      throw new Error(`server.mjs includes scene engine code (${marker}). Import plain data from agent-scene-capabilities.js instead of agent-scene.js.`);
    }
  }
  // bin/crucible-mcp.mjs imports each of these from the bundle.
  const requiredExports = ['createAgentMcpServer', 'runMcpCli', 'runCheckUpdateCli'];
  const missingExports = requiredExports.filter(name => !server.exports.includes(name));
  if (missingExports.length > 0) {
    throw new Error(`Node bundle must export ${missingExports.join(', ')}.`);
  }
  const licenses = await collectLicenses([...previewChunks.map(({ chunk }) => chunk), server]);
  const previewEntry = previewChunks.find(({ fileName }) => fileName === PREVIEW_ENTRY_FILE);
  const files = new Map([['preview.js', previewEntry.bytes], ['server.mjs', server.code], ['LICENSES.md', licenses.text]]);
  const outputs = [...files].map(([filename, text]) => {
    const bytes = Buffer.from(text);
    return { filename, bytes: bytes.length, sha256: digest(bytes) };
  });
  const manifest = {
    schemaVersion: 1,
    packageName: metadata.name,
    packageVersion: metadata.version,
    sourceCommit: revision.stdout.trim(),
    sourceDirty: Boolean(status.stdout.trim()),
    nodeTarget: 'node20',
    buildTool: { name: 'vite', version: (await packageAt(join(root, 'node_modules', 'vite'))).metadata.version },
    externalDependencies: [{ name: 'playwright-core', version: (await packageAt(join(root, 'node_modules', 'playwright-core'))).metadata.version }],
    dependencies: licenses.dependencies,
    embeddedDependencies: licenses.embeddedDependencies,
    licenseGaps: licenses.licenseGaps,
    outputs,
    previewChunks: previewChunks
      .filter(({ fileName }) => fileName !== PREVIEW_ENTRY_FILE)
      .map(({ fileName, bytes }) => ({ filename: fileName, bytes: bytes.length, sha256: digest(bytes) }))
      .sort((left, right) => left.filename.localeCompare(right.filename)),
  };
  await mkdir(destination, { recursive: true });
  for (const [filename, contents] of files) {
    await writeFile(join(destination, filename), contents);
  }
  await writeFile(join(destination, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const gap of licenses.licenseGaps) {
    console.error(`MCP license gap: ${gap.name}@${gap.version}. ${gap.reason}`);
  }
  if (licenses.licenseGaps.length) {
    throw new Error('MCP build has unresolved license gaps. Inspect manifest.json and supply the exact installed license texts.');
  }
  console.error(`Built MCP preview and server for ${metadata.name}@${metadata.version}. Manifest: ${join(destination, 'manifest.json')}`);
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const argumentsList = process.argv.slice(2);
  const optionNames = { '--out-dir': 'outDir', '--library-dir': 'libraryDir' };
  const options = {};
  let valid = argumentsList.length % 2 === 0;
  for (let index = 0; valid && index < argumentsList.length; index += 2) {
    const name = optionNames[argumentsList[index]];
    if (!name || name in options) valid = false;
    else options[name] = argumentsList[index + 1];
  }
  if (!valid) {
    console.error('Use node scripts/build-mcp.mjs [--out-dir <project subdirectory>] [--library-dir <project subdirectory>].');
    process.exitCode = 1;
  } else {
    buildMcp(options).catch(error => {
      console.error(error.message);
      process.exitCode = 1;
    });
  }
}
