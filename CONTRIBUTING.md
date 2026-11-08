# Contributing to 67js

This file covers setup, the checks a change must pass, the code style and the release flow.
Coding agents can start with [AGENTS.md](AGENTS.md), the short version. Everyone follows the [code of conduct](CODE_OF_CONDUCT.md).
To ask a question or report a bug, see [SUPPORT.md](SUPPORT.md).

## Set up

1. Install Node.js 20.19 or later (the `Test` workflow uses 24) and Google Chrome.
2. Clone the repository and run `npm ci`.
3. Run `npm run dev`. Vite prints the local URL of the showcase.

The library source is in `src/` and the Node tools and smoke scripts are in `scripts/`.
The tests are in `tests/` and the guides are in `docs/`.
`public/` holds the site assets: previews, CC0 textures and the HDRI.

## Make a change

1. For a large feature, open an issue first with the feature form, so that we agree on the design before you write it. Issues labelled `good first issue` are a good place to start.
2. Create a branch from `main`.
3. Write the change and its tests in the same commit.
4. Update the guide in `docs/` that describes the feature.
5. Add `changes/<issue-or-branch>.md` with your changelog bullet (format in `changes/README.md`). Do not edit `CHANGELOG.md`: two pull requests that edit it conflict on GitHub.
6. Open a pull request. The template asks what changed and how you checked it.

## Checks

Run `npm run preflight` before you open a pull request. It runs every check below that applies to the files you changed, plus the size, tool cost and coverage gates, keeps going after a failure and ends with one line per check and how to fix it. Logs go to `artifacts/preflight/`. `--skip-tests` skips the slow test pass while you iterate.

The checks it runs, if you want one alone:

1. Run `npm test`. All Node tests must pass.
2. Run `npm run check:links` if you changed a Markdown or HTML file. It finds links that point at no file.
3. Run `npm run build`. It builds the site and the viewers into `dist/`.
4. Run `npm run smoke:package` if you changed exports, `package.json` or the build. It installs the packed archive into a clean project.

A renderer or shader change also needs a look at real pixels.
Run `npm run smoke` or the `smoke:*` script for the area that you changed, and look at the screenshots that it saves under `artifacts/`.
A change to skinning, glTF loading, poses or IK also needs `npm run smoke:character`, which takes a real character through the MCP server. Run `npm run prepare:release` first.
Screenshots and other output go to `artifacts/`, which Git ignores.

Every pull request runs `npm audit`, `npm run size`, `npm run tool-cost`, `npm test` (with coverage, eight shards; Node runs each file in its own process), `prepare:release`, `smoke:package` and `smoke:mcp-package` in the `Test` workflow. `smoke:mcp-package` draws through the MCP server on SwiftShader in Chrome. `npm run size` compares every bundle with `origin/main`. If a bundle grows past its allowance (64 bytes gzip for core and the scenes, 2% for the npm archive), add `changes/<issue>.size.md` with the line `- entry:core: <why it is worth the bytes>` and say why in the pull request. Never edit `bench/size/budgets.json` or `baseline.json` in a pull request. `bench/size/README.md` has the details.

`npm run tool-cost` does the same for what the MCP tools cost an agent. If a tool schema grows by more than 64 bytes, a typical result by more than 128 bytes, or the schema total by more than 128 bytes, first move rare detail into `scene_capabilities` or a shared schema. If the growth is worth it, add a line to `changes/<issue>.size.md`, such as `- tool:scene_create: <why it is worth the bytes>`, `- tool-total: <why>` or `- result:scene_capabilities: <why>`. Never edit `bench/tool-cost-budgets.json` in a pull request. `bench/tool-cost-ceilings.json` holds fixed absolute ceilings (the schema total, each tool and the default `scene_capabilities` answer) that fail the check whatever the growth. Put field detail in a `scene_capabilities` topic and keep only the common fields in the tool schema. `bench/tool-cost/README.md` has the details.

Branch protection on `main` requires the `test` check to pass before a merge. Merge a pull request only when `GitGuardian Security Checks` also passes.

These checks need a GPU or a person's eyes, so they do not run on a pull request. The author runs each one that applies:

| Check | Run it when you change |
| --- | --- |
| `npm run smoke:mcp` | MCP tools or the preview, on a GPU |
| `npm run smoke:character` | Skinning, glTF loading, poses or IK |
| `npm run reference` | Shaders, lighting or materials |
| `npm run benchmark:runtime` | The renderer's frame path |
| `scripts/blender-golden.py` | A case in `tests/fixtures/blender/cases.json`, or the Blender version |
| `scripts/blender-easing-golden.py` | An easing curve, or the Blender version |

Do not weaken a test to make it pass. If a test is flaky, find the cause and fix the test or the code.

## Code style

- Use descriptive full names. Write `positionCount`, not `n` or `cnt`. Short names are fine for small loop indices.
- Write one statement on each line. Keep functions small.
- Add a comment only where the reason is not clear from the code.
- Keep the core renderer free of new runtime dependencies. Put optional features in an addon under `src/` and export it as `67js/addons/<name>`.
- Make every scene builder deterministic for the same seed. Tests compare geometry byte for byte.
- Validate input at the public boundary and throw an error that says what failed and what to pass instead.
- Measure a performance claim on matching scenes before you write it in the docs.

## Assets

Use only assets that you can share under CC0 or a license that allows redistribution.
Record the source, the author and the license of each asset in `public/textures/CREDITS.md`.
Keep site assets out of the npm package: the `files` list in `package.json` decides what ships.

`scripts/build-leaf-cards.py` rebuilds the leaf cards in `public/textures/leaves` from the ambientCG atlases. Its header gives the command.

## Release

Maintainers make releases. `package.json` holds the version, and the publish workflow runs when it changes on `main`.

1. Update the version in `package.json` and in `src/version.js`, then run `npm run changes:fold`. It writes the files in `changes/` into `CHANGELOG.md` as that version's section and deletes them. Read `npm run changes` first to see what it will fold. It also deletes the `changes/*.size.md` notes.
2. Run `npm run size:release` and `npm run tool-cost:release`. They reset the size budgets, the baseline and the tool cost ceilings to the release numbers. Read the diffs of `bench/size/budgets.json` and `bench/tool-cost-budgets.json`.
3. Run `npm test`, `npm run build` and `npm run smoke:package`.
4. Commit and push to `main`.
5. Wait for the `Publish 67js` workflow. It tests the package and publishes the new version through the npm trusted publisher.
6. Run `npm run deploy`. It checks that the tree is clean and pushed, builds the site and verifies the live `/release.json`.

## License

By contributing, you agree that your contribution is licensed under the [MIT License](LICENSE).
