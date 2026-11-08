// HDRI environments and .cube looks a recipe names. A recipe never carries a path or a URL: it names one of the entries
// shipped in assets/looks, or the SHA-256 ID of a .hdr or .cube file in the MCP asset catalog. The host (the MCP runtime,
// or an app that calls the register functions) decodes the file and registers it here before the scene builds.

/** Environment maps shipped in assets/looks as 128 x 64 Radiance files (Poly Haven CC0, shrunk; THIRD-PARTY-NOTICES.md). */
export const BUNDLED_ENVIRONMENT_NAMES = Object.freeze(['sky-clouds', 'studio-softbox']);

/** .cube looks shipped in assets/looks (made for 67js, CC0): 9 points per side. */
export const BUNDLED_CUBE_LOOK_NAMES = Object.freeze(['teal-orange', 'noir']);

export const CATALOG_FILE_ID = /^[a-f0-9]{64}$/;
export const MAXIMUM_CATALOG_LOOK_BYTES = 4 * 1024 * 1024;

const environmentSources = new Map();
let registrationCount = 0;
const cubeLooks = new Map();

export function isEnvironmentReference(reference) {
  return BUNDLED_ENVIRONMENT_NAMES.includes(reference) || CATALOG_FILE_ID.test(reference);
}

export function isCubeLookReference(reference) {
  return BUNDLED_CUBE_LOOK_NAMES.includes(reference) || CATALOG_FILE_ID.test(reference);
}

/** Registers decoded Radiance data ({ width, height, data } from parseRadianceHdr) under a bundled name or catalog ID. */
export function registerCatalogEnvironment(reference, decoded) {
  if (!isEnvironmentReference(reference)) throw new RangeError(`environment.hdri must be one of ${BUNDLED_ENVIRONMENT_NAMES.join(', ')} or the 64-character ID of a .hdr file in the asset catalog.`);
  environmentSources.set(reference, decoded);
  registrationCount++;
}

/** Registers a parsed look ({ size, data } from parseCube) under a bundled name or catalog ID. */
export function registerCatalogLook(reference, look) {
  if (!isCubeLookReference(reference)) throw new RangeError(`A .cube look must be one of ${BUNDLED_CUBE_LOOK_NAMES.join(', ')} or the 64-character ID of a .cube file in the asset catalog.`);
  cubeLooks.set(reference, look);
}

/** The registered look for a name that is not one of the built-in looks. */
export function catalogLook(reference) {
  const look = cubeLooks.get(reference);
  if (!look) throw new Error(`The .cube look ${reference.slice(0, 16)} is not loaded: the host registers it with registerCatalogLook (the MCP runtime does this from the asset catalog).`);
  return look;
}

/** Changes whenever an HDRI is registered, so a map cache can drop maps built from older data. */
export function environmentRegistrationCount() {
  return registrationCount;
}

/** The decoded data registered for an HDRI reference. */
export function catalogEnvironmentSource(reference) {
  const source = environmentSources.get(reference);
  if (!source) throw new Error(`The HDRI ${reference.slice(0, 16)} is not loaded: the host registers it with registerCatalogEnvironment (the MCP runtime does this from assets/looks or the asset catalog).`);
  return source;
}

/** The catalog references a recipe or edit list uses: `{ environments, looks }`, each a sorted list of unique strings. */
export function catalogLookReferences(value) {
  const environments = new Set();
  const looks = new Set();
  const visit = node => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    const environment = node.environment;
    if (environment && typeof environment === 'object' && !Array.isArray(environment)) {
      if (typeof environment.hdri === 'string') environments.add(environment.hdri);
      if (typeof environment.look === 'string' && isCubeLookReference(environment.look)) looks.add(environment.look);
    }
    Object.values(node).forEach(visit);
  };
  visit(value);
  return { environments: [...environments].sort(), looks: [...looks].sort() };
}
