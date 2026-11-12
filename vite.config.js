import { defineConfig } from 'vite';
import fs from 'node:fs';
import path from 'node:path';

const headers = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

// VITE_LOCAL_FOLDERS lists folders (separated by the platform path delimiter) that the dev server also serves, read only, under
// /@local/<folder name>/..., for example the folder of a GLB opened in bench/flicker/index.html. Unset, nothing outside the project
// is served. Vite's own /@fs/ route cannot reach another drive on Windows.
function serveLocalFolders() {
  const folders = (process.env.VITE_LOCAL_FOLDERS ?? '').split(path.delimiter).filter(Boolean).map(folder => path.resolve(folder));
  return {
    name: 'serve-local-folders',
    configureServer(server) {
      server.middlewares.use('/@local', (request, response, next) => {
        const relative = decodeURIComponent(new URL(request.url, 'http://localhost').pathname).replace(/^\//, '');
        const [folderName, ...rest] = relative.split('/');
        const root = folders.find(folder => path.basename(folder) === folderName);
        const file = root && path.resolve(root, ...rest);
        if (!file || !file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return next();
        response.setHeader('Content-Type', 'application/octet-stream');
        response.setHeader('Content-Length', fs.statSync(file).size);
        fs.createReadStream(file).pipe(response);
      });
    },
  };
}

export default defineConfig({
  plugins: [serveLocalFolders()],
  server: { headers, watch: { ignored: ['**/.claude/**'] } },
  // Scan only the project's own pages. Agent worktrees under .claude hold hundreds of copies of them and made the first page load take 13 s.
  // The browser denoiser page imports `denoiser`, which is installed by hand (bench/reference/denoise-browser.mjs). Scanning it
  // failed the whole scan, so gl-matrix was found at runtime and Vite reloaded pages in the middle of tests (issue #314).
  optimizeDeps: {
    entries: ['*.html', 'bench/**/*.html', '!bench/reference/denoise-browser/**'],
    include: ['gl-matrix'],
  },
  preview: { headers },
  build: {
    rolldownOptions: {
      input: {
        home: 'index.html',
        downloads: 'downloads.html',
        object: 'object.html',
        nature: 'nature.html',
        film: 'film.html',
        motion: 'motion.html',
        modeling: 'modeling.html',
        view2d: 'view2d.html',
        assets: 'assets.html',
        guide: 'getting-started.html',
        docs: 'docs.html',
        changelog: 'changelog.html',
        showcase: 'showcase.html',
        marketplace: 'marketplace.html',
      },
    },
  },
});
