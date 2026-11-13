import { existsSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';

/**
 * Resolves the --jobs folder once at startup. The flag is set by the person who starts the server, never by a tool call, so a
 * junction or symlink they chose (for example a Windows junction to another drive) is followed here and the job store then
 * works on, and is confined to, the real folder it points at. The store still refuses a link as its root, and it never follows
 * links inside it. A folder that does not exist yet is created by the store.
 */
export function resolveJobRoot(jobRoot) {
  if (jobRoot === undefined) return undefined;
  if (typeof jobRoot !== 'string' || !isAbsolute(jobRoot)) {
    throw new TypeError('Job root must be an explicit absolute directory path.');
  }
  if (!existsSync(jobRoot)) return jobRoot;
  let resolved;
  try {
    resolved = realpathSync(jobRoot);
    if (!statSync(resolved).isDirectory()) throw new Error('not a directory');
  } catch (error) {
    throw new Error(`--jobs ${jobRoot} cannot be used (${error.message}). Pass the real, existing directory path, not a link to something else.`);
  }
  return resolved;
}
