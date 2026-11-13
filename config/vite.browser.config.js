import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

// One self-contained ES module with no relative chunk import. It lands in build/ beside the library files, so the npm package
// carries it and a CDN that mirrors npm (jsdelivr, unpkg) serves it from a single URL. The library build runs first and empties
// build/, so this build must not empty it again. The site copies the same bytes to /releases/<version>/67.module.js.
export const STANDALONE_FILE_NAME = '67.standalone.js';

export default defineConfig({
  build: {
    copyPublicDir: false,
    emptyOutDir: false,
    rolldownOptions: { output: { banner: `/*! ${readFileSync('LICENSE', 'utf8')} */` } },
    outDir: 'build',
    lib: { entry: 'src/index.js', formats: ['es'], fileName: () => STANDALONE_FILE_NAME },
    minify: true,
  },
});
