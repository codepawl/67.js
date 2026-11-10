// The time rules and the wording of the `PR metadata` bot. Pure, so tests call it without GitHub.
// The bot keeps one status comment per pull request and finds it by a hidden marker. The marker also holds the time of the
// first failing comment, which starts the 72 hour clock, and the time of the one reminder.
import { NEEDS_OWNER_DECISION_LABEL } from './pr-metadata-check.mjs';

export const STATUS_MARKER = 'pr-metadata-status';
export const REMINDER_MARKER = 'pr-metadata-reminder';
export const CLOSE_MARKER = 'pr-metadata-closed';
export const HOUR_MS = 60 * 60 * 1000;
export const REMINDER_AFTER_HOURS = 48;
export const CLOSE_AFTER_HOURS = 72;

const guideUrl = 'https://github.com/codepawl/67.js/blob/main/CONTRIBUTING.md';

export function buildMarker(name, fields = {}) {
  const pairs = Object.entries(fields)
    .filter(([, value]) => value)
    .map(([key, value]) => `${key}=${value}`);
  return `<!-- ${[name, ...pairs].join(' ')} -->`;
}

// Reads `<!-- name key=value key=value -->` from a comment body, or returns null when the comment has no such marker.
export function parseMarker(commentBody, name) {
  const match = new RegExp(`<!--\\s*${name}((?:\\s+[a-zA-Z]+=\\S+)*)\\s*-->`).exec(commentBody ?? '');
  if (!match) return null;
  const fields = {};
  for (const pair of match[1].trim().split(/\s+/).filter(Boolean)) {
    const separator = pair.indexOf('=');
    fields[pair.slice(0, separator)] = pair.slice(separator + 1);
  }
  return fields;
}

function formatDate(milliseconds) {
  return new Date(milliseconds).toISOString().slice(0, 10);
}

function bulletsOf(contributorFixes) {
  return contributorFixes
    .map(({ message, docsAnchor }) => `- ${message} [How](${guideUrl}#${docsAnchor})`)
    .join('\n');
}

export function renderStatusComment({ contributorFixes, firstFailedAt, reminderSentAt, exempt }) {
  const marker = buildMarker(STATUS_MARKER, { firstFailedAt, reminderSentAt });
  if (contributorFixes.length === 0) {
    return `${marker}\nThank you. The pull request now has everything the guide asks for, and a maintainer will review it as soon as they can.`;
  }
  const closeDate = formatDate(Date.parse(firstFailedAt) + CLOSE_AFTER_HOURS * HOUR_MS);
  const deadline = exempt
    ? 'This is a maintainer pull request, so it will not close by itself.'
    : `If these are still open on ${closeDate}, we close the pull request so the queue stays clear. You can reopen it any time after you fix them.`;
  return [
    marker,
    'Thank you for the pull request. A few small things are missing before a maintainer can review it:',
    '',
    bulletsOf(contributorFixes),
    '',
    `You can fix these by editing the description or pushing a commit. This comment updates itself when you do. ${deadline}`,
    '',
    `Stuck on any of it? Reply here and we will help. The whole flow is in the [contributing guide](${guideUrl}).`,
  ].join('\n');
}

export function renderReminderComment({ contributorFixes, closeDate }) {
  return [
    buildMarker(REMINDER_MARKER),
    `A small reminder: these items are still open, and we close the pull request on ${closeDate} if they stay that way.`,
    '',
    bulletsOf(contributorFixes),
    '',
    'You can reopen it any time after you fix them. Reply here if you need help.',
  ].join('\n');
}

export function renderCloseComment() {
  return [
    buildMarker(CLOSE_MARKER),
    'Thank you for the work on this. We are closing the pull request because the items above stayed open for 3 days. Nothing is lost.',
    '',
    `Once they are fixed, reopen it and the check runs again. Details are in the [contributing guide](${guideUrl}).`,
  ].join('\n');
}

// Decides what the bot does with a pull request that has a status comment (or none).
// previousState is the marker of the status comment: { firstFailedAt, reminderSentAt } or null.
export function decideActions({ now, contributorFixes, previousState, exempt, draft, labels, reopened }) {
  const failing = contributorFixes.length > 0;
  if (!failing) {
    return { statusState: previousState ? {} : null, remind: false, close: false };
  }
  const firstFailedAt = (!reopened && previousState?.firstFailedAt) || new Date(now).toISOString();
  const reminderSentAt = reopened ? undefined : previousState?.reminderSentAt;
  const elapsedHours = (now - Date.parse(firstFailedAt)) / HOUR_MS;
  const protectedFromTimers = exempt || draft || labels.includes(NEEDS_OWNER_DECISION_LABEL);
  const remind = !protectedFromTimers && !reminderSentAt && elapsedHours >= REMINDER_AFTER_HOURS && elapsedHours < CLOSE_AFTER_HOURS;
  const close = !protectedFromTimers && elapsedHours >= CLOSE_AFTER_HOURS;
  return {
    statusState: { firstFailedAt, reminderSentAt: remind ? new Date(now).toISOString() : reminderSentAt },
    remind,
    close,
    closeDate: formatDate(Date.parse(firstFailedAt) + CLOSE_AFTER_HOURS * HOUR_MS),
  };
}
