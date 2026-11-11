// Lets the reference scenes load their sky in Node: a fetch of a root-relative URL such as /hdri/sky.hdr reads the file from public/.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const originalFetch = globalThis.fetch;
const publicDirectory = new URL('../../public/', import.meta.url);

globalThis.fetch = async function fetchWithPublicFiles(resource, ...rest) {
  const resourceText = typeof resource === 'string' ? resource : resource?.url;
  if (typeof resourceText === 'string' && resourceText.startsWith('/') && !resourceText.startsWith('//')) {
    const bytes = await readFile(fileURLToPath(new URL(resourceText.slice(1), publicDirectory)));
    return new Response(bytes);
  }
  return originalFetch(resource, ...rest);
};
