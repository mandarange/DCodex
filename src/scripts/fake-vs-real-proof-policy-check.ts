#!/usr/bin/env node
// @ts-nocheck
import { assertGate, emitGate, importDist } from './gate-lib.js';

const mod = await importDist('core/proof/fake-real-proof-policy.js');
const fake = mod.evaluateFakeRealProofPolicy({ backend: 'fake', real_parallel_claim: false });
assertGate(fake.schema === 'sks.fake-real-proof-policy.v3', 'fake-real proof policy schema must be v3', fake);
assertGate(fake.ok === true && fake.proof_level === 'fixture_only' && fake.real_claims.length === 0, 'fake backend must remain fixture-only', fake);
const badFake = mod.evaluateFakeRealProofPolicy({ backend: 'fake', real_parallel_claim: true });
assertGate(badFake.ok === false && badFake.blockers.includes('fake_backend_claimed_real_execution'), 'fake backend cannot claim execution authority', badFake);
const supporting = mod.evaluateFakeRealProofPolicy({ backend: 'zellij', zellij_pane_verified: true });
assertGate(supporting.ok === true && supporting.proof_level === 'integration_optional', 'supporting runtime evidence cannot become execution proof', supporting);
assertGate(supporting.subsystem_levels.zellij_pane === 'proven' && supporting.real_claims.length === 0, 'Zellij evidence must remain supporting-only', supporting);
const official = mod.evaluateFakeRealProofPolicy(passingOfficialEvidence());
assertGate(official.ok === true && official.proof_level === 'proven', 'official Codex subagent evidence must satisfy execution proof', official);
assertGate(official.execution_authority.workflow === 'official_codex_subagent', 'official Codex subagent must be the execution authority', official);
const authorityRows = Object.values(official.subsystems).filter((row) => row.evidence_role === 'execution_authority');
assertGate(authorityRows.length === 1 && authorityRows[0].proof_level === 'proven', 'exactly one proven execution-authority row is required', official);
emitGate('proof:fake-vs-real-policy', { fake: fake.proof_level, supporting: supporting.proof_level, official: official.proof_level });

function passingOfficialEvidence() {
  const runId = 'proof-policy-v3-check';
  return {
    subagent_plan: {
      schema: 'sks.subagent-plan.v1', workflow: 'official_codex_subagent', route: '$Naruto', workflow_run_id: runId,
      requested_subagents: 1, max_depth: 1, config_blockers: [],
      wave_lifecycle: { count_policy: 'exact', target_subagents: 1 }
    },
    subagent_evidence: {
      schema: 'sks.subagent-evidence.v1', workflow: 'official_codex_subagent', run_id: runId,
      requested_subagents: 1, count_policy: 'exact', target_subagents: 1, started_threads: 1, completed_threads: 1, failed_threads: 0,
      open_thread_ids: [], event_sources: ['SubagentStart', 'SubagentStop'], parent_summary_present: true,
      parent_summary_trustworthy: true, parent_summary_status: 'completed', preparation_only: false,
      status: 'completed', ok: true, blockers: []
    },
    naruto_summary: {
      schema: 'sks.naruto-subagent-workflow.v1', workflow: 'official_codex_subagent', route: '$Naruto', workflow_run_id: runId,
      requested_subagents: 1, count_policy: 'exact', target_subagents: 1, status: 'completed', ok: true, completion_evidence: true, parent_summary_present: true, blockers: []
    },
    naruto_gate: {
      schema: 'sks.naruto-gate.v1', workflow: 'official_codex_subagent', route: '$Naruto', workflow_run_id: runId,
      requested_subagents: 1, count_policy: 'exact', target_subagents: 1, status: 'passed', passed: true, terminal: true, terminal_state: 'completed',
      official_subagent_evidence: true, subagent_evidence_ready: true, parent_summary_present: true,
      session_cleanup: true, native_process_proof_required: false, blockers: []
    }
  };
}
