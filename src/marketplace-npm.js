// npm's own rule for package names, so a name from the search result cannot steer the manifest request elsewhere.
const NPM_PACKAGE_NAME = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;

/** The registry path of a package: every character encoded, then the scope's @ restored, as the registry expects. */
export function npmManifestPath(name) {
  if (typeof name !== 'string' || name.length > 214 || !NPM_PACKAGE_NAME.test(name)) return null;
  return `${encodeURIComponent(name).replace(/^%40/, '@')}/latest`;
}
