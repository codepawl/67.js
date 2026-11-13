import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
export const SITE_FOLDER = 'site';

// The site pages live in site/, but their addresses stay /index.html, /docs.html, /file.html and so on. The dev server answers a
// page address from site/, and the build moves the built pages out of the site/ folder, so dist/ looks as it did when the pages
// sat at the repository root.
export function sitePages() {
  return {
    name: 'site-pages',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const [pathname, query = ''] = request.url.split('?');
        const pageName = pathname === '/' ? 'index.html' : pathname.slice(1);
        const isPageAddress = pageName.endsWith('.html') && !pageName.includes('/');
        if (isPageAddress && existsSync(join(projectRoot, SITE_FOLDER, pageName))) {
          request.url = `/${SITE_FOLDER}/${pageName}${query ? `?${query}` : ''}`;
        }
        next();
      });
    },
    generateBundle: {
      order: 'post',
      handler(options, bundle) {
        const prefix = `${SITE_FOLDER}/`;
        for (const [key, output] of Object.entries(bundle)) {
          if (output.type !== 'asset' || !key.startsWith(prefix) || !key.endsWith('.html')) continue;
          delete bundle[key];
          this.emitFile({ type: 'asset', fileName: key.slice(prefix.length), source: output.source });
        }
      },
    },
  };
}
