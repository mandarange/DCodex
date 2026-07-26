#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs';
import path from 'node:path';
import { assertGate, emitGate, importDist, root } from './gate-lib.js';

const mod = await importDist('core/strategy/strategy-compiler.js');
const compiled = mod.compileStrategy({
  prompt: 'Update independent release files.',
  writeTargets: ['src/core/version.ts', 'README.md', 'CHANGELOG.md'],
  agentCount: 5
});
const report = { schema: 'sks.strategy-parallel-modification-plan-check.v1', ok: compiled.parallel_modification_plan.can_parallelize_writes, plan: compiled.parallel_modification_plan };
const out = path.join(root, '.sneakoscope', 'reports', 'strategy-parallel-modification-plan.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);

assertGate(compiled.parallel_modification_plan.batches.length >= 1, 'parallel modification plan must include a batch', report);
assertGate(compiled.parallel_modification_plan.serial_conflicts.length === 0, 'independent write targets must not serialize', report);
emitGate('strategy:parallel-modification-plan', { batches: compiled.parallel_modification_plan.batches.length });
