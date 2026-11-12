import { spawn } from 'node:child_process';

/** Opens a loopback address in the person's default browser. Only an address the annotate server built is passed in. */
export function openInDefaultBrowser(url) {
  if (!/^http:\/\/127\.0\.0\.1:\d+\/[a-f0-9]+\/$/.test(url)) {
    return Promise.reject(new Error('Only the local annotate address can be opened.'));
  }
  const command = process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  return new Promise((resolve, reject) => {
    const child = spawn(command[0], command[1], { stdio: 'ignore', detached: true, windowsVerbatimArguments: true });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}
