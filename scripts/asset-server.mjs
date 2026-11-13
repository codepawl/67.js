import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

/** An asset above this size is served over HTTP: a Playwright route copies it through the browser protocol, which closes the browser. */
export const LARGE_ASSET_BYTES = 32 * 1024 ** 2;

/**
 * Streams scene assets from disk on 127.0.0.1. `assetPaths` is read on each request, so it can fill after the server starts.
 * The returned `origin` ends in a random token and every request must carry it, so a web page that scans loopback ports
 * cannot read a private asset. Only a Host of 127.0.0.1 or localhost on this port is answered (DNS rebinding), and only
 * `pageOrigin`, the render page, may read the answer cross-origin; with no `pageOrigin` no CORS header is sent.
 */
export function startAssetServer(assetPaths, { pageOrigin } = {}) {
  const token = randomUUID();
  let port = 0;
  const server = createServer((request, response) => {
    const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    const parts = new URL(request.url, 'http://127.0.0.1').pathname.split('/');
    const [, requestToken, kind, indexText] = parts;
    if (!allowedHosts.includes(request.headers.host) || requestToken !== token || kind !== 'asset' || !/^\d+$/.test(indexText ?? '')) {
      response.writeHead(404).end('not found');
      return;
    }
    const file = assetPaths[Number(indexText)];
    if (!file) {
      response.writeHead(404).end('not found');
      return;
    }
    try {
      const headers = {
        'content-type': 'application/octet-stream',
        'content-length': statSync(file).size,
        'cross-origin-resource-policy': 'cross-origin',
      };
      if (pageOrigin) Object.assign(headers, { 'access-control-allow-origin': pageOrigin, vary: 'Origin' });
      response.writeHead(200, headers);
      createReadStream(file).on('error', () => response.destroy()).pipe(response);
    } catch {
      if (!response.headersSent) response.writeHead(500).end('asset unreadable');
      else response.destroy();
    }
  });
  return new Promise((resolveServer, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      const close = () => new Promise(resolveClose => {
        server.close(resolveClose);
        server.closeAllConnections();
      });
      resolveServer({ origin: `http://127.0.0.1:${port}/${token}`, port, close });
    });
  });
}
