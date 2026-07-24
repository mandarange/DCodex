import os from 'node:os';
import path from 'node:path';
import { projectRoot, exists, formatBytes, nowIso, writeJsonAtomic } from '../core/fsx.js';
import { flag } from '../cli/args.js';
import { printJson } from '../cli/output.js';
import { ui as cliUi } from '../cli/cli-theme.js';
import { getCodexInfo } from '../core/codex-adapter.js';
import { rustInfo } from '../core/rust-accelerator.js';
import { codexAppIntegrationStatus } from '../core/codex-app.js';
import { codexLbMetrics, readCodexLbCircuit } from '../core/codex-lb-circuit.js';
import { codexLbStatus } from '../cli/install-helpers.js';
import { codexLbToolOutputRecoveryOverrideAcknowledged } from '../core/codex-lb/codex-lb-tool-output-recovery.js';
import { normalizeInstallScope } from '../core/init.js';
import { inspectCodexConfigReadability } from '../core/codex/codex-config-readability.js';
import { checkZellijCapability } from '../core/zellij/zellij-capability.js';
import { inventoryCodexPermissionProfiles } from '../core/codex/codex-permission-profiles.js';
import { appendMigrationEvents, hashConfigText } from '../core/migration/migration-transaction-journal.js';
import { resolveProviderContext } from '../core/provider/provider-context.js';
import { readLocalModelConfig } from '../core/agents/ollama-worker-config.js';
import { writeCodex0138CapabilityArtifacts } from '../core/codex-control/codex-0138-capability.js';
import { writeCodexPluginInventoryArtifacts, pluginAppTemplatePolicy } from '../core/codex-plugins/codex-plugin-json.js';
import { writeMcpPluginInventoryArtifacts } from '../core/mcp/mcp-plugin-inventory.js';
import { buildCodexAppHarnessMatrix } from '../core/codex-app/codex-app-harness-matrix.js';
import { buildCodexNativeFeatureMatrix } from '../core/codex-native/codex-native-feature-broker.js';
import { withSecretPreservationGuard } from '../core/config/config-migration-journal.js';
import { reconcileDoctorSkills } from '../core/doctor/doctor-skill-reconcile.js';
import { isUpdateMigrationReceiptCurrent, projectUpdateMigrationReceiptPath, writeProjectUpdateMigrationReceipt } from '../core/update/update-migration-state.js';
import { inspectSksMenuBarStatus, installSksMenuBar, sksMenuBarRestartDeferred } from '../core/codex-app/sks-menubar.js';
import { sweepSksTempDirs } from '../core/retention.js';
import { detectImagegenCapability } from '../core/imagegen/imagegen-capability.js';
import { CURRENT_CODEX_RELEASE_MANIFEST } from '../core/codex-compat/codex-release-manifest.js';
import { formatHarnessConflictReport, scanHarnessConflicts } from '../core/harness-conflicts.js';
import {
  doctorArgWarnings,
  doctorMenuBarInstallPolicy,
  doctorPhaseIdsForProfile,
  doctorProfileFromArgs
} from './doctor-profile.js';

export { doctorArgWarnings, doctorMenuBarInstallPolicy, doctorProfileFromArgs } from './doctor-profile.js';

export async function run(_command: any, args: any = [], deps: any = {}) {
  const root = await projectRoot();
  const doctorFix = flag(args, '--fix');
  const globalOnly = doctorFix && flag(args, '--global-only');
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
    const guardRoot = globalOnly
      ? path.resolve(deps.home || process.env.HOME || os.homedir())
      : root;
    return withSecretPreservationGuard(guardRoot, 'doctor-fix', async () => (
      globalOnly
        ? runDoctorGlobalOnlyFix(args, root, deps)
        : runDoctor(args, root, doctorFix)
    ));
  }
  return runDoctor(args, root, doctorFix);
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
  const ensureStoredOpenRouterProviderImpl = deps.ensureStoredOpenRouterProviderDuringInstallImpl
    || (await import('../cli/install-helpers.js')).ensureStoredOpenRouterProviderDuringInstall;
  const installMenuBarImpl = deps.installSksMenuBarImpl || installSksMenuBar;
  const codexLbStatusImpl = deps.codexLbStatusImpl || codexLbStatus;
  const doctorEnv = deps.env || (deps.home
    ? { ...process.env, HOME: home }
    : process.env);

  const providerStatus = await codexLbStatusImpl({
    probeToolOutputRecovery: true,
    allowUnverifiedToolOutputRecovery: codexLbToolOutputRecoveryOverrideAcknowledged({ args })
  }).catch((err: any) => ({
    selected: null,
    provider_ready: false,
    recovery_probe_failed: true,
    tool_output_recovery: {
      ok: false,
      status: 'probe_failed',
      blockers: ['codex_lb_tool_output_recovery_status_probe_failed'],
      operator_actions: []
    },
    error: err?.message || String(err)
  }));
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
  const openRouterEnv = {
    ...doctorEnv,
    HOME: home,
    SKS_HOME: path.join(home, '.sneakoscope')
  };
  const openRouterProvider = await ensureStoredOpenRouterProviderImpl({ home, env: openRouterEnv }).catch((err: any) => ({
    schema: 'sks.openrouter-provider-upgrade-repair.v1',
    ok: false,
    status: 'failed',
    blockers: ['openrouter_provider_repair_failed'],
    error: err?.message || String(err)
  }));
  const menuBar = await installMenuBarImpl({
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
  }));

  const recoveryReady = codexLbRecoveryStatusReady(providerStatus, true);
  const globalSkillsReady = !(globalSkills as any)?.error
    && (globalSkills as any)?.ok !== false
    && (globalSkills as any)?.core_skill_integrity?.ok !== false;
  const globalFastModeReady = (globalFastMode as any)?.status !== 'failed'
    && (globalFastMode as any)?.ok !== false;
  const menuBarReady = (menuBar as any)?.ok !== false;
  const openRouterProviderReady = (openRouterProvider as any)?.ok !== false;
  const blockers = [...new Set([
    ...(!globalSkillsReady ? [`global_skills_reconcile_failed:${(globalSkills as any)?.error || 'core_skill_integrity'}`] : []),
    ...((currentSurface as any)?.ok !== true ? ((currentSurface as any)?.blockers || ['global_current_surface_reconcile_failed']) : []),
    ...(!globalFastModeReady ? [`global_fast_mode_repair_failed:${(globalFastMode as any)?.error || (globalFastMode as any)?.status || 'unknown'}`] : []),
    ...(!openRouterProviderReady ? ((openRouterProvider as any)?.blockers || ['openrouter_provider_repair_failed']) : []),
    ...(!menuBarReady ? ((menuBar as any)?.blockers || ['sks_menubar_repair_failed']) : []),
    ...(!recoveryReady ? ((providerStatus as any)?.tool_output_recovery?.blockers || ['codex_lb_tool_output_recovery_unverified']) : [])
  ].map(String).filter(Boolean))];
  const ok = blockers.length === 0;
  return {
    schema: 'sks.doctor-status.v3',
    elapsed_ms: Date.now() - startedAtMs,
    ok,
    status: ok ? 'global_fix_ok' : 'blocked',
    diagnostic_depth: 'global-only',
    global_only: true,
    install_scope: 'global',
    root,
    home,
    project_root_alias_detected: path.resolve(root) === home,
    no_project_writes_performed: true,
    project_phases_skipped: [
      'project_skills_reconcile',
      'project_codex_config_repair',
      'project_context7_mcp_repair',
      'project_supabase_mcp_repair',
      'project_hook_trust_repair',
      'project_command_alias_cleanup',
      'project_migration_receipt'
    ],
    skills: { global: globalSkills, project: { skipped: true, reason: 'global_only_doctor' } },
    current_public_surface: currentSurface,
    codex_app_fast_mode: globalFastMode,
    openrouter_provider: openRouterProvider,
    sks_menubar: menuBar,
    codex_lb: {
      provider_status: providerStatus,
      tool_output_recovery: providerStatus?.tool_output_recovery || null,
      recovery_ok: recoveryReady
    },
    blockers,
    next_actions: [
      ...(recoveryReady ? [] : ((providerStatus as any)?.tool_output_recovery?.operator_actions || [])),
      ...(!openRouterProviderReady ? ['Run `sks codex-app set-openrouter-key` to repair the stored-key provider configuration without switching models.'] : []),
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
    console.log(`SKS Doctor global repair: ${result.ok ? 'ok' : 'blocked'}`);
    console.log(`Global skills: ${(result.skills.global as any)?.error ? 'blocked' : 'reconciled'}`);
    console.log(`SKS menu bar: ${(result.sks_menubar as any)?.status || ((result.sks_menubar as any)?.ok ? 'ok' : 'blocked')}`);
    for (const blocker of result.blockers) console.log(`- blocker: ${blocker}`);
    for (const action of result.next_actions) console.log(`- ${action}`);
  }
  if (!result.ok) process.exitCode = 1;
  return result;
}

function codexLbRecoveryStatusReady(status: any, probeRequired = false): boolean {
  if (status == null) return !probeRequired;
  if (status.recovery_probe_failed === true || status.error) return false;
  if (status.selected === false) return true;
  return status.selected === true && status.tool_output_recovery?.ok === true;
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
  const [codex, rust, codexConfig, sneakoscopeExists] = await Promise.all([
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
    exists(`${root}/.sneakoscope`)
  ]);
  const ready = {
    schema: 'sks.doctor-readiness-matrix.v2',
    generated_at: nowIso(),
    ready: Boolean(codexConfig?.ok),
    cli_ready: Boolean(codexConfig?.ok),
    mad_ready: false,
    managed_state_current: sneakoscopeExists,
    codex_config_readable_by_node: Boolean(codexConfig?.ok),
    codex_config_readable_by_codex_cli: false,
    codex_config_readable_in_zellij_context: false,
    codex_app_ready: false,
    primary_blocker: codexConfig?.ok ? null : 'codex_config_unreadable',
    blockers: codexConfig?.ok ? [] : ['codex_config_unreadable'],
    next_actions: codexConfig?.ok ? [] : ['Run `sks doctor --fix --json` to repair managed config.']
  };
  const codexNativeFeatureMatrix = fallbackCodexNativeFeatureMatrix(codex, [], ['native_feature_matrix_deferred_to_full_doctor_or_route_gate']);
  const zellijReadiness = buildZellijReadiness(root, { status: 'skipped', required_for: ['sks --mad', 'interactive lane UI'] }, ready);
  const runtimeReadiness = buildRuntimeReadiness(zellijReadiness, codexNativeFeatureMatrix);
  const deferredImagegen = deferredNativeRepair('sks.doctor-imagegen-repair.v1', false, [
    'Run `sks doctor --fix --repair-native-capabilities --json` after enabling Codex App image_generation.'
  ]);
  const deferredComputerUse = deferredNativeRepair('sks.doctor-computer-use-repair.v1', false, [
    'Computer Use route needs manual OS/App permission verification before use.'
  ]);
  const deferredBrowserUse = deferredNativeRepair('sks.doctor-browser-use-repair.v1', false, [
    'Chrome/web review route needs the Codex Chrome Extension enabled before use.'
  ]);
  const result = {
    schema: 'sks.doctor-status.v3',
    elapsed_ms: Date.now() - startedAtMs,
    ok: true,
    status: 'fast_readonly_ok',
    diagnostic_depth: 'fast',
    deep_diagnostics_skipped: true,
    deep_ok: null,
    not_counted_as_full_doctor: true,
    next_actions: ['Run sks doctor --full --json for deep diagnostics.'],
    root,
    fast_path: true,
    no_fix_write_policy: reportFile ? 'report_file_only' : 'no_writes_performed',
    arg_warnings: doctorArgWarnings(args),
    node: { ok: Number(process.versions.node.split('.')[0]) >= 20, version: process.version },
    codex,
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
      schema: 'sks.provider-context.v1',
      generated_at: nowIso(),
      provider: 'unknown',
      auth_mode: 'unknown',
      route: '$Doctor',
      service_tier: process.env.SKS_SERVICE_TIER || 'fast',
      source: 'skipped',
      confidence: 'low',
      conflict: false,
      warnings: ['provider_context_optional_diagnostic_skipped'],
      signals: {}
    },
    codex_lb: codexLbMetrics(await readCodexLbCircuit(root).catch(() => ({}))),
    codex_doctor: null,
    pre_repair_codex_doctor: null,
    post_repair_codex_doctor: null,
    codex_doctor_diff: null,
    observational_codex_doctor_diff: null,
    zellij: { ok: true, skipped: true, status: 'skipped_fast_path', required_for: ['sks --mad', 'interactive lane UI'] },
    zellij_repair: { schema: 'sks.zellij-self-heal.v1', ok: true, skipped: true, blockers: [], warnings: ['zellij_repair_deferred_to_full_doctor_or_route_gate'] },
    context7_repair: { schema: 'sks.doctor-context7-repair.v1', ok: true, fix: false, skipped: true, actions: [], blockers: [], warnings: ['context7_repair_deferred_to_fix'] },
    codex_startup_repair: { schema: 'sks.doctor-codex-startup-repair.v1', ok: true, fix: false, skipped: true, actions: [], blockers: [], warnings: ['codex_startup_repair_deferred_to_fix'] },
    startup_config_repair: null,
    context7_mcp_repair: null,
    supabase_mcp_repair: null,
    doctor_fix_transaction: null,
    doctor_fix_postcheck: null,
    postcheck: null,
    local_model: null,
    agent_role_config: { schema: 'sks.agent-role-config-repair.v1', ok: true, apply: false, skipped: true, blockers: [] },
    zellij_readiness: zellijReadiness,
    codex_permission_profiles: { skipped: true, reason: 'doctor_json_fast_path_optional_diagnostics_skipped' },
    command_aliases: { schema: 'sks.command-alias-cleanup.v1', ok: true, skipped: true, reason: 'doctor_json_fast_path_no_write' },
    sks_temp_sweep: { ok: true, skipped: true, action_count: 0, reason: 'doctor_without_fix', error: null },
    imagegen: { ok: false, auth_readiness: null, codex_app_builtin_available: false },
    imagegen_repair: deferredImagegen,
    codex_0138: { capability: null, doctor: { schema: 'sks.codex-0138-doctor.v1', ok: true, skipped: true, blockers: [], warnings: ['historical_codex_0138_doctor_skipped'] }, plugins: null, plugin_app_template_policy: null, mcp_plugin_inventory: null },
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
      zellij: null,
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

async function runDoctor(args: any = [], root: string, doctorFix: boolean) {
  const startedAtMs = Date.now();
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
  const shouldRunZellijRepair = deepDiagnostics || flag(args, '--repair-zellij') || flag(args, '--install-homebrew') || process.env.SKS_REQUIRE_ZELLIJ === '1';
  const nativeCapabilityDiagnosticsRequested = deepDiagnostics || flag(args, '--repair-native-capabilities');
  const doctorPhaseIds = doctorPhaseIdsForProfile(doctorProfile);
  const { runDoctorCommandAliasCleanup } = await import('../core/doctor/command-alias-cleanup.js');
  const { runDoctorNativeCapabilityRepair } = await import('../core/doctor/doctor-native-capability-repair.js');
  const { runDoctorCodexStartupRepair } = await import('../core/doctor/doctor-codex-startup-repair.js');
  const { runDoctorContext7Repair } = await import('../core/doctor/doctor-context7-repair.js');
  const { compareCodexDoctorBridge, runCodexDoctorBridge } = await import('../core/doctor/codex-doctor-bridge.js');
  const { repairCodexAppFastUi } = await import('../core/codex-app/codex-app-fast-ui-repair.js');
  const { runDoctorZellijRepair, doctorZellijRepairConsoleLine } = await import('../core/doctor/doctor-zellij-repair.js');
  const { repairAgentRoleConfigs } = await import('../core/agents/agent-role-config.js');
  const { runCodex0138Doctor } = await import('../core/doctor/codex-0138-doctor.js');
  const { writeDoctorReadinessMatrix } = await import('../core/doctor/doctor-readiness-matrix.js');
  const doctorDirtyPlan = doctorFix ? (await import('../core/doctor/doctor-dirty-planner.js')).planDoctorDirtyRepair(root, doctorPhaseIds) : null;
  let setupRepair = null;
  let sksUpdate: any = null;
  let openRouterProviderRepair: any = { ok: true, status: 'skipped', reason: 'doctor_without_fix' };
  let migrationPreFix: Record<string, string | null> | null = null;
  if (doctorFix) {
    migrationPreFix = await captureCodexConfigSnapshot();
    const installScope = installScopeFromArgs(args);
    openRouterProviderRepair = flag(args, '--local-only')
      ? { ok: true, status: 'skipped', reason: 'local-only repair' }
      : await (await import('../cli/install-helpers.js')).ensureStoredOpenRouterProviderDuringInstall().catch((err: any) => ({
          schema: 'sks.openrouter-provider-upgrade-repair.v1',
          ok: false,
          status: 'failed',
          blockers: ['openrouter_provider_repair_failed'],
          error: err?.message || String(err)
        }));
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
  const skillsReconcile = await reconcileDoctorSkills(root, doctorFix);
  const commandAliasCleanup = await runDoctorCommandAliasCleanup({
    root,
    fix: doctorFix
  }).catch((err: any) => ({
    schema: 'sks.command-alias-cleanup.v1',
    ok: false,
    status: 'blocked',
    root,
    fix: doctorFix,
    report_path: `${root}/.sneakoscope/reports/command-alias-cleanup.json`,
    canonical_command_count: 0,
    current_alias_count: 0,
    detected: { registered_alias_commands: [], catalog_alias_rows: [], missing_canonical_targets: [] },
    actions: [],
    blockers: [err?.message || String(err)]
  }));
  const doctorNativeCapabilityRepair = await runDoctorNativeCapabilityRepair({
    root,
    fix: nativeCapabilityDiagnosticsRequested && doctorFix,
    yes: flag(args, '--yes') || flag(args, '-y'),
    flags: args.map((arg: any) => String(arg)),
    skipNativeCapabilities: !nativeCapabilityDiagnosticsRequested
  }).catch((err: any) => ({
    schema: 'sks.doctor-native-capability-repair.v1',
    ok: false,
    root,
    fix: doctorFix,
    yes: flag(args, '--yes') || flag(args, '-y'),
    core_skills: null,
    skill_dedupe: null,
    native_capabilities: null,
    secret_preservation_guard: '.sneakoscope/reports/secret-preservation-guard.json',
    core_blockers: [err?.message || String(err)],
    route_blockers: {},
    optional_manual_required: [],
    optional_warnings: [],
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
  const codexLbCircuit = codexLbMetrics(await readCodexLbCircuit(root).catch(() => ({})));
  const codexLbProviderStatus = deepDiagnostics || doctorFix
    ? await codexLbStatus({
        probeToolOutputRecovery: true,
        allowUnverifiedToolOutputRecovery: codexLbToolOutputRecoveryOverrideAcknowledged({ args })
      }).catch((err: any) => ({
        selected: null,
        provider_ready: false,
        recovery_probe_failed: true,
        tool_output_recovery: {
          ok: false,
          status: 'probe_failed',
          blockers: ['codex_lb_tool_output_recovery_status_probe_failed'],
          operator_actions: []
        },
        error: err?.message || String(err)
      }))
    : null;
  const codexLbRecoveryReady = codexLbRecoveryStatusReady(codexLbProviderStatus, deepDiagnostics || doctorFix);
  const codexLb = {
    ...codexLbCircuit,
    provider_status: codexLbProviderStatus,
    tool_output_recovery: codexLbProviderStatus?.tool_output_recovery || null,
    recovery_ok: codexLbRecoveryReady
  };
  const providerContext = deepDiagnostics
    ? await resolveProviderContext({ root, route: '$Doctor', serviceTier: process.env.SKS_SERVICE_TIER || 'fast' }).catch((err: any) => ({
        schema: 'sks.provider-context.v1',
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
          codex_lb_key_present: false,
          codex_lb_explicit: false,
          codex_app_auth_present: false,
          model_provider: null
        }
      }))
    : {
        schema: 'sks.provider-context.v1',
        generated_at: new Date().toISOString(),
        provider: 'unknown',
        auth_mode: 'unknown',
        route: '$Doctor',
        service_tier: process.env.SKS_SERVICE_TIER || 'fast',
        source: 'skipped',
        confidence: 'low',
        conflict: false,
        warnings: ['provider_context_optional_diagnostic_skipped'],
        signals: {
          openai_api_key_present: false,
          codex_lb_key_present: false,
          codex_lb_explicit: false,
          codex_app_auth_present: false,
          model_provider: null
        }
      };
  const explicitCodexAppUiRepair = flag(args, '--repair-codex-app-ui');
  const codexAppUiPlan = shouldEvaluateCodexAppUiRepair
    ? await repairCodexAppFastUi(root, {
        apply: false,
        reportPath: `${root}/.sneakoscope/reports/codex-app-fast-ui-repair-plan.json`
      }).catch((err: any) => ({
        schema: 'sks.codex-app-fast-ui-repair.v1',
        ok: false,
        apply: false,
        safe_auto_apply: false,
        requires_confirmation: true,
        fast_selector: 'manual_action_required',
        provider_selector: 'ok',
        host_owned_config: 'diagnostic_failed',
        next_action: 'Review Codex App UI config manually.',
        actions: [],
        blockers: [err?.message || String(err)]
      }))
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
      }).catch((err: any) => ({
        schema: 'sks.codex-app-fast-ui-repair.v1',
        ok: false,
        apply: true,
        safe_auto_apply: false,
        requires_confirmation: true,
        fast_selector: 'manual_action_required',
        provider_selector: 'ok',
        host_owned_config: 'diagnostic_failed',
        next_action: 'Review Codex App UI config manually.',
        actions: [],
        blockers: [err?.message || String(err)]
      }))
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
      'Rotate CODEX_LB_API_KEY and OPENROUTER_API_KEY if they were previously exposed in launchd.'
    ],
    blockers: [err?.message || String(err)],
    warnings: []
  }));
  const zellijRepair = shouldRunZellijRepair
    ? await runDoctorZellijRepair({ root, args, doctorFix }).catch((err: any) => ({
        schema: 'sks.zellij-self-heal.v1',
        ok: false,
        requested_by: 'doctor --fix',
        fix_requested: doctorFix,
        auto_approved: flag(args, '--yes') || flag(args, '-y'),
        install_homebrew_allowed: false,
        before: { status: 'unknown', version: null, bin: null },
        latest_version: null,
        strategy: 'failed',
        command: 'sks doctor --fix --yes',
        after: { status: 'unknown', version: null, bin: null },
        mutation_guard_artifact: null,
        homebrew: { present: false, bin: null, install_attempted: false, install_allowed: false },
        blockers: [err?.message || String(err)],
        warnings: []
      }))
    : {
        schema: 'sks.zellij-self-heal.v1',
        ok: true,
        skipped: true,
        requested_by: 'doctor --fix',
        fix_requested: doctorFix,
        auto_approved: false,
        install_homebrew_allowed: false,
        before: { status: 'skipped', version: null, bin: null },
        latest_version: null,
        strategy: 'deferred',
        command: 'sks doctor --fix --full --yes',
        after: { status: 'skipped', version: null, bin: null },
        mutation_guard_artifact: null,
        homebrew: { present: false, bin: null, install_attempted: false, install_allowed: false },
        blockers: [],
        warnings: ['zellij_repair_deferred_to_full_doctor_or_route_gate']
      };
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
  const hookTrustRepair = doctorFix && doctorPhaseIds.includes('hook_trust_repair')
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
            run: async () => ({
              id: 'startup_config_repair',
              ok: (startupConfigRepair as any)?.ok === true,
              repaired: (startupConfigRepair as any)?.apply === true,
              blockers: (startupConfigRepair as any)?.blockers || [],
              rollback_evidence: (startupConfigRepair as any)?.backup_path || 'startup_config_repair_idempotent_report'
            })
          },
          {
            id: 'context7_repair',
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
            run: async () => ({
              id: 'hook_trust_repair',
              ok: (hookTrustRepair as any)?.ok !== false,
              repaired: doctorFix,
              blockers: (hookTrustRepair as any)?.blockers || [],
              warnings: (hookTrustRepair as any)?.warnings || [],
              rollback_evidence: (hookTrustRepair as any)?.fixed?.managed_hook_file || 'codex_hook_trust_repair_idempotent'
            })
          },
          {
            id: 'sks_menubar',
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
              const status = await inspectSksMenuBarStatus({ root }).catch((err: any) => ({
                ok: false,
                launchd: { ok: false, state: null, pid: null, error: err?.message || String(err) },
                action_target: { ok: false, smoke_code: null, smoke_output: null },
                blockers: [err?.message || String(err)],
                warnings: []
              } as any));
              const blockers = [
                ...((status as any).launchd?.ok === true ? [] : [`launchd_not_running:${(status as any).launchd?.error || (status as any).launchd?.state || 'unknown'}`]),
                ...((status as any).action_target?.ok === true ? [] : [`action_script_smoke_failed:${(status as any).action_target?.smoke_code ?? 'no_code'}`]),
                ...((status as any).ok === true ? [] : ((status as any).blockers || ['menubar_status_not_ok']))
              ];
              return {
                ok: blockers.length === 0,
                blockers,
                warnings: [
                  ...((status as any).warnings || []),
                  blockers.length === 0 ? 'menubar_postcheck_passed' : 'menubar_postcheck_failed'
                ]
              };
            }
          },
          {
            id: 'command_alias_cleanup',
            run: async () => ({
              id: 'command_alias_cleanup',
              ok: (commandAliasCleanup as any)?.ok !== false,
              repaired: Array.isArray((commandAliasCleanup as any)?.actions) && (commandAliasCleanup as any).actions.length > 0,
              blockers: (commandAliasCleanup as any)?.blockers || [],
              rollback_evidence: (commandAliasCleanup as any)?.report_path || 'command_alias_cleanup_report'
            })
          },
          {
            id: 'native_capability_repair',
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
  const zellij = await checkZellijCapability({ root, require: process.env.SKS_REQUIRE_ZELLIJ === '1' });
  const localModel = await readLocalModelConfig().catch(() => null);
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
  const codex0138Capability = deepDiagnostics
    ? await writeCodex0138CapabilityArtifacts(root, { codexBin: codexBin || null }).catch((err: any) => ({ error: err?.message || String(err), report: null }))
    : { skipped: true, report: null };
  const codex0138Doctor = deepDiagnostics
    ? await runCodex0138Doctor(root, { fix: doctorFix }).catch((err: any) => ({ schema: 'sks.codex-0138-doctor.v1', ok: false, error: err?.message || String(err), blockers: ['codex_0138_doctor_exception'], warnings: [] }))
    : { schema: 'sks.codex-0138-doctor.v1', ok: true, skipped: true, blockers: [], warnings: ['historical_codex_0138_doctor_skipped'] };
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
  const ready = await writeDoctorReadinessMatrix(root, {
    codex,
    codex_config: codexConfig,
    codex_app: codexApp,
    codex_lb: codexLb,
    codex_doctor: authoritativeCodexDoctor,
    pre_repair_codex_doctor: preRepairCodexDoctor,
    post_repair_codex_doctor: postRepairCodexDoctor,
    require_codex_doctor: deepDiagnostics || flag(args, '--require-actual-codex'),
    zellij,
    context7_repair: context7Repair,
    codex_startup_repair: codexStartupRepair,
    startup_config_repair: startupConfigRepair,
    context7_mcp_repair: context7McpRepair,
    supabase_mcp_repair: supabaseMcpRepair,
    doctor_fix_transaction: doctorFixTransaction,
    doctor_dirty_plan: doctorDirtyPlan,
    doctor_fix_postcheck: doctorFixPostcheck,
    doctor_native_capability: doctorNativeCapabilityRepair,
    skills: skillsReconcile,
    local_model: localModel,
    agent_role_config: agentRoleConfigRepair,
    repair: configRepair,
    codex_app_ui: codexAppUi,
    sks_menubar: sksMenuBar,
    codex_0138_doctor: codex0138Doctor,
    codex_plugin_inventory: (pluginInventory as any)?.report || null,
    codex_plugin_app_template_policy: pluginPolicy,
    codex_app_harness_matrix: codexAppHarnessMatrix,
    require_codex_cli_config_load: requireActualCodexProbe,
    operator_actions: [
      ...(codexConfig.operator_actions || []),
      ...(configRepair?.operator_actions || []),
      ...(zellijRepair && !(zellijRepair as any).ok && (zellijRepair as any).command ? [`Run: ${(zellijRepair as any).command}`] : []),
      ...((codexStartupRepair as any).manual_actions || []),
      ...(pluginPolicy?.doctor_warnings || [])
    ]
  });
  if (doctorFix) {
    const readinessBlockers = [
      ...(Array.isArray((ready as any).blockers) ? (ready as any).blockers.map(String).filter(Boolean) : []),
      ...((openRouterProviderRepair as any)?.ok === false
        ? (((openRouterProviderRepair as any)?.blockers || ['openrouter_provider_repair_failed']).map(String))
        : [])
    ];
    const migrationWarnings = [
      ...((doctorNativeCapabilityRepair as any)?.optional_warnings || []),
      ...((doctorFixPostcheck as any)?.optional_warnings || [])
    ];
    try {
      const receiptInput: Parameters<typeof writeProjectUpdateMigrationReceipt>[0] = {
        root,
        source: `doctor-${doctorProfile}`,
        blockers: readinessBlockers,
        warnings: migrationWarnings
      };
      if (readinessBlockers.length) receiptInput.status = 'blocked';
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
  const zellijReadiness = buildZellijReadiness(root, zellij as any, ready as any);
  const runtimeReadiness = buildRuntimeReadiness(zellijReadiness, codexNativeFeatureMatrix as any);
  const resultOk = ready.ready
    && (!sksUpdate || (sksUpdate as any).ok !== false)
    && (commandAliasCleanup as any).ok !== false
    && (codexStartupRepair as any).ok !== false
    && (agentRoleConfigRepair as any).ok !== false
    && (openRouterProviderRepair as any).ok !== false
    && ((officialSubagentConfig as any).blockers || []).length === 0
    && codexLbRecoveryReady;
  const result = {
    schema: 'sks.doctor-status.v3',
    elapsed_ms: Date.now() - startedAtMs,
    ok: resultOk,
    status: resultOk ? (doctorFix ? 'fix_ok' : deepDiagnostics ? 'full_ok' : 'fast_ok') : 'blocked',
    diagnostic_depth: deepDiagnostics ? 'full' : doctorFix ? 'fix' : 'fast',
    deep_diagnostics_skipped: !deepDiagnostics,
    deep_ok: deepDiagnostics ? resultOk : null,
    not_counted_as_full_doctor: !deepDiagnostics,
    root,
    arg_warnings: argWarnings,
    node: { ok: Number(process.versions.node.split('.')[0]) >= 20, version: process.version },
    codex,
    codex_config: codexConfig,
    rust,
    codex_app: codexApp,
    codex_app_ui: codexAppUi,
    openrouter_provider: openRouterProviderRepair,
    sks_menubar: sksMenuBar,
    provider_context: providerContext,
    codex_lb: codexLb,
    codex_doctor: authoritativeCodexDoctor,
    pre_repair_codex_doctor: preRepairCodexDoctor,
    post_repair_codex_doctor: postRepairCodexDoctor,
    codex_doctor_diff: codexDoctorAuthoritativeDiff,
    observational_codex_doctor_diff: codexDoctorDiff,
    zellij,
    zellij_repair: zellijRepair,
    context7_repair: context7Repair,
    codex_startup_repair: codexStartupRepair,
    startup_config_repair: startupConfigRepair,
    context7_mcp_repair: context7McpRepair,
    supabase_mcp_repair: supabaseMcpRepair,
    doctor_fix_transaction: doctorFixTransaction,
    doctor_fix_postcheck: doctorFixPostcheck,
    postcheck: doctorFixPostcheck ? {
      ok: (doctorFixPostcheck as any).ok === true,
      pending_manual: (doctorFixPostcheck as any).pending_manual || [],
      required_blockers: (doctorFixPostcheck as any).required_blockers || [],
      optional_warnings: (doctorFixPostcheck as any).optional_warnings || []
    } : null,
    local_model: localModel,
    agent_role_config: agentRoleConfigRepair,
    official_subagent_config: officialSubagentConfig,
    zellij_readiness: zellijReadiness,
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
    codex_0138: {
      capability: (codex0138Capability as any).report || null,
      doctor: codex0138Doctor,
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
    repair: { sks_update: sksUpdate, setup: setupRepair, openrouter_provider: openRouterProviderRepair, codex_config: configRepair, migration_journal: migrationJournal, global_sks_installs: globalSksInstallCleanup, agent_role_config: agentRoleConfigRepair, zellij: zellijRepair, context7: context7Repair, codex_startup: codexStartupRepair, startup_config: startupConfigRepair, context7_mcp: context7McpRepair, supabase_mcp: supabaseMcpRepair, mcp_transport_collision: mcpTransportCollisionRepair, imagegen: imagegenRepair, computer_use: computerUseRepair, browser_use: browserUseRepair, hook_trust: hookTrustRepair, sks_menubar: sksMenuBar, doctor_transaction: doctorFixTransaction, doctor_dirty_plan: doctorDirtyPlan, doctor_postcheck: doctorFixPostcheck, codex_native: codexNativeRepair, doctor_native_capability: doctorNativeCapabilityRepair, command_aliases: commandAliasCleanup, skills: skillsReconcile, sks_temp_sweep: sksTempSweep }
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
  console.log('SKS Doctor');
  for (const warning of argWarnings) console.log(`Argument warning: ${warning}`);
  for (const warning of (officialSubagentConfig as any).warnings || []) console.log(`Official subagent warning: ${warning}`);
  console.log(`Root:      ${root}`);
  console.log(`Node:      ${result.node.ok ? 'ok' : 'fail'} ${result.node.version}`);
  console.log(`Codex:     ${codex.bin ? 'ok' : 'missing'} ${codex.version || ''}`);
  const actual = (codexConfig.checks || []).find((check: any) => check.name === 'actual_codex_cli_config_load');
  console.log('Project config:');
  console.log(`  node read:       ${ready.codex_config_readable_by_node ? 'ok' : 'failed'}`);
  console.log(`  codex cli read:  ${ready.codex_config_readable_by_codex_cli ? 'ok' : (actual?.status || 'failed')}`);
  console.log('Zellij:');
  console.log(`  binary:      ${zellijReadiness.binary} ${zellijReadiness.version || ''} ${zellijReadiness.status === 'ok' ? 'ok' : zellijReadiness.status}`);
  console.log(`  required_for: ${zellijReadiness.required_for.join(', ')}`);
  console.log(`  layout:      ${zellijReadiness.layout_proof}`);
  console.log(`  pane proof:  ${zellijReadiness.pane_proof}`);
  console.log(`  screen proof:${zellijReadiness.screen_proof}`);
  const zellijRepairLine = doctorZellijRepairConsoleLine(zellijRepair as any);
  if (zellijRepairLine) console.log(zellijRepairLine);
  console.log('Context7 MCP:');
  console.log(`  transport: ${(context7Repair as any).preferred_transport || 'remote'}`);
  console.log(`  repair: ${(context7Repair as any).ok ? 'ok' : 'blocked'}`);
  for (const action of (context7Repair as any).actions || []) console.log(`  - ${action}`);
  for (const warning of (context7Repair as any).warnings || []) console.log(`  warning: ${warning}`);
  console.log('Codex startup config:');
  console.log(`  repair: ${(codexStartupRepair as any).ok ? 'ok' : 'blocked'}`);
  for (const action of (codexStartupRepair as any).actions || []) console.log(`  - ${action}`);
  for (const action of (codexStartupRepair as any).manual_actions || []) console.log(`  manual: ${action}`);
  for (const warning of (codexStartupRepair as any).warnings || []) console.log(`  warning: ${warning}`);
  console.log(`  codex doctor:    ${formatCodexDoctorConsoleStatus(authoritativeCodexDoctor)}`);
  console.log(`Rust acc.: ${rust.mode || (rust.available ? 'rust_accelerated' : 'js_fallback')} ${rust.version || rust.status || ''}`);
  console.log(`Codex App: ${ready.codex_app_ready ? 'ok' : 'optional_missing'}`);
  console.log('SKS Runtime Readiness:');
  console.log(`  Zellij: ${runtimeReadiness.zellij}`);
  console.log(`  Codex Native: ${runtimeReadiness.codex_native}`);
  console.log(`  Loop Mesh: ${runtimeReadiness.loop_mesh}`);
  console.log(`  QA Visual: ${runtimeReadiness.qa_visual}`);
  console.log(`  Research Sources: ${runtimeReadiness.research_sources}`);
  console.log(`  Image Follow-up: ${runtimeReadiness.image_followup}`);
  for (const note of runtimeReadiness.notes) console.log(`  ${note}`);
  if (runtimeReadiness.repair_actions.length) {
    console.log('Repair actions:');
    for (const action of runtimeReadiness.repair_actions) console.log(`  - ${action}`);
  }
  const nativeCapabilityRows = Array.isArray((doctorNativeCapabilityRepair as any)?.native_capabilities?.capabilities)
    ? (doctorNativeCapabilityRepair as any).native_capabilities.capabilities
    : [];
  console.log('SKS Native Capabilities:');
  console.log(`  image generation: ${nativeCapabilityStatus(nativeCapabilityRows, 'image_generation', 'repair_required')}`);
  console.log(`  image follow-up edit: ${nativeCapabilityStatus(nativeCapabilityRows, 'image_followup_edit', 'degraded')}`);
  console.log(`  computer use: ${nativeCapabilityStatus(nativeCapabilityRows, 'computer_use', 'manual_required')}`);
  console.log(`  Chrome/web review: ${nativeCapabilityStatus(nativeCapabilityRows, 'chrome_web_review', 'manual_required')}`);
  console.log(`  app screenshot: ${nativeCapabilityStatus(nativeCapabilityRows, 'codex_app_screenshot', 'degraded')}`);
  console.log(`  app handoff: ${nativeCapabilityStatus(nativeCapabilityRows, 'app_handoff', 'unavailable')}`);
  console.log(`  image path exposure: ${nativeCapabilityStatus(nativeCapabilityRows, 'image_path_exposure', 'fallback')}`);
  const nativeManualActions = uniqueNativeManualActions(nativeCapabilityRows);
  if (nativeManualActions.length) {
    console.log('  manual next actions:');
    for (const action of nativeManualActions) console.log(`    - ${action}`);
  }
  console.log('SKS Skills:');
  console.log(`  core skills: ${doctorSkillStatus((doctorNativeCapabilityRepair as any)?.core_skills)}`);
  console.log(`  duplicate project skills: ${doctorDedupeStatus((doctorNativeCapabilityRepair as any)?.skill_dedupe)}`);
  console.log('SKS Current Command Surface:');
  console.log(`  status: ${(commandAliasCleanup as any).status || ((commandAliasCleanup as any).ok ? 'clean' : 'blocked')}`);
  console.log(`  canonical commands: ${(commandAliasCleanup as any).canonical_command_count ?? 0}`);
  const managedRuntimeCleanup = (commandAliasCleanup as any)?.cleanup?.managed_runtime;
  if (managedRuntimeCleanup) {
    console.log(`  managed items reconciled: ${managedRuntimeCleanup.removed_managed_artifact_count ?? 0}`);
    console.log(`  user-authored collisions preserved: ${managedRuntimeCleanup.preserved_user_file_count ?? 0}`);
  }
  if ((commandAliasCleanup as any).report_path) console.log(`  report: ${(commandAliasCleanup as any).report_path}`);
  console.log('Secret preservation:');
  console.log(`  Supabase keys: ${(doctorNativeCapabilityRepair as any)?.ok === false && String(((doctorNativeCapabilityRepair as any)?.blockers || []).join(' ')).includes('secret_preservation_failed') ? 'blocked' : 'preserved'}`);
  console.log('  raw secret values: never recorded');
  console.log(`  migration journal: ${(doctorNativeCapabilityRepair as any)?.secret_preservation_guard || '.sneakoscope/reports/secret-preservation-guard.json'}`);
  console.log('Codex App Harness:');
  console.log(`  plugins: ${(codexAppHarnessMatrix as any).app_features?.plugin_json ? 'ok' : 'degraded'}`);
  console.log(`  hook approval: ${(codexAppHarnessMatrix as any).app_features?.hook_approval_state_detectable ? 'ok' : 'unknown'}`);
  console.log(`  skills: ${(codexAppHarnessMatrix as any).sks_integrations?.dollar_skills_synced ? 'ok' : 'degraded'}`);
  console.log(`  agent roles: ${(codexAppHarnessMatrix as any).sks_integrations?.agent_roles_synced ? 'ok' : 'degraded'}`);
  console.log(`  native agent_type: ${(codexAppHarnessMatrix as any).app_features?.agent_type_supported ? 'ok' : 'fallback message-role'}`);
  console.log(`  init-deep memory: ${(codexAppHarnessMatrix as any).sks_integrations?.init_deep_available ? 'available' : 'missing'}`);
  console.log(`  loop mesh app profile: ${(codexAppHarnessMatrix as any).sks_integrations?.loop_mesh_app_profile_available ? 'available' : 'missing'}`);
  const codexAppUiStatus = codexAppUi as any;
  console.log('Codex App UI:');
  console.log(`  fast selector: ${codexAppUi.fast_selector || 'unknown'}`);
  console.log(`  provider selector: ${codexAppUi.provider_selector || 'unknown'}`);
  if (Array.isArray(codexAppUiStatus.provider_blockers) && codexAppUiStatus.provider_blockers.length) {
    console.log(`  provider blockers: ${codexAppUiStatus.provider_blockers.join(', ')}`);
  }
  if (Array.isArray(codexAppUiStatus.provider_actions) && codexAppUiStatus.provider_actions.length) {
    console.log('  provider actions:');
    for (const action of codexAppUiStatus.provider_actions) console.log(`    - ${action}`);
  }
  console.log(`  host-owned config: ${codexAppUi.host_owned_config || 'unknown'}`);
  if (Array.isArray(codexAppUi.actions) && codexAppUi.actions.some((action: any) => action.changed)) {
    console.log('  repaired files:');
    for (const action of codexAppUi.actions.filter((entry: any) => entry.changed)) console.log(`    - ${action.file}${action.backup_path ? ` (backup ${action.backup_path})` : ''}`);
  }
  if (codexAppUi.next_action) console.log(`  next action: ${codexAppUi.next_action}`);
  console.log('SKS Menu Bar:');
  console.log(`  status: ${(sksMenuBar as any).status || ((sksMenuBar as any).ok ? 'ok' : 'blocked')}`);
  const menubarPhase = (doctorFixTransaction as any)?.phases?.find((phase: any) => phase?.id === 'sks_menubar');
  if (menubarPhase) {
    const menubarSummary = menubarPhase.ok
      ? (menubarPhase.repaired ? 'repaired' : 'verified')
      : `blocked(${(menubarPhase.blockers || []).join(', ') || 'unknown'})`;
    console.log(`  menubar: ${menubarSummary}`);
  }
  if ((sksMenuBar as any).app_path) console.log(`  app: ${(sksMenuBar as any).app_path}`);
  if ((sksMenuBar as any).launch_agent_path) console.log(`  launch agent: ${(sksMenuBar as any).launch_agent_path}`);
  if (Array.isArray((sksMenuBar as any).blockers) && (sksMenuBar as any).blockers.length) console.log(`  blockers: ${(sksMenuBar as any).blockers.join(', ')}`);
  if (Array.isArray((sksMenuBar as any).warnings) && (sksMenuBar as any).warnings.length) console.log(`  warnings: ${(sksMenuBar as any).warnings.join(', ')}`);
  console.log(`Provider: ${providerContext.provider || 'unknown'} ${providerContext.service_tier || ''} (${providerContext.source || 'unknown'}, ${providerContext.confidence || 'low'})`);
  const imagegenReady = (imagegen as any).auth_readiness;
  if (imagegenReady) {
    const paths = imagegenReady.available_paths?.length ? imagegenReady.available_paths.join(', ') : 'none';
    console.log(`Image Gen: auth=${imagegenReady.auth_mode} | headless_auto=${imagegenReady.headless_auto_available ? 'available' : 'unavailable'} | paths: ${paths}`);
    if (!imagegenReady.headless_auto_available) {
      for (const action of imagegenReady.next_actions || []) console.log(`  - ${action}`);
    }
  }
  console.log(`Image Gen repair: ${nativeCapabilityReadiness.imagegen.status}`);
  for (const action of (imagegenRepair as any).manual_actions || []) console.log(`  - ${action}`);
  console.log(`Computer Use repair: ${(computerUseRepair as any).recovered ? 'ok' : (computerUseRepair as any).attempted ? 'blocked' : 'not-needed'}`);
  for (const action of (computerUseRepair as any).next_actions || []) console.log(`  - ${action}`);
  console.log(`Browser Use repair: ${(browserUseRepair as any).recovered ? 'ok' : (browserUseRepair as any).attempted ? 'blocked' : 'not-needed'}`);
  for (const action of (browserUseRepair as any).next_actions || []) console.log(`  - ${action}`);
  if (mcpTransportCollisionRepair) {
    const collisionCount = ((mcpTransportCollisionRepair as any).servers || []).filter((s: any) => s.status === 'collision_resolved').length;
    console.log(`MCP transport collision repair: ${(mcpTransportCollisionRepair as any).ok ? 'ok' : 'blocked'}${collisionCount ? ` (${collisionCount} resolved)` : ''}`);
  }
  {
    const manifestPath = path.join(root, '.sneakoscope', 'agent-bridge', 'manifest.json');
    const manifestExists = await exists(manifestPath);
    console.log(`Agent bridge: ${manifestExists ? 'manifest present' : 'not set up'}${manifestExists ? '' : ' — run `sks agent-bridge setup` to publish the manifest and register with an MCP host'}`);
  }
  const codex0138 = (codex0138Capability as any).report || {};
  console.log('Codex current compatibility:');
  console.log(`  target: ${CURRENT_CODEX_RELEASE_MANIFEST.targetTag}`);
  console.log(`  runtime: ${codex.version || 'unknown'}`);
  console.log(`  multi-agent mode: ${(codexNativeFeatureMatrix as any).features?.multi_agent_mode?.ok ? 'verified' : 'unverified'}`);
  console.log(`  rollout budget: ${(codexNativeFeatureMatrix as any).features?.rollout_budget?.ok ? 'verified' : 'unverified'}`);
  console.log(`  indexed search: ${(codexNativeFeatureMatrix as any).features?.indexed_web_search?.ok ? 'verified' : 'unverified'}`);
  console.log(`  current time: ${(codexNativeFeatureMatrix as any).features?.current_time_read?.ok ? 'verified' : 'unverified'}`);
  console.log('Historical compatibility: Codex 0.138 features:');
  console.log(`  /app handoff: ${codex0138.supports_app_handoff ? 'ok' : 'unavailable'}`);
  console.log(`  plugin JSON: ${codex0138.supports_plugin_json ? 'ok' : 'unavailable'}`);
  console.log(`  image path exposure: ${codex0138.supports_image_path_exposure ? 'ok' : 'unavailable'}`);
  console.log(`  OAuth MCP pre-refresh: ${codex0138.supports_oauth_mcp_prerefresh ? 'ok' : 'unavailable'}`);
  const plugins = (pluginInventory as any)?.report?.plugins || [];
  const remoteMcpCount = plugins.flatMap((plugin: any) => plugin.remote_mcp_servers || []).length;
  const unavailableTemplates = pluginPolicy?.unavailable_app_templates?.length || 0;
  console.log(`Codex plugins: ${(pluginInventory as any)?.report ? 'ok' : 'warning'}`);
  console.log(`  Remote MCP servers: ${remoteMcpCount} candidates`);
  console.log(`  Unavailable app templates: ${unavailableTemplates}`);
  for (const warning of pluginPolicy?.doctor_warnings || []) console.log(`  warning: ${warning}`);
  if ((codex0138Doctor as any)?.fixed?.length) console.log(`  doctor --fix repaired: ${(codex0138Doctor as any).fixed.join(', ')}`);
  console.log(`codex-lb:  ${codexLb.ok ? 'ok' : `warning ${codexLb.circuit?.state || 'unknown'}`}`);
  if (codexLb.tool_output_recovery) {
    const recovery: any = codexLb.tool_output_recovery;
    console.log(`  interrupted tool-output recovery: ${recovery.ok ? 'ready' : 'blocked'} (${recovery.observed_version || recovery.status}; minimum ${recovery.minimum_version})`);
    if (!recovery.ok) for (const action of recovery.operator_actions || []) console.log(`  action: ${action}`);
  }
  if (localModel) {
    console.log('Local LLM:');
    console.log(`  enabled: ${localModel.enabled ? 'yes' : 'no'}`);
    console.log(`  status: ${localModel.status}`);
    console.log(`  provider: ${localModel.provider}`);
    console.log(`  model: ${localModel.model}`);
    console.log(`  endpoint: ${localModel.base_url}`);
    console.log(`  last smoke: ${localModel.last_smoke?.ok ? `ok ${localModel.last_smoke.latency_ms || 0}ms ${localModel.last_smoke.tokens_per_second || 0} tok/s` : 'missing'}`);
    console.log('  final arbiter: GPT required');
  }
  console.log(`Permissions: config profile and permission profile are tracked separately (${permissionProfiles.codex_config_profile_field}, ${permissionProfiles.codex_permission_profile_field})`);
  console.log('Ready:');
  console.log(`  cli_ready: ${ready.cli_ready ? 'yes' : 'no'}`);
  console.log(`  mad_ready: ${ready.mad_ready ? 'yes' : 'no'}`);
  console.log(`  managed_state_current: ${ready.managed_state_current ? 'yes' : 'no'}`);
  console.log(`  ready:     ${ready.ready ? 'yes' : 'no'}`);
  if (!ready.ready) {
    console.log('Primary blocker:');
    console.log(`  ${ready.primary_blocker || 'unknown'}`);
  }
  if (configRepair?.repair_actions?.length) {
    console.log('What I fixed:');
    for (const action of configRepair.repair_actions) console.log(`  - ${action.name}: ${action.ok ? 'ok' : 'failed'}`);
  }
  if (migrationJournal?.journal_path) {
    console.log(`Migration journal: ${migrationJournal.journal_path} (${migrationJournal.event_count} events, ${migrationJournal.mutations_without_rollback} without rollback)`);
  }
  if (sksUpdate) {
    console.log(`SKS update: ${(sksUpdate as any).status}${(sksUpdate as any).latest ? ` latest ${(sksUpdate as any).latest}` : ''}${(sksUpdate as any).error ? ` (${(sksUpdate as any).error})` : ''}`);
  }
  if (globalSksInstallCleanup) {
    console.log(`Global SKS installs: kept ${(globalSksInstallCleanup as any).kept?.length ?? 0}, removed ${(globalSksInstallCleanup as any).removed?.filter((entry: any) => entry.ok).length ?? 0}, source repo exempt ${(globalSksInstallCleanup as any).candidates?.filter((entry: any) => entry.source_repo_exempt).length ?? 0}`);
    if ((globalSksInstallCleanup as any).npm_cache) console.log(`NPM cache cleanup: ${(globalSksInstallCleanup as any).npm_cache.status}`);
  }
  if (!ready.ready && ready.next_actions?.length) {
    console.log('What still needs you:');
    for (const action of ready.next_actions) console.log(`  - ${action}`);
  }
  if (!result.ok) process.exitCode = 1;
}

function buildRuntimeReadiness(zellijReadiness: any, matrix: any) {
  const defaults = matrix?.invocation_defaults || {};
  const hookPolicy = defaults.hook_evidence_policy || 'unknown-do-not-count';
  const agentStrategy = defaults.loop_worker_role_strategy || 'message-role';
  const multiAgentMode = defaults.multi_agent_mode || 'none';
  const rolloutBudget = defaults.rollout_budget_strategy || 'sks-local-only';
  const researchSource = defaults.research_source_strategy || 'local-files';
  const zellijStatus = zellijReadiness?.status === 'ok'
    ? 'ok'
    : zellijReadiness?.cli_ready ? 'headless_available' : 'repair_required';
  const codexNative = matrix?.ok === true
    ? 'ok'
    : matrix?.codex_cli?.available ? 'degraded' : 'blocked';
  const repairActions: string[] = [];
  if (zellijStatus !== 'ok') {
    repairActions.push('Zellij: sks doctor --fix --yes');
    repairActions.push('Homebrew + Zellij: sks doctor --fix --install-homebrew --yes');
  }
  if (codexNative !== 'ok') repairActions.push('Codex Native managed assets: sks doctor --fix --repair-codex-native --yes');
  if (matrix?.features?.project_memory?.ok !== true) repairActions.push('Project memory: sks codex-native init-deep --apply --directory-local');
  return {
    schema: 'sks.runtime-readiness-story.v1',
    zellij: zellijStatus,
    codex_native: codexNative,
    loop_mesh: agentStrategy === 'agent_type' ? 'ok' : 'fallback',
    qa_visual: defaults.qa_visual_review_strategy || 'blocked',
    research_sources: researchSource,
    image_followup: defaults.image_followup_strategy || 'blocked',
    hook_evidence_policy: hookPolicy,
    agent_role_strategy: agentStrategy,
    multi_agent_mode: multiAgentMode,
    rollout_budget_strategy: rolloutBudget,
    current_time_source: defaults.current_time_source || 'external-clock',
    overload_retry_policy: defaults.overload_retry_policy || 'generic',
    notes: [
      ...(zellijStatus === 'headless_available' ? ['MAD can run with --headless; live panes require repair'] : []),
      ...(hookPolicy !== 'approved-only' ? ['hook-derived evidence will not count'] : []),
      ...(agentStrategy !== 'agent_type' ? ['message-role fallback active'] : []),
      ...(multiAgentMode === 'proactive' ? [`Codex ${CURRENT_CODEX_RELEASE_MANIFEST.requiredCliVersion} multi-agent proactive mode available for Naruto-style routes`] : []),
      ...(rolloutBudget === 'codex-0144-shared' ? [`Codex ${CURRENT_CODEX_RELEASE_MANIFEST.requiredCliVersion} rollout budget can be recorded in route proof`] : []),
      ...(researchSource === 'indexed-web-search' ? [`Codex ${CURRENT_CODEX_RELEASE_MANIFEST.requiredCliVersion} indexed web search selected for source-intelligence routes`] : [])
    ],
    repair_actions: [...new Set(repairActions)]
  };
}

function deferredNativeRepair(schema: string, doctorFix: boolean, nextActions: string[]) {
  return {
    schema,
    generated_at: nowIso(),
    ok: true,
    skipped: true,
    status: 'deferred_to_explicit_native_capability_probe',
    attempted: false,
    apply: doctorFix,
    recovered: false,
    blockers: [],
    next_actions: nextActions,
    manual_actions: nextActions
  };
}

function fallbackCodexNativeFeatureMatrix(codex: any, blockers: string[] = [], warnings: string[] = []) {
  return {
    schema: 'sks.codex-native-feature-matrix.v1',
    ok: blockers.length === 0,
    skipped: blockers.length === 0,
    codex_cli: { available: Boolean(codex?.bin || codex?.available), version: codex?.version || null, bin: codex?.bin || null },
    features: {},
    invocation_defaults: {
      loop_worker_role_strategy: 'message-role',
      multi_agent_mode: 'none',
      rollout_budget_strategy: 'sks-local-only',
      qa_visual_review_strategy: 'route-gated',
      research_source_strategy: 'local-files',
      image_followup_strategy: 'artifact-path',
      hook_evidence_policy: 'unknown-do-not-count',
      skill_bridge_strategy: 'cli-only',
      current_time_source: 'external-clock',
      overload_retry_policy: 'generic'
    },
    blockers,
    warnings
  };
}

async function writeJsonReportFile(file: string, value: unknown): Promise<void> {
  const fsp = await import('node:fs/promises');
  const path = await import('node:path');
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function nativeCapabilityStatus(rows: any[], id: string, fallback: string): string {
  const row = rows.find((entry: any) => entry?.id === id);
  if (!row) return fallback;
  if (row.after === 'verified' || row.before === 'verified') return 'verified';
  if (id === 'image_path_exposure') {
    if (row.before === 'degraded' || row.after === 'degraded' || row.repairability === 'doctor-fix') return 'fallback';
    return fallback;
  }
  if (id === 'app_handoff') return 'unavailable';
  if (row.repairability === 'manual-required') return 'manual_required';
  if (row.before === 'degraded' || row.after === 'degraded') return 'degraded';
  if (row.repairability === 'doctor-fix') return row.after === 'blocked' ? 'blocked' : 'repair_required';
  if (row.repairability === 'unavailable') return 'unavailable';
  return fallback;
}

function uniqueNativeManualActions(rows: any[]): string[] {
  return [...new Set(rows
    .filter((row: any) => row?.repairability === 'manual-required' && row?.after !== 'verified')
    .flatMap((row: any) => Array.isArray(row.repair_actions) ? row.repair_actions : [])
    .filter((action: any) => typeof action === 'string' && action.trim()))];
}

function doctorSkillStatus(coreSkills: any): string {
  if (!coreSkills) return 'drift_detected';
  if (Array.isArray(coreSkills.restored) && coreSkills.restored.length) return 'repaired';
  if (Array.isArray(coreSkills.blockers) && coreSkills.blockers.length) return 'drift_detected';
  return 'current';
}

function doctorDedupeStatus(skillDedupe: any): string {
  if (!skillDedupe) return 'manual_required';
  if (Array.isArray(skillDedupe.actions) && skillDedupe.actions.some((action: any) => action.action === 'quarantined')) return 'repaired';
  if (Array.isArray(skillDedupe.blockers) && skillDedupe.blockers.length) return 'manual_required';
  return 'none';
}

function buildZellijReadiness(root: string, zellij: any, ready: any) {
  const status = String(zellij?.status || 'missing');
  const usable = status === 'ok';
  const proofStatus = usable ? 'optional' : 'unavailable';
  const readiness: Record<string, any> = {
    schema: 'sks.zellij-readiness.v1',
    binary: zellij?.bin || 'zellij',
    status,
    min_version: zellij?.min_version || '0.41.0',
    version: zellij?.version || null,
    required_for: zellij?.required_for || ['sks --mad', 'interactive lane UI'],
    layout_proof: proofStatus,
    pane_proof: proofStatus,
    screen_proof: proofStatus,
    mad_ready: ready?.mad_ready === true,
    cli_ready: ready?.cli_ready === true,
    ready_for_interactive_runtime: ready?.codex_config_readable_in_zellij_context === true
  };
  return readiness;
}

async function codexHomeConfigPath(): Promise<string> {
  const path = await import('node:path');
  const os = await import('node:os');
  const home = process.env.CODEX_HOME || path.join(process.env.HOME || os.homedir(), '.codex');
  return path.join(home, 'config.toml');
}

async function captureCodexConfigSnapshot(): Promise<Record<string, string | null>> {
  const fsp = await import('node:fs/promises');
  const path = await import('node:path');
  const read = async (p: string | null | undefined) => {
    if (!p) return null;
    try { return await fsp.readFile(p, 'utf8'); } catch { return null; }
  };
  const root = await projectRoot();
  const projectPath = root ? path.join(root, '.codex', 'config.toml') : null;
  const homePath = await codexHomeConfigPath();
  return {
    project_path: projectPath,
    project_text: await read(projectPath),
    home_path: homePath,
    home_text: await read(homePath)
  };
}

async function writeFixMigrationJournal(
  root: string,
  preFix: Record<string, string | null> | null,
  configRepair: any,
  setupRepair: any
) {
  if (!preFix) return null;
  const fsp = await import('node:fs/promises');
  const read = async (p: string | null | undefined) => {
    if (!p) return null;
    try { return await fsp.readFile(p, 'utf8'); } catch { return null; }
  };
  const projectAfter = await read(preFix.project_path);
  const homeAfter = await read(preFix.home_path);
  const structureRepairs: any[] = Array.isArray(configRepair?.structure_repairs) ? configRepair.structure_repairs : [];
  const projectStructure = structureRepairs.find((repair) => repair.scope === 'project');
  const homeStructure = structureRepairs.find((repair) => repair.scope === 'codex_home');
  const events = [
    {
      step: 'doctor_fix_project_config',
      target: preFix.project_path || '.codex/config.toml',
      beforeHash: preFix.project_text != null ? hashConfigText(preFix.project_text) : null,
      afterHash: projectAfter != null ? hashConfigText(projectAfter) : null,
      backupPath: setupRepair?.config_backup_path || projectStructure?.backup_path || configRepair?.policy?.backup_path || null
    },
    {
      step: 'doctor_fix_codex_home_config',
      target: preFix.home_path || '~/.codex/config.toml',
      beforeHash: preFix.home_text != null ? hashConfigText(preFix.home_text) : null,
      afterHash: homeAfter != null ? hashConfigText(homeAfter) : null,
      backupPath: homeStructure?.backup_path || null
    }
  ].filter((event) => event.beforeHash != null || event.afterHash != null);
  if (!events.length) return null;
  return appendMigrationEvents(root, events);
}

async function backupProjectConfigBeforeFix(): Promise<string | null> {
  try {
    const fsp = await import('node:fs/promises');
    const path = await import('node:path');
    const root = await projectRoot();
    if (!root) return null;
    const configPath = path.join(root, '.codex', 'config.toml');
    if (!(await exists(configPath))) return null;
    const text = await fsp.readFile(configPath, 'utf8');
    const backupPath = `${configPath}.doctor-pre-fix-${Date.now().toString(36)}.bak`;
    await fsp.writeFile(backupPath, text);
    return backupPath;
  } catch {
    return null;
  }
}

function installScopeFromArgs(args: any = []) {
  if (flag(args, '--project')) return 'project';
  if (flag(args, '--global')) return 'global';
  const index = args.indexOf('--install-scope');
  return normalizeInstallScope(index >= 0 && args[index + 1] ? args[index + 1] : 'global');
}

function readOption(args: any = [], name: string, fallback: any = null) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

export function formatCodexDoctorConsoleStatus(report: any) {
  if (!report || report.available !== true) return 'unavailable';
  return report.disposition || (report.exit_code === 0 ? 'pass' : 'warn');
}

function mergeObservedCodexStartupWarnings(startupRepair: any, codexDoctor: any) {
  const text = `${codexDoctor?.stdout_tail || ''}\n${codexDoctor?.stderr_tail || ''}`;
  const manual = new Set<string>(Array.isArray(startupRepair?.manual_actions) ? startupRepair.manual_actions : []);
  const warnings = new Set<string>(Array.isArray(startupRepair?.warnings) ? startupRepair.warnings : []);
  const blockers = new Set<string>(Array.isArray(startupRepair?.blockers) ? startupRepair.blockers : []);
  if (/codex_apps[\s\S]{0,500}token_expired|token_expired[\s\S]{0,500}codex_apps/i.test(text)) {
    manual.add('Codex Apps MCP token is expired; sign in to Codex App/CLI again so the connector can mint a fresh token.');
    warnings.add('codex_apps_token_expired_observed');
    blockers.add('codex_apps_token_expired_manual_reauth_required');
  }
  if (/SUPABASE_ACCESS_TOKEN[\s\S]{0,500}mcp server ['"`]?supabase['"`]?|mcp server ['"`]?supabase['"`]?[\s\S]{0,500}SUPABASE_ACCESS_TOKEN/i.test(text)) {
    manual.add('Supabase MCP uses SUPABASE_ACCESS_TOKEN but the variable is unset; export the token or migrate that server to a read-only remote URL.');
    warnings.add('supabase_access_token_missing_observed');
    blockers.add('supabase_access_token_missing_manual_auth_required');
  }
  if (/node_repl[\s\S]{0,500}No such file or directory|No such file or directory[\s\S]{0,500}node_repl/i.test(text)) {
    warnings.add('node_repl_missing_command_observed');
  }
  return {
    ...startupRepair,
    ok: blockers.size === 0 && startupRepair?.ok !== false,
    manual_actions: [...manual],
    warnings: [...warnings],
    blockers: [...blockers]
  };
}
