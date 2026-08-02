import path from 'node:path'
import { nowIso, writeJsonAtomic } from '../fsx.js'
import { buildCodexExecArgs } from '../codex/codex-cli-syntax-builder.js'
import { inspectCodexConfigReadability } from '../codex/codex-config-readability.js'
import { repairCodexConfigEperm } from '../codex/codex-config-eperm-repair.js'
import { splitCodexProjectConfigPolicy } from '../codex/codex-project-config-policy.js'
import { checkZellijCapability } from '../zellij/zellij-capability.js'
import { codexLbStatus } from '../../cli/install-helpers.js'
import { codexLbToolOutputRecoveryOverrideAcknowledged } from '../codex-lb/codex-lb-tool-output-recovery.js'

export const PARALLEL_PREFLIGHT_SCHEMA = 'sks.parallel-preflight.v1'

export async function runParallelPreflight(checks: Array<{ id: string; run: () => Promise<any> }>) {
  const startedAt = nowIso()
  const settled = await Promise.allSettled(checks.map((check) => check.run()))
  const results = settled.map((result, index) => ({
    id: checks[index]?.id || `check_${index}`,
    ok: result.status === 'fulfilled' && result.value?.ok !== false,
    status: result.status,
    value: result.status === 'fulfilled' ? result.value : null,
    error: result.status === 'rejected' ? String(result.reason?.message || result.reason) : null
  }))
  return {
    schema: PARALLEL_PREFLIGHT_SCHEMA,
    generated_at: nowIso(),
    started_at: startedAt,
    ok: results.every((result) => result.ok),
    results,
    blockers: results.flatMap((result: any) => result.value?.blockers || (result.ok ? [] : [`${result.id}_failed`])),
    operator_actions: [...new Set(results.flatMap((result: any) => result.value?.operator_actions || []))]
  }
}

export async function runCodexLaunchPreflight(rootInput: string = process.cwd(), opts: any = {}) {
  const root = path.resolve(rootInput || process.cwd())
  const reportPath = opts.reportPath || path.join(root, '.sneakoscope', 'reports', 'mad-launch-preflight.json')
  // On the interactive launch path the real codex profile is exercised the moment the
  // Zellij session opens, so spawning `codex exec` here (up to ~20s, and again inside
  // the repair re-inspections) is redundant. launchFast skips ONLY the live-codex probe;
  // all filesystem/permission/symlink/ACL/EPERM readability + repair checks still run, so
  // the EPERM/tcc_possible/EACCES blockers still fire for unreadable configs
  // (codex_cli_config_eperm is probe-only and intentionally not exercised on this path).
  const probeCodex = opts.launchFast === true ? false : opts.actualCodex !== false
  const readonly = await runParallelPreflight([
    { id: 'codex_config_readability', run: () => inspectCodexConfigReadability(root, { ...opts, codexProbe: probeCodex, actualCodex: probeCodex, writeReport: false }) },
    { id: 'codex_project_config_policy', run: () => splitCodexProjectConfigPolicy(root, { ...opts, writeReport: false }) },
    { id: 'codex_lb_tool_output_recovery', run: () => inspectCodexLbToolOutputRecoveryForLaunch(opts) }
  ])
  // A failed read-only preflight must not invoke the full repair inspector unless
  // the operator explicitly requested repair. The repair path re-runs readability
  // before and after its work; on macOS ACL/TCC failures those repeated 5s probes
  // used to compound into minute-scale `sks --mad` startup delays even though no
  // mutation was authorized. Keep the blocker from the first pass and fail fast.
  const repair = opts.fix === true
    ? await repairCodexConfigEperm(root, { ...opts, codexProbe: probeCodex, actualCodex: probeCodex, fix: true, writeReport: false })
    : null
  const providedZellijCapability = reusableZellijCapability(opts.zellijCapability, opts.requireZellij === true)
  const zellijCapability = opts.zellijCapability === false
    ? null
    : providedZellijCapability || await checkZellijCapability({ root, require: opts.requireZellij === true, writeReport: false })
  const codexArgs = buildCodexExecArgs({
    json: true,
    outputLastMessage: path.join(root, '.sneakoscope', 'reports', 'codex-preflight-output.json'),
    ephemeral: true,
    skipGitRepoCheck: true,
    profile: opts.profile || null,
    ignoreUserConfig: !opts.profile,
    ignoreRules: true,
    sandbox: opts.sandbox || 'workspace-write',
    serviceTier: opts.serviceTier || 'fast',
    prompt: 'SKS Codex launch preflight syntax proof only.'
  })
  const fastTierProof = {
    schema: 'sks.codex-fast-tier-cli-proof.v1',
    ok: codexArgs.includes('-c') && codexArgs.includes(`service_tier=${opts.serviceTier || 'fast'}`),
    service_tier: opts.serviceTier || 'fast',
    codex_args: codexArgs
  }
  const blockers = [...new Set([...(readonly.blockers || []), ...(repair?.blockers || []), ...(zellijCapability?.blockers || []), ...(fastTierProof.ok ? [] : ['service_tier_not_passed_to_codex'])])]
  const operatorActions = [...new Set([...(readonly.operator_actions || []), ...(repair?.operator_actions || []), ...(zellijCapability?.operator_actions || [])])]
  const codexLbToolOutputRecovery = readonly.results.find((result) => result.id === 'codex_lb_tool_output_recovery')?.value || null
  const report = {
    schema: 'sks.mad-launch-preflight.v1',
    generated_at: nowIso(),
    root,
    ok: blockers.length === 0,
    readonly,
    repair,
    zellij_capability: zellijCapability,
    codex_lb_tool_output_recovery: codexLbToolOutputRecovery,
    fast_tier_proof: fastTierProof,
    blockers,
    operator_actions: operatorActions
  }
  if (opts.writeReport !== false) await writeJsonAtomic(reportPath, { ...report, report_path: reportPath })
  return report
}

function reusableZellijCapability(value: any, requireZellij: boolean) {
  if (!value || value.schema !== 'sks.zellij-capability.v1' || typeof value.status !== 'string') return null
  if (requireZellij && value.status !== 'ok') return null
  return value
}

export async function inspectCodexLbToolOutputRecoveryForLaunch(opts: any = {}) {
  if (opts.skipCodexLbToolOutputRecovery === true) {
    return {
      schema: 'sks.codex-lb-launch-recovery-preflight.v1',
      ok: true,
      status: 'not_applicable',
      selected: false,
      blockers: [],
      operator_actions: []
    }
  }
  const allowUnverifiedToolOutputRecovery = opts.allowUnverifiedToolOutputRecovery === true
    || codexLbToolOutputRecoveryOverrideAcknowledged({ env: opts.env || process.env })
  const status = await codexLbStatus({
    ...opts,
    // Prefer an explicit fixture home (codexHome) so launch preflight tests do not
    // inherit the operator machine's selected codex-lb provider.
    ...(opts.home || opts.codexHome ? { home: opts.home || opts.codexHome } : {}),
    ...(opts.codexLbConfigPath ? { configPath: opts.codexLbConfigPath } : {}),
    ...(opts.codexLbEnvPath ? { envPath: opts.codexLbEnvPath } : {}),
    ...(typeof opts.codexLbToolOutputRecoveryFetch === 'function'
      ? { toolOutputRecoveryFetch: opts.codexLbToolOutputRecoveryFetch }
      : {}),
    ...(opts.codexLbToolOutputRecoveryTimeoutMs
      ? { toolOutputRecoveryTimeoutMs: opts.codexLbToolOutputRecoveryTimeoutMs }
      : {}),
    probeToolOutputRecovery: true,
    allowUnverifiedToolOutputRecovery
  })
  const recovery = status.tool_output_recovery
  const required = status.selected === true
  const providerReady = status.provider_ready === true
  const providerBlockers = Array.isArray(status.blockers)
    ? status.blockers.map(String).filter(Boolean)
    : []
  const ok = !required || (providerReady && recovery?.ok === true)
  return {
    schema: 'sks.codex-lb-launch-recovery-preflight.v1',
    ok,
    status: !required
      ? 'not_selected'
      : !providerReady
        ? providerBlockers[0] || 'provider_not_ready'
        : recovery?.status || 'version_unverified',
    selected: required,
    provider_ready: providerReady,
    base_url: status.base_url || null,
    tool_output_recovery: recovery || null,
    blockers: ok
      ? []
      : !providerReady
        ? providerBlockers.length > 0
          ? providerBlockers
          : ['codex_lb_provider_not_ready']
        : recovery?.blockers || ['codex_lb_tool_output_recovery_version_unverified'],
    operator_actions: ok ? [] : recovery?.operator_actions || [
      'Upgrade codex-lb, or run `sks codex-lb disable`; SKS will not change routing or authentication silently.'
    ]
  }
}
