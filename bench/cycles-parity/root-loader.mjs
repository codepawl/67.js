// Resolves root-relative imports (/src/*, /bench/*, /packages/*) from the repository root so Node can load reference scenes directly.
const REPOSITORY_ROOT_URL = new URL('../../', import.meta.url);
const ROOT_PREFIXES = ['/src/', '/bench/', '/packages/', '/scripts/'];

function hasRepositoryRootPrefix(specifier) {
  return ROOT_PREFIXES.some((prefix) => specifier.startsWith(prefix));
}

export async function resolve(specifier, context, nextResolve) {
  if (hasRepositoryRootPrefix(specifier)) {
    const resolvedUrl = new URL(specifier.slice(1), REPOSITORY_ROOT_URL).href;
    return nextResolve(resolvedUrl, context);
  }
  return nextResolve(specifier, context);
}
