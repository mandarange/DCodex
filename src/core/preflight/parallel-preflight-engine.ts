import path from 'node:path'
import { nowIso, writeJsonAtomic } from '../fsx.js'
import { buildCodexExecArgs } from '../codex/codex-cli-syntax-builder.js'
import { inspectCodexConfigReadability } from '../codex/codex-config-readability.js'
import { repairCodexConfigEperm } from '../codex/codex-config-eperm-repair.js'
import { splitCodexProjectConfigPolicy } from '../codex/codex-project-config-policy.js'
import { desktopBridgeStatusV3 } from '../codex-lb/desktop-controller-v3.js'

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
  // The native launch path exercises the real Codex profile after this preflight.
  // launchFast skips ONLY the live-codex probe;
  // all filesystem/permission/symlink/ACL/EPERM readability + repair checks still run, so
  // the EPERM/tcc_possible/EACCES blockers still fire for unreadable configs
  // (codex_cli_config_eperm is probe-only and intentionally not exercised on this path).
  const probeCodex = opts.launchFast === true ? false : opts.actualCodex !== false
  const readonly = await runParallelPreflight([
    { id: 'codex_config_readability', run: () => inspectCodexConfigReadability(root, { ...opts, codexProbe: probeCodex, actualCodex: probeCodex, writeReport: false }) },
    { id: 'codex_project_config_policy', run: () => splitCodexProjectConfigPolicy(root, { ...opts, writeReport: false }) },
    { id: 'desktop_bridge_status', run: () => inspectDesktopBridgeForLaunch(opts) }
  ])
  // A failed read-only preflight must not invoke the full repair inspector unless
  // the operator explicitly requested repair. The repair path re-runs readability
  // before and after its work; on macOS ACL/TCC failures those repeated 5s probes
  // used to compound into minute-scale `sks --mad` startup delays even though no
  // mutation was authorized. Keep the blocker from the first pass and fail fast.
  const repair = opts.fix === true
    ? await repairCodexConfigEperm(root, { ...opts, codexProbe: probeCodex, actualCodex: probeCodex, fix: true, writeReport: false })
    : null
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
  const blockers = [...new Set([...(readonly.blockers || []), ...(repair?.blockers || []), ...(fastTierProof.ok ? [] : ['service_tier_not_passed_to_codex'])])]
  const operatorActions = [...new Set([...(readonly.operator_actions || []), ...(repair?.operator_actions || [])])]
  const desktopBridgeStatus = readonly.results.find((result) => result.id === 'desktop_bridge_status')?.value || null
  const report = {
    schema: 'sks.mad-launch-preflight.v1',
    generated_at: nowIso(),
    root,
    ok: blockers.length === 0,
    readonly,
    repair,
    desktop_bridge_status: desktopBridgeStatus,
    fast_tier_proof: fastTierProof,
    blockers,
    operator_actions: operatorActions
  }
  if (opts.writeReport !== false) await writeJsonAtomic(reportPath, { ...report, report_path: reportPath })
  return report
}

export async function inspectDesktopBridgeForLaunch(opts: any = {}) {
  if (opts.skipDesktopBridgeStatus === true) {
    return {
      schema: 'sks.desktop-bridge-launch-preflight.v1',
      ok: true,
      status: 'skipped',
      managed: false,
      blockers: [],
      operator_actions: []
    }
  }
  const status = await (opts.desktopBridgeStatusImpl || desktopBridgeStatusV3)({
    ...opts,
    ...(opts.home || opts.codexHome ? { home: opts.home || opts.codexHome } : {})
  })
  const managed = status.management?.managed === true
  const ready = status.readiness?.ready === true
  const blockers = managed && !ready
    ? Array.isArray(status.readiness?.blockers)
      ? status.readiness.blockers.map(String).filter(Boolean)
      : ['desktop_bridge_not_ready']
    : []
  return {
    schema: 'sks.desktop-bridge-launch-preflight.v1',
    ok: !managed || ready,
    status: !managed ? 'not_managed' : ready ? 'ready' : 'blocked',
    managed,
    ready,
    correlation_id: status.correlation_id || null,
    blockers,
    operator_actions: managed && !ready && Array.isArray(status.recovery_actions)
      ? status.recovery_actions.map(String).filter(Boolean)
      : []
  }
}
