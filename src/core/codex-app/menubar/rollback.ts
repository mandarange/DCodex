import fs from 'node:fs/promises';
import path from 'node:path';
import { readJson, sha256, which } from '../../fsx.js';
import {
  applyMenuBarGenerationTransaction,
  commitMenuBarGenerationTransaction,
  installGenerationPairs,
  MenuBarGenerationTransactionError,
  recoverMenuBarGenerationTransaction,
  rollbackGenerationPairs
} from './generation-transaction.js';
import { launchMenuBar, stopMenuBarForReplacement } from './launch-agent.js';
import { sksMenuBarPaths } from './paths.js';
import { aggregateFileHashes } from './build-stamp.js';
import { inspectInstalledResources } from './resources.js';
import { inspectSignature } from './signature.js';
import type {
  SksMenuBarArtifactVerification,
  SksMenuBarBuildStamp,
  SksMenuBarGenerationTransactionOutcome,
  SksMenuBarLegacyBuildStampV1,
  SksMenuBarRollbackOptions,
  SksMenuBarRollbackResult
} from './types.js';

export async function inspectMenuBarArtifactSet(input: {
  appPath: string;
  buildStampPath: string;
  actionScriptPath: string;
  launchAgentPath: string;
  env?: NodeJS.ProcessEnv;
}): Promise<SksMenuBarArtifactVerification> {
  const blockers: string[] = [];
  const appExists = await isDirectoryWithoutSymlink(input.appPath);
  const executablePath = path.join(input.appPath, 'Contents', 'MacOS', 'SKSMenuBar');
  const executableExists = await isRegularFileWithoutSymlink(executablePath);
  const buildStampExists = await isRegularFileWithoutSymlink(input.buildStampPath);
  const actionScriptExists = await isRegularFileWithoutSymlink(input.actionScriptPath);
  const launchAgentExists = await isRegularFileWithoutSymlink(input.launchAgentPath);
  const stamp = buildStampExists
    ? await readJson<SksMenuBarBuildStamp | null>(input.buildStampPath, null).catch(() => null)
    : null;
  const actionText = actionScriptExists ? await fs.readFile(input.actionScriptPath, 'utf8').catch(() => '') : '';
  const actionMode = actionScriptExists ? await fs.stat(input.actionScriptPath).catch(() => null) : null;
  const actionScriptExecutable = Boolean(actionMode && (actionMode.mode & 0o111) !== 0);
  const actionScriptHashOk = Boolean(stamp && actionText && sha256(actionText) === stamp.action_script_sha256);
  const executableHashOk = Boolean(executableExists && (!stamp?.legacy_v1
    || sha256(await fs.readFile(executablePath)) === stamp.legacy_v1.executable_sha256));
  const infoPlistPath = path.join(input.appPath, 'Contents', 'Info.plist');
  const infoPlistExists = await isRegularFileWithoutSymlink(infoPlistPath);
  const infoPlistHashOk = Boolean(stamp && infoPlistExists
    && sha256(await fs.readFile(infoPlistPath)) === stamp.info_plist_sha256);
  const launchAgentHashOk = Boolean(stamp && launchAgentExists
    && sha256(await fs.readFile(input.launchAgentPath)) === stamp.launch_agent_sha256);
  const signature = appExists
    ? await inspectSignature(input.appPath, input.env)
    : { checked: true, identifier: null, ok: false, error: 'app_missing' };
  const resources = stamp?.legacy_v1
    ? await inspectExactResourceInventory(path.join(input.appPath, 'Contents', 'Resources'), stamp.resource_files_sha256)
    : await inspectInstalledResources({
        resourcesDir: path.join(input.appPath, 'Contents', 'Resources'),
        buildStamp: stamp
      }).catch(() => ({ checked: true, ok: false, missing: [], mismatched: [] }));

  if (!appExists) blockers.push('rollback_app_missing_or_symlink');
  if (!executableExists) blockers.push('rollback_executable_missing_or_symlink');
  if (!executableHashOk) blockers.push('rollback_executable_hash_mismatch');
  if (!buildStampExists || !stamp || stamp.schema !== 'sks.sks-menubar-build-stamp.v2') blockers.push('rollback_build_stamp_invalid');
  if (stamp && stamp.codesign_identifier !== 'com.sneakoscope.sks-menubar') blockers.push('rollback_codesign_identifier_invalid');
  if (stamp?.legacy_v1 && !/^6\.2\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(stamp.package_version)) blockers.push('rollback_legacy_version_invalid');
  if (!actionScriptExists) blockers.push('rollback_action_script_missing_or_symlink');
  if (!actionScriptExecutable) blockers.push('rollback_action_script_not_executable');
  if (!actionScriptHashOk) blockers.push('rollback_action_script_hash_mismatch');
  if (!infoPlistHashOk) blockers.push('rollback_info_plist_hash_mismatch');
  if (!launchAgentHashOk) blockers.push('rollback_launch_agent_hash_mismatch');
  if (!signature.ok) blockers.push('rollback_signature_invalid');
  if (!resources.ok) blockers.push('rollback_resources_invalid');

  return {
    checked: true,
    ok: blockers.length === 0,
    app_exists: appExists,
    executable_exists: executableExists,
    executable_hash_ok: executableHashOk,
    build_stamp_exists: buildStampExists,
    action_script_exists: actionScriptExists,
    action_script_executable: actionScriptExecutable,
    action_script_hash_ok: actionScriptHashOk,
    info_plist_hash_ok: infoPlistHashOk,
    launch_agent_hash_ok: launchAgentHashOk,
    signature,
    resources,
    package_version: stamp?.package_version || null,
    legacy_v1_normalized: Boolean(stamp?.legacy_v1),
    blockers
  };
}

export async function normalizeLegacyMenuBarBuildStamp(input: {
  appPath: string;
  legacySourcePath: string;
  buildStampPath: string;
  actionScript: string;
  launchAgentPath: string;
  env?: NodeJS.ProcessEnv;
}): Promise<{ ok: boolean; stamp: SksMenuBarBuildStamp | null; blockers: string[] }> {
  const blockers: string[] = [];
  if (!(await isRegularFileWithoutSymlink(input.buildStampPath))) {
    return { ok: false, stamp: null, blockers: ['legacy_build_stamp_missing_or_symlink'] };
  }
  const stampBytes = await fs.readFile(input.buildStampPath).catch(() => null);
  const legacy = stampBytes
    ? await readJson<SksMenuBarLegacyBuildStampV1 | null>(input.buildStampPath, null).catch(() => null)
    : null;
  if (!legacy || legacy.schema !== 'sks.sks-menubar-build-stamp.v1') blockers.push('legacy_build_stamp_schema_invalid');
  if (legacy && !/^6\.2\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(legacy.package_version)) blockers.push('legacy_build_stamp_version_invalid');
  if (!(await isRegularFileWithoutSymlink(input.legacySourcePath))) blockers.push('legacy_source_missing_or_symlink');
  const sourceBytes = await fs.readFile(input.legacySourcePath).catch(() => null);
  if (!legacy || !sourceBytes || sha256(sourceBytes) !== legacy.source_sha256) blockers.push('legacy_source_hash_mismatch');
  if (!legacy || !input.actionScript || sha256(input.actionScript) !== legacy.action_script_sha256) blockers.push('legacy_action_script_hash_mismatch');
  const infoPlistPath = path.join(input.appPath, 'Contents', 'Info.plist');
  const infoPlist = await fs.readFile(infoPlistPath).catch(() => null);
  if (!legacy || !infoPlist || sha256(infoPlist) !== legacy.info_plist_sha256) blockers.push('legacy_info_plist_hash_mismatch');
  if (legacy && infoPlist && !infoPlist.toString('utf8').includes(`<string>${legacy.package_version}</string>`)) blockers.push('legacy_info_plist_version_mismatch');
  const launchAgent = await fs.readFile(input.launchAgentPath).catch(() => null);
  if (!legacy || !launchAgent || sha256(launchAgent) !== legacy.launch_agent_sha256) blockers.push('legacy_launch_agent_hash_mismatch');
  const executablePath = path.join(input.appPath, 'Contents', 'MacOS', 'SKSMenuBar');
  const executable = await isRegularFileWithoutSymlink(executablePath) ? await fs.readFile(executablePath).catch(() => null) : null;
  if (!executable) blockers.push('legacy_executable_missing_or_symlink');
  const signature = await inspectSignature(input.appPath, input.env);
  if (!signature.ok || signature.identifier !== 'com.sneakoscope.sks-menubar') blockers.push('legacy_signature_invalid');
  const resourceInventory = await hashResourceInventory(path.join(input.appPath, 'Contents', 'Resources')).catch(() => null);
  if (!resourceInventory) blockers.push('legacy_resource_inventory_invalid');
  if (legacy?.codesign_identifier !== 'com.sneakoscope.sks-menubar') blockers.push('legacy_codesign_identifier_invalid');
  if (blockers.length || !legacy || !stampBytes || !sourceBytes || !executable || !resourceInventory) {
    return { ok: false, stamp: null, blockers };
  }
  return {
    ok: true,
    blockers: [],
    stamp: {
      schema: 'sks.sks-menubar-build-stamp.v2',
      package_version: legacy.package_version,
      source_sha256: legacy.source_sha256,
      source_files_sha256: { 'SKSMenuBar.swift': legacy.source_sha256 },
      resources_sha256: aggregateFileHashes(resourceInventory),
      resource_files_sha256: resourceInventory,
      action_script_sha256: legacy.action_script_sha256,
      info_plist_sha256: legacy.info_plist_sha256,
      launch_agent_sha256: legacy.launch_agent_sha256,
      swiftc_version: legacy.swiftc_version,
      codesign_identifier: legacy.codesign_identifier,
      legacy_v1: {
        original_schema: legacy.schema,
        original_stamp_sha256: sha256(stampBytes),
        source_file: 'SKSMenuBar.swift',
        source_file_sha256: legacy.source_sha256,
        executable_sha256: sha256(executable)
      }
    }
  };
}

export async function rollbackSksMenuBar(opts: SksMenuBarRollbackOptions = {}): Promise<SksMenuBarRollbackResult> {
  const env = opts.env || process.env;
  const paths = sksMenuBarPaths(opts.home || env.HOME, opts.root);
  const actions: string[] = [];
  const warnings: string[] = [];
  let transaction: SksMenuBarGenerationTransactionOutcome | null = null;
  if (process.platform !== 'darwin') {
    return result('unsupported_platform', true, null, null, null, null, { requested: false, method: 'none', ok: true }, [], ['not_macos']);
  }
  const launchctl = env.SKS_MENUBAR_LAUNCHCTL || await which('launchctl').catch(() => null) || '/bin/launchctl';
  const open = env.SKS_MENUBAR_OPEN || await which('open').catch(() => null) || '/usr/bin/open';
  let replacementStopped = false;

  if (await existsWithoutFollowingSymlink(paths.install_transaction_path)) {
    const stopFailure = await stopBeforeReplacement();
    if (stopFailure) return stopFailure;
  }

  const installRecovery = await recoverMenuBarGenerationTransaction({
    purpose: 'install',
    journalPath: paths.install_transaction_path,
    pairs: installGenerationPairs(paths),
    env
  });
  if (!installRecovery.ok) {
    transaction = installRecovery;
    return result(
      'terminal_uncertain', false, null, null, null, null,
      { requested: false, method: 'none', ok: false, terminal_uncertain: true, error: installRecovery.error },
      ['menubar_install_transaction_recovery_terminal_uncertain'], warnings
    );
  }
  if (installRecovery.status === 'rolled_back') {
    transaction = installRecovery;
    actions.push('recovered interrupted Menu Bar install transaction to the verified previous generation');
    const restored = await inspectMenuBarArtifactSet({
      appPath: paths.app_path,
      buildStampPath: paths.build_stamp_path,
      actionScriptPath: paths.action_script_path,
      launchAgentPath: paths.launch_agent_path,
      env
    });
    if (!restored.ok) {
      return result(
        'terminal_uncertain', false, restored.package_version, null, null, restored,
        { requested: false, method: 'none', ok: false, terminal_uncertain: true, error: 'recovered_install_generation_invalid' },
        [...restored.blockers, 'menubar_install_transaction_recovery_verification_failed'], warnings
      );
    }
    actions.push('verified generation restored from interrupted Menu Bar install');
    if (opts.launch === false || env.SKS_SKIP_SKS_MENUBAR_LAUNCH === '1') {
      return result('rolled_back_launch_skipped', true, restored.package_version, null, null, restored, { requested: false, method: 'skipped', ok: true }, [], warnings);
    }
    const launch = await launchMenuBar({
      launchctl,
      open,
      paths,
      env,
      alreadyStopped: replacementStopped,
      ...(restored.package_version ? { expectedVersion: restored.package_version } : {})
    });
    return result(
      launch.ok ? 'rolled_back' : launch.terminal_uncertain ? 'terminal_uncertain' : 'failed',
      launch.ok,
      restored.package_version,
      null,
      null,
      restored,
      launch,
      launch.ok ? [] : [launch.terminal_uncertain ? 'menubar_rollback_launch_terminal_uncertain' : 'menubar_rollback_launch_failed'],
      warnings
    );
  }
  if (installRecovery.status === 'completed_commit') actions.push('completed interrupted committed Menu Bar install cleanup');

  const rollbackPairs = rollbackGenerationPairs(paths);
  if (await existsWithoutFollowingSymlink(paths.rollback_transaction_path)) {
    const stopFailure = await stopBeforeReplacement();
    if (stopFailure) return stopFailure;
  }
  const rollbackRecovery = await recoverMenuBarGenerationTransaction({
    purpose: 'rollback', journalPath: paths.rollback_transaction_path, pairs: rollbackPairs, env
  });
  if (!rollbackRecovery.ok) {
    transaction = rollbackRecovery;
    return result(
      'terminal_uncertain', false, null, null, null, null,
      { requested: false, method: 'none', ok: false, terminal_uncertain: true, error: rollbackRecovery.error },
      ['menubar_rollback_transaction_recovery_terminal_uncertain'], warnings
    );
  }
  if (rollbackRecovery.status === 'rolled_back') actions.push('recovered interrupted Menu Bar rollback to its pre-rollback generation before retrying');
  if (rollbackRecovery.status === 'completed_commit') actions.push('completed interrupted committed Menu Bar rollback cleanup');

  const verificationBefore = await inspectMenuBarArtifactSet({
    appPath: paths.backup_app_path,
    buildStampPath: paths.previous_build_stamp_path,
    actionScriptPath: paths.previous_action_script_path,
    launchAgentPath: paths.previous_launch_agent_path,
    env
  });
  const replacedStamp = await readJson<SksMenuBarBuildStamp | null>(paths.build_stamp_path, null).catch(() => null);
  if (!verificationBefore.ok) {
    return result('failed', false, verificationBefore.package_version, replacedStamp?.package_version || null, verificationBefore, null, { requested: false, method: 'none', ok: false, error: 'rollback_candidate_invalid' }, verificationBefore.blockers, warnings);
  }

  const stopFailure = await stopBeforeReplacement();
  if (stopFailure) return stopFailure;

  try {
    transaction = await applyMenuBarGenerationTransaction({
      purpose: 'rollback', journalPath: paths.rollback_transaction_path, pairs: rollbackPairs, env
    });
    actions.push('swapped app, build stamp, action script, and LaunchAgent as one journaled rollback generation');
  } catch (error) {
    const failed = error instanceof MenuBarGenerationTransactionError ? error.outcome : null;
    const recovery = await recoverMenuBarGenerationTransaction({
      purpose: 'rollback', journalPath: paths.rollback_transaction_path, pairs: rollbackPairs, env
    });
    transaction = recovery;
    const detail = failed?.error || (error instanceof Error ? error.message : String(error));
    return result(
      recovery.ok ? 'failed' : 'terminal_uncertain',
      false,
      verificationBefore.package_version,
      replacedStamp?.package_version || null,
      verificationBefore,
      null,
      { requested: false, method: 'none', ok: false, terminal_uncertain: !recovery.ok, error: detail },
      [recovery.ok ? 'menubar_rollback_swap_failed' : 'menubar_rollback_swap_terminal_uncertain'],
      warnings
    );
  }

  const verificationAfter = await inspectMenuBarArtifactSet({
    appPath: paths.app_path,
    buildStampPath: paths.build_stamp_path,
    actionScriptPath: paths.action_script_path,
    launchAgentPath: paths.launch_agent_path,
    env
  });
  if (!verificationAfter.ok) {
    const recovery = await recoverMenuBarGenerationTransaction({
      purpose: 'rollback', journalPath: paths.rollback_transaction_path, pairs: rollbackPairs, env
    });
    transaction = recovery;
    return result(
      recovery.ok ? 'failed' : 'terminal_uncertain',
      false,
      verificationBefore.package_version,
      replacedStamp?.package_version || null,
      verificationBefore,
      verificationAfter,
      { requested: false, method: 'none', ok: false, terminal_uncertain: !recovery.ok, error: 'rollback_post_restore_verification_failed' },
      [...verificationAfter.blockers, recovery.ok ? 'menubar_rollback_verification_failed' : 'menubar_rollback_verification_terminal_uncertain'],
      warnings
    );
  }
  actions.push('verified restored Menu Bar signature, resources, build stamp, action script, and launch agent');
  const committed = await commitMenuBarGenerationTransaction({
    purpose: 'rollback', journalPath: paths.rollback_transaction_path, pairs: rollbackPairs, env
  });
  if (!committed.ok) {
    const recovery = await recoverMenuBarGenerationTransaction({
      purpose: 'rollback', journalPath: paths.rollback_transaction_path, pairs: rollbackPairs, env
    });
    transaction = recovery;
    if (!recovery.ok) {
      return result(
        'terminal_uncertain', false, verificationBefore.package_version, replacedStamp?.package_version || null,
        verificationBefore, verificationAfter,
        { requested: false, method: 'none', ok: false, terminal_uncertain: true, error: recovery.error || committed.error },
        ['menubar_rollback_commit_terminal_uncertain'], warnings
      );
    }
    warnings.push('menubar_rollback_commit_cleanup_recovered');
  } else {
    transaction = committed;
  }

  if (opts.launch === false || env.SKS_SKIP_SKS_MENUBAR_LAUNCH === '1') {
    return result('rolled_back_launch_skipped', true, verificationBefore.package_version, replacedStamp?.package_version || null, verificationBefore, verificationAfter, { requested: false, method: 'skipped', ok: true }, [], warnings);
  }
  const launch = await launchMenuBar({
    launchctl,
    open,
    paths,
    env,
    alreadyStopped: replacementStopped,
    ...(verificationBefore.package_version ? { expectedVersion: verificationBefore.package_version } : {})
  });
  if (!launch.ok) {
    return result(
      launch.terminal_uncertain ? 'terminal_uncertain' : 'failed',
      false,
      verificationBefore.package_version,
      replacedStamp?.package_version || null,
      verificationBefore,
      verificationAfter,
      launch,
      [launch.terminal_uncertain ? 'menubar_rollback_launch_terminal_uncertain' : 'menubar_rollback_launch_failed'],
      warnings
    );
  }
  actions.push(launch.verified_running_after_timeout
    ? 'launchctl kickstart timed out; launchctl print verified the restored service is running'
    : 'launchctl restarted the restored Menu Bar service');
  return result('rolled_back', true, verificationBefore.package_version, replacedStamp?.package_version || null, verificationBefore, verificationAfter, launch, [], warnings);

  async function stopBeforeReplacement(): Promise<SksMenuBarRollbackResult | null> {
    if (replacementStopped) return null;
    const stopped = await stopMenuBarForReplacement({
      launchctl,
      paths,
      executablePaths: [paths.executable_path],
      env
    });
    if (!stopped.ok) {
      return result(
        stopped.timed_out ? 'terminal_uncertain' : 'failed',
        false,
        null,
        null,
        null,
        null,
        {
          requested: false,
          method: 'none',
          ok: false,
          terminal_uncertain: stopped.timed_out,
          error: stopped.error || 'menubar_rollback_stop_failed'
        },
        [stopped.error || 'menubar_rollback_stop_failed'],
        warnings
      );
    }
    replacementStopped = true;
    actions.push('booted out Menu Bar and verified process termination before journaled rollback replacement');
    return null;
  }

  function result(
    status: SksMenuBarRollbackResult['status'],
    ok: boolean,
    previousVersion: string | null,
    replacedVersion: string | null,
    before: SksMenuBarArtifactVerification | null,
    after: SksMenuBarArtifactVerification | null,
    launch: SksMenuBarRollbackResult['launch'],
    blockers: string[],
    resultWarnings: string[]
  ): SksMenuBarRollbackResult {
    return {
      schema: 'sks.menubar-rollback.v1',
      ok,
      platform: process.platform,
      status,
      paths,
      previous_version: previousVersion,
      replaced_version: replacedVersion,
      verification_before: before,
      verification_after: after,
      launch,
      actions: [...actions],
      warnings: [...resultWarnings],
      blockers,
      transaction
    };
  }
}

async function existsWithoutFollowingSymlink(file: string): Promise<boolean> {
  return fs.lstat(file).then(() => true).catch(() => false);
}

async function isRegularFileWithoutSymlink(file: string): Promise<boolean> {
  return fs.lstat(file).then((stat) => stat.isFile() && !stat.isSymbolicLink()).catch(() => false);
}

async function isDirectoryWithoutSymlink(file: string): Promise<boolean> {
  return fs.lstat(file).then((stat) => stat.isDirectory() && !stat.isSymbolicLink()).catch(() => false);
}

async function inspectExactResourceInventory(
  resourcesDir: string,
  expected: Record<string, string>
): Promise<{ checked: boolean; ok: boolean; missing: string[]; mismatched: string[] }> {
  const actual = await hashResourceInventory(resourcesDir).catch(() => null);
  if (!actual) return { checked: true, ok: false, missing: Object.keys(expected), mismatched: [] };
  const missing = Object.keys(expected).filter((name) => !(name in actual));
  const mismatched = Object.keys(actual).filter((name) => expected[name] !== actual[name]);
  return { checked: true, ok: missing.length === 0 && mismatched.length === 0, missing, mismatched };
}

async function hashResourceInventory(resourcesDir: string): Promise<Record<string, string>> {
  if (!(await existsWithoutFollowingSymlink(resourcesDir))) return {};
  if (!(await isDirectoryWithoutSymlink(resourcesDir))) throw new Error('resource_directory_invalid');
  const output: Record<string, string> = {};
  const stack: Array<{ directory: string; relative: string }> = [{ directory: resourcesDir, relative: '' }];
  while (stack.length) {
    const current = stack.pop()!;
    const entries = await fs.readdir(current.directory, { withFileTypes: true });
    for (const entry of entries) {
      const file = path.join(current.directory, entry.name);
      const relative = path.join(current.relative, entry.name).split(path.sep).join('/');
      if (entry.isSymbolicLink()) throw new Error(`resource_symlink_invalid:${relative}`);
      if (entry.isDirectory()) stack.push({ directory: file, relative });
      else if (entry.isFile()) output[relative] = sha256(await fs.readFile(file));
      else throw new Error(`resource_entry_invalid:${relative}`);
    }
  }
  return output;
}
