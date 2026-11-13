import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { sitePages } from '../scripts/vite-site-pages.mjs';

function rewrittenAddress(address) {
  let handler;
  sitePages().configureServer({ middlewares: { use: (middleware) => { handler = middleware; } } });
  const request = { url: address };
  handler(request, {}, () => {});
  return request.url;
}

test('the dev server answers a page address from site/', () => {
  assert.equal(rewrittenAddress('/'), '/site/index.html');
  assert.equal(rewrittenAddress('/docs.html'), '/site/docs.html');
  assert.equal(rewrittenAddress('/file.html?export=1&width=640'), '/site/file.html?export=1&width=640');
});

test('addresses that are not site pages are left alone', () => {
  assert.equal(rewrittenAddress('/nope.html'), '/nope.html');
  assert.equal(rewrittenAddress('/bench/runtime-loop/index.html'), '/bench/runtime-loop/index.html');
  assert.equal(rewrittenAddress('/src/file-scene.js'), '/src/file-scene.js');
});

test('the build writes each page at the output root, not under site/', () => {
  const emitted = [];
  const bundle = {
    'site/docs.html': { type: 'asset', source: '<html>docs</html>' },
    'site/nested/other.html': { type: 'asset', source: '<html>nested</html>' },
    'assets/app.js': { type: 'chunk' },
  };
  sitePages().generateBundle.handler.call({ emitFile: (file) => emitted.push(file) }, {}, bundle);
  assert.deepEqual(emitted.map(file => file.fileName).sort(), ['docs.html', 'nested/other.html']);
  assert.deepEqual(Object.keys(bundle), ['assets/app.js']);
});

test('the repository root holds no site page', () => {
  const rootPages = readdirSync(new URL('..', import.meta.url)).filter(name => name.endsWith('.html'));
  assert.deepEqual(rootPages, []);
});
