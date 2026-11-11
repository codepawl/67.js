# Maintainers

## Automated first pass

A workflow, `.github/workflows/claude-triage.yml`, has Claude look at every new issue and pull request from someone outside the team. It checks the format against `CONTRIBUTING.md` and the templates, looks for anything unsafe in a pull request, and leaves one comment that it updates in place. Its prompt is `.github/claude/triage-prompt.md`.

### What runs

- Triggers: an issue opened, and a pull request opened or marked ready for review. A push, a reopen or an edit never runs it again, and an item that already has the sticky note is never triaged twice.
- Skipped: drafts, bots, authors who are owner, member or collaborator, anything assigned, anything labeled `status:in-progress`, `hold:look-approval` or `needs-owner-decision`, and anything a maintainer has already commented on or reviewed.
- Limits: an author with more than 3 items in 24 hours is skipped, and so is everything once the workflow has had more than 40 runs in 24 hours. A failed count blocks the run.
- Pause: set the repository variable `TRIAGE_ENABLED` to `false` (Settings, Secrets and variables, Actions, Variables). Nothing else needs editing.
- Before it posts, the gate runs again against the live item, so a maintainer who assigns, labels, comments, closes or merges while Claude is working stops the comment and the labels.

### What it can do

- Read the base branch and the item's text, file list and diff (cut at 200 KB), written to `pr-data/` by a step that holds no Claude secret.
- Return a comment, which a plain step cleans (no pings, HTML, images, links outside this repository and the project site, cross-repository references or token-shaped text; a note that contains the real token, even split or encoded, is withheld) and posts as the single comment marked `claude-triage`. The script writes a fixed header ("not a review, an approval or a security clearance") and quotes Claude's text under it.
- Suggest labels. A plain step adds only these: `needs-triage`, `bug`, `enhancement`, `documentation`, `goal:capable`, `goal:light`, `goal:ai`, and at most one goal label. No label that stops the bot or gates work (`hold:*`, `status:*`) is on the list, and no automation here trusts these labels.

### What it cannot do

- Merge, push, create a branch, edit a file, close or edit an issue or pull request, or remove a label. The job token is `contents: read`, `issues: write`, `pull-requests: write` and nothing else.
- Run a command, write a file, browse the web or use any tool beyond Read, Glob and Grep. Reading `/proc`, `/sys`, `/etc`, the runner's temp, action and config folders and `.git` is denied, and its secrets are scrubbed from the subprocess environment. This is defence in depth, not proof: the action's own security page says prompt injection risk is reduced, not removed. Rotate `CLAUDE_CODE_OAUTH_TOKEN` if you suspect a leak.
- Run code from a pull request. The workflow runs from the base branch and never checks out the pull request head.

Text in an issue or pull request is untrusted, so the prompt treats it as data. Read the comment as a hint, not a verdict: it can be wrong, and a pull request still needs a person to review the diff.

### Taking over

Assign the item to yourself, add `status:in-progress`, `hold:look-approval` or `needs-owner-decision`, or write a comment or review. The bot stops and leaves its last note as it was.

### Setup

1. Run `claude setup-token` and copy the token it prints.
2. Add it as the repository secret `CLAUDE_CODE_OAUTH_TOKEN` (Settings, Secrets and variables, Actions).

Without the secret the job logs one line and does nothing. The workflow takes no other secret; it uses the job's own `GITHUB_TOKEN`.

### Cost

Each run uses the subscription behind that token, with the Sonnet model and at most 6 turns, so a run is small but not free. The body is cut at 16 KB, the diff at 60 KB and a linked issue at 8 KB. The limits above cap a day's spend.

### Trying it without posting

To see what the first pass would say about an item, open the Actions tab, pick "Claude triage", choose "Run workflow" and enter the issue or pull request number. The run applies the same gate and the same Claude step, then prints the comment and the labels it would add to the job log and the step summary. It posts no comment and adds no label. Only people with write access can start it. A dry run works on any item you name, including your own, closed, held or already triaged items, and it runs while `TRIAGE_ENABLED` is `false`, so you can test the bot before turning it on. Only the daily run limit stops it, because it still uses the subscription. The "Decide whether the first pass applies" step prints the reason when it skips.

### Approval wording

The comment is quoted under a fixed header that says it is not a review, an approval or a security clearance. If Claude's text uses a word or phrase such as "safe", "secure", "approved", "LGTM", "ready to merge", "good to merge", "looks good", "no security issues" or "verified" (`APPROVAL_PHRASES` in `scripts/triage-post-comment.mjs`), the text is withheld and the comment only says that a maintainer will review the item.

### Turning it off

Disable the "Claude triage" workflow in the Actions tab, delete the secret, or delete the workflow file. Any of these stops it at once.

### Changing it

Change `.github/claude/triage-prompt.md` to change what Claude checks, and the label list in `scripts/triage-apply-labels.mjs` to change what it may label. `tests/triage-bot.test.js` fails if the workflow gains a write permission or a tool beyond Read, Glob and Grep.
