// Reads a TAP report from `node --test --test-reporter=tap` and writes a Markdown table of how many tests ran, passed,
// failed and were skipped, with the skip reasons, so a green check says what it did not run (#1146).
// A test that failed with "the GPU device was lost" is counted apart: the software Vulkan adapter of CI (lavapipe) reports ray
// query support but loses the device on the first trace, so those tests need a real GPU and say nothing about the code.
// A test whose child process draws on the GPU and only reports an exit code can be named with --gpu-bound "<test name>" (repeatable) to be counted there.
// Exit code: 1 when any other test failed, 0 otherwise.
// Usage: node scripts/summarize-addon-tests.mjs <report.tap> [--title "<heading>"] [--gpu-bound "<test name>"]...
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DEVICE_LOST = /GPU device was lost/;
const TEST_LINE = /^(\s*)(not ok|ok) \d+ - (.*?)(?: # (SKIP|skip|TODO|todo)\b ?(.*))?$/;

/** Counts the leaf tests of a TAP report. A parent line follows its deeper-indented subtests in TAP, so one that does so is a suite or a file, not a test. */
export function countTapTests(reportText, gpuBoundNames = []) {
  const entries = [];
  for (const line of reportText.split(/\r?\n/)) {
    const match = TEST_LINE.exec(line);
    if (match === null) {
      if (entries.length > 0 && DEVICE_LOST.test(line)) entries.at(-1).deviceLost = true;
      continue;
    }
    entries.push({
      depth: match[1].length,
      failed: match[2] === 'not ok',
      name: match[3],
      deviceLost: gpuBoundNames.includes(match[3]),
      skipReason: match[4]?.toLowerCase() === 'skip' ? match[5].trim() || 'no reason given' : null,
    });
  }
  const counts = { passed: 0, failed: 0, deviceLost: 0, skipped: 0, skipReasons: new Map() };
  entries.forEach((entry, index) => {
    const previous = entries[index - 1];
    const isParent = previous !== undefined && previous.depth > entry.depth;
    if (isParent) return;
    if (entry.skipReason !== null) {
      counts.skipped += 1;
      counts.skipReasons.set(entry.skipReason, (counts.skipReasons.get(entry.skipReason) ?? 0) + 1);
    } else if (entry.failed && entry.deviceLost) {
      counts.deviceLost += 1;
    } else if (entry.failed) {
      counts.failed += 1;
    } else {
      counts.passed += 1;
    }
  });
  return counts;
}

export function formatSummary(counts, title) {
  const total = counts.passed + counts.failed + counts.deviceLost + counts.skipped;
  const lines = [`### ${title}`, '', '| Result | Tests |', '| --- | ---: |'];
  lines.push(`| ran and passed | ${counts.passed} |`);
  lines.push(`| ran and failed | ${counts.failed} |`);
  lines.push(`| lost the GPU device on the software adapter (need a real GPU) | ${counts.deviceLost} |`);
  lines.push(`| skipped | ${counts.skipped} |`);
  lines.push(`| total | ${total} |`, '');
  if (counts.skipReasons.size > 0) {
    lines.push('Skipped because:', '');
    const sorted = [...counts.skipReasons].sort((first, second) => second[1] - first[1]);
    for (const [reason, count] of sorted) lines.push(`- ${count} x ${reason}`);
    lines.push('');
  }
  return lines.join('\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const reportPath = process.argv[2];
  if (!reportPath) {
    console.error('Pass the path of a TAP report: node scripts/summarize-addon-tests.mjs <report.tap> [--title "<heading>"]');
    process.exit(2);
  }
  const titleIndex = process.argv.indexOf('--title');
  const title = titleIndex > 0 ? process.argv[titleIndex + 1] : 'Addon tests';
  const gpuBoundNames = process.argv.flatMap((argument, index) => (argument === '--gpu-bound' ? [process.argv[index + 1]] : []));
  const counts = countTapTests(readFileSync(reportPath, 'utf8'), gpuBoundNames);
  console.log(formatSummary(counts, title));
  process.exit(counts.failed > 0 ? 1 : 0);
}
