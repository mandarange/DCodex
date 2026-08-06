#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectPublishPreflight } from '../core/release/publish-preflight.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// Direct `npm publish` may precede the Git release tag. It still requires a
// clean main checkout that exactly matches live origin/main.
// Source-bound physical receipts remain enforced by `sks release stage` / CI.
const report = inspectPublishPreflight({
  root,
  requireReleaseTag: false,
  requirePhysicalReleaseGates: false,
});
console.log(JSON.stringify(report, null, 2));
if (!report.ok) {
  console.error(`npm publish blocked by reproducibility preflight: ${report.blockers.join(', ')}`);
  process.exitCode = 1;
}
