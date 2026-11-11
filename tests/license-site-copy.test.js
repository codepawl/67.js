import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('public/license.txt is byte-identical to LICENSE', async () => {
  const repositoryLicense = await readFile(new URL('../LICENSE', import.meta.url));
  const siteLicense = await readFile(new URL('../public/license.txt', import.meta.url));
  assert.ok(
    repositoryLicense.equals(siteLicense),
    'public/license.txt differs from LICENSE; copy LICENSE over it so the site shows the same text',
  );
});
