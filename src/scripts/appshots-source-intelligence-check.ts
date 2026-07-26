#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertGate, emitGate, importDist, root } from './gate-lib.js';

const mod = await importDist('core/source-intelligence/source-intelligence-runner.js');
const missionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-appshots-source-intelligence-'));
const fixture = writeAppshotFixture(missionDir);
const evidence = await mod.runSourceIntelligence({
  root,
  missionDir,
  route: '$UX-Review',
  query: 'visual Appshots source intelligence',
  offline: true,
  context7Available: true,
  appshots: {
    sourcePaths: [fixture.rel],
    sourceMetadata: [fixture.metadata],
    operatorActionRecorded: true
  }
});
const report = { schema: 'sks.appshots-source-intelligence-check.v1', ok: evidence.ok, evidence };
const out = path.join(root, '.sneakoscope', 'reports', 'appshots-source-intelligence.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);

assertGate(evidence.appshots?.ok === true, 'Source Intelligence must carry Appshots evidence', report);
assertGate(evidence.proof.source_intelligence.appshots_ok === true, 'Source Intelligence proof must mark Appshots ok', report);
assertGate(evidence.appshots?.proof_level === 'fixture_instrumented_real', 'Source Intelligence must not promote fixture Appshots to proven', report);
emitGate('appshots:source-intelligence', { mode: evidence.mode });

function writeAppshotFixture(dir) {
  const file = path.join(dir, 'redacted-appshot-fixture.json');
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
      thread_id: 'thread-fixture-source-intelligence',
      attachment_id: 'attachment-fixture-source-intelligence',
      source_app: 'Codex',
      source_window: 'Fixture Appshot'
    }
  };
}
