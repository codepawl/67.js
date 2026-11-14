#!/usr/bin/env node
// Deprecated alias of crucible-addon-check, kept for one release.
import { main } from './crucible-addon-check.mjs';

console.error('67js-addon-check is now crucible-addon-check; the old name goes away in the next release.');
process.exitCode = main(process.argv.slice(2));
