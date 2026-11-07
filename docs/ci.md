# CI

`test.yml` runs on every pull request and is called by `publish.yml`, so a release runs the same checks as the pull request that produced it.

## Jobs

All jobs start at once.

| Job | What it runs |
| --- | --- |
| `audit` | `npm audit --audit-level=high` |
| `size` | `npm run size` and `npm run tool-cost` against the pull request base (pull requests only; a release has no base) |
| `unit` (6 shards) | `npm run build:lib`, then `npm run test:coverage` on one third of the test files; uploads its lcov |
| `coverage` | merges the shard lcov files, writes the summary, compares with `coverage-baseline.json`, uploads `lcov` |
| `package` | `prepare:release`, `check:links:package`, `smoke:package`, `smoke:mcp-package` |
| `test` | waits for every job above and fails unless each one succeeded. Branch protection on `main` requires this name. |

`node --test` runs each file in its own process (the Node 24 default, `--test-isolation=process`), so the unit pass is also the isolation check. `npm run test:isolated` stays as a local tool: it runs the same files four at a time and reruns a failure alone.

## Coverage

Coverage comes from Node's built-in `--experimental-test-coverage`. The `coverage` job fails when line, branch or function coverage falls more than 0.5 points below `coverage-baseline.json`. Raise the baseline by editing that file; lower it only on purpose and say why in the pull request. To reproduce locally: `npm run test:coverage -- --test-reporter=lcov --test-reporter-destination=coverage/lcov.info`, then `npm run coverage:gate -- coverage`.

## Add a job or a smoke

1. Add the job to `test.yml`: `actions/checkout`, then `./.github/actions/setup`, then your command. Pin any new action by full SHA.
2. Add its id to `needs` of the `test` job. A job left out of `needs` does not gate `main`.
3. A smoke that needs the packed archive goes in the `package` job after `prepare:release`.
