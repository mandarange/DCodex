#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs';
import path from 'node:path';
import { assertGate, emitGate, importDist, root } from './gate-lib.js';

const detector = await importDist('core/codex/appshots-detector.js');
const evidenceMod = await importDist('core/source-intelligence/appshots-evidence.js');
const fixture = writeAppshotFixture();
const threadAttachments = [
  {
    thread_id: 'thread-appshot-001',
    attachment_id: 'att-appshot-001',
    kind: 'appshot',
    mime_type: 'image/png',
    source_app: 'Codex',
    source_window: 'Release Fixture',
    local_only: true,
    codex_appshot: true
  },
  {
    thread_id: 'thread-appshot-001',
    attachment_id: 'att-text-001',
    kind: 'text',
    mime_type: 'text/plain',
    local_only: true
  }
];
const discovery = detector.discoverAppshotsThreadAttachments(threadAttachments, { visualRequired: true });
const evidence = evidenceMod.buildAppshotsEvidence({
  root,
  prompt: 'visual Appshots thread attachment discovery fixture',
  sourcePaths: [fixture.rel],
  sourceMetadata: [fixture.metadata],
  threadAttachments,
  operatorActionRecorded: true
});
const missing = detector.detectAppshotsCapability({
  prompt: 'visual Appshots required',
  visualRequired: true,
  operatorActionRecorded: false,
  appshotsToolAvailable: false,
  threadAttachments: []
});
const report = {
  schema: 'sks.appshots-thread-attachment-discovery-check.v1',
  ok: discovery.ok === true && evidence.ok === true && missing.operator_action_required === true,
  discovery,
  evidence,
  missing_required_status: missing.status,
  missing_required_blockers: missing.blockers
};
const out = path.join(root, '.sneakoscope', 'reports', 'appshots-thread-attachment-discovery.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);

assertGate(discovery.attachments.some((row) => row.kind === 'appshot' && row.thread_id && row.attachment_id), 'Appshots discovery must retain thread and attachment ids', report);
assertGate(discovery.attachments.some((row) => row.kind === 'appshot' && row.source_app && row.source_window && row.local_only === true), 'Appshots discovery must retain source app, source window, and local-only provenance', report);
assertGate(discovery.attachments.some((row) => row.kind === 'text'), 'Appshots discovery must classify text attachments when metadata exists', report);
assertGate(evidence.thread_attachment_discovery.appshot_attachment_count === 1, 'Appshots evidence must embed thread attachment discovery', report);
assertGate(evidence.source_verification.every((row) => row.source_type !== 'codex_appshot' || (row.thread_id && row.attachment_id && row.source_app && row.source_window && row.local_only === true)), 'Appshots codex_appshot evidence must preserve thread, attachment, source, and local-only fields', report);
assertGate(!JSON.stringify(report).includes('CLI-created'), 'Appshots evidence must not claim CLI-created Appshots', report);
assertGate(missing.operator_action_required === true, 'Missing required Appshot must request operator action', report);
emitGate('appshots:thread-attachment-discovery', { appshot_attachment_count: discovery.appshot_attachment_count });

function writeAppshotFixture() {
  const dir = path.join(root, '.sneakoscope', 'reports', 'appshots-fixtures');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'thread-attachment.redacted-appshot.json');
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
      thread_id: 'thread-appshot-001',
      attachment_id: 'att-appshot-001',
      source_app: 'Codex',
      source_window: 'Release Fixture'
    }
  };
}
