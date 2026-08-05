#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectPublishPreflight } from '../core/release/publish-preflight.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const dryRun = ['1', 'true'].includes(String(process.env.npm_config_dry_run || process.env.NPM_CONFIG_DRY_RUN || '').toLowerCase());
const report = inspectPublishPreflight({
  root,
  requireReleaseTag: !dryRun,
  requirePhysicalReleaseGates: !dryRun,
});
console.log(JSON.stringify(report, null, 2));
if (!report.ok) {
  console.error(`npm publish blocked by reproducibility preflight: ${report.blockers.join(', ')}`);
  process.exitCode = 1;
}
