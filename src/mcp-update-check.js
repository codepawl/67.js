// Tells the MCP server whether a newer @codepawlhq/crucible exists on npm. The one request goes to a fixed URL, runs in the
// background, is cached for a day and never throws: offline, a slow registry or a bad answer leave the server as it was.
import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const UPDATE_CHECK_URL = 'https://registry.npmjs.org/@codepawlhq/crucible/latest';
export const UPDATE_CHECK_TIMEOUT_MS = 2000;
export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const RELEASE_NOTES_BASE = 'https://github.com/codepawl/crucible/releases/tag/v';
const STABLE_VERSION = /^\d{1,9}\.\d{1,9}\.\d{1,9}$/;

// Any one of these turns the check off. CI counts as set when it holds any text other than 0 or false.
export function updateCheckDisabled(env = process.env) {
  const flagged = name => env[name] !== undefined && env[name] !== '' && env[name] !== '0';
  return flagged('SIXTYSEVENJS_NO_UPDATE_CHECK') || flagged('NO_UPDATE_NOTIFIER') || (flagged('CI') && env.CI !== 'false');
}

function versionParts(version) {
  return version.split('.').map(Number);
}

// True when `latest` is a newer stable x.y.z than `current`. A pre-release or odd string on either side is never newer.
export function isNewerVersion(latest, current) {
  const currentCore = String(current).split('-')[0];
  if (!STABLE_VERSION.test(latest) || !STABLE_VERSION.test(currentCore)) {
    return false;
  }
  const latestParts = versionParts(latest);
  const currentParts = versionParts(currentCore);
  for (let index = 0; index < 3; index += 1) {
    if (latestParts[index] !== currentParts[index]) {
      return latestParts[index] > currentParts[index];
    }
  }
  return String(current).includes('-');
}

export function updateCachePath(env = process.env, platform = process.platform) {
  const base = env.XDG_CACHE_HOME
    || (platform === 'win32' && env.LOCALAPPDATA ? env.LOCALAPPDATA : join(homedir(), '.cache'));
  return join(base, 'crucible', 'update-check.json');
}

export function buildUpdateAvailable(current, latest) {
  return {
    current,
    latest,
    releaseNotes: `${RELEASE_NOTES_BASE}${latest}`,
    update: {
      plugin: 'Run /plugin marketplace update Crucible, then /plugin update crucible@crucible, then restart the client.',
      npx: 'Run npx -y -p @codepawlhq/crucible@latest crucible-mcp --version once, then restart the client.',
      project: 'Run npm install @codepawlhq/crucible@latest (or crucible@npm:@codepawlhq/crucible@latest) in the project, then restart the client.',
    },
    ask: 'Tell the user a newer Crucible exists and ask whether to update. Run an update command only after they say yes.',
  };
}

export function updateNoticeText(updateAvailable) {
  return ` A newer Crucible is out (running ${updateAvailable.current}, latest ${updateAvailable.latest}; notes ${updateAvailable.releaseNotes}). Tell the user and ask whether to update; do not update on your own. Commands per install route are in the updateAvailable field of the first scene_capabilities result.`;
}

function readCache(cachePath) {
  try {
    const cached = JSON.parse(readFileSync(cachePath, 'utf8'));
    // latest is null after a failed request: the day still counts, so an offline user is asked once a day, not every start.
    if (typeof cached.checkedAt === 'number' && (cached.latest === null || STABLE_VERSION.test(cached.latest))) {
      return cached;
    }
  } catch {
    // A missing or damaged cache is the same as no cache.
  }
  return null;
}

async function fetchLatestVersion(fetchImpl, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(UPDATE_CHECK_URL, { signal: controller.signal, headers: { accept: 'application/json' } });
    if (!response.ok) {
      return null;
    }
    const body = await response.json();
    return typeof body.version === 'string' && STABLE_VERSION.test(body.version) ? body.version : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Reads the cache at once and refreshes it in the background when it is over a day old. `current()` gives the newest
// answer so far (null when up to date or unknown); `settled` resolves when the refresh ends and never rejects.
export function startUpdateCheck({
  currentVersion,
  env = process.env,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  cachePath = updateCachePath(env),
  timeoutMs = UPDATE_CHECK_TIMEOUT_MS,
} = {}) {
  let latest = null;
  let settled = Promise.resolve();
  if (!updateCheckDisabled(env) && typeof fetchImpl === 'function') {
    const cached = readCache(cachePath);
    latest = cached?.latest ?? null;
    if (cached === null || now() - cached.checkedAt >= UPDATE_CHECK_INTERVAL_MS || cached.checkedAt > now()) {
      settled = refreshCache({ fetchImpl, now, cachePath, timeoutMs, previousLatest: latest }).then(found => {
        latest = found ?? latest;
      }).catch(() => {});
    }
  }
  return {
    current: () => (latest !== null && isNewerVersion(latest, currentVersion) ? buildUpdateAvailable(currentVersion, latest) : null),
    settled,
  };
}

async function refreshCache({ fetchImpl, now, cachePath, timeoutMs, previousLatest }) {
  const found = await fetchLatestVersion(fetchImpl, timeoutMs);
  try {
    await mkdir(dirname(cachePath), { recursive: true });
    await writeFile(cachePath, JSON.stringify({ checkedAt: now(), latest: found ?? previousLatest }));
  } catch {
    // An unwritable cache only means the next start asks again.
  }
  return found;
}

// `crucible-mcp --check-update`: one explicit request, ignores the cache and the off switches, prints and returns.
export async function describeUpdateCheck({ currentVersion, fetchImpl = globalThis.fetch, timeoutMs = UPDATE_CHECK_TIMEOUT_MS }) {
  const found = await fetchLatestVersion(fetchImpl, timeoutMs);
  const lines = [`current ${currentVersion}`];
  if (found === null) {
    lines.push('latest unknown (the npm registry did not answer)');
  } else {
    lines.push(`latest ${found}`);
    lines.push(isNewerVersion(found, currentVersion) ? `update available: ${RELEASE_NOTES_BASE}${found}` : 'up to date');
  }
  return lines.join('\n');
}
