import fs from 'node:fs'
import path from 'node:path'
import { appendJsonlBounded, ensureDir, nowIso, packageRoot, writeJsonAtomic } from '../fsx.js'
import { writeCodexConfigGuarded } from '../codex/codex-config-guard.js'
import { validateJsonSchemaRecursive } from '../json-schema-validator.js'
import type { CodexTaskInput, CodexTaskResult } from './codex-control-plane.js'
import { resolveCodexOutputSchema } from './codex-output-schemas.js'
import { detectCodexSdkCapability } from './codex-sdk-capability.js'
import { mapCodexSdkSandboxPolicy } from './codex-sdk-sandbox-policy.js'
import { codexSdkRuntimePolicies, runRealCodexSdkTask } from './codex-sdk-adapter.js'
import { fakeCodexSdkAllowed, runFakeCodexSdkTask } from './codex-fake-sdk-adapter.js'
import { translateCodexSdkEvents } from './codex-event-translator.js'
import { writeCodexControlProof } from './codex-control-proof.js'
import { recordCodexThread } from './codex-thread-registry.js'
import { runWithCodexReliabilityShield } from './codex-reliability-shield.js'
import { routeCodexTask } from '../router/ultra-router.js'
import { writeUltraRouterProof } from '../router/router-proof.js'
import { readLocalModelConfig } from '../agents/ollama-worker-config.js'
import { runLocalLlmTask } from '../local-llm/local-llm-control-adapter.js'
import { detectPythonCodexSdkCapability, runPythonCodexSdkTask } from './python-codex-sdk-adapter.js'
import { defaultModelCallBudget, withModelCallSlot } from './model-call-concurrency.js'
import { inspectCodexLbSdkLaunchRecovery } from './codex-lb-launch-recovery.js'
import { prepareNativeCodexAuthBridge } from './codex-sdk-env-policy.js'

export async function runCodexTask(input: CodexTaskInput): Promise<CodexTaskResult & Record<string, unknown>> {
  const root = path.resolve(input.mutationLedgerRoot)
  await ensureDir(root)
  const schema = resolveCodexOutputSchema(input.outputSchemaId, input.outputSchema)
  const routerDecision = routeCodexTask(input)
  const task = { ...input, tier: input.tier || routerDecision.tier, outputSchema: schema }
  await writeUltraRouterProof(root, { task, decision: routerDecision })
  const selectedBackend = selectCodexControlBackend(task, routerDecision)
  if (selectedBackend === 'local-llm') return runLocalControlTask(root, task, schema, routerDecision)
  if (selectedBackend === 'python-codex-sdk') return runPythonControlTask(root, task, schema, routerDecision)
  const capability = await detectCodexSdkCapability()
  const sandbox = mapCodexSdkSandboxPolicy(task)
  const runtime = codexSdkRuntimePolicies(task)
  const bundledCodex = resolveBundledCodexBinary()
  if (bundledCodex && !runtime.env.env.SKS_PYTHON_CODEX_SDK_CODEX_BIN) runtime.env.env.SKS_PYTHON_CODEX_SDK_CODEX_BIN = bundledCodex
  if (runtime.env.env.HOME) await ensureDir(runtime.env.env.HOME)
  if (runtime.env.env.CODEX_HOME) await ensureDir(runtime.env.env.CODEX_HOME)
  const fakeAllowed = fakeCodexSdkAllowed()
  const nativeCodexAuthBridge = await prepareNativeCodexAuthBridge(runtime.env.env, { required: !fakeAllowed })
  if (nativeCodexAuthBridge.ok) {
    runtime.env.proof.home = runtime.env.env.HOME
    runtime.env.proof.codex_home = runtime.env.env.CODEX_HOME
  }
  const codexLbToolOutputRecovery = await inspectCodexLbSdkLaunchRecovery({
    config: runtime.config,
    env: runtime.env.env,
    overrideEnv: process.env
  })
  if (codexLbToolOutputRecovery.ok) await ensurePythonCodexLbConfig(runtime.env.env, runtime.config)
  const blockers = [
    ...(capability.ok || fakeAllowed ? [] : capability.blockers),
    ...(sandbox.ok ? [] : sandbox.blockers),
    ...(nativeCodexAuthBridge.ok ? [] : nativeCodexAuthBridge.blockers),
    ...(codexLbToolOutputRecovery.ok ? [] : codexLbToolOutputRecovery.blockers)
  ]
  let adapterResult: any = null
  let nativeAuthCleanupBlockers: string[] = []
  try {
    if (!blockers.length) {
      adapterResult = await withModelCallSlot({
        root,
        missionId: task.missionId,
        provider: 'codex-sdk',
        budget: defaultModelCallBudget('codex-sdk'),
        slotId: task.slotId || null,
        generationIndex: task.generationIndex ?? null,
        sessionId: task.sessionId || null,
        backend: 'codex-sdk'
      }, () => runWithCodexReliabilityShield(task, async (_attempt, controls) => {
        try {
          const attemptTask = controls?.noMcp
            ? { ...task, requestedScopeContract: { ...task.requestedScopeContract, no_mcp: true } }
            : task
          return fakeAllowed
            ? await runFakeCodexSdkTask(attemptTask)
            : await runRealCodexSdkTask(attemptTask, { sandboxMode: sandbox.sandboxMode, env: runtime.env.env, config: { ...runtime.config, mcp_servers: {} } })
        } catch (err: any) {
          return {
            ok: false,
            sdkThreadId: '',
            sdkRunId: null,
            events: [],
            finalResponse: '',
            structuredOutput: null,
            blockers: ['codex_sdk_run_failed:' + String(err?.message || err)]
          }
        }
      }))
    }
  } finally {
    nativeAuthCleanupBlockers = await cleanupNativeCodexAuthBridge(nativeCodexAuthBridge)
  }
  const events = Array.isArray(adapterResult?.events) ? adapterResult.events : []
  const translatedEvents = translateCodexSdkEvents(events)
  if (adapterResult?.liveEventsWritten !== true) {
    for (const event of translatedEvents) await appendJsonlBounded(path.join(root, 'codex-sdk-events.jsonl'), event, 5 * 1024 * 1024)
  }
  if (adapterResult?.reliabilityShield) await writeJsonAtomic(path.join(root, 'codex-reliability-shield.json'), adapterResult.reliabilityShield)
  const structuredOutput = adapterResult?.structuredOutput
  const validation = structuredOutput ? validateJsonSchemaRecursive(structuredOutput, schema) : { ok: false, issues: ['structured_output_missing'] }
  const primaryBlockers = [
    ...blockers,
    ...nativeAuthCleanupBlockers,
    ...(adapterResult?.blockers || []),
    ...codexControlAdapterFailureBlockers(adapterResult, 'codex-sdk')
  ]
  const runFailed = isRunFailureBlocker(primaryBlockers)
  const finalBlockers = [
    ...primaryBlockers,
    ...(!runFailed && events.length === 0 ? ['codex_sdk_event_stream_missing'] : []),
    ...(!runFailed && !validation.ok ? ['codex_sdk_structured_output_invalid', ...validation.issues.map((issue) => `schema:${issue}`)] : [])
  ]
  const workerResult = normalizeWorkerResult(structuredOutput, task, finalBlockers, validation.ok)
  const workerResultPath = path.join(root, 'codex-sdk-worker-result.json')
  await writeJsonAtomic(workerResultPath, workerResult)
  const patchEnvelopePath = Array.isArray(workerResult.patch_envelopes) && workerResult.patch_envelopes.length
    ? path.join(root, 'codex-sdk-patch-envelope.json')
    : null
  if (patchEnvelopePath) {
    await writeJsonAtomic(patchEnvelopePath, {
      schema: 'sks.codex-sdk-patch-envelope.v1',
      generated_at: nowIso(),
      ok: true,
      envelope_count: workerResult.patch_envelopes.length,
      envelopes: workerResult.patch_envelopes
    })
  }
  const result: CodexTaskResult & Record<string, unknown> = {
    ok: finalBlockers.length === 0,
    // Must match backend_family below: a fake-adapter run self-reporting
    // 'codex-sdk' here defeated every downstream `backend === 'fake'` check
    // (fake-real-proof-policy, agent-proof-evidence, naruto-real-write-proof,
    // etc.) that already exists specifically to disclaim fixture-only runs.
    backend: fakeAllowed ? 'fake' : 'codex-sdk',
    backend_family: fakeAllowed ? 'fake' : 'remote-gpt',
    sdkThreadId: String(adapterResult?.sdkThreadId || ''),
    sdkRunId: adapterResult?.sdkRunId ? String(adapterResult.sdkRunId) : null,
    runtimeIdentity: adapterResult?.runtimeIdentity || null,
    streamEventCount: events.length,
    structuredOutputValid: validation.ok,
    workerResultPath,
    patchEnvelopePath,
    blockers: finalBlockers,
    codexLbToolOutputRecovery,
    reliabilityShield: adapterResult?.reliabilityShield || null,
    capacityFallback: adapterResult?.reliabilityShield?.selected_model_capacity_fallback === true,
    modelCapacityRetryCount: Number(adapterResult?.reliabilityShield?.model_capacity_retry_count || 0),
    ultraRouterDecision: routerDecision as unknown as Record<string, unknown>,
    outputSchemaId: task.outputSchemaId,
    finalResponse: adapterResult?.finalResponse || '',
    eventTypes: events.map((event: any) => String(event?.type || 'unknown')),
    translatedEventCount: translatedEvents.length
  }
  await recordCodexThread(root, {
    backend: result.backend,
    backend_family: result.backend_family,
    route: task.route,
    mission_id: task.missionId,
    work_item_id: task.workItemId || null,
    slot_id: task.slotId || null,
    generation_index: task.generationIndex ?? null,
    session_id: task.sessionId || null,
    zellij_pane_id: task.zellijPaneId || null,
    sdk_thread_id: result.sdkThreadId,
    sdk_run_id: result.sdkRunId,
    stream_event_count: result.streamEventCount,
    output_schema_id: task.outputSchemaId,
    structured_output_valid: result.structuredOutputValid,
    worker_result_path: result.workerResultPath
  })
  await writeCodexControlProof(root, {
    task,
    result,
    capability: capability as unknown as Record<string, unknown>,
    sandbox,
    envProof: {
      ...runtime.env.proof,
      capacity_fallback_selected: result.capacityFallback === true,
      model_capacity_retry_count: result.modelCapacityRetryCount,
      native_codex_auth_bridge: nativeCodexAuthBridge.proof,
      codex_lb_tool_output_recovery: codexLbToolOutputRecovery
    },
    config: runtime.config,
    reliabilityShield: adapterResult?.reliabilityShield || null,
    routerDecision: routerDecision as unknown as Record<string, unknown>,
    translatedEvents
  })
  return result
}

async function runPythonControlTask(root: string, task: CodexTaskInput, schema: Record<string, unknown>, routerDecision: unknown) {
  const capability = await detectPythonCodexSdkCapability()
  const runtime = codexSdkRuntimePolicies(task)
  if (runtime.env.env.HOME) await ensureDir(runtime.env.env.HOME)
  if (runtime.env.env.CODEX_HOME) await ensureDir(runtime.env.env.CODEX_HOME)
  const fakeAllowed = process.env.SKS_PYTHON_CODEX_SDK_FAKE === '1'
  const nativeCodexAuthBridge = await prepareNativeCodexAuthBridge(runtime.env.env, { required: !fakeAllowed })
  if (nativeCodexAuthBridge.ok) {
    runtime.env.proof.home = runtime.env.env.HOME
    runtime.env.proof.codex_home = runtime.env.env.CODEX_HOME
  }
  const codexLbToolOutputRecovery = await inspectCodexLbSdkLaunchRecovery({
    config: runtime.config,
    env: runtime.env.env,
    overrideEnv: process.env
  })
  let adapterResult: any
  let nativeAuthCleanupBlockers: string[] = []
  try {
    adapterResult = codexLbToolOutputRecovery.ok && nativeCodexAuthBridge.ok && (capability.ok || fakeAllowed)
      ? await withModelCallSlot({
        root,
        missionId: task.missionId,
        provider: 'python-codex-sdk',
        budget: defaultModelCallBudget('python-codex-sdk'),
        slotId: task.slotId || null,
        generationIndex: task.generationIndex ?? null,
        sessionId: task.sessionId || null,
        backend: 'python-codex-sdk'
      }, () => runPythonCodexSdkTask(task, { env: runtime.env.env, config: runtime.config }))
      : {
          ok: false,
          events: [],
          translatedEvents: [],
          finalResponse: '',
          threadId: '',
          turnId: '',
          blockers: [
            ...(codexLbToolOutputRecovery.ok ? [] : codexLbToolOutputRecovery.blockers),
            ...(nativeCodexAuthBridge.ok ? [] : nativeCodexAuthBridge.blockers),
            ...(capability.ok || fakeAllowed ? [] : capability.blockers)
          ],
          capability
        }
  } finally {
    nativeAuthCleanupBlockers = await cleanupNativeCodexAuthBridge(nativeCodexAuthBridge)
  }
  const events = Array.isArray(adapterResult.events) ? adapterResult.events : []
  const translatedEvents = Array.isArray(adapterResult.translatedEvents) ? adapterResult.translatedEvents : []
  for (const event of translatedEvents) await appendJsonlBounded(path.join(root, 'python-codex-sdk-events.jsonl'), event, 5 * 1024 * 1024)
  const structuredOutput = parseStructuredOutput(adapterResult.finalResponse || '')
  const validation = structuredOutput ? validateJsonSchemaRecursive(structuredOutput, schema) : { ok: false, issues: ['structured_output_missing'] }
  const primaryBlockers = [
    ...nativeAuthCleanupBlockers,
    ...(adapterResult.blockers || []),
    ...codexControlAdapterFailureBlockers(adapterResult, 'python-codex-sdk')
  ]
  const runFailed = isRunFailureBlocker(primaryBlockers)
  const finalBlockers = [
    ...primaryBlockers,
    ...(runFailed || events.length > 0 ? [] : ['python_codex_sdk_event_stream_missing']),
    ...(runFailed || validation.ok ? [] : ['python_codex_sdk_structured_output_invalid', ...validation.issues.map((issue) => `schema:${issue}`)])
  ]
  const workerResult = normalizeWorkerResult(structuredOutput, task, finalBlockers, validation.ok, 'python-codex-sdk')
  const workerResultPath = path.join(root, 'python-codex-sdk-worker-result.json')
  await writeJsonAtomic(workerResultPath, workerResult)
  const patchEnvelopePath = Array.isArray(workerResult.patch_envelopes) && workerResult.patch_envelopes.length
    ? path.join(root, 'python-codex-sdk-patch-envelope.json')
    : null
  if (patchEnvelopePath) {
    await writeJsonAtomic(patchEnvelopePath, {
      schema: 'sks.python-codex-sdk-patch-envelope.v1',
      generated_at: nowIso(),
      ok: true,
      envelope_count: workerResult.patch_envelopes.length,
      envelopes: workerResult.patch_envelopes
    })
  }
  const pythonSdkProofPath = path.join(root, 'python-codex-sdk-proof.json')
  await writeJsonAtomic(pythonSdkProofPath, {
    schema: 'sks.python-codex-sdk-proof.v1',
    generated_at: nowIso(),
    ok: finalBlockers.length === 0,
    backend: 'python-codex-sdk',
    backend_family: fakeAllowed ? 'fake' : 'python-sdk',
    package_name: capability.package_name,
    import_name: capability.import_name,
    python_bin: capability.python_bin,
    python_version: capability.python_version,
    sandbox: task.sandboxPolicy,
    thread_id: adapterResult.threadId || '',
    turn_id: adapterResult.turnId || '',
    stream_event_count: events.length,
    structured_output_valid: validation.ok,
    worker_result_path: workerResultPath,
    native_codex_auth_bridge: nativeCodexAuthBridge.proof,
    codex_lb_tool_output_recovery: codexLbToolOutputRecovery,
    blockers: finalBlockers
  })
  const result: CodexTaskResult & Record<string, unknown> = {
    ok: finalBlockers.length === 0,
    backend: 'python-codex-sdk',
    backend_family: fakeAllowed ? 'fake' : 'python-sdk',
    sdkThreadId: String(adapterResult.threadId || ''),
    sdkRunId: adapterResult.turnId ? String(adapterResult.turnId) : null,
    streamEventCount: events.length,
    structuredOutputValid: validation.ok,
    workerResultPath,
    patchEnvelopePath,
    pythonSdkProofPath,
    blockers: finalBlockers,
    codexLbToolOutputRecovery,
    reliabilityShield: {},
    ultraRouterDecision: routerDecision as Record<string, unknown>,
    outputSchemaId: task.outputSchemaId,
    finalResponse: adapterResult.finalResponse || '',
    eventTypes: events.map((event: any) => String(event?.event || event?.type || 'unknown')),
    translatedEventCount: translatedEvents.length
  }
  await recordCodexThread(root, {
    backend: result.backend,
    backend_family: result.backend_family,
    route: task.route,
    mission_id: task.missionId,
    work_item_id: task.workItemId || null,
    slot_id: task.slotId || null,
    generation_index: task.generationIndex ?? null,
    session_id: task.sessionId || null,
    zellij_pane_id: task.zellijPaneId || null,
    sdk_thread_id: result.sdkThreadId,
    sdk_run_id: result.sdkRunId,
    stream_event_count: result.streamEventCount,
    output_schema_id: task.outputSchemaId,
    structured_output_valid: result.structuredOutputValid,
    worker_result_path: result.workerResultPath
  })
  await writeCodexControlProof(root, {
    task,
    result,
    capability: capability as unknown as Record<string, unknown>,
    sandbox: { ok: true, sandbox_policy: task.sandboxPolicy, python_sandbox: mapPythonSandbox(task.sandboxPolicy), blockers: [] },
    envProof: {
      ...runtime.env.proof,
      python_bin: capability.python_bin,
      python_version: capability.python_version,
      native_codex_auth_bridge: nativeCodexAuthBridge.proof,
      codex_lb_tool_output_recovery: codexLbToolOutputRecovery
    },
    config: { ...runtime.config, backend: 'python-codex-sdk', package_name: capability.package_name, import_name: capability.import_name },
    reliabilityShield: null,
    routerDecision: routerDecision as Record<string, unknown>,
    translatedEvents
  })
  return result
}

async function cleanupNativeCodexAuthBridge(bridge: Awaited<ReturnType<typeof prepareNativeCodexAuthBridge>>): Promise<string[]> {
  const proof = bridge.proof as Record<string, any>
  try {
    const cleanup = await bridge.cleanup()
    proof.cleanup_required = cleanup.cleanup_required
    proof.cleanup_status = cleanup.status
    proof.cleanup_outcome = cleanup.outcome
    if (!cleanup.ok) {
      proof.cleanup_blockers = cleanup.blockers
      return cleanup.blockers
    }
    return []
  } catch (error: any) {
    const blocker = `native_codex_auth_cleanup_failed:${String(error?.message || error)}`
    proof.cleanup_required = true
    proof.cleanup_status = 'failed'
    proof.cleanup_blockers = [blocker]
    return [blocker]
  }
}

async function runLocalControlTask(root: string, task: CodexTaskInput, schema: Record<string, unknown>, routerDecision: unknown) {
  const config = await readLocalModelConfig()
  const adapterResult = await withModelCallSlot({
    root,
    missionId: task.missionId,
    provider: 'local-llm',
    budget: defaultModelCallBudget('local-llm'),
    slotId: task.slotId || null,
    generationIndex: task.generationIndex ?? null,
    sessionId: task.sessionId || null,
    backend: 'local-llm'
  }, () => runLocalLlmTask(task, { config, outputSchema: schema }))
  for (const event of adapterResult.events || []) await appendJsonlBounded(path.join(root, 'local-llm-events.jsonl'), event, 5 * 1024 * 1024)
  const structuredOutput = adapterResult.structuredOutput
  const validation = structuredOutput ? validateJsonSchemaRecursive(structuredOutput, schema) : { ok: false, issues: ['structured_output_missing'] }
  const primaryBlockers = [
    ...(adapterResult.blockers || []),
    ...codexControlAdapterFailureBlockers(adapterResult, 'local-llm')
  ]
  const runFailed = isRunFailureBlocker(primaryBlockers)
  const finalBlockers = [
    ...primaryBlockers,
    ...(runFailed || (Array.isArray(adapterResult.events) && adapterResult.events.length > 0) ? [] : ['local_llm_event_stream_missing']),
    ...(runFailed || validation.ok ? [] : ['local_llm_structured_output_invalid', ...validation.issues.map((issue) => `schema:${issue}`)])
  ]
  const workerResult = normalizeWorkerResult(structuredOutput, task, finalBlockers, validation.ok, 'local-llm')
  // Stamp the local-llm request id as backend proof on model-authored patch
  // envelopes; without it agent-patch-schema rejects every local-llm patch
  // with model_authored_backend_proof_missing (the model cannot know the id).
  if (Array.isArray(workerResult.patch_envelopes)) {
    workerResult.patch_envelopes = workerResult.patch_envelopes.map((envelope: any) => ({
      ...envelope,
      backend_ollama_request_id: envelope?.backend_ollama_request_id || adapterResult.requestId
    }))
  }
  const workerResultPath = path.join(root, 'local-llm-worker-result.json')
  await writeJsonAtomic(workerResultPath, workerResult)
  const patchEnvelopePath = Array.isArray(workerResult.patch_envelopes) && workerResult.patch_envelopes.length
    ? path.join(root, 'local-llm-patch-envelope.json')
    : null
  if (patchEnvelopePath) {
    await writeJsonAtomic(patchEnvelopePath, {
      schema: 'sks.local-llm-patch-envelope.v1',
      generated_at: nowIso(),
      ok: true,
      envelope_count: workerResult.patch_envelopes.length,
      envelopes: workerResult.patch_envelopes,
      requires_gpt_final: true
    })
  }
  const localLlmProofPath = path.join(root, 'local-llm-proof.json')
  await writeJsonAtomic(localLlmProofPath, adapterResult.proof)
  const result: CodexTaskResult & Record<string, unknown> = {
    ok: finalBlockers.length === 0,
    backend: 'local-llm',
    backend_family: 'local-llm',
    sdkThreadId: '',
    sdkRunId: null,
    streamEventCount: adapterResult.events?.length || 0,
    structuredOutputValid: validation.ok,
    workerResultPath,
    patchEnvelopePath,
    localLlmProofPath,
    blockers: finalBlockers,
    reliabilityShield: {},
    ultraRouterDecision: routerDecision as Record<string, unknown>,
    outputSchemaId: task.outputSchemaId,
    finalResponse: adapterResult.finalResponse || '',
    eventTypes: (adapterResult.events || []).map((event: any) => String(event?.type || 'unknown')),
    translatedEventCount: adapterResult.events?.length || 0,
    localLlmRequestId: adapterResult.requestId
  }
  await recordCodexThread(root, {
    backend: result.backend,
    backend_family: result.backend_family,
    route: task.route,
    mission_id: task.missionId,
    work_item_id: task.workItemId || null,
    slot_id: task.slotId || null,
    generation_index: task.generationIndex ?? null,
    session_id: task.sessionId || null,
    zellij_pane_id: task.zellijPaneId || null,
    sdk_thread_id: null,
    sdk_run_id: null,
    local_llm_request_id: adapterResult.requestId,
    stream_event_count: result.streamEventCount,
    output_schema_id: task.outputSchemaId,
    structured_output_valid: result.structuredOutputValid,
    worker_result_path: result.workerResultPath
  })
  await writeCodexControlProof(root, {
    task,
    result,
    capability: config.capability as unknown as Record<string, unknown>,
    sandbox: { ok: task.sandboxPolicy !== 'full-access', sandbox_policy: task.sandboxPolicy, blockers: task.sandboxPolicy === 'full-access' ? ['local_llm_full_access_blocked'] : [] },
    envProof: { provider: config.provider, endpoint: config.base_url },
    config: { provider: config.provider, model: config.model, endpoint: config.base_url, status: config.status },
    reliabilityShield: null,
    routerDecision: routerDecision as Record<string, unknown>,
    translatedEvents: adapterResult.events || []
  })
  return result
}

function selectCodexControlBackend(input: CodexTaskInput, routerDecision: any): 'codex-sdk' | 'python-codex-sdk' | 'local-llm' {
  const prefs = Array.isArray(input.backendPreference) ? input.backendPreference : []
  for (const pref of prefs) {
    if (pref === 'python-codex-sdk') return 'python-codex-sdk'
    if (pref === 'codex-sdk') return 'codex-sdk'
    if (pref === 'local-llm' && input.tier === 'worker') return 'local-llm'
  }
  if (input.localLlmPolicy?.mode === 'disabled') return 'codex-sdk'
  if (input.allowLocalLlm === true && input.tier === 'worker' && routerDecision?.selected_profile === 'local-llm-worker') return 'local-llm'
  if (input.allowLocalLlm === true && input.tier === 'worker' && input.localLlmPolicy?.mode === 'local_only') return 'local-llm'
  if (input.allowLocalLlm === true && input.tier === 'worker' && input.localLlmPolicy?.mode === 'local_preferred') return 'local-llm'
  return 'codex-sdk'
}

function normalizeWorkerResult(value: any, input: CodexTaskInput, blockers: string[], structuredOutputValid: boolean, backend: 'codex-sdk' | 'python-codex-sdk' | 'local-llm' = 'codex-sdk') {
  const status = blockers.length ? 'blocked' : normalizeStatus(value?.status)
  return {
    ...value,
    mission_id: String(value?.mission_id || input.missionId || ''),
    agent_id: String(value?.agent_id || input.slotId || input.workItemId || 'codex-sdk-worker'),
    session_id: String(value?.session_id || input.sessionId || input.workItemId || 'codex-sdk-session'),
    persona_id: String(value?.persona_id || value?.agent_id || input.slotId || 'codex-sdk-worker'),
    task_slice_id: String(value?.task_slice_id || input.workItemId || ''),
    backend,
    status,
    summary: String(value?.summary || (blockers.length ? `${backend} task blocked.` : `${backend} task completed.`)),
    findings: Array.isArray(value?.findings) ? value.findings : [],
    proposed_changes: Array.isArray(value?.proposed_changes) ? value.proposed_changes : [],
    changed_files: Array.isArray(value?.changed_files) ? value.changed_files : [],
    lease_compliance: value?.lease_compliance || { ok: true, violations: [] },
    artifacts: Array.isArray(value?.artifacts) ? value.artifacts : [],
    blockers,
    confidence: String(value?.confidence || (structuredOutputValid ? 'verified_partial' : 'blocked')),
    handoff_notes: String(value?.handoff_notes || `${backend} Control Plane produced this worker result.`),
    unverified: Array.isArray(value?.unverified) ? value.unverified : [],
    writes: Array.isArray(value?.writes) ? value.writes : [],
    patch_envelopes: Array.isArray(value?.patch_envelopes) ? value.patch_envelopes : [],
    rollback_notes: Array.isArray(value?.rollback_notes) ? value.rollback_notes : [],
    verification: value?.verification || { status: structuredOutputValid ? 'passed' : 'failed', checks: ['codex-sdk-output-schema'] },
    recursion_guard: value?.recursion_guard || { ok: true, violations: [] }
  }
}

function normalizeStatus(value: unknown): 'done' | 'failed' | 'blocked' {
  return value === 'failed' || value === 'blocked' || value === 'done' ? value : 'done'
}

function isRunFailureBlocker(blockers: readonly unknown[]): boolean {
  return blockers.some((blocker) => {
    const text = String(blocker || '')
    return text.startsWith('codex_sdk_run_failed')
      || text.startsWith('codex_sdk_turn_timeout')
      || text.startsWith('python_codex_sdk_run_failed')
      || text.startsWith('python_codex_sdk_timeout')
      || text.startsWith('python_codex_sdk_error')
      || text.startsWith('native_codex_auth_bridge_failed')
      || text.startsWith('native_codex_auth_cleanup_failed')
      || text.startsWith('local_llm_generate_failed')
      || text.startsWith('local_llm_eligibility_blocked')
      || text.startsWith('codex_lb_tool_output_recovery_')
      || text.endsWith('_adapter_reported_failure')
      || text === 'codex_reliability_shield_failed'
      || text === 'codex_reliability_fatal_error_no_retry'
      || text === 'codex_reliability_mcp_auth_error'
  })
}

export function codexControlAdapterFailureBlockers(
  adapterResult: any,
  backend: 'codex-sdk' | 'python-codex-sdk' | 'local-llm'
): string[] {
  if (!adapterResult) return []
  const blockers = adapterResult.ok === true ? [] : [`${backend.replaceAll('-', '_')}_adapter_reported_failure`]
  if (backend === 'codex-sdk' && adapterResult.reliabilityShield && adapterResult.reliabilityShield.ok !== true) {
    blockers.push('codex_reliability_shield_failed')
  }
  return [...new Set(blockers)]
}

function mapPythonSandbox(value: string) {
  if (value === 'workspace-write') return 'workspace_write'
  if (value === 'full-access') return 'full_access'
  return 'read_only'
}

function parseStructuredOutput(text: string) {
  const trimmed = String(text || '').trim()
  if (!trimmed) return null
  try {
    return JSON.parse(trimmed)
  } catch {
    const start = trimmed.indexOf('{')
    const end = trimmed.lastIndexOf('}')
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1))
      } catch {}
    }
    return null
  }
}

async function ensurePythonCodexLbConfig(env: Record<string, string>, config: Record<string, unknown>) {
  const codexHome = env.CODEX_HOME
  const lbBaseUrl = normalizeCodexLbBaseUrl(env.CODEX_LB_BASE_URL)
  if (!codexHome || !lbBaseUrl || !env.CODEX_LB_API_KEY) return
  const model = String(config.model || env.SKS_CODEX_MODEL || env.CODEX_MODEL || '').trim()
  const text = [
    ...(model ? [`model = ${tomlQuote(model)}`] : []),
    'model_provider = "codex-lb"',
    'service_tier = "fast"',
    `model_reasoning_effort = ${tomlQuote(String(config.model_reasoning_effort || env.SKS_CODEX_REASONING || env.CODEX_MODEL_REASONING_EFFORT || 'minimal'))}`,
    'approval_policy = "never"',
    '',
    '[model_providers.codex-lb]',
    'name = "codex-lb"',
    `base_url = ${tomlQuote(lbBaseUrl)}`,
    'wire_api = "responses"',
    'env_key = "CODEX_LB_API_KEY"',
    'supports_websockets = true',
    'requires_openai_auth = false',
    ''
  ].join('\n')
  const configPath = path.join(codexHome, 'config.toml')
  await writeCodexConfigGuarded({
    configPath,
    cause: 'python-codex-lb-config',
    mutate: () => text
  })
}

function normalizeCodexLbBaseUrl(value: unknown) {
  let host = String(value || '').trim()
  if (!host) return ''
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(host)) host = `https://${host}`
  host = host.replace(/\/+$/, '')
  return /\/backend-api\/codex$/i.test(host) ? host : `${host}/backend-api/codex`
}

function tomlQuote(value: string) {
  return JSON.stringify(value)
}

function resolveBundledCodexBinary() {
  const platform = process.platform
  const arch = process.arch
  const pkg = platform === 'darwin' && arch === 'arm64'
    ? '@openai/codex-darwin-arm64'
    : platform === 'darwin' && arch === 'x64'
      ? '@openai/codex-darwin-x64'
      : platform === 'linux' && arch === 'arm64'
        ? '@openai/codex-linux-arm64'
        : platform === 'linux' && arch === 'x64'
          ? '@openai/codex-linux-x64'
          : platform === 'win32' && arch === 'x64'
            ? '@openai/codex-win32-x64'
            : platform === 'win32' && arch === 'arm64'
              ? '@openai/codex-win32-arm64'
              : ''
  if (!pkg) return ''
  const binary = platform === 'win32' ? 'codex.exe' : 'codex'
  const candidates = [
    path.join(packageRoot(), 'node_modules', pkg, 'vendor', nativeTargetTriple(platform, arch), 'bin', binary),
    path.join(packageRoot(), 'node_modules', pkg, 'vendor', nativeTargetTriple(platform, arch), 'codex', binary)
  ]
  return candidates.find((candidate) => fs.existsSync(candidate)) || ''
}

function nativeTargetTriple(platform: NodeJS.Platform, arch: string) {
  if (platform === 'darwin' && arch === 'arm64') return 'aarch64-apple-darwin'
  if (platform === 'darwin' && arch === 'x64') return 'x86_64-apple-darwin'
  if (platform === 'linux' && arch === 'arm64') return 'aarch64-unknown-linux-musl'
  if (platform === 'linux' && arch === 'x64') return 'x86_64-unknown-linux-musl'
  if (platform === 'win32' && arch === 'arm64') return 'aarch64-pc-windows-msvc'
  if (platform === 'win32' && arch === 'x64') return 'x86_64-pc-windows-msvc'
  return ''
}
