#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { importDist } from './gate-lib.js';

export async function runDynamicPoolFixture(opts = {}) {
  const target = opts.target || 4;
  const total = opts.total || 8;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-dynamic-pool-'));
  const scheduler = await importDist('core/agents/agent-scheduler.js');
  const roster = {
    schema: 'sks.agent-roster.v1',
    agent_count: target,
    concurrency: target,
    roster: Array.from({ length: target }, (_, index) => ({
      id: `agent_${index + 1}`,
      persona_id: `agent_${index + 1}`,
      role: index % 2 === 0 ? 'verifier' : 'implementer',
      write_policy: 'read-only',
      index: index + 1
    }))
  };
  const slices = Array.from({ length: total }, (_, index) => ({
    id: `work-${String(index + 1).padStart(3, '0')}`,
    role: 'verifier',
    description: `fixture work ${index + 1}`,
    delay_ms: index < 2 ? 10 : index < target ? 90 : 15,
    write_paths: [],
    readonly_paths: []
  }));
  const launched = [];
  const result = await scheduler.runAgentScheduler({
    root,
    missionId: 'M-dynamic-pool',
    rootHash: 'fixture-root',
    roster,
    partition: { slices },
    prompt: 'dynamic pool fixture',
    targetActiveSlots: target,
    sourceIntelligenceRefs: { artifact: 'source-intelligence-evidence.json', ok: true, mode: 'offline_context7_only' },
    goalModeRef: { artifact: 'goal-mode-applied.json', ok: true, mode: 'official_goal_default' },
    launchSession: async ({ agent, workItem, generation }) => {
      launched.push({ session_id: generation.session_id, slot_id: agent.slot_id, generation_index: agent.generation_index, work_item_id: workItem.id, started_at: Date.now() });
      await delay(Number(workItem.slice?.delay_ms || 1));
      return {
        schema: 'sks.agent-result.v1',
        mission_id: 'M-dynamic-pool',
        agent_id: agent.id,
        session_id: generation.session_id,
        persona_id: agent.persona_id,
        task_slice_id: workItem.id,
        status: 'done',
        backend: 'fake',
        summary: `completed ${workItem.id}`,
        findings: [],
        proposed_changes: [],
        changed_files: [],
        lease_compliance: { ok: true, violations: [] },
        artifacts: [path.join(generation.artifact_dir, 'agent-result.json')],
        blockers: [],
        confidence: 'fixture',
        handoff_notes: '',
        unverified: [],
        writes: [],
        source_intelligence_refs: agent.source_intelligence_refs,
        goal_mode_ref: agent.goal_mode_ref,
        recursion_guard: { ok: true, violations: [] },
        verification: { status: 'fixture', checks: ['dynamic-pool-fixture'] }
      };
    }
  });
  const eventsText = await fs.readFile(path.join(root, 'agent-scheduler-events.jsonl'), 'utf8');
  const events = eventsText.trim().split(/\n+/).filter(Boolean).map((line) => JSON.parse(line));
  return { root, result, launched, events };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
