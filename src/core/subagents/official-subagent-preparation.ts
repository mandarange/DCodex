import fsp from 'node:fs/promises'
import path from 'node:path'
import { nowIso, randomId, readJson, writeJsonAtomic, writeTextAtomic } from '../fsx.js'
import { SSOT_GUARD_ARTIFACT, buildSsotGuard, validateSsotGuardArtifact } from '../safety/ssot-guard.js'
import { classifyTaskProfile } from '../runtime/task-profile.js'
import { chooseVerificationBudget } from '../runtime/verification-budget.js'
import {
  buildOfficialSubagentPrompt,
  validateOfficialSubagentSlices,
  type OfficialSubagentSlice
} from './official-subagent-prompt.js'
import { readOfficialSubagentConfig } from './official-subagent-config.js'
import {
  NARUTO_PARENT_EFFORT,
  NARUTO_PARENT_MODEL
} from './model-policy.js'
import {
  MAX_ON_DEMAND_SUBAGENT_ROLE_COUNT,
  officialSubagentFanoutPolicy,
  officialSubagentOnDemandRolePlan,
  officialSubagentRoleCatalog,
  recommendOfficialSubagentRoles
} from './agent-catalog.js'
import {
  resolveSubagentThreadBudget,
  type SubagentThreadBudgetInput
} from './thread-budget.js'
import { decideNarutoConcurrency } from '../naruto/naruto-concurrency-governor.js'
import type { HardwareCapacityProbeInput } from '../naruto/hardware-capacity-probe.js'
import { createSubagentWaveLifecycle } from './wave-lifecycle.js'
import { decideOfficialSubagentModel } from '../agents/agent-effort-policy.js'
import { readBoundedTriwikiAttention } from './triwiki-attention.js'
import { readRoleModelPreferences } from './role-model-preferences.js'
import {
  inferProviderFromModel,
  readConfiguredCodexModelRoutingContext
} from '../codex-app/codex-model-catalog.js'
import { childInheritsActiveMainModel } from '../provider/model-router.js'
import {
  SUBAGENT_EVIDENCE_FILENAME,
  SUBAGENT_EVENT_LOG_FILENAME,
  SUBAGENT_PARENT_SUMMARY_FILENAME,
  normalizeSubagentParentSummary,
  writeSubagentEvidence
} from './subagent-evidence.js'
import { sksPrefixedDollarCommand, unprefixedSksSkillName } from '../routes/dollar-prefix.js'
import {
  withFileLock,
  tryWithFileLock,
  type FileLockLease
} from '../locks/file-lock.js'
import { updateCurrentIfMissionAndRun } from '../mission.js'
import {
  HOST_CAPABILITY_HOOK_EVIDENCE_FILENAME,
  HOST_CAPABILITY_HOOK_OBSERVATIONS_FILENAME,
  HOST_CAPABILITY_HOOK_PENDING_RUNTIME_FILENAME,
  HOST_CAPABILITY_HOOK_RUNTIME_FILENAME
} from '../agent-bridge/host-capability-runtime.js'
import { uniqueStrings } from '../text/strings.js'

export const NARUTO_RESULT_SCHEMA = 'sks.naruto-subagent-workflow.v1'
export const SUBAGENT_PLAN_FILENAME = 'subagent-plan.json'
export const NARUTO_SUMMARY_FILENAME = 'naruto-summary.json'
export const NARUTO_GATE_FILENAME = 'naruto-gate.json'
export const OFFICIAL_SUBAGENT_LIFECYCLE_LOCK = '.subagent-evidence.lock'
export const OFFICIAL_SUBAGENT_PREPARATION_TRANSACTION = '.official-subagent-preparation-transaction.json'
export const SUBAGENT_LIFECYCLE_CAPTURE_FAILURE_DIR = 'subagent-lifecycle-capture-failures'
const OFFICIAL_SUBAGENT_PREPARATION_STAGE_PREFIX = '.official-subagent-preparation-stage-'

export function withOfficialSubagentLifecycleLock<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  return withFileLock({
    lockPath: path.join(dir, OFFICIAL_SUBAGENT_LIFECYCLE_LOCK),
    timeoutMs: 5_000,
    staleMs: 60_000
  }, fn)
}

export interface OfficialSubagentPreparationInput {
  root: string
  dir: string
  missionId: string
  goal: string
  route: string
  sessionScope?: string | null
  requestedSubagents?: number
  requestedSubagentsExplicit?: boolean
  maxThreads?: number
  workflowRunId?: string
  mode?: 'generic' | 'naruto'
  readOnly?: boolean
  observedParentModel?: string | null
  env?: NodeJS.ProcessEnv
  hardware?: HardwareCapacityProbeInput
  preparationOnly?: boolean
  statePatch?: (prepared: {
    plan: Record<string, any>
    budget: ReturnType<typeof resolveSubagentThreadBudget>
    workflowRunId: string
  }) => Record<string, any>
  failureInjection?:
    | 'after_marker_before_artifact'
    | 'after_cleanup_and_evidence_promotion_before_plan'
    | 'after_artifact_commit_before_state'
    | 'after_state_commit_before_marker_clear'
  slices?: OfficialSubagentSlice[]
  capacity?: Omit<
    SubagentThreadBudgetInput,
    'requested' | 'configuredMaxThreads' | 'independentSliceCount'
  >
}

export async function prepareOfficialSubagentMission(input: OfficialSubagentPreparationInput) {
  return withOfficialSubagentLifecycleLock(input.dir, () => prepareOfficialSubagentMissionLocked(input))
}

async function prepareOfficialSubagentMissionLocked(input: OfficialSubagentPreparationInput) {
  const recovered = await recoverOfficialSubagentPreparationTransaction(input)
  if (recovered) return recovered
  const previousPlan = await readJson<Record<string, any> | null>(
    path.join(input.dir, SUBAGENT_PLAN_FILENAME),
    null
  ).catch(() => null)
  const expectedWorkflowRunId = String(previousPlan?.workflow_run_id || '').trim()
  const goal = String(input.goal || '').trim()
  const mode = input.mode === 'naruto' ? 'naruto' : 'generic'
  const taskProfile = classifyTaskProfile(goal)
  const slices = Array.isArray(input.slices) ? input.slices : []
  const sliceSafety = validateOfficialSubagentSlices(slices)
  const suggestedAgents = uniqueStrings([
    ...recommendOfficialSubagentRoles({
      description: goal,
      readOnly: input.readOnly === true,
      requiresWrite: input.readOnly !== true
    }),
    ...slices.map((slice) => slice.agent || '').filter(Boolean)
  ])
  const officialConfig = await readOfficialSubagentConfig(input.root)
  const triwikiAttention = await readBoundedTriwikiAttention(
    input.root,
    triwikiAttentionLimit(taskProfile),
    goal
  )
  const roleModelPreferences = await readRoleModelPreferences({ env: input.env || process.env })
  const roleModelRouting = await readConfiguredCodexModelRoutingContext({ env: input.env || process.env })
  const roleModelCatalog = roleModelRouting.catalog
  const activeMainModel = input.sessionScope && roleModelRouting.selected_provider && roleModelRouting.selected_model
    ? {
        provider: roleModelRouting.selected_provider,
        model: roleModelRouting.selected_model
      }
    : null
  const roleModelCatalogBlockers = Object.entries(roleModelPreferences.store.roles).flatMap(([name, preference]) => {
    const routed = preference.provider !== 'openai' || preference.model.includes('/')
    if (!routed) return []
    if (roleModelRouting.selected_provider !== 'sks-router') {
      return [`role_model_router_not_selected:${name}`]
    }
    const catalogEntry = roleModelCatalog.models.find((entry) => entry.model === preference.model)
    if (!roleModelCatalog.ok || !catalogEntry) {
      return [`role_model_preference_not_in_active_catalog:${name}:${preference.model}`]
    }
    if (!catalogEntry.reasoning_efforts.includes(preference.reasoning_effort)) {
      return [`role_model_preference_reasoning_not_in_active_catalog:${name}:${preference.model}:${preference.reasoning_effort}`]
    }
    if (catalogEntry.multi_agent_version !== 'v2') {
      return [`role_model_preference_multi_agent_v2_required:${name}:${preference.model}`]
    }
    return []
  })
  const operatorRequested = input.requestedSubagentsExplicit ?? input.requestedSubagents !== undefined
  const routeContract = mode === 'generic' && !operatorRequested
    ? routeOwnedSubagentContract(input.route)
    : null
  const requestedSubagents = input.requestedSubagents ?? routeContract?.count
  const requestedSource = operatorRequested
    ? 'operator'
    : routeContract
      ? 'route_contract'
      : 'automatic'
  const selectedFanoutPolicy = officialSubagentFanoutPolicy({
    ...(requestedSubagents === undefined ? {} : { requestedSubagents }),
    requestedExplicit: requestedSource !== 'automatic',
    requestedSource,
    taskProfile,
    suggestedRoles: suggestedAgents,
    goal,
    maxThreads: input.maxThreads ?? officialConfig.maxThreads,
    ...(input.hardware ? { hardware: input.hardware } : {}),
    ...(slices.length > 0 ? { independentSliceCount: slices.length } : {})
  })
  const decompositionStatus = slices.length > 0 && (
    requestedSource === 'automatic'
    || slices.length === selectedFanoutPolicy.requested_subagents
  )
    ? 'ready'
    : 'parent_required'
  const configuredMaxThreads = input.maxThreads ?? officialConfig.maxThreads
  // Configured frame limits express SKS/operator intent; they do not prove what
  // the already-running Codex host actually exposes. Only runtime-observed
  // capacity supplied by the host is authoritative as an external limiter.
  const externalCodexHostCap = input.capacity?.externalCodexHostCap
  const externalCodexHostCapVerification = externalCodexHostCap === undefined
    ? 'unverified_external_host_cap'
    : 'verified'
  const waveGovernor = decideNarutoConcurrency({
    requestedWorkers: Math.min(selectedFanoutPolicy.requested_subagents, configuredMaxThreads),
    totalWorkItems: selectedFanoutPolicy.requested_subagents,
    backend: 'official-subagent',
    parallelismMode: 'extreme',
    maxThreads: configuredMaxThreads,
    ...(externalCodexHostCap === undefined ? {} : { externalCodexHostCap }),
    ...(input.hardware ? { hardware: input.hardware } : {})
  })
  const budget = resolveSubagentThreadBudget({
    requested: selectedFanoutPolicy.requested_subagents,
    configuredMaxThreads,
    ...(input.capacity || {}),
    ...(externalCodexHostCap === undefined ? {} : { externalCodexHostCap }),
    ...(input.capacity?.marginalUsefulWorkers === undefined
      ? { marginalUsefulWorkers: waveGovernor.safe_active_workers }
      : {}),
    // Demand-driven: reserve reviewer frame slots only for reviewer-only /
    // critical multi-domain fanout — not because a role catalog mentions expert.
    reviewerReservedThreads: selectedFanoutPolicy.selection_reason.includes('reviewer')
      || selectedFanoutPolicy.critical_multi_domain
      ? Math.max(1, Number(selectedFanoutPolicy.automatic_reviewer_ceiling || 1))
      : 0,
    ...(slices.length > 0
      ? {
          independentSliceCount: slices.length,
          readyDagWidth: input.capacity?.readyDagWidth ?? slices.length,
          disjointOwnershipCount: input.capacity?.disjointOwnershipCount ?? (sliceSafety.safe ? slices.length : 0)
        }
      : {})
  })
  const verification = chooseVerificationBudget({ taskProfile, changedFiles: [] })
  const workflowRunId = String(input.workflowRunId || '').trim()
    || `${mode === 'naruto' ? 'naruto' : 'official'}-${Date.now().toString(36)}-${randomId(8)}`
  const fanoutPolicy = {
    ...selectedFanoutPolicy,
    requested_subagents: budget.requestedSubagents,
    capacity_controller: budget.capacity,
    mass_parallel: selectedFanoutPolicy.mass_parallel === true,
    mass_automatic_ceiling: selectedFanoutPolicy.mass_parallel === true
      ? selectedFanoutPolicy.automatic_ceiling
      : null
  }
  const observedParentModel = String(input.observedParentModel || '').trim() || null
  const parentModelMatch = observedParentModel ? observedParentModelMatchesPolicy(observedParentModel) : null
  const delegationGoal = input.readOnly
    ? `${goal}\n\nConstraint: run every delegated slice in read-only mode. Do not edit files.`
    : goal
  const delegationPrompt = buildOfficialSubagentPrompt({
    goal: delegationGoal,
    slices,
    requestedSubagents: budget.requestedSubagents,
    requestedSubagentsExplicit: requestedSource === 'operator',
    requestedSubagentsSource: requestedSource,
    maxThreads: budget.maxThreads,
    decompositionStatus,
    firstWave: budget.firstWave,
    waveCount: budget.waveCount,
    capacity: budget.capacity,
    triwikiAttention,
    recommendedAgents: suggestedAgents,
    roleModelPreferences: roleModelPreferences.store.roles,
    activeMainModel,
    parentOutputMode: mode === 'naruto' && input.sessionScope ? 'app_naruto_stdin' : 'raw_json',
    missionId: input.missionId,
    workflowRunId
  })
  const selectedAgentPlan = officialSubagentOnDemandRolePlan(suggestedAgents)
  const agentRouting = Object.fromEntries(Object.entries(selectedAgentPlan).map(([name, config]) => {
    const decision = decideOfficialSubagentModel({
      persona: {
        role: name as any,
        naruto_role: name,
        write_policy: config.sandbox_mode === 'read-only' ? 'read-only' : 'route-local-artifact',
        read_only: config.sandbox_mode === 'read-only'
      },
      prompt: goal,
      agentId: name,
      readonly: config.sandbox_mode === 'read-only'
    })
    const preference = roleModelPreferences.store.roles[name]
    const inheritActiveMain = childInheritsActiveMainModel(activeMainModel?.model)
    const routedProvider = preference?.provider
      || (inheritActiveMain ? activeMainModel?.provider : null)
      || inferProviderFromModel(config.model || decision.model)
    const routedModel = preference?.model
      || (inheritActiveMain ? activeMainModel?.model : null)
      || config.model
      || decision.model
    const routedReasoning = preference?.reasoning_effort
      || config.model_reasoning_effort
      || decision.model_reasoning_effort
    return [name, {
      ...config,
      // Catalog TOML remains the spawn-type contract; dynamic decision records why
      // this role maps onto the sealed four-profile matrix for this goal.
      routed_provider: routedProvider,
      routed_model: routedModel,
      routed_model_reasoning_effort: routedReasoning,
      routed_model_policy: preference
        ? 'user_role_model_preference'
        : inheritActiveMain
          ? 'active_main_model'
          : (config.model_policy || decision.model_selection_reason),
      routing_dynamic: !preference && !inheritActiveMain,
      role_model_preference_source: preference
        ? 'user-scoped-owner-only'
        : inheritActiveMain
          ? 'active-main-model'
          : 'managed-default'
    }]
  }))
  const agentCatalog = onDemandAgentCatalogMetadata(selectedAgentPlan)
  const ssotGuard = buildSsotGuard({ route: input.route, mode: mode === 'naruto' ? 'NARUTO' : 'OFFICIAL_SUBAGENT', task: goal })
  const ssotGuardValidation = validateSsotGuardArtifact(ssotGuard)
  const configBlockers = [
    ...officialConfig.blockers,
    ...roleModelPreferences.blockers,
    ...roleModelCatalogBlockers,
    ...ssotGuardValidation.issues.map((issue) => `ssot_guard:${issue}`),
    ...sliceSafety.blockers.map((blocker) => `subagent_slice:${blocker}`),
    ...(requestedSource !== 'automatic'
      && slices.length > 0
      && slices.length < budget.requestedSubagents
      ? [`exact_subagent_decomposition_incomplete:requested=${budget.requestedSubagents}:ready_slices=${slices.length}`]
      : []),
    ...(budget.capacity.exhausted ? ['subagent_capacity_exhausted'] : [])
  ]
  const plan = {
    schema: 'sks.subagent-plan.v1',
    mission_id: input.missionId,
    route: input.route,
    workflow: 'official_codex_subagent',
    workflow_run_id: workflowRunId,
    session_scope: input.sessionScope || null,
    goal,
    read_only: input.readOnly === true,
    task_profile: taskProfile,
    decomposition_status: decompositionStatus,
    delegation_prompt: delegationPrompt,
    requested_subagents: budget.requestedSubagents,
    requested_subagents_explicit: requestedSource === 'operator',
    requested_subagents_source: requestedSource,
    route_owned_count_contract: routeContract,
    max_threads: budget.maxThreads,
    first_wave: budget.firstWave,
    wave_count: budget.waveCount,
    max_depth: budget.maxDepth,
    wave_lifecycle: createSubagentWaveLifecycle({
      workflowRunId,
      targetSubagents: budget.requestedSubagents,
      countPolicy: requestedSource === 'automatic' ? 'dynamic_automatic' : 'exact',
      waveCapacity: budget.firstWave
    }),
    config_source: input.maxThreads === undefined ? officialConfig.sources.maxThreads : 'cli',
    config_sources: officialConfig.sources,
    config_blockers: configBlockers,
    triwiki_attention: triwikiAttention,
    suggested_agents: suggestedAgents,
    fanout_policy: fanoutPolicy,
    capacity_controller: budget.capacity,
    external_codex_host_cap_verification: externalCodexHostCapVerification,
    concurrency_governor: {
      ...waveGovernor,
      external_codex_host_cap_verification: externalCodexHostCapVerification,
      reasons: uniqueStrings([
        ...waveGovernor.reasons,
        ...(externalCodexHostCap === undefined ? ['unverified_external_host_cap'] : [])
      ])
    },
    slice_safety: sliceSafety,
    slices,
    parent_model_policy: NARUTO_PARENT_MODEL,
    observed_parent_model: observedParentModel,
    parent_model_match: parentModelMatch,
    parent: {
      model: NARUTO_PARENT_MODEL,
      model_reasoning_effort: NARUTO_PARENT_EFFORT
    },
    agent_catalog: agentCatalog,
    agents: agentRouting,
    role_model_preferences: {
      schema: roleModelPreferences.store.schema,
      path: roleModelPreferences.path,
      overrides: roleModelPreferences.store.roles,
      routing: {
        selected_provider: roleModelRouting.selected_provider,
        selected_model: roleModelRouting.selected_model,
        active_main_model_inherited: childInheritsActiveMainModel(activeMainModel?.model),
        runtime_verified: false
      },
      catalog: {
        configured: roleModelCatalog.configured,
        ok: roleModelCatalog.ok,
        path: roleModelCatalog.path,
        model_count: roleModelCatalog.model_count,
        blockers: roleModelCatalog.blockers
      },
      blockers: [...roleModelPreferences.blockers, ...roleModelCatalogBlockers]
    },
    verification_budget: verification,
    verification_checks: [],
    verification: { budget: verification },
    created_at: nowIso()
  }
  const statePatch = input.statePatch?.({ plan, budget, workflowRunId }) || null
  const preparedResultBase = {
    plan,
    budget,
    verification,
    taskProfile,
    delegationPrompt,
    workflowRunId,
    officialConfig,
    triwikiAttention,
    suggestedAgents,
    fanoutPolicy,
    configBlockers,
    observedParentModel,
    parentModelMatch
  }
  const transactionFile = path.join(input.dir, OFFICIAL_SUBAGENT_PREPARATION_TRANSACTION)
  const stageName = `${OFFICIAL_SUBAGENT_PREPARATION_STAGE_PREFIX}${safePreparationStageId(workflowRunId)}`
  const stageDir = path.join(input.dir, stageName)
  const artifactInventory = officialSubagentPreparationArtifactInventory(mode)
  const tombstoneInventory = officialSubagentPreparationTombstoneInventory(mode)
  let transaction = {
    schema: 'sks.official-subagent-preparation-transaction.v2',
    status: 'staging',
    mission_id: input.missionId,
    session_scope: input.sessionScope || null,
    route: input.route,
    mode,
    goal,
    previous_workflow_run_id: expectedWorkflowRunId || null,
    target_workflow_run_id: workflowRunId,
    stage_dir: stageName,
    artifact_inventory: artifactInventory,
    tombstone_inventory: tombstoneInventory,
    state_patch: statePatch,
    prepared_result: preparedResultBase,
    created_at: nowIso()
  }
  await writeJsonAtomic(transactionFile, transaction)
  if (input.failureInjection === 'after_marker_before_artifact') {
    throw new Error('official_subagent_preparation_injected_failure:after_marker_before_artifact')
  }
  await fsp.rm(stageDir, { recursive: true, force: true })
  await fsp.mkdir(stageDir, { recursive: true })
  const evidence = await writeOfficialSubagentPreparationStage(stageDir, {
    mode,
    plan,
    ssotGuard,
    budget,
    workflowRunId,
    preparationOnly: input.preparationOnly !== false,
    configBlockers,
    parentModelMatch,
    observedParentModel,
    verification,
    missionId: input.missionId,
    sessionScope: input.sessionScope || null,
    suggestedAgents
  })
  await validateOfficialSubagentPreparationBundle(stageDir, transaction)
  transaction = { ...transaction, status: 'staged' }
  await writeJsonAtomic(transactionFile, transaction)

  const promote = async () => {
    transaction = { ...transaction, status: 'promoting' }
    await writeJsonAtomic(transactionFile, transaction)
    await promoteOfficialSubagentPreparationBundle(input.dir, stageDir, transaction, input.failureInjection)
  }

  if (statePatch) {
    const committed = await updateCurrentIfMissionAndRun(
      input.root,
      input.missionId,
      expectedWorkflowRunId,
      async () => {
        await promote()
        if (input.failureInjection === 'after_artifact_commit_before_state') {
          throw new Error('official_subagent_preparation_injected_failure:after_artifact_commit_before_state')
        }
        return statePatch
      },
      { sessionKey: input.sessionScope || null }
    )
    if (committed.updated !== true) {
      throw new Error(`official_subagent_preparation_state_generation_mismatch:${committed.status}`)
    }
    if (input.failureInjection === 'after_state_commit_before_marker_clear') {
      throw new Error('official_subagent_preparation_injected_failure:after_state_commit_before_marker_clear')
    }
  } else {
    await promote()
  }
  await cleanupOfficialSubagentPreparationTransaction(transactionFile, stageDir)

  return {
    ...preparedResultBase,
    evidence,
  }
}

async function recoverOfficialSubagentPreparationTransaction(input: OfficialSubagentPreparationInput) {
  const file = path.join(input.dir, OFFICIAL_SUBAGENT_PREPARATION_TRANSACTION)
  const marker = await readJson<Record<string, any> | null>(file, null).catch(() => null)
  if (!marker) return null
  if (marker.schema !== 'sks.official-subagent-preparation-transaction.v2'
    || String(marker.mission_id || '') !== String(input.missionId || '')
    || String(marker.session_scope || '') !== String(input.sessionScope || '')) {
    throw new Error('official_subagent_preparation_transaction_identity_mismatch')
  }
  const previousRunId = String(marker.previous_workflow_run_id || '').trim()
  const targetRunId = String(marker.target_workflow_run_id || '').trim()
  const stageName = String(marker.stage_dir || '')
  if (!stageName.startsWith(OFFICIAL_SUBAGENT_PREPARATION_STAGE_PREFIX)
    || path.basename(stageName) !== stageName) {
    throw new Error('official_subagent_preparation_transaction_stage_identity_invalid')
  }
  const stageDir = path.join(input.dir, stageName)
  const plan = await readJson<Record<string, any> | null>(
    path.join(input.dir, SUBAGENT_PLAN_FILENAME),
    null
  ).catch(() => null)
  const planRunId = String(plan?.workflow_run_id || '').trim()
  const stageValidation = await validateOfficialSubagentPreparationBundle(stageDir, marker, { throwOnError: false })
  if (planRunId === previousRunId) {
    if (!stageValidation.ok) {
      if (marker.status === 'staging') {
        await cleanupOfficialSubagentPreparationTransaction(file, stageDir)
        return null
      }
      throw new Error(`official_subagent_preparation_transaction_stage_incomplete:${stageValidation.issues.join(',')}`)
    }
    if (marker.state_patch) {
      const committed = await updateCurrentIfMissionAndRun(
        input.root,
        input.missionId,
        previousRunId,
        async () => {
          await promoteOfficialSubagentPreparationBundle(input.dir, stageDir, marker)
          return marker.state_patch
        },
        { sessionKey: input.sessionScope || null }
      )
      if (committed.updated !== true) {
        throw new Error(`official_subagent_preparation_transaction_state_generation_mismatch:${committed.status}`)
      }
    } else {
      await promoteOfficialSubagentPreparationBundle(input.dir, stageDir, marker)
    }
  } else if (planRunId === targetRunId) {
    await validateOfficialSubagentPreparationBundle(input.dir, marker, { exactInventory: false })
    if (marker.state_patch) {
      let committed = await updateCurrentIfMissionAndRun(
        input.root,
        input.missionId,
        previousRunId,
        marker.state_patch,
        { sessionKey: input.sessionScope || null }
      )
      if (committed.updated !== true) {
        committed = await updateCurrentIfMissionAndRun(
          input.root,
          input.missionId,
          targetRunId,
          () => null,
          { sessionKey: input.sessionScope || null }
        )
        if (committed.status !== 'unchanged') {
          throw new Error(`official_subagent_preparation_transaction_state_generation_mismatch:${committed.status}`)
        }
      }
    }
  } else {
    throw new Error('official_subagent_preparation_transaction_plan_generation_mismatch')
  }
  const evidence = await readJson<Record<string, any> | null>(
    path.join(input.dir, SUBAGENT_EVIDENCE_FILENAME),
    null
  ).catch(() => null)
  const committedPlan = await readJson<Record<string, any> | null>(
    path.join(input.dir, SUBAGENT_PLAN_FILENAME),
    null
  ).catch(() => null)
  await cleanupOfficialSubagentPreparationTransaction(file, stageDir)
  const preparedResult = marker.prepared_result && typeof marker.prepared_result === 'object'
    ? marker.prepared_result
    : null
  const sameRequest = String(marker.goal || '') === String(input.goal || '').trim()
    && String(marker.route || '') === String(input.route || '')
  return sameRequest && preparedResult
    ? { ...preparedResult, plan: committedPlan, evidence }
    : null
}

export async function officialSubagentPreparationInProgress(dir: string) {
  return fsp.access(path.join(dir, OFFICIAL_SUBAGENT_PREPARATION_TRANSACTION))
    .then(() => true)
    .catch(() => false)
}

function safePreparationStageId(value: string) {
  return value.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 120) || 'unknown'
}

function officialSubagentPreparationArtifactInventory(mode: 'generic' | 'naruto') {
  return [
    SUBAGENT_EVENT_LOG_FILENAME,
    SSOT_GUARD_ARTIFACT,
    SUBAGENT_EVIDENCE_FILENAME,
    ...(mode === 'naruto' ? [NARUTO_SUMMARY_FILENAME, NARUTO_GATE_FILENAME] : []),
    SUBAGENT_PLAN_FILENAME
  ]
}

function officialSubagentPreparationTombstoneInventory(mode: 'generic' | 'naruto') {
  return [
    SUBAGENT_PARENT_SUMMARY_FILENAME,
    SUBAGENT_LIFECYCLE_CAPTURE_FAILURE_DIR,
    ...(mode === 'naruto'
      ? [
          'completion-proof.json',
          'completion-proof.md',
          'evidence-index.json',
          'route-completion-contract.json',
          'trust-report.json',
          HOST_CAPABILITY_HOOK_PENDING_RUNTIME_FILENAME,
          HOST_CAPABILITY_HOOK_RUNTIME_FILENAME,
          HOST_CAPABILITY_HOOK_OBSERVATIONS_FILENAME,
          HOST_CAPABILITY_HOOK_EVIDENCE_FILENAME
        ]
      : [])
  ]
}

async function writeOfficialSubagentPreparationStage(stageDir: string, input: any) {
  await writeTextAtomic(path.join(stageDir, SUBAGENT_EVENT_LOG_FILENAME), '')
  await writeJsonAtomic(path.join(stageDir, SSOT_GUARD_ARTIFACT), input.ssotGuard)
  const evidence = await writeSubagentEvidence(stageDir, {
    requestedSubagents: input.budget.requestedSubagents,
    countPolicy: input.plan.wave_lifecycle.count_policy,
    targetSubagents: input.plan.wave_lifecycle.target_subagents,
    events: [],
    parentSummaryPresent: false,
    workflowStatus: 'delegation_context_ready',
    preparationOnly: input.preparationOnly,
    runId: input.workflowRunId,
    additionalBlockers: input.configBlockers
  })
  if (input.mode === 'naruto') {
    const blockers = uniqueStrings([
      ...evidence.blockers,
      ...input.configBlockers
      // parent_model_match stays on the summary/gate as advisory LOD evidence;
      // do not hard-block preparation or finalization on App parent model strings.
    ])
    await writeJsonAtomic(path.join(stageDir, NARUTO_SUMMARY_FILENAME), buildNarutoSummary({
      missionId: input.missionId,
      workflowRunId: input.workflowRunId,
      budget: input.budget,
      evidence,
      verification: input.verification,
      status: 'delegation_context_ready',
      ok: false,
      blockers,
      sessionKey: input.sessionScope,
      suggestedAgents: input.suggestedAgents,
      observedParentModel: input.observedParentModel,
      parentModelMatch: input.parentModelMatch,
      waveLifecycle: input.plan.wave_lifecycle
    }))
    await writeNarutoGate(stageDir, {
      missionId: input.missionId,
      workflowRunId: input.workflowRunId,
      evidence,
      passed: false,
      blockers,
      configBlockers: input.configBlockers,
      observedParentModel: input.observedParentModel,
      parentModelMatch: input.parentModelMatch
    })
  }
  await writeJsonAtomic(path.join(stageDir, SUBAGENT_PLAN_FILENAME), input.plan)
  return evidence
}

async function validateOfficialSubagentPreparationBundle(
  dir: string,
  marker: Record<string, any>,
  opts: { throwOnError?: boolean; exactInventory?: boolean } = {}
) {
  const issues: string[] = []
  const mode = marker.mode === 'naruto' ? 'naruto' : 'generic'
  const expectedInventory = officialSubagentPreparationArtifactInventory(mode)
  const expectedTombstones = officialSubagentPreparationTombstoneInventory(mode)
  if (JSON.stringify(marker.artifact_inventory) !== JSON.stringify(expectedInventory)) issues.push('artifact_inventory')
  if (JSON.stringify(marker.tombstone_inventory) !== JSON.stringify(expectedTombstones)) issues.push('tombstone_inventory')
  if (opts.exactInventory !== false) {
    const actual = await fsp.readdir(dir).catch(() => [])
    if (JSON.stringify([...actual].sort()) !== JSON.stringify([...expectedInventory].sort())) issues.push('stage_inventory')
  }
  const [plan, evidence, ssot, events] = await Promise.all([
    readJson<Record<string, any> | null>(path.join(dir, SUBAGENT_PLAN_FILENAME), null).catch(() => null),
    readJson<Record<string, any> | null>(path.join(dir, SUBAGENT_EVIDENCE_FILENAME), null).catch(() => null),
    readJson<Record<string, any> | null>(path.join(dir, SSOT_GUARD_ARTIFACT), null).catch(() => null),
    fsp.readFile(path.join(dir, SUBAGENT_EVENT_LOG_FILENAME), 'utf8').catch(() => null)
  ])
  const targetRunId = String(marker.target_workflow_run_id || '')
  const missionId = String(marker.mission_id || '')
  if (plan?.schema !== 'sks.subagent-plan.v1'
    || plan?.workflow !== 'official_codex_subagent'
    || String(plan?.mission_id || '') !== missionId
    || String(plan?.workflow_run_id || '') !== targetRunId) issues.push('plan_identity')
  if (evidence?.schema !== 'sks.subagent-evidence.v1'
    || evidence?.workflow !== 'official_codex_subagent'
    || String(evidence?.run_id || '') !== targetRunId) issues.push('evidence_identity')
  if (!validateSsotGuardArtifact(ssot).ok) issues.push('ssot_guard')
  if (events !== '') issues.push('events_not_empty')
  if (mode === 'naruto') {
    const [summary, gate] = await Promise.all([
      readJson<Record<string, any> | null>(path.join(dir, NARUTO_SUMMARY_FILENAME), null).catch(() => null),
      readJson<Record<string, any> | null>(path.join(dir, NARUTO_GATE_FILENAME), null).catch(() => null)
    ])
    if (summary?.schema !== NARUTO_RESULT_SCHEMA
      || String(summary?.mission_id || '') !== missionId
      || String(summary?.workflow_run_id || '') !== targetRunId) issues.push('summary_identity')
    if (gate?.schema !== 'sks.naruto-gate.v1'
      || String(gate?.mission_id || '') !== missionId
      || String(gate?.workflow_run_id || '') !== targetRunId) issues.push('gate_identity')
  }
  const result = { ok: issues.length === 0, issues }
  if (!result.ok && opts.throwOnError !== false) {
    throw new Error(`official_subagent_preparation_bundle_invalid:${issues.join(',')}`)
  }
  return result
}

async function promoteOfficialSubagentPreparationBundle(
  dir: string,
  stageDir: string,
  marker: Record<string, any>,
  failureInjection?: OfficialSubagentPreparationInput['failureInjection']
) {
  await validateOfficialSubagentPreparationBundle(stageDir, marker)
  const inventory = officialSubagentPreparationArtifactInventory(marker.mode === 'naruto' ? 'naruto' : 'generic')
  const tombstones = officialSubagentPreparationTombstoneInventory(marker.mode === 'naruto' ? 'naruto' : 'generic')
  await Promise.all(tombstones.map((name) => (
    fsp.rm(path.join(dir, name), { recursive: true, force: true })
  )))
  for (const name of inventory.filter((item) => item !== SUBAGENT_PLAN_FILENAME)) {
    await writeTextAtomic(path.join(dir, name), await fsp.readFile(path.join(stageDir, name), 'utf8'))
  }
  if (failureInjection === 'after_cleanup_and_evidence_promotion_before_plan') {
    throw new Error('official_subagent_preparation_injected_failure:after_cleanup_and_evidence_promotion_before_plan')
  }
  await writeTextAtomic(
    path.join(dir, SUBAGENT_PLAN_FILENAME),
    await fsp.readFile(path.join(stageDir, SUBAGENT_PLAN_FILENAME), 'utf8')
  )
  await validateOfficialSubagentPreparationBundle(dir, marker, { exactInventory: false })
}

async function cleanupOfficialSubagentPreparationTransaction(markerFile: string, stageDir: string) {
  await fsp.rm(markerFile, { force: true })
  await fsp.rm(stageDir, { recursive: true, force: true })
}

function triwikiAttentionLimit(taskProfile: string): number {
  return ['parallel-read', 'parallel-write', 'high-risk'].includes(taskProfile) ? 6 : 4
}

function routeOwnedSubagentContract(route: string): { count: number; reason: string } | null {
  const normalized = unprefixedSksSkillName(route)
  if (normalized === 'research') {
    return { count: 3, reason: 'research_exact_three_independent_reviewers' }
  }
  if (normalized === 'autoresearch') {
    return { count: 3, reason: 'autoresearch_exact_three_independent_reviewers' }
  }
  return null
}

export function buildNarutoSummary(input: any) {
  const parentSummary = normalizeSubagentParentSummary(input.parentSummary)
  const suggestedAgents = Array.isArray(input.suggestedAgents)
    ? uniqueStrings(input.suggestedAgents)
    : []
  const selectedAgentPlan = officialSubagentOnDemandRolePlan(suggestedAgents)
  return {
    schema: NARUTO_RESULT_SCHEMA,
    ok: input.ok === true,
    completion_evidence: input.ok === true,
    status: input.status,
    route: sksPrefixedDollarCommand('naruto'),
    workflow: 'official_codex_subagent',
    workflow_run_id: input.workflowRunId || input.evidence?.run_id || null,
    mission_id: input.missionId,
    parent: {
      model: NARUTO_PARENT_MODEL,
      model_reasoning_effort: NARUTO_PARENT_EFFORT,
      observed_model: input.observedParentModel || null,
      observed_model_match: input.parentModelMatch ?? null
    },
    requested_subagents: input.evidence?.requested_subagents ?? input.budget.requestedSubagents,
    count_policy: input.evidence?.count_policy || input.waveLifecycle?.count_policy || 'exact',
    target_subagents: input.evidence?.target_subagents ?? input.waveLifecycle?.target_subagents ?? input.budget.requestedSubagents,
    max_threads: input.budget.maxThreads,
    first_wave: input.budget.firstWave,
    wave_count: input.budget.waveCount,
    capacity_controller: input.budget.capacity,
    max_depth: input.budget.maxDepth,
    wave_lifecycle: input.waveLifecycle || null,
    started_subagents: Number(input.evidence?.started_threads || 0),
    completed_subagents: Number(input.evidence?.completed_threads || 0),
    failed_subagents: Number(input.evidence?.failed_threads || 0),
    agent_catalog: onDemandAgentCatalogMetadata(selectedAgentPlan),
    agents: selectedAgentPlan,
    verification: {
      budget: input.verification,
      checks: []
    },
    parent_summary_present: Boolean(input.parentSummary),
    parent_summary: parentSummary.summary,
    parent_thread_outcomes: parentSummary.raw?.thread_outcomes || [],
    app_session: input.appSession === true,
    session_scope: input.sessionKey || null,
    blockers: uniqueStrings(input.blockers || input.evidence?.blockers || []),
    updated_at: nowIso()
  }
}

function onDemandAgentCatalogMetadata(
  selectedAgentPlan: Record<string, unknown>
) {
  const selectedAgents = Object.keys(selectedAgentPlan)
  return {
    mode: 'on_demand',
    total_available: officialSubagentRoleCatalog().length,
    selected_count: selectedAgents.length,
    selected_agents: selectedAgents,
    max_injected: MAX_ON_DEMAND_SUBAGENT_ROLE_COUNT,
    full_catalog_injected: false
  }
}

export async function writeNarutoGate(dir: string, input: any) {
  const ssotGuard = await readJson(path.join(dir, SSOT_GUARD_ARTIFACT), null)
  const ssotValidation = validateSsotGuardArtifact(ssotGuard)
  const blockers = uniqueStrings([
    ...(input.blockers || []),
    ...ssotValidation.issues.map((issue) => `${SSOT_GUARD_ARTIFACT}:${issue}`)
  ])
  const gate = buildNarutoGateResult({
    ...input,
    passed: input.passed === true && ssotValidation.ok && blockers.length === 0,
    ssotGuard: ssotValidation.ok,
    blockers
  })
  await writeJsonAtomic(path.join(dir, NARUTO_GATE_FILENAME), gate)
  return gate
}

export function buildNarutoGateResult(input: any) {
  const passed = input.passed === true
  const requested = Number(input.evidence?.requested_subagents || 0)
  const target = Number(input.evidence?.target_subagents || requested || 0)
  const completed = Number(input.evidence?.completed_threads || 0)
  const failed = Number(input.evidence?.failed_threads || 0)
  const started = Number(input.evidence?.started_threads || 0)
  const open = Array.isArray(input.evidence?.open_thread_ids) ? input.evidence.open_thread_ids.length : 0
  const unmatched = Array.isArray(input.evidence?.unmatched_stop_thread_ids) ? input.evidence.unmatched_stop_thread_ids.length : 0
  const ambiguous = Array.isArray(input.evidence?.ambiguous_stop_thread_ids) ? input.evidence.ambiguous_stop_thread_ids.length : 0
  return {
    schema: 'sks.naruto-gate.v1',
    route: sksPrefixedDollarCommand('naruto'),
    workflow: 'official_codex_subagent',
    workflow_run_id: input.workflowRunId || input.evidence?.run_id || null,
    mission_id: input.missionId,
    parent_model_policy: NARUTO_PARENT_MODEL,
    observed_parent_model: input.observedParentModel || null,
    parent_model_match: input.parentModelMatch ?? null,
    status: passed ? 'passed' : 'blocked',
    passed,
    terminal: passed,
    terminal_state: passed ? 'completed' : 'blocked',
    subagent_plan_ready: true,
    official_subagent_evidence: input.evidence?.ok === true,
    session_cleanup: target > 0
      && started === target
      && completed === target
      && failed === 0
      && open === 0
      && unmatched === 0
      && ambiguous === 0,
    subagent_evidence_ready: input.evidence?.ok === true,
    requested_subagents: requested || null,
    count_policy: input.evidence?.count_policy || 'exact',
    target_subagents: target || null,
    started_subagents: started,
    completed_subagents: Number(input.evidence?.completed_threads || 0),
    failed_subagents: Number(input.evidence?.failed_threads || 0),
    parent_summary_present: input.evidence?.parent_summary_present === true,
    ssot_guard: input.ssotGuard === true,
    event_sources: input.evidence?.event_sources || [],
    evidence: {
      official_subagent_evidence: SUBAGENT_EVIDENCE_FILENAME,
      parent_summary: SUBAGENT_PARENT_SUMMARY_FILENAME,
      ssot_guard: SSOT_GUARD_ARTIFACT,
      requested_subagents: requested,
      count_policy: input.evidence?.count_policy || 'exact',
      target_subagents: target,
      started_threads: started,
      completed_threads: completed,
      failed_threads: failed
    },
    native_process_proof_required: false,
    config_blockers: uniqueStrings(input.configBlockers || []),
    blockers: uniqueStrings(input.blockers || input.evidence?.blockers || []),
    missing_fields: uniqueStrings(input.blockers || input.evidence?.blockers || []),
    updated_at: nowIso()
  }
}

function observedParentModelMatchesPolicy(model: string) {
  return model.toLowerCase() === NARUTO_PARENT_MODEL || /gpt[-_. ]?5\.6[-_. ]?sol|\bsol(?:\s+max)?\b/i.test(model)
}

export const NARUTO_MISSION_RUN_LOCK = '.naruto-run.lock'
export const NARUTO_MISSION_RUN_STALE_MS = 120_000

export interface NarutoMissionRunAdmissionInput {
  missionId: string
  missionDir: string
  prompt?: string
  staleMs?: number
}

export interface NarutoMissionRunLease {
  recovered: boolean
  protectChildPid(pid: number): Promise<void>
}

export type NarutoMissionRunAdmission<T> =
  | { kind: 'executed'; recovered: boolean; value: T }
  | { kind: 'reused'; response: Record<string, unknown> }
  | { kind: 'running'; response: Record<string, unknown> }
  | { kind: 'blocked'; response: Record<string, unknown> }

interface NarutoJsonArtifact {
  exists: boolean
  malformed: boolean
  value: Record<string, unknown> | null
}

interface NarutoAdmissionSnapshot {
  mission: NarutoJsonArtifact
  plan: NarutoJsonArtifact
  evidence: NarutoJsonArtifact
  parentSummary: NarutoJsonArtifact
  summary: NarutoJsonArtifact
  gate: NarutoJsonArtifact
  eventsExists: boolean
  eventRunIds: string[]
}

export async function withNarutoMissionRunAdmission<T>(
  input: NarutoMissionRunAdmissionInput,
  execute: (lease: NarutoMissionRunLease) => Promise<T>
): Promise<NarutoMissionRunAdmission<T>> {
  const normalized = normalizeNarutoAdmissionInput(input)
  const initial = await readNarutoAdmissionSnapshot(normalized.missionDir)
  const reusable = reusableNarutoTerminalResponse(normalized.missionId, initial)
  if (reusable) return { kind: 'reused', response: reusable }

  const lock = await tryWithFileLock({
    lockPath: path.join(normalized.missionDir, NARUTO_MISSION_RUN_LOCK),
    staleMs: normalized.staleMs
  }, async (fileLease) => {
    const ownedSnapshot = await readNarutoAdmissionSnapshot(normalized.missionDir)
    const ownedReusable = reusableNarutoTerminalResponse(normalized.missionId, ownedSnapshot)
    if (ownedReusable) {
      return { kind: 'reused', response: ownedReusable } satisfies NarutoMissionRunAdmission<T>
    }

    const blockers = uniqueStrings([
      ...narutoArtifactIdentityBlockers(normalized.missionId, ownedSnapshot),
      ...narutoRequestIdentityBlockers(normalized.prompt, ownedSnapshot)
    ])
    if (blockers.length > 0) {
      return {
        kind: 'blocked',
        response: blockedNarutoIdentityResponse(normalized.missionId, ownedSnapshot, blockers)
      } satisfies NarutoMissionRunAdmission<T>
    }

    const value = await execute(narutoAdmissionLease(fileLease))
    return {
      kind: 'executed',
      recovered: fileLease.recovered,
      value
    } satisfies NarutoMissionRunAdmission<T>
  })

  if (lock.acquired) return lock.value

  const afterBusy = await readNarutoAdmissionSnapshot(normalized.missionDir)
  const completedWhileWaiting = reusableNarutoTerminalResponse(normalized.missionId, afterBusy)
  if (completedWhileWaiting) return { kind: 'reused', response: completedWhileWaiting }
  return {
    kind: 'running',
    response: runningNarutoResponse(normalized.missionId, afterBusy)
  }
}

function narutoAdmissionLease(fileLease: FileLockLease): NarutoMissionRunLease {
  return {
    recovered: fileLease.recovered,
    protectChildPid: (pid: number) => fileLease.protectPid(pid)
  }
}

function normalizeNarutoAdmissionInput(
  input: NarutoMissionRunAdmissionInput
): Required<NarutoMissionRunAdmissionInput> {
  const missionId = String(input.missionId || '').trim()
  if (!missionId) throw new Error('naruto_mission_run_admission_mission_id_missing')
  return {
    missionId,
    missionDir: path.resolve(input.missionDir),
    prompt: String(input.prompt || '').trim(),
    staleMs: Math.max(1, input.staleMs ?? NARUTO_MISSION_RUN_STALE_MS)
  }
}

async function readNarutoAdmissionSnapshot(missionDir: string): Promise<NarutoAdmissionSnapshot> {
  const [mission, plan, evidence, parentSummary, summary, gate, events] = await Promise.all([
    readNarutoJsonArtifact(path.join(missionDir, 'mission.json')),
    readNarutoJsonArtifact(path.join(missionDir, SUBAGENT_PLAN_FILENAME)),
    readNarutoJsonArtifact(path.join(missionDir, SUBAGENT_EVIDENCE_FILENAME)),
    readNarutoJsonArtifact(path.join(missionDir, SUBAGENT_PARENT_SUMMARY_FILENAME)),
    readNarutoJsonArtifact(path.join(missionDir, NARUTO_SUMMARY_FILENAME)),
    readNarutoJsonArtifact(path.join(missionDir, NARUTO_GATE_FILENAME)),
    fsp.readFile(path.join(missionDir, SUBAGENT_EVENT_LOG_FILENAME), 'utf8')
      .then((text) => ({ exists: true, runIds: narutoEventRunIds(text) }))
      .catch(() => ({ exists: false, runIds: [] as string[] }))
  ])
  return {
    mission,
    plan,
    evidence,
    parentSummary,
    summary,
    gate,
    eventsExists: events.exists,
    eventRunIds: events.runIds
  }
}

async function readNarutoJsonArtifact(file: string): Promise<NarutoJsonArtifact> {
  try {
    const parsed: unknown = JSON.parse(await fsp.readFile(file, 'utf8'))
    if (!isNarutoRecord(parsed)) return { exists: true, malformed: true, value: null }
    return { exists: true, malformed: false, value: parsed }
  } catch (error: unknown) {
    if (narutoErrorCode(error) === 'ENOENT') return { exists: false, malformed: false, value: null }
    return { exists: true, malformed: true, value: null }
  }
}

function reusableNarutoTerminalResponse(
  missionId: string,
  snapshot: NarutoAdmissionSnapshot
): Record<string, unknown> | null {
  if (narutoArtifactIdentityBlockers(missionId, snapshot).length > 0) return null
  const plan = snapshot.plan.value
  const evidence = snapshot.evidence.value
  const summary = snapshot.summary.value
  const gate = snapshot.gate.value
  const runId = canonicalNarutoRunId(snapshot)
  if (!runId) return null
  const core = Boolean(
    plan?.schema === 'sks.subagent-plan.v1'
      && plan?.workflow === 'official_codex_subagent'
      && evidence?.schema === 'sks.subagent-evidence.v1'
      && evidence?.workflow === 'official_codex_subagent'
      && summary?.schema === NARUTO_RESULT_SCHEMA
      && summary?.workflow === 'official_codex_subagent'
      && gate?.schema === 'sks.naruto-gate.v1'
      && gate?.workflow === 'official_codex_subagent'
  )
  if (!core || !summary || !gate || !evidence) return null

  const completed = summary.status === 'completed'
    && summary.ok === true
    && summary.completion_evidence === true
    && evidence.status === 'completed'
    && evidence.ok === true
    && evidence.parent_summary_trustworthy === true
    && gate.passed === true
    && gate.terminal === true
    && gate.terminal_state === 'completed'
    && snapshot.parentSummary.exists
    && !snapshot.parentSummary.malformed
    && snapshot.eventsExists
  if (completed) {
    return reusedNarutoResponse(missionId, runId, 'completed', summary, gate, evidence, true)
  }

  const blocked = summary.status === 'blocked'
    && summary.ok !== true
    && gate.passed !== true
    && gate.terminal_state === 'blocked'
    && (
      evidence.status === 'blocked'
      || uniqueStrings([
        ...narutoArray(evidence.blockers),
        ...narutoArray(gate.blockers)
      ]).length > 0
    )
  if (blocked) {
    return reusedNarutoResponse(
      missionId,
      runId,
      'blocked',
      summary,
      gate,
      evidence,
      snapshot.parentSummary.exists && !snapshot.parentSummary.malformed
    )
  }
  return null
}

function reusedNarutoResponse(
  missionId: string,
  runId: string,
  status: 'completed' | 'blocked',
  summary: Record<string, unknown>,
  gate: Record<string, unknown>,
  evidence: Record<string, unknown>,
  parentSummaryPresent: boolean
): Record<string, unknown> {
  return {
    ...summary,
    schema: NARUTO_RESULT_SCHEMA,
    ok: status === 'completed',
    completion_evidence: status === 'completed',
    status,
    mission_id: missionId,
    workflow_run_id: runId,
    parent_summary_present: parentSummaryPresent,
    reused: true,
    already_running: false,
    blockers: uniqueStrings([
      ...narutoArray(summary.blockers),
      ...narutoArray(gate.blockers),
      ...narutoArray(evidence.blockers)
    ])
  }
}

function runningNarutoResponse(
  missionId: string,
  snapshot: NarutoAdmissionSnapshot
): Record<string, unknown> {
  return {
    schema: NARUTO_RESULT_SCHEMA,
    // Observing the mission-wide owner is a successful idempotent admission
    // outcome. Completion is still false, but callers must not treat an
    // already-running workflow as a command failure.
    ok: true,
    completion_evidence: false,
    status: 'running',
    mission_id: missionId,
    workflow: 'official_codex_subagent',
    workflow_run_id: activeNarutoRunId(snapshot),
    reused: false,
    already_running: true,
    blockers: []
  }
}

function activeNarutoRunId(snapshot: NarutoAdmissionSnapshot): string | null {
  return narutoText(snapshot.plan.value?.workflow_run_id)
    || narutoText(snapshot.summary.value?.workflow_run_id)
    || narutoText(snapshot.gate.value?.workflow_run_id)
    || narutoText(snapshot.evidence.value?.run_id)
    || null
}

function blockedNarutoIdentityResponse(
  missionId: string,
  snapshot: NarutoAdmissionSnapshot,
  blockers: string[]
): Record<string, unknown> {
  return {
    schema: NARUTO_RESULT_SCHEMA,
    ok: false,
    completion_evidence: false,
    status: 'blocked',
    mission_id: missionId,
    workflow: 'official_codex_subagent',
    workflow_run_id: canonicalNarutoRunId(snapshot),
    reused: false,
    already_running: false,
    blockers
  }
}

function narutoArtifactIdentityBlockers(
  missionId: string,
  snapshot: NarutoAdmissionSnapshot
): string[] {
  const blockers: string[] = []
  if (!snapshot.mission.exists) blockers.push('naruto_mission_identity_conflict:mission_record_missing')
  else if (snapshot.mission.malformed) blockers.push('naruto_mission_identity_conflict:mission_record_malformed')
  else {
    if (narutoText(snapshot.mission.value?.id) !== missionId) {
      blockers.push('naruto_mission_identity_conflict:mission_record_id')
    }
    const mode = normalizeNarutoRoute(snapshot.mission.value?.mode)
    if (mode && mode !== 'naruto') blockers.push('naruto_mission_identity_conflict:mission_mode')
  }

  const artifacts: Array<[string, NarutoJsonArtifact, string]> = [
    [SUBAGENT_PLAN_FILENAME, snapshot.plan, 'sks.subagent-plan.v1'],
    [SUBAGENT_EVIDENCE_FILENAME, snapshot.evidence, 'sks.subagent-evidence.v1'],
    [SUBAGENT_PARENT_SUMMARY_FILENAME, snapshot.parentSummary, 'sks.subagent-parent-summary.v1'],
    [NARUTO_SUMMARY_FILENAME, snapshot.summary, NARUTO_RESULT_SCHEMA],
    [NARUTO_GATE_FILENAME, snapshot.gate, 'sks.naruto-gate.v1']
  ]
  for (const [name, artifact, schema] of artifacts) {
    if (!artifact.exists) continue
    if (artifact.malformed) {
      blockers.push('naruto_mission_identity_conflict:malformed:' + name)
      continue
    }
    if (artifact.value?.schema !== schema) {
      blockers.push('naruto_mission_identity_conflict:schema:' + name)
    }
    const artifactMissionId = narutoText(artifact.value?.mission_id)
    if (artifactMissionId && artifactMissionId !== missionId) {
      blockers.push('naruto_mission_identity_conflict:mission_id:' + name)
    }
    const workflow = narutoText(artifact.value?.workflow)
    if (workflow && workflow !== 'official_codex_subagent') {
      blockers.push('naruto_mission_identity_conflict:workflow:' + name)
    }
  }

  if (narutoArtifactRunIds(snapshot).length > 1) {
    blockers.push('naruto_mission_identity_conflict:workflow_run_id')
  }
  return uniqueStrings(blockers)
}

function narutoRequestIdentityBlockers(
  prompt: string,
  snapshot: NarutoAdmissionSnapshot
): string[] {
  if (!prompt || !snapshot.mission.value) return []
  const missionPrompt = narutoText(snapshot.mission.value.prompt)
  return missionPrompt && missionPrompt !== prompt
    ? ['naruto_mission_identity_conflict:mission_prompt']
    : []
}

function narutoArtifactRunIds(snapshot: NarutoAdmissionSnapshot): string[] {
  return uniqueStrings([
    narutoText(snapshot.plan.value?.workflow_run_id),
    narutoText(snapshot.evidence.value?.run_id),
    narutoText(snapshot.parentSummary.value?.run_id),
    narutoText(snapshot.summary.value?.workflow_run_id),
    narutoText(snapshot.gate.value?.workflow_run_id),
    ...snapshot.eventRunIds
  ])
}

function canonicalNarutoRunId(snapshot: NarutoAdmissionSnapshot): string | null {
  const runIds = narutoArtifactRunIds(snapshot)
  return runIds.length === 1 ? runIds[0] || null : null
}

function narutoEventRunIds(value: string): string[] {
  const values: string[] = []
  for (const line of value.split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const row: unknown = JSON.parse(line)
      if (isNarutoRecord(row)) {
        values.push(narutoText(row.workflow_run_id), narutoText(row.run_id))
      }
    } catch {
      // A torn incomplete line is not an identity claim. The admitted owner
      // may reset it only after the live/terminal checks above pass.
    }
  }
  return uniqueStrings(values)
}

function normalizeNarutoRoute(value: unknown): string {
  return narutoText(value).replace(/^\$/, '').replace(/^sks-/, '').replace(/_/g, '-').toLowerCase()
}

function narutoArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function narutoText(value: unknown): string {
  return String(value || '').trim()
}

function isNarutoRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function narutoErrorCode(error: unknown): string {
  return error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
}
