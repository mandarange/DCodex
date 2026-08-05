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
import { probeTelegram, telegramSelfHealAction } from '../core/telegram/doctor.js';
import { TelegramClient, type TelegramTokenProvider } from '../core/telegram/client.js';
import { resolveTelegramBotToken } from '../core/telegram/keychain.js';
import { telegramLivenessPath } from '../core/telegram/liveness.js';
import { inspectCodexConfigReadability } from '../core/codex/codex-config-readability.js';
import {
  inspectOAuthCallbackPortConflict,
  oauthCallbackDoctorGuidance
} from '../core/codex/oauth-callback-port-diagnostic.js';
import { inventoryCodexPermissionProfiles } from '../core/codex/codex-permission-profiles.js';
import { resolveProviderContext } from '../core/provider/provider-context.js';
import { readLocalModelConfig } from '../core/agents/ollama-worker-config.js';
import { writeCodexCurrentAppCapabilityArtifacts } from '../core/codex-control/codex-current-app-capability.js';
import { writeCodexPluginInventoryArtifacts, pluginAppTemplatePolicy } from '../core/codex-plugins/codex-plugin-json.js';
import { writeMcpPluginInventoryArtifacts } from '../core/mcp/mcp-plugin-inventory.js';
import { buildCodexAppHarnessMatrix } from '../core/codex-app/codex-app-harness-matrix.js';
import { buildCodexNativeFeatureMatrix } from '../core/codex-native/codex-native-feature-broker.js';
import { withSecretPreservationGuard } from '../core/config/config-migration-journal.js';
import { reconcileDoctorSkills } from '../core/doctor/doctor-skill-reconcile.js';
import { buildSksMenuBarDoctorPostcheck } from '../core/doctor/sks-menubar-doctor.js';
import { isUpdateMigrationReceiptCurrent, projectUpdateMigrationReceiptPath, writeProjectUpdateMigrationReceipt } from '../core/update/update-migration-state.js';
import { inspectSksMenuBarStatus, installSksMenuBar, sksMenuBarPaths, sksMenuBarRestartDeferred } from '../core/codex-app/menubar/index.js';
import { restartLaunchAgent } from '../core/codex-app/menubar/launch-agent.js';
import { sweepSksTempDirs } from '../core/retention.js';
import { detectImagegenCapability } from '../core/imagegen/imagegen-capability.js';
import { CURRENT_CODEX_RELEASE_MANIFEST } from '../core/codex-compat/codex-release-manifest.js';
import { formatHarnessConflictReport, scanHarnessConflicts } from '../core/harness-conflicts.js';
import {
  doctorArgWarnings as baseDoctorArgWarnings,
  doctorMenuBarInstallPolicy,
  doctorPhaseIdsForProfile,
  doctorProfileFromArgs
} from './doctor-profile.js';
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

export { doctorMenuBarInstallPolicy, doctorProfileFromArgs } from './doctor-profile.js';
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
      recovery_actions: (status.recovery_actions || []).map(String).filter(Boolean)
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
  const desktopBridge = await inspectDoctorDesktopBridgeStatus({
    home,
    processEnv: doctorEnv
  }, { desktopBridgeStatusImpl: deps.desktopBridgeStatusImpl });
  const telegramRemote = await inspectTelegramRemote({
    live: true,
    fix: true,
    root,
    home,
    env: doctorEnv
  }, deps);

  const globalSkillsReady = !(globalSkills as any)?.error
    && (globalSkills as any)?.ok !== false
    && (globalSkills as any)?.core_skill_integrity?.ok !== false;
  const globalFastModeReady = (globalFastMode as any)?.status !== 'failed'
    && (globalFastMode as any)?.ok !== false;
  const menuBarReady = (menuBar as any)?.ok !== false;
  const blockers = [...new Set([
    ...(!globalSkillsReady ? [`global_skills_reconcile_failed:${(globalSkills as any)?.error || 'core_skill_integrity'}`] : []),
    ...((currentSurface as any)?.ok !== true ? ((currentSurface as any)?.blockers || ['global_current_surface_reconcile_failed']) : []),
    ...(!globalFastModeReady ? [`global_fast_mode_repair_failed:${(globalFastMode as any)?.error || (globalFastMode as any)?.status || 'unknown'}`] : []),
    ...(!menuBarReady ? ((menuBar as any)?.blockers || ['sks_menubar_repair_failed']) : []),
    ...((desktopBridge as any).ok === false
      ? ((desktopBridge as any).blockers || ['desktop_bridge_unavailable'])
      : [])
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
    openrouter_provider: desktopBridge.providers?.openrouter || null,
    sks_menubar: menuBar,
    telegram_remote: telegramRemote,
    desktop_bridge: desktopBridge,
    blockers,
    next_actions: [
      ...((desktopBridge as any).ok === false ? (desktopBridge as any).recovery_actions || [] : []),
      ...telegramDoctorOperatorActions(telegramRemote),
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
    const telegramOutcome = (result.telegram_remote as any)?.self_heal_outcome;
    const telegramAction = telegramOutcome?.attempted
      ? telegramOutcome.action
      : (result.telegram_remote as any)?.self_heal_action || 'none';
    console.log(`Telegram Remote: ${(result.telegram_remote as any)?.status || 'unknown'} (self-heal ${telegramAction}${telegramOutcome?.attempted ? `, ${telegramOutcome.recovered ? 'recovered' : 'still degraded'}` : ''})`);
    const telegramCheckedLine = telegramDoctorCheckedLine(result.telegram_remote);
    if (telegramCheckedLine) console.log(telegramCheckedLine);
    console.log(`Desktop Bridge: ${result.desktop_bridge.ok ? 'ready' : 'blocked'} (${result.desktop_bridge.status?.readiness?.state || 'unavailable'})`);
    for (const blocker of result.blockers) console.log(`- blocker: ${blocker}`);
    for (const action of result.next_actions) console.log(`- ${action}`);
  }
  if (!result.ok) process.exitCode = 1;
  return result;
}

export async function inspectTelegramRemote(input: {
  live?: boolean;
  fix?: boolean;
  root?: string;
  home?: string;
  env?: NodeJS.ProcessEnv;
  receiptPath?: string;
} = {}, deps: {
  telegramClient?: TelegramClient;
  telegramTokenProvider?: TelegramTokenProvider;
  resolveTelegramBotTokenImpl?: typeof resolveTelegramBotToken;
  probeTelegramImpl?: typeof probeTelegram;
  restartLaunchAgentImpl?: typeof restartLaunchAgent;
  telegramReprobeAttempts?: number;
  telegramReprobeDelayMs?: number;
  telegramSleepImpl?: (ms: number) => Promise<void>;
} = {}) {
  const env = input.env || process.env;
  const home = path.resolve(input.home || env.HOME || os.homedir());
  const receiptPath = input.receiptPath || telegramLivenessPath(home);
  const probeImpl = deps.probeTelegramImpl || probeTelegram;
  let tokenProvider = deps.telegramTokenProvider;
  let client = deps.telegramClient;
  if (input.live && (!tokenProvider || !client)) {
    const resolveImpl = deps.resolveTelegramBotTokenImpl || resolveTelegramBotToken;
    let resolvedToken: Promise<string | null> | null = null;
    tokenProvider ||= {
      loadToken: () => {
        resolvedToken ||= Promise.resolve(resolveImpl({ env })).then((result) => result.token);
        return resolvedToken;
      }
    };
    client ||= new TelegramClient({ tokenProvider });
  }
  const runProbe = () => {
    if (!input.live) return probeImpl({ receiptPath });
    if (!client || !tokenProvider) throw new Error('telegram_live_probe_dependencies_missing');
    return probeImpl({ client, tokenProvider, receiptPath });
  };
  const before = await runProbe();
  const action = telegramSelfHealAction(before);
  if (!input.fix || action !== 'restart_poll' || !before.token_configured || before.paired_chat_count < 1) {
    return {
      ...before,
      self_heal_action: action,
      self_heal_outcome: {
        requested: input.fix === true,
        attempted: false,
        action,
        reason: input.fix !== true
          ? 'report_only'
          : action !== 'restart_poll'
            ? 'action_not_restart_poll'
            : 'telegram_not_configured_or_paired'
      }
    };
  }

  const restartImpl = deps.restartLaunchAgentImpl || restartLaunchAgent;
  const restart = await restartImpl(sksMenuBarPaths(home, input.root), env).catch((error: unknown) => ({
    ok: false,
    error: error instanceof Error ? error.message : String(error)
  }));
  const maximumReprobes = Math.max(1, Math.min(deps.telegramReprobeAttempts ?? 3, 5));
  const reprobeDelayMs = Math.max(0, Math.min(deps.telegramReprobeDelayMs ?? 500, 5_000));
  const sleepImpl = deps.telegramSleepImpl || ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let reprobeAttempts = 1;
  let after = await runProbe();
  let afterAction = telegramSelfHealAction(after);
  while (restart?.ok === true && afterAction === 'restart_poll' && reprobeAttempts < maximumReprobes) {
    await sleepImpl(reprobeDelayMs);
    after = await runProbe();
    afterAction = telegramSelfHealAction(after);
    reprobeAttempts += 1;
  }
  return {
    ...after,
    self_heal_action: afterAction,
    self_heal_attempted_action: action,
    self_heal_before: before,
    self_heal_outcome: {
      requested: true,
      attempted: true,
      action,
      after_action: afterAction,
      restart_ok: restart?.ok === true,
      reprobe_ok: after.ok,
      reprobe_attempts: reprobeAttempts,
      recovered: restart?.ok === true && after.ok && afterAction === 'none',
      error: restart?.error || null,
      restart
    }
  };
}

export function telegramDoctorCheckedLine(probe: any, indent = ''): string | null {
  if (!probe?.getme_checked_at) return null;
  return `${indent}checked: ${probe.getme_checked_at} (${probe.getme_latency_ms ?? 'unknown'} ms, ${probe.getme_check_kind || 'receipt'})`;
}

function telegramDoctorOperatorActions(probe: any): string[] {
  if (!probe || probe.status === 'not_configured') return [];
  if (probe.self_heal_action === 'restart_poll') {
    if (probe.self_heal_outcome?.recovered === true) return [];
    return ['Run `sks menubar restart` to restart the resident Telegram long poller.'];
  }
  if (probe.self_heal_action === 'revalidate_token') {
    return ['Run `sks telegram setup --token-stdin`, then `sks menubar restart`, to revalidate the bot identity.'];
  }
  if (probe.self_heal_action === 'operator_remove_webhook') {
    return ['Remove the Telegram bot webhook through the Bot API, then run `sks menubar restart`; getUpdates and webhooks cannot be active together.'];
  }
  if (probe.self_heal_action === 'operator_repair_audit') {
    return ['Restore owner-only write access to `~/.codex/sks-menubar/logs/telegram-audit.jsonl`, then run `sks menubar restart`.'];
  }
  return [];
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
  const telegramRemote = await inspectTelegramRemote();
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
      ...((desktopBridge as any).ok === false ? (desktopBridge as any).recovery_actions || [] : []),
      ...telegramDoctorOperatorActions(telegramRemote)
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
    telegram_remote: telegramRemote,
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
    local_model: null,
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
  const desktopBridge = await inspectDoctorDesktopBridgeStatus({
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
  const telegramRemote = await inspectTelegramRemote({
    live: deepDiagnostics || doctorFix,
    fix: doctorFix,
    root,
    env: process.env
  }, deps);
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
            id: 'codex_config_syntax_repair',
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
    local_model: localModel,
    agent_role_config: agentRoleConfigRepair,
    repair: configRepair,
    codex_app_ui: codexAppUi,
    sks_menubar: sksMenuBar,
    telegram_remote: telegramRemote,
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
      ...((desktopBridge as any).ok === false ? (desktopBridge as any).recovery_actions || [] : []),
      ...telegramDoctorOperatorActions(telegramRemote)
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
  const resultOk = ready.ready
    && (!sksUpdate || (sksUpdate as any).ok !== false)
    && (!doctorFix || migrationReceiptOwnsReconcile || (skillsReconcile as any)?.convergence?.ok === true)
    && (commandAliasCleanup as any).ok !== false
    && (codexStartupRepair as any).ok !== false
    && (codexConfigSyntaxRepair as any)?.ok !== false
    && (agentRoleConfigRepair as any).ok !== false
    && (openRouterProviderRepair as any).ok !== false
    && ((officialSubagentConfig as any).blockers || []).length === 0
    && desktopBridge.ok !== false;
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
    warnings: [...oauthCallbackPortDiagnostic.warnings, ...(desktopBridge.warnings || [])],
    operator_actions: [
      ...oauthCallbackOperatorActions,
      ...((desktopBridge as any).ok === false ? (desktopBridge as any).recovery_actions || [] : [])
    ],
    node: { ok: Number(process.versions.node.split('.')[0]) >= 20, version: process.version },
    codex,
    oauth_callback_port_diagnostic: oauthCallbackPortDiagnostic,
    codex_config: codexConfig,
    rust,
    codex_app: codexApp,
    codex_app_ui: codexAppUi,
    openrouter_provider: desktopBridge.providers?.openrouter || null,
    sks_menubar: sksMenuBar,
    telegram_remote: telegramRemote,
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
    postcheck: doctorFixPostcheck ? {
      ok: (doctorFixPostcheck as any).ok === true,
      pending_manual: (doctorFixPostcheck as any).pending_manual || [],
      required_blockers: (doctorFixPostcheck as any).required_blockers || [],
      optional_warnings: (doctorFixPostcheck as any).optional_warnings || []
    } : null,
    local_model: localModel,
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
  console.log('SKS Doctor');
  for (const warning of argWarnings) console.log(`Argument warning: ${warning}`);
  for (const warning of (officialSubagentConfig as any).warnings || []) console.log(`Official subagent warning: ${warning}`);
  console.log(`Root:      ${root}`);
  console.log(`Node:      ${result.node.ok ? 'ok' : 'fail'} ${result.node.version}`);
  console.log(`Codex:     ${codex.bin ? 'ok' : 'missing'} ${codex.version || ''}`);
  if (oauthCallbackPortDiagnostic.conflict) {
    const listeners = oauthCallbackPortDiagnostic.listeners
      .map((listener) => `${listener.command} pid ${listener.pid} ${listener.address}`)
      .join(', ');
    console.log(`OAuth callback port 1455: warning (${listeners})`);
    for (const action of oauthCallbackOperatorActions) console.log(`  action: ${action}`);
  }
  const actual = (codexConfig.checks || []).find((check: any) => check.name === 'actual_codex_cli_config_load');
  console.log('Project config:');
  console.log(`  node read:       ${ready.codex_config_readable_by_node ? 'ok' : 'failed'}`);
  console.log(`  codex cli read:  ${ready.codex_config_readable_by_codex_cli ? 'ok' : (actual?.status || 'failed')}`);
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
  if (codexConfigSyntaxRepair) {
    console.log('Codex config syntax:');
    console.log(`  repair: ${codexConfigSyntaxRepair.ok ? 'ok' : 'blocked'}`);
    for (const action of codexConfigSyntaxRepair.actions || []) console.log(`  - ${action}`);
    for (const action of codexConfigSyntaxRepair.manual_actions || []) console.log(`  manual: ${action}`);
    for (const warning of codexConfigSyntaxRepair.warnings || []) console.log(`  warning: ${warning}`);
  }
  console.log(`  codex doctor:    ${formatCodexDoctorConsoleStatus(authoritativeCodexDoctor)}`);
  console.log(`Rust acc.: ${rust.mode || (rust.available ? 'rust_accelerated' : 'js_fallback')} ${rust.version || rust.status || ''}`);
  console.log(`Codex App: ${ready.codex_app_ready ? 'ok' : 'optional_missing'}`);
  console.log('SKS Runtime Readiness:');
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
  for (const line of sksMenuBarRunningVersionConsoleLines(sksMenuBar)) console.log(line);
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
  console.log('Telegram Remote:');
  console.log(`  status: ${(telegramRemote as any).status || 'unknown'}`);
  console.log(`  getMe: ${(telegramRemote as any).bot_identity_valid ? 'verified' : (telegramRemote as any).token_configured ? 'invalid' : 'not configured'}`);
  console.log(`  audit: ${(telegramRemote as any).audit_healthy ? 'healthy' : 'unavailable'}`);
  const telegramCheckedLine = telegramDoctorCheckedLine(telegramRemote, '  ');
  if (telegramCheckedLine) console.log(telegramCheckedLine);
  console.log(`  long poll: ${(telegramRemote as any).poller?.running ? 'running' : 'stopped'}`);
  const telegramSelfHealOutcome = (telegramRemote as any).self_heal_outcome;
  const telegramDisplayedAction = telegramSelfHealOutcome?.attempted
    ? telegramSelfHealOutcome.action
    : (telegramRemote as any).self_heal_action;
  if (telegramDisplayedAction && telegramDisplayedAction !== 'none') {
    console.log(`  self-heal: ${telegramDisplayedAction}${telegramSelfHealOutcome?.attempted ? ` (${telegramSelfHealOutcome.recovered ? 'recovered' : 'attempted, still degraded'})` : ''}`);
  }
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
  const codexCurrentApp = (codexCurrentAppCapability as any).report || {};
  console.log('Codex current compatibility:');
  console.log(`  target: ${CURRENT_CODEX_RELEASE_MANIFEST.targetTag}`);
  console.log(`  runtime: ${codex.version || 'unknown'}`);
  console.log(`  multi-agent mode: ${(codexNativeFeatureMatrix as any).features?.multi_agent_mode?.ok ? 'verified' : 'unverified'}`);
  console.log(`  rollout budget: ${(codexNativeFeatureMatrix as any).features?.rollout_budget?.ok ? 'verified' : 'unverified'}`);
  console.log(`  indexed search: ${(codexNativeFeatureMatrix as any).features?.indexed_web_search?.ok ? 'verified' : 'unverified'}`);
  console.log(`  current time: ${(codexNativeFeatureMatrix as any).features?.current_time_read?.ok ? 'verified' : 'unverified'}`);
  console.log('Current Codex app features:');
  console.log(`  /app handoff: ${codexCurrentApp.supports_app_handoff ? 'ok' : 'unavailable'}`);
  console.log(`  plugin JSON: ${codexCurrentApp.supports_plugin_json ? 'ok' : 'unavailable'}`);
  console.log(`  image path exposure: ${codexCurrentApp.supports_image_path_exposure ? 'ok' : 'unavailable'}`);
  console.log(`  OAuth MCP pre-refresh: ${codexCurrentApp.supports_oauth_mcp_prerefresh ? 'ok' : 'unavailable'}`);
  const plugins = (pluginInventory as any)?.report?.plugins || [];
  const remoteMcpCount = plugins.flatMap((plugin: any) => plugin.remote_mcp_servers || []).length;
  const unavailableTemplates = pluginPolicy?.unavailable_app_templates?.length || 0;
  console.log(`Codex plugins: ${(pluginInventory as any)?.report ? 'ok' : 'warning'}`);
  console.log(`  Remote MCP servers: ${remoteMcpCount} candidates`);
  console.log(`  Unavailable app templates: ${unavailableTemplates}`);
  for (const warning of pluginPolicy?.doctor_warnings || []) console.log(`  warning: ${warning}`);
  if ((codexCurrentAppDoctor as any)?.fixed?.length) console.log(`  doctor --fix repaired: ${(codexCurrentAppDoctor as any).fixed.join(', ')}`);
  console.log(`Desktop Bridge: ${desktopBridge.ok ? 'ready' : 'blocked'} (${desktopBridge.status?.readiness?.state || 'unavailable'})`);
  for (const providerId of ['codex-lb', 'openrouter']) {
    const provider = desktopBridge.providers?.[providerId];
    if (!provider) continue;
    console.log(`  ${providerId}: ${provider.enabled ? 'enabled' : 'disabled'}; credential ${provider.credential?.state || 'unknown'} (${provider.credential?.source || 'none'}); endpoint ${provider.endpoint?.configured ? 'configured' : 'missing'}`);
  }
  for (const warning of desktopBridge.warnings || []) console.log(`  warning: ${warning}`);
  for (const blocker of desktopBridge.blockers || []) console.log(`  blocker: ${blocker}`);
  if (!desktopBridge.ok) for (const action of desktopBridge.recovery_actions || []) console.log(`  action: ${action}`);
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
  console.log(`  core_ready: ${ready.core_ready ? 'yes' : 'no'}`);
  console.log(`  center_ready: ${ready.center_ready ? 'yes' : 'no'}${ready.center_attempted ? ' (repair attempted)' : ' (not attempted)'}`);
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
