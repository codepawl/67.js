// Node test reporter that writes how long each test file took, as JSON: { "tests/x.test.js": milliseconds }.
// Use: node --test --test-reporter=./scripts/test-timing-reporter.mjs --test-reporter-destination=timings.json <files>
// scripts/shard-test-files.mjs reads the committed copy (test-timings.json) to balance the shards.
import { relative } from 'node:path';

export default async function* timingReporter(source) {
  const millisecondsByFile = new Map();
  for await (const event of source) {
    if (event.type !== 'test:pass' && event.type !== 'test:fail') continue;
    const { file, nesting, details, name } = event.data;
    if (!file || nesting !== 0) continue;
    const relativeFile = relative(process.cwd(), file).split('\\').join('/');
    // Top-level tests of a file add up; the file's own entry (named after the file) already covers all of them.
    const isFileEntry = name === file || name === relativeFile;
    const previous = millisecondsByFile.get(relativeFile) ?? 0;
    millisecondsByFile.set(
      relativeFile,
      isFileEntry ? Math.max(previous, details.duration_ms) : previous + details.duration_ms
    );
  }
  const sorted = Object.fromEntries(
    [...millisecondsByFile.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([file, ms]) => [file, Math.round(ms)])
  );
  yield `${JSON.stringify(sorted, null, 2)}\n`;
}
