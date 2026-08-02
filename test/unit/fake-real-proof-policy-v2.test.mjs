import test from 'node:test';
import assert from 'node:assert/strict';

test('fake-real proof policy v3 recognizes only official Codex subagent execution evidence', async () => {
  const mod = await import('../../dist/core/proof/fake-real-proof-policy.js');
  const official = mod.evaluateFakeRealProofPolicy(passingOfficialEvidence());
  const requiredMissing = mod.evaluateFakeRealProofPolicy({
    require_official_subagents: true
  });
  const supporting = mod.evaluateFakeRealProofPolicy({
    backend: 'zellij',
    zellij_pane_verified: true,
    output_schema_used: true,
    output_last_message_path: 'result.json'
  });
  assert.equal(official.schema, 'sks.fake-real-proof-policy.v3');
  assert.equal(official.proof_level, 'proven');
  assert.deepEqual(official.real_claims, ['official_codex_subagent_execution']);
  assert.equal(official.subsystems.official_codex_subagent.evidence_role, 'execution_authority');
  assert.equal(Object.values(official.subsystems).filter((row) => row.evidence_role === 'execution_authority').length, 1);
  assert.deepEqual(Object.keys(official.subsystems).sort(), [
    'cleanup', 'dynamic_scheduler', 'goal_mode', 'intelligent_work_graph', 'official_codex_subagent',
    'route_blackbox', 'source_intelligence', 'warp_mad_lanes', 'zellij_pane'
  ]);
  assert.equal(requiredMissing.proof_level, 'real_required_missing');
  assert.equal(requiredMissing.subsystem_levels.official_codex_subagent, 'real_required_missing');
  assert.equal(requiredMissing.ok, false);
  assert.equal(supporting.proof_level, 'integration_optional');
  assert.equal(supporting.subsystem_levels.zellij_pane, 'proven');
  assert.deepEqual(supporting.real_claims, []);
  assert.ok(supporting.supporting_claims.includes('codex_structured_output_evidence'));
});

test('dynamic proof uses run-scoped cumulative starts and rejects a raw target above the 256-child automatic ceiling', async () => {
  const mod = await import('../../dist/core/proof/fake-real-proof-policy.js');
  const withinCeiling = dynamicOfficialEvidence();
  const proven = mod.evaluateOfficialSubagentExecutionProof(withinCeiling, { required: true });
  assert.equal(proven.proof_level, 'proven');

  const overCeiling = structuredClone(withinCeiling);
  overCeiling.subagent_plan.wave_lifecycle.target_subagents = 11;
  const blocked = mod.evaluateOfficialSubagentExecutionProof(overCeiling, { required: true });
  assert.equal(blocked.proof_level, 'blocked');
  assert.ok(blocked.blockers.includes('subagent_automatic_fanout_cap_exceeded:11/10'));

  const tamperedCeiling = structuredClone(withinCeiling);
  tamperedCeiling.subagent_plan.fanout_policy.automatic_ceiling = 257;
  tamperedCeiling.subagent_plan.wave_lifecycle.target_subagents = 257;
  tamperedCeiling.subagent_plan.wave_lifecycle.cumulative_started = 257;
  for (const artifact of ['subagent_evidence', 'naruto_summary', 'naruto_gate']) {
    tamperedCeiling[artifact].target_subagents = 257;
  }
  tamperedCeiling.subagent_evidence.started_threads = 257;
  tamperedCeiling.subagent_evidence.completed_threads = 257;
  const tamperedBlocked = mod.evaluateOfficialSubagentExecutionProof(tamperedCeiling, { required: true });
  assert.equal(tamperedBlocked.proof_level, 'blocked');
  assert.ok(tamperedBlocked.blockers.includes('subagent_automatic_fanout_cap_exceeded:257/256'));
});

function passingOfficialEvidence() {
  const runId = 'proof-policy-v3-test';
  return {
    subagent_plan: {
      schema: 'sks.subagent-plan.v1', workflow: 'official_codex_subagent', route: '$Naruto', workflow_run_id: runId,
      requested_subagents: 1, max_depth: 1, config_blockers: []
    },
    subagent_evidence: {
      schema: 'sks.subagent-evidence.v1', workflow: 'official_codex_subagent', run_id: runId,
      requested_subagents: 1, started_threads: 1, completed_threads: 1, failed_threads: 0,
      open_thread_ids: [], event_sources: ['SubagentStart', 'SubagentStop'], parent_summary_present: true,
      parent_summary_trustworthy: true, parent_summary_status: 'completed', preparation_only: false,
      status: 'completed', ok: true, blockers: []
    },
    naruto_summary: {
      schema: 'sks.naruto-subagent-workflow.v1', workflow: 'official_codex_subagent', route: '$Naruto', workflow_run_id: runId,
      requested_subagents: 1, status: 'completed', ok: true, completion_evidence: true, parent_summary_present: true, blockers: []
    },
    naruto_gate: {
      schema: 'sks.naruto-gate.v1', workflow: 'official_codex_subagent', route: '$Naruto', workflow_run_id: runId,
      requested_subagents: 1, status: 'passed', passed: true, terminal: true, terminal_state: 'completed',
      official_subagent_evidence: true, subagent_evidence_ready: true, parent_summary_present: true,
      session_cleanup: true, native_process_proof_required: false, blockers: []
    }
  };
}

function dynamicOfficialEvidence() {
  const runId = 'proof-policy-v3-dynamic';
  return {
    subagent_plan: {
      schema: 'sks.subagent-plan.v1', workflow: 'official_codex_subagent', route: '$Naruto', workflow_run_id: runId,
      requested_subagents: 2, max_threads: 3, max_depth: 1, config_blockers: [],
      fanout_policy: { automatic_ceiling: 10 },
      wave_lifecycle: {
        count_policy: 'dynamic_automatic', requested_target_subagents: 2, target_subagents: 10,
        cumulative_started: 10
      }
    },
    subagent_evidence: {
      schema: 'sks.subagent-evidence.v1', workflow: 'official_codex_subagent', run_id: runId,
      requested_subagents: 2, count_policy: 'dynamic_automatic', target_subagents: 10,
      started_threads: 10, completed_threads: 10, failed_threads: 0,
      open_thread_ids: [], event_sources: ['SubagentStart', 'SubagentStop'], parent_summary_present: true,
      parent_summary_trustworthy: true, parent_summary_status: 'completed', preparation_only: false,
      status: 'completed', ok: true, blockers: []
    },
    naruto_summary: {
      schema: 'sks.naruto-subagent-workflow.v1', workflow: 'official_codex_subagent', route: '$Naruto', workflow_run_id: runId,
      requested_subagents: 2, count_policy: 'dynamic_automatic', target_subagents: 10,
      status: 'completed', ok: true, completion_evidence: true, parent_summary_present: true, blockers: []
    },
    naruto_gate: {
      schema: 'sks.naruto-gate.v1', workflow: 'official_codex_subagent', route: '$Naruto', workflow_run_id: runId,
      requested_subagents: 2, count_policy: 'dynamic_automatic', target_subagents: 10,
      status: 'passed', passed: true, terminal: true, terminal_state: 'completed',
      official_subagent_evidence: true, subagent_evidence_ready: true, parent_summary_present: true,
      session_cleanup: true, native_process_proof_required: false, blockers: []
    }
  };
}
