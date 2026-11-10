# Maintainers

## Automated first pass

A workflow, `.github/workflows/claude-triage.yml`, has Claude look at every new issue and pull request from someone outside the team. It checks the format against `CONTRIBUTING.md` and the templates, looks for anything unsafe in a pull request, and leaves one comment that it updates in place. Its prompt is `.github/claude/triage-prompt.md`.

### What runs

- Triggers: an issue opened or reopened, and a pull request opened, reopened, marked ready for review or pushed to.
- Skipped: drafts, bots, authors who are owner, member or collaborator, anything assigned, anything labeled `status:in-progress`, `hold:look-approval` or `needs-owner-decision`, and anything a maintainer has already commented on or reviewed.
- One run per item at a time; a newer push cancels the older run.

### What it can do

- Read the base branch and the item's text, file list and diff (cut at 200 KB), written to `pr-data/` by a step that holds no Claude secret.
- Return a comment, which a plain step cleans (no pings, images, HTML or token-shaped text) and posts or updates as the single comment marked `claude-triage`.
- Suggest labels. A plain step adds only these: `needs-triage`, `bug`, `enhancement`, `documentation`, `goal:capable`, `goal:light`, `goal:ai`, `status:needs-author`, `hold:look-approval`, and at most one goal label.

### What it cannot do

- Merge, push, create a branch, edit a file, close or edit an issue or pull request, or remove a label. The job token is `contents: read`, `issues: write`, `pull-requests: write` and nothing else.
- Run a command, write a file, browse the web or use any tool beyond Read, Glob and Grep. Its secrets are scrubbed from the subprocess environment.
- Run code from a pull request. The workflow runs from the base branch and never checks out the pull request head.

Text in an issue or pull request is untrusted, so the prompt treats it as data. Read the comment as a hint, not a verdict: it can be wrong, and a pull request still needs a person to review the diff.

### Taking over

Assign the item to yourself, add `status:in-progress`, or write a comment or review. The bot stops from then on and leaves its last note as it was. Adding `hold:look-approval` or `needs-owner-decision` also stops it.

### Setup

1. Run `claude setup-token` and copy the token it prints.
2. Add it as the repository secret `CLAUDE_CODE_OAUTH_TOKEN` (Settings, Secrets and variables, Actions).

Without the secret the job logs one line and does nothing. The workflow takes no other secret; it uses the job's own `GITHUB_TOKEN`.

### Cost

Each run uses the subscription behind that token, with the Sonnet model and at most 8 turns, so a run is small but not free. Many first-time contributors in a day add up on the owner's quota.

### Turning it off

Disable the "Claude triage" workflow in the Actions tab, delete the secret, or delete the workflow file. Any of these stops it at once.

### Changing it

Change `.github/claude/triage-prompt.md` to change what Claude checks, and the label list in `scripts/triage-apply-labels.mjs` to change what it may label. `tests/triage-bot.test.js` fails if the workflow gains a write permission or a tool beyond Read, Glob and Grep.
