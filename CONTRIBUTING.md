# Contributing to 67js

This file covers setup, how to send a change, the checks it must pass, the code style and the release flow.
Coding agents can start with [AGENTS.md](AGENTS.md), the short version. Everyone follows the [code of conduct](CODE_OF_CONDUCT.md).
To ask a question or report a bug, see [SUPPORT.md](SUPPORT.md).
A maintainer gives a first answer to every issue and pull request within about 7 days.
Coding agents are welcome to open pull requests. There is no disclosure box: the person who opens the pull request answers for it.

## Set up

1. Install Node.js 20.19 or later (the `Test` workflow uses 24) and Google Chrome.
2. Clone the repository and run `npm ci`.
3. Run `npm run dev`. Vite prints the local URL of the showcase.

The library source is in `src/` and the Node tools and smoke scripts are in `scripts/`.
The tests are in `tests/` and the guides are in `docs/`.
`public/` holds the site assets: previews, CC0 textures and the HDRI.

## Make a change

1. Pick an issue. Issues labelled `good first issue` or `help wanted` are good places to start. For a large feature with no issue, open one with the feature form first. We then agree on the design before you write it.
2. Comment on the issue that you take it, so that two people do not build the same thing.
3. Fork the repository (`gh repo fork codepawl/67.js --clone`) and create a branch from `main` named `<issue>-<short-slug>`, such as `412-mesh-bevel`.
4. Write the change and its tests in the same commit, and update the guide in `docs/` that describes the feature.
5. Add a change note (see [Change notes](#change-notes)). Do not edit `CHANGELOG.md`: two pull requests that edit it conflict on GitHub.
6. Run `npm run preflight`, then push and open a pull request. The template asks what changed and how you checked it.

Name the pull request `<imperative sentence> (#<issue>)`, such as `Add mesh bevel to scene_edit_mesh (#412)`. Keep one change in each pull request.

### Link the issue

Write `Closes #123` in the description when the pull request finishes the issue. Write `Part of #123` when it is one step of a larger issue. Issues are for work to do, so there is no tracking issue to link.

### Change notes

Every change under `src/`, `bin/`, `packages/` or `skills/` adds `changes/<issue>.md` with one changelog bullet. When one issue gets several pull requests, add a slug: `changes/<issue>-<slug>.md`. A size note is `changes/<issue>.size.md` or `changes/<issue>-<slug>.size.md`. CI, docs-only and test-only pull requests need no note. [changes/README.md](changes/README.md) has the format.

The `Test` workflow runs this check on every pull request, so `git push --no-verify` does not skip it.

### Describe how you checked it

Under **How I checked it** (or **Ran**, **Checks**, **Tests**, **Verification**), paste the commands you ran and what they printed. A line such as `npm run preflight: 14 checks ok` is enough. This applies to agents too: show the commands and their results.

### Keep private data out

Issues and pull requests are public. Leave out local paths (a Windows user folder, or a home folder under `/home` or `/Users`), tokens and personal data. Use a path inside the repository instead.

## Checks

Run `npm run preflight` before you open a pull request. It runs every check below that applies to the files you changed, plus the size, tool cost and coverage gates, keeps going after a failure and ends with one line per check and how to fix it. Logs go to `artifacts/preflight/`. `--skip-tests` skips the slow test pass while you iterate.

`npm ci` points git at `.githooks/`, whose pre-push hook runs `npm run preflight -- --skip-tests` and stops the push when a gate fails. Pushing only tags or branch deletions skips it. To skip it once, run `SKIP_PREFLIGHT=1 git push` in Bash or `$env:SKIP_PREFLIGHT=1; git push` in PowerShell. `git push --no-verify` skips it too. The unit tests stay out of the hook because they take minutes; run the full preflight before you open the pull request.

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

Branch protection on `main` requires the `test` check to pass before a merge. `GitGuardian Security Checks` is an external check that must also pass.

These checks need a GPU or a person's eyes, so they do not run on a pull request. The author runs each one that applies:

| Check | Run it when you change |
| --- | --- |
| `npm run smoke:mcp` | MCP tools or the preview, on a GPU |
| `npm run smoke:character` | Skinning, glTF loading, poses or IK |
| `npm run reference` | Shaders, lighting or materials |
| `npm run benchmark:runtime` | The renderer's frame path |
| `scripts/blender-golden.py` | A case in `tests/fixtures/blender/cases.json`, or the Blender version |
| `scripts/blender-easing-golden.py` | An easing curve, or the Blender version |

### Tool schema and skill changes

A change to an MCP tool, its schema or a skill under `skills/` also needs the agent bench. A longer schema can lower how often an agent succeeds. Run Haiku alone, because it reacts first, and compare it with the baseline:

```sh
node bench/agent-modeling/bench.mjs --models haiku --runs 3 --label <branch> --backend cpu
node bench/agent-modeling/compare-bench.mjs bench/agent-modeling/results/bench-baseline.json bench/agent-modeling/results/bench-<branch>.json
```

Paste the table into the pull request. The bench runs through a Claude Code login. Without one, write "I have no Claude Code login; a maintainer runs the bench." in the pull request and a maintainer runs it. If the tool schemas did not change, write "The tool schemas are unchanged." Only `skills/` and `scripts/mcp-server.mjs` trigger this check. [bench/agent-modeling/README.md](bench/agent-modeling/README.md) has the details.

### Look changes

A change to shaders, lighting, materials, the default render or a post step changes how every scene looks. Add a before and an after picture to the pull request. A bot adds the label `hold:look-approval`. Only the owner removes it, and nothing with that label merges.

### Who runs the GPU and person checks

You run the checks in the table above that apply, when you can. When you cannot (for example, you have no GPU), say so in the pull request. A maintainer runs them and adds the label `status:needs-gpu-check`. The merge waits for them only for look and renderer changes.

Do not weaken a test to make it pass. If a test is flaky, find the cause and fix the test or the code.

## Labels and milestones

The maintainer sets labels and the milestone, so you do not need to. Every issue has one goal and one priority:

- `goal:capable`, `goal:light` or `goal:ai` say which part of the [goal](docs/goal.md) the work serves.
- `priority:must`, `priority:should` or `priority:could` say how soon.
- `bug`, `enhancement` or `documentation` say what kind of work it is.

The milestones are `0 Measure`, `1 Lighter`, `2 Modeling`, `3 Look`, `4 Motion and simulation`, `5 Agent surface` and `6 Games`. [docs/goal.md](docs/goal.md) explains each one. A pull request that misses a label or the milestone gets `needs-triage` until the maintainer sets them.

## Review and merge

Only the maintainer merges. There is no required review and no auto-merge. A pull request merges when the `test` check passes, `GitGuardian Security Checks` passes, and the maintainer has looked at it. [CODEOWNERS](.github/CODEOWNERS) lists the maintainer.

## The pull request check

The `PR metadata` workflow checks each pull request against this guide. It posts one friendly comment that lists what is missing, with a link to the section that explains each item. The checks are:

- The description links an issue and says how you checked.
- Shipped code has a change note.
- Tool and skill changes have a bench table.
- Look changes have a picture.
- The description holds no local path.

Docs-only, CI-only and test-only pull requests skip everything except the local path check.

- The comment updates itself when you fix an item. One reminder follows after 5 days.
- A maintainer gives a first answer within about 7 days. That reply time is separate from the bot clock, which counts only items on your side. If an item is still open 7 days after the first comment (the end of that UTC day, weekends included), the bot closes the pull request. It invites you to reopen it once the item is fixed, and reopening starts the time again.
- Pull requests from the owner, members, collaborators and bots never close by themselves. Drafts and pull requests labelled `needs-owner-decision` do not close either.
- Labels and the milestone never count against you. The bot adds `needs-triage` when they are missing and `status:needs-author` while something of yours is missing.

For maintainers: the workflow is `.github/workflows/pr-metadata.yml`, and the rules are the pure modules `scripts/pr-metadata-check.mjs` (what is missing) and `scripts/pr-metadata-flow.mjs` (the clock and the wording). The workflow runs on `pull_request_target`, so it never checks out or runs the code of the pull request. It reads the description and the file list through the API only. Do not change that. It is not a required check.

To test a change to the rules, run `node --test tests/pr-metadata-check.test.js`. To see what the bot would do on the real repository without changing anything, run the workflow by hand: `gh workflow run pr-metadata.yml -f dry_run=true`, then read the log. A run with `dry_run=false` sweeps every open pull request.

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

1. Update the version in `package.json` and in `src/version.js`, run `npm run plugin:sync` to copy it into `.claude-plugin/marketplace.json`, then run `npm run changes:fold`. It writes the files in `changes/` into `CHANGELOG.md` as that version's section and deletes them. Read `npm run changes` first to see what it will fold. It also deletes the `changes/*.size.md` notes.
2. Run `npm run size:release` and `npm run tool-cost:release`. They reset the size budgets, the baseline and the tool cost ceilings to the release numbers. Read the diffs of `bench/size/budgets.json` and `bench/tool-cost-budgets.json`.
3. Run `npm test`, `npm run build` and `npm run smoke:package`.
4. Commit and push to `main`.
5. Wait for the `Publish 67js` workflow. It tests the package and publishes the new version through the npm trusted publisher.
6. Run `npm run deploy`. It checks that the tree is clean and pushed, builds the site and verifies the live `/release.json`.

## License

By contributing, you agree that your contribution is licensed under the [MIT License](LICENSE).
