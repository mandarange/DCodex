#!/usr/bin/env node
// @ts-nocheck
import { assertGate, emitGate, importDist } from './gate-lib.js';

const validator = await importDist('core/agents/agent-worker-pipeline.js');
const queueMod = await importDist('core/agents/agent-work-queue.js');
const scheduler = await importDist('core/agents/agent-scheduler.js');

const valid = {
  id: 'follow-up-001',
  title: 'Follow-up',
  description: 'Validate a schema-bound generated work item.',
  required_persona_category: 'verifier',
  priority: 1,
  dependencies: [],
  lease_requirements: [],
  max_attempts: 1,
  reason: 'fixture'
};
const base = {
  schema: 'sks.agent-result.v1',
  mission_id: 'M-follow-up',
  agent_id: 'agent_1',
  session_id: 'session-1',
  persona_id: 'agent_1',
  task_slice_id: 'slice-01',
  status: 'done',
  backend: 'fake',
  summary: 'ok',
  findings: [],
  proposed_changes: [],
  changed_files: [],
  lease_compliance: { ok: true, violations: [] },
  artifacts: [],
  blockers: [],
  confidence: 'fixture',
  handoff_notes: '',
  unverified: [],
  writes: [],
  recursion_guard: { ok: true, violations: [] },
  verification: { status: 'fixture', checks: [] }
};
const normalized = validator.validateAgentWorkerResult({ ...base, follow_up_work_items: [valid] });
assertGate(normalized.status === 'done', 'valid follow_up_work_items must pass result validation', normalized);
assertGate(normalized.follow_up_work_items?.length === 1, 'valid follow_up_work_items must survive normalization', normalized);
const invalid = validator.validateAgentWorkerResult({ ...base, follow_up_work_items: [{ id: 'bad', title: 'bad' }] });
assertGate(invalid.status === 'blocked', 'invalid follow_up_work_items must block result validation', invalid);

const queue = queueMod.createAgentWorkQueue({ slices: [{ id: 'work-001', role: 'verifier', description: 'seed' }], maxQueueExpansion: 1 });
const enqueue = queueMod.enqueueFollowUpWorkItems(queue, [valid, { ...valid, id: 'follow-up-002' }], { originSessionId: 'session-1' });
assertGate(enqueue.accepted.length === 1, 'max_queue_expansion must cap accepted follow-up work', enqueue);
assertGate(enqueue.blocked_count >= 1, 'follow-up overflow must be reported as blocked', enqueue);

const result = await scheduler.runAgentScheduler({
  root: await tempRoot(),
  missionId: 'M-follow-up',
  rootHash: 'fixture-root',
  roster: { agent_count: 1, concurrency: 1, roster: [{ id: 'agent_1', persona_id: 'agent_1', role: 'verifier', write_policy: 'read-only', index: 1 }] },
  partition: { slices: [{ id: 'work-001', role: 'verifier', description: 'seed' }] },
  prompt: 'follow-up runtime fixture',
  targetActiveSlots: 1,
  sourceIntelligenceRefs: { ok: true, artifact: 'source-intelligence-evidence.json' },
  goalModeRef: { ok: true, artifact: 'goal-mode-applied.json' },
  maxQueueExpansion: 1,
  launchSession: async ({ agent, workItem, generation }) => ({
    ...base,
    mission_id: 'M-follow-up',
    agent_id: agent.id,
    session_id: generation.session_id,
    persona_id: agent.persona_id,
    task_slice_id: workItem.id,
    follow_up_work_items: workItem.id === 'work-001' ? [valid] : []
  })
});
assertGate(result.state.generated_work_item_count === 1, 'scheduler must count generated follow-up work items', result.state);
assertGate(result.state.total_work_items === 2, 'scheduler must enqueue generated follow-up work item', result.state);
emitGate('agent:follow-up-work-schema', { generated_work_item_count: result.state.generated_work_item_count, total_work_items: result.state.total_work_items });

async function tempRoot() {
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  return fs.mkdtemp(path.join(os.tmpdir(), 'sks-follow-up-work-'));
}
