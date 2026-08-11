#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectPublishPreflight } from '../core/release/publish-preflight.js';
import { inspectPublishRegistryAuth, isRealNpmPublish } from '../core/release/publish-registry-auth.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// Direct `npm publish` may precede the Git release tag. It still requires a
// clean main checkout that exactly matches live origin/main.
// Source-bound physical receipts remain enforced by `sks release stage` / CI.
const report = inspectPublishPreflight({
  root,
  requireReleaseTag: false,
  requirePhysicalReleaseGates: false,
});

// Reproducibility alone never told the operator whether the package could
// actually be uploaded, so a run passed every stage and then failed on the PUT
// with a 404 that reads like a missing package rather than an expired login.
const publishing = isRealNpmPublish();
const packageName = (() => {
  try {
    return String(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).name || '') || null;
  } catch {
    return null;
  }
})();
const registryAuth = inspectPublishRegistryAuth({ packageName, publishing });

const combined = {
  ...report,
  registry_auth: registryAuth,
  ok: report.ok && registryAuth.ok,
  blockers: [...report.blockers, ...registryAuth.blockers],
};
console.log(JSON.stringify(combined, null, 2));
// Reported separately: a reproducibility blocker and an authentication blocker
// need different actions, and the reproducibility line is a pinned contract.
if (!report.ok) {
  console.error(`npm publish blocked by reproducibility preflight: ${report.blockers.join(', ')}`);
}
if (!registryAuth.ok) {
  console.error(`npm publish blocked by registry auth: ${registryAuth.blockers.join(', ')}`);
  for (const action of registryAuth.operator_actions) console.error(action);
}
if (!combined.ok) process.exitCode = 1;
