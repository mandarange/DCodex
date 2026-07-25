#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertGate, emitGate, importDist, root } from './gate-lib.js';

const queueMod = await importDist('core/agents/agent-patch-queue.js');
const applyMod = await importDist('core/agents/agent-patch-apply-worker.js');
const mergeMod = await importDist('core/agents/agent-merge-coordinator.js');
const proofMod = await importDist('core/agents/agent-patch-proof.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-agent-patch-'));
fs.writeFileSync(path.join(tmp, 'a.txt'), 'alpha\n');
fs.writeFileSync(path.join(tmp, 'b.txt'), 'bravo\n');
const queue = new queueMod.InMemoryAgentPatchQueue();
const envelope = (agent, file, operation) => ({
  schema: 'sks.agent-patch-envelope.v1',
  agent_id: agent,
  session_id: `${agent}-session`,
  slot_id: `${agent}-slot`,
  generation_index: 1,
  lease_id: `lease:${agent}:${file}`,
  task_slice_id: `task:${agent}:${file}`,
  verification_hint: { node_id: `verify:${agent}` },
  rollback_hint: { node_id: `rollback:${agent}` },
  lease_proof: {
    lease_id: `lease:${agent}:${file}`,
    owner_agent: agent,
    strategy_task_id: `strategy:${agent}`,
    micro_win_id: `micro:${agent}:${file}`,
    verification_node_id: `verify:${agent}`,
    rollback_node_id: `rollback:${agent}`,
    allowed_paths: [file],
    protected_path_check: 'passed'
  },
  operations: [operation]
});
const first = queue.enqueue(envelope('agent-a', 'a.txt', { op: 'replace', path: 'a.txt', search: 'alpha', replace: 'alpha-1' }));
const second = queue.enqueue(envelope('agent-b', 'b.txt', { op: 'replace', path: 'b.txt', search: 'bravo', replace: 'bravo-1' }));
const merge = mergeMod.coordinateAgentPatchMerge(queue.queued());
const applyResults = [];
for (const entry of queue.queued()) {
  const applyResult = await applyMod.applyAgentPatchEnvelope(tmp, entry.envelope);
  applyResults.push({ ...applyResult, entry_id: entry.id });
  if (applyResult.ok) queue.markApplied(entry.id);
}
const proof = proofMod.buildAgentPatchProof({
  queue: queue.toJSON(),
  merge,
  applyResults,
  verification: ['fixture-files-mutated'],
  transactionJournal: {
    schema: 'sks.agent-patch-transaction-journal-summary.v1',
    ok: true,
    event_count: 8,
    blockers: []
  },
  verificationRollbackDag: {
    nodes: [
      { id: 'verify:agent-a', kind: 'verification' },
      { id: 'rollback:agent-a', kind: 'rollback' },
      { id: 'verify:agent-b', kind: 'verification' },
      { id: 'rollback:agent-b', kind: 'rollback' }
    ]
  }
});
const atomicProbeFile = path.join(tmp, 'atomic.txt');
fs.writeFileSync(atomicProbeFile, 'before\n');
const atomicBlocked = await applyMod.applyAgentPatchEnvelope(tmp, {
  schema: 'sks.agent-patch-envelope.v1',
  agent_id: 'atomic-probe',
  session_id: 'atomic-session',
  slot_id: 'atomic-slot',
  generation_index: 1,
  lease_id: 'lease:atomic-probe:atomic.txt',
  rollback_hint: { node_id: 'rollback:atomic' },
  operations: [
    { op: 'replace', path: 'atomic.txt', search: 'before', replace: 'after' },
    { op: 'write', path: '.codex/blocked.txt', content: 'blocked' }
  ]
});
const normalizedConflict = mergeMod.coordinateAgentPatchMerge([
  envelope('agent-a', 'same.txt', { op: 'write', path: 'same.txt', content: 'a' }),
  envelope('agent-b', 'same.txt', { op: 'write', path: './same.txt', content: 'b' })
]);
const parentChildConflict = mergeMod.coordinateAgentPatchMerge([
  envelope('agent-a', 'dir', { op: 'write', path: 'dir', content: 'a' }),
  envelope('agent-b', 'dir/file.txt', { op: 'write', path: 'dir/file.txt', content: 'b' })
]);
const report = { schema: 'sks.agent-parallel-write-kernel-check.v1', ok: proof.ok, first, second, merge, applyResults, proof, atomicBlocked, normalizedConflict, parentChildConflict };
const out = path.join(root, '.sneakoscope', 'reports', 'agent-parallel-write-kernel.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);

assertGate(merge.ok === true, 'parallel write merge should not report conflicts for disjoint files', report);
assertGate(applyResults.every((result) => result.ok), 'parallel write apply results must all pass', report);
assertGate(proof.ok === true, 'parallel write proof must pass', report);
assertGate(fs.readFileSync(path.join(tmp, 'a.txt'), 'utf8').includes('alpha-1'), 'first patch did not apply', report);
assertGate(fs.readFileSync(path.join(tmp, 'b.txt'), 'utf8').includes('bravo-1'), 'second patch did not apply', report);
assertGate(atomicBlocked.ok === false && fs.readFileSync(atomicProbeFile, 'utf8') === 'before\n', 'blocked patch must not partially mutate files', report);
assertGate(normalizedConflict.ok === false, 'merge coordinator must catch normalized path collisions', report);
assertGate(parentChildConflict.ok === false, 'merge coordinator must catch parent/child path overlaps', report);
emitGate('agent:parallel-write-kernel', { changed_files: proof.changed_files.length });
