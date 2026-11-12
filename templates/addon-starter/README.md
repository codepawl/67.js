# 67js addon starter

A minimal 67js addon. It registers a `hover` controller kind through `registerController`.

1. Copy this folder, then rename the package in `package.json`.
2. `npm install`, then `npm test`.
3. Check the contract: `node node_modules/@codepawlhq/67js/scripts/addon-check.mjs .`
4. `npm publish`. The `67js-addon` keyword is how the addon is found.

Keep `@codepawlhq/67js` a peer dependency, list every extension point you use in the `67js` field, and keep `bundleBytes` at least the size of the entry file. The full guide is [docs/addons.md](https://github.com/codepawl/67.js/blob/main/docs/addons.md).

Install only addons you trust: a code addon runs with the full rights of your page or Node process.
