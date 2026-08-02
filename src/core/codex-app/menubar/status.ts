import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { exists, PACKAGE_VERSION, readJson, readText, sha256 } from '../../fsx.js';
import { smokeSksMenuBarAction } from './action-runner.js';
import { isCodexAppRunningByBundleId, readMenuBarConfig } from './config.js';
import {
  inspectLaunchdService,
  inspectRunningMenuBarProcess,
  removeLaunchAgent,
  restartLaunchAgent,
  waitForRunningMenuBarVersion
} from './launch-agent.js';
import { sksMenuBarPaths } from './paths.js';
import { inspectInstalledResources } from './resources.js';
import { inspectMenuBarArtifactSet } from './rollback.js';
import { inspectSignature } from './signature.js';
import { cleanupRetiredRemoteBridgeLaunchAgent, quarantineRetiredRemoteBridgeBindings } from './migration.js';
import { inspectProjectMenuBarCanonicalState } from './global-install.js';
import type {
  SksMenuBarBuildStamp,
  SksMenuBarStatusResult,
  SksMenuBarUninstallResult,
  SksMenuBarVersionProbe
} from './types.js';

export async function inspectSksMenuBarStatus(opts: {
  home?: string;
  root?: string;
  env?: NodeJS.ProcessEnv;
} = {}): Promise<SksMenuBarStatusResult> {
  const paths = sksMenuBarPaths(opts.home || opts.env?.HOME, opts.root);
  const installed = await exists(paths.executable_path);
  const actionText = await readText(paths.action_script_path, '');
  const nodeBin = shellAssignment(actionText, 'NODE_BIN');
  const sksEntry = shellAssignment(actionText, 'SKS_ENTRY');
  const actionSmoke = await smokeSksMenuBarAction(paths.action_script_path);
  const buildStamp = await readJson<SksMenuBarBuildStamp | null>(paths.build_stamp_path, null);
  const actionIntegrity = evaluateActionScriptIntegrity(actionText, buildStamp);
  const expectedVersion = buildStamp?.package_version || PACKAGE_VERSION;
  const versionMatches = actionSmoke.detectedVersion === expectedVersion && expectedVersion === PACKAGE_VERSION;
  const config = await readMenuBarConfig(paths.config_path);
  const codexRunning = config.codex_bundle_id ? await isCodexAppRunningByBundleId(config.codex_bundle_id, opts.env) : null;
  const launchd = await inspectLaunchdService(opts.env);
  const runningProcess = await inspectRunningMenuBarProcess(paths, launchd.pid, opts.env);
  const running = runningProcess.ok;
  const installedVersion = buildStamp?.package_version || null;
  const persistedVersionProbe = await readJson<SksMenuBarVersionProbe | null>(paths.version_probe_path, null);
  let versionProbe = evaluatePersistedMenuBarVersionProbe({
    probe: persistedVersionProbe,
    expectedVersion,
    runningProcess,
    persistedPath: paths.version_probe_path
  });
  if (!versionProbe.ok
      && runningProcess.ok
      && runningProcess.package_version === expectedVersion
      && (versionProbe.error === 'menubar_version_probe_missing'
        || versionProbe.error === 'menubar_version_probe_stale')) {
    versionProbe = await waitForRunningMenuBarVersion(paths, expectedVersion, launchd.pid, opts.env);
  }
  const legacyVerification = buildStamp?.legacy_v1
    ? await inspectMenuBarArtifactSet({
        appPath: paths.app_path,
        buildStampPath: paths.build_stamp_path,
        actionScriptPath: paths.action_script_path,
        launchAgentPath: paths.launch_agent_path,
        ...(opts.env ? { env: opts.env } : {})
      })
    : null;
  const signature = legacyVerification?.signature || await inspectSignature(paths.app_path, opts.env);
  const resources = legacyVerification?.resources || await inspectInstalledResources({ resourcesDir: paths.resources_path, buildStamp });
  const canonicalState = await inspectProjectMenuBarCanonicalState({
    paths,
    root: paths.root,
    ...(opts.env ? { env: opts.env } : {})
  });
  const blockers: string[] = [];
  const warnings: string[] = [];
  const runtime = evaluateMenuBarRuntimeReadiness({
    installed,
    running,
    verifiedProcessMatchesExpectedVersion: runningProcess.ok
      && runningProcess.package_version === expectedVersion,
    launchd
  });
  if (!installed) blockers.push('menubar_app_missing');
  if (runtime.blocker) blockers.push(runtime.blocker);
  if (runtime.warning) warnings.push(runtime.warning);
  if (installed && launchd.checked && launchd.ok && !runningProcess.ok) blockers.push('menubar_runtime_identity_unverified');
  if (installed && launchd.checked && launchd.ok && !versionProbe.ok) blockers.push(versionProbe.error || 'menubar_version_probe_failed');
  if (installed && !actionSmoke.executable) blockers.push('action_script_not_executable');
  if (installed && !actionSmoke.ok) blockers.push('action_script_smoke_failed');
  if (installed && actionSmoke.ok && !versionMatches) blockers.push('action_target_version_mismatch');
  if (installed && !buildStamp) blockers.push('build_stamp_missing');
  if (installed && buildStamp && !actionIntegrity.script_hash_matches_stamp) blockers.push('action_script_hash_mismatch');
  if (installed && !resources.ok) blockers.push('menubar_resources_invalid');
  if (installed && signature.checked && !signature.ok) blockers.push('menubar_signature_invalid');
  if (await exists(paths.install_transaction_path)) blockers.push('menubar_install_transaction_pending');
  if (await exists(paths.rollback_transaction_path)) blockers.push('menubar_rollback_transaction_pending');
  blockers.push(...canonicalState.blockers);
  if (canonicalState.verified_duplicates.length > 0) blockers.push('menubar_canonical_only_verified_duplicate_present');
  if (canonicalState.unverified_collisions.length > 0) blockers.push('menubar_canonical_only_unverified_duplicate_present');
  warnings.push(...canonicalState.warnings);
  if (!config.codex_bundle_id) warnings.push('codex_sync_disabled');
  return {
    schema: 'sks.menubar-status.v1', ok: blockers.length === 0, platform: process.platform,
    installed, running, installed_version: installedVersion, running_process: runningProcess,
    menubar_version_probe: versionProbe,
    duplicate_install_candidates: canonicalState.candidate_paths,
    paths,
    launchd,
    action_target: {
      node_bin: nodeBin,
      node_exists: nodeBin ? await isExecutable(nodeBin) : false,
      sks_entry: sksEntry,
      sks_entry_exists: sksEntry ? await exists(sksEntry) : false,
      smoke_code: actionSmoke.code,
      smoke_output: actionSmoke.output,
      version_detected: actionSmoke.versionDetected,
      detected_version: actionSmoke.detectedVersion,
      expected_version: expectedVersion,
      version_matches_expected: versionMatches,
      ...actionIntegrity,
      executable: actionSmoke.executable,
      ok: actionSmoke.ok && versionMatches && actionIntegrity.script_hash_matches_stamp
    },
    codex_sync: {
      ok: Boolean(config.codex_bundle_id), bundle_id: config.codex_bundle_id,
      codex_running: codexRunning,
      icon_visible_expected: config.codex_bundle_id ? codexRunning === true : true,
      warning: config.codex_bundle_id ? null : 'codex_sync_disabled'
    },
    build_stamp: buildStamp, package_version: PACKAGE_VERSION, signature, resources,
    blockers, warnings,
    next_actions: blockers.length ? defaultNextActions() : ['sks menubar status --json']
  };
}

export function evaluatePersistedMenuBarVersionProbe(input: {
  probe: SksMenuBarVersionProbe | null;
  expectedVersion: string;
  runningProcess: SksMenuBarStatusResult['running_process'];
  persistedPath: string;
}): SksMenuBarVersionProbe {
  const base = {
    schema: 'sks.menubar-version-probe.v1' as const,
    checked: true,
    expected_version: input.expectedVersion,
    running_version: input.runningProcess.package_version,
    pid: input.runningProcess.pid,
    generated_at: input.probe?.generated_at || new Date(0).toISOString(),
    persisted_path: input.persistedPath
  };
  if (!input.probe || input.probe.schema !== 'sks.menubar-version-probe.v1') {
    return { ...base, ok: false, error: 'menubar_version_probe_missing' };
  }
  if (!input.runningProcess.ok) {
    return { ...base, ok: false, error: input.runningProcess.error || 'menubar_runtime_identity_unverified' };
  }
  if (input.probe.expected_version !== input.expectedVersion
      || input.probe.running_version !== input.runningProcess.package_version
      || input.probe.pid !== input.runningProcess.pid) {
    return { ...base, ok: false, error: 'menubar_version_probe_stale' };
  }
  if (input.runningProcess.package_version !== input.expectedVersion) {
    return { ...base, ok: false, error: 'menubar_running_version_mismatch' };
  }
  return { ...base, generated_at: input.probe.generated_at, ok: true, error: null };
}

export function evaluateMenuBarRuntimeReadiness(input: {
  installed: boolean;
  running: boolean;
  verifiedProcessMatchesExpectedVersion?: boolean;
  launchd: Pick<SksMenuBarStatusResult['launchd'], 'checked' | 'ok'>;
}): { blocker: 'launchd_not_running' | null; warning: 'launchd_not_running_process_active' | null } {
  if (!input.installed || !input.launchd.checked || input.launchd.ok) {
    return { blocker: null, warning: null };
  }
  if (input.running && input.verifiedProcessMatchesExpectedVersion === true) {
    return { blocker: null, warning: 'launchd_not_running_process_active' };
  }
  return {
    blocker: 'launchd_not_running',
    warning: input.running ? 'launchd_not_running_process_active' : null
  };
}

export function evaluateActionScriptIntegrity(
  actionText: string,
  buildStamp: Pick<SksMenuBarBuildStamp, 'action_script_sha256'> | null | undefined
) {
  const scriptSha256 = actionText ? sha256(actionText) : null;
  const expectedScriptSha256 = buildStamp?.action_script_sha256 || null;
  return {
    script_sha256: scriptSha256,
    expected_script_sha256: expectedScriptSha256,
    script_hash_matches_stamp: Boolean(scriptSha256 && expectedScriptSha256 && scriptSha256 === expectedScriptSha256)
  };
}

export async function restartSksMenuBar(opts: { home?: string; root?: string; env?: NodeJS.ProcessEnv } = {}) {
  const env = opts.env || process.env;
  const paths = sksMenuBarPaths(opts.home || env.HOME, opts.root);
  if (process.platform !== 'darwin') return { schema: 'sks.menubar-restart.v1', ok: true, platform: process.platform, skipped: true, reason: 'not_macos' };
  return { schema: 'sks.menubar-restart.v1', platform: process.platform, ...(await restartLaunchAgent(paths, env)) };
}

export async function uninstallSksMenuBar(opts: { home?: string; root?: string; env?: NodeJS.ProcessEnv } = {}): Promise<SksMenuBarUninstallResult> {
  const env = opts.env || process.env;
  const paths = sksMenuBarPaths(opts.home || env.HOME, opts.root);
  if (process.platform !== 'darwin') return { schema: 'sks.menubar-uninstall.v1', ok: true, platform: process.platform, paths, actions: [], warnings: ['not_macos'], blockers: [] };
  const removed = await removeLaunchAgent(paths, env);
  const retiredLaunchAgent = await cleanupRetiredRemoteBridgeLaunchAgent({ home: paths.home, env });
  const retiredBindings = await quarantineRetiredRemoteBridgeBindings(paths.root);
  const actions = [
    ...removed.actions,
    ...(retiredLaunchAgent.status === 'removed' ? ['removed retired remote bridge LaunchAgent'] : []),
    ...(retiredBindings.status === 'quarantined' ? ['quarantined retired remote bridge bindings'] : [])
  ];
  const warnings = [...removed.warnings, ...retiredLaunchAgent.warnings, ...retiredBindings.warnings];
  const blockers = [...removed.blockers, ...retiredLaunchAgent.blockers, ...retiredBindings.blockers];
  return {
    schema: 'sks.menubar-uninstall.v1',
    ok: blockers.length === 0,
    platform: process.platform,
    paths,
    actions,
    warnings,
    blockers
  };
}

export function isMenuBarInstallPathUnderTempDir(target: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const resolved = path.resolve(target);
  const roots = new Set<string>();
  for (const value of [os.tmpdir(), env.TMPDIR, env.SKS_TMP_DIR]) {
    if (!value) continue;
    const abs = path.resolve(value);
    roots.add(abs);
    if (abs.startsWith('/var/')) roots.add(path.resolve('/private', abs.slice(1)));
    if (abs.startsWith('/private/var/')) roots.add(abs.replace('/private', ''));
  }
  return [...roots].some((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`));
}

export function defaultNextActions(): string[] {
  return ['Run: sks menubar status', 'Run: sks menubar install', 'Run: sks menubar restart', 'Run: sks menubar uninstall'];
}

function shellAssignment(text: string, key: string): string | null {
  const line = text.split(/\r?\n/).find((row) => row.startsWith(`${key}=`));
  if (!line) return null;
  const value = line.slice(key.length + 1).trim();
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replace(/'\\''/g, "'");
  return value;
}

async function isExecutable(file: string): Promise<boolean> {
  return fs.access(file, 1).then(() => true).catch(() => false);
}
