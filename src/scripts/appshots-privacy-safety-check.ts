#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs';
import path from 'node:path';
import { assertGate, emitGate, importDist, root } from './gate-lib.js';

const mod = await importDist('core/source-intelligence/appshots-evidence.js');
const fixture = writeAppshotFixture('privacy');
const evidence = mod.buildAppshotsEvidence({
  root,
  prompt: 'visual Appshots privacy',
  sourcePaths: [fixture.rel],
  sourceMetadata: [fixture.metadata],
  operatorActionRecorded: true
});
const policy = evidence.operator_policy.privacy_safety;
const report = { schema: 'sks.appshots-privacy-safety-check.v1', ok: evidence.privacy_safety_ok, policy };
const out = path.join(root, '.sneakoscope', 'reports', 'appshots-privacy-safety.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);

assertGate(evidence.privacy_safety_ok === true, 'Appshots privacy safety must pass', report);
assertGate(policy.avoid_secrets_and_credentials === true, 'Appshots privacy safety must avoid secrets', report);
assertGate(evidence.source_verification.every((row) => row.redacted && row.local_only), 'Appshots privacy safety must verify redacted local-only sources', report);
emitGate('appshots:privacy-safety', { privacy_safety_ok: evidence.privacy_safety_ok });

function writeAppshotFixture(name) {
  const dir = path.join(root, '.sneakoscope', 'reports', 'appshots-fixtures');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.redacted-appshot.json`);
  fs.writeFileSync(file, `${JSON.stringify({ fixture: true, redacted: true, text: '[redacted appshot fixture]' })}\n`);
  const rel = path.relative(root, file).split(path.sep).join('/');
  return {
    rel,
    metadata: {
      path: rel,
      source_type: 'codex_appshot',
      origin: 'fixture',
      operator_attached: true,
      frontmost_window: true,
      redacted: true,
      local_only: true,
      fixture: true,
      thread_id: 'thread-fixture-privacy',
      attachment_id: 'attachment-fixture-privacy',
      source_app: 'Codex',
      source_window: 'Fixture Appshot'
    }
  };
}
