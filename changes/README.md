# Change notes

## Name the file

- `changes/<issue>.md`, such as `changes/199.md`, is the note of a pull request that works on issue 199.
- When one issue gets several pull requests, add a slug: `changes/199-edges.md`.
- A size note adds `.size`: `changes/<issue>.size.md` or `changes/<issue>-<slug>.size.md`.
- A pull request that changes only CI, docs or tests needs no note. Every change under `src/`, `bin/`, `packages/` or `skills/` needs one. The `Test` workflow checks that, and `npm run check:change-note` runs the same check on your machine.

Other docs link here for the rule. Each note holds the changelog bullet exactly as it should read in `CHANGELOG.md`:

```md
- `bar` takes a `foo` option for X (#123)
```

Keep the bullet to one line a user can read in a few seconds: what they can do now, or what got better, and the issue number. Put the measurements, the method and the edge cases in the pull request and the docs, not here. Start a breaking change with `Breaking:`.

A bullet may carry one picture or clip on the line below it: `  media: <url> <alt text>`. The URL is `https://` or a site path starting with `/`, and a `.mp4` or `.webm` plays as a muted loop. The site changelog shows it under the bullet, and `changes:fold` writes it into `CHANGELOG.md` as markdown (an image line, or a link line for a clip) so the GitHub release notes carry it too.

Do not edit `CHANGELOG.md` in a pull request. Two pull requests then never touch the same file, so GitHub has nothing to conflict on.

`npm run changes` prints the pending notes. At release time `npm run changes:fold` writes them into `CHANGELOG.md` as the section for the version in `package.json` and deletes the files. Then edit that section by hand before the release: merge bullets about the same feature, drop internal ones (benchmark scripts, CI, refactors with no visible effect), and sort the rest under `### Highlights`, `### Agents and MCP`, `### Rendering`, `### glTF`, `### Animation and physics`, `### Tools, docs and site` and `### Breaking changes`. The site shows each `###` heading, and every entry under `Breaking changes` gets the breaking mark.

A size note is not a changelog bullet. It accepts a bundle size increase, and `bench/size/README.md` says how. `changes:fold` leaves it out of the changelog and deletes it. The same note accepts a tool cost increase, with lines such as `- tool:scene_create: <reason>`, and `bench/tool-cost/README.md` says how.
