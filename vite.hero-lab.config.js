import { defineConfig } from 'vite';

// Builds only the hero prototype page so its bundle bytes can be measured as shipped (minified, split by scene):
//   npx vite build --config vite.hero-lab.config.js && npx vite preview --config vite.hero-lab.config.js --port 5196
export default defineConfig({
  build: {
    outDir: 'artifacts/hero-lab-dist',
    emptyOutDir: true,
    rolldownOptions: { input: { heroB: 'hero-b.html', heroLoop: 'hero-loop.html' } },
  },
  preview: { host: '127.0.0.1' },
});
