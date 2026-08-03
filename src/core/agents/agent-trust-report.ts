import path from 'node:path'
import { nowIso, readJson, writeJsonAtomic, writeTextAtomic } from '../fsx.js'
import {
  OFFICIAL_SUBAGENT_EXECUTION_ARTIFACTS,
  OFFICIAL_SUBAGENT_EXECUTION_AUTHORITY
} from '../proof/fake-real-proof-policy.js'

export async function writeAgentTrustReport(root: string, input: any = {}) {
  const cleanupProof = await readJson<any>(path.join(root, 'agent-cleanup-proof.json'), null)
  const intelligentWorkGraph = await readJson<any>(path.join(root, 'agent-intelligent-work-graph.json'), null)
  const fakeRealPolicy = await readJson<any>(path.join(root, 'fake-real-proof-policy.json'), null)
  const runtimeTruthMatrix = await readJson<any>(path.join(root, 'runtime-truth-matrix.json'), null)
  const patchHandoff = await readJson<any>(path.join(root, 'agent-patch-handoff-runtime.json'), null)
  const patchJournal = await readJson<any>(path.join(root, 'agent-patch-transaction-journal-summary.json'), null)
  const conflictRebase = await readJson<any>(path.join(root, 'agent-patch-conflict-rebase-results.json'), null)
  const officialSubagentExecution = (runtimeTruthMatrix?.rows || runtimeTruthMatrix?.subsystems || []).find?.((row: any) => row.subsystem === OFFICIAL_SUBAGENT_EXECUTION_AUTHORITY) || null
  const runtimeTruthGroups = {
    Fake: [] as string[],
    Optional: [] as string[],
    Proven: [] as string[],
    Blocked: [] as string[]
  }
  const pushTruth = (status: string, label: string) => {
    if (/fake|fixture/.test(status)) runtimeTruthGroups.Fake.push(label)
    else if (/optional/.test(status)) runtimeTruthGroups.Optional.push(label)
    else if (/passed|proven/.test(status)) runtimeTruthGroups.Proven.push(label)
    else if (/blocked|failed|missing/.test(status)) runtimeTruthGroups.Blocked.push(label)
  }
  pushTruth(cleanupProof?.ok === true ? 'passed' : cleanupProof ? 'blocked' : 'not_run', 'cleanup executor')
  pushTruth(intelligentWorkGraph?.ok === true ? 'passed' : intelligentWorkGraph ? 'partial' : 'not_run', 'intelligent work graph')
  pushTruth(officialSubagentExecution?.proof_level || 'not_run', 'official Codex subagent execution')
  const subsystemProofLevels = {
    ...(fakeRealPolicy?.subsystem_levels || {}),
    ...Object.fromEntries((runtimeTruthMatrix?.rows || runtimeTruthMatrix?.subsystems || []).map((row: any) => [row.subsystem, row.proof_level])),
    cleanup: runtimeTruthMatrix?.rows?.find?.((row: any) => row.subsystem === 'cleanup')?.proof_level || fakeRealPolicy?.subsystem_levels?.cleanup || (cleanupProof?.ok === true ? 'proven' : cleanupProof ? 'blocked' : 'not_run'),
    intelligent_work_graph: runtimeTruthMatrix?.rows?.find?.((row: any) => row.subsystem === 'intelligent_work_graph')?.proof_level || fakeRealPolicy?.subsystem_levels?.intelligent_work_graph || intelligentWorkGraph?.proof_level || (intelligentWorkGraph ? 'partial' : 'not_run')
  }
  const report = {
    schema: 'sks.agent-trust-report.v1',
    generated_at: nowIso(),
    agent_orchestration: {
      backend: input.backend || 'unknown',
      agent_count: input.roster?.agent_count || 0,
      default_agents: input.roster?.default_agents || 5,
      max_agents: input.roster?.max_agents || 20,
      no_overlap_ok: input.partition?.no_overlap_proof?.ok !== false,
      ledger_hash_chain_ok: input.ledger?.ok !== false,
      all_sessions_closed: input.cleanup?.all_sessions_closed === true,
      terminal_sessions_closed: input.terminal_sessions_closed ?? input.proof?.terminal_sessions_closed ?? null,
      terminal_close_report: 'sessions/<slot_id>/gen-<n>/agent-terminal-close-report.json',
      target_active_slots: input.proof?.target_active_slots ?? input.scheduler?.target_active_slots ?? null,
      total_work_items: input.scheduler?.total_work_items ?? null,
      pending_count: input.scheduler?.pending_count ?? null,
      active_slot_count: input.scheduler?.active_slot_count ?? null,
      completed_count: input.scheduler?.completed_count ?? null,
      max_observed_active_slots: input.proof?.max_observed_active_slots ?? input.scheduler?.max_observed_active_slots ?? null,
      backfill_count: input.proof?.backfill_count ?? input.scheduler?.backfill_count ?? null,
      expected_backfill_count: input.proof?.expected_backfill_count ?? input.scheduler?.expected_backfill_count ?? null,
      pending_queue_drained: input.proof?.pending_queue_drained ?? input.scheduler?.pending_queue_drained ?? null,
      generation_count: input.proof?.generation_count ?? null,
      cleanup_executor: {
        status: cleanupProof?.ok === true ? 'passed' : cleanupProof ? 'blocked' : 'not_run',
        proof: cleanupProof ? 'agent-cleanup-proof.json' : null,
        stale_processes_killed: cleanupProof?.stale_processes_killed || [],
        orphan_temp_dirs_removed: cleanupProof?.orphan_temp_dirs_removed || [],
        stale_locks_removed: cleanupProof?.stale_locks_removed || [],
        skipped_active_sessions: cleanupProof?.skipped_active_sessions || []
      },
      intelligent_work_graph: {
        status: intelligentWorkGraph?.ok === true ? 'passed' : intelligentWorkGraph ? 'partial' : 'not_run',
        score: intelligentWorkGraph?.work_graph_quality_score ?? null,
        test_ownership: 'agent-test-ownership-map.json',
        critical_path: 'agent-critical-path.json',
        integration_bottlenecks: 'agent-integration-bottlenecks.json'
      },
      output_schema_ok: input.output_schema_ok !== false,
      output_tail_report: 'agent-output-tails.json',
      output_tail_records: Number(input.outputTails?.record_count || 0),
      timeout_kill_report: 'agent-timeout-kill-report.json',
      killed_timed_out_sessions: Array.isArray(input.timeoutKill?.killed_sessions) ? input.timeoutKill.killed_sessions : [],
      fake_backend_disclaimer: input.backend === 'fake' ? 'fixture only; no execution-authority claim' : null
    },
    patch_handoff_runtime: {
      status: patchHandoff?.ok === true ? 'passed' : patchHandoff ? 'blocked' : 'not_run',
      proof: patchHandoff ? 'agent-patch-handoff-runtime.json' : null,
      transaction_journal: patchJournal ? 'agent-patch-transaction-journal.jsonl' : null,
      transaction_journal_summary: patchJournal ? 'agent-patch-transaction-journal-summary.json' : null,
      transaction_journal_ok: patchJournal?.ok === true,
      transaction_event_count: patchJournal?.event_count ?? null,
      conflict_rebase: conflictRebase ? 'agent-patch-conflict-rebase-results.json' : null,
      conflict_rebase_ok: conflictRebase?.ok === true,
      rebase_attempt_count: conflictRebase?.rebase_attempt_count ?? null
    },
    execution_proof: {
      authority: runtimeTruthMatrix?.execution_authority?.workflow || OFFICIAL_SUBAGENT_EXECUTION_AUTHORITY,
      status: officialSubagentExecution?.proof_level || 'not_run',
      required_mode: officialSubagentExecution?.required_mode === true,
      evidence_role: officialSubagentExecution?.evidence_role || 'execution_authority',
      evidence_artifacts: officialSubagentExecution?.evidence_artifacts || [...OFFICIAL_SUBAGENT_EXECUTION_ARTIFACTS],
      blockers: officialSubagentExecution?.blockers || []
    },
    runtime_truth_groups: runtimeTruthGroups,
    runtime_truth_matrix: runtimeTruthMatrix ? 'runtime-truth-matrix.json' : null,
    proof_level_by_subsystem: subsystemProofLevels,
    fake_real_policy: fakeRealPolicy ? 'fake-real-proof-policy.json' : null,
    blockers: Array.isArray(input.blockers) ? input.blockers : []
  }
  await writeJsonAtomic(path.join(root, 'agent-trust-report.json'), report)
  await writeTextAtomic(path.join(root, 'agent-trust-report.md'), renderAgentTrustReportMarkdown(report))
  return report
}

function renderAgentTrustReportMarkdown(report: any) {
  const orchestration = report.agent_orchestration || {}
  return [
    '# Agent Trust Report',
    '',
    `- backend: ${orchestration.backend || 'unknown'}`,
    `- agent_count: ${orchestration.agent_count || 0}`,
    `- all_sessions_closed: ${orchestration.all_sessions_closed === true}`,
    `- terminal_sessions_closed: ${orchestration.terminal_sessions_closed === true}`,
    `- target_active_slots: ${orchestration.target_active_slots ?? 'unknown'}`,
    `- total_work_items: ${orchestration.total_work_items ?? 'unknown'}`,
    `- active_slot_count: ${orchestration.active_slot_count ?? 'unknown'}`,
    `- completed_count: ${orchestration.completed_count ?? 'unknown'}`,
    `- backfill_count: ${orchestration.backfill_count ?? 'unknown'}`,
    `- expected_backfill_count: ${orchestration.expected_backfill_count ?? 'unknown'}`,
    `- pending_queue_drained: ${orchestration.pending_queue_drained === true}`,
    `- cleanup_executor: ${orchestration.cleanup_executor?.status || 'not_run'}`,
    `- work_graph_quality_score: ${orchestration.intelligent_work_graph?.score ?? 'unknown'}`,
    `- runtime_truth_fake: ${(report.runtime_truth_groups?.Fake || []).join(', ') || 'None'}`,
    `- runtime_truth_optional: ${(report.runtime_truth_groups?.Optional || []).join(', ') || 'None'}`,
    `- runtime_truth_proven: ${(report.runtime_truth_groups?.Proven || []).join(', ') || 'None'}`,
    `- runtime_truth_blocked: ${(report.runtime_truth_groups?.Blocked || []).join(', ') || 'None'}`,
    `- runtime_truth_matrix: ${report.runtime_truth_matrix || 'not_run'}`,
    `- patch_handoff_runtime: ${report.patch_handoff_runtime?.status || 'not_run'}`,
    `- patch_transaction_journal: ${report.patch_handoff_runtime?.transaction_journal || 'not_run'}`,
    `- patch_conflict_rebase: ${report.patch_handoff_runtime?.conflict_rebase || 'not_run'}`,
    `- execution_authority: ${report.execution_proof?.authority || OFFICIAL_SUBAGENT_EXECUTION_AUTHORITY}`,
    `- execution_proof_status: ${report.execution_proof?.status || 'not_run'}`,
    ...Object.entries(report.proof_level_by_subsystem || {}).sort(([a], [b]) => a.localeCompare(b)).map(([name, level]) => `- proof_level.${name}: ${level}`),
    `- generation_count: ${orchestration.generation_count ?? 'unknown'}`,
    `- no_overlap_ok: ${orchestration.no_overlap_ok === true}`,
    `- ledger_hash_chain_ok: ${orchestration.ledger_hash_chain_ok === true}`,
    `- blockers: ${(report.blockers || []).length}`,
    ''
  ].join('\n')
}
