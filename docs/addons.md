# Addons from other people

A code addon is an npm package that extends 67js through the extension points it already has. 67js's own addons (`67js/addons/*`) are first-party; this page is the contract for third-party ones.

## Security

A code addon runs with the full rights of your page or Node process: it can read files, use the network and change anything in the scene. The MCP server never loads one from a tool call. Install only addons you trust, and read what an addon does before you add it.

## The contract

An addon package:

- lists `@codepawlhq/67js` under `peerDependencies`, so it shares the host's copy instead of bundling its own;
- has `67js-addon` in `keywords`, so a search by that keyword finds it;
- has a SPDX `license`;
- has a `67js` field in `package.json` that states what the addon needs:

```json
"67js": {
  "range": ">=0.19.0 <1.0.0",
  "extensionPoints": ["registerController"],
  "bundleBytes": 2048
}
```

`range` is the 67js versions it was tested with (comparators such as `>=0.19.0 <1.0.0`, or `^0.19.0`). `extensionPoints` lists every point it uses. `bundleBytes` is the size of the entry file named by `main` or `exports`.

The manifest lives in `package.json` rather than a separate `67js-addon.json` because the npm registry returns the whole `package.json` of each version, so a listing can read the range and points without unpacking the tarball, and there is no second file to forget to publish.

## Extension points

These are the ways code can extend 67js today, and the only names the `extensionPoints` list accepts:

| Name | What the addon calls | Import |
| --- | --- | --- |
| `registerController` | `registerController(kind, factory)`: a controller kind (a boat, a ball) | `67js/addons/player` |
| `registerCameraRig` | `registerCameraRig(kind, factory)`: a camera rig kind | `67js/addons/player` |
| `userPass` | a GLSL `userPass(vec2 uv)` fragment set on `renderer.userPasses` ([user passes](user-passes.md)) | `67js/addons/user-pass` |
| `streamingLoader` | `registerLoader(format, loader)` on a streaming instance ([streaming](streaming.md)) | `67js/addons/streaming` |
| `runtimeSystem` | `runtime.addSystem(system)` ([runtime](runtime.md)) | `67js/addons/runtime` |

Kinds and formats cannot be replaced once registered, so pick a name that is unlikely to clash, such as a prefix with your package name.

## Write one

Copy [templates/addon-starter](https://github.com/codepawl/67.js/tree/main/templates/addon-starter). It registers a `hover` controller kind, has a test written with `node:test`, and passes the check below. Export a function that registers, rather than registering on import, so the host decides when.

## Test one

Run your own tests with `@codepawlhq/67js` installed as a dev dependency next to the peer entry. Then check the contract:

```sh
node node_modules/@codepawlhq/67js/scripts/addon-check.mjs . --version 0.19.0
```

The check says what failed and what to pass instead. It tests the keyword, the peer dependency, the license, the `67js` field, the entry size, and that the range allows the version you pass.

## Publish one

`npm publish` the package. Keep `67js-addon` in the keywords and bump the `range` after you test against a new 67js release.
