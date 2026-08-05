import path from 'node:path'
import { nowIso, writeJsonAtomic } from '../fsx.js'
import { resolveLocalCollaborationPolicy } from '../local-llm/local-collaboration-policy.js'

export const DOCTOR_READINESS_MATRIX_SCHEMA = 'sks.doctor-readiness-matrix.v2'
const OPTIONAL_ROUTE_SCOPES = new Set(['route-computer-use', 'route-chrome-web-review', 'route-app-handoff', 'route-app-screenshot'])

export async function writeDoctorReadinessMatrix(root: string, input: any = {}) {
  const matrix = buildDoctorReadinessMatrix(input)
  const reportPath = input.reportPath || path.join(root, '.sneakoscope', 'reports', 'doctor-ready-breakdown.json')
  await writeJsonAtomic(reportPath, { ...matrix, report_path: reportPath })
  return { ...matrix, report_path: reportPath }
}

export function buildDoctorReadinessMatrix(input: any = {}) {
  const codexConfig = input.codex_config || {}
  const checks = Array.isArray(codexConfig.checks) ? codexConfig.checks : []
  const actual = checks.find((check: any) => check.name === 'actual_codex_cli_config_load') || {}
  const nodeRead = checks.find((check: any) => check.name === 'node_process_read' || check.name === 'node_read') || {}
  const childRead = checks.find((check: any) => check.name === 'spawned_child_read' || check.name === 'spawned_node_child_read') || {}
  const codexDoctor = input.codex_doctor || null
  const codexCliRequired = input.require_codex_cli_config_load === true
  const actualOk = actual.ok === true && !String(actual.status || '').includes('not_requested')
  const cliConfigOk = codexCliRequired ? actualOk : (actual.ok !== false)
  const codexBinOk = Boolean(input.codex?.bin || input.codex?.available)
  const configBlockers = normalizeList(codexConfig.blockers)
  const blockers = new Set<string>()
  const warnings = new Set<string>()

  if (!codexBinOk) blockers.add('codex_cli_missing')
  if (nodeRead.ok === false) blockers.add('codex_config_node_read_failed')
  if (childRead.ok === false) blockers.add('codex_config_child_read_failed')
  if (!cliConfigOk) {
    for (const blocker of configBlockers) blockers.add(blocker)
    if (!configBlockers.length) blockers.add('codex_cli_config_load_unverified')
  }
  const codexDoctorBlockers = normalizeList(codexDoctor?.blockers)
  const codexDoctorBlockingChecks = Array.isArray(codexDoctor?.blocking_checks)
    ? codexDoctor.blocking_checks.map((check: any) => String(check?.issue || check?.id || '')).filter(Boolean)
    : []
  if (codexDoctor?.disposition === 'block' || codexDoctorBlockers.length || codexDoctorBlockingChecks.length) {
    for (const blocker of [...codexDoctorBlockers, ...codexDoctorBlockingChecks]) blockers.add(blocker)
    if (!codexDoctorBlockers.length && !codexDoctorBlockingChecks.length) blockers.add('codex_doctor_blocked')
  }
  if (codexDoctor?.warnings?.length) for (const warning of codexDoctor.warnings) warnings.add(String(warning))
  if (input.codex_app?.ok === false) warnings.add('codex_app_needs_setup_optional_for_cli')
  if (input.codex_app_ui?.fast_selector === 'manual_action_required') warnings.add('codex_app_fast_selector_manual_action_required')
  if (input.codex_app_ui?.requires_confirmation === true) blockers.add('codex_app_fast_ui_repair_requires_confirmation')
  if (input.codex_app_ui?.fast_selector === 'repaired') warnings.add('codex_app_fast_selector_repaired_restart_app_if_needed')
  if (input.sks_menubar?.ok === false) warnings.add(`sks_menubar_${input.sks_menubar?.status || 'blocked'}`)
  const telegramRemote = input.telegram_remote || null
  if (telegramRemote?.status === 'degraded') {
    for (const blocker of normalizeList(telegramRemote.blockers)) warnings.add(`telegram_remote:${blocker}`)
    if (!normalizeList(telegramRemote.blockers).length) warnings.add('telegram_remote_degraded')
  }
  const codexCurrentAppDoctor = input.codex_current_app_doctor || null
  if (codexCurrentAppDoctor?.ok === false) for (const blocker of normalizeList(codexCurrentAppDoctor.blockers)) warnings.add(blocker)
  for (const warning of normalizeList(codexCurrentAppDoctor?.warnings)) warnings.add(warning)
  const codexCurrentCoreRealProbes = input.codex_current_core_real_probes || null
  if (codexCurrentCoreRealProbes?.real_probes_last_run_status === 'blocked') warnings.add('codex_current_core_real_probes_blocked')
  if (codexCurrentCoreRealProbes?.real_probes_last_run_status === 'not_run') warnings.add('codex_current_core_real_probes_not_run')
  for (const warning of normalizeList(input.codex_plugin_app_template_policy?.doctor_warnings)) warnings.add(warning)
  const codexAppHarness = input.codex_app_harness_matrix || null
  for (const warning of normalizeList(codexAppHarness?.warnings)) warnings.add(warning)
  if (codexAppHarness?.ok === false) for (const blocker of normalizeList(codexAppHarness.blockers)) warnings.add(`codex_app_harness:${blocker}`)
  const desktopBridge = input.desktop_bridge_status || input.desktop_bridge || null
  if (desktopBridge?.management?.managed === true && desktopBridge?.readiness?.ready !== true) {
    const bridgeBlockers = normalizeList(desktopBridge?.readiness?.blockers)
    for (const blocker of bridgeBlockers) blockers.add(blocker)
    if (!bridgeBlockers.length) blockers.add('desktop_bridge_not_ready')
  }
  if (desktopBridge?.management?.managed === true && desktopBridge?.service?.running !== true) {
    warnings.add('desktop_bridge_service_not_running')
  }
  const localModel = input.local_model || {}
  const localStatus = String(localModel.status || (localModel.enabled ? 'enabled_unverified' : 'disabled'))
  if (localModel.enabled === true && localStatus === 'enabled_unverified') warnings.add('local_llm_enabled_unverified')
  if (localModel.enabled === true && localStatus === 'degraded') warnings.add('local_llm_degraded')
  if (localModel.enabled === true && localStatus === 'blocked') warnings.add('local_llm_blocked_worker_tier_disabled')
  const agentRoleConfig = input.agent_role_config || {}
  if (agentRoleConfig.ok === false) blockers.add('agent_role_config_repair_failed')
  if (Array.isArray(agentRoleConfig.missing) && agentRoleConfig.missing.length && agentRoleConfig.apply !== true) warnings.add('agent_role_config_missing_repair_available')
  const skills = input.skills || null
  for (const scope of ['global', 'project']) {
    const report = skills?.[scope]
    if (!report || report.skipped === true) continue
    if (report.ok === false || report.core_skill_integrity?.ok === false) {
      blockers.add(`${scope}_skills_reconcile_failed`)
      for (const warning of normalizeList(report.warnings)) warnings.add(`${scope}_skills:${warning}`)
    }
  }
  const legacyGenerationConvergence = skills?.convergence || null
  const legacyGenerationConvergenceRequired = input.require_legacy_generation_convergence === true
  if (legacyGenerationConvergenceRequired && legacyGenerationConvergence?.ok !== true) {
    blockers.add(legacyGenerationConvergence ? 'legacy_generation_convergence_failed' : 'legacy_generation_convergence_missing')
  }
  if (legacyGenerationConvergence?.ok === false) {
    blockers.add('legacy_generation_convergence_failed')
    for (const blocker of normalizeList(legacyGenerationConvergence.blockers)) {
      blockers.add(`legacy_generation:${blocker}`)
    }
    for (const warning of normalizeList(legacyGenerationConvergence.warnings)) {
      warnings.add(`legacy_generation:${warning}`)
    }
    if (legacyGenerationConvergence.retired_agent_roles?.ok === false) {
      blockers.add('retired_agent_role_reconcile_failed')
    }
    if (legacyGenerationConvergence.managed_configs?.ok === false) {
      blockers.add('managed_config_convergence_failed')
    }
    if (Array.isArray(legacyGenerationConvergence.retired_runtime_scopes)
      && legacyGenerationConvergence.retired_runtime_scopes.some((report: any) => report?.ok !== true)) {
      blockers.add('retired_runtime_scope_reconcile_failed')
    }
  }
  const repairReadiness = buildRepairReadiness(input)
  for (const blocker of repairReadiness.blockers) blockers.add(blocker)
  for (const warning of repairReadiness.warnings) warnings.add(warning)
  const localCollaborationPolicy = resolveLocalCollaborationPolicy({ mode: input.local_collaboration?.mode || null })
  const gptFinalAvailable = input.local_collaboration?.gpt_final_arbiter_available === undefined
    ? codexBinOk
    : input.local_collaboration.gpt_final_arbiter_available === true
  if (localCollaborationPolicy.gpt_final_required && !gptFinalAvailable) blockers.add('gpt_final_arbiter_unavailable')
  const routeBlockers = input.doctor_native_capability?.route_blockers || input.doctor_native_capability?.native_capabilities?.route_blockers || {}
  for (const [scope, list] of Object.entries(routeBlockers)) {
    for (const blocker of Array.isArray(list) ? list : []) {
      const value = `route:${scope}:${String(blocker)}`
      if (OPTIONAL_ROUTE_SCOPES.has(String(scope))) warnings.add(value)
      else blockers.add(value)
    }
  }

  const codexConfigNode = nodeRead.ok !== false && codexConfig.ok !== false
  const codexConfigChild = childRead.ok !== false && codexConfig.ok !== false
  const cliReady = codexBinOk && codexConfigNode && codexConfigChild && cliConfigOk
  const madReady = cliReady
  const nextActions = normalizeList(input.operator_actions || codexConfig.operator_actions)
  for (const [scope, list] of Object.entries(routeBlockers)) {
    for (const blocker of Array.isArray(list) ? list : []) nextActions.push(nextActionForRouteBlocker(String(scope), String(blocker)))
  }
  if (!nextActions.length && blockers.size) nextActions.push(...nextActionsForBlockers([...blockers]))
  if (input.codex_app_ui?.requires_confirmation === true) nextActions.push(input.codex_app_ui.next_action || 'Run `sks doctor --fix --repair-codex-app-ui` after reviewing the repair plan.')

  const managedStateCurrent = repairReadiness.ok && agentRoleConfig.ok !== false
  const coreReady = blockers.size === 0 && cliReady && managedStateCurrent
  const centerAttempted = input.sks_menubar?.apply === true
  const centerPhase = Array.isArray(input.doctor_fix_transaction?.phases)
    ? input.doctor_fix_transaction.phases.find((phase: any) => phase?.id === 'sks_menubar')
    : null
  const centerReady = input.sks_menubar?.ok === true
    && (!centerAttempted || !centerPhase || centerPhase.ok === true)
  const coreBlockers = [...blockers]
  const installCenterBlockers = normalizeList(input.sks_menubar?.blockers)
  const phaseCenterBlockers = normalizeList(centerPhase?.blockers)
  const centerBlockers = centerReady
    ? []
    : [
        ...installCenterBlockers,
        ...phaseCenterBlockers,
        ...(centerAttempted && !installCenterBlockers.length && !phaseCenterBlockers.length
          ? ['sks_center_repair_failed']
          : [])
      ]
  const commandBlockers = centerAttempted ? [...new Set([...coreBlockers, ...centerBlockers])] : coreBlockers
  const commandReady = coreReady && (!centerAttempted || centerReady)
  return {
    schema: DOCTOR_READINESS_MATRIX_SCHEMA,
    generated_at: nowIso(),
    cli_ready: cliReady,
    mad_ready: madReady,
    codex_config_readable_by_node: codexConfigNode,
    codex_config_readable_by_codex_cli: actualOk,
    codex_doctor: codexDoctor || null,
    codex_current_app_doctor: codexCurrentAppDoctor,
    codex_current_core_real_probes: codexCurrentCoreRealProbes,
    codex_plugin_inventory: input.codex_plugin_inventory || null,
    codex_plugin_app_template_policy: input.codex_plugin_app_template_policy || null,
    codex_app_harness_matrix: codexAppHarness,
    fast_mode_ready: input.fast_mode_ready !== false,
    codex_app_ui: input.codex_app_ui || null,
    sks_menubar: input.sks_menubar || null,
    hooks_ready: input.hooks_ready !== false,
    codex_app_ready: input.codex_app?.ok === true,
    codex_app_required_for_cli: false,
    managed_state_current: managedStateCurrent,
    core_ready: coreReady,
    center_attempted: centerAttempted,
    center_ready: centerReady,
    core_blockers: coreBlockers,
    center_blockers: [...new Set(centerBlockers)],
    optional_capabilities: buildOptionalCapabilities(input),
    repair_readiness: repairReadiness,
    local_collaboration: {
      mode: localCollaborationPolicy.mode,
      local_backend: input.local_collaboration?.local_backend || localModel.provider || 'ollama',
      local_model: input.local_collaboration?.local_model || localModel.model || null,
      final_arbiter: gptFinalAvailable ? 'GPT available' : 'missing',
      final_apply_allowed: localCollaborationPolicy.gpt_final_required ? gptFinalAvailable : localCollaborationPolicy.mode === 'disabled',
      blockers: localCollaborationPolicy.gpt_final_required && !gptFinalAvailable ? ['gpt_final_arbiter_unavailable'] : localCollaborationPolicy.blockers
    },
    local_llm: {
      enabled: localModel.enabled === true,
      status: localStatus,
      provider: localModel.provider || 'ollama',
      model: localModel.model || null,
      endpoint: localModel.endpoint || localModel.base_url || null,
      last_smoke: localModel.last_smoke || null,
      final_arbiter: 'GPT required',
      worker_tier_enabled: localModel.enabled === true && localStatus === 'verified',
      blockers: normalizeList(localModel.blockers)
    },
    agent_role_config: agentRoleConfig,
    skills,
    ready: commandReady,
    primary_blocker: commandBlockers[0] || null,
    blockers: commandBlockers,
    warnings: [...warnings],
    next_actions: nextActions
  }
}

function normalizeList(value: any) {
  return Array.isArray(value) ? value.filter(Boolean).map(String) : []
}

function buildRepairReadiness(input: any = {}) {
  const phases: Array<{
    id: string
    ok: boolean
    required_for_core_ready: boolean
    manual_required: boolean
    blockers: string[]
    warnings: string[]
  }> = []
  const add = (id: string, value: any, required = true) => {
    if (!value) return
    const ok = value.ok !== false && value.status !== 'blocked'
    phases.push({
      id,
      ok,
      required_for_core_ready: required,
      manual_required: value.manual_required === true || value.requires_confirmation === true,
      blockers: normalizeList(value.blockers),
      warnings: normalizeList(value.warnings)
    })
  }
  add('codex_startup_repair', input.codex_startup_repair, true)
  add('startup_config_repair', input.startup_config_repair, true)
  add('context7_repair', input.context7_repair, true)
  add('context7_mcp_repair', input.context7_mcp_repair, true)
  add('supabase_mcp_repair', input.supabase_mcp_repair, input.supabase_mcp_repair?.ready_blocking === true)
  add('sks_menubar', input.sks_menubar, false)
  add('command_alias_cleanup', input.command_aliases, true)
  const doctorNativeCapability = input.doctor_native_capability
  const nativeCoreBlockers = doctorNativeCapability && Array.isArray(doctorNativeCapability.core_blockers)
    ? normalizeList(doctorNativeCapability.core_blockers)
    : normalizeList(doctorNativeCapability?.blockers)
  add('native_capability_repair', doctorNativeCapability ? {
    ok: nativeCoreBlockers.length === 0,
    blockers: nativeCoreBlockers,
    warnings: doctorNativeCapability.optional_warnings
  } : null, false)
  const requireLegacyGlobalHookCleanup = input.require_legacy_global_hook_cleanup === true
  const legacyGlobalHooks = doctorNativeCapability?.legacy_global_hooks
  if (legacyGlobalHooks || requireLegacyGlobalHookCleanup) {
    const legacyGlobalHookBlockers = legacyGlobalHooks
      ? normalizeList(legacyGlobalHooks.blockers).map((blocker) => `legacy_global_hooks:${blocker}`)
      : ['legacy_global_hooks:cleanup_result_missing']
    phases.push({
      id: 'legacy_global_hook_cleanup',
      ok: legacyGlobalHooks?.ok === true && legacyGlobalHookBlockers.length === 0,
      required_for_core_ready: requireLegacyGlobalHookCleanup,
      manual_required: false,
      blockers: legacyGlobalHookBlockers,
      warnings: normalizeList(legacyGlobalHooks?.warnings)
    })
  }
  if (input.doctor_fix_transaction) {
    for (const phase of input.doctor_fix_transaction.phases || []) {
      phases.push({
        id: `transaction:${phase.id || 'unknown'}`,
        ok: phase.ok === true,
        required_for_core_ready: phase.required_for_ready !== false,
        manual_required: phase.manual_required === true,
        blockers: normalizeList(phase.blockers),
        warnings: normalizeList(phase.warnings)
      })
    }
  }
  if (input.doctor_fix_postcheck) {
    phases.push({
      id: 'doctor_fix_postcheck',
      ok: input.doctor_fix_postcheck.ok === true,
      required_for_core_ready: false,
      manual_required: input.doctor_fix_postcheck.manual_required === true || normalizeList(input.doctor_fix_postcheck.pending_manual).length > 0,
      blockers: normalizeList(input.doctor_fix_postcheck.required_blockers || input.doctor_fix_postcheck.blockers),
      warnings: [
        ...normalizeList(input.doctor_fix_postcheck.required_blockers || input.doctor_fix_postcheck.blockers).map((blocker) => `postcheck_pending:${blocker}`),
        ...normalizeList(input.doctor_fix_postcheck.optional_warnings),
        ...normalizeList(input.doctor_fix_postcheck.warnings)
      ]
    })
  }
  const blockers = phases
    .filter((phase) => phase.required_for_core_ready && !phase.ok)
    .flatMap((phase) => phase.blockers.length ? phase.blockers : [`doctor_required_phase_failed:${phase.id}`])
  const warnings = phases
    .filter((phase) => !phase.required_for_core_ready && !phase.ok)
    .flatMap((phase) => phase.blockers.length ? phase.blockers.map((blocker) => `optional:${blocker}`) : [`doctor_optional_phase_unready:${phase.id}`])
    .concat(phases.flatMap((phase) => phase.warnings))
  return {
    schema: 'sks.doctor-repair-readiness.v1',
    ok: blockers.length === 0,
    authoritative_probe: input.post_repair_codex_doctor ? 'post_repair_codex_doctor' : input.codex_doctor ? 'codex_doctor' : null,
    phases,
    blockers: [...new Set(blockers)],
    warnings: [...new Set(warnings)]
  }
}

function buildOptionalCapabilities(input: any = {}) {
  const nativeRows = Array.isArray(input.doctor_native_capability?.native_capabilities?.capabilities)
    ? input.doctor_native_capability.native_capabilities.capabilities
    : []
  const find = (id: string, fallback: 'verified' | 'manual_required' | 'unavailable') => {
    const row = nativeRows.find((entry: any) => entry?.id === id)
    if (!row) return fallback
    if (row.availability === 'verified' || row.after === 'verified' || row.before === 'verified' || row.ok === true || row.status === 'verified' || row.status === 'available') return 'verified'
    if (row.availability === 'manual-required' || row.manual_required === true || row.status === 'manual_required' || row.repairability === 'manual-required') return 'manual_required'
    return 'unavailable'
  }
  return {
    computer_use: find('computer_use', 'manual_required'),
    chrome_web_review: find('chrome_web_review', 'manual_required'),
    codex_app: input.codex_app?.ok === true ? 'verified' : 'optional_missing',
    route_blockers: input.doctor_native_capability?.route_blockers || input.doctor_native_capability?.native_capabilities?.route_blockers || {}
  }
}

function nextActionsForBlockers(blockers: string[]) {
  return blockers.map((blocker) => {
    if (blocker.includes('config')) return 'Review Codex config repair output, then rerun `sks doctor --fix --yes`.'
    if (blocker.includes('context7')) return 'Run `sks doctor --fix --yes` to migrate Context7 MCP to the managed remote transport.'
    if (blocker.includes('codex_doctor')) return 'Inspect the Codex Doctor section above; fix the listed blocker and rerun `sks doctor --fix --yes`.'
    if (blocker.includes('agent_role')) return 'Run `sks doctor --fix --yes` to refresh SKS-managed agent roles.'
    return `Resolve blocker: ${blocker}`
  })
}

function nextActionForRouteBlocker(scope: string, blocker: string) {
  if (scope === 'route-image') return `Repair image route capability (${blocker}): run \`sks doctor --fix --full --yes\`, then verify Codex App/image auth.`
  if (scope === 'route-computer-use') return `Computer Use route needs manual readiness (${blocker}); verify OS/App permissions before using that route.`
  if (scope === 'route-chrome-web-review') return `Chrome/web review route needs manual readiness (${blocker}); enable the Codex Chrome Extension before using signed-in browser review.`
  return `Resolve ${scope} route blocker: ${blocker}`
}
