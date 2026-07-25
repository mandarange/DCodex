#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { assertGate, emitGate, importDist, root } from './gate-lib.js';

const { analyzeHelperDuplication, DEFAULT_MAX_COPIES } = await importDist('core/quality/helper-dedup.js');

// Shrink-only baseline, captured when this gate landed. Every entry is a pure
// helper that was already re-implemented past the ceiling; each may hold or
// shrink, never grow. Delete an entry once its copies reach the ceiling.
//
// Most of the remainder is gate-script boilerplate (`emit`, `assertGate`,
// `emitGate`, `readOption`) that belongs in ./gate-lib.ts, plus small
// fs/env helpers that belong in core/fsx.ts.
const BASELINE: Record<string, number> = {
  emit: 22,
  assertGate: 12,
  emitGate: 10,
  sleep: 9,
  delay: 8,
  unique: 7,
  readJson: 6,
  errorCode: 5,
  restoreEnv: 5,
  asList: 4,
  escapeRegex: 4,
  exists: 4,
  nonEmpty: 4,
  normalizePath: 4,
  normalizeStringList: 4,
  parseJson: 4,
  processIsAlive: 4,
  read: 4,
  readArg: 4,
  readOption: 4,
  rel: 4,
  sha256: 4,
  shellQuote: 4,
  tail: 4,
  walk: 4
};

function collect(dir: string, out: Array<{ path: string; text: string }>) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collect(full, out);
    else if (entry.name.endsWith('.ts')) {
      out.push({ path: path.relative(root, full).split(path.sep).join('/'), text: fs.readFileSync(full, 'utf8') });
    }
  }
  return out;
}

const sources = collect(path.join(root, 'src'), []);
const report = analyzeHelperDuplication(sources, { maxCopies: DEFAULT_MAX_COPIES, baseline: BASELINE });

const shrunk = Object.entries(BASELINE)
  .filter(([name, allowed]) => {
    const current = report.waived.find((group: { name: string }) => group.name === name)?.count ?? 0;
    return current < allowed;
  })
  .map(([name]) => name);

console.log(JSON.stringify({ ...report, baseline_entries: Object.keys(BASELINE).length, shrunk }, null, 2));

if (shrunk.length > 0) {
  console.log(`Baseline can be tightened for: ${shrunk.join(', ')}`);
}

assertGate(
  report.ok,
  'a pure helper is defined identically in more modules than the ceiling allows — export it once and import it',
  report
);
emitGate('quality:helper-dedup', {
  max_copies: report.max_copies,
  scanned_files: report.scanned_files,
  scanned_helpers: report.scanned_helpers,
  baselined: report.waived.length
});
