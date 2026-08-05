import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ensureDir, exists, PACKAGE_VERSION, readJson, readText, runProcess, sha256, which,
  writeJsonAtomic, writeTextAtomic
} from '../../fsx.js';
import { actionScriptSource } from './action-runner.js';
import { buildMenuBarAppStaging, MenuBarBuildError } from './app-bundle.js';
import { aggregateFileHashes, createSksMenuBarBuildStamp, menuBarBuildStampsEqual } from './build-stamp.js';
import { MENU_ITEMS, SKS_MENUBAR_LABEL } from './constants.js';
import { resolveCodexBundleId, writeDefaultMenuBarConfig } from './config.js';
import {
  applyMenuBarGenerationTransaction,
  commitMenuBarGenerationTransaction,
  installGenerationPairs,
  MenuBarGenerationTransactionError,
  recoverMenuBarGenerationTransaction,
  rollbackGenerationPairs
} from './generation-transaction.js';
import {
  launchAgentSource,
  launchMenuBar,
  inspectRunningMenuBarProcess,
  seedMenuBarPreferredPosition,
  stopMenuBarForReplacement,
  terminateMenuBarProcesses
} from './launch-agent.js';
import {
  cleanupProjectMenuBarDuplicates,
  verifiedProjectMenuBarDuplicateExecutablePaths
} from './global-install.js';
import {
  cleanupRetiredRemoteBridgeLaunchAgent,
  quarantineRetiredRemoteBridgeBindings
} from './migration.js';
import { sksMenuBarPaths } from './paths.js';
import { infoPlistSource, inspectInstalledResources, loadNativeMenuBarSources, nativeResourceHashes } from './resources.js';
import { inspectMenuBarArtifactSet, normalizeLegacyMenuBarBuildStamp, rollbackSksMenuBar } from './rollback.js';
import { inspectSignature } from './signature.js';
import { defaultNextActions, inspectSksMenuBarStatus, isMenuBarInstallPathUnderTempDir } from './status.js';
import type { NativeSourceInput, SksMenuBarBuildStamp, SksMenuBarGenerationTransactionOutcome, SksMenuBarInstallOptions, SksMenuBarInstallResult, SksMenuBarLegacyBuildStampV1, SksMenuBarRollbackResult, SksMenuBarTargetCheck } from './types.js';

export function sksMenuBarRestartDeferred(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.SKS_UPDATE_DEFER_MENUBAR_RESTART === '1'
    || env.SKS_SKIP_SKS_MENUBAR_LAUNCH === '1';
}

export async function installSksMenuBar(opts: SksMenuBarInstallOptions = {}): Promise<SksMenuBarInstallResult> {
  const apply = opts.apply === true;
  const env = opts.env || process.env;
  const paths = sksMenuBarPaths(opts.home || env.HOME, opts.root);
  const actions: string[] = [];
  const warnings: string[] = [];
  let targetCheck: SksMenuBarTargetCheck | undefined;
  let codexBundleId: string | null = null;
  let transaction: SksMenuBarGenerationTransactionOutcome | null = null;

  if (process.platform !== 'darwin') {
    const result = baseResult(paths, apply, 'unsupported_platform', true, actions, ['sks_menubar_requires_macos']);
    result.app_path = null;
    result.executable_path = null;
    result.launch_agent_path = null;
    result.action_script_path = null;
    result.build_stamp_path = null;
    result.config_path = null;
    result.report_path = apply ? paths.report_path : null;
    result.launch = { requested: false, method: 'none', ok: true };
    if (apply) await writeReport(paths.report_path, result);
    return result;
  }

  if (!apply) {
    const status = await inspectSksMenuBarStatus({ home: paths.home, root: paths.root, env }).catch(() => null);
    const result = baseResult(paths, false, 'planned', status?.ok !== false, status?.installed ? ['menubar_app_present'] : ['menubar_app_install_available'], status?.warnings || []);
    result.codex_bundle_id = status?.codex_sync.bundle_id || null;
    result.build_stamp = status?.build_stamp || null;
    if (status) {
      result.installed_version = status.installed_version;
      result.running_process = status.running_process;
      result.menubar_version_probe = status.menubar_version_probe;
    }
    result.duplicate_install_candidates = status?.duplicate_install_candidates || [];
    result.blockers = status?.blockers || [];
    result.launch = { requested: false, method: 'skipped', ok: true };
    return result;
  }

  await ensureDir(paths.install_dir);
  await ensureDir(paths.logs_dir);
  await ensureDir(paths.operations_dir);
  await ensureDir(path.dirname(paths.launch_agent_path));
  const installPairs = installGenerationPairs(paths);
  const rollbackPairs = rollbackGenerationPairs(paths);
  for (const pending of [
    { purpose: 'install' as const, journalPath: paths.install_transaction_path, pairs: installPairs },
    { purpose: 'rollback' as const, journalPath: paths.rollback_transaction_path, pairs: rollbackPairs }
  ]) {
    const recovery = await recoverMenuBarGenerationTransaction({ ...pending, env });
    if (!recovery.ok) return blocked('menubar_generation_recovery_terminal_uncertain', recovery.error || recovery.status, null, recovery);
    if (recovery.status === 'rolled_back') actions.push(`recovered interrupted Menu Bar ${pending.purpose} transaction to its previous generation`);
    if (recovery.status === 'completed_commit') actions.push(`completed committed Menu Bar ${pending.purpose} transaction cleanup`);
  }
  const retiredRemoteBridge = await cleanupRetiredRemoteBridgeLaunchAgent({
    home: paths.home,
    env
  });
  warnings.push(...retiredRemoteBridge.warnings);
  if (!retiredRemoteBridge.ok) {
    return blocked(
      retiredRemoteBridge.blockers[0] || 'retired_remote_bridge_cleanup_failed',
      'The retired SKS remote bridge LaunchAgent could not be stopped safely.'
    );
  }
  if (retiredRemoteBridge.removed) {
    actions.push('stopped and removed the retired SKS remote bridge LaunchAgent');
  }
  const retiredBindings = await quarantineRetiredRemoteBridgeBindings(paths.root);
  warnings.push(...retiredBindings.warnings);
  if (!retiredBindings.ok) {
    return blocked(
      retiredBindings.blockers[0] || 'retired_remote_bridge_binding_cleanup_failed',
      'Retired remote bridge bindings could not be quarantined safely.'
    );
  }
  if (retiredBindings.status === 'quarantined') {
    actions.push(`quarantined ${retiredBindings.retired_binding_count} retired remote bridge binding(s)`);
  }
  const swiftc = env.SKS_MENUBAR_SWIFTC || await which('swiftc').catch(() => null) || '/usr/bin/swiftc';
  const codesign = env.SKS_MENUBAR_CODESIGN || await which('codesign').catch(() => null) || '/usr/bin/codesign';
  const launchctl = env.SKS_MENUBAR_LAUNCHCTL || await which('launchctl').catch(() => null) || '/bin/launchctl';
  const open = env.SKS_MENUBAR_OPEN || await which('open').catch(() => null) || '/usr/bin/open';
  const xcodeSelect = env.SKS_MENUBAR_XCODE_SELECT || await which('xcode-select').catch(() => null) || '/usr/bin/xcode-select';
  const clt = await runProcess(xcodeSelect, ['-p'], { timeoutMs: 5_000, maxOutputBytes: 8 * 1024 }).catch(() => ({ code: 1, stdout: '', stderr: '' }));
  if (clt.code !== 0) return blocked('xcode_clt_missing', 'Run xcode-select --install');
  if (!(await exists(swiftc))) return blocked('swiftc_missing');
  if (!(await exists(codesign))) return blocked('codesign_missing');

  codexBundleId = await resolveCodexBundleId({ home: paths.home, env, warnings });
  const config = await writeDefaultMenuBarConfig(paths.config_path, codexBundleId);
  targetCheck = await resolveSksEntryForInstall(opts.sksEntry, paths.root);
  if (!targetCheck.exists || !targetCheck.resolved) return blocked('sks_entry_unresolved');
  if (targetCheck.project_local) warnings.push('sks_entry_project_local');
  const previousActionScript = await readText(paths.action_script_path, '');
  const previousLaunchAgent = await readText(paths.launch_agent_path, '');
  const previousRaw = await readJson<SksMenuBarBuildStamp | SksMenuBarLegacyBuildStampV1 | null>(paths.build_stamp_path, null);
  let previous = previousRaw?.schema === 'sks.sks-menubar-build-stamp.v2' ? previousRaw : null;
  const actionScript = actionScriptSource({ nodeBin: process.execPath, sksEntry: targetCheck.resolved });
  const runtime: NativeSourceInput = {
    actionScriptPath: paths.action_script_path,
    projectRootPath: paths.root,
    buildStampPath: paths.build_stamp_path,
    configPath: paths.config_path,
    lastActionLogPath: paths.last_action_log_path,
    operationDirPath: paths.operations_dir,
    codexBundleId: config.codex_bundle_id,
    packageVersion: PACKAGE_VERSION
  };
  const sourceFiles = loadNativeMenuBarSources(runtime);
  const sourceHashes = Object.fromEntries(sourceFiles.map((entry) => [entry.name, entry.sha256]));
  let resourceHashes: Record<string, string>;
  try {
    resourceHashes = nativeResourceHashes();
  } catch (error) {
    return blocked('menubar_resource_missing', error instanceof Error ? error.message : String(error));
  }
  const infoPlist = infoPlistSource(PACKAGE_VERSION);
  const launchAgent = launchAgentSource(paths.executable_path, paths.install_dir);
  const swiftcVersion = await toolVersion(swiftc, ['--version']);
  const stamp = createSksMenuBarBuildStamp({
    packageVersion: PACKAGE_VERSION,
    sourceHashes,
    resourceHashes,
    actionScriptSha256: sha256(actionScript),
    infoPlistSha256: sha256(infoPlist),
    launchAgentSha256: sha256(launchAgent),
    swiftcVersion,
    codesignIdentifier: SKS_MENUBAR_LABEL
  });
  const currentAction = previousActionScript;
  const bundleExists = await exists(paths.executable_path);
  const resources = bundleExists
    ? await inspectInstalledResources({ resourcesDir: paths.resources_path, buildStamp: previous })
    : { checked: false, ok: false, missing: [], mismatched: [] };
  const signature = bundleExists
    ? await inspectSignature(paths.app_path, { ...env, SKS_MENUBAR_CODESIGN: codesign })
    : { checked: false, identifier: null, ok: false, error: 'app_missing' };
  const installedInfoPlist = await readText(paths.info_plist_path, '');
  const restartDeferred = sksMenuBarRestartDeferred(env);
  const launchWanted = opts.launch !== false
    && env.SKS_SKIP_SKS_MENUBAR_LAUNCH !== '1'
    && !restartDeferred;
  if (restartDeferred && opts.launch !== false && env.SKS_SKIP_SKS_MENUBAR_LAUNCH !== '1') {
    warnings.push('launch_deferred_until_parent_operation_completes');
  }
  const launchAllowed = path.resolve(paths.home) === realUserHome()
    && !isMenuBarInstallPathUnderTempDir(paths.executable_path, env);
  if (launchWanted && path.resolve(paths.home) !== realUserHome()) warnings.push('launch_skipped_non_user_home');
  if (launchWanted && isMenuBarInstallPathUnderTempDir(paths.executable_path, env)) warnings.push('launch_skipped_temp_install');
  const upToDate = bundleExists
    && currentAction === actionScript
    && menuBarBuildStampsEqual(previous, stamp)
    && resources.ok
    && signature.ok
    && sha256(installedInfoPlist) === stamp.info_plist_sha256;
  if (upToDate) {
    actions.push('menubar_up_to_date');
  } else {
    const preservingPrevious = await exists(paths.app_path);
    try {
      if (preservingPrevious) {
        if (previousRaw?.schema === 'sks.sks-menubar-build-stamp.v1') {
          const normalized = await normalizeLegacyMenuBarBuildStamp({
            appPath: paths.app_path,
            legacySourcePath: path.join(paths.install_dir, 'SKSMenuBar.swift'),
            buildStampPath: paths.build_stamp_path,
            actionScript: previousActionScript,
            launchAgentPath: paths.launch_agent_path,
            env: { ...env, SKS_MENUBAR_CODESIGN: codesign }
          });
          if (!normalized.ok || !normalized.stamp) {
            throw new MenuBarBuildError('menubar_legacy_rollback_candidate_invalid', normalized.blockers.join(','));
          }
          previous = normalized.stamp;
          await writeJsonAtomic(paths.build_stamp_path, previous);
          actions.push(`normalized verified ${previousRaw.package_version} Menu Bar v1 rollback metadata`);
        }
        if (!previous) throw new MenuBarBuildError('menubar_previous_build_stamp_invalid', 'installed Menu Bar has no verifiable rollback stamp');
        if (!previousActionScript || sha256(previousActionScript) !== previous.action_script_sha256) {
          throw new MenuBarBuildError('menubar_previous_action_script_invalid', 'installed Menu Bar action script does not match its rollback stamp');
        }
        if (!previousLaunchAgent || sha256(previousLaunchAgent) !== previous.launch_agent_sha256) {
          throw new MenuBarBuildError('menubar_previous_launch_agent_invalid', 'installed Menu Bar launch agent does not match its rollback stamp');
        }
        const currentVerification = await inspectMenuBarArtifactSet({
          appPath: paths.app_path,
          buildStampPath: paths.build_stamp_path,
          actionScriptPath: paths.action_script_path,
          launchAgentPath: paths.launch_agent_path,
          env: { ...env, SKS_MENUBAR_CODESIGN: codesign }
        });
        if (!currentVerification.ok) {
          throw new MenuBarBuildError('menubar_previous_generation_invalid', currentVerification.blockers.join(','));
        }
      }
      const built = await buildMenuBarAppStaging({
        paths, swiftc, codesign, runtime, infoPlist, actions,
        ...(opts.quiet === undefined ? {} : { quiet: opts.quiet })
      });
      stamp.source_sha256 = built.sourceSha256;
      stamp.source_files_sha256 = built.sourceHashes;
      stamp.resources_sha256 = aggregateFileHashes(built.resourceHashes);
      stamp.resource_files_sha256 = built.resourceHashes;
      await writeTextAtomic(paths.staging_action_script_path, actionScript, { mode: 0o755 });
      await writeTextAtomic(paths.staging_launch_agent_path, launchAgent);
      await writeJsonAtomic(paths.staging_build_stamp_path, stamp);
      const stagedVerification = await inspectMenuBarArtifactSet({
        appPath: paths.staging_app_path,
        buildStampPath: paths.staging_build_stamp_path,
        actionScriptPath: paths.staging_action_script_path,
        launchAgentPath: paths.staging_launch_agent_path,
        env: { ...env, SKS_MENUBAR_CODESIGN: codesign }
      });
      if (!stagedVerification.ok) {
        throw new MenuBarBuildError('menubar_staged_generation_invalid', stagedVerification.blockers.join(','));
      }
    } catch (error) {
      if (error instanceof MenuBarBuildError) return blocked(error.blocker, error.message);
      return blocked('menubar_build_failed', error instanceof Error ? error.message : String(error));
    }
  }

  const duplicateExecutablePaths = await verifiedProjectMenuBarDuplicateExecutablePaths({
    paths,
    root: paths.root,
    env
  });
  const mustStopCanonical = !upToDate || (launchWanted && launchAllowed);
  let canonicalStopped = false;
  if (mustStopCanonical) {
    const stopped = await stopMenuBarForReplacement({
      launchctl,
      paths,
      executablePaths: [paths.executable_path, ...duplicateExecutablePaths],
      env
    });
    if (!stopped.ok) {
      return blocked(stopped.error || 'menubar_stop_before_replace_failed', 'Menu Bar process shutdown could not be verified before replacement.');
    }
    canonicalStopped = true;
    actions.push('booted out Menu Bar and verified all canonical/project duplicate processes stopped');
  } else {
    const duplicateStop = await terminateMenuBarProcesses(duplicateExecutablePaths, env);
    if (!duplicateStop.ok) {
      return blocked('menubar_project_duplicate_stop_failed', `Remaining PIDs: ${duplicateStop.remaining_pids.join(',')}`);
    }
  }

  const duplicateCleanup = await cleanupProjectMenuBarDuplicates({
    paths,
    root: paths.root,
    env,
    candidateExecutablePaths: duplicateExecutablePaths
  });
  warnings.push(...duplicateCleanup.warnings);
  if (!duplicateCleanup.ok) {
    return blocked(
      duplicateCleanup.blockers[0] || 'menubar_project_duplicate_cleanup_failed',
      'Project-local Menu Bar duplicate cleanup could not be completed safely.'
    );
  }
  if (duplicateCleanup.removed.length > 0) {
    actions.push(`removed ${duplicateCleanup.removed.length} verified project-local Menu Bar duplicate(s)`);
  }
  if (duplicateCleanup.receipt_path) actions.push(`wrote duplicate cleanup receipt ${duplicateCleanup.receipt_path}`);

  if (!upToDate) {
    const preservingPrevious = await exists(paths.app_path);
    try {
      transaction = await applyMenuBarGenerationTransaction({
        purpose: 'install', journalPath: paths.install_transaction_path, pairs: installPairs, env
      });
      actions.push(`installed ${paths.app_path} as one journaled generation`);
      if (preservingPrevious) actions.push(`preserved complete previous generation at ${paths.backup_app_path}`);
    } catch (error) {
      const failed = error instanceof MenuBarGenerationTransactionError ? error.outcome : null;
      const recovery = await recoverMenuBarGenerationTransaction({
        purpose: 'install', journalPath: paths.install_transaction_path, pairs: installPairs, env
      });
      transaction = recovery;
      return blocked(
        recovery.ok ? 'menubar_install_transaction_failed' : 'menubar_install_transaction_terminal_uncertain',
        (failed?.error || (error instanceof Error ? error.message : String(error))),
        null,
        recovery
      );
    }
  }
  const installedVerification = await inspectMenuBarArtifactSet({
    appPath: paths.app_path,
    buildStampPath: paths.build_stamp_path,
    actionScriptPath: paths.action_script_path,
    launchAgentPath: paths.launch_agent_path,
    env: { ...env, SKS_MENUBAR_CODESIGN: codesign }
  });
  if (!installedVerification.ok) {
    if (!upToDate) {
      const recovery = await recoverMenuBarGenerationTransaction({
        purpose: 'install', journalPath: paths.install_transaction_path, pairs: installPairs, env
      });
      transaction = recovery;
      return blocked(
        recovery.ok ? 'menubar_post_install_verification_failed' : 'menubar_post_install_recovery_terminal_uncertain',
        installedVerification.blockers.join(','),
        null,
        recovery
      );
    }
    return blocked('menubar_post_install_verification_failed', installedVerification.blockers.join(','));
  }
  actions.push('verified installed Menu Bar signature, resources, build stamp, action script, and launch agent');
  if (!upToDate) {
    const committed = await commitMenuBarGenerationTransaction({
      purpose: 'install', journalPath: paths.install_transaction_path, pairs: installPairs, env
    });
    if (!committed.ok) {
      const recovery = await recoverMenuBarGenerationTransaction({
        purpose: 'install', journalPath: paths.install_transaction_path, pairs: installPairs, env
      });
      if (!recovery.ok) return blocked('menubar_install_commit_terminal_uncertain', recovery.error || committed.error || committed.status, null, recovery);
      warnings.push('menubar_install_commit_cleanup_recovered');
      transaction = recovery;
    } else {
      transaction = committed;
    }
  }
  let launch: NonNullable<SksMenuBarInstallResult['launch']> = { requested: false, method: 'skipped', ok: true };
  if (launchWanted && launchAllowed) {
    if (await seedMenuBarPreferredPosition(env)) actions.push('seeded SKS menu bar preferred position');
    launch = await launchMenuBar({
      launchctl,
      open,
      paths,
      env,
      alreadyStopped: canonicalStopped,
      expectedVersion: stamp.package_version,
      executablePaths: [paths.executable_path, ...duplicateExecutablePaths]
    });
  }
  const rollbackCandidateExists = !upToDate && await exists(paths.backup_app_path);
  const rollback = shouldAutoRollbackMenuBarLaunch({ launch, upToDate, rollbackCandidateExists })
    ? await rollbackSksMenuBar({ home: paths.home, root: paths.root, env: { ...env, SKS_MENUBAR_CODESIGN: codesign }, launch: true })
    : null;
  if (!launch.ok && launch.terminal_uncertain === true && rollbackCandidateExists) {
    warnings.push('menubar_launch_terminal_uncertain_rollback_skipped');
  }
  if (rollback?.ok) actions.push(`rolled back Menu Bar to ${rollback.previous_version || 'the verified previous build'}`);
  const terminalUncertain = launch.terminal_uncertain === true || rollback?.status === 'terminal_uncertain';
  const ok = launch.ok;
  const result = baseResult(paths, true, ok ? (launch.requested ? (launch.method === 'open-fallback' ? 'installed_open_fallback' : 'installed') : 'installed_launch_skipped') : terminalUncertain ? 'terminal_uncertain' : 'blocked', ok, actions, warnings);
  result.codex_bundle_id = codexBundleId;
  result.target_check = targetCheck;
  result.build_stamp = rollback?.ok
    ? await readJson<SksMenuBarBuildStamp | null>(paths.build_stamp_path, null)
    : stamp;
  result.launch = launch;
  result.installed_version = result.build_stamp?.package_version || null;
  if (launch.version_probe) {
    result.menubar_version_probe = launch.version_probe;
    result.running_process = await inspectRunningMenuBarProcess(paths, launch.version_probe.pid, env);
  }
  result.rollback = rollback;
  result.transaction = transaction;
  result.blockers = ok ? [] : [
    terminalUncertain ? 'sks_menubar_launch_terminal_uncertain' : launch.error || 'sks_menubar_launch_failed',
    ...(rollback && !rollback.ok ? rollback.blockers : [])
  ];
  await writeReport(paths.report_path, result);
  return result;

  async function blocked(
    reason: string,
    detail?: string,
    rollback: SksMenuBarRollbackResult | null = null,
    failedTransaction: SksMenuBarGenerationTransactionOutcome | null = null
  ): Promise<SksMenuBarInstallResult> {
    const terminalUncertain = rollback?.status === 'terminal_uncertain' || failedTransaction?.status === 'terminal_uncertain';
    const result = baseResult(paths, apply, terminalUncertain ? 'terminal_uncertain' : 'blocked', false, actions, detail ? [...warnings, detail] : warnings);
    result.codex_bundle_id = codexBundleId;
    if (targetCheck) result.target_check = targetCheck;
    result.rollback = rollback;
    result.transaction = failedTransaction;
    result.blockers = [reason, ...(rollback && !rollback.ok ? rollback.blockers : [])];
    result.launch = { requested: false, method: 'none', ok: false, terminal_uncertain: terminalUncertain, error: detail || reason };
    await writeReport(paths.report_path, result);
    return result;
  }
}

export function shouldAutoRollbackMenuBarLaunch(input: {
  launch: NonNullable<SksMenuBarInstallResult['launch']>;
  upToDate: boolean;
  rollbackCandidateExists: boolean;
}): boolean {
  return !input.launch.ok
    && input.launch.terminal_uncertain !== true
    && !input.upToDate
    && input.rollbackCandidateExists;
}

function baseResult(paths: ReturnType<typeof sksMenuBarPaths>, apply: boolean, status: SksMenuBarInstallResult['status'], ok: boolean, actions: string[], warnings: string[]): SksMenuBarInstallResult {
  return {
    schema: 'sks.codex-app-sks-menubar.v1', ok, apply, status, platform: process.platform,
    app_path: paths.app_path, executable_path: paths.executable_path,
    launch_agent_path: paths.launch_agent_path, action_script_path: paths.action_script_path,
    build_stamp_path: paths.build_stamp_path, config_path: paths.config_path,
    report_path: paths.report_path, menu_items: [...MENU_ITEMS], actions,
    tcc_automation_status: 'unknown', next_actions: defaultNextActions(), blockers: [], warnings
  };
}

async function resolveSksEntryForInstall(explicit: string | undefined, root: string): Promise<SksMenuBarTargetCheck> {
  const packaged = fileURLToPath(new URL('../../../bin/sks.js', import.meta.url));
  const requested = explicit ? path.resolve(explicit) : null;
  const candidate = requested || packaged;
  const found = await exists(candidate);
  const relative = path.relative(path.resolve(root), candidate);
  return {
    requested, resolved: found ? candidate : null, packaged, exists: found,
    project_local: relative === '' || (Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative)),
    used_previous_script: false
  };
}

async function toolVersion(tool: string, args: string[]): Promise<string> {
  const result = await runProcess(tool, args, { timeoutMs: 5_000, maxOutputBytes: 16 * 1024 }).catch(() => ({ code: 1, stdout: '', stderr: '' }));
  return result.code === 0 ? String(result.stdout || result.stderr).trim().split(/\r?\n/)[0] || 'unknown' : 'unknown';
}

function realUserHome(): string {
  try { return path.resolve(os.userInfo().homedir); } catch { return path.resolve(os.homedir()); }
}

async function writeReport(reportPath: string, result: SksMenuBarInstallResult): Promise<void> {
  try { await writeJsonAtomic(reportPath, result); }
  catch { result.report_write_failed = true; result.warnings.push('menubar_report_write_failed'); }
}
