import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';

/** An asset above this size is served over HTTP: a Playwright route copies it through the browser protocol, which closes the browser. */
export const LARGE_ASSET_BYTES = 32 * 1024 ** 2;

/**
 * Streams scene assets from disk on 127.0.0.1. `assetPaths` is read on each request, so it can fill after the server starts.
 * The headers let a page served with Cross-Origin-Embedder-Policy: require-corp read the answer.
 */
export function startAssetServer(assetPaths) {
  const server = createServer((request, response) => {
    const index = Number(new URL(request.url, 'http://127.0.0.1').pathname.split('/')[2]);
    const file = assetPaths[index];
    if (!file) {
      response.writeHead(404).end('not found');
      return;
    }
    response.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': statSync(file).size,
      'access-control-allow-origin': '*',
      'cross-origin-resource-policy': 'cross-origin',
    });
    createReadStream(file).on('error', () => response.destroy()).pipe(response);
  });
  return new Promise((resolveServer, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const origin = `http://127.0.0.1:${server.address().port}`;
      const close = () => new Promise(resolveClose => {
        server.close(resolveClose);
        server.closeAllConnections();
      });
      resolveServer({ origin, close });
    });
  });
}
