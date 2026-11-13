import { defineConfig } from 'vite';
import { sitePages } from './vite-site-pages.mjs';

// Editing another scene must not reload an offline render halfway through a film.
export default defineConfig({
  plugins: [sitePages()],
  server: {
    hmr: false,
    watch: { ignored: ['**/*'] },
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
});
