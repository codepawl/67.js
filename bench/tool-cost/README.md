# Tool cost

Every MCP tool schema is read on every turn, so their size is a cost to each agent. `npm run tool-cost` measures three kinds of bytes and compares them with the same numbers on the base branch. The `Test` workflow runs it on every pull request. A pull request never edits a tool cost number, so two pull requests do not conflict over one.

## What it measures

- `tool:<name>`: the description and input schema of one tool.
- `tool-total`: all tool schemas together.
- `result:<name>`: a typical result of one tool, from `scripts/measure-tool-cost.mjs`.

`node scripts/measure-tool-cost.mjs` prints the full report with estimated tokens.

## How the check decides

The check measures the base branch with its own copy of the script, then compares each cost. It reuses the machinery of the size check: the same base ref, the same cache by base commit and the same notes. On your machine the base is `origin/main`, from the commit where your branch left it.

A cost fails when it grows by more than its allowance:

- A tool schema: 64 bytes.
- A typical result: 128 bytes.
- The schema total: 128 bytes.

The allowance is about one short schema field. A change that adds a field to one or two tools passes. A new cost that the base does not have is reported and never fails. A cost that shrinks never fails.

## When a check fails

1. Move rare detail into `scene_capabilities`, or reference a shared schema. This is the best fix, because the schemas are read on every turn and `scene_capabilities` is read once.
2. If the growth is worth its cost, add `changes/<issue>.size.md` to your pull request, with one line for each cost that you accept:

```md
- tool:scene_create: the new environment field costs 90 bytes
- tool-total: the same field
- result:scene_capabilities: its notes are 140 bytes
```

3. State the same reason in the pull request.

The check reads only the notes that your branch adds, so a note from another pull request never accepts your growth. Your note is a new file, so it conflicts with nobody. A size note can hold bundle lines and tool cost lines together.

## Absolute ceilings

`bench/tool-cost-ceilings.json` holds hand-set ceilings for the schema total (100,000 bytes), each large tool, every other tool and the default `scene_capabilities` answer (4,000 bytes). `npm run tool-cost` enforces them on every run, beside the growth check, so the total cannot creep back up in allowed steps. A `size.md` line does not lift them: raising one means editing the file in the pull request, with the reason in the pull request.

Tools list their common fields and a one-line list of the rest. The strict schema still validates every call; scene_capabilities serves the full field outline of each recipe part by topic (`motion`, `environment`, `materialFields`, `meshEdit`, `meshEdit.<op>` and others).

## Release ceilings

`bench/tool-cost-budgets.json` holds the absolute ceilings. They are reported on a pull request and enforced with `npm run tool-cost -- --absolute`. A release refreshes them with `npm run tool-cost:release`, which sets each ceiling 2% over the measured value. Read the diff, because a reset hides growth since the last reset.

The file once held a `measured` note that every pull request extended. It is gone, and `git log -p bench/tool-cost-budgets.json` keeps the history.
