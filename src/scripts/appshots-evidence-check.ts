#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs';
import path from 'node:path';
import { assertGate, emitGate, importDist, root } from './gate-lib.js';

const mod = await importDist('core/source-intelligence/appshots-evidence.js');
const fixture = writeAppshotFixture('evidence');
const evidence = mod.buildAppshotsEvidence({
  root,
  prompt: 'visual Appshots proof',
  sourcePaths: [fixture.rel],
  sourceMetadata: [fixture.metadata],
  operatorActionRecorded: true
});
const report = { schema: 'sks.appshots-evidence-check.v1', ok: evidence.ok, evidence };
const out = path.join(root, '.sneakoscope', 'reports', 'appshots-evidence.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);

assertGate(evidence.ok === true, 'Appshots evidence must pass with source path', report);
assertGate(evidence.status === 'recorded', 'Appshots evidence must mark recorded visual source', report);
assertGate(evidence.proof_level === 'fixture_instrumented_real', 'Appshots fixture evidence must not be promoted to proven', report);
assertGate(evidence.source_verification.every((row) => row.accepted === true), 'Appshots evidence must verify source metadata', report);
emitGate('appshots:evidence', { source_count: evidence.source_count });

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
      thread_id: 'thread-fixture-evidence',
      attachment_id: 'attachment-fixture-evidence',
      source_app: 'Codex',
      source_window: 'Fixture Appshot'
    }
  };
}
