#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs';
import path from 'node:path';
import { assertGate, emitGate, importDist, root } from './gate-lib.js';

const mod = await importDist('core/mcp/mcp-tool-policy.js');
const proof = await mod.proveMcpReadOnlyRuntimeScheduler();
const report = { schema: 'sks.mcp-readonly-runtime-scheduler-check.v1', ok: proof.ok, proof };
const out = path.join(root, '.sneakoscope', 'reports', 'mcp-readonly-runtime-scheduler.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);

assertGate(proof.read_only_parallel === true, 'readOnlyHint fixtures must overlap at runtime', report);
assertGate(proof.write_serial === true, 'write-capable MCP fixtures must be serialized', report);
assertGate(proof.destructive_false_positive_blocked === true, 'destructive readOnlyHint false positive must be blocked', report);
assertGate(proof.tools.every((row) => Number.isFinite(row.started_at_ms) && Number.isFinite(row.ended_at_ms)), 'MCP scheduler proof must include timestamps', report);
assertGate(proof.ok === true, 'MCP runtime scheduler proof must be blocker-free', report);
assertGate(proof.overlap_evidence.length >= 1, 'MCP scheduler proof must include actual overlap evidence rows', report);
assertGate(proof.tools.filter((row) => row.scheduled_mode === 'parallel_readonly_batch').length >= 3, 'MCP scheduler proof must use at least three read-only tools', report);
emitGate('mcp:readonly-runtime-scheduler', { overlaps: proof.overlap_evidence.length });
