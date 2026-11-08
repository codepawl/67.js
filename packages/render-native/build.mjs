// Builds the native addon with cargo and copies it to build/render-native.node.
// Windows must target MSVC: the default GNU toolchain crashes any wgpu 30 program before main.
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageDirectory = dirname(fileURLToPath(import.meta.url));
const targetArguments = process.platform === 'win32' ? ['--target', 'x86_64-pc-windows-msvc'] : [];
const build = spawnSync('cargo', ['build', '--release', ...targetArguments], { cwd: packageDirectory, stdio: 'inherit' });
if (build.status !== 0) process.exit(build.status ?? 1);

const releaseDirectory = join(packageDirectory, 'target', ...(targetArguments.length > 0 ? [targetArguments[1]] : []), 'release');
const libraryName = { win32: 'render_native.dll', darwin: 'librender_native.dylib', linux: 'librender_native.so' }[process.platform];
mkdirSync(join(packageDirectory, 'build'), { recursive: true });
copyFileSync(join(releaseDirectory, libraryName), join(packageDirectory, 'build', 'render-native.node'));
console.log('Built build/render-native.node');
