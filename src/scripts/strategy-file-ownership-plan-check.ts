#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs';
import path from 'node:path';
import { assertGate, emitGate, importDist, root } from './gate-lib.js';

const mod = await importDist('core/strategy/strategy-compiler.js');
const compiled = mod.compileStrategy({
  prompt: 'Patch separate source and docs files.',
  writeTargets: ['src/core/strategy/strategy-gate.ts', 'docs/strategy-first-parallel-write.md']
});
const report = { schema: 'sks.strategy-file-ownership-plan-check.v1', ok: compiled.file_ownership_plan.no_overlap, ownership: compiled.file_ownership_plan };
const out = path.join(root, '.sneakoscope', 'reports', 'strategy-file-ownership-plan.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);

assertGate(compiled.file_ownership_plan.no_overlap === true, 'file ownership plan must prove no overlapping writes', report);
assertGate(compiled.file_ownership_plan.protected_write_paths.length === 0, 'file ownership plan must block protected paths', report);
emitGate('strategy:file-ownership-plan', { owners: compiled.file_ownership_plan.owners.length });
