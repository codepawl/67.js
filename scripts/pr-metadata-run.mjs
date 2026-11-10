// GitHub glue of the `PR metadata` workflow. It reads a pull request and its file list through the API, never checks out the
// pull request's code, and runs the pure rules of pr-metadata-check.mjs and pr-metadata-flow.mjs on them.
// `github` is the Octokit client that actions/github-script passes in. Tests pass a fake with the same few methods.
import { checkPullRequest, isAutoCloseExempt, LOOK_HOLD_LABEL } from './pr-metadata-check.mjs';
import {
  CLOSE_MARKER,
  REMINDER_MARKER,
  STATUS_MARKER,
  decideActions,
  parseMarker,
  renderCloseComment,
  renderReminderComment,
  renderStatusComment,
} from './pr-metadata-flow.mjs';

const BOT_LOGIN = 'github-actions[bot]';

function toCheckInput(pullRequest, files) {
  return {
    pr: {
      body: pullRequest.body ?? '',
      title: pullRequest.title,
      author: pullRequest.user?.login ?? '',
      authorAssociation: pullRequest.author_association,
      labels: pullRequest.labels.map(label => label.name),
      milestone: pullRequest.milestone?.title ?? null,
      draft: Boolean(pullRequest.draft),
    },
    files: files.map(file => ({ filename: file.filename, additions: file.additions, deletions: file.deletions })),
  };
}

// The owner may remove hold:look-approval. Add it only if it was never added, so a removal sticks.
async function labelWasEverAdded({ github, repo, number, label }) {
  const events = await github.paginate(github.rest.issues.listEvents, { ...repo, issue_number: number, per_page: 100 });
  return events.some(event => event.event === 'labeled' && event.label?.name === label);
}

export async function checkOnePullRequest({ github, repo, number, now, reopened, dryRun, log }) {
  const { data: pullRequest } = await github.rest.pulls.get({ ...repo, pull_number: number });
  if (pullRequest.state !== 'open') return { skipped: 'closed' };
  const files = await github.paginate(github.rest.pulls.listFiles, { ...repo, pull_number: number, per_page: 100 });
  const input = toCheckInput(pullRequest, files);
  const result = checkPullRequest(input);
  const exempt = isAutoCloseExempt(input.pr);
  const comments = await github.paginate(github.rest.issues.listComments, { ...repo, issue_number: number, per_page: 100 });
  const statusComment = comments.find(comment => comment.user?.login === BOT_LOGIN && parseMarker(comment.body, STATUS_MARKER));
  const previousState = statusComment ? parseMarker(statusComment.body, STATUS_MARKER) : null;
  const decision = decideActions({
    now,
    contributorFixes: result.contributorFixes,
    previousState,
    exempt,
    draft: input.pr.draft,
    labels: input.pr.labels,
    reopened,
  });

  const act = async (description, action) => {
    log(`${dryRun ? '[dry run] ' : ''}#${number}: ${description}`);
    if (!dryRun) await action();
  };

  let addLabels = result.addLabels;
  if (addLabels.includes(LOOK_HOLD_LABEL) && await labelWasEverAdded({ github, repo, number, label: LOOK_HOLD_LABEL })) {
    addLabels = addLabels.filter(label => label !== LOOK_HOLD_LABEL);
  }
  if (addLabels.length > 0) {
    await act(`add labels ${addLabels.join(', ')}`, () => github.rest.issues.addLabels({ ...repo, issue_number: number, labels: addLabels }));
  }
  for (const label of result.removeLabels) {
    await act(`remove label ${label}`, async () => {
      try {
        await github.rest.issues.removeLabel({ ...repo, issue_number: number, name: label });
      } catch (error) {
        if (error.status !== 404) throw error;
      }
    });
  }

  // The owner, maintainers and bots get the report in the job summary only. A comment would read as a warning to them.
  if (!exempt && decision.statusState) {
    const body = renderStatusComment({ contributorFixes: result.contributorFixes, exempt, ...decision.statusState });
    if (!statusComment) {
      await act('post the status comment', () => github.rest.issues.createComment({ ...repo, issue_number: number, body }));
    } else if (statusComment.body !== body) {
      await act('update the status comment', () => github.rest.issues.updateComment({ ...repo, comment_id: statusComment.id, body }));
    }
  }
  if (decision.remind) {
    await act('post the reminder', () => github.rest.issues.createComment({
      ...repo,
      issue_number: number,
      body: renderReminderComment({ contributorFixes: result.contributorFixes, closeDate: decision.closeDate }),
    }));
  }
  if (decision.close) {
    await act('close the pull request', async () => {
      await github.rest.issues.createComment({ ...repo, issue_number: number, body: renderCloseComment() });
      await github.rest.pulls.update({ ...repo, pull_number: number, state: 'closed' });
    });
  }
  return { result, decision, exempt };
}

export async function runPullRequestCheck({ github, context, core, now = Date.now() }) {
  const repo = context.repo;
  const dryRun = process.env.PR_METADATA_DRY_RUN === '1';
  const log = message => core.info(message);
  const failures = [];

  if (context.eventName === 'pull_request_target') {
    const outcome = await checkOnePullRequest({
      github,
      repo,
      number: context.payload.pull_request.number,
      now,
      reopened: context.payload.action === 'reopened',
      dryRun,
      log,
    });
    if (outcome.result?.contributorFixes.length) {
      failures.push(...outcome.result.contributorFixes.map(item => `${item.id}: ${item.message}`));
    }
  } else {
    const openPullRequests = await github.paginate(github.rest.pulls.list, { ...repo, state: 'open', per_page: 100 });
    for (const pullRequest of openPullRequests) {
      try {
        await checkOnePullRequest({ github, repo, number: pullRequest.number, now, reopened: false, dryRun, log });
      } catch (error) {
        core.warning(`#${pullRequest.number}: ${error.message}`);
      }
    }
  }

  if (failures.length > 0) {
    await core.summary.addHeading('Pull request metadata').addList(failures).write();
    core.setFailed(`The pull request needs ${failures.length} fix${failures.length === 1 ? '' : 'es'}. Details are in the summary and the bot comment.`);
  }
}
