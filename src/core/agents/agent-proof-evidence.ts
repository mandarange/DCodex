import path from 'node:path'
import { AGENT_PROOF_EVIDENCE_SCHEMA } from './agent-schema.js'
import { nowIso, PACKAGE_VERSION, readJson, writeJsonAtomic } from '../fsx.js'
import { validateAgentLedgerHashChain } from './agent-central-ledger.js'
import { assertAllAgentSessionsClosed } from './agent-lifecycle.js'
import { assertAgentTerminalSessionsClosed } from './agent-terminal-session.js'
import { assertAgentSessionGenerationsClosed } from './agent-session-generation.js'
import { writeFakeRealProofPolicyReport } from '../proof/fake-real-proof-policy.js'
import { buildRuntimeTruthMatrix, writeRuntimeTruthMatrix } from '../proof/runtime-truth-matrix.js'
import { evaluateGptFinalGate } from '../codex-control/gpt-final-gate.js'
import { gptFinalRequiredForPipeline } from '../pipeline/gpt-final-required.js'

export async function writeAgentProofEvidence(root: string, input: { missionId: string; backend: string; route?: string; routeCommand?: string; routeBlackboxKind?: string; requestedWorkItems?: number; minimumWorkItems?: number; targetActiveSlots?: number; realParallel?: boolean; roster?: any; partition?: any; consensus?: any; results?: any[]; cleanup?: any; janitor?: any; trust?: any; wrongness?: any; outputTails?: any; timeoutKill?: any; scheduler?: any; parallelWritePolicy?: any; gitWorktreeRuntime?: any; patchHandoff?: any; strategyGate?: any; nativeCliWorkerRuntimeProof?: any; noSubagentScalingPolicy?: any; officialSubagentHelperPolicy?: any; fastModePolicy?: any; fastModePropagation?: any; triwikiContext?: any; selectedCoreSkill?: any; gptFinalArbiter?: any; finalGptPatchStage?: any }) {
  const lifecycle = await assertAllAgentSessionsClosed(root)
  const terminal = await assertAgentTerminalSessionsClosed(root)
  const generations = await assertAgentSessionGenerationsClosed(root)
  const ledger = await validateAgentLedgerHashChain(root)
  const workQueue = await readJson<any>(path.join(root, 'agent-work-queue.json'), null)
  const scheduler = input.scheduler || await readJson<any>(path.join(root, 'agent-scheduler-state.json'), null)
  const taskGraph = input.partition?.task_graph || await readJson<any>(path.join(root, 'agent-task-graph.json'), null)
  const parallelWritePolicy = input.parallelWritePolicy || await readJson<any>(path.join(root, 'agent-parallel-write-policy.json'), null)
  const gitWorktreeRuntime = input.gitWorktreeRuntime || await readJson<any>(path.join(root, 'agent-git-worktree-runtime.json'), null)
  const patchQueue = await readJson<any>(path.join(root, 'agent-patch-queue.json'), null)
  const patchQueueEvents = await readTextSafe(path.join(root, 'agent-patch-queue-events.jsonl'))
  const patchMerge = await readJson<any>(path.join(root, 'agent-merge-coordinator-report.json'), null)
  const patchApplyResults = await readJson<any>(path.join(root, 'agent-patch-apply-results.json'), null)
  const patchVerificationResults = await readJson<any>(path.join(root, 'agent-patch-verification-results.json'), null)
  const patchRollbackProof = await readJson<any>(path.join(root, 'agent-patch-rollback-proof.json'), null)
  const patchProof = await readJson<any>(path.join(root, 'agent-patch-proof.json'), null)
  const patchHandoff = input.patchHandoff || await readJson<any>(path.join(root, 'agent-patch-handoff-runtime.json'), null)
  const gptFinalArbiter = input.gptFinalArbiter || await readJson<any>(path.join(root, 'gpt-final-arbiter', 'gpt-final-arbiter.json'), null)
  const narutoWorkGraph = await readJson<any>(path.join(root, 'naruto-work-graph.json'), null)
  const narutoRoleDistribution = await readJson<any>(path.join(root, 'naruto-role-distribution.json'), null)
  const narutoConcurrencyGovernor = await readJson<any>(path.join(root, 'naruto-concurrency-governor.json'), null)
  const narutoActivePool = await readJson<any>(path.join(root, 'naruto-active-pool.json'), null)
  const narutoVerificationDag = await readJson<any>(path.join(root, 'naruto-verification-dag.json'), null)
  const gptFinalRequired = gptFinalRequiredForPipeline({ candidateResults: input.results || [] }).gpt_final_required
  const finalGptPatchStage = input.finalGptPatchStage || null
  const gptFinalGate = gptFinalArbiter?.final_gate || evaluateGptFinalGate({
    required: gptFinalRequired,
    gptFinalStatus: gptFinalArbiter?.result?.status || null,
    gptFinalAvailable: Boolean(gptFinalArbiter)
  })
  const nativeCliWorkerRuntimeProof = input.nativeCliWorkerRuntimeProof || await readJson<any>(path.join(root, 'native-cli-worker-runtime-proof.json'), null)
  const noSubagentScalingPolicy = input.noSubagentScalingPolicy || await readJson<any>(path.join(root, 'no-subagent-scaling-policy.json'), null)
  const officialSubagentHelperPolicy = input.officialSubagentHelperPolicy || await readJson<any>(path.join(root, 'official-subagent-helper-policy.json'), null)
  const fastModePropagation = input.fastModePropagation || await readJson<any>(path.join(root, 'fast-mode-propagation-proof.json'), null)
  const cleanupProof = await readJson<any>(path.join(root, 'agent-cleanup-proof.json'), null)
  const intelligentWorkGraph = await readJson<any>(path.join(root, 'agent-intelligent-work-graph.json'), null)
  const slots = await readJson<any>(path.join(root, 'agent-worker-slots.json'), null)
  const generationArtifact = await readJson<any>(path.join(root, 'agent-session-generations.json'), null)
  const strategyGate = input.strategyGate || await readJson<any>(path.join(root, 'strategy-gate.json'), null)
  const schedulerEvents = await readTextSafe(path.join(root, 'agent-scheduler-events.jsonl'))
  const terminalCloseReportCount = terminal.total_sessions || 0
  const generationCount = generations.generation_count || 0
  const finalWorkItemCount = Number(scheduler?.completed_count || 0) + Number(scheduler?.failed_count || 0) + Number(scheduler?.blocked_count || 0)
  const requestedWorkItems = Number(input.requestedWorkItems || taskGraph?.desired_work_items || taskGraph?.total_work_items || 0)
  const taskGraphTotalWorkItems = Number(taskGraph?.total_work_items || 0)
  const workQueueTotalWorkItems = Number(workQueue?.total_work_items || 0)
  const schedulerTotalWorkItems = Number(scheduler?.total_work_items || 0)
  const targetActiveSlots = Number(input.targetActiveSlots || scheduler?.target_active_slots || taskGraph?.target_active_slots || input.roster?.agent_count || 0)
  const minimumWorkItems = Number(input.minimumWorkItems || taskGraph?.minimum_work_items || targetActiveSlots || 0)
  const taskGraphMatchesCliOptions = Boolean(taskGraph) && requestedWorkItems === taskGraphTotalWorkItems && targetActiveSlots === Number(taskGraph.target_active_slots || 0)
  const workQueueMatchesTaskGraph = Boolean(workQueue && taskGraph) && workQueueTotalWorkItems === taskGraphTotalWorkItems
  const schedulerMatchesWorkQueue = Boolean(scheduler && workQueue) && schedulerTotalWorkItems === workQueueTotalWorkItems
  const terminalReportsMatchGenerations = terminalCloseReportCount >= generationCount
  const taskGraphSourceRefsOk = Boolean(taskGraph?.work_items?.length) && taskGraph.work_items.every((item: any) => item.source_intelligence_refs)
  const taskGraphGoalRefsOk = Boolean(taskGraph?.work_items?.length) && taskGraph.work_items.every((item: any) => item.goal_mode_ref)
  const taskGraphStrategyRefsOk = Boolean(taskGraph?.work_items?.length) && taskGraph.work_items.every((item: any) => item.strategy_refs)
  const workQueueSourceRefsOk = Boolean(workQueue?.items?.length) && workQueue.items.every((item: any) => item.source_intelligence_refs)
  const workQueueGoalRefsOk = Boolean(workQueue?.items?.length) && workQueue.items.every((item: any) => item.goal_mode_ref)
  const workQueueStrategyRefsOk = Boolean(workQueue?.items?.length) && workQueue.items.every((item: any) => item.slice?.strategy_refs)
  const route = String(input.route || taskGraph?.route_type || 'internal-worker-runtime')
  const isNarutoRoute = route === '$Naruto'
  const routeCommand = String(input.routeCommand || 'internal-worker-runtime')
  const realRouteCommandUsed = routeCommand !== 'internal-worker-runtime'
  const patchEntries = Array.isArray(patchQueue?.entries) ? patchQueue.entries : []
  const patchApplyRows = Array.isArray(patchApplyResults?.results) ? patchApplyResults.results : []
  const patchQueuePendingCount = Number(patchQueue?.queued_count || patchEntries.filter((entry: any) => entry.status === 'pending').length || 0)
  const patchConflictCount = Number(patchMerge?.conflicts?.length || patchMerge?.serial_conflicts?.length || 0)
  const serialBottleneckCount = Number(patchMerge?.serial_conflicts?.length || 0)
  const patchQueueOk = patchHandoff ? Boolean(patchQueue) && patchQueuePendingCount === 0 : true
  const patchApplyOk = patchHandoff ? patchApplyRows.every((row: any) => row.ok !== false) : true
  const patchVerificationOk = patchHandoff ? patchVerificationResults?.ok !== false && patchApplyRows.every((row: any) => {
    const changed = Array.isArray(row.changed_files) && row.changed_files.length > 0
    return !changed || (row.verification?.status && row.verification.status !== 'failed')
  }) : true
  const patchRollbackOk = patchHandoff ? patchRollbackProof?.ok !== false && patchApplyRows.every((row: any) => {
    const changed = Array.isArray(row.changed_files) && row.changed_files.length > 0
    return !changed || Boolean(row.rollback_digest)
  }) : true
  const parallelPatchApplyVerified = patchHandoff ? Array.isArray(patchProof?.wall_clock_parallel_evidence) && patchProof.wall_clock_parallel_evidence.length > 0 || Number(patchHandoff?.parallel_apply_count || 0) > 1 : false
  const readOnlyNoWriteLeaseMode = isReadOnlyNoWriteLeaseMode({
    results: input.results || [],
    leases: input.partition?.leases || [],
    parallelWritePolicy,
    taskGraph,
    narutoWorkGraph
  })
  const changedFileLeaseBlockers = readOnlyNoWriteLeaseMode ? [] : agentChangedFileLeaseViolations(input.results || [], input.partition?.leases || [])
  const schedulerBackfillSatisfied = !scheduler
    || Number(scheduler.expected_backfill_count || 0) <= Number(scheduler.backfill_count || 0)
    || (scheduler.pending_queue_drained === true
      && Number(scheduler.active_slot_count || 0) === 0
      && Number(scheduler.max_observed_active_slots || 0) >= Number(scheduler.target_active_slots || 0))
  const workQueueItems = Array.isArray(workQueue?.items) ? workQueue.items : []
  const workItemsNotAllCompletedIds = workQueueItems
    .filter((item: any) => item.status !== 'completed')
    .map((item: any) => String(item.id))
  const workItemsFailedOrBlockedCount = Number(scheduler?.failed_count || 0) + Number(scheduler?.blocked_count || 0)
  const workItemStatusById = new Map(workQueueItems.map((item: any) => [String(item.id), String(item.status)]))
  const orphanedPendingWorkItemIds = workQueueItems
    .filter((item: any) => item.status === 'pending')
    .filter((item: any) => (Array.isArray(item.dependencies) ? item.dependencies : []).some((dep: any) => {
      const depStatus = workItemStatusById.get(String(dep))
      return depStatus === 'failed' || depStatus === 'blocked' || !depStatus
    }))
    .map((item: any) => String(item.id))
  const blockers = [
    ...(lifecycle.ok ? [] : ['agent_lifecycle_not_all_closed']),
    ...(lifecycle.ok ? [] : lifecycle.open_sessions.map((id: string) => 'session_open:' + id)),
    ...((input.timeoutKill?.killed_sessions || []).map((id: string) => 'session_timeout_killed:' + id)),
    ...(terminal.ok ? [] : terminal.blockers),
    ...(generations.ok ? [] : generations.blockers),
    ...(!scheduler ? ['agent_scheduler_state_missing'] : []),
    ...(!workQueue ? ['agent_work_queue_missing'] : []),
    ...(!schedulerEvents.trim() ? ['agent_scheduler_events_missing'] : []),
    ...(!slots ? ['agent_worker_slots_missing'] : []),
    ...(!generationArtifact ? ['agent_session_generations_missing'] : []),
    ...(Array.isArray(scheduler?.blockers) ? scheduler.blockers : []),
    ...(scheduler && scheduler.pending_count > 0 && scheduler.active_slot_count === 0 ? ['scheduler_pending_queue_without_active_sessions'] : []),
    ...(scheduler && scheduler.pending_queue_drained !== true ? ['scheduler_pending_queue_not_drained'] : []),
    ...(scheduler && Number(scheduler.active_slot_count || 0) !== 0 ? ['scheduler_active_slots_not_zero_at_finalization'] : []),
    ...(schedulerBackfillSatisfied ? [] : ['scheduler_backfill_count_below_expected']),
    ...(scheduler && Number(scheduler.total_work_items || 0) >= Number(scheduler.target_active_slots || 0) && Number(scheduler.max_observed_active_slots || 0) !== Number(scheduler.target_active_slots || 0) ? ['scheduler_max_observed_active_slots_mismatch'] : []),
    ...(taskGraph && !taskGraphMatchesCliOptions ? ['task_graph_cli_options_mismatch'] : []),
    ...(workQueue && taskGraph && !workQueueMatchesTaskGraph ? ['work_queue_task_graph_mismatch'] : []),
    ...(scheduler && workQueue && !schedulerMatchesWorkQueue ? ['scheduler_work_queue_mismatch'] : []),
    ...(workQueue && schedulerTotalWorkItems && Number(scheduler?.completed_count || 0) !== schedulerTotalWorkItems ? ['work_items_not_all_completed:' + workItemsNotAllCompletedIds.join(',')] : []),
    ...(workItemsFailedOrBlockedCount > 0 ? ['work_items_failed:' + workItemsFailedOrBlockedCount] : []),
    ...(orphanedPendingWorkItemIds.length ? ['work_items_orphaned_pending:' + orphanedPendingWorkItemIds.join(',')] : []),
    ...(taskGraph && !taskGraphSourceRefsOk ? ['task_graph_source_refs_missing'] : []),
    ...(taskGraph && !taskGraphGoalRefsOk ? ['task_graph_goal_refs_missing'] : []),
    ...(taskGraph && !taskGraphStrategyRefsOk ? ['task_graph_strategy_refs_missing'] : []),
    ...(workQueue && !workQueueSourceRefsOk ? ['work_queue_source_refs_missing'] : []),
    ...(workQueue && !workQueueGoalRefsOk ? ['work_queue_goal_refs_missing'] : []),
    ...(workQueue && !workQueueStrategyRefsOk ? ['work_queue_strategy_refs_missing'] : []),
    ...(strategyGate?.ok === false ? strategyGate.blockers || ['strategy_gate_not_ok'] : []),
    ...(generationCount < finalWorkItemCount ? ['session_generation_count_below_finished_work_items'] : []),
    ...(terminalCloseReportCount < generationCount ? ['terminal_close_report_count_below_generation_count'] : []),
    ...(slots && slots.all_slots_closed_after_drain !== true ? ['agent_worker_slots_not_closed_after_drain'] : []),
    ...(ledger.blockers || []),
    ...(input.partition?.blockers || []),
    ...(input.consensus?.blockers || []),
    ...(input.janitor?.ok === false ? input.janitor.blockers || ['agent_janitor_not_ok'] : []),
    ...(cleanupProof?.ok === false ? cleanupProof.blockers || ['agent_cleanup_proof_not_ok'] : []),
    ...(input.results || []).flatMap((result: any) => result.blockers || []),
    ...(nativeCliWorkerRuntimeProof?.ok === false ? nativeCliWorkerRuntimeProof.blockers || ['native_cli_worker_runtime_proof_not_ok'] : []),
    ...(noSubagentScalingPolicy?.ok === false ? noSubagentScalingPolicy.blockers || ['no_subagent_scaling_policy_not_ok'] : []),
    ...(officialSubagentHelperPolicy?.ok === false ? officialSubagentHelperPolicy.blockers || ['official_subagent_helper_policy_not_ok'] : []),
    ...(fastModePropagation?.ok === false ? fastModePropagation.blockers || ['fast_mode_propagation_not_ok'] : []),
    ...(patchHandoff?.ok === false ? patchHandoff.blockers || ['patch_handoff_not_ok'] : []),
    ...(gitWorktreeRuntime?.required === true && gitWorktreeRuntime?.ok === false ? gitWorktreeRuntime.blockers || ['git_worktree_runtime_not_ok'] : []),
    ...(patchHandoff && !patchQueue ? ['patch_queue_missing'] : []),
    ...(patchHandoff && !patchMerge ? ['patch_merge_report_missing'] : []),
    ...(patchHandoff && !patchApplyResults ? ['patch_apply_results_missing'] : []),
    ...(patchHandoff && !patchVerificationResults ? ['patch_verification_results_missing'] : []),
    ...(patchHandoff && !patchRollbackProof ? ['patch_rollback_proof_missing'] : []),
    ...(patchHandoff && patchProof?.ok === false ? patchProof.blockers || ['patch_proof_not_ok'] : []),
    ...(patchHandoff && !patchQueueOk ? ['patch_queue_not_ok'] : []),
    ...(patchHandoff && !patchApplyOk ? ['patch_apply_not_ok'] : []),
    ...(patchHandoff && !patchVerificationOk ? ['patch_verification_not_ok'] : []),
    ...(patchHandoff && !patchRollbackOk ? ['patch_rollback_not_ok'] : []),
    ...(gptFinalRequired && gptFinalGate.ok !== true ? gptFinalGate.blockers || ['gpt_final_arbiter_gate_not_ok'] : []),
    ...(gptFinalRequired && gptFinalArbiter?.ok !== true ? gptFinalArbiter?.blockers || ['gpt_final_arbiter_not_ok'] : []),
    ...(gptFinalRequired && finalGptPatchStage?.ok === false ? finalGptPatchStage.blockers || ['final_gpt_patch_stage_not_ok'] : []),
    ...(isNarutoRoute && !narutoWorkGraph ? ['naruto_work_graph_missing'] : []),
    ...(isNarutoRoute && narutoWorkGraph?.ok === false ? narutoWorkGraph.blockers || ['naruto_work_graph_not_ok'] : []),
    ...(isNarutoRoute && !narutoRoleDistribution ? ['naruto_role_distribution_missing'] : []),
    ...(isNarutoRoute && narutoRoleDistribution?.ok === false ? narutoRoleDistribution.blockers || ['naruto_role_distribution_not_ok'] : []),
    ...(isNarutoRoute && !narutoConcurrencyGovernor ? ['naruto_concurrency_governor_missing'] : []),
    ...(isNarutoRoute && !narutoActivePool ? ['naruto_active_pool_missing'] : []),
    ...(isNarutoRoute && narutoActivePool?.ok === false ? narutoActivePool.blockers || ['naruto_active_pool_not_ok'] : []),
    ...(isNarutoRoute && !narutoVerificationDag ? ['naruto_verification_dag_missing'] : []),
    ...changedFileLeaseBlockers
  ]
  const evidence = {
    schema: AGENT_PROOF_EVIDENCE_SCHEMA,
    ok: blockers.length === 0,
    status: blockers.length ? 'blocked' : 'passed',
    generated_at: nowIso(),
    mission_id: input.missionId,
    backend: input.backend,
    route,
    route_command: routeCommand,
    // Deployed Core Skill snapshot consulted at route start (read-only; never
    // confers mutation rights). Null when no snapshot is deployed for this route.
    selected_core_skill: input.selectedCoreSkill || null,
    git_worktree_runtime: gitWorktreeRuntime,
    route_blackbox_kind: input.routeBlackboxKind || (realRouteCommandUsed ? 'actual_route_command' : 'internal_worker_runtime'),
    real_route_command_used: realRouteCommandUsed,
    native_cli_worker_runtime_proof: nativeCliWorkerRuntimeProof ? 'native-cli-worker-runtime-proof.json' : null,
    native_cli_worker_runtime: nativeCliWorkerRuntimeProof ? 'native-cli-worker-runtime.json' : null,
    no_subagent_scaling_policy: noSubagentScalingPolicy ? 'no-subagent-scaling-policy.json' : null,
    official_subagent_helper_policy: officialSubagentHelperPolicy ? 'official-subagent-helper-policy.json' : null,
    official_subagent_helper_lane_enabled: officialSubagentHelperPolicy?.official_codex_subagent_helper_lane_enabled === true,
    official_subagent_helper_lane_ok: officialSubagentHelperPolicy?.ok === true,
    official_subagent_helper_worker_capacity_credit: Number(officialSubagentHelperPolicy?.worker_capacity_credit || 0),
    official_subagent_helper_observed_subagent_event_count: Number(officialSubagentHelperPolicy?.observed_subagent_event_count || 0),
    official_subagent_helper_events_counted_as_worker_sessions: officialSubagentHelperPolicy?.subagent_events_counted_as_worker_sessions === true,
    official_subagent_helper_capacity_source: officialSubagentHelperPolicy?.worker_capacity_source || null,
    official_subagent_helper_parallel_allowed: officialSubagentHelperPolicy?.helper_lane_may_run_in_parallel_with_native_workers === true,
    official_subagent_helper_capabilities: officialSubagentHelperPolicy?.codex_app_capabilities_allowed || [],
    official_subagent_helper_builtin_agents: officialSubagentHelperPolicy?.built_in_agents_allowed || [],
    official_subagent_helper_required_output_proof_for_generated_images: officialSubagentHelperPolicy?.required_output_proof_for_generated_images || [],
    codex_builtin_imagegen_helper_allowed: officialSubagentHelperPolicy?.codex_builtin_imagegen_helper_allowed === true,
    codex_builtin_imagegen_required_surface: officialSubagentHelperPolicy?.preferred_image_generation_surface || null,
    codex_builtin_imagegen_evidence_class: officialSubagentHelperPolicy?.codex_app_builtin_evidence_class || null,
    imagegen_api_fallback_evidence_class: officialSubagentHelperPolicy?.api_fallback_evidence_class || null,
    imagegen_provider_surface_evidence_required: officialSubagentHelperPolicy?.provider_surface_evidence_required === true,
    imagegen_api_fallback_counts_as_codex_app_evidence: officialSubagentHelperPolicy?.imagegen_api_fallback_counts_as_codex_app_evidence === true,
    fast_mode_policy: input.fastModePolicy || null,
    fast_mode_propagation: fastModePropagation ? 'fast-mode-propagation-proof.json' : null,
    native_cli_worker_process_count: Number(nativeCliWorkerRuntimeProof?.spawned_worker_process_count || 0),
    native_cli_max_observed_worker_process_count: Number(nativeCliWorkerRuntimeProof?.max_observed_worker_process_count || 0),
    native_cli_unique_worker_session_count: Number(nativeCliWorkerRuntimeProof?.unique_worker_session_count || 0),
    native_cli_subagent_scaling_blocked: noSubagentScalingPolicy?.ok === true,
    service_tier: input.fastModePolicy?.service_tier || fastModePropagation?.service_tier || 'fast',
    fast_mode: input.fastModePolicy?.fast_mode !== false,
    parallel_write_policy: 'agent-parallel-write-policy.json',
    strategy_gate: 'strategy-gate.json',
    strategy_gate_ok: strategyGate?.ok === true,
    strategy_scheduler_allowed: strategyGate?.scheduler_allowed === true,
    parallel_write_route_flags_wired: parallelWritePolicy?.route_level_flags_wired === true,
    parallel_write_mode: parallelWritePolicy?.write_mode || 'off',
    parallel_write_apply_patches: parallelWritePolicy?.apply_patches === true,
    parallel_write_dry_run_patches: parallelWritePolicy?.dry_run_patches === true,
    parallel_write_max_write_agents: Number(parallelWritePolicy?.max_write_agents || 0),
    gpt_final_arbiter: gptFinalArbiter ? 'gpt-final-arbiter/gpt-final-arbiter.json' : null,
    gpt_final_required: gptFinalRequired,
    gpt_final_status: gptFinalArbiter?.result?.status || (gptFinalRequired ? 'missing' : 'not_required_no_worktree_candidates'),
    gpt_final_backend: gptFinalArbiter?.backend || null,
    gpt_final_patch_source: finalGptPatchStage?.final_patch_source || (gptFinalRequired ? 'blocked' : 'not_applicable'),
    gpt_final_gate_ok: gptFinalGate.ok === true,
    gpt_final_gate: gptFinalGate,
    naruto_work_graph: narutoWorkGraph ? 'naruto-work-graph.json' : null,
    naruto_total_work_items: Number(narutoWorkGraph?.total_work_items || 0),
    naruto_mixed_work_kinds: narutoWorkGraph?.mixed_work_kinds || [],
    naruto_write_allowed_count: Number(narutoWorkGraph?.write_allowed_count || 0),
    naruto_role_distribution: narutoRoleDistribution ? 'naruto-role-distribution.json' : null,
    naruto_role_distribution_entries: narutoRoleDistribution?.entries || [],
    naruto_verifier_only: narutoRoleDistribution?.verifier_only === true,
    naruto_implementation_like_ratio: Number(narutoRoleDistribution?.implementation_like_ratio || 0),
    naruto_concurrency_governor: narutoConcurrencyGovernor ? 'naruto-concurrency-governor.json' : null,
    naruto_safe_active_workers: Number(narutoConcurrencyGovernor?.safe_active_workers || 0),
    naruto_active_pool: narutoActivePool ? 'naruto-active-pool.json' : null,
    naruto_active_pool_refill_events: Number(narutoActivePool?.refill_events || 0),
    naruto_verification_dag: narutoVerificationDag ? 'naruto-verification-dag.json' : null,
    patch_handoff_runtime: patchHandoff ? 'agent-patch-handoff-runtime.json' : null,
    patch_queue: patchHandoff ? 'agent-patch-queue.json' : null,
    patch_queue_events: patchHandoff ? 'agent-patch-queue-events.jsonl' : null,
    patch_queue_event_count: patchQueueEvents.split(/\n/).filter(Boolean).length,
    patch_proof: patchHandoff ? 'agent-patch-proof.json' : null,
    patch_queue_ok: patchQueueOk,
    patch_apply_ok: patchApplyOk,
    patch_verification_ok: patchVerificationOk,
    patch_rollback_ok: patchRollbackOk,
    parallel_patch_apply_verified: parallelPatchApplyVerified,
    patch_conflict_count: patchConflictCount,
    serial_bottleneck_count: serialBottleneckCount,
    changed_files_by_agent: changedFilesByAgent(patchApplyRows, patchEntries),
    lease_compliance_by_patch: leaseComplianceByPatch(patchEntries, input.partition?.leases || [], patchProof),
    rollback_digest_count: patchApplyRows.filter((row: any) => row.rollback_digest).length,
    real_parallel_claim: input.realParallel === true && input.backend === 'codex-sdk',
    fake_backend_disclaimer: input.backend === 'fake' ? 'fixture only; no real parallel execution claim' : null,
    agent_count: input.roster?.agent_count || input.results?.length || 0,
    max_agents: input.roster?.max_agents || 20,
    all_sessions_closed: lifecycle.ok,
    launched_count: lifecycle.launched_count,
    closed_session_count: lifecycle.closed_session_count,
    terminal_sessions_closed: terminal.ok,
    terminal_session_count: terminal.total_sessions,
    terminal_generation_count: generations.generation_count,
    terminal_close_report_count: terminalCloseReportCount,
    terminal_close_report: 'sessions/<slot_id>/gen-<n>/agent-terminal-close-report.json',
    session_generation_count: generations.generation_count,
    all_generations_closed: generations.ok,
    scheduler_state: 'agent-scheduler-state.json',
    target_active_slots: targetActiveSlots,
    requested_work_items: requestedWorkItems,
    actual_total_work_items: taskGraphTotalWorkItems || schedulerTotalWorkItems,
    minimum_work_items: minimumWorkItems,
    task_graph_total_work_items: taskGraphTotalWorkItems,
    work_queue_total_work_items: workQueueTotalWorkItems,
    scheduler_total_work_items: schedulerTotalWorkItems,
    task_graph_matches_cli_options: taskGraphMatchesCliOptions,
    work_queue_matches_task_graph: workQueueMatchesTaskGraph,
    scheduler_matches_work_queue: schedulerMatchesWorkQueue,
    max_observed_active_slots: scheduler?.max_observed_active_slots || 0,
    pending_queue_drained: scheduler?.pending_queue_drained === true,
    backfill_count: scheduler?.backfill_count || 0,
    expected_backfill_count: scheduler?.expected_backfill_count || 0,
    backfill_expected_for_route: Number(scheduler?.expected_backfill_count || 0) > 0,
    slot_count: slots?.slot_count || 0,
    generation_count: generationCount,
    all_slots_closed_after_drain: slots?.all_slots_closed_after_drain === true,
    generated_work_item_count: scheduler?.generated_work_item_count || 0,
    source_intelligence_generation_refs_ok: generations.missing_source_intelligence_refs.length === 0,
    goal_mode_generation_refs_ok: generations.missing_goal_mode_refs.length === 0,
    task_graph_source_refs_ok: taskGraphSourceRefsOk,
    task_graph_goal_refs_ok: taskGraphGoalRefsOk,
    work_queue_source_refs_ok: workQueueSourceRefsOk,
    work_queue_goal_refs_ok: workQueueGoalRefsOk,
    task_graph_strategy_refs_ok: taskGraphStrategyRefsOk,
    work_queue_strategy_refs_ok: workQueueStrategyRefsOk,
    real_truth_summary: {
      fake_backend: input.backend === 'fake',
      cleanup_executor_status: cleanupProof?.ok === true ? 'passed' : cleanupProof ? 'blocked' : 'not_run',
      work_graph_quality_score: Number(intelligentWorkGraph?.work_graph_quality_score || taskGraph?.work_graph_quality_score || 0),
      fake_vs_real_policy: 'fake-real-proof-policy.json'
    },
    intelligent_work_graph: 'agent-intelligent-work-graph.json',
    test_ownership_map: 'agent-test-ownership-map.json',
    critical_path: 'agent-critical-path.json',
    integration_bottlenecks: 'agent-integration-bottlenecks.json',
    work_graph_quality_score: Number(intelligentWorkGraph?.work_graph_quality_score || taskGraph?.work_graph_quality_score || 0),
    work_graph_quality_partial: Number(intelligentWorkGraph?.work_graph_quality_score || taskGraph?.work_graph_quality_score || 0) < 0.55,
    terminal_reports_match_generations: terminalReportsMatchGenerations,
    ledger_hash_chain_ok: ledger.ok,
    no_overlap_ok: input.partition?.no_overlap_proof?.ok !== false,
    consensus_ok: input.consensus?.ok === true,
    output_tail_report: 'agent-output-tails.json',
    output_tail_records: Number(input.outputTails?.record_count || 0),
    timeout_kill_report: 'agent-timeout-kill-report.json',
    timeout_killed_sessions: Array.isArray(input.timeoutKill?.killed_sessions) ? input.timeoutKill.killed_sessions : [],
    cleanup_report: 'agent-cleanup.json',
    janitor_report: 'agent-janitor-report.json',
    janitor_ok: input.janitor?.ok !== false,
    trust_report: 'agent-trust-report.json',
    wrongness_records: 'agent-wrongness-records.json',
    triwiki_context: 'agent-triwiki-context.json',
    triwiki_context_consulted: input.triwikiContext?.present === true,
    context_pack_hash: input.triwikiContext?.context_pack_hash || null,
    triwiki_use_first_count: Number(input.triwikiContext?.use_first?.length || 0),
    triwiki_hydrate_first_count: Number(input.triwikiContext?.hydrate_first?.length || 0),
    triwiki_claim_count: Number(input.triwikiContext?.claim_count || 0),
    changed_files_lease_checked: !readOnlyNoWriteLeaseMode,
    dependency_collision_risk: input.partition?.no_overlap_proof?.dependency_collision_risk || [],
    blockers
  }
  await writeJsonAtomic(path.join(root, 'agent-proof-evidence.json'), evidence)
  await writeFakeRealProofPolicyReport(root, evidence)
  const runtimeTruthMatrix = await buildRuntimeTruthMatrix({
    root: repoRootFromAgentRoot(root),
    agentRoot: root,
    releaseVersion: PACKAGE_VERSION,
    reports: {
      'agent-cleanup-proof.json': cleanupProof,
      'agent-intelligent-work-graph.json': intelligentWorkGraph,
      'source-intelligence-evidence.json': input.partition?.source_intelligence_refs,
      'goal-mode-applied.json': input.partition?.goal_mode_ref,
      'agent-scheduler-state.json': scheduler
      , 'strategy-gate.json': strategyGate
      , 'agent-patch-proof.json': patchProof
      , 'agent-patch-handoff-runtime.json': patchHandoff
      , 'gpt-final-arbiter/gpt-final-arbiter.json': gptFinalArbiter
      , 'native-cli-worker-runtime-proof.json': nativeCliWorkerRuntimeProof
      , 'no-subagent-scaling-policy.json': noSubagentScalingPolicy
      , 'official-subagent-helper-policy.json': officialSubagentHelperPolicy
      , 'fast-mode-propagation-proof.json': fastModePropagation
    }
  })
  await writeRuntimeTruthMatrix(repoRootFromAgentRoot(root), runtimeTruthMatrix, { agentRoot: root })
  return evidence
}

function changedFilesByAgent(applyRows: any[], queueEntries: any[]) {
  const entryAgents = new Map(queueEntries.map((entry) => [String(entry.id), String(entry.envelope?.agent_id || 'unknown')]))
  const out: Record<string, string[]> = {}
  for (const row of applyRows) {
    const agent = entryAgents.get(String(row.entry_id || '')) || 'unknown'
    out[agent] = [...new Set([...(out[agent] || []), ...((row.changed_files || []).map(String))])]
  }
  return out
}

export function leaseComplianceByPatch(queueEntries: any[], leases: any[], patchProof?: any) {
  if (Array.isArray(patchProof?.lease_compliance_by_patch)) {
    const entriesById = new Map(queueEntries.map((entry) => [String(entry.id), entry]))
    return patchProof.lease_compliance_by_patch.map((row: any) => {
      const patchEntryId = String(row.patch_entry_id || row.entry_id || '')
      const entry = entriesById.get(patchEntryId)
      return {
        patch_entry_id: patchEntryId,
        agent_id: entry?.envelope?.agent_id || row.agent_id || null,
        lease_id: row.lease_id || null,
        ok: row.ok === true,
        write_paths: Array.isArray(row.write_paths) ? row.write_paths.map(String) : []
      }
    })
  }
  return queueEntries.map((entry) => {
    const leaseId = entry.envelope?.lease_id || entry.envelope?.lease_proof?.lease_id || null
    const agentId = entry.envelope?.agent_id || null
    const paths = (entry.envelope?.operations || []).map((operation: any) => String(operation.path || ''))
    const lease = leases.find((candidate: any) => candidate.id === leaseId || (candidate.agent_id === agentId && paths.some((file: string) => pathWithin(file, candidate.path))))
    return {
      patch_entry_id: entry.id,
      agent_id: agentId,
      lease_id: leaseId,
      ok: Boolean(lease),
      write_paths: paths
    }
  })
}

export async function readAgentProofEvidence(root: string, missionId: string) {
  return readJson(path.join(root, '.sneakoscope', 'missions', missionId, 'agents', 'agent-proof-evidence.json'), null)
}

async function readTextSafe(file: string) {
  try {
    const fs = await import('node:fs/promises')
    return await fs.readFile(file, 'utf8')
  } catch {
    return ''
  }
}

function agentChangedFileLeaseViolations(results: any[], leases: any[]) {
  const activeWrites = leases.filter((lease) => lease.kind === 'write' && lease.status !== 'released')
  const violations: string[] = []
  for (const result of results) {
    const agentId = result.agent_id
    for (const file of result.changed_files || []) {
      const normalized = String(file || '').replace(/\\/g, '/').replace(/^\.\//, '')
      const allowed = activeWrites.some((lease) => lease.agent_id === agentId && pathWithin(normalized, lease.path))
      if (!allowed) violations.push('lease_changed_file_violation:' + agentId + ':' + normalized)
    }
  }
  return violations
}

function isReadOnlyNoWriteLeaseMode(input: { results: any[]; leases: any[]; parallelWritePolicy: any; taskGraph: any; narutoWorkGraph: any }) {
  const writeLeaseCount = input.leases.filter((lease) => lease.kind === 'write').length
  if (writeLeaseCount > 0) return false
  const resultWriteSignals = input.results.some((result) =>
    (Array.isArray(result?.writes) && result.writes.length > 0)
    || (Array.isArray(result?.patch_envelopes) && result.patch_envelopes.length > 0)
  )
  if (resultWriteSignals) return false
  const policyReadonly = input.parallelWritePolicy?.readonly === true
  const policyWriteOff = String(input.parallelWritePolicy?.write_mode || 'off') === 'off'
  const narutoReadOnly = input.narutoWorkGraph?.readonly === true || Number(input.narutoWorkGraph?.write_allowed_count || 0) === 0
  const taskGraphNoWrites = Number(input.taskGraph?.write_allowed_count || 0) === 0
  return policyReadonly || policyWriteOff || narutoReadOnly || taskGraphNoWrites
}

function pathWithin(file: string, leasePath: string) {
  const left = String(file || '').replace(/\\/g, '/').replace(/^\.\//, '')
  const right = String(leasePath || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')
  return left === right || left.startsWith(right + '/')
}

function repoRootFromAgentRoot(agentRoot: string) {
  const normalized = path.resolve(agentRoot)
  const marker = `${path.sep}.sneakoscope${path.sep}missions${path.sep}`
  if (!normalized.includes(marker)) return normalized
  return path.resolve(normalized, '..', '..', '..', '..')
}
