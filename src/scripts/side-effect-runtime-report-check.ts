#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs';
import path from 'node:path';
import { assertGate, emitGate, importDist, root } from './gate-lib.js';

const { buildSideEffectRuntimeReport } = await importDist('core/safety/side-effect-runtime-report.js');

const report = await buildSideEffectRuntimeReport(root);
const out = path.join(root, '.sneakoscope', 'reports', 'side-effect-runtime-report.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);

assertGate(report.unexpected_applied_mutations === 0, 'unexpected applied mutations must be zero', report);
assertGate(report.global_mutations_without_confirmation === 0, 'global mutations without confirmation must be zero', report);
assertGate(report.config_mutations_without_backup_or_noop === 0, 'config/global mutations without backup or noop must be zero', report);
emitGate('side-effect:runtime-report', {
  ledgers: report.ledger_paths.length,
  applied: report.applied_entries,
  unexpected_applied_mutations: report.unexpected_applied_mutations
});
