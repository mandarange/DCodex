#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs';
import path from 'node:path';
import { assertGate, emitGate, importDist, root } from './gate-lib.js';

const mod = await importDist('core/mcp/mcp-tool-policy.js');
const readOnly = mod.classifyMcpToolForConcurrency({ name: 'search_docs', annotations: { readOnlyHint: true }, inputSchema: { type: 'object' } });
const destructive = mod.classifyMcpToolForConcurrency({ name: 'delete_docs', annotations: { readOnlyHint: true }, inputSchema: { type: 'object' } });
const report = { schema: 'sks.mcp-readonly-concurrency-check.v1', ok: readOnly.concurrency === 'candidate_parallel_readonly' && destructive.concurrency === 'serial_required', readOnly, destructive };
const out = path.join(root, '.sneakoscope', 'reports', 'mcp-readonly-concurrency.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);

assertGate(readOnly.concurrency === 'candidate_parallel_readonly', 'readOnlyHint non-destructive tools may be parallel candidates', report);
assertGate(destructive.concurrency === 'serial_required', 'destructive tools remain serial even with readOnlyHint', report);
assertGate(readOnly.advisory_only === true, 'readOnlyHint must remain advisory only', report);
emitGate('mcp:readonly-concurrency', { read_only: readOnly.concurrency, destructive: destructive.concurrency });
