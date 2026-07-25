#!/usr/bin/env node
// @ts-nocheck
// Gate: release:gate-budget
// Reports the slowest gates and any gate exceeding its time budget, from the gate
// result cache. Tolerant of missing timing data (informational on a cold cache).
// Only a gate exceeding the HARD ceiling is a blocker.
import fs from 'node:fs';
import path from 'node:path';
import { assertGate, emitGate, importDist, root } from './gate-lib.js';

const { readGateCache } = await importDist('core/release/gate-cache.js');

const SOFT_BUDGET_MS = Number(process.env.SKS_GATE_BUDGET_MS || 120_000);
const HARD_CEILING_MS = Number(process.env.SKS_GATE_HARD_CEILING_MS || 600_000);

const cache = await readGateCache(root);
const records = Object.values(cache.records || {});
const sorted = records.slice().sort((a, b) => (b.duration_ms || 0) - (a.duration_ms || 0));
const slowest = sorted.slice(0, 10).map((r) => ({ gate_id: r.gate_id, duration_ms: r.duration_ms }));
const overBudget = sorted.filter((r) => (r.duration_ms || 0) > SOFT_BUDGET_MS).map((r) => ({ gate_id: r.gate_id, duration_ms: r.duration_ms }));
const overCeiling = sorted.filter((r) => (r.duration_ms || 0) > HARD_CEILING_MS).map((r) => ({ gate_id: r.gate_id, duration_ms: r.duration_ms }));

const report = {
  schema: 'sks.release-gate-budget.v1',
  ok: overCeiling.length === 0,
  timing_data: records.length > 0,
  soft_budget_ms: SOFT_BUDGET_MS,
  hard_ceiling_ms: HARD_CEILING_MS,
  slowest,
  over_budget: overBudget,
  over_ceiling: overCeiling,
  note: records.length === 0 ? 'no_timing_data (populate via release:check:dynamic gate cache)' : undefined
};
const reportDir = path.join(root, '.sneakoscope', 'reports');
fs.mkdirSync(reportDir, { recursive: true });
fs.writeFileSync(path.join(reportDir, 'release-gate-budget.json'), `${JSON.stringify(report, null, 2)}\n`);

// Only a gate over the HARD ceiling fails the gate; soft-budget gates are warnings.
assertGate(overCeiling.length === 0, 'a gate exceeded the hard time ceiling', { overCeiling, hard_ceiling_ms: HARD_CEILING_MS });
emitGate('release:gate-budget', { slowest: slowest.length, over_budget: overBudget.length, timing_data: records.length > 0 });
