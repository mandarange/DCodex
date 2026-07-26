#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertGate, emitGate, importDist } from './gate-lib.js';
import { writeReport } from './patch-handoff-gate-lib.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-patch-journal-'));
fs.writeFileSync(path.join(dir, 'a.txt'), 'before\n');
const storeMod = await importDist('core/agents/agent-patch-queue-store.js');
const applyMod = await importDist('core/agents/agent-patch-apply-worker.js');
const journalMod = await importDist('core/agents/agent-patch-transaction-journal.js');
const store = new storeMod.PersistentAgentPatchQueueStore(dir);
const entry = await store.enqueue({
  schema: 'sks.agent-patch-envelope.v1',
  agent_id: 'agent-journal',
  session_id: 'session-journal',
  slot_id: 'slot-journal',
  generation_index: 1,
  lease_id: 'lease-journal',
  lease_proof: {
    lease_id: 'lease-journal',
    owner_agent: 'agent-journal',
    owner_persona: 'fixture',
    allowed_paths: ['a.txt'],
    strategy_task_id: 'task-journal',
    micro_win_id: 'win-journal',
    verification_node_id: 'verify-journal',
    rollback_node_id: 'rollback-journal',
    protected_path_check: 'passed'
  },
  verification_hint: { node_id: 'verify-journal' },
  rollback_hint: { node_id: 'rollback-journal' },
  operations: [{ op: 'replace', path: 'a.txt', search: 'before', replace: 'after' }]
}, { mission_id: 'M-journal', route: '$Naruto' });
await store.markApplying(entry.id);
const applyResult = await applyMod.applyAgentPatchQueueEntry(dir, entry, { artifactsDir: dir });
await store.markApplied(entry.id);
await store.markVerified(entry.id);
const journal = new journalMod.AgentPatchTransactionJournal(dir);
await journal.append({ event_type: 'verification_started', entry_id: entry.id, agent_id: entry.agent_id, lease_id: entry.lease_id, status: 'started' });
await journal.append({ event_type: 'verification_finished', entry_id: entry.id, agent_id: entry.agent_id, lease_id: entry.lease_id, status: 'verified', verification_status: applyResult.verification.status, changed_files: applyResult.changed_files, rollback_digest: applyResult.rollback_digest });
await journal.append({ event_type: 'rollback_dry_run_started', entry_id: entry.id, agent_id: entry.agent_id, lease_id: entry.lease_id, status: 'started', rollback_digest: applyResult.rollback_digest });
const rollbackDryRun = await applyMod.rollbackAgentPatchApply(dir, applyResult, { dryRun: true });
await journal.append({ event_type: 'rollback_dry_run_finished', entry_id: entry.id, agent_id: entry.agent_id, lease_id: entry.lease_id, status: rollbackDryRun.status, rollback_digest: rollbackDryRun.rollback_digest, changed_files: applyResult.changed_files });
const summary = await journal.writeSummary();
const report = { schema: 'sks.agent-patch-transaction-journal-check.v1', ok: summary.ok, artifact_dir: dir, summary, applyResult, rollbackDryRun };
writeReport('agent-patch-transaction-journal', report);

assertGate(summary.ok === true, 'transaction journal summary must pass', report);
assertGate(summary.event_types.includes('enqueue'), 'journal must record enqueue', report);
assertGate(summary.event_types.includes('lock_acquired'), 'journal must record lock acquisition', report);
assertGate(summary.event_types.includes('lock_released'), 'journal must record lock release', report);
assertGate(summary.event_types.includes('apply_started') && summary.event_types.includes('apply_finished'), 'journal must record apply lifecycle', report);
assertGate(summary.event_types.includes('verification_finished'), 'journal must record verification completion', report);
assertGate(summary.event_types.includes('rollback_dry_run_finished'), 'journal must record rollback dry-run completion', report);
emitGate('agent:patch-transaction-journal', { event_count: summary.event_count });
