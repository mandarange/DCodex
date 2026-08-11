import path from 'node:path'
import { nowIso, readJson, writeJsonAtomic } from '../fsx.js'
import { buildFixturePatchEnvelopes } from './agent-runner-fake.js'
import { runProcessAgent } from './agent-runner-process.js'
import { validateAgentWorkerResult } from './agent-worker-pipeline.js'
import { normalizeAgentPatchEnvelope, type AgentPatchEnvelope } from './agent-patch-schema.js'
import { runCodexTask } from '../codex-control/codex-control-plane.js'
import { CODEX_AGENT_WORKER_RESULT_SCHEMA_ID, codexAgentWorkerResultSchema } from '../codex-control/schemas/agent-worker-result.schema.js'
import { leanEngineeringCompactText, leanPolicyReference } from '../lean-engineering-policy.js'
import { readCodexLbModelCatalog, readLbHealth } from '../codex-lb/codex-lb-env.js'
import { categoryForWorkerRole, isNarutoGpt56Model, modelRouteReason, routeModel, type ModelChoice, type TaskCategory } from '../provider/model-router.js'
import { codexTimeoutClassForRoute } from '../codex-control/codex-reliability-shield.js'
import { readConfiguredCodexModelRoutingContext } from '../codex-app/codex-model-catalog.js'

export const NATIVE_WORKER_BACKEND_ROUTER_SCHEMA = 'sks.native-worker-backend-router.v1'

type BackendSource = 'fixture' | 'process_generated' | 'model_authored'

export async function runNativeWorkerBackendRouter(input: {
  agentRoot: string
  workerDirRel: string
  resultRel: string
  patchRel: string
  agent: any
  slice: any
  intake: any
  backend: string
  fastModePolicy: { fast_mode: boolean; service_tier: 'fast' | 'standard' }
  guard: any
}) {
  const root = path.resolve(input.agentRoot)
  const pathRoot = path.resolve(input.intake?.cwd || input.intake?.projectRoot || input.agentRoot)
  const requestedBackend = String(input.backend || '')
  let backend = normalizeBackend(requestedBackend)
  const narutoRequest = isNarutoWorkerRequest(input)
  const reportRel = path.join(input.workerDirRel, 'worker-backend-router-report.json')
  const startedAt = nowIso()
  let result: any
  let childReports: any[] = []
  let patchEnvelopes: AgentPatchEnvelope[] = []
  let proofLevel = 'blocked'
  let outputLastMessagePath: string | null = null
  let modelRouting: { category: TaskCategory; choice: ModelChoice; reason: string; explicit: boolean; lb_health: any; lb_catalog: any; blockers: string[] } | null = null

  const narutoBackendBlocker = narutoWorkerBackendBlocker(backend, narutoRequest)
  if (narutoBackendBlocker) {
    const blocker = narutoBackendBlocker
    result = validateAgentWorkerResult(blockedResult(input, [blocker]))
  } else if (!input.guard?.ok) {
    result = validateAgentWorkerResult(blockedResult(input, ['native_cli_worker_recursion_guard_missing']))
  } else if (!backend) {
    result = validateAgentWorkerResult(blockedResult(input, ['unsupported_argument:backend']))
  } else if (backend === 'fake') {
    patchEnvelopes = buildFixturePatchEnvelopes(input.agent, input.slice, envelopeOpts(input, 'fixture'))
    proofLevel = 'fixture_only'
    result = validateAgentWorkerResult(baseResult(input, backend, patchEnvelopes, {
      summary: 'Fake backend generated fixture patch envelopes.',
      confidence: 'fixture',
      unverified: ['fixture backend does not prove real Codex execution']
    }))
  } else if (backend === 'process') {
    const processRun = await runProcessAgent(input.agent, input.slice, {
      missionId: input.intake.mission_id || input.intake.parent_mission_id || '',
      agentRoot: root,
      cwd: input.intake.cwd || root,
      command: Array.isArray(input.intake.process_command) ? input.intake.process_command.map(String) : defaultProcessCommand(input),
      fastMode: input.fastModePolicy.fast_mode,
      serviceTier: input.fastModePolicy.service_tier
    })
    const processReportRel = processRun.artifacts.find((artifact: string) => artifact.endsWith('agent-process-report.json')) || null
    const processReport = processReportRel ? await readJson<any>(path.join(root, processReportRel), null) : null
    childReports = processReport ? [processReport] : []
    patchEnvelopes = buildGeneratedPatchEnvelopes(input, 'process_generated', Number(processReport?.pid))
    proofLevel = processReport?.pid ? 'process_child_proven' : 'verified_partial'
    result = validateAgentWorkerResult({
      ...processRun,
      patch_envelopes: patchEnvelopes,
      ...(patchEnvelopes.length ? {} : { no_patch_reason: buildNoPatchReason(input, backend) }),
      artifacts: [...new Set([...(processRun.artifacts || []), ...(patchEnvelopes.length ? [input.patchRel] : [])])],
      process_child_report: processReport,
      model_authored_patch_envelopes: false,
      fixture_patch_envelopes: false,
      verification: { status: processRun.status === 'done' ? 'passed' : 'failed', checks: [...(processRun.verification?.checks || []), 'native-worker-backend-router', 'process-child-execution'] }
    })
  } else if (backend === 'codex-sdk') {
    modelRouting = await resolveWorkerModelRouting(input)
    if (modelRouting.blockers.length) {
      proofLevel = 'blocked'
      result = validateAgentWorkerResult(blockedResult(input, modelRouting.blockers))
    } else {
    const sdkTask = await runCodexTask({
      route: String(input.intake.route || '$Naruto'),
      tier: 'worker',
      missionId: String(input.intake.mission_id || input.intake.parent_mission_id || ''),
      workItemId: String(input.slice?.id || ''),
      slotId: String(input.agent.slot_id || input.agent.id || ''),
      generationIndex: Number(input.agent.generation_index || 1),
      sessionId: String(input.agent.session_id || ''),
      cwd: String(input.intake.cwd || root),
      prompt: buildWorkerPrompt(input.slice),
      model: modelRouting.choice.model,
      reasoningEffort: modelRouting.choice.reasoning,
      modelReasoningEffort: modelRouting.choice.reasoning,
      serviceTier: modelRouting.choice.serviceTier,
      inputFiles: input.intake.input_files || [],
      inputImages: input.intake.input_images || [],
      outputSchemaId: CODEX_AGENT_WORKER_RESULT_SCHEMA_ID,
      outputSchema: codexAgentWorkerResultSchema as Record<string, unknown>,
      sandboxPolicy: hasWriteLease(input.slice, input.intake) ? 'workspace-write' : 'read-only',
      requestedScopeContract: {
        id: String(input.intake.lease_id || input.slice?.id || ''),
        route: String(input.intake.route || '$Naruto'),
        read_only: !hasWriteLease(input.slice, input.intake),
        allowed_paths: writePaths(input.slice, input.intake),
        write_paths: writePaths(input.slice, input.intake),
        model_route_reason: modelRouting.reason,
        service_tier: modelRouting.choice.serviceTier,
        user_confirmed_full_access: false,
        mad_sks_authorized: input.intake.mad_sks_authorized === true || process.env.SKS_MAD_SKS_ACTIVE === '1'
      },
      backendPreference: ['codex-sdk'],
      mutationLedgerRoot: path.join(root, input.workerDirRel),
      reliabilityPolicy: {
        maxEmptyResultRetries: 1,
        timeoutClass: codexTimeoutClassForRoute(input.intake.route, 'standard')
      }
    })
    outputLastMessagePath = sdkTask.workerResultPath
    const sdkWorkerResult = normalizeSdkWorkerResultPaths(await readJson<any>(sdkTask.workerResultPath, null), input, pathRoot)
    patchEnvelopes = normalizeSdkPatchEnvelopes(sdkWorkerResult?.patch_envelopes || [], input, sdkTask.sdkThreadId, pathRoot)
    proofLevel = sdkTask.ok ? (patchEnvelopes.length ? 'model_authored' : 'codex_sdk_thread_proven') : 'blocked'
    const sdkReport = {
      schema: 'sks.codex-sdk-worker-adapter.v1',
      backend: sdkTask.backend,
      backend_family: sdkTask.backend_family,
      sdk_thread_id: sdkTask.sdkThreadId,
      sdk_run_id: sdkTask.sdkRunId,
      stream_event_count: sdkTask.streamEventCount,
      structured_output_valid: sdkTask.structuredOutputValid,
      worker_result_path: sdkTask.workerResultPath,
      patch_envelope_path: sdkTask.patchEnvelopePath || null,
      model: modelRouting.choice.model,
      model_reasoning_effort: modelRouting.choice.reasoning,
      service_tier: modelRouting.choice.serviceTier,
      model_route_reason: modelRouting.reason,
      blockers: sdkTask.blockers
    }
    childReports = [sdkReport]
    result = validateAgentWorkerResult({
      ...sdkWorkerResult,
      agent_id: workerOwnerId(input),
      session_id: input.agent.session_id,
      persona_id: input.agent.persona_id || input.agent.id,
      task_slice_id: input.slice?.id || '',
      backend: 'codex-sdk',
      patch_envelopes: patchEnvelopes,
      ...(patchEnvelopes.length ? {} : { no_patch_reason: buildNoPatchReason(input, sdkTask.backend || backend) }),
      codex_child_report: sdkReport,
      codex_sdk_thread: sdkReport,
      model_authored_patch_envelopes: patchEnvelopes.length > 0,
      fixture_patch_envelopes: false,
      artifacts: [...new Set([
        ...(sdkWorkerResult?.artifacts || []),
        path.relative(root, sdkTask.workerResultPath),
        path.join(input.workerDirRel, 'codex-control-proof.json'),
        path.join(input.workerDirRel, 'codex-thread-registry.json'),
        path.join(input.workerDirRel, 'codex-sdk-events.jsonl')
      ])],
      blockers: [...(sdkWorkerResult?.blockers || []), ...sdkTask.blockers],
      verification: {
        status: sdkTask.ok ? 'passed' : 'failed',
        checks: [
          ...(sdkWorkerResult?.verification?.checks || []),
          'codex-sdk-control-plane',
          'codex-sdk-event-stream',
          'codex-sdk-structured-output'
        ]
      }
    })
    }
  }

  const report = {
    schema: NATIVE_WORKER_BACKEND_ROUTER_SCHEMA,
    generated_at: nowIso(),
    started_at: startedAt,
    finished_at: nowIso(),
    ok: result.status === 'done',
    selected_backend: backend || input.backend,
    requested_backend: requestedBackend,
    agent_id: input.agent.id,
    session_id: input.agent.session_id,
    worker_process_id: process.pid,
    child_process_ids: childReports.map((report) => Number(report?.pid || report?.codex_child_pid)).filter((pid) => Number.isFinite(pid)),
    output_last_message_path: outputLastMessagePath,
    patch_envelope_count: patchEnvelopes.length,
      model_authored_patch_envelopes: patchEnvelopes.some((envelope: AgentPatchEnvelope) => envelope.source === 'model_authored'),
      fixture_patch_envelopes: patchEnvelopes.some((envelope: AgentPatchEnvelope) => envelope.source === 'fixture'),
    proof_level: proofLevel,
    lean_engineering_policy: leanPolicyReference(),
    fast_mode: input.fastModePolicy.fast_mode,
    service_tier: modelRouting?.choice.serviceTier || input.fastModePolicy.service_tier,
    model: modelRouting?.choice.model || input.agent.model || null,
    model_reasoning_effort: modelRouting?.choice.reasoning || input.agent.model_reasoning_effort || null,
    model_route_reason: modelRouting?.reason || null,
    model_route_category: modelRouting?.category || null,
    sdk_thread_id: childReports.find((report) => report?.sdk_thread_id)?.sdk_thread_id || null,
    sdk_run_id: childReports.find((report) => report?.sdk_run_id)?.sdk_run_id || null,
    stream_event_count: Number(childReports.find((report) => report?.stream_event_count)?.stream_event_count || 0),
    structured_output_valid: childReports.some((report) => report?.structured_output_valid === true),
    blockers: result.blockers || []
  }
  await writeJsonAtomic(path.join(root, reportRel), report)
  return {
    result: validateAgentWorkerResult({
      ...result,
      backend_router_report: report,
      artifacts: [...new Set([...(result.artifacts || []), reportRel])]
    }),
    report,
    reportRel,
    patchEnvelopes
  }
}

export async function resolveWorkerModelRouting(input: {
  agent: any
  slice: any
  intake: any
  fastModePolicy: { fast_mode: boolean; service_tier: 'fast' | 'standard' }
}, deps: { lbHealth?: any; lbCatalog?: any; env?: NodeJS.ProcessEnv } = {}) {
  const narutoOnly = Boolean(input.agent?.naruto_role) || /\$?naruto/i.test(String(input.intake?.route || ''))
  const taskKindText = [
    input.slice?.work_item_kind,
    input.slice?.kind,
    input.slice?.type,
    input.slice?.title,
    input.slice?.required_role,
    input.slice?.role,
    input.agent?.naruto_role,
    input.agent?.role,
    input.agent?.persona_id
  ].map((value) => String(value || '')).join(' ')
  const riskText = [taskKindText, input.slice?.risk, input.slice?.risk_focus, input.slice?.acceptance, input.slice?.parent_prompt, input.slice?.description, input.intake?.prompt].map((value) => String(value || '')).join(' ')
  const category = categoryForWorkerRole(String(input.agent?.role || 'executor'), taskKindText)
  const env = deps.env || process.env
  const configuredRouting = !Object.prototype.hasOwnProperty.call(deps, 'env') || env.CODEX_HOME || env.HOME
    ? await readConfiguredCodexModelRoutingContext({ env }).catch(() => null)
    : null
  const sealedPlanModel = ['user_role_model_preference', 'active_main_model'].includes(
    String(input.agent?.routed_model_policy || '')
  )
    ? String(input.agent?.routed_model || '').trim()
    : ''
  const configuredMainModel = String(
    input.intake?.main_model
    || input.intake?.selected_model
    || input.intake?.provider_model
    || configuredRouting?.selected_model
    || ''
  ).trim()
  const managedAgentModel = String(input.agent?.model || '').trim()
  const inheritedModel = sealedPlanModel || configuredMainModel || managedAgentModel
  const providerModelSelected = Boolean(sealedPlanModel || configuredMainModel)
  const lbHealth = Object.prototype.hasOwnProperty.call(deps, 'lbHealth') ? deps.lbHealth : await readLbHealth().catch(() => null)
  const lbCatalog = narutoOnly && !providerModelSelected
    ? Object.prototype.hasOwnProperty.call(deps, 'lbCatalog')
      ? deps.lbCatalog
      : input.intake?.naruto_model_catalog || await readCodexLbModelCatalog().catch(() => null)
    : null
  const explicitModel = String(env.SKS_WORKER_MODEL || env.SKS_AGENT_MODEL || '').trim()
  const explicitReasoningRaw = String(env.SKS_WORKER_REASONING || env.SKS_WORKER_MODEL_REASONING || '').trim()
  const explicitTierRaw = String(env.SKS_WORKER_SERVICE_TIER || env.SKS_SERVICE_TIER || '').trim()
  const explicitReasoning = normalizeModelReasoning(explicitReasoningRaw)
  const explicitTier = normalizeServiceTier(explicitTierRaw)
  const explicitNarutoModelInvalid = narutoOnly && Boolean(explicitModel) && !isNarutoGpt56Model(explicitModel)
  const explicitNarutoReasoningInvalid = narutoOnly && Boolean(explicitReasoningRaw) && !explicitReasoning
  const explicitNarutoTierInvalid = narutoOnly && Boolean(explicitTierRaw) && !explicitTier
  const inheritedReasoning = normalizeModelReasoning(
    sealedPlanModel
      ? input.agent?.routed_model_reasoning_effort
      : input.agent?.model_reasoning_effort
  )
  const routed = providerModelSelected
    ? {
        model: inheritedModel,
        reasoning: explicitReasoning || inheritedReasoning || 'medium',
        serviceTier: explicitTier || input.fastModePolicy.service_tier || 'fast'
      } satisfies ModelChoice
    : explicitModel && !narutoOnly
    ? {
        model: explicitModel,
        reasoning: explicitReasoning || inheritedReasoning || 'medium',
        serviceTier: explicitTier || input.fastModePolicy.service_tier || 'fast'
      } satisfies ModelChoice
    : await routeModel(category, {
        lbHealth,
        ...(narutoOnly ? {
          narutoOnly: true,
          taskText: taskKindText,
          riskText,
          availableModels: lbCatalog?.models || [],
          availableModelEfforts: lbCatalog?.model_efforts || {},
          ...(explicitModel ? { model: explicitModel } : {})
        } : { model: inheritedModel || null })
      })
  const blockers = [
    ...(narutoOnly && !providerModelSelected && !lbCatalog?.ok ? (lbCatalog?.blockers || ['codex_lb_model_catalog_unavailable']) : []),
    ...(explicitNarutoModelInvalid ? ['naruto_worker_model_outside_gpt_5_6_family'] : []),
    ...(explicitNarutoReasoningInvalid ? ['naruto_reasoning_override_invalid'] : []),
    ...(explicitNarutoTierInvalid ? ['naruto_service_tier_override_invalid'] : []),
    ...(narutoOnly && explicitReasoning && explicitReasoning !== routed.reasoning ? ['naruto_reasoning_override_conflicts_with_policy'] : []),
    ...(narutoOnly && explicitTier && explicitTier !== 'fast' ? ['naruto_service_tier_override_conflicts_with_policy'] : []),
    ...(narutoOnly && !routed.model ? ['naruto_worker_model_unavailable'] : [])
  ]
  return {
    category,
    choice: routed,
    explicit: Boolean(explicitModel || providerModelSelected),
    lb_health: lbHealth,
    lb_catalog: lbCatalog,
    blockers: [...new Set(blockers)],
    reason: modelRouteReason(category, routed, {
      explicit: Boolean(explicitModel || providerModelSelected),
      quotaLow: lbHealth?.quota_low === true,
      degraded: lbHealth?.degraded_models || []
    })
  }
}

function normalizeModelReasoning(value: unknown): ModelChoice['reasoning'] | null {
  const text = String(value || '').toLowerCase()
  return text === 'low' || text === 'medium' || text === 'high' || text === 'xhigh' || text === 'max' || text === 'ultra' ? text : null
}

function normalizeServiceTier(value: unknown): ModelChoice['serviceTier'] | null {
  const text = String(value || '').toLowerCase()
  return text === 'standard' ? 'standard' : text === 'fast' || text === 'priority' ? 'fast' : null
}

function isNarutoWorkerRequest(input: { agent?: any; intake?: any }): boolean {
  return Boolean(input.agent?.naruto_role) || /\$?naruto/i.test(String(input.intake?.route || ''))
}

export function narutoWorkerBackendBlocker(backend: string | null, narutoRequest = true): string | null {
  if (!narutoRequest) return null
  if (backend === 'process') return 'naruto_gpt_5_6_family_only_process_backend_forbidden'
  return null
}

function normalizeBackend(value: string): 'fake' | 'process' | 'codex-sdk' | null {
  return value === 'fake' || value === 'process' || value === 'codex-sdk' ? value : null
}

function envelopeOpts(input: any, source: BackendSource, childPid?: number) {
  return {
    missionId: input.intake.mission_id || input.intake.parent_mission_id || '',
    route: input.intake.route || '$Naruto',
    fastMode: input.fastModePolicy.fast_mode,
    serviceTier: input.fastModePolicy.service_tier,
    nativeCliWorkerSessionId: input.agent.session_id,
    nativeCliProcessId: process.pid,
    workerProcessId: process.pid,
    source,
    ...(childPid === undefined ? {} : { backendChildProcessId: childPid })
  }
}

function buildGeneratedPatchEnvelopes(input: any, source: BackendSource, childPid?: number) {
  return buildFixturePatchEnvelopes(input.agent, input.slice, envelopeOpts(input, source, childPid)).map((envelope: AgentPatchEnvelope) => normalizeAgentPatchEnvelope({
    ...envelope,
    source,
    worker_process_id: process.pid,
    ...(childPid === undefined ? {} : { backend_child_process_id: childPid })
  }))
}

function buildWorkerPrompt(slice: any) {
  const write = writePaths(slice, {})
  return [
    String(slice?.description || slice?.title || 'Complete the assigned worker task.'),
    '',
    write.length
      ? `Write-capable slice. Return JSON matching ${CODEX_AGENT_WORKER_RESULT_SCHEMA_ID}; include patch_envelopes for write_paths=${JSON.stringify(write)}.`
      : `Read-only slice. Return JSON matching ${CODEX_AGENT_WORKER_RESULT_SCHEMA_ID}; do not report pre-existing repository dirtiness as changed_files.`,
    write.length
      ? 'Patch envelopes must touch only the listed write_paths. For small file edits, prefer operations like {"op":"write","path":"relative/file","content":"complete final file content"}; use replace only when search text is copied verbatim from the current file.'
      : '',
    write.length
      ? 'Quality gates run before queue acceptance: impact-scan requires cochanged callers for exported signature changes, machine-feedback runs type/lint/related tests, diff-quality blocks dead exports, and compiled mistake rules block repeated mistakes.'
      : '',
    write.length
      ? 'Every write result must report verification status passed with at least one concrete check, or status not_applicable with a specific reason. For a reproducible bug or changed observable behavior, add the smallest regression check that would catch it. Do not manufacture a dedicated test when a smaller real check is sufficient. For repair work, include repair_hypothesis before patching.'
      : '',
    leanEngineeringCompactText(),
    'Required JSON fields: status, summary, findings, changed_files, patch_envelopes, verification, rollback_notes, blockers.'
  ].join('\n')
}

function buildNoPatchReason(input: any, backend: string) {
  const writePathCount = writePaths(input.slice, input.intake).length
  return {
    schema: 'sks.native-cli-worker-no-patch-reason.v1',
    generated_at: nowIso(),
    ok: writePathCount === 0,
    reason: writePathCount ? 'write_capable_task_without_backend_patch_envelope' : 'read_only_or_no_write_paths',
    route_justification: writePathCount ? 'backend returned no patch envelopes for a write-capable task' : 'task has no write paths',
    read_only_or_noop_evidence: writePathCount === 0,
    task_slice_id: input.slice?.id || null,
    backend,
    blockers: writePathCount && backend !== 'fake' ? ['write_capable_no_patch_envelope'] : []
  }
}

function hasWriteLease(slice: any, intake: any) {
  return writePaths(slice, intake).length > 0
}

function writePaths(slice: any, intake: any) {
  return [
    ...(Array.isArray(slice?.write_paths) ? slice.write_paths : []),
    ...(Array.isArray(intake?.write_paths) ? intake.write_paths : [])
  ].map(String).filter(Boolean)
}

function workerOwnerId(input: any) {
  return String(input.slice?.owner_agent_id || input.slice?.owner || input.agent?.agent_id || input.agent?.id || '')
}

function normalizeSdkWorkerResultPaths(result: any, input: any, root: string) {
  if (!result || typeof result !== 'object') return result
  const normalized = { ...result }
  if (Array.isArray(result.changed_files)) normalized.changed_files = normalizeWorkerPaths(root, result.changed_files)
  if (Array.isArray(result.artifacts)) normalized.artifacts = normalizeWorkerPaths(root, result.artifacts)
  if (Array.isArray(result.writes)) normalized.writes = result.writes.map((write: any) => normalizeWorkerWrite(root, write))
  if (Array.isArray(result.patch_envelopes)) normalized.patch_envelopes = result.patch_envelopes.map((envelope: any) => normalizeWorkerEnvelopePaths(root, envelope, writePaths(input.slice, input.intake)))
  return normalized
}

function normalizeSdkPatchEnvelopes(envelopes: AgentPatchEnvelope[], input: any, sdkThreadId: string, root: string) {
  const fallbackAllowedPaths = normalizeWorkerPaths(root, writePaths(input.slice, input.intake))
  return envelopes.map((rawEnvelope) => {
    const envelope = normalizeWorkerEnvelopePaths(root, rawEnvelope, fallbackAllowedPaths)
    const leaseProof = envelope.lease_proof && typeof envelope.lease_proof === 'object'
      ? envelope.lease_proof
      : {}
    const allowedPaths = Array.isArray(envelope.allowed_paths) && envelope.allowed_paths.length
      ? envelope.allowed_paths
      : fallbackAllowedPaths
    const leaseAllowedPaths = Array.isArray(leaseProof.allowed_paths) && leaseProof.allowed_paths.length
      ? leaseProof.allowed_paths
      : allowedPaths
    const ownerAgent = workerOwnerId(input)
    const verificationNodeId = String(envelope.verification_node_id || leaseProof.verification_node_id || input.slice?.verification_node_id || (input.slice?.id ? `verify:${input.slice.id}` : ''))
    const rollbackNodeId = String(envelope.rollback_node_id || leaseProof.rollback_node_id || input.slice?.rollback_node_id || (input.slice?.id ? `rollback:${input.slice.id}` : ''))
    const strategyTaskId = String(envelope.strategy_task_id || leaseProof.strategy_task_id || input.slice?.strategy_task_id || input.slice?.id || '')
    const microWinId = String(envelope.micro_win_id || leaseProof.micro_win_id || input.slice?.micro_win_id || input.slice?.id || '')
    return normalizeAgentPatchEnvelope({
      ...envelope,
      agent_id: ownerAgent,
      session_id: input.agent.session_id,
      slot_id: envelope.slot_id || input.agent.slot_id || input.agent.session_id || input.agent.id,
      task_slice_id: input.slice?.id || envelope.task_slice_id || '',
      lease_id: envelope.lease_id || input.intake.lease_id || input.slice?.lease_id || input.slice?.id || '',
      allowed_paths: allowedPaths,
      ...(strategyTaskId ? { strategy_task_id: strategyTaskId } : {}),
      ...(microWinId ? { micro_win_id: microWinId } : {}),
      ...(verificationNodeId ? { verification_node_id: verificationNodeId } : {}),
      ...(rollbackNodeId ? { rollback_node_id: rollbackNodeId } : {}),
      ...(verificationNodeId && !envelope.verification_hint ? { verification_hint: { node_id: verificationNodeId, artifact: 'agent-patch-verification-results.json' } } : {}),
      ...(rollbackNodeId && !envelope.rollback_hint ? { rollback_hint: { node_id: rollbackNodeId, artifact: 'agent-patch-rollback-proof.json' } } : {}),
      lease_proof: {
        ...leaseProof,
        lease_id: leaseProof.lease_id || envelope.lease_id || input.intake.lease_id || input.slice?.lease_id || input.slice?.id || '',
        owner_agent: ownerAgent,
        owner_persona: input.agent.persona_id || input.agent.id,
        allowed_paths: leaseAllowedPaths,
        ...(strategyTaskId ? { strategy_task_id: strategyTaskId } : {}),
        ...(microWinId ? { micro_win_id: microWinId } : {}),
        ...(verificationNodeId ? { verification_node_id: verificationNodeId } : {}),
        ...(rollbackNodeId ? { rollback_node_id: rollbackNodeId } : {}),
        protected_path_check: leaseProof.protected_path_check || 'passed'
      },
      source: 'model_authored',
      native_cli_worker_session_id: input.agent.session_id,
      native_cli_process_id: process.pid,
      worker_process_id: process.pid,
      backend_sdk_thread_id: sdkThreadId,
      fast_mode: input.fastModePolicy.fast_mode,
      service_tier: input.fastModePolicy.service_tier
    })
  })
}

function normalizeWorkerEnvelopePaths(root: string, envelope: any, fallbackAllowedPaths: string[]) {
  if (!envelope || typeof envelope !== 'object') return envelope
  const leaseProof = envelope.lease_proof && typeof envelope.lease_proof === 'object'
    ? {
      ...envelope.lease_proof,
      ...(Array.isArray(envelope.lease_proof.allowed_paths) ? { allowed_paths: normalizeWorkerPaths(root, envelope.lease_proof.allowed_paths) } : {})
    }
    : envelope.lease_proof
  return {
    ...envelope,
    ...(Array.isArray(envelope.allowed_paths) ? { allowed_paths: normalizeWorkerPaths(root, envelope.allowed_paths) } : { allowed_paths: fallbackAllowedPaths }),
    ...(leaseProof ? { lease_proof: leaseProof } : {}),
    ...(Array.isArray(envelope.operations) ? { operations: envelope.operations.map((operation: any) => normalizeWorkerPatchOperation(root, operation)) } : {})
  }
}

function normalizeWorkerPatchOperation(root: string, operation: any) {
  if (!operation || typeof operation !== 'object') return operation
  return {
    ...operation,
    path: normalizeWorkerPath(root, operation.path)
  }
}

function normalizeWorkerWrite(root: string, write: any) {
  if (typeof write === 'string') return normalizeWorkerPath(root, write)
  if (!write || typeof write !== 'object') return write
  return {
    ...write,
    ...(write.path === undefined ? {} : { path: normalizeWorkerPath(root, write.path) })
  }
}

function normalizeWorkerPaths(root: string, values: any[]) {
  return values.map((value) => normalizeWorkerPath(root, value)).filter(Boolean)
}

function normalizeWorkerPath(root: string, value: any) {
  const text = String(value || '').trim()
  if (!text) return ''
  const normalizedText = text.replace(/\\/g, '/')
  if (!path.isAbsolute(normalizedText)) return normalizedText
  const resolvedValue = path.resolve(normalizedText)
  for (const candidate of equivalentRootPaths(root)) {
    if (resolvedValue === candidate) return '.'
    const prefix = candidate.endsWith(path.sep) ? candidate : `${candidate}${path.sep}`
    if (resolvedValue.startsWith(prefix)) return path.relative(candidate, resolvedValue).split(path.sep).join('/')
  }
  return normalizedText
}

function equivalentRootPaths(root: string) {
  const resolved = path.resolve(root)
  const candidates = [resolved]
  if (resolved.startsWith('/private/')) candidates.push(resolved.replace(/^\/private/, ''))
  else candidates.push(`/private${resolved}`)
  return [...new Set(candidates)]
}

function defaultProcessCommand(input: any) {
  return [
    process.execPath,
    '-e',
    `console.log(${JSON.stringify(`sks process backend worker ${input.agent.session_id || input.agent.id} completed ${input.slice?.id || 'task'}`)})`
  ]
}

function baseResult(input: any, backend: string, patchEnvelopes: AgentPatchEnvelope[], extra: any = {}) {
  return {
    mission_id: input.intake.mission_id || input.intake.parent_mission_id || '',
    agent_id: input.agent.id,
    session_id: input.agent.session_id,
    persona_id: input.agent.persona_id || input.agent.id,
    task_slice_id: input.slice?.id || '',
    status: 'done',
    backend,
    summary: extra.summary || `Native worker backend ${backend} completed.`,
    findings: [`native worker backend ${backend} executed`],
    proposed_changes: [],
    changed_files: [],
    lease_compliance: { ok: true, violations: [] },
    artifacts: [],
    blockers: [],
    confidence: extra.confidence || 'verified_partial',
    handoff_notes: 'Backend router returned worker result.',
    unverified: extra.unverified || [],
    writes: [],
    patch_envelopes: patchEnvelopes,
    model_authored_patch_envelopes: patchEnvelopes.some((envelope) => envelope.source === 'model_authored'),
    fixture_patch_envelopes: patchEnvelopes.some((envelope) => envelope.source === 'fixture'),
    source_intelligence_refs: input.agent.source_intelligence_refs || input.intake.source_intelligence_refs || null,
    goal_mode_ref: input.agent.goal_mode_ref || input.intake.goal_mode_ref || null,
    verification: { status: 'passed', checks: ['native-worker-backend-router'] },
    recursion_guard: { ok: true, violations: [] }
  }
}

function blockedResult(input: any, blockers: string[]) {
  return {
    ...baseResult(input, String(input.backend || 'unknown'), [], { summary: 'Native worker backend router blocked.', confidence: 'blocked' }),
    status: 'blocked',
    blockers
  }
}
