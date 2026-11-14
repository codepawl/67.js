# Crucible addon starter

A minimal Crucible addon. It registers a `hover` controller kind through `registerController`.

1. Copy this folder, then rename the package in `package.json`.
2. `npm install`, then `npm test`.
3. Check the contract: `npx crucible-addon-check .`
4. `npm publish`. The `crucible-addon` keyword is how the addon is found.

Keep `@codepawlhq/crucible` a peer dependency, list every extension point you use in the `crucible` field, and keep `bundleBytes` at least the size of the entry file. The full guide is [docs/addons.md](https://github.com/codepawl/crucible/blob/main/docs/addons.md).

Install only addons you trust: a code addon runs with the full rights of your page or Node process.
