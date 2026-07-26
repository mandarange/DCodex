#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertGate, emitGate, importDist } from './gate-lib.js';
import { writeReport } from './patch-handoff-gate-lib.js';

const queueMod = await importDist('core/agents/agent-patch-queue-store.js');
const mergeMod = await importDist('core/agents/agent-merge-coordinator.js');
const rebaseMod = await importDist('core/agents/agent-patch-conflict-rebase.js');
const proofMod = await importDist('core/agents/agent-patch-proof.js');
const journalMod = await importDist('core/agents/agent-patch-transaction-journal.js');

const sameFileSuccess = await runFixture('same-file-success', {
  files: { 'same.txt': 'base\n' },
  envelopes: [
    makeEnvelope('agent-a', [replaceOp('same.txt', 'base', 'agent-a')]),
    makeEnvelope('agent-b', [replaceOp('same.txt', 'agent-a', 'agent-b')])
  ]
});
const proof = await buildProofForSuccessfulRebase(sameFileSuccess);

const unreconcilable = await runFixture('same-file-unreconcilable', {
  files: { 'miss.txt': 'base\n' },
  envelopes: [
    makeEnvelope('agent-c', [replaceOp('miss.txt', 'base', 'agent-c')]),
    makeEnvelope('agent-d', [replaceOp('miss.txt', 'never-present', 'agent-d')])
  ]
});

const subtree = await runFixture('subtree-conflict', {
  envelopes: [
    makeEnvelope('agent-e', [writeOp('tree/child.txt', 'child\n')]),
    makeEnvelope('agent-f', [writeOp('tree', 'parent-as-file\n')])
  ]
});

const domainBlocked = await runFixture('domain-conflict-blocked', {
  envelopes: [
    makeEnvelope('agent-g', [writeOp('domain-a.txt', 'a\n')], { conflict_prediction_id: 'shared-domain' }),
    makeEnvelope('agent-h', [writeOp('domain-b.txt', 'b\n')], { conflict_prediction_id: 'shared-domain' })
  ]
});

const domainRetry = await runFixture('domain-conflict-retry', {
  envelopes: [
    makeEnvelope('agent-i', [writeOp('domain-c.txt', 'c\n')], { conflict_prediction_id: 'retry-domain' }),
    makeEnvelope('agent-j', [writeOp('domain-d.txt', 'd\n')], { conflict_prediction_id: 'retry-domain' })
  ],
  rebaseOptions: { allowDomainRetry: true }
});

const protectedPath = await runFixture('protected-path-conflict', {
  envelopes: [
    makeEnvelope('agent-k', [writeOp('.codex/protected.txt', 'blocked\n')], { allowed_paths: ['.codex/protected.txt'] })
  ]
});

const unleased = await runFixture('unleased-path-conflict', {
  envelopes: [
    makeEnvelope('agent-l', [writeOp('outside.txt', 'blocked\n')], { allowed_paths: ['allowed.txt'] })
  ]
});

const dirty = await runFixture('dirty-unrelated-change', {
  files: { 'dirty.txt': 'changed by somebody else\n' },
  envelopes: [makeEnvelope('agent-m', [writeOp('dirty.txt', 'agent write\n')])],
  mergeFactory: (entries) => manualMerge(entries, 'dirty_unrelated_change:dirty.txt', 'dirty.txt')
});

const stale = await runFixture('stale-context-rebase', {
  files: { 'stale.txt': 'current\n' },
  envelopes: [makeEnvelope('agent-n', [replaceOp('stale.txt', 'current', 'rebased')])],
  mergeFactory: (entries) => manualMerge(entries, 'stale_context:stale.txt', 'stale.txt')
});

const checks = {
  same_file_group_created: sameFileSuccess.merge.serial_merge_groups.length === 1,
  same_file_rebase_succeeds: sameFileSuccess.rebase.ok === true && sameFileSuccess.rebase.rebase_attempt_count === 2 && sameFileSuccess.rebase.succeeded_entry_ids.length === 2,
  same_file_rollback_dry_run_recorded: sameFileSuccess.rebase.apply_results.every((row) => row.rollback_dry_run?.ok === true),
  proof_accepts_successful_rebase: proof.conflict_rebase_ok === true && proof.ok === true,
  unreconcilable_blocks: unreconcilable.rebase.ok === false && textOf(unreconcilable.rebase).includes('search_not_found'),
  subtree_blocks_without_throwing: subtree.rebase.ok === false && textOf(subtree.rebase).includes('serial_rebase_exception'),
  domain_blocks_by_default: domainBlocked.rebase.ok === false && domainBlocked.rebase.blocked_entry_ids.length === 2,
  domain_retry_can_succeed_when_allowed: domainRetry.rebase.ok === true && domainRetry.rebase.succeeded_entry_ids.length === 2,
  protected_path_blocks: protectedPath.rebase.ok === false && textOf(protectedPath.rebase).includes('protected_path'),
  unleased_path_blocks: unleased.rebase.ok === false && textOf(unleased.rebase).includes('lease_path_not_allowed'),
  dirty_unrelated_change_blocks: dirty.rebase.ok === false && textOf(dirty.rebase).includes('dirty_unrelated_change'),
  stale_context_rebases: stale.rebase.ok === true && stale.rebase.succeeded_entry_ids.length === 1,
  fixtures_produce_conflict_graphs: [sameFileSuccess, unreconcilable, subtree, domainBlocked, domainRetry, protectedPath, unleased].every((fixture) => fixture.merge.conflict_graph?.edges?.length >= 1),
  fixtures_produce_serial_groups: [sameFileSuccess, unreconcilable, subtree, domainBlocked, domainRetry, protectedPath, unleased, dirty, stale].every((fixture) => fixture.merge.serial_merge_groups?.length >= 1),
  fixtures_produce_rebase_artifacts: [sameFileSuccess, unreconcilable, subtree, domainBlocked, domainRetry, protectedPath, unleased, dirty, stale].every((fixture) => fs.existsSync(path.join(fixture.dir, 'agent-patch-conflict-rebase-results.json')))
};

const report = {
  schema: 'sks.agent-patch-conflict-rebase-check.v1',
  ok: Object.values(checks).every(Boolean),
  checks,
  proof,
  fixtures: {
    sameFileSuccess,
    unreconcilable,
    subtree,
    domainBlocked,
    domainRetry,
    protectedPath,
    unleased,
    dirty,
    stale
  }
};
writeReport('agent-patch-conflict-rebase', report);

for (const [name, ok] of Object.entries(checks)) {
  assertGate(ok === true, `conflict rebase fixture failed: ${name}`, report);
}
emitGate('agent:patch-conflict-rebase', { rebase_attempt_count: sameFileSuccess.rebase.rebase_attempt_count, fixture_count: Object.keys(report.fixtures).length });

async function buildProofForSuccessfulRebase(fixture) {
  const journal = new journalMod.AgentPatchTransactionJournal(fixture.dir);
  for (const id of fixture.rebase.succeeded_entry_ids) {
    const applyResult = fixture.rebase.apply_results.find((row) => row.entry_id === id);
    await fixture.store.markApplying(id);
    await fixture.store.markApplied(id);
    await journal.append({ event_type: 'verification_started', entry_id: id, agent_id: applyResult?.agent_id || null, lease_id: applyResult?.lease_id || null, status: 'started', changed_files: applyResult?.changed_files || [], rollback_digest: applyResult?.rollback_digest || null });
    await journal.append({ event_type: 'verification_finished', entry_id: id, agent_id: applyResult?.agent_id || null, lease_id: applyResult?.lease_id || null, status: 'verified', verification_status: applyResult?.verification?.status || 'verified', changed_files: applyResult?.changed_files || [], rollback_digest: applyResult?.rollback_digest || null });
    await fixture.store.markVerified(id);
  }
  const journalSummary = await journal.writeSummary();
  return proofMod.buildAgentPatchProof({
    queue: fixture.store.queue.toJSON(),
    merge: { ...fixture.merge, ok: true, blockers: [], unresolved_conflict_entry_ids: [] },
    applyResults: fixture.rebase.apply_results,
    verification: ['verified'],
    parallelWritePolicy: { write_mode: 'serial' },
    transactionJournal: journalSummary,
    conflictRebase: fixture.rebase
  });
}

async function runFixture(name, input) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `sks-conflict-rebase-${name}-`));
  writeFiles(dir, input.files || {});
  const store = new queueMod.PersistentAgentPatchQueueStore(dir);
  const entries = [];
  for (const envelope of input.envelopes) entries.push(await store.enqueue(envelope, { mission_id: `M-${name}`, route: '$Naruto' }));
  const merge = input.mergeFactory ? input.mergeFactory(entries) : mergeMod.coordinateAgentPatchMerge(entries);
  const rebase = await rebaseMod.executeAgentPatchConflictRebase(dir, entries, merge, { artifactsDir: dir, ...(input.rebaseOptions || {}) });
  return { name, dir, store, merge, rebase };
}

function makeEnvelope(agent, operations, extraLease = {}) {
  const allowedPaths = extraLease.allowed_paths || operations.map((operation) => operation.path);
  return {
    schema: 'sks.agent-patch-envelope.v1',
    agent_id: agent,
    session_id: `session-${agent}`,
    slot_id: `slot-${agent}`,
    generation_index: 1,
    lease_id: `lease-${agent}`,
    lease_proof: {
      lease_id: `lease-${agent}`,
      owner_agent: agent,
      owner_persona: 'fixture',
      allowed_paths: allowedPaths,
      strategy_task_id: `task-${agent}`,
      micro_win_id: `win-${agent}`,
      verification_node_id: `verify-${agent}`,
      rollback_node_id: `rollback-${agent}`,
      protected_path_check: 'passed',
      ...extraLease
    },
    verification_hint: { node_id: `verify-${agent}` },
    rollback_hint: { node_id: `rollback-${agent}` },
    operations
  };
}

function writeOp(file, content) {
  return { op: 'write', path: file, content };
}

function replaceOp(file, search, replace) {
  return { op: 'replace', path: file, search, replace };
}

function manualMerge(entries, reason, file) {
  return {
    schema: 'sks.agent-merge-coordinator.v1',
    ok: false,
    merge_order: entries.map((entry) => entry.agent_id),
    apply_order: ['serial-001'],
    touched_files: [file],
    conflicts: [{ type: 'manual-fixture', file, entries: entries.map((entry) => entry.id), agents: entries.map((entry) => entry.agent_id), reason }],
    conflict_graph: {
      nodes: entries.map((entry) => ({ entry_id: entry.id, agent_id: entry.agent_id, lease_id: entry.lease_id })),
      edges: [{ file, entries: entries.map((entry) => entry.id), reason }]
    },
    parallel_apply_groups: [],
    serial_merge_groups: [{ group_id: 'serial-001', entry_ids: entries.map((entry) => entry.id), agents: entries.map((entry) => entry.agent_id), reason, file }],
    blocked_conflicts: [{ type: 'manual-fixture', file, entries: entries.map((entry) => entry.id), agents: entries.map((entry) => entry.agent_id), reason }],
    blockers: [reason]
  };
}

function writeFiles(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
}

function textOf(value) {
  return JSON.stringify(value);
}
