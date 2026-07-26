#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs';
import path from 'node:path';
import { assertGate, emitGate, importDist, root } from './gate-lib.js';

const mod = await importDist('core/source-intelligence/appshots-evidence.js');
const fixture = writeAppshotFixture('voxel');
const evidence = mod.buildAppshotsEvidence({
  root,
  prompt: 'visual Appshots voxel',
  sourcePaths: [fixture.rel],
  sourceMetadata: [fixture.metadata],
  operatorActionRecorded: true
});
const report = { schema: 'sks.appshots-triwiki-voxel-check.v1', ok: evidence.triwiki_voxel_ready, evidence };
const out = path.join(root, '.sneakoscope', 'reports', 'appshots-triwiki-voxel.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);

assertGate(evidence.triwiki_voxel_ready === true, 'Appshots visual source must be TriWiki/Voxel ready', report);
assertGate(evidence.accepted_source_paths.length === 1, 'Appshots TriWiki/Voxel evidence must use verified accepted sources', report);
emitGate('appshots:triwiki-voxel', { source_count: evidence.source_count });

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
      thread_id: 'thread-fixture-voxel',
      attachment_id: 'attachment-fixture-voxel',
      source_app: 'Codex',
      source_window: 'Fixture Appshot'
    }
  };
}
