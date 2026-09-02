import os from 'node:os';
import path from 'node:path';
import { projectRoot, exists, formatBytes, nowIso, readText, writeJsonAtomic } from '../core/fsx.js';
import { flag } from '../cli/args.js';
import { printJson } from '../cli/output.js';
import { ui as cliUi } from '../cli/cli-theme.js';
import { getCodexInfo } from '../core/codex-adapter.js';
import { rustInfo } from '../core/rust-accelerator.js';
import { codexAppIntegrationStatus } from '../core/codex-app.js';
import { desktopBridgeStatusV3 } from '../core/codex-lb/desktop-controller-v3.js';
import { readDesktopBridgeUnreachableUpstreamEvidence, repairDoctorDesktopBridgeCatalog } from '../core/doctor/desktop-bridge-catalog-repair.js';
import { inspectCodexConfigReadability } from '../core/codex/codex-config-readability.js';
import {
  inspectOAuthCallbackPortConflict,
  oauthCallbackDoctorGuidance
} from '../core/codex/oauth-callback-port-diagnostic.js';
import { inventoryCodexPermissionProfiles } from '../core/codex/codex-permission-profiles.js';
import { resolveProviderContext } from '../core/provider/provider-context.js';
import { writeCodexCurrentAppCapabilityArtifacts } from '../core/codex-control/codex-current-app-capability.js';
import { writeCodexPluginInventoryArtifacts, pluginAppTemplatePolicy } from '../core/codex-plugins/codex-plugin-json.js';
import { writeMcpPluginInventoryArtifacts } from '../core/mcp/mcp-plugin-inventory.js';
import { buildCodexAppHarnessMatrix } from '../core/codex-app/codex-app-harness-matrix.js';
import { buildCodexNativeFeatureMatrix } from '../core/codex-native/codex-native-feature-broker.js';
import { withSecretPreservationGuard } from '../core/config/config-migration-journal.js';
import { reconcileDoctorSkills } from '../core/doctor/doctor-skill-reconcile.js';
import { buildSksMenuBarDoctorPostcheck } from '../core/doctor/sks-menubar-doctor.js';
import { isUpdateMigrationReceiptCurrent, projectUpdateMigrationReceiptPath, writeProjectUpdateMigrationReceipt } from '../core/update/update-migration-state.js';
import { inspectSksMenuBarStatus, installSksMenuBar, sksMenuBarRestartDeferred } from '../core/codex-app/menubar/index.js';
import { sweepSksTempDirs } from '../core/retention.js';
import { detectImagegenCapability } from '../core/imagegen/imagegen-capability.js';
import { CURRENT_CODEX_RUNTIME_CONTRACT } from '../core/codex-compat/codex-runtime-contract.js';
import { formatHarnessConflictReport, scanHarnessConflicts } from '../core/harness-conflicts.js';
import {
  doctorArgWarnings as baseDoctorArgWarnings,
  doctorGlobalOnlySelection,
  doctorMenuBarInstallPolicy,
  doctorPhaseIdsForProfile,
  doctorProfileFromArgs,
  doctorProfileRequiresDesktopBridgeReadiness
} from './doctor-profile.js';
import { renderDoctorConsoleReport } from './doctor-console.js';
import {
  buildCodexAppUiDiagnosticFailure, buildRuntimeReadiness,
  captureCodexConfigSnapshot, deferredNativeRepair,
  doctorDedupeStatus, doctorSkillStatus,
  fallbackCodexNativeFeatureMatrix, formatCodexDoctorConsoleStatus,
  installScopeFromArgs, isMigrationUserOwnedProjectConfigBlocker,
  mergeObservedCodexStartupWarnings, nativeCapabilityStatus,
  readOption, rebootstrapSksMenuBarLaunchdForDoctorFix,
  sksMenuBarRunningVersionConsoleLines, uniqueNativeManualActions, writeFixMigrationJournal,
  writeJsonReportFile
} from './doctor-helpers.js';

export { doctorMenuBarInstallPolicy, doctorProfileFromArgs, doctorProfileRequiresDesktopBridgeReadiness } from './doctor-profile.js';
export {
  buildCodexAppUiDiagnosticFailure,
  buildRuntimeReadiness,
  formatCodexDoctorConsoleStatus,
  rebootstrapSksMenuBarLaunchdForDoctorFix,
  sksMenuBarRunningVersionConsoleLines
};

export function doctorArgWarnings(args: any[] = []): string[] {
  return baseDoctorArgWarnings(args);
}

// The Desktop Bridge repair itself lives in core so the project fix
// transaction, the global-only fix, and the update migration stage all execute
// the SAME code path; these re-exports keep the historical import surface.
export {
  CATALOG_REPAIR_MAX_ATTEMPTS,
  repairDoctorDesktopBridgeCatalog,
  restartStaleDesktopBridgeRuntime
} from '../core/doctor/desktop-bridge-catalog-repair.js';

export function deferCommandAliasCleanupToMigrationReceipt(result: any) {
  const observedBlockers = Array.isArray(result?.blockers)
    ? result.blockers.map(String).filter(Boolean)
    : [];
  return {
    ...result,
    ok: true,
    status: 'deferred_to_project_migration_receipt',
    fix: false,
    repair_owner: 'project_migration_receipt',
    pre_migration_blockers: observedBlockers,
    actions: [],
    blockers: [],
    warnings: [
      ...(Array.isArray(result?.warnings) ? result.warnings.map(String).filter(Boolean) : []),
      ...(observedBlockers.length ? [`pre_migration_public_surface_findings_deferred:${observedBlockers.length}`] : [])
    ]
  };
}

export async function inspectDoctorDesktopBridgeStatus(input: any = {}, deps: any = {}) {
  const processEnv: NodeJS.ProcessEnv = input.processEnv || process.env;
  const home = path.resolve(input.home || processEnv.HOME || os.homedir());
  try {
    const status = await (deps.desktopBridgeStatusImpl || desktopBridgeStatusV3)({
      home,
      env: processEnv
    });
    if (!status || typeof status !== 'object' || !status.providers || !status.readiness) {
      throw new Error('invalid Desktop Bridge status response');
    }
    const enabledProviders = Object.values(status.providers as Record<string, any>)
      .filter((provider: any) => provider?.enabled === true);
    // `management.managed` identifies the single supported runtime; it does not
    // mean that the user has configured an active provider. A fresh install must
    // remain a valid Doctor state until at least one bridge profile is enabled.
    const expected = enabledProviders.length > 0;
    const blockers = expected && status.readiness.ready !== true
      ? (status.readiness.blockers || []).map(String).filter(Boolean)
      : [];
    const recoveryActions = (status.recovery_actions || []).map(String).filter(Boolean);
    // Readiness is computed from cached diagnostics and never exercises the
    // upstream, so a serving bridge whose pinned upstream address went dead
    // after a network change reported green here for days. The bridge's own
    // log is the one durable trace of that state; read it (state file + log
    // tail, nothing live) so a plain doctor names the condition and `--fix`
    // has a reason to restart the service.
    if (expected && status.management?.managed === true) {
      const evidence = await (deps.desktopBridgeUpstreamEvidenceImpl || readDesktopBridgeUnreachableUpstreamEvidence)(home).catch(() => null);
      if (evidence) {
        blockers.push(`desktop_bridge_upstream_unreachable:${evidence.code}`);
        recoveryActions.push('Run `sks doctor --fix` (or `sks bridge repair`) to restart the Desktop Bridge and re-resolve its upstream address.');
      }
    }
    return {
      schema: 'sks.doctor-desktop-bridge.v1',
      ok: blockers.length === 0,
      read_only: true,
      credentials_mutated: false,
      managed: status.management?.managed === true,
      status,
      providers: status.providers,
      blockers,
      warnings: (status.readiness.warnings || []).map(String).filter(Boolean),
      recovery_actions: recoveryActions
    };
  } catch (error: unknown) {
    return {
      schema: 'sks.doctor-desktop-bridge.v1',
      ok: false,
      read_only: true,
      credentials_mutated: false,
      managed: null,
      status: null,
      providers: null,
      blockers: [`desktop_bridge_status_unavailable:${error instanceof Error ? error.message : String(error)}`],
      warnings: [],
      recovery_actions: ['Run `sks bridge status --json` to inspect Desktop Bridge provider readiness.']
    };
  }
}

export async function run(_command: any, args: any = [], deps: any = {}) {
  const root = await projectRoot();
  if (flag(args, '--search')) {
    const { buildSearchDoctorReport, printSearchDoctorReport } = await import('../core/search/doctor.js');
    const report = await buildSearchDoctorReport(args);
    printSearchDoctorReport(report, flag(args, '--json'));
    if (!report.ok) process.exitCode = 1;
    return report;
  }
  const doctorFix = flag(args, '--fix');
  const homeDir = path.resolve(deps.home || process.env.HOME || os.homedir());
  // `--fix` from the home directory reroutes to global-only repair: root
  // discovery never resolves home as a project, so the cwd fallback root IS
  // home there, and running project phases against it would misclassify the
  // user's home folder as an app project.
  const globalOnly = doctorGlobalOnlySelection({ args, doctorFix, root, home: homeDir }).global_only;
  if (doctorFix) {
    const conflictScan = await scanHarnessConflicts(root);
    if (conflictScan.hard_block) {
      const blocked = {
        schema: 'sks.doctor-status.v3',
        ok: false,
        status: 'blocked_harness_conflict',
        diagnostic_depth: 'fix',
        root,
        blockers: conflictScan.hard.map((item: any) => `${item.name || 'harness'}:${item.path}`),
        conflicts: conflictScan.conflicts,
        cleanup_prompt_command: 'sks conflicts cleanup --yes',
        no_fix_writes_performed: true
      };
      process.exitCode = 1;
      if (flag(args, '--json')) {
        printJson(blocked);
        return blocked;
      }
      console.error(formatHarnessConflictReport(conflictScan, { includePrompt: false }));
      console.error('Run `sks conflicts cleanup --yes` to quarantine OMX/DCodex markers before doctor --fix.');
      return blocked;
    }
  }
  const doctorProfile = doctorProfileFromArgs(args, doctorFix);
  if (!flag(args, '--json')) {
    cliUi.banner('doctor');
    cliUi.step(doctorFix ? 'repairing and validating' : 'validating');
  }
  if (!doctorFix && flag(args, '--json') && doctorProfile === 'fast') return runDoctorJsonFastPath(args, root);
  if (doctorFix) {
    const guardRoot = globalOnly ? homeDir : root;
    return withSecretPreservationGuard(guardRoot, 'doctor-fix', async () => (
      globalOnly
        ? runDoctorGlobalOnlyFix(args, root, deps)
        : runDoctor(args, root, doctorFix, deps)
    ));
  }
  return runDoctor(args, root, doctorFix, deps);
}

export async function executeDoctorGlobalOnlyFix(args: any[] = [], root: string, deps: any = {}) {
  const startedAtMs = Date.now();
  const home = path.resolve(deps.home || process.env.HOME || os.homedir());
  const reconcileSkillsImpl = deps.reconcileSkillsImpl
    || (await import('../core/init/skills.js')).reconcileSkills;
  const reconcileCurrentSurfaceImpl = deps.runDoctorCommandAliasCleanupImpl
    || (await import('../core/doctor/command-alias-cleanup.js')).runDoctorCommandAliasCleanup;
  const ensureGlobalFastModeImpl = deps.ensureGlobalCodexFastModeDuringInstallImpl
    || (await import('../cli/install-helpers.js')).ensureGlobalCodexFastModeDuringInstall;
  const installMenuBarImpl = deps.installSksMenuBarImpl || installSksMenuBar;
  const doctorEnv = deps.env || (deps.home
    ? { ...process.env, HOME: home }
    : process.env);
  const globalSkills = await reconcileSkillsImpl({
    targetDir: path.join(home, '.agents', 'skills'),
    scope: 'global',
    fix: true
  }).catch((err: any) => ({
    schema: 'sks.skill-reconcile.v1',
    scope: 'global',
    target_dir: path.join(home, '.agents', 'skills'),
    fix: true,
    error: err?.message || String(err),
    core_skill_integrity: { ok: false, installed_count: 0, restored_count: 0 }
  }));
  const currentSurface = await reconcileCurrentSurfaceImpl({
    root: home,
    home,
    globalRuntimeRoot: path.resolve(deps.globalRuntimeRoot || process.env.SKS_GLOBAL_ROOT || path.join(home, '.sneakoscope-global')),
    fix: true
  }).catch((err: any) => ({
    ok: false,
    blockers: [err?.message || String(err)]
  }));
  const globalFastMode = await ensureGlobalFastModeImpl({ home }).catch((err: any) => ({
    status: 'failed',
    error: err?.message || String(err)
  }));
  // The migration profile owns config/schema convergence only (the update flow
  // rebuilds and verifies the Menu Bar in its own stages right afterwards), so
  // it skips the Menu Bar install exactly like the project migration profile.
  const doctorProfile = doctorProfileFromArgs(args, true);
  const menuBarPolicy = doctorMenuBarInstallPolicy(args, true, doctorEnv);
  const menuBar = menuBarPolicy.phase_enabled
    ? await installMenuBarImpl({
      home,
      root: home,
      apply: true,
      launch: !sksMenuBarRestartDeferred(doctorEnv),
      env: doctorEnv,
      quiet: flag(args, '--json') || flag(args, '--machine-only')
    }).catch((err: any) => ({
      schema: 'sks.codex-app-sks-menubar.v1',
      ok: false,
      status: 'blocked',
      blockers: [err?.message || String(err)],
      warnings: []
    }))
    : {
      schema: 'sks.codex-app-sks-menubar.v1',
      ok: true,
      status: 'skipped_by_profile',
      skipped: true,
      blockers: [],
      warnings: [`sks_menubar_phase_skipped_for_profile:${doctorProfile}`]
    };
  // 9.0.2 routed home runs here and kept only the bridge STATUS read; the
  // repair (8.7.0 catalog sync with read-back verification, 8.6.6 stale-runtime
  // restart) only ran on the project path. The bridge is home-scoped global
  // state — every bridge path derives from HOME — so a home-rooted `--fix`
  // reported `codex_lb_catalog_stale` with the remedy `retry_catalog_sync`
  // while being the one fix run that never executed that remedy. Repair FIRST,
  // then read the status, so the report is the post-repair snapshot.
  const desktopBridgeRepairImpl = deps.desktopBridgeRepairImpl || repairDoctorDesktopBridgeCatalog;
  const desktopBridgeRepair: any = await desktopBridgeRepairImpl({ fix: true }).catch((err: any) => ({
    id: 'desktop_bridge_catalog_repair',
    ok: false,
    repaired: false,
    required_for_ready: false,
    manual_required: false,
    warnings: [],
    blockers: [`desktop_bridge_catalog_repair_failed:${err?.message || String(err)}`],
    rollback_evidence: 'combined_catalog_previous_generation_preserved'
  }));
  const desktopBridge = await inspectDoctorDesktopBridgeStatus({
    home,
    processEnv: doctorEnv
  }, { desktopBridgeStatusImpl: deps.desktopBridgeStatusImpl });
  const globalSkillsReady = !(globalSkills as any)?.error
    && (globalSkills as any)?.ok !== false
    && (globalSkills as any)?.core_skill_integrity?.ok !== false;
  const globalFastModeReady = (globalFastMode as any)?.status !== 'failed'
    && (globalFastMode as any)?.ok !== false;
  const menuBarReady = (menuBar as any)?.ok !== false;
  const migrationScopeBlockers = [...new Set([
    ...(!globalSkillsReady ? [`global_skills_reconcile_failed:${(globalSkills as any)?.error || 'core_skill_integrity'}`] : []),
    ...((currentSurface as any)?.ok !== true ? ((currentSurface as any)?.blockers || ['global_current_surface_reconcile_failed']) : []),
    ...(!globalFastModeReady ? [`global_fast_mode_repair_failed:${(globalFastMode as any)?.error || (globalFastMode as any)?.status || 'unknown'}`] : [])
  ].map(String).filter(Boolean))];
  const bridgeBlockers = [...new Set([
    ...((desktopBridgeRepair as any)?.ok === false
      ? ((desktopBridgeRepair as any)?.blockers?.length ? (desktopBridgeRepair as any).blockers : ['desktop_bridge_catalog_repair_failed'])
      : []),
    ...((desktopBridge as any).ok === false
      ? ((desktopBridge as any).blockers || ['desktop_bridge_unavailable'])
      : [])
  ].map(String).filter(Boolean))];
  // Same judgment as the project path: the migration profile never gates on
  // live bridge readiness, so its bridge findings demote to warnings and the
  // named follow-up below — otherwise the first update after a bridge outage
  // could never write a current receipt.
  const bridgeReadinessRequired = doctorProfileRequiresDesktopBridgeReadiness(doctorProfile);
  // A home-rooted migration doctor is how `sks update` runs from a non-project
  // directory. It still needs the migration receipt the update's
  // `project_receipt` stage verifies; home is the honest root for it (the
  // already-current update path writes the identical home-rooted receipt), and
  // the receipt's own stages carry the home/global-scoped migrations.
  let migrationReceipt: any = null;
  if (doctorProfile === 'migration') {
    const writeReceiptImpl = deps.writeProjectUpdateMigrationReceiptImpl || writeProjectUpdateMigrationReceipt;
    migrationReceipt = await writeReceiptImpl({
      root: home,
      source: `doctor-${doctorProfile}`,
      blockers: migrationScopeBlockers,
      warnings: ['global_only_home_scope_migration_receipt'],
      ...(migrationScopeBlockers.length ? { status: 'blocked' as const } : {})
    }).catch((err: any) => ({
      schema: 'sks.project-migration-receipt.v2',
      status: 'blocked',
      sks_version: null,
      root: home,
      source: `doctor-${doctorProfile}`,
      generated_at: new Date().toISOString(),
      blockers: [`migration_receipt_failed:${err?.message || String(err)}`],
      warnings: []
    }));
  }
  const migrationReceiptBlockers = migrationReceipt && !isUpdateMigrationReceiptCurrent(migrationReceipt)
    ? ((migrationReceipt.blockers || []).length ? migrationReceipt.blockers : ['global_migration_receipt_not_current'])
    : [];
  const blockers = [...new Set([
    ...migrationScopeBlockers,
    ...(!menuBarReady ? ((menuBar as any)?.blockers || ['sks_menubar_repair_failed']) : []),
    ...(bridgeReadinessRequired ? bridgeBlockers : []),
    ...migrationReceiptBlockers
  ].map(String).filter(Boolean))];
  const warnings = [...new Set([
    ...(!bridgeReadinessRequired ? bridgeBlockers.map((blocker) => `migration_optional_blocker:${blocker}`) : []),
    ...((desktopBridgeRepair as any)?.warnings || []),
    ...((desktopBridge as any)?.warnings || [])
  ].map(String).filter(Boolean))];
  const ok = blockers.length === 0;
  const projectRootAliasDetected = path.resolve(root) === home;
  return {
    schema: 'sks.doctor-status.v3',
    elapsed_ms: Date.now() - startedAtMs,
    ok,
    status: ok ? 'global_fix_ok' : 'blocked',
    diagnostic_depth: 'global-only',
    global_only: true,
    install_scope: 'global',
    doctor_profile: doctorProfile,
    root,
    home,
    project_root_alias_detected: projectRootAliasDetected,
    no_project_writes_performed: true,
    project_phases_skipped: [
      'project_skills_reconcile',
      'project_codex_config_repair',
      'project_context7_mcp_repair',
      'project_supabase_mcp_repair',
      'project_hook_trust_repair',
      'project_command_alias_cleanup',
      ...(migrationReceipt ? [] : ['project_migration_receipt'])
    ],
    skills: { global: globalSkills, project: { skipped: true, reason: 'global_only_doctor' } },
    current_public_surface: currentSurface,
    codex_app_fast_mode: globalFastMode,
    openrouter_provider: desktopBridge.providers?.openrouter || null,
    sks_menubar: menuBar,
    desktop_bridge_repair: desktopBridgeRepair,
    desktop_bridge: desktopBridge,
    ...(migrationReceipt ? { migration_receipt: migrationReceipt } : {}),
    blockers,
    warnings,
    next_actions: [
      ...(projectRootAliasDetected
        ? ['Project checks were skipped because this directory is your home folder. Run them from your project: cd <your-project> && sks doctor --fix']
        : []),
      ...((desktopBridge as any).ok === false ? (desktopBridge as any).recovery_actions || [] : []),
      ...(!bridgeReadinessRequired && bridgeBlockers.length
        ? ['Desktop Bridge still reports blockers: run `sks doctor --fix` to repair the bridge catalog.']
        : []),
      'Run `sks doctor --fix --json` from a specific project directory when project-scoped repair is required.'
    ]
  };
}

async function runDoctorGlobalOnlyFix(args: any[] = [], root: string, deps: any = {}) {
  const result = await executeDoctorGlobalOnlyFix(args, root, deps);
  const reportFile = readOption(args, '--report-file', null);
  if (reportFile) await writeJsonReportFile(reportFile, result);
  if (flag(args, '--machine-only') && !flag(args, '--json')) {
    if (!result.ok) process.exitCode = 1;
    return result;
  }
  if (flag(args, '--json')) {
    printJson(result);
  } else {
    const bridgeRepair: any = (result as any).desktop_bridge_repair;
    console.log(`SKS Doctor global repair: ${result.ok ? 'ok' : 'blocked'}`);
    console.log(`Global skills: ${(result.skills.global as any)?.error ? 'blocked' : 'reconciled'}`);
    console.log(`SKS menu bar: ${(result.sks_menubar as any)?.status || ((result.sks_menubar as any)?.ok ? 'ok' : 'blocked')}`);
    console.log(`Desktop Bridge repair: ${
      bridgeRepair?.skipped_reason
        ? bridgeRepair.skipped_reason
        : bridgeRepair?.repaired
          ? 'repaired'
          : bridgeRepair?.ok === false ? 'failed' : 'nothing_to_repair'
    }`);
    console.log(`Desktop Bridge: ${result.desktop_bridge.ok ? 'ready' : 'blocked'} (${result.desktop_bridge.status?.readiness?.state || 'unavailable'})`);
    if ((result as any).migration_receipt) {
      console.log(`Migration receipt: ${(result as any).migration_receipt.status} (${(result as any).home})`);
    }
    for (const blocker of result.blockers) console.log(`- blocker: ${blocker}`);
    for (const action of result.next_actions) console.log(`- ${action}`);
  }
  if (!result.ok) process.exitCode = 1;
  return result;
}

async function runDoctorJsonFastPath(args: any = [], root: string) {
  const startedAtMs = Date.now();
  const reportFile = readOption(args, '--report-file', null);
  const codexBin = readOption(args, '--codex-bin', process.env.SKS_DOCTOR_CODEX_BIN || '');
  const configProbeOpts = {
    codexProbe: false,
    actualCodex: false,
    requireActualCodex: false,
    codexBin: codexBin || undefined
  };
  const [codex, rust, codexConfig, sneakoscopeExists, oauthCallbackPortDiagnostic, desktopBridge] = await Promise.all([
    codexBin
      ? Promise.resolve({ bin: codexBin, version: 'fixture-or-explicit', available: true })
      : getCodexInfo().catch(() => ({ bin: null, version: null, available: false })),
    rustInfo().catch((err: any) => ({ available: false, mode: 'js_fallback', status: 'error', version: null, error: err.message })),
    inspectCodexConfigReadability(root, configProbeOpts).catch((err: any) => ({
      ok: false,
      checks: [],
      operator_actions: [],
      blockers: [err?.message || String(err)]
    })),
    exists(`${root}/.sneakoscope`),
    inspectOAuthCallbackPortConflict(),
    inspectDoctorDesktopBridgeStatus({ processEnv: process.env })
  ]);
  const oauthCallbackOperatorActions = oauthCallbackDoctorGuidance(oauthCallbackPortDiagnostic);
  const ready = {
    schema: 'sks.doctor-readiness-matrix.v2',
    generated_at: nowIso(),
    ready: Boolean(codexConfig?.ok),
    cli_ready: Boolean(codexConfig?.ok),
    mad_ready: false,
    managed_state_current: sneakoscopeExists,
    codex_config_readable_by_node: Boolean(codexConfig?.ok),
    codex_config_readable_by_codex_cli: false,
    codex_app_ready: false,
    primary_blocker: codexConfig?.ok ? null : 'codex_config_unreadable',
    blockers: codexConfig?.ok ? [] : ['codex_config_unreadable'],
    next_actions: codexConfig?.ok ? [] : ['Run `sks doctor --fix --json` to repair managed config.']
  };
  const codexNativeFeatureMatrix = fallbackCodexNativeFeatureMatrix(codex, [], ['native_feature_matrix_deferred_to_full_doctor_or_route_gate']);
  const runtimeReadiness = buildRuntimeReadiness(codexNativeFeatureMatrix);
  const deferredImagegen = deferredNativeRepair('sks.doctor-imagegen-repair.v1', false, [
    'Run `sks doctor --fix --repair-native-capabilities --json` after enabling Codex App image_generation.'
  ]);
  const deferredComputerUse = deferredNativeRepair('sks.doctor-computer-use-repair.v1', false, [
    'Computer Use route needs manual OS/App permission verification before use.'
  ]);
  const deferredBrowserUse = deferredNativeRepair('sks.doctor-browser-use-repair.v1', false, [
    'Chrome/web review route needs the Codex Chrome Extension enabled before use.'
  ]);
  const desktopBridgeReady = (desktopBridge as any).ok !== false;
  const result = {
    schema: 'sks.doctor-status.v3',
    elapsed_ms: Date.now() - startedAtMs,
    ok: desktopBridgeReady,
    status: desktopBridgeReady ? 'fast_readonly_ok' : 'blocked',
    diagnostic_depth: 'fast',
    deep_diagnostics_skipped: true,
    deep_ok: null,
    not_counted_as_full_doctor: true,
    next_actions: [
      'Run sks doctor --full --json for deep diagnostics.',
      ...((desktopBridge as any).ok === false ? (desktopBridge as any).recovery_actions || [] : [])
    ],
    root,
    fast_path: true,
    no_fix_write_policy: reportFile ? 'report_file_only' : 'no_writes_performed',
    arg_warnings: doctorArgWarnings(args),
    warnings: [...oauthCallbackPortDiagnostic.warnings],
    operator_actions: [
      ...oauthCallbackOperatorActions,
      ...((desktopBridge as any).ok === false ? (desktopBridge as any).recovery_actions || [] : [])
    ],
    node: { ok: Number(process.versions.node.split('.')[0]) >= 20, version: process.version },
    codex,
    oauth_callback_port_diagnostic: oauthCallbackPortDiagnostic,
    codex_config: codexConfig,
    rust,
    codex_app: { ok: false, skipped: true, warnings: ['codex_app_optional_diagnostic_skipped'] },
    codex_app_ui: {
      schema: 'sks.codex-app-fast-ui-repair.v1',
      ok: true,
      apply: false,
      skipped: true,
      actions: [],
      blockers: [],
      warnings: ['codex_app_ui_repair_deferred']
    },
    sks_menubar: {
      schema: 'sks.codex-app-sks-menubar.v1',
      ok: true,
      apply: false,
      status: 'skipped_fast_path',
      actions: [],
      blockers: [],
      warnings: ['menubar_install_deferred_to_fix_or_full_doctor']
    },
    provider_context: {
      schema: 'sks.provider-context.v2',
      generated_at: nowIso(),
      provider: 'unknown',
      auth_mode: 'unknown',
      route: '$Doctor',
      service_tier: process.env.SKS_SERVICE_TIER || 'fast',
      source: 'unknown',
      confidence: 'low',
      conflict: false,
      warnings: ['provider_context_optional_diagnostic_skipped'],
      signals: {
        openai_api_key_present: false,
        codex_app_auth_present: false,
        desktop_bridge_status_available: false,
        desktop_bridge_managed: false,
        desktop_bridge_ready: false,
        desktop_bridge_provider: null,
        desktop_bridge_native_identity_configured: false,
        desktop_bridge_credential_state: null
      }
    },
    desktop_bridge: desktopBridge,
    codex_doctor: null,
    pre_repair_codex_doctor: null,
    post_repair_codex_doctor: null,
    codex_doctor_diff: null,
    observational_codex_doctor_diff: null,
    context7_repair: { schema: 'sks.doctor-context7-repair.v1', ok: true, fix: false, skipped: true, actions: [], blockers: [], warnings: ['context7_repair_deferred_to_fix'] },
    codex_startup_repair: { schema: 'sks.doctor-codex-startup-repair.v1', ok: true, fix: false, skipped: true, actions: [], blockers: [], warnings: ['codex_startup_repair_deferred_to_fix'] },
    startup_config_repair: null,
    context7_mcp_repair: null,
    supabase_mcp_repair: null,
    doctor_fix_transaction: null,
    doctor_fix_postcheck: null,
    postcheck: null,
    agent_role_config: { schema: 'sks.agent-role-config-repair.v1', ok: true, apply: false, skipped: true, blockers: [] },
    codex_permission_profiles: { skipped: true, reason: 'doctor_json_fast_path_optional_diagnostics_skipped' },
    command_aliases: { schema: 'sks.command-alias-cleanup.v1', ok: true, skipped: true, reason: 'doctor_json_fast_path_no_write' },
    sks_temp_sweep: { ok: true, skipped: true, action_count: 0, reason: 'doctor_without_fix', error: null },
    imagegen: { ok: false, auth_readiness: null, codex_app_builtin_available: false },
    imagegen_repair: deferredImagegen,
    codex_current_app: { capability: null, doctor: { schema: 'sks.codex-current-app-doctor.v1', ok: true, skipped: true, blockers: [], warnings: ['historical_codex_current_app_doctor_skipped'] }, plugins: null, plugin_app_template_policy: null, mcp_plugin_inventory: null },
    codex_app_harness_matrix: { schema: 'sks.codex-app-harness-matrix.v1', ok: true, skipped: true, app_features: {}, sks_integrations: {}, blockers: [], warnings: ['codex_app_harness_optional_diagnostic_skipped'] },
    codex_native_feature_matrix: codexNativeFeatureMatrix,
    runtime_readiness: runtimeReadiness,
    ready,
    sneakoscope: { ok: sneakoscopeExists },
    package: { bytes: 0, human: formatBytes(0) },
    skills: { skipped: true, reason: 'doctor_without_fix' },
    repair: {
      sks_update: null,
      setup: null,
      codex_config: null,
      migration_journal: null,
      global_sks_installs: null,
      agent_role_config: null,
      context7: null,
      codex_startup: null,
      startup_config: null,
      context7_mcp: null,
      supabase_mcp: null,
      mcp_transport_collision: null,
      imagegen: deferredImagegen,
      computer_use: deferredComputerUse,
      browser_use: deferredBrowserUse,
      hook_trust: null,
      sks_menubar: null,
      doctor_transaction: null,
      doctor_dirty_plan: null,
      doctor_postcheck: null,
      codex_native: null,
      doctor_native_capability: null,
      command_aliases: null,
      skills: { skipped: true, reason: 'doctor_without_fix' },
      sks_temp_sweep: { ok: true, skipped: true, reason: 'doctor_without_fix', actions: [] }
    }
  };
  if (reportFile) await writeJsonReportFile(reportFile, result);
  printJson(result);
  if (!result.ok) process.exitCode = 1;
  return result;
}

async function runDoctor(args: any = [], root: string, doctorFix: boolean, deps: any = {}) {
  const startedAtMs = Date.now();
  const oauthCallbackPortDiagnostic = await inspectOAuthCallbackPortConflict();
  const oauthCallbackOperatorActions = oauthCallbackDoctorGuidance(oauthCallbackPortDiagnostic);
  const sksTempSweep = doctorFix ? await sweepSksTempDirs(root, { maxAgeHours: 24 }).catch((err: any) => ({
    ok: false,
    error: err?.message || String(err),
    actions: []
  })) : { ok: true, skipped: true, reason: 'doctor_without_fix', actions: [] };
  const doctorProfile = doctorProfileFromArgs(args, doctorFix);
  const machineOnly = flag(args, '--machine-only');
  const reportFile = readOption(args, '--report-file', null);
  const argWarnings = doctorArgWarnings(args);
  const deepDiagnostics = doctorProfile === 'full' || doctorProfile === 'capabilities';
  const codexBin = readOption(args, '--codex-bin', process.env.SKS_DOCTOR_CODEX_BIN || '');
  const actualCodexProbeRequested = flag(args, '--actual-codex') || flag(args, '--require-actual-codex') || Boolean(codexBin);
  const actualCodexProbeEnabled = deepDiagnostics || actualCodexProbeRequested;
  const requireActualCodexProbe = flag(args, '--require-actual-codex') || (deepDiagnostics && doctorFix);
  const shouldEvaluateCodexAppUiRepair = doctorFix || deepDiagnostics || flag(args, '--repair-codex-app-ui');
  const nativeCapabilityDiagnosticsRequested = deepDiagnostics || flag(args, '--repair-native-capabilities');
  const requireLegacyGlobalHookCleanup = doctorFix && doctorProfile === 'migration';
  // Migration Doctor has one mutation owner: the project migration receipt.
  // Its structured stages reconcile skills and hook trust exactly once.
  const migrationReceiptOwnsReconcile = doctorFix && doctorProfile === 'migration';
  const doctorPhaseIds = doctorPhaseIdsForProfile(doctorProfile);
  const { runDoctorCommandAliasCleanup } = await import('../core/doctor/command-alias-cleanup.js');
  const { runDoctorNativeCapabilityRepair } = await import('../core/doctor/doctor-native-capability-repair.js');
  const { runDoctorCodexStartupRepair } = await import('../core/doctor/doctor-codex-startup-repair.js');
  const { runDoctorContext7Repair } = await import('../core/doctor/doctor-context7-repair.js');
  const { compareCodexDoctorBridge, runCodexDoctorBridge } = await import('../core/doctor/codex-doctor-bridge.js');
  const { repairCodexAppFastUi } = await import('../core/codex-app/codex-app-fast-ui-repair.js');
  const { repairAgentRoleConfigs } = await import('../core/agents/agent-role-config.js');
  const { runCodexCurrentAppDoctor } = await import('../core/doctor/codex-current-app-doctor.js');
  const { writeDoctorReadinessMatrix } = await import('../core/doctor/doctor-readiness-matrix.js');
  const doctorDirtyPlan = doctorFix ? (await import('../core/doctor/doctor-dirty-planner.js')).planDoctorDirtyRepair(root, doctorPhaseIds) : null;
  let setupRepair = null;
  let sksUpdate: any = null;
  const openRouterProviderRepair: any = {
    ok: true,
    status: 'read_only',
    reason: 'Desktop Bridge owns provider credentials; Doctor does not migrate them.'
  };
  let migrationPreFix: Record<string, string | null> | null = null;
  if (doctorFix) {
    migrationPreFix = await captureCodexConfigSnapshot();
    const installScope = installScopeFromArgs(args);
    setupRepair = {
      schema: 'sks.doctor-setup-phase.v2',
      ok: true,
      status: 'semantic_dirty_plan_only',
      reason: 'setup_force_removed_from_doctor_hot_path',
      profile: doctorProfile,
      install_scope: installScope,
      config_backup_path: null,
      global_skills: installScope === 'global' && !flag(args, '--local-only')
        ? deepDiagnostics ? await (await import('../cli/install-helpers.js')).ensureGlobalCodexSkillsDuringInstall({ force: true }) : { status: 'skipped', reason: 'default_doctor_no_global_skill_regeneration' }
        : { status: 'skipped', reason: 'project or local-only repair' },
      codex_app_fast_mode: flag(args, '--local-only')
        ? { status: 'skipped', reason: 'local-only repair' }
        : await (await import('../cli/install-helpers.js')).ensureGlobalCodexFastModeDuringInstall().catch((err: any) => ({ status: 'failed', error: err?.message || String(err) })),
      openrouter_provider: openRouterProviderRepair
    };
  }
  const skillsReconcile = await reconcileDoctorSkills(root, doctorFix && !migrationReceiptOwnsReconcile);
  const managedGenerationConvergence = doctorFix && !migrationReceiptOwnsReconcile
    ? (skillsReconcile as any)?.convergence || null
    : null;
  const inspectCommandAliasCleanup = (
    fix: boolean,
    convergence: any = null,
    managedGenerationAlreadyConverged = false
  ) => runDoctorCommandAliasCleanup({
    root,
    fix,
    managedGenerationAlreadyConverged,
    ...(convergence ? { managedGenerationConvergence: convergence } : {})
  }).catch((err: any) => ({
    schema: 'sks.command-alias-cleanup.v1',
    ok: false,
    status: 'blocked',
    root,
    fix,
    report_path: `${root}/.sneakoscope/reports/command-alias-cleanup.json`,
    canonical_command_count: 0,
    current_alias_count: 0,
    detected: { registered_alias_commands: [], catalog_alias_rows: [], missing_canonical_targets: [] },
    actions: [],
    blockers: [err?.message || String(err)]
  }));
  let commandAliasCleanup = await inspectCommandAliasCleanup(
    doctorFix && !migrationReceiptOwnsReconcile,
    managedGenerationConvergence
  );
  const commandAliasCleanupBeforeReceipt = migrationReceiptOwnsReconcile
    ? deferCommandAliasCleanupToMigrationReceipt(commandAliasCleanup)
    : commandAliasCleanup;
  const doctorNativeCapabilityRepair = await runDoctorNativeCapabilityRepair({
    root,
    fix: nativeCapabilityDiagnosticsRequested && doctorFix,
    yes: flag(args, '--yes') || flag(args, '-y'),
    flags: args.map((arg: any) => String(arg)),
    skipNativeCapabilities: !nativeCapabilityDiagnosticsRequested,
    requireLegacyGlobalHookCleanup
  }).catch((err: any) => ({
    schema: 'sks.doctor-native-capability-repair.v1',
    ok: false,
    root,
    fix: doctorFix,
    yes: flag(args, '--yes') || flag(args, '-y'),
    core_skills: null,
    skill_dedupe: null,
    native_capabilities: null,
    legacy_global_hooks: {
      ok: false,
      blockers: [`cleanup_failed_before_report:${err?.message || String(err)}`],
      warnings: []
    },
    secret_preservation_guard: '.sneakoscope/reports/secret-preservation-guard.json',
    core_blockers: [err?.message || String(err)],
    route_blockers: {},
    optional_manual_required: [],
    optional_warnings: [],
    required_blockers: requireLegacyGlobalHookCleanup
      ? [`legacy_global_hooks:cleanup_failed_before_report:${err?.message || String(err)}`]
      : [],
    blockers: [err?.message || String(err)]
  }));
  const configProbeOpts = {
    codexProbe: actualCodexProbeEnabled,
    actualCodex: actualCodexProbeEnabled,
    requireActualCodex: requireActualCodexProbe,
    codexBin: codexBin || undefined
  };
  let codexStartupRepair = await runDoctorCodexStartupRepair({ root, fix: doctorFix }).catch((err: any) => ({
    schema: 'sks.doctor-codex-startup-repair.v1',
    ok: false,
    generated_at: new Date().toISOString(),
    fix: doctorFix,
    configs: [],
    agent_role_files: { sanitized: [], created: [], blockers: [err?.message || String(err)] },
    actions: [],
    manual_actions: [],
    blockers: [err?.message || String(err)],
    warnings: [],
    report_path: `${root}/.sneakoscope/reports/doctor-codex-startup-repair.json`
  }));
  const codexDoctorBefore = flag(args, '--fix') && deepDiagnostics ? await runCodexDoctorBridge({ codexBin: codexBin || null, cwd: root, required: flag(args, '--require-actual-codex') }).catch(() => null) : null;
  const configRepair = flag(args, '--fix') ? await (await import('../core/codex/codex-config-eperm-repair.js')).repairCodexConfigEperm(root, { fix: true, ...configProbeOpts }) : null;
  const migrationJournal = flag(args, '--fix')
    ? await writeFixMigrationJournal(root, migrationPreFix, configRepair, setupRepair).catch(() => null)
    : null;
  let codexConfig = configRepair?.after || await inspectCodexConfigReadability(root, configProbeOpts);
  const preRepairCodexDoctor = deepDiagnostics || flag(args, '--require-actual-codex')
    ? await runCodexDoctorBridge({ codexBin: codexBin || null, cwd: root, required: flag(args, '--require-actual-codex') })
    : null;
  const codexDoctorDiff = compareCodexDoctorBridge(codexDoctorBefore, preRepairCodexDoctor);
  codexStartupRepair = mergeObservedCodexStartupWarnings(codexStartupRepair, preRepairCodexDoctor);
  const codexConfigSyntaxRepair = doctorPhaseIds.includes('codex_config_syntax_repair')
    ? await (await import('../core/doctor/codex-config-syntax-repair.js')).runCodexConfigSyntaxRepair({ root, fix: doctorFix }).catch((err: any) => ({
      schema: 'sks.codex-config-syntax-repair.v1',
      ok: false,
      generated_at: new Date().toISOString(),
      fix: doctorFix,
      configs: [],
      actions: [],
      manual_actions: [],
      blockers: [err?.message || String(err)],
      warnings: [],
      report_path: `${root}/.sneakoscope/reports/codex-config-syntax-repair.json`
    }))
    : null;
  const codex = codexBin
    ? { bin: codexBin, version: 'fixture-or-explicit', available: true }
    : await getCodexInfo().catch(() => ({ bin: null, version: null, available: false }));
  const rust: any = await rustInfo().catch((err: any) => ({
    available: false,
    mode: 'js_fallback',
    status: 'error',
    version: null,
    error: err.message
  }));
  const codexApp = deepDiagnostics
    ? await codexAppIntegrationStatus({ codex }).catch((err: any) => ({ ok: false, error: err.message }))
    : { ok: false, skipped: true, warnings: ['codex_app_optional_diagnostic_skipped'] };
  // Only the BEFORE picture: a `--fix` run repairs the bridge inside the
  // transaction further down, and `desktopBridge` is re-read once that closes.
  const desktopBridgeBeforeFix = await inspectDoctorDesktopBridgeStatus({
    processEnv: process.env
  }, { desktopBridgeStatusImpl: deps.desktopBridgeStatusImpl });
  const providerContext = deepDiagnostics
    ? await resolveProviderContext({ root, route: '$Doctor', serviceTier: process.env.SKS_SERVICE_TIER || 'fast' }).catch((err: any) => ({
        schema: 'sks.provider-context.v2',
        generated_at: new Date().toISOString(),
        provider: 'unknown',
        auth_mode: 'unknown',
        route: '$Doctor',
        service_tier: 'unknown',
        source: 'unknown',
        confidence: 'low',
        conflict: false,
        warnings: [err?.message || String(err)],
        signals: {
          openai_api_key_present: false,
          codex_app_auth_present: false,
          desktop_bridge_status_available: false,
          desktop_bridge_managed: false,
          desktop_bridge_ready: false,
          desktop_bridge_provider: null,
          desktop_bridge_native_identity_configured: false,
          desktop_bridge_credential_state: null
        }
      }))
    : {
        schema: 'sks.provider-context.v2',
        generated_at: new Date().toISOString(),
        provider: 'unknown',
        auth_mode: 'unknown',
        route: '$Doctor',
        service_tier: process.env.SKS_SERVICE_TIER || 'fast',
        source: 'unknown',
        confidence: 'low',
        conflict: false,
        warnings: ['provider_context_optional_diagnostic_skipped'],
        signals: {
          openai_api_key_present: false,
          codex_app_auth_present: false,
          desktop_bridge_status_available: false,
          desktop_bridge_managed: false,
          desktop_bridge_ready: false,
          desktop_bridge_provider: null,
          desktop_bridge_native_identity_configured: false,
          desktop_bridge_credential_state: null
        }
      };
  const explicitCodexAppUiRepair = flag(args, '--repair-codex-app-ui');
  const codexAppUiPlan = shouldEvaluateCodexAppUiRepair
    ? await repairCodexAppFastUi(root, {
        apply: false,
        reportPath: `${root}/.sneakoscope/reports/codex-app-fast-ui-repair-plan.json`
      }).catch((err: unknown) => buildCodexAppUiDiagnosticFailure(false, err))
    : {
        schema: 'sks.codex-app-fast-ui-repair.v1',
        ok: true,
        apply: false,
        skipped: true,
        safe_auto_apply: false,
        requires_confirmation: false,
        fast_selector: 'skipped_optional',
        provider_selector: 'skipped_optional',
        host_owned_config: 'not_inspected',
        next_action: 'Run `sks doctor --fix --repair-codex-app-ui` for Codex App UI repair.',
        actions: [],
        blockers: [],
        warnings: ['codex_app_ui_repair_deferred']
      };
  const shouldApplyCodexAppUiRepair = shouldEvaluateCodexAppUiRepair && doctorFix && (
    explicitCodexAppUiRepair ||
    codexAppUiPlan.safe_auto_apply === true
  );
  const codexAppUi = shouldApplyCodexAppUiRepair
    ? await repairCodexAppFastUi(root, {
        apply: true,
        force: explicitCodexAppUiRepair,
        reportPath: `${root}/.sneakoscope/reports/codex-app-fast-ui-repair.json`
      }).catch((err: unknown) => buildCodexAppUiDiagnosticFailure(true, err))
    : codexAppUiPlan;
  const menuBarPolicy = doctorMenuBarInstallPolicy(args, doctorFix, process.env);
  const menuBarLaunchRequested = menuBarPolicy.launch;
  const sksMenuBar = await installSksMenuBar({
    root,
    apply: menuBarPolicy.apply,
    launch: menuBarLaunchRequested,
    env: process.env,
    quiet: machineOnly || flag(args, '--json')
  }).catch((err: any) => ({
    schema: 'sks.codex-app-sks-menubar.v1',
    ok: false,
    apply: menuBarPolicy.apply,
    status: 'blocked',
    platform: process.platform,
    app_path: null,
    executable_path: null,
    launch_agent_path: null,
    action_script_path: null,
    build_stamp_path: null,
    report_path: `${root}/.sneakoscope/reports/sks-menubar.json`,
    menu_items: [],
    actions: [],
    launch: { requested: menuBarLaunchRequested, method: 'none', ok: false, error: err?.message || String(err) },
    tcc_automation_status: 'unknown',
    next_actions: [
      'Run: sks menubar status',
      'Run: sks menubar install',
      'Run: sks menubar restart',
    ],
    blockers: [err?.message || String(err)],
    warnings: []
  }));
  const context7Repair = await runDoctorContext7Repair({ root, fix: doctorFix }).catch((err: any) => ({
    schema: 'sks.doctor-context7-repair.v1',
    ok: false,
    generated_at: new Date().toISOString(),
    fix: doctorFix,
    preferred_transport: 'remote',
    configs: [],
    actions: [],
    blockers: [err?.message || String(err)],
    warnings: [],
    report_path: `${root}/.sneakoscope/reports/doctor-context7-repair.json`
  }));
  const startupConfigRepair = doctorFix
    ? await (await import('../core/doctor/codex-startup-config-repair.js')).repairCodexStartupConfig({ root, apply: true }).catch((err: any) => ({
        schema: 'sks.codex-startup-config-repair.v1',
        ok: false,
        apply: true,
        blockers: [err?.message || String(err)]
      }))
    : null;
  const context7McpRepair = doctorFix
    ? await (await import('../core/doctor/context7-mcp-repair.js')).repairContext7Mcp({ root, apply: true }).catch((err: any) => ({
        schema: 'sks.doctor-context7-mcp-repair.v1',
        ok: false,
        apply: true,
        repaired: false,
        manual_required: false,
        blockers: [err?.message || String(err)],
        warnings: []
      }))
    : null;
  const supabaseMcpRepair = doctorFix && doctorPhaseIds.includes('supabase_mcp_repair')
    ? await (await import('../core/doctor/supabase-mcp-repair.js')).repairSupabaseMcp({ root, apply: true }).catch((err: any) => ({
        schema: 'sks.doctor-supabase-mcp-repair.v1',
        ok: false,
        apply: true,
        configured: false,
        disabled: false,
        disabled_preserved: false,
        token_env_present: false,
        unsafe_write_access: false,
        read_only_migrated: false,
        write_scope_requires_confirmation: false,
        ready_blocking: true,
        manual_required: true,
        next_action: 'Review Supabase MCP configuration manually.',
        blockers: [err?.message || String(err)],
        warnings: [],
        raw_secret_values_recorded: false
      }))
    : null;
  const hookTrustRepair = doctorFix
    && !migrationReceiptOwnsReconcile
    && doctorPhaseIds.includes('hook_trust_repair')
    ? await (await import('../core/codex-hooks/codex-hook-trust-doctor.js')).codexHookTrustDoctor(root, { fix: true, managed: true, actual: true }).catch((err: any) => ({
        schema: 'sks.codex-hook-trust-doctor.v2',
        ok: false,
        actual: true,
        blockers: [`hook_trust_repair_failed:${err?.message || String(err)}`],
        warnings: [],
        repair_actions: ['sks codex trust-doctor --fix --managed --actual']
      }))
    : null;
  const doctorFixTransaction = doctorFix
      ? await (await import('../core/doctor/doctor-transaction.js')).runDoctorFixTransaction({
        root,
        dirtyPlan: doctorDirtyPlan,
        json: flag(args, '--json'),
        machineOnly,
        phases: [
          {
            id: 'setup',
            report: () => setupRepair,
            run: async () => ({
              id: 'setup',
              ok: setupRepair !== null,
              repaired: setupRepair !== null,
              blockers: setupRepair === null ? ['setup_repair_not_recorded'] : [],
              rollback_evidence: (setupRepair as any)?.config_backup_path || 'setup_force_regeneration_idempotent_manifest'
            })
          },
          {
            id: 'codex_startup_repair',
            report: () => codexStartupRepair,
            run: async () => ({
              id: 'codex_startup_repair',
              ok: (codexStartupRepair as any)?.ok !== false,
              repaired: doctorFix,
              blockers: (codexStartupRepair as any)?.blockers || [],
              warnings: (codexStartupRepair as any)?.warnings || [],
              rollback_evidence: (codexStartupRepair as any)?.report_path || 'codex_startup_repair_report'
            })
          },
          {
            id: 'startup_config_repair',
            report: () => startupConfigRepair,
            run: async () => ({
              id: 'startup_config_repair',
              ok: (startupConfigRepair as any)?.ok === true,
              repaired: (startupConfigRepair as any)?.apply === true,
              blockers: (startupConfigRepair as any)?.blockers || [],
              rollback_evidence: (startupConfigRepair as any)?.backup_path || 'startup_config_repair_idempotent_report'
            })
          },
          {
            id: 'codex_config_syntax_repair',
            report: () => codexConfigSyntaxRepair,
            run: async () => ({
              id: 'codex_config_syntax_repair',
              ok: (codexConfigSyntaxRepair as any)?.ok !== false,
              repaired: doctorFix && (codexConfigSyntaxRepair?.configs || []).some((entry) => entry.changed),
              blockers: (codexConfigSyntaxRepair as any)?.blockers || [],
              warnings: (codexConfigSyntaxRepair as any)?.warnings || [],
              rollback_evidence: (codexConfigSyntaxRepair as any)?.report_path || 'codex_config_syntax_repair_report'
            })
          },
          {
            id: 'context7_repair',
            report: () => context7Repair,
            run: async () => ({
              id: 'context7_repair',
              ok: (context7Repair as any)?.ok !== false,
              repaired: doctorFix,
              blockers: (context7Repair as any)?.blockers || [],
              warnings: (context7Repair as any)?.warnings || [],
              rollback_evidence: (context7Repair as any)?.report_path || 'context7_repair_report'
            })
          },
          {
            id: 'context7_mcp_repair',
            report: () => context7McpRepair,
            run: async () => ({
              id: 'context7_mcp_repair',
              ok: (context7McpRepair as any)?.ok === true,
              repaired: (context7McpRepair as any)?.repaired === true,
              manual_required: (context7McpRepair as any)?.manual_required === true,
              blockers: (context7McpRepair as any)?.blockers || [],
              warnings: (context7McpRepair as any)?.warnings || [],
              rollback_evidence: (context7McpRepair as any)?.backup_path || 'context7_mcp_repair_idempotent_report'
            })
          },
          {
            id: 'supabase_mcp_repair',
            report: () => supabaseMcpRepair,
            required_for_ready: false,
            run: async () => ({
              id: 'supabase_mcp_repair',
              ok: (supabaseMcpRepair as any)?.ok === true,
              repaired: false,
              manual_required: (supabaseMcpRepair as any)?.manual_required === true,
              required_for_ready: false,
              blockers: (supabaseMcpRepair as any)?.blockers || [],
              warnings: (supabaseMcpRepair as any)?.warnings || [],
              rollback_evidence: 'optional_supabase_no_ready_mutation_required'
            })
          },
          {
            id: 'hook_trust_repair',
            report: () => hookTrustRepair,
            run: async () => ({
              id: 'hook_trust_repair',
              ok: (hookTrustRepair as any)?.ok !== false,
              repaired: doctorFix && !migrationReceiptOwnsReconcile,
              blockers: (hookTrustRepair as any)?.blockers || [],
              warnings: (hookTrustRepair as any)?.warnings || [],
              rollback_evidence: migrationReceiptOwnsReconcile
                ? 'project_migration_receipt_owns_hook_trust_refresh'
                : (hookTrustRepair as any)?.fixed?.managed_hook_file || 'codex_hook_trust_repair_idempotent'
            })
          },
          {
            id: 'sks_menubar',
            report: () => sksMenuBar,
            required_for_ready: false,
            run: async () => ({
              id: 'sks_menubar',
              ok: (sksMenuBar as any)?.ok === true,
              repaired: doctorFix && Array.isArray((sksMenuBar as any)?.actions) && (sksMenuBar as any).actions.length > 0,
              required_for_ready: false,
              blockers: (sksMenuBar as any)?.blockers || [],
              warnings: (sksMenuBar as any)?.warnings || [],
              artifact_path: (sksMenuBar as any)?.report_path || null,
              rollback_evidence: (sksMenuBar as any)?.launch_agent_path || (sksMenuBar as any)?.report_path || 'sks_menubar_optional_no_core_mutation'
            }),
            postcheck: async () => {
              const inspectMenuBarStatusImpl = deps.inspectSksMenuBarStatusImpl || inspectSksMenuBarStatus;
              const status = await inspectMenuBarStatusImpl({ root }).catch((err: any) => ({
                ok: false,
                launchd: { ok: false, state: null, pid: null, error: err?.message || String(err) },
                action_target: { ok: false, smoke_code: null, smoke_output: null },
                blockers: [err?.message || String(err)],
                warnings: []
              } as any));
              const launchdRepair = await rebootstrapSksMenuBarLaunchdForDoctorFix({
                fix: doctorFix,
                root,
                env: process.env,
                status
              }, {
                inspectSksMenuBarStatusImpl: inspectMenuBarStatusImpl,
                restartLaunchAgentImpl: deps.restartLaunchAgentImpl
              });
              const postcheck = buildSksMenuBarDoctorPostcheck(launchdRepair.status);
              return launchdRepair.attempted
                ? {
                    ...postcheck,
                    repaired: launchdRepair.ok,
                    warnings: [
                      ...(postcheck.warnings || []),
                      launchdRepair.ok ? 'launchd_rebootstrap_recovered' : 'launchd_rebootstrap_failed'
                    ]
                  }
                : postcheck;
            }
          },
          {
            id: 'command_alias_cleanup',
            report: () => commandAliasCleanupBeforeReceipt,
            run: async () => ({
              id: 'command_alias_cleanup',
              ok: (commandAliasCleanupBeforeReceipt as any)?.ok !== false,
              repaired: Array.isArray((commandAliasCleanupBeforeReceipt as any)?.actions) && (commandAliasCleanupBeforeReceipt as any).actions.length > 0,
              blockers: (commandAliasCleanupBeforeReceipt as any)?.blockers || [],
              warnings: (commandAliasCleanupBeforeReceipt as any)?.warnings || [],
              rollback_evidence: (commandAliasCleanupBeforeReceipt as any)?.report_path || 'command_alias_cleanup_report'
            })
          },
          {
            id: 'native_capability_repair',
            report: () => doctorNativeCapabilityRepair,
            required_for_ready: false,
            run: async () => ({
              id: 'native_capability_repair',
              ok: (doctorNativeCapabilityRepair as any)?.ok !== false,
              repaired: doctorFix,
              manual_required: Array.isArray((doctorNativeCapabilityRepair as any)?.optional_manual_required) && (doctorNativeCapabilityRepair as any).optional_manual_required.length > 0,
              required_for_ready: false,
              blockers: (doctorNativeCapabilityRepair as any)?.blockers || [],
              warnings: (doctorNativeCapabilityRepair as any)?.optional_warnings || (doctorNativeCapabilityRepair as any)?.warnings || [],
              route_blockers: (doctorNativeCapabilityRepair as any)?.route_blockers || {},
              rollback_evidence: (doctorNativeCapabilityRepair as any)?.secret_preservation_guard || 'native_capability_repair_report'
            } as any)
          },
          {
            id: 'desktop_bridge_catalog_repair',
            required_for_ready: false,
            // Doctor previously only PRINTED "action: retry_catalog_sync" while
            // --fix left the stale catalog in place; a stale combined catalog
            // blocks the bridge and freezes the Desktop picker generation. The
            // repair body lives in core (`repairDoctorDesktopBridgeCatalog`) so
            // the global-only fix and the update migration stage run the SAME
            // restart -> sync -> read-back-verify -> bounded-retry sequence.
            run: async () => repairDoctorDesktopBridgeCatalog({ fix: doctorFix }) as any
          }
        ].filter((phase) => doctorPhaseIds.includes(phase.id))
      }).catch((err: any) => ({
        schema: 'sks.doctor-fix-transaction.v2',
        generated_at: new Date().toISOString(),
        ok: false,
        postcheck_ok: false,
        dirty_plan: doctorDirtyPlan,
        phases: [
          {
            id: 'doctor_fix_transaction',
            ok: false,
            repaired: false,
            manual_required: false,
            blockers: [err?.message || String(err)],
            warnings: [],
            artifact_path: null,
            rollback_evidence: null
          }
        ],
        mutations_without_rollback: 0,
        rollback_performed: false,
        raw_secret_values_recorded: false
      } as any))
    : null;
  const doctorFixPostcheck = doctorFix ? (await import('../core/doctor/doctor-repair-postcheck.js')).doctorRepairPostcheck(doctorFixTransaction as any) : null;
  // Read the bridge again now the repair transaction has closed. Doctor used to
  // report the snapshot taken BEFORE it, so a `desktop_bridge_catalog_repair`
  // that succeeded still printed `Desktop Bridge: blocked` listing the very
  // blockers it had just cleared — from the user's side, indistinguishable from
  // a repair that never ran, and unchanged no matter how often they re-ran
  // `--fix`. Everything downstream (report, blockers, printed summary) consumes
  // this binding.
  const desktopBridge = doctorFixTransaction
    ? await inspectDoctorDesktopBridgeStatus({
      processEnv: process.env
    }, { desktopBridgeStatusImpl: deps.desktopBridgeStatusImpl })
    : desktopBridgeBeforeFix;
  const permissionProfiles = await inventoryCodexPermissionProfiles(root, { writeReport: true });
  const startupRoleRepair = (startupConfigRepair as any)?.role_repair;
  const agentRoleConfigRepair = doctorFix && startupRoleRepair
    ? startupRoleRepair
    : await repairAgentRoleConfigs({
        root,
        apply: false,
        reportPath: `${root}/.sneakoscope/reports/agent-role-config-repair.json`
      }).catch((err: any) => ({
        schema: 'sks.agent-role-config-repair.v1',
        ok: false,
        apply: false,
        missing: [],
        existing: [],
        created: [],
        warnings_suppressed: false,
        blockers: [err?.message || String(err)]
      }));
  const officialSubagentConfig = await (await import('../core/subagents/official-subagent-config.js'))
    .readOfficialSubagentConfig(root)
    .catch((err: any) => ({
      maxThreads: null,
      maxDepth: null,
      blockers: [`official_subagent_config_read_failed:${err?.message || String(err)}`],
      warnings: []
    }));
  const globalSksInstallCleanup = flag(args, '--fix') && !flag(args, '--local-only')
    ? await (await import('../core/doctor/global-sks-install-cleanup.js')).cleanDuplicateGlobalSksInstalls({ root, fix: true }).catch((err: any) => ({ schema: 'sks.global-sks-install-cleanup.v1', ok: false, fix: true, error: err?.message || String(err), blockers: ['global_sks_install_cleanup_exception'] }))
    : null;
  const shouldProbeNativeCapabilityRepairs = doctorFix || deepDiagnostics || nativeCapabilityDiagnosticsRequested;
  const imagegen = await detectImagegenCapability({ codexBin: codexBin || undefined }).catch((err: any) => ({ ok: false, error: err.message, auth_readiness: null, core_ready: false, blockers: ['imagegen_detection_exception'] }));
  const imagegenRepair = shouldProbeNativeCapabilityRepairs
    ? await (await import('../core/doctor/imagegen-repair.js')).repairCodexImagegen({ root, apply: doctorFix, codexBin: codexBin || null }).catch((err: any) => ({
        schema: 'sks.doctor-imagegen-repair.v1',
        ok: false,
        attempted: true,
        apply: doctorFix,
        recovered: false,
        capability_ready: false,
        route_ready: false,
        real_generation_verified: false,
        blockers: [err?.message || String(err)],
        manual_actions: ['Run `sks doctor --fix --json` after enabling Codex App image_generation.']
      }))
    : (imagegen as any).core_ready === true
      ? {
          schema: 'sks.doctor-imagegen-repair.v1',
          ok: false,
          attempted: false,
          apply: doctorFix,
          recovered: false,
          capability_ready: true,
          configuration_ready: true,
          route_ready: false,
          real_generation_verified: false,
          current_task_tool_manifest_verified: false,
          requires_new_task: true,
          before: imagegen,
          after: imagegen,
          steps: [],
          blockers: ['codex_imagegen_current_task_tool_manifest_unverified', 'codex_imagegen_real_output_unverified'],
          manual_actions: [
            'Start a fresh Codex/Work task so $imagegen is present in its tool manifest.',
            'Invoke $imagegen with gpt-image-2 and bind the selected raster output path to route evidence.'
          ],
          communication_test: {
            level: 'flag_level',
            ok: false,
            checked: 'codex features list (feature-flag/plugin metadata only)',
            real_generation_round_trip_performed: false,
            blocker: 'codex_imagegen_real_output_unverified'
          }
        }
      : deferredNativeRepair('sks.doctor-imagegen-repair.v1', doctorFix, [
        'Run `sks doctor --fix --repair-native-capabilities --json` after enabling Codex App image_generation.'
      ]);
  const computerUseRepair = shouldProbeNativeCapabilityRepairs
    ? await (await import('../core/doctor/computer-use-repair.js')).repairComputerUse({ root, apply: doctorFix, codexBin: codexBin || null }).catch((err: any) => ({
      schema: 'sks.doctor-computer-use-repair.v1',
      ok: false,
      attempted: false,
      apply: doctorFix,
      recovered: false,
      blockers: [err?.message || String(err)],
      next_actions: ['Run `sks doctor --fix --json` after checking Codex App settings for Computer Use.']
    }))
    : deferredNativeRepair('sks.doctor-computer-use-repair.v1', doctorFix, [
      'Computer Use route needs manual OS/App permission verification before use.',
      'Run `sks doctor --fix --repair-native-capabilities --json` for an explicit Computer Use repair probe.'
    ]);
  const browserUseRepair = shouldProbeNativeCapabilityRepairs
    ? await (await import('../core/doctor/browser-use-repair.js')).repairBrowserUse({ root, apply: doctorFix, codexBin: codexBin || null }).catch((err: any) => ({
      schema: 'sks.doctor-browser-use-repair.v1',
      ok: false,
      attempted: false,
      apply: doctorFix,
      recovered: false,
      blockers: [err?.message || String(err)],
      next_actions: ['Run `sks doctor --fix --json` after checking Codex App settings for Browser Use / Chrome extension.']
    }))
    : deferredNativeRepair('sks.doctor-browser-use-repair.v1', doctorFix, [
      'Chrome/web review route needs the Codex Chrome Extension enabled before use.',
      'Run `sks doctor --fix --repair-native-capabilities --json` for an explicit Browser Use repair probe.'
    ]);
  const mcpTransportCollisionRepair = doctorFix
    ? await (await import('../core/doctor/mcp-transport-collision-repair.js')).detectAndRepairMcpTransportCollisions({ root, apply: true }).catch((err: any) => ({
        schema: 'sks.mcp-transport-collision-repair.v1',
        ok: false,
        apply: true,
        project_config_path: null,
        global_config_path: null,
        servers: [],
        blockers: [err?.message || String(err)],
        warnings: [],
        raw_secret_values_recorded: false
      }))
    : null;
  const nativeCapabilityReadinessStatus = (repair: any) => repair?.skipped === true
    ? (repair.status || 'deferred')
    : repair?.route_ready === true
      ? 'ok'
      : repair?.capability_ready === true
        ? 'available-unverified'
        : (repair?.recovered === true || repair?.ok === true ? 'ok' : repair?.attempted ? 'blocked' : 'not-needed');
  const nativeCapabilityReadiness = {
    schema: 'sks.native-capability-readiness.v1',
    generated_at: nowIso(),
    apply: doctorFix,
    imagegen: {
      status: nativeCapabilityReadinessStatus(imagegenRepair),
      capability_ready: (imagegenRepair as any)?.capability_ready === true,
      route_ready: (imagegenRepair as any)?.route_ready === true,
      generated_output_verified: (imagegenRepair as any)?.real_generation_verified === true,
      communication_test: (imagegenRepair as any)?.communication_test || null,
      blockers: (imagegenRepair as any)?.blockers || []
    },
    computer_use: { status: nativeCapabilityReadinessStatus(computerUseRepair), blockers: (computerUseRepair as any)?.blockers || [], next_actions: (computerUseRepair as any)?.next_actions || [] },
    browser_use: { status: nativeCapabilityReadinessStatus(browserUseRepair), blockers: (browserUseRepair as any)?.blockers || [], next_actions: (browserUseRepair as any)?.next_actions || [] }
  };
  if (doctorFix) {
    await writeJsonAtomic(path.join(root, '.sneakoscope', 'reports', 'native-capability-readiness.json'), nativeCapabilityReadiness).catch(() => undefined);
  }
  const codexCurrentAppCapability = deepDiagnostics
    ? await writeCodexCurrentAppCapabilityArtifacts(root, { codexBin: codexBin || null }).catch((err: any) => ({ error: err?.message || String(err), report: null }))
    : { skipped: true, report: null };
  const codexCurrentAppDoctor = deepDiagnostics
    ? await runCodexCurrentAppDoctor(root, { fix: doctorFix }).catch((err: any) => ({ schema: 'sks.codex-current-app-doctor.v1', ok: false, error: err?.message || String(err), blockers: ['codex_current_app_doctor_exception'], warnings: [] }))
    : { schema: 'sks.codex-current-app-doctor.v1', ok: true, skipped: true, blockers: [], warnings: ['historical_codex_current_app_doctor_skipped'] };
  const pluginInventory = deepDiagnostics
    ? await writeCodexPluginInventoryArtifacts(root).catch((err: any) => ({ error: err?.message || String(err), report: null, artifact: null }))
    : { skipped: true, report: null, artifact: null };
  const pluginPolicy = (pluginInventory as any)?.report ? pluginAppTemplatePolicy((pluginInventory as any).report) : null;
  const mcpPluginInventory = (pluginInventory as any)?.report
    ? await writeMcpPluginInventoryArtifacts(root, { inventory: (pluginInventory as any).report }).catch((err: any) => ({ error: err?.message || String(err), candidates: null }))
    : null;
  const repairCodexNative = doctorFix && doctorPhaseIds.includes('native_capability_repair');
  const codexNativeRepair = repairCodexNative
    ? await (await import('../core/codex-native/codex-native-repair-transaction.js')).repairCodexNativeManagedAssets({
        root,
        requestedBy: 'doctor --fix',
        yes: flag(args, '--yes') || flag(args, '-y')
      }).catch((err: any) => ({
        schema: 'sks.codex-native-repair-transaction.v1',
        ok: false,
        generated_at: new Date().toISOString(),
        requested_by: 'doctor --fix',
        repaired: [],
        blockers: [err?.message || String(err)],
        warnings: []
      }))
    : null;
  // Runs AFTER every mutator, including the two that write configs once the
  // fix transaction has already closed. This is the only postcheck that reads
  // the files back from disk, so it is the only one that can contradict a phase
  // which reported success.
  const configDiskVerification = doctorFix
    ? await (await import('../core/doctor/doctor-repair-postcheck.js')).verifyCodexConfigsOnDisk({ root })
      .catch((err: any) => ({
        schema: 'sks.doctor-config-disk-verification.v1' as const,
        ok: false,
        project_config_path: '',
        codex_home_config_path: '',
        project_config_present: false,
        codex_home_config_present: false,
        multi_agent_v2_enabled: null,
        agents_enabled: null,
        blockers: [`config_disk_verification_failed:${err?.message || String(err)}`]
      }))
    : null;
  const codexAppHarnessMatrix = deepDiagnostics
    ? await buildCodexAppHarnessMatrix({ root, mode: 'read-only' }).catch((err: any) => ({
        schema: 'sks.codex-app-harness-matrix.v1',
        ok: false,
        codex_cli: { available: false, version: null },
        app_features: {},
        sks_integrations: {},
        blockers: [err?.message || String(err)],
        warnings: []
      }))
    : {
        schema: 'sks.codex-app-harness-matrix.v1',
        ok: true,
        skipped: true,
        app_features: {},
        sks_integrations: {},
        blockers: [],
        warnings: ['codex_app_harness_optional_diagnostic_skipped']
      };
  const codexNativeFeatureMatrix = deepDiagnostics
    ? await buildCodexNativeFeatureMatrix({ root, mode: 'read-only' }).catch((err: any) => fallbackCodexNativeFeatureMatrix(codex, [err?.message || String(err)]))
    : fallbackCodexNativeFeatureMatrix(codex, [], ['native_feature_matrix_deferred_to_full_doctor_or_route_gate']);
  if (doctorFix && codexConfig?.ok === false) {
    const reinspected = await inspectCodexConfigReadability(root, configProbeOpts).catch(() => null);
    if (reinspected) codexConfig = reinspected;
  }
  const postRepairCodexDoctor = doctorFix && (deepDiagnostics || flag(args, '--require-actual-codex'))
    ? await runCodexDoctorBridge({ codexBin: codexBin || null, cwd: root, required: flag(args, '--fix') || flag(args, '--require-actual-codex') }).catch((err: any) => ({
        schema: 'sks.codex-doctor-bridge.v2',
        generated_at: new Date().toISOString(),
        available: false,
        exit_code: null,
        process_exit_code: null,
        disposition: 'block',
        semantic_ok: false,
        source_format: 'text-fallback',
        blocking_checks: [],
        warning_checks: [],
        informational_checks: [],
        environment_diagnostics_ok: false,
        git_diagnostics_ok: false,
        terminal_diagnostics_ok: false,
        app_server_diagnostics_ok: false,
        thread_inventory_ok: false,
        stdout_tail: '',
        stderr_tail: '',
        blockers: [`post_repair_codex_doctor_exception:${err?.message || String(err)}`],
        warnings: []
      } as any))
    : preRepairCodexDoctor;
  const authoritativeCodexDoctor = postRepairCodexDoctor;
  const codexDoctorAuthoritativeDiff = compareCodexDoctorBridge(codexDoctorBefore, authoritativeCodexDoctor as any);
  const pkgBytes = 0;
  const doctorReadinessInput: any = {
    codex,
    codex_config: codexConfig,
    codex_app: codexApp,
    desktop_bridge: desktopBridge,
    codex_doctor: authoritativeCodexDoctor,
    pre_repair_codex_doctor: preRepairCodexDoctor,
    post_repair_codex_doctor: postRepairCodexDoctor,
    require_codex_doctor: deepDiagnostics || flag(args, '--require-actual-codex'),
    context7_repair: context7Repair,
    codex_startup_repair: codexStartupRepair,
    startup_config_repair: startupConfigRepair,
    codex_config_syntax_repair: codexConfigSyntaxRepair,
    context7_mcp_repair: context7McpRepair,
    supabase_mcp_repair: supabaseMcpRepair,
    doctor_fix_transaction: doctorFixTransaction,
    doctor_dirty_plan: doctorDirtyPlan,
    doctor_fix_postcheck: doctorFixPostcheck,
    command_aliases: migrationReceiptOwnsReconcile ? commandAliasCleanupBeforeReceipt : undefined,
    doctor_native_capability: doctorNativeCapabilityRepair,
    require_legacy_global_hook_cleanup: requireLegacyGlobalHookCleanup,
    require_legacy_generation_convergence: doctorFix && !migrationReceiptOwnsReconcile,
    skills: skillsReconcile,
    agent_role_config: agentRoleConfigRepair,
    repair: configRepair,
    codex_app_ui: codexAppUi,
    sks_menubar: sksMenuBar,
    codex_current_app_doctor: codexCurrentAppDoctor,
    codex_plugin_inventory: (pluginInventory as any)?.report || null,
    codex_plugin_app_template_policy: pluginPolicy,
    codex_app_harness_matrix: codexAppHarnessMatrix,
    require_codex_cli_config_load: requireActualCodexProbe,
    operator_actions: [
      ...(codexConfig.operator_actions || []),
      ...(configRepair?.operator_actions || []),
      ...((codexStartupRepair as any).manual_actions || []),
      ...((codexConfigSyntaxRepair as any)?.manual_actions || []),
      ...(pluginPolicy?.doctor_warnings || []),
      ...((desktopBridge as any).ok === false ? (desktopBridge as any).recovery_actions || [] : [])
    ]
  };
  let ready = await writeDoctorReadinessMatrix(root, doctorReadinessInput);
  if (doctorFix) {
    const readinessBlockers = [
      ...(Array.isArray((ready as any).blockers) ? (ready as any).blockers.map(String).filter(Boolean) : []),
      ...((openRouterProviderRepair as any)?.ok === false
        ? (((openRouterProviderRepair as any)?.blockers || ['openrouter_provider_repair_failed']).map(String))
        : [])
    ];
    const preservedUserOwnedConfig = doctorProfile === 'migration'
      && readinessBlockers.length > 0
      && readinessBlockers.every(isMigrationUserOwnedProjectConfigBlocker);
    const receiptBlockers = preservedUserOwnedConfig ? [] : readinessBlockers;
    const migrationWarnings = [
      ...((commandAliasCleanup as any)?.warnings || []),
      ...((doctorNativeCapabilityRepair as any)?.optional_warnings || []),
      ...((doctorFixPostcheck as any)?.optional_warnings || []),
      ...(preservedUserOwnedConfig
        ? [
            'migration_doctor_preserved_user_owned_project_config',
            ...readinessBlockers.map((blocker) => `migration_optional_blocker:${blocker}`)
          ]
        : [])
    ];
    try {
      const receiptInput: Parameters<typeof writeProjectUpdateMigrationReceipt>[0] = {
        root,
        source: `doctor-${doctorProfile}`,
        blockers: receiptBlockers,
        warnings: migrationWarnings
      };
      if (receiptBlockers.length) receiptInput.status = 'blocked';
      if (migrationReceiptOwnsReconcile) {
        // The receipt-owned stages perform the mutation. Re-run the
        // public-surface check after those stages, but before the receipt is
        // published, so repaired pre-migration findings cannot stale-block
        // the same command that repaired them.
        receiptInput.postMigrationStageCheck = async () => {
          commandAliasCleanup = await inspectCommandAliasCleanup(false, null, true);
          doctorReadinessInput.command_aliases = commandAliasCleanup;
          ready = await writeDoctorReadinessMatrix(root, doctorReadinessInput);
          return {
            blockers: Array.isArray((commandAliasCleanup as any)?.blockers)
              ? (commandAliasCleanup as any).blockers.map(String).filter(Boolean)
              : [],
            warnings: Array.isArray((commandAliasCleanup as any)?.warnings)
              ? (commandAliasCleanup as any).warnings.map(String).filter(Boolean)
              : []
          };
        };
      }
      const receipt = await writeProjectUpdateMigrationReceipt(receiptInput);
      sksUpdate = {
        schema: 'sks.update-now.v2',
        ok: receipt.status === 'current' && isUpdateMigrationReceiptCurrent(receipt),
        status: receipt.status === 'current' ? 'repaired' : receipt.status,
        reason: receipt.status === 'current' ? 'doctor_fix_wrote_current_project_migration_receipt' : 'doctor_fix_migration_receipt_blocked',
        stages: receipt.migration_stages || [],
        migration_current: isUpdateMigrationReceiptCurrent(receipt),
        receipt_path: projectUpdateMigrationReceiptPath(root),
        blockers: receipt.blockers || [],
        warnings: receipt.warnings || []
      };
    } catch (err: any) {
      sksUpdate = {
        schema: 'sks.update-now.v2',
        ok: false,
        status: 'blocked',
        reason: 'doctor_fix_migration_receipt_failed',
        stages: [],
        migration_current: false,
        receipt_path: projectUpdateMigrationReceiptPath(root),
        blockers: [`migration_receipt_failed:${err?.message || String(err)}`],
        warnings: migrationWarnings
      };
    }
  }
  const runtimeReadiness = buildRuntimeReadiness(codexNativeFeatureMatrix as any);
  // `blocked` used to be reported with no top-level `blockers` at all: the ten
  // conditions below collapsed into one boolean, so a failed `doctor --fix`
  // exited 1 naming nothing. Each condition now carries the blocker it implies,
  // and `resultOk` is derived from the list so the two cannot disagree.
  const resultBlockers = [
    ...(ready.ready
      ? []
      : (Array.isArray((ready as any).blockers) && (ready as any).blockers.length
        ? (ready as any).blockers.map((blocker: any) => `readiness:${String(blocker)}`)
        : ['readiness_not_ready'])),
    ...(sksUpdate && (sksUpdate as any).ok === false ? ['sks_update_blocked'] : []),
    ...(doctorFix && !migrationReceiptOwnsReconcile && (skillsReconcile as any)?.convergence?.ok !== true
      ? ['managed_skill_reconcile_not_converged']
      : []),
    ...((commandAliasCleanup as any).ok === false ? ['command_alias_cleanup_blocked'] : []),
    ...((codexStartupRepair as any).ok === false ? ['codex_startup_repair_blocked'] : []),
    ...((codexConfigSyntaxRepair as any)?.ok === false ? ['codex_config_syntax_repair_blocked'] : []),
    ...((agentRoleConfigRepair as any).ok === false ? ['agent_role_config_repair_blocked'] : []),
    ...((openRouterProviderRepair as any).ok === false ? ['openrouter_provider_repair_blocked'] : []),
    ...((((officialSubagentConfig as any).blockers || []) as any[])
      .map((blocker) => `official_subagent_config:${String(blocker)}`)),
    ...(doctorProfileRequiresDesktopBridgeReadiness(doctorProfile) && desktopBridge.ok === false
      ? ['desktop_bridge_not_ready']
      : []),
    // These two mutate configs after the fix transaction has closed, so nothing
    // downstream observed their failures: `mcp_transport_collision` was only
    // console.log'd and `codex_native` only embedded in the `repair` blob.
    ...((mcpTransportCollisionRepair as any)?.ok === false ? ['mcp_transport_collision_repair_blocked'] : []),
    ...((codexNativeRepair as any)?.ok === false ? ['codex_native_repair_blocked'] : []),
    ...(((configDiskVerification as any)?.blockers || []) as any[])
      .map((blocker) => `config_disk_verification:${String(blocker)}`)
  ];
  const resultOk = resultBlockers.length === 0;
  // Repairs that refuse for a recoverable reason ship the manual step with the
  // refusal; surface it instead of leaving the operator with a blocker id.
  const repairOperatorActions = [
    ...((codexStartupRepair as any)?.config_file_repair?.operator_actions || []),
    ...((agentRoleConfigRepair as any)?.operator_actions || [])
  ].map(String).filter(Boolean);
  const result = {
    schema: 'sks.doctor-status.v3',
    elapsed_ms: Date.now() - startedAtMs,
    ok: resultOk,
    status: resultOk ? (doctorFix ? 'fix_ok' : deepDiagnostics ? 'full_ok' : 'fast_ok') : 'blocked',
    core_ready: ready.core_ready === true,
    center_ready: ready.center_ready === true,
    center_attempted: ready.center_attempted === true,
    diagnostic_depth: deepDiagnostics ? 'full' : doctorFix ? 'fix' : 'fast',
    deep_diagnostics_skipped: !deepDiagnostics,
    deep_ok: deepDiagnostics ? resultOk : null,
    not_counted_as_full_doctor: !deepDiagnostics,
    root,
    arg_warnings: argWarnings,
    blockers: [...new Set(resultBlockers.map(String))],
    warnings: [...oauthCallbackPortDiagnostic.warnings, ...(desktopBridge.warnings || [])],
    operator_actions: [...new Set([
      ...oauthCallbackOperatorActions,
      ...((desktopBridge as any).ok === false ? (desktopBridge as any).recovery_actions || [] : []),
      ...repairOperatorActions,
      ...(resultOk ? [] : ['Each blocker above names a report under .sneakoscope/reports/; re-run `sks doctor --full --json` after resolving them.'])
    ].map(String).filter(Boolean))],
    node: { ok: Number(process.versions.node.split('.')[0]) >= 20, version: process.version },
    codex,
    oauth_callback_port_diagnostic: oauthCallbackPortDiagnostic,
    codex_config: codexConfig,
    rust,
    codex_app: codexApp,
    codex_app_ui: codexAppUi,
    openrouter_provider: desktopBridge.providers?.openrouter || null,
    sks_menubar: sksMenuBar,
    provider_context: providerContext,
    desktop_bridge: desktopBridge,
    codex_doctor: authoritativeCodexDoctor,
    pre_repair_codex_doctor: preRepairCodexDoctor,
    post_repair_codex_doctor: postRepairCodexDoctor,
    codex_doctor_diff: codexDoctorAuthoritativeDiff,
    observational_codex_doctor_diff: codexDoctorDiff,
    context7_repair: context7Repair,
    codex_startup_repair: codexStartupRepair,
    startup_config_repair: startupConfigRepair,
    codex_config_syntax_repair: codexConfigSyntaxRepair,
    context7_mcp_repair: context7McpRepair,
    supabase_mcp_repair: supabaseMcpRepair,
    doctor_fix_transaction: doctorFixTransaction,
    doctor_fix_postcheck: doctorFixPostcheck,
    config_disk_verification: configDiskVerification,
    postcheck: doctorFixPostcheck ? {
      ok: (doctorFixPostcheck as any).ok === true && (configDiskVerification as any)?.ok !== false,
      pending_manual: (doctorFixPostcheck as any).pending_manual || [],
      required_blockers: (doctorFixPostcheck as any).required_blockers || [],
      optional_warnings: (doctorFixPostcheck as any).optional_warnings || []
    } : null,
    agent_role_config: agentRoleConfigRepair,
    official_subagent_config: officialSubagentConfig,
    codex_permission_profiles: permissionProfiles,
    command_aliases: commandAliasCleanup,
    sks_temp_sweep: {
      ok: (sksTempSweep as any).ok !== false,
      skipped: (sksTempSweep as any).skipped === true,
      action_count: Array.isArray((sksTempSweep as any).actions) ? (sksTempSweep as any).actions.length : 0,
      reason: (sksTempSweep as any).reason || null,
      error: (sksTempSweep as any).error || null
    },
    imagegen: {
      ok: (imagegenRepair as any)?.route_ready === true,
      capability_ready: (imagegen as any).codex_app?.available === true,
      route_ready: (imagegenRepair as any)?.route_ready === true,
      generated_output_verified: (imagegenRepair as any)?.real_generation_verified === true,
      auth_ready: (imagegen as any).auth_readiness?.headless_auto_available === true,
      auth_readiness: (imagegen as any).auth_readiness || null,
      codex_app_builtin_available: (imagegen as any).codex_app?.available === true
    },
    imagegen_repair: imagegenRepair,
    codex_current_app: {
      capability: (codexCurrentAppCapability as any).report || null,
      doctor: codexCurrentAppDoctor,
      plugins: (pluginInventory as any)?.report || null,
      plugin_app_template_policy: pluginPolicy,
      mcp_plugin_inventory: (mcpPluginInventory as any)?.candidates || null
    },
    codex_app_harness_matrix: codexAppHarnessMatrix,
    codex_native_feature_matrix: codexNativeFeatureMatrix,
    runtime_readiness: runtimeReadiness,
    ready,
    sneakoscope: { ok: await exists(`${root}/.sneakoscope`) },
    package: { bytes: pkgBytes, human: formatBytes(pkgBytes) },
    skills: skillsReconcile,
    repair: { sks_update: sksUpdate, setup: setupRepair, openrouter_provider: openRouterProviderRepair, codex_config: configRepair, migration_journal: migrationJournal, global_sks_installs: globalSksInstallCleanup, agent_role_config: agentRoleConfigRepair, context7: context7Repair, codex_startup: codexStartupRepair, startup_config: startupConfigRepair, context7_mcp: context7McpRepair, supabase_mcp: supabaseMcpRepair, mcp_transport_collision: mcpTransportCollisionRepair, imagegen: imagegenRepair, computer_use: computerUseRepair, browser_use: browserUseRepair, hook_trust: hookTrustRepair, sks_menubar: sksMenuBar, doctor_transaction: doctorFixTransaction, doctor_dirty_plan: doctorDirtyPlan, doctor_postcheck: doctorFixPostcheck, codex_native: codexNativeRepair, doctor_native_capability: doctorNativeCapabilityRepair, command_aliases: commandAliasCleanup, skills: skillsReconcile, sks_temp_sweep: sksTempSweep }
  };
  if (reportFile) await writeJsonReportFile(reportFile, result);
  if (machineOnly && !flag(args, '--json')) {
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (flag(args, '--json')) {
    printJson(result);
    if (!result.ok) process.exitCode = 1;
    return;
  }
  const agentBridgeManifestExists = await exists(path.join(root, '.sneakoscope', 'agent-bridge', 'manifest.json'));
  const consoleLines = renderDoctorConsoleReport(result, {
    oauthCallbackOperatorActions,
    nativeCapabilityReadiness,
    agentBridgeManifestExists,
    codexCurrentAppCapability,
    pluginInventory,
    rootIsHome: path.resolve(root) === path.resolve(deps.home || process.env.HOME || os.homedir())
  });
  for (const consoleLine of consoleLines) console.log(consoleLine);
  if (!result.ok) process.exitCode = 1;
}
