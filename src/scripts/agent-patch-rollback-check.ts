#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertGate, emitGate, importDist, root } from './gate-lib.js';

const applyMod = await importDist('core/agents/agent-patch-apply-worker.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-patch-rollback-'));
const file = path.join(tmp, 'rollback.txt');
const created = path.join(tmp, 'created.txt');
fs.writeFileSync(file, 'before\n');
const envelope = {
  schema: 'sks.agent-patch-envelope.v1',
  agent_id: 'rollback-agent',
  session_id: 'rollback-session',
  slot_id: 'rollback-slot',
  generation_index: 1,
  lease_id: 'lease:rollback-agent:rollback.txt',
  rollback_hint: { node_id: 'rollback-fixture' },
  operations: [
    { op: 'replace', path: 'rollback.txt', search: 'before', replace: 'after' },
    { op: 'write', path: 'created.txt', content: 'created\n' }
  ]
};
const applied = await applyMod.applyAgentPatchEnvelope(tmp, envelope);
const rolledBack = await applyMod.rollbackAgentPatchApply(tmp, applied);
const restored = fs.readFileSync(file, 'utf8');
const createdRemoved = !fs.existsSync(created);
const report = { schema: 'sks.agent-patch-rollback-check.v1', ok: applied.ok && rolledBack.ok && restored === 'before\n' && createdRemoved, applied, rolledBack, restored, createdRemoved };
const out = path.join(root, '.sneakoscope', 'reports', 'agent-patch-rollback.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);

assertGate(applied.ok === true, 'rollback check patch did not apply', report);
assertGate(rolledBack.ok === true, 'rollback check did not execute rollback mechanism', report);
assertGate(restored === 'before\n', 'rollback check did not restore original content', report);
assertGate(createdRemoved === true, 'rollback check did not delete file created by patch', report);
emitGate('agent:patch-rollback', { rollback_entries: applied.rollback.length, deleted_files: rolledBack.deleted_files.length });
