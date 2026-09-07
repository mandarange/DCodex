import os from 'node:os';
import path from 'node:path';
import { exists, PACKAGE_VERSION } from '../../fsx.js';
import { executeDesktopBridgeCommandV3 } from '../../codex-lb/desktop-controller-v3.js';
import { desktopBridgeRuntimeVersion } from '../../codex-lb/desktop-bridge/state.js';
import {
  desktopBridgeServicePaths,
  desktopBridgeServiceStatus
} from '../../codex-lb/desktop-service.js';

export interface DesktopBridgeRestageRun {
  ok: boolean;
  status: 'ok' | 'skipped' | 'failed';
  actions: string[];
  blockers: string[];
  warnings: string[];
}

export interface DesktopBridgeRestageOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  home?: string;
  packageVersion?: string;
  /** Both seams must be supplied to exercise the stage under test isolation. */
  serviceStatus?: typeof desktopBridgeServiceStatus;
  executeCommand?: typeof executeDesktopBridgeCommandV3;
}

/**
 * Converge an installed bridge on the package and settings being migrated.
 * A bare kickstart reuses the old launch entry and only acknowledges a restart
 * request. The shared repair rewrites that entry, preserves provider settings,
 * and waits for the service; an independent status read verifies its result.
 * Configuration mismatch also requires repair when the package is unchanged.
 * Bridge readiness remains optional for package migration, with explicit repair
 * warnings when convergence fails.
 */
export async function desktopBridgeRestage(
  options: DesktopBridgeRestageOptions = {}
): Promise<DesktopBridgeRestageRun> {
  const skip = (reason: string): DesktopBridgeRestageRun =>
    ({ ok: true, status: 'ok', actions: [reason], blockers: [], warnings: [] });
  const warn = (warnings: string[]): DesktopBridgeRestageRun =>
    ({ ok: true, status: 'ok', actions: [], blockers: [], warnings });
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const version = options.packageVersion || PACKAGE_VERSION;
  if (platform !== 'darwin') return skip('desktop_bridge_restage_not_macos');
  // HOME does not isolate launchctl's gui domain. Test and release harnesses
  // must replace both service operations before this stage can reach them.
  const reachesRealLaunchd = !(options.serviceStatus && options.executeCommand);
  const isolated = [process.env, env].some((candidate) =>
    candidate.NODE_TEST_CONTEXT !== undefined
      || candidate.SKS_TEST_ISOLATION === '1'
      || candidate.SKS_RELEASE_UPGRADE_SMOKE === '1');
  if (reachesRealLaunchd && isolated) return skip('desktop_bridge_restage_skipped_under_tests');
  if (env.SKS_SKIP_BRIDGE_RESTAGE === '1') return skip('desktop_bridge_restage_disabled');
  const home = options.home || path.resolve(env.HOME || os.homedir());
  const paths = desktopBridgeServicePaths(home);
  if (!(await exists(paths.launch_agent_path))) return skip('desktop_bridge_restage_no_launch_agent');
  if (!(await exists(paths.settings_path))) return skip('desktop_bridge_restage_no_managed_bridge');

  const serviceOptions = { home, env, platform };
  const statusImpl = options.serviceStatus || desktopBridgeServiceStatus;
  const before = await statusImpl(serviceOptions).catch(() => null);
  const runningVersion = desktopBridgeRuntimeVersion(before?.state);
  if (before?.ok && before.running && before.loaded && runningVersion === version) {
    return skip('desktop_bridge_restage_already_current');
  }

  const repair = await (options.executeCommand || executeDesktopBridgeCommandV3)(
    { operation: 'repair' }, serviceOptions
  ).catch(() => null);
  const after = await statusImpl(serviceOptions).catch(() => null);
  const repairedVersion = desktopBridgeRuntimeVersion(after?.state);
  const command = repair?.schema === 'sks.desktop-bridge-command-result.v1' ? repair : null;
  const commandBlockers = command?.execution.blockers || [];
  if (command?.ok && command.execution.ok && commandBlockers.length === 0
    && after?.ok && after.running && after.loaded && repairedVersion === version) {
    return {
      ok: true,
      status: 'ok',
      actions: [before?.running
        ? `desktop_bridge_restarted:${runningVersion || 'pre-8.6.2'}:${version}`
        : `desktop_bridge_bootstrapped:${version}`],
      blockers: [],
      warnings: []
    };
  }
  const incomplete = [...new Set([
    ...commandBlockers,
    ...(after?.blockers || []),
    ...(!command?.ok || !command.execution.ok ? ['desktop_bridge_repair_failed'] : []),
    ...(!after?.running || !after.loaded ? ['desktop_bridge_service_not_running'] : []),
    ...(repairedVersion !== version
      ? [`desktop_bridge_runtime_version_unverified:${repairedVersion || 'unknown'}:${version}`]
      : [])
  ])];
  return warn([
    ...incomplete.map((blocker) => `desktop_bridge_restage_incomplete:${blocker}`),
    'Desktop Bridge update repair incomplete: run `sks bridge repair` from your home directory'
  ]);
}

/** The migration runner passes (root, fromVersion), not an options object. */
export function runDesktopBridgeRestageStage(): Promise<DesktopBridgeRestageRun> {
  return desktopBridgeRestage();
}
