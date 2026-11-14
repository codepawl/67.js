import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

function run(executable, argumentsList, capture = false) {
  const result = spawnSync(executable, argumentsList, { windowsHide: true, encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit' });
  if (result.status !== 0) throw new Error(`Deployment step failed: ${result.error?.message ?? result.stderr ?? executable}`);
  return result.stdout?.trim();
}

if (run('git', ['status', '--porcelain'], true)) throw new Error('Commit changes before deployment.');
const commit = run('git', ['rev-parse', 'HEAD'], true);
const remoteCommit = run('git', ['ls-remote', 'origin', 'refs/heads/main'], true).split(/\s/)[0];
if (commit !== remoteCommit) throw new Error('Push this commit to origin/main before deployment.');
run(process.execPath, ['scripts/prepare-release.mjs', '--require-clean']);
run(process.execPath, ['node_modules/vite/bin/vite.js', 'build']);
run(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'deploy']);
const release = JSON.parse(await readFile('dist/release.json', 'utf8'));
let response;
let live;
for (let attempt = 0; attempt < 6; attempt++) {
  try {
    response = await fetch(`https://crucible.codepawl.com/release.json?commit=${commit}`, { cache: 'no-store', signal: AbortSignal.timeout(10000) });
    if (response.ok) {
      live = await response.json();
      if (live.commit === commit && live.version === release.version && live.integrity === release.integrity) break;
    }
  } catch (error) {
    if (attempt === 5) throw error;
  }
  console.log('Waiting for the custom domain to serve the release.');
  await delay(5000);
}
if (!response.ok) throw new Error(`Live release verification failed: HTTP ${response.status}.`);
if (live.commit !== commit || live.version !== release.version || live.integrity !== release.integrity) throw new Error('Live release differs from the pushed build.');
console.log(`Verified live ${live.packageName}@${live.version} at ${live.commit}.`);
